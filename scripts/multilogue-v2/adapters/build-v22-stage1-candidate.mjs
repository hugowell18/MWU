import { createHash } from 'node:crypto';

import { EPSILON, SPEAKERS, canonicalSpeakers, round } from '../core/contracts.mjs';
import { DEFAULT_BACKCHANNEL_LEXICON, DEFAULT_TURN_PROJECTORS } from '../core/interaction-engine.mjs';

const V22_BACKCHANNEL_ADDITIONS = Object.freeze(['me too', 'same', 'same here']);
const V22_QUESTION_PROJECTORS = Object.freeze([
  'am', 'are', 'can', 'could', 'did', 'do', 'does', 'has', 'have', 'is', 'shall', 'should', 'was', 'were', 'will', 'would',
]);

const DEFAULTS = Object.freeze({
  phraseGapSeconds: 0.5,
  phraseMaxSeconds: 4,
  parentResponseGapSeconds: 0.5,
  parentResponseMaxSeconds: 8,
  activityBridgeSeconds: 0.1,
  shortTurnAssemblyOverride: true,
  shortTurnMaxWords: 12,
  shortTurnMaxSeconds: 3.2,
  shortTurnMinAssemblyConfidence: 0.7,
  providerScoreMargin: 0.1,
  shortQuestionMinAssemblyConfidence: null,
  shortQuestionProviderScoreMargin: null,
  hardQuestionSpeakerChangeOverride: false,
  hardQuestionAssemblySafetyFloor: 0.75,
  lexicalBackchannelAssemblyOverride: true,
  semanticProjectorScoreBonus: 0.15,
  residualMinSeconds: 0.08,
  residualNonlexicalMaxSeconds: 0.5,
  residualAcousticSupportRatio: 0,
  promoteLongResidual: true,
  rebuildTransitionsFromFloor: true,
  hardQuestionResponseBoundary: false,
  speakerSoundingIntervals: null,
  speakerAcousticBridgeSeconds: 0,
});

export function buildV22Stage1Candidate(stage1Input, roomSoundingIntervals, userOptions = {}) {
  const options = {
    ...DEFAULTS,
    ...userOptions,
    speakers: canonicalSpeakers(userOptions.speakers || stage1Input.speakers || Object.values(stage1Input.speakerMapping?.pyannote || {})),
  };
  validateInput(stage1Input, roomSoundingIntervals, options);

  const wordById = new Map((stage1Input.words || []).map((word) => [String(word.id), word]));
  const assemblyMap = stage1Input.speakerMapping.assemblyai;
  const wordEvents = [];
  const passthroughEvents = [];

  for (const event of stage1Input.stage1Evidence || []) {
    const sourceWordId = sourceWordIdForEvent(event.id);
    const sourceWord = sourceWordId ? wordById.get(sourceWordId) : null;
    if (!sourceWord || !Array.isArray(event.tokens) || event.tokens.length === 0) {
      passthroughEvents.push({ ...event });
      continue;
    }
    wordEvents.push({
      ...event,
      source_word_id: sourceWordId,
      assembly_speaker: assemblyMap[String(sourceWord.speaker)] || null,
      assembly_confidence: finiteOrNull(sourceWord.confidence),
      assembly_utterance_id: sourceWord.utterance_id
        ?? sourceWord.utteranceId
        ?? sourceWord.utterance
        ?? null,
    });
  }

  const phraseBuild = buildPhraseEvents(wordEvents, options);
  const phraseCoverage = phraseBuild.events.flatMap((event) => (
    (event.activity_segments || [{ start: event.start, end: event.end }]).map((segment) => ({
      speaker: event.speaker,
      start: segment.start,
      end: segment.end,
    }))
  ));
  const residualBuild = promoteResidualEvidence(
    stage1Input.stage1UnknownEvidence || [],
    roomSoundingIntervals,
    phraseCoverage,
    options,
  );

  const promotedIds = new Set(residualBuild.events.map((event) => event.id));
  const evidence = [
    ...phraseBuild.events,
    ...passthroughEvents,
    ...residualBuild.events,
  ].sort(eventSort);
  const flags = [
    ...(stage1Input.initialFlags || []),
    ...phraseBuild.flags,
    ...residualBuild.flags,
  ].sort(flagSort);

  return {
    input: {
      ...stage1Input,
      methodologyVersion: 'multilogue-v2.2-calibration-candidate-v1',
      roomSoundingIntervals: roomSoundingIntervals.map(copyInterval),
      stage1Evidence: evidence,
      initialFlags: dedupeFlags(flags),
      interactionConfig: {
        ...(stage1Input.interactionConfig || {}),
        rebuildTransitionsFromFloor: options.rebuildTransitionsFromFloor === true,
        backchannelLexicon: options.backchannelLexicon
          || [...DEFAULT_BACKCHANNEL_LEXICON, ...V22_BACKCHANNEL_ADDITIONS],
        turnProjectors: options.turnProjectors
          || [...DEFAULT_TURN_PROJECTORS, ...V22_QUESTION_PROJECTORS],
      },
      adapterMetadata: {
        ...(stage1Input.adapterMetadata || {}),
        v22Candidate: {
          runtime_gold_access: false,
          phrase_options: phraseOptionSnapshot(options),
          residual_options: residualOptionSnapshot(options),
          phrase_count: phraseBuild.events.length,
          parent_response_count: phraseBuild.parentCount,
          phrase_disagreement_count: phraseBuild.disagreementCount,
          phrase_override_count: phraseBuild.overrideCount,
          promoted_residual_count: residualBuild.events.length,
          promoted_short_nonlexical_count: residualBuild.shortCount,
          promoted_long_unknown_lexical_count: residualBuild.longCount,
          promoted_residual_seconds: round(residualBuild.totalSeconds, 6),
          transition_source: options.rebuildTransitionsFromFloor ? 'generated_floor' : 'event_candidates',
        },
      },
    },
    provenance: {
      contract_version: 'multilogue-v2.2-stage1-candidate-provenance-v1',
      runtime_gold_access: false,
      options: { ...phraseOptionSnapshot(options), ...residualOptionSnapshot(options) },
      phrase_candidates: phraseBuild.provenance,
      residual_candidates: residualBuild.provenance,
      promoted_event_ids: [...promotedIds].sort(),
    },
    stats: {
      source_word_event_count: wordEvents.length,
      phrase_event_count: phraseBuild.events.length,
      parent_response_count: phraseBuild.parentCount,
      passthrough_event_count: passthroughEvents.length,
      phrase_disagreement_count: phraseBuild.disagreementCount,
      phrase_override_count: phraseBuild.overrideCount,
      promoted_residual_count: residualBuild.events.length,
      promoted_short_nonlexical_count: residualBuild.shortCount,
      promoted_long_unknown_lexical_count: residualBuild.longCount,
      promoted_residual_seconds: round(residualBuild.totalSeconds, 6),
      unresolved_residual_count: (stage1Input.stage1UnknownEvidence || []).length,
    },
  };
}

export function buildPhraseEvents(wordEvents, userOptions = {}) {
  const options = { ...DEFAULTS, ...userOptions };
  const ordered = [...wordEvents].sort(eventSort);
  const parents = [];

  for (const word of ordered) {
    const groupingSpeaker = word.assembly_speaker || word.speaker;
    const utteranceId = word.assembly_utterance_id == null ? null : String(word.assembly_utterance_id);
    const previous = parents[parents.length - 1];
    const sameExplicitUtterance = utteranceId != null
      && previous?.assemblyUtteranceId != null
      && previous.assemblyUtteranceId === utteranceId;
    const sameConstructedResponse = utteranceId == null
      && previous
      && previous?.assemblyUtteranceId == null
      && previous.groupingSpeaker === groupingSpeaker
      && word.start - previous.end <= options.parentResponseGapSeconds + EPSILON
      && word.end - previous.start <= options.parentResponseMaxSeconds + EPSILON;
    const hardQuestionBoundary = options.hardQuestionResponseBoundary === true
      && previous
      && previous.groupingSpeaker === groupingSpeaker
      && utteranceId == null
      && previous.assemblyUtteranceId == null
      && startsWithTurnProjector(word.tokens || [], options.turnProjectors);
    const canAppend = previous
      && previous.groupingSpeaker === groupingSpeaker
      && !hardQuestionBoundary
      && (sameExplicitUtterance || sameConstructedResponse);
    if (canAppend) {
      previous.words.push(word);
      previous.end = Math.max(previous.end, word.end);
    } else {
      parents.push({
        groupingSpeaker,
        assemblyUtteranceId: utteranceId,
        start: word.start,
        end: word.end,
        words: [word],
        hardBoundaryReason: previous && previous.groupingSpeaker !== groupingSpeaker
          ? 'assembly_speaker_change'
          : hardQuestionBoundary ? 'short_turn_projector_question' : null,
      });
    }
  }

  const events = [];
  const flags = [];
  const provenance = [];
  let disagreementCount = 0;
  let overrideCount = 0;
  let sequence = 0;
  for (const [parentIndex, parent] of parents.entries()) {
    const parentTokens = parent.words.flatMap((word) => word.tokens || []);
    const fusion = fusePhraseSpeaker(parent, options);
    if (fusion.disagreement) disagreementCount += 1;
    if (fusion.decision.startsWith('assembly_short_')) overrideCount += 1;
    const parentId = stableId('response', [
      parent.groupingSpeaker,
      parent.assemblyUtteranceId || 'constructed',
      parent.words.map((word) => word.source_word_id).join(','),
    ]);
    const children = splitResponseChildren(parent.words, options);
    for (const [childIndex, child] of children.entries()) {
      sequence += 1;
      const sourceWordIds = child.words.map((word) => word.source_word_id);
      const tokens = child.words.flatMap((word) => word.tokens || []);
      const id = stableId('phrase', [parentId, sourceWordIds.join(','), fusion.speaker]);
      const confidenceValues = child.words.map((word) => word.assembly_confidence).filter(Number.isFinite);
      const event = {
        id,
        parent_response_id: parentId,
        parent_response_sequence: parentIndex + 1,
        child_sequence: childIndex + 1,
        speaker: fusion.speaker,
        start: round(child.start, 6),
        end: round(child.end, 6),
        confidence: confidenceValues.length
          ? round(confidenceValues.reduce((sum, value) => sum + value, 0) / confidenceValues.length, 6)
          : null,
        provisional_kind: 'vocalisation',
        lexical_class: child.groupingClass,
        evidence_state: 'known',
        floor_eligible: true,
        overlap_eligible: true,
        tokens,
        interaction_tokens: parentTokens,
        parent_turn_projector_candidate: fusion.turn_projector_candidate,
        parent_lexical_backchannel_candidate: fusion.lexical_backchannel_candidate,
        short_explicit_question: fusion.short_explicit_question,
        hard_response_boundary: parent.hardBoundaryReason,
        activity_segments: mergeActivitySegments(
          child.words.map((word) => ({ start: word.start, end: word.end })),
          options.activityBridgeSeconds,
        ),
        source_word_ids: sourceWordIds,
        source_event_ids: child.words.map((word) => word.id),
        speaker_fusion: fusion,
        review_codes: fusion.disagreement ? ['provider_speaker_disagreement'] : [],
      };
      events.push(event);
      provenance.push({
        phrase_id: id,
        parent_response_id: parentId,
        parent_response_sequence: parentIndex + 1,
        child_sequence: childIndex + 1,
        sequence,
        start: event.start,
        end: event.end,
        token_count: tokens.length,
        parent_token_count: parentTokens.length,
        source_word_ids: sourceWordIds,
        source_event_ids: event.source_event_ids,
        selected_speaker: fusion.speaker,
        speaker_fusion: fusion,
        hard_response_boundary: parent.hardBoundaryReason,
      });
      if (fusion.disagreement) {
        flags.push({
          start: event.start,
          end: event.end,
          code: fusion.decision.startsWith('assembly_short_')
            ? 'short_turn_speaker_fusion_override'
            : 'speaker_provider_disagreement_retained',
          severity: 'review',
          source: 'stage1_v22_phrase_fusion',
          related_id: id,
        });
      }
    }
  }
  return { events, flags, provenance, disagreementCount, overrideCount, parentCount: parents.length };
}

function splitResponseChildren(words, options) {
  const children = [];
  for (const word of words) {
    const groupingClass = word.lexical_class === 'filled_pause' ? 'filled_pause' : 'lexical';
    const previous = children[children.length - 1];
    const canAppend = previous
      && previous.groupingClass === groupingClass
      && word.start - previous.end <= options.phraseGapSeconds + EPSILON
      && word.end - previous.start <= options.phraseMaxSeconds + EPSILON;
    if (canAppend) {
      previous.words.push(word);
      previous.end = Math.max(previous.end, word.end);
    } else {
      children.push({ groupingClass, start: word.start, end: word.end, words: [word] });
    }
  }
  return children;
}

function fusePhraseSpeaker(group, options) {
  const assemblySpeaker = group.groupingSpeaker;
  const speakers = options.speakers || SPEAKERS;
  const pyannoteSeconds = Object.fromEntries(speakers.map((speaker) => [speaker, 0]));
  for (const word of group.words) {
    if (speakers.includes(word.speaker)) pyannoteSeconds[word.speaker] += word.end - word.start;
  }
  const ranking = speakers.map((speaker) => ({ speaker, seconds: pyannoteSeconds[speaker] }))
    .sort((left, right) => right.seconds - left.seconds || left.speaker.localeCompare(right.speaker));
  const pyannoteSpeaker = ranking[0].speaker;
  const pyannoteTotal = ranking.reduce((sum, item) => sum + item.seconds, 0);
  const pyannoteShare = pyannoteTotal > EPSILON ? ranking[0].seconds / pyannoteTotal : 0;
  const confidenceValues = group.words.map((word) => word.assembly_confidence).filter(Number.isFinite);
  const assemblyConfidence = confidenceValues.length
    ? confidenceValues.reduce((sum, value) => sum + value, 0) / confidenceValues.length
    : null;
  const tokenCount = group.words.reduce((sum, word) => sum + (word.tokens || []).length, 0);
  const duration = group.end - group.start;
  const disagreement = speakers.includes(assemblySpeaker) && assemblySpeaker !== pyannoteSpeaker;
  const shortTurn = tokenCount <= options.shortTurnMaxWords
    && duration <= options.shortTurnMaxSeconds + EPSILON;
  const tokens = group.words.flatMap((word) => word.tokens || []);
  const projectorCandidate = startsWithTurnProjector(tokens, options.turnProjectors);
  const backchannelCandidate = passesLexicalBackchannelCandidate(tokens, options.backchannelLexicon);
  const assemblyScore = assemblyConfidence == null
    ? null
    : assemblyConfidence + ((projectorCandidate || backchannelCandidate) ? options.semanticProjectorScoreBonus : 0);
  const pyannoteScore = pyannoteShare;
  const scoreMargin = assemblyScore == null ? null : assemblyScore - pyannoteScore;
  const questionConfidence = Number(options.shortQuestionMinAssemblyConfidence
    ?? options.shortTurnMinAssemblyConfidence);
  const questionMargin = Number(options.shortQuestionProviderScoreMargin
    ?? options.providerScoreMargin);
  const hardAssemblyQuestionBoundary = options.hardQuestionSpeakerChangeOverride === true
    && group.hardBoundaryReason === 'assembly_speaker_change';
  const requiredQuestionConfidence = hardAssemblyQuestionBoundary
    ? Number(options.hardQuestionAssemblySafetyFloor)
    : questionConfidence;
  const questionOverride = disagreement
    && options.shortTurnAssemblyOverride === true
    && shortTurn
    && projectorCandidate
    && assemblyConfidence != null
    && assemblyConfidence >= requiredQuestionConfidence
    && (hardAssemblyQuestionBoundary || scoreMargin >= questionMargin - EPSILON);
  const backchannelOverride = disagreement
    && options.shortTurnAssemblyOverride === true
    && options.lexicalBackchannelAssemblyOverride !== false
    && shortTurn
    && backchannelCandidate
    && !projectorCandidate
    && assemblyConfidence != null
    && assemblyConfidence >= options.shortTurnMinAssemblyConfidence
    && scoreMargin >= options.providerScoreMargin - EPSILON;
  const canOverride = questionOverride || backchannelOverride;
  return {
    speaker: canOverride ? assemblySpeaker : pyannoteSpeaker,
    decision: questionOverride ? (options.hardQuestionSpeakerChangeOverride === true
      ? 'assembly_short_question_override'
      : 'assembly_short_turn_override')
      : backchannelOverride ? 'assembly_short_turn_override'
      : disagreement ? 'pyannote_local_majority_retained' : 'provider_agreement',
    disagreement,
    short_turn: shortTurn,
    turn_projector_candidate: projectorCandidate,
    short_explicit_question: projectorCandidate && shortTurn,
    lexical_backchannel_candidate: backchannelCandidate,
    assembly_speaker: assemblySpeaker,
    assembly_mean_confidence: assemblyConfidence == null ? null : round(assemblyConfidence, 6),
    pyannote_speaker: pyannoteSpeaker,
    pyannote_share: round(pyannoteShare, 6),
    pyannote_seconds: Object.fromEntries(Object.entries(pyannoteSeconds).map(([speaker, value]) => [speaker, round(value, 6)])),
    assembly_score: assemblyScore == null ? null : round(assemblyScore, 6),
    pyannote_score: round(pyannoteScore, 6),
    provider_score_margin: scoreMargin == null ? null : round(scoreMargin, 6),
    question_override: questionOverride,
    backchannel_override: backchannelOverride,
    hard_assembly_question_boundary: hardAssemblyQuestionBoundary,
    required_question_confidence: requiredQuestionConfidence,
  };
}

export function promoteResidualEvidence(unknownEvents, roomSoundingIntervals, phraseCoverage, userOptions = {}) {
  const options = { ...DEFAULTS, ...userOptions };
  const sounding = normalizeIntervals(roomSoundingIntervals);
  const speakerSounding = normalizeSpeakerIntervals(
    options.speakerSoundingIntervals,
    options.speakerAcousticBridgeSeconds,
    options.speakers,
  );
  const events = [];
  const flags = [];
  const provenance = [];
  let shortCount = 0;
  let longCount = 0;
  let totalSeconds = 0;

  for (const residual of [...unknownEvents].sort(eventSort)) {
    const acousticSounding = speakerSounding?.[residual.speaker] || sounding;
    const phraseSpans = phraseCoverage.filter((item) => item.speaker === residual.speaker);
    const uncovered = subtractMany({ start: residual.start, end: residual.end }, phraseSpans);
    const supportedSegments = intersectMany(uncovered, acousticSounding);
    const sourceDuration = Math.max(EPSILON, Number(residual.end) - Number(residual.start));
    const supportSeconds = supportedSegments.reduce((sum, segment) => sum + segment.end - segment.start, 0);
    const supportRatio = supportSeconds / sourceDuration;
    if (supportRatio + EPSILON < options.residualAcousticSupportRatio) continue;
    for (const segment of supportedSegments) {
      const duration = segment.end - segment.start;
      if (duration < options.residualMinSeconds - EPSILON) continue;
      const shortNonlexical = duration <= options.residualNonlexicalMaxSeconds + EPSILON;
      if (!shortNonlexical && options.promoteLongResidual !== true) continue;
      const id = stableId('residual', [residual.id, segment.start, segment.end, residual.speaker]);
      const lexicalClass = shortNonlexical ? 'nonlexical' : 'unknown';
      const event = {
        id,
        speaker: residual.speaker,
        start: round(segment.start, 6),
        end: round(segment.end, 6),
        confidence: residual.confidence ?? null,
        provisional_kind: 'vocalisation',
        lexical_class: lexicalClass,
        evidence_state: 'known',
        floor_eligible: shortNonlexical,
        overlap_eligible: false,
        tokens: [],
        source_residual_ids: [residual.id],
        acoustic_support: speakerSounding ? 'speaker_conditioned_vad_clipped_to_provider_turn' : 'local_room_vad_intersection',
        acoustic_support_ratio: round(supportRatio, 6),
        source_residual_duration_seconds: round(sourceDuration, 6),
        review_codes: [shortNonlexical
          ? 'provisional_nonlexical_acoustic_residual'
          : 'provisional_unknown_lexical_acoustic_residual'],
      };
      events.push(event);
      totalSeconds += duration;
      if (shortNonlexical) shortCount += 1;
      else longCount += 1;
      const code = shortNonlexical
        ? 'provisional_nonlexical_acoustic_residual'
        : 'provisional_unknown_lexical_acoustic_residual';
      flags.push({
        start: event.start,
        end: event.end,
        code,
        severity: 'review',
        source: 'stage1_v22_residual_fusion',
        related_id: id,
      });
      provenance.push({
        event_id: id,
        source_residual_id: residual.id,
        speaker: residual.speaker,
        start: event.start,
        end: event.end,
        lexical_class: lexicalClass,
        evidence_rule: speakerSounding
          ? 'pyannote_residual_intersect_speaker_conditioned_vad_and_not_phrase_span'
          : 'pyannote_residual_intersect_local_room_vad_and_not_phrase_span',
        acoustic_support_ratio: round(supportRatio, 6),
      });
    }
  }
  return { events, flags, provenance, shortCount, longCount, totalSeconds };
}

function phraseOptionSnapshot(options) {
  return {
    phrase_gap_seconds: Number(options.phraseGapSeconds),
    phrase_max_seconds: Number(options.phraseMaxSeconds),
    parent_response_gap_seconds: Number(options.parentResponseGapSeconds),
    parent_response_max_seconds: Number(options.parentResponseMaxSeconds),
    activity_bridge_seconds: Number(options.activityBridgeSeconds),
    short_turn_assembly_override: options.shortTurnAssemblyOverride === true,
    short_turn_max_words: Number(options.shortTurnMaxWords),
    short_turn_max_seconds: Number(options.shortTurnMaxSeconds),
    short_turn_min_assembly_confidence: Number(options.shortTurnMinAssemblyConfidence),
    provider_score_margin: Number(options.providerScoreMargin),
    short_question_min_assembly_confidence: Number(options.shortQuestionMinAssemblyConfidence
      ?? options.shortTurnMinAssemblyConfidence),
    short_question_provider_score_margin: Number(options.shortQuestionProviderScoreMargin
      ?? options.providerScoreMargin),
    hard_question_speaker_change_override: options.hardQuestionSpeakerChangeOverride === true,
    hard_question_assembly_safety_floor: Number(options.hardQuestionAssemblySafetyFloor),
    lexical_backchannel_assembly_override: options.lexicalBackchannelAssemblyOverride !== false,
    semantic_projector_score_bonus: Number(options.semanticProjectorScoreBonus),
  };
}

function residualOptionSnapshot(options) {
  return {
    residual_min_seconds: Number(options.residualMinSeconds),
    residual_nonlexical_max_seconds: Number(options.residualNonlexicalMaxSeconds),
    residual_acoustic_support_ratio: Number(options.residualAcousticSupportRatio),
    promote_long_residual: options.promoteLongResidual === true,
    rebuild_transitions_from_floor: options.rebuildTransitionsFromFloor === true,
    speaker_conditioned_acoustic_support: options.speakerSoundingIntervals != null,
    speaker_acoustic_bridge_seconds: Number(options.speakerAcousticBridgeSeconds || 0),
  };
}

function validateInput(input, roomIntervals, options) {
  if (!input || typeof input !== 'object') throw new Error('stage1 input is required');
  if (!Array.isArray(input.stage1Evidence) || !Array.isArray(input.stage1UnknownEvidence)) {
    throw new Error('stage1 evidence collections are required');
  }
  if (!input.speakerMapping?.assemblyai) throw new Error('AssemblyAI canonical speaker mapping is required');
  if (!Array.isArray(roomIntervals)) throw new Error('room sounding intervals must be an array');
  for (const key of [
    'phraseGapSeconds', 'phraseMaxSeconds', 'parentResponseGapSeconds', 'parentResponseMaxSeconds',
    'activityBridgeSeconds', 'shortTurnMaxWords', 'shortTurnMaxSeconds',
    'shortTurnMinAssemblyConfidence', 'providerScoreMargin', 'semanticProjectorScoreBonus',
    'hardQuestionAssemblySafetyFloor',
    'residualMinSeconds', 'residualNonlexicalMaxSeconds', 'residualAcousticSupportRatio',
    'speakerAcousticBridgeSeconds',
  ]) {
    if (!Number.isFinite(Number(options[key])) || Number(options[key]) < 0) throw new Error(`${key} must be a non-negative number`);
  }
}

function normalizeSpeakerIntervals(value, bridgeSeconds = 0, speakers = SPEAKERS) {
  if (value == null) return null;
  const output = {};
  for (const speaker of speakers) {
    if (!Array.isArray(value[speaker])) throw new Error(`speakerSoundingIntervals.${speaker} must be an array`);
    output[speaker] = mergeActivitySegments(value[speaker], Number(bridgeSeconds));
  }
  return output;
}

function sourceWordIdForEvent(eventId) {
  const value = String(eventId || '');
  return value.startsWith('event_aa_word_') ? value.slice('event_'.length) : null;
}

function stableId(kind, values) {
  const digest = createHash('sha256').update(values.map((value) => String(value)).join('|')).digest('hex').slice(0, 16);
  return `event_v22_${kind}_${digest}`;
}

function startsWithTurnProjector(tokens, configured) {
  const phrase = tokens.join(' ');
  const projectors = configured || [...DEFAULT_TURN_PROJECTORS, ...V22_QUESTION_PROJECTORS];
  return projectors.some((projector) => phrase === projector || phrase.startsWith(`${projector} `));
}

function passesLexicalBackchannelCandidate(tokens, configured) {
  if (tokens.length === 0 || tokens.length > 3) return false;
  const phrase = tokens.join(' ');
  const lexicon = new Set(configured || [...DEFAULT_BACKCHANNEL_LEXICON, ...V22_BACKCHANNEL_ADDITIONS]);
  if (lexicon.has(phrase)) return true;
  return tokens.filter((token) => lexicon.has(token)).length > tokens.length / 2;
}

function mergeActivitySegments(segments, maximumGap) {
  const output = [];
  for (const segment of normalizeIntervals(segments)) {
    const previous = output[output.length - 1];
    if (previous && segment.start - previous.end <= Number(maximumGap) + EPSILON) {
      previous.end = Math.max(previous.end, segment.end);
    } else {
      output.push({ ...segment });
    }
  }
  return output.map((segment) => ({ start: round(segment.start, 6), end: round(segment.end, 6) }));
}

function normalizeIntervals(intervals) {
  return intervals
    .map((item) => ({ start: Number(item.start), end: Number(item.end) }))
    .filter((item) => Number.isFinite(item.start) && Number.isFinite(item.end) && item.end > item.start + EPSILON)
    .sort((left, right) => left.start - right.start || left.end - right.end);
}

function subtractMany(container, exclusions) {
  let output = [{ start: Number(container.start), end: Number(container.end) }];
  for (const exclusion of normalizeIntervals(exclusions)) {
    const next = [];
    for (const interval of output) {
      if (exclusion.end <= interval.start + EPSILON || exclusion.start >= interval.end - EPSILON) {
        next.push(interval);
        continue;
      }
      if (exclusion.start > interval.start + EPSILON) next.push({ start: interval.start, end: Math.min(interval.end, exclusion.start) });
      if (exclusion.end < interval.end - EPSILON) next.push({ start: Math.max(interval.start, exclusion.end), end: interval.end });
    }
    output = next;
  }
  return output;
}

function intersectMany(intervals, sounding) {
  const output = [];
  for (const interval of intervals) {
    for (const acoustic of sounding) {
      if (acoustic.end <= interval.start + EPSILON) continue;
      if (acoustic.start >= interval.end - EPSILON) break;
      const start = Math.max(interval.start, acoustic.start);
      const end = Math.min(interval.end, acoustic.end);
      if (end > start + EPSILON) output.push({ start, end });
    }
  }
  return output;
}

function dedupeFlags(flags) {
  const unique = new Map();
  for (const flag of flags) {
    const normalized = {
      start: round(Number(flag.start), 6),
      end: round(Number(flag.end), 6),
      code: String(flag.code),
      severity: String(flag.severity || 'review'),
      source: String(flag.source || 'stage1_v22'),
      related_id: String(flag.related_id || ''),
    };
    if (!(normalized.end > normalized.start + EPSILON)) continue;
    const key = JSON.stringify(normalized);
    if (!unique.has(key)) unique.set(key, normalized);
  }
  return [...unique.values()].sort(flagSort);
}

function copyInterval(interval) {
  return { start: Number(interval.start), end: Number(interval.end) };
}

function finiteOrNull(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function eventSort(left, right) {
  return Number(left.start) - Number(right.start)
    || Number(left.end) - Number(right.end)
    || String(left.speaker).localeCompare(String(right.speaker))
    || String(left.id).localeCompare(String(right.id));
}

function flagSort(left, right) {
  return Number(left.start) - Number(right.start)
    || Number(left.end) - Number(right.end)
    || String(left.code).localeCompare(String(right.code))
    || String(left.related_id || '').localeCompare(String(right.related_id || ''));
}
