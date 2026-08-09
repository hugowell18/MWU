import {
  EPSILON,
  FRAME_STEP_SECONDS,
  SPEAKERS,
  SPEAKER_LABELS,
  phonationIncluded,
  round,
  sortedUnique,
} from './contracts.mjs';
import { flagSort, makeFlag } from './mapping.mjs';
import { coalesceFlags, flagsToFrameText } from './timeline.mjs';

export const DEFAULT_BACKCHANNEL_LEXICON = Object.freeze([
  'mhm', 'mm', 'hmm', 'uh-huh', 'mm-hmm', 'yeah', 'yes', 'yep', 'right', 'okay', 'ok', 'sure',
  'true', 'exactly', 'i see', 'oh', 'ah', 'wow', 'really', 'good', 'nice',
]);

export const DEFAULT_TURN_PROJECTORS = Object.freeze([
  'what', 'why', 'who', 'when', 'where', 'how', 'but', 'so', 'well', 'actually', 'i think', 'no',
]);

export const DEFAULT_ACKNOWLEDGEMENT_FORMULAS = Object.freeze([
  "that's good", 'that is good', 'sounds good', 'very good', 'good point',
  "that's great", 'that is great', 'sounds great', "that's right", 'that is right',
]);

export const DEFAULT_RESPONSE_ACKNOWLEDGEMENT_LEXICON = Object.freeze([
  'oh', 'yes', 'yeah', 'yep', 'okay', 'ok', 'right', 'sure',
]);

export function evaluateBackchannel(event, holder, events, config = {}) {
  const lexicon = new Set(config.backchannelLexicon || DEFAULT_BACKCHANNEL_LEXICON);
  const projectors = config.turnProjectors || DEFAULT_TURN_PROJECTORS;
  const maxWords = Number(config.backchannelMaxWords ?? 3);
  const explicitSemantic = config.strictEvidenceRoles !== true || event.semantic_evidence === 'explicit_asr';
  const tokens = interactionTokens(event);
  const phrase = tokens.join(' ');
  const pureNonLexical = (event.lexical_class === 'nonlexical' && tokens.length === 0) || event.soft_chuckle === true;
  const condition1 = explicitSemantic && (pureNonLexical || tokens.length <= maxWords);
  const matched = phrase && lexicon.has(phrase) ? tokens.length : tokens.filter((token) => lexicon.has(token)).length;
  const condition2 = explicitSemantic && (pureNonLexical || (tokens.length > 0 && matched > tokens.length / 2));
  const condition3 = explicitSemantic && (pureNonLexical
    || !projectors.some((projector) => phrase === projector || phrase.startsWith(`${projector} `)));
  const condition4 = explicitSemantic
    && holderCarriesOn(holder, event, events, {
      lexicon,
      projectors,
      maxWords,
      strictEvidenceRoles: config.strictEvidenceRoles === true,
      continuationWindowSeconds: Number(config.holderContinuationWindowSeconds ?? Number.POSITIVE_INFINITY),
    });
  return {
    qualifies: SPEAKERS.includes(holder) && event.speaker !== holder && condition1 && condition2 && condition3 && condition4,
    conditions: {
      short_or_nonlexical: condition1,
      lexical_majority: condition2,
      non_projecting_start: condition3,
      holder_carries_on: condition4,
    },
  };
}

export function runInteractionEngine({
  duration,
  sharedActivity,
  events,
  overlapEvidence = [],
  initialFlags = [],
  config = {},
}) {
  const settings = {
    frameStep: FRAME_STEP_SECONDS,
    floorReleaseSeconds: Number(config.floorReleaseSeconds ?? 1),
    minOverlapSeconds: Number(config.minOverlapSeconds ?? 0.1),
    overlapAssociationToleranceSeconds: Number(config.overlapAssociationToleranceSeconds ?? 0.1),
    overlapMode: config.overlapMode || 'unknown',
    backchannelLexicon: config.backchannelLexicon || DEFAULT_BACKCHANNEL_LEXICON,
    turnProjectors: config.turnProjectors || DEFAULT_TURN_PROJECTORS,
    backchannelMaxWords: Number(config.backchannelMaxWords ?? 3),
    holderContinuationWindowSeconds: Number(config.holderContinuationWindowSeconds ?? Number.POSITIVE_INFINITY),
    rebuildTransitionsFromFloor: config.rebuildTransitionsFromFloor === true,
    strictEvidenceRoles: config.strictEvidenceRoles === true,
    preFloorBackchannelClassification: config.preFloorBackchannelClassification === true,
    acousticBackchannelEnabled: config.acousticBackchannelEnabled === true,
    acousticBackchannelMinSeconds: Number(config.acousticBackchannelMinSeconds ?? 0.12),
    acousticBackchannelMaxSeconds: Number(config.acousticBackchannelMaxSeconds ?? 1),
    acousticResponseMaxSeconds: Number(config.acousticResponseMaxSeconds ?? 1),
    explicitBackchannelMaxSeconds: Number(config.explicitBackchannelMaxSeconds ?? 1),
    acknowledgementFormulas: config.acknowledgementFormulas || DEFAULT_ACKNOWLEDGEMENT_FORMULAS,
    questionResponseAcknowledgementEnabled: config.questionResponseAcknowledgementEnabled !== false,
    questionResponseAcknowledgementLexicon:
      config.questionResponseAcknowledgementLexicon || DEFAULT_RESPONSE_ACKNOWLEDGEMENT_LEXICON,
    questionResponseMaxGapSeconds: Number(config.questionResponseMaxGapSeconds ?? 1),
    questionResponseContinuationSeconds: Number(config.questionResponseContinuationSeconds ?? 2),
    questionResponseOverlapToleranceSeconds: Number(config.questionResponseOverlapToleranceSeconds ?? 0.1),
    acousticResponseConfirmationSeconds: Number(config.acousticResponseConfirmationSeconds ?? 3),
  };
  if (!['path_a_candidate', 'path_b_exclusive', 'unknown'].includes(settings.overlapMode)) {
    throw new Error(`unsupported overlap mode: ${settings.overlapMode}`);
  }

  const terminalCues = classifyTerminalAdministrativeCues(events, duration);
  const flags = [...initialFlags, ...terminalCues.flags];
  const preliminaryFloor = settings.preFloorBackchannelClassification
    ? buildPreliminaryFloor(duration, terminalCues.events, settings)
    : null;
  const preFloor = settings.preFloorBackchannelClassification
    ? classifyPreFloorBackchannels(terminalCues.events, settings, preliminaryFloor)
    : { events: terminalCues.events, eventIds: new Set(), evidence: [], responseEvidence: [], flags: [] };
  flags.push(...preFloor.flags);
  const interactionEvents = preFloor.events;
  const eventAnalysis = analyzeEvents(interactionEvents, duration, settings, flags, preFloor.eventIds);
  const floorTier = buildFloorTier(duration, eventAnalysis, settings);
  const rawOverlap = sharedActivity.frames.map((frame) => {
    const active = activeEventsAt(interactionEvents, midpoint(frame))
      .filter((event) => event.provisional_kind === 'vocalisation'
        && event.overlap_eligible !== false
        && !eventAnalysis.bcEventIds.has(event.id));
    return new Set(active.map((event) => event.speaker)).size >= 2;
  });
  const qualifiedOverlap = qualifyOverlapRuns(sharedActivity.frames, rawOverlap, settings.minOverlapSeconds, flags);
  const speakerFrameLabels = Object.fromEntries(SPEAKERS.map((speaker) => [speaker, []]));

  for (const frame of sharedActivity.frames) {
    const mid = midpoint(frame);
    const active = activeEventsAt(interactionEvents, mid);
    const activeAttributed = active.length > 0;
    const activeVocalisations = active.filter((event) => event.provisional_kind === 'vocalisation');
    const floor = floorAt(floorTier, mid);
    const thresholdFilledSpeaker = frame.filled_by_threshold
      ? bridgeSpeakerForThresholdFill(frame, interactionEvents, eventAnalysis.bcEventIds, floor)
      : null;
    if (frame.sounding && !activeAttributed && !thresholdFilledSpeaker) {
      flags.push(makeFlag(frame.start, frame.end, 'unattributed_sounding', 'review', 'timeline'));
    }
    if (!frame.sounding && activeVocalisations.length > 0) {
      flags.push(makeFlag(frame.start, frame.end, 'attribution_in_room_silence', 'review', 'timeline'));
    }
    for (const speaker of SPEAKERS) {
      const own = active.filter((event) => event.speaker === speaker);
      const text = labelForFrame({
        speaker,
        own,
        floor,
        bcEventIds: eventAnalysis.bcEventIds,
        qualifiedOverlap: qualifiedOverlap[frame.index],
        thresholdFilledSpeaker,
        strictEvidenceRoles: settings.strictEvidenceRoles,
      });
      if (!SPEAKER_LABELS.includes(text)) throw new Error(`label engine emitted invalid label ${text}`);
      speakerFrameLabels[speaker].push({ start: frame.start, end: frame.end, text, floor: floor.text });
    }
  }

  const speakerTiers = Object.fromEntries(
    SPEAKERS.map((speaker) => [speaker, mergeLabelFrames(speakerFrameLabels[speaker])]),
  );
  flagLongOwnPauses(speakerTiers, settings.floorReleaseSeconds, flags);

  const floorTransfers = settings.rebuildTransitionsFromFloor
    ? rebuildTransferCandidatesFromFloor(floorTier, eventAnalysis.transfers)
    : eventAnalysis.transfers;
  const transitions = [];
  const transitionEvidence = [];
  for (const transfer of floorTransfers) {
    const association = associateOverlapEvidenceToTransfer(transfer, overlapEvidence, settings);
    if (settings.overlapMode === 'path_b_exclusive') {
      const reviewStart = round(Math.max(0, Math.min(Math.max(0, duration - settings.frameStep), transfer.incoming_onset)));
      flags.push(makeFlag(
        reviewStart,
        round(Math.min(duration, reviewStart + settings.frameStep)),
        'path_b_transfer_review_required',
        'review',
        'fto',
        `${transfer.from}>${transfer.to}:${transfer.candidate_id || 'candidate'}`,
      ));
    }
    if (settings.overlapMode === 'path_b_exclusive' && association.overlap_class !== 'none') {
      const status = association.overlap_class === 'qualified'
        ? 'overlap_present_offset_not_measured'
        : 'subthreshold_overlap_present_offset_not_measured';
      const transition = {
        ...transfer,
        sequence: transitions.length + 1,
        point_time: round(transfer.incoming_onset),
        raw_gap: round(transfer.incoming_onset - transfer.outgoing_offset),
        fto: null,
        sign: 'missing',
        status,
        review_required: true,
        overlap: association,
      };
      transition.label = `${transition.from}>${transition.to} FTO=NA overlap=${association.overlap_class} status=${status}`;
      transitions.push(transition);
      transitionEvidence.push(buildTransitionEvidence(transition, association));
      flags.push(makeFlag(
        transition.point_time,
        Math.min(duration, transition.point_time + settings.frameStep),
        status,
        'review',
        'fto',
        association.matched_evidence_ids.join(':') || `${transition.from}>${transition.to}`,
      ));
      if (transfer.fto < -EPSILON) {
        flags.push(makeFlag(
          transfer.incoming_onset,
          Math.min(duration, transfer.incoming_onset + settings.frameStep),
          'manual_negative_fto_required',
          'review',
          'fto',
          `${transfer.from}>${transfer.to}`,
        ));
      }
      continue;
    }
    if (transfer.fto < -EPSILON && settings.overlapMode !== 'path_a_candidate') {
      flags.push(makeFlag(
        transfer.incoming_onset,
        Math.min(duration, transfer.incoming_onset + settings.frameStep),
        'manual_negative_fto_required',
        'review',
        'fto',
        `${transfer.from}>${transfer.to}`,
      ));
      continue;
    }
    const transition = {
      ...transfer,
      sequence: transitions.length + 1,
      point_time: round(transfer.fto < 0 ? transfer.outgoing_offset : transfer.incoming_onset),
      status: 'provisional',
      review_required: true,
    };
    transition.label = `${transition.from}>${transition.to} FTO=${formatSigned(transition.fto)} status=provisional`;
    transitions.push(transition);
    transitionEvidence.push(buildTransitionEvidence(transition, association));
    flags.push(makeFlag(
      transition.point_time,
      Math.min(duration, transition.point_time + settings.frameStep),
      'provisional_fto',
      'review',
      'fto',
      `${transition.from}>${transition.to}`,
    ));
  }

  const orderedFlags = coalesceFlags(flags).sort(flagSort);
  const flagsTier = flagsToFrameText(sharedActivity.frames, orderedFlags);
  return {
    settings,
    speakerTiers,
    floorTier: floorTier.map(({ start, end, text }) => ({ start, end, text })),
    transitions,
    transitionEvidence,
    flagsTier,
    flags: orderedFlags,
    metrics: summarizeInteraction(duration, speakerTiers, floorTier, transitions),
    diagnostics: {
      bc_event_ids: [...eventAnalysis.bcEventIds].sort(),
      failed_bid_event_ids: [...eventAnalysis.failedBidIds].sort(),
      floor_transfers: floorTransfers,
      event_floor_transfer_candidates: eventAnalysis.transfers,
      transitions_rebuilt_from_floor: settings.rebuildTransitionsFromFloor,
      transition_evidence: transitionEvidence,
      overlap_evidence_count: overlapEvidence.length,
      ambiguous_transfers: eventAnalysis.ambiguities,
      overlap_mode: settings.overlapMode,
      shared_activity_summary: sharedActivity.summary,
      pre_floor_backchannels: preFloor.evidence,
      pre_floor_response_acknowledgements: preFloor.responseEvidence
        .filter((item) => item.response_kind === 'question_response_acknowledgement'),
      acoustic_response_boundary_candidates: preFloor.responseEvidence
        .filter((item) => item.evidence_kind === 'acoustic_response_boundary_candidate'),
      acoustic_response_boundary_confirmations: eventAnalysis.responseAnchorConfirmations,
      terminal_administrative_cues: terminalCues.evidence,
    },
  };
}

export function classifyTerminalAdministrativeCues(events, duration) {
  const ordered = [...events].sort(eventSort);
  const evidence = [];
  const flags = [];
  const classified = ordered.map((event) => {
    if (event.semantic_evidence !== 'explicit_asr' || event.provisional_kind !== 'vocalisation') return event;
    const tokens = (event.tokens || []).map((token) => String(token).trim().toLowerCase()).filter(Boolean);
    if (!isAdministrativeStopCue(tokens) || activityEnd(event) - activityStart(event) > 2 + EPSILON) return event;
    const laterSubstantive = ordered.some((candidate) => candidate.id !== event.id
      && activityStart(candidate) >= activityEnd(event) - EPSILON
      && candidate.semantic_evidence === 'explicit_asr'
      && candidate.provisional_kind === 'vocalisation'
      && candidate.floor_eligible !== false
      && !isAdministrativeStopCue((candidate.tokens || []).map((token) => String(token).trim().toLowerCase()).filter(Boolean)));
    const nearRecordingEnd = Number(duration) - activityEnd(event) <= 5 + EPSILON;
    if (laterSubstantive && !nearRecordingEnd) return event;
    const record = {
      event_id: event.id,
      speaker: event.speaker,
      start: round(activityStart(event)),
      end: round(activityEnd(event)),
      tokens,
      decision: 'task_control_x_floor_ineligible',
    };
    evidence.push(record);
    flags.push(makeFlag(record.start, record.end, 'terminal_administrative_stop_cue', 'review', 'task_control', event.id));
    return {
      ...event,
      provisional_kind: 'artifact',
      floor_eligible: false,
      overlap_eligible: false,
      semantic_class: 'task_control',
      review_codes: [...new Set([...(event.review_codes || []), 'terminal_administrative_stop_cue'])],
    };
  });
  return { events: classified, evidence, flags };
}

function isAdministrativeStopCue(tokens) {
  const phrase = tokens.join(' ');
  return tokens.includes('stop')
    || phrase === "that's all"
    || phrase === 'that is all'
    || phrase === "we're done"
    || phrase === 'we are done';
}

export function classifyPreFloorBackchannels(events, settings = {}, preliminaryFloor = null) {
  const options = {
    backchannelLexicon: settings.backchannelLexicon || DEFAULT_BACKCHANNEL_LEXICON,
    turnProjectors: settings.turnProjectors || DEFAULT_TURN_PROJECTORS,
    backchannelMaxWords: Number(settings.backchannelMaxWords ?? 3),
    holderContinuationWindowSeconds: Number(settings.holderContinuationWindowSeconds ?? 1),
    acousticBackchannelEnabled: settings.acousticBackchannelEnabled === true,
    acousticBackchannelMinSeconds: Number(settings.acousticBackchannelMinSeconds ?? 0.12),
    acousticBackchannelMaxSeconds: Number(settings.acousticBackchannelMaxSeconds ?? 1),
    acousticResponseMaxSeconds: Number(settings.acousticResponseMaxSeconds ?? 1),
    explicitBackchannelMaxSeconds: Number(settings.explicitBackchannelMaxSeconds ?? 1),
    acknowledgementFormulas: settings.acknowledgementFormulas || DEFAULT_ACKNOWLEDGEMENT_FORMULAS,
    floorReleaseSeconds: Number(settings.floorReleaseSeconds ?? 1),
    questionResponseAcknowledgementEnabled: settings.questionResponseAcknowledgementEnabled !== false,
    questionResponseAcknowledgementLexicon:
      settings.questionResponseAcknowledgementLexicon || DEFAULT_RESPONSE_ACKNOWLEDGEMENT_LEXICON,
    questionResponseMaxGapSeconds: Number(settings.questionResponseMaxGapSeconds ?? 1),
    questionResponseContinuationSeconds: Number(settings.questionResponseContinuationSeconds ?? 2),
    questionResponseOverlapToleranceSeconds: Number(settings.questionResponseOverlapToleranceSeconds ?? 0.1),
    acousticResponseConfirmationSeconds: Number(settings.acousticResponseConfirmationSeconds ?? 3),
  };
  const ordered = [...events].sort(eventSort);
  const evidence = [];
  const responseEvidence = [];
  const responseAnchors = new Map();
  const eventIds = new Set();
  const flags = [];
  const eventById = new Map(ordered.map((event) => [event.id, event]));
  if (options.questionResponseAcknowledgementEnabled) {
    for (const event of ordered) {
      const response = questionResponseAcknowledgementEvidence(event, ordered, options);
      if (!response) continue;
      responseEvidence.push(response);
      responseAnchors.set(event.id, response);
      flags.push(makeFlag(
        response.start,
        response.end,
        'question_response_acknowledgement_onset',
        'review',
        'pre_floor_response',
        event.id,
      ));
    }
  }
  const tentative = ordered.map((event) => {
    if (responseAnchors.has(event.id)) return null;
    const candidate = preFloorCandidateKind(event, options);
    if (!candidate) return null;
    const support = surroundingHolderSupport(event, ordered, options, preliminaryFloor);
    return support ? { event, candidate, support } : null;
  }).filter(Boolean);
  const tentativeIds = new Set(tentative.map((item) => item.event.id));
  const accepted = new Map();
  for (const item of tentative) {
    const supportEvents = item.support.evidenceIds.map((id) => eventById.get(id)).filter(Boolean);
    const questionSupportedResponse = item.candidate === 'acoustic_nonlexical'
      && item.event.overlap_corroborated_identity !== true
      && activityEnd(item.event) - activityStart(item.event) <= options.acousticResponseMaxSeconds + EPSILON
      && supportEvents.some((candidate) => candidate.short_explicit_question === true
        || candidate.parent_turn_projector_candidate === true);
    if (questionSupportedResponse) {
      const record = {
        event_id: item.event.id,
        speaker: item.event.speaker,
        preceding_question_speaker: item.support.speaker,
        start: round(activityStart(item.event)),
        end: round(activityEnd(item.event)),
        duration_seconds: round(activityEnd(item.event) - activityStart(item.event)),
        runtime_evidence_ids: item.support.evidenceIds,
        evidence_kind: 'acoustic_response_boundary_candidate',
        reason_code: 'acoustic_response_boundary_candidate_pending_confirmation',
        decision: 'floor_ineligible_candidate_pending_explicit_confirmation',
        floor_eligible: false,
      };
      responseEvidence.push(record);
      responseAnchors.set(item.event.id, record);
      flags.push(makeFlag(
        record.start,
        record.end,
        'acoustic_response_boundary_candidate_pending_confirmation',
        'review',
        'pre_floor_response',
        item.event.id,
      ));
      continue;
    }
    if (item.candidate === 'acoustic_nonlexical'
      && (options.acousticBackchannelEnabled !== true
        || activityEnd(item.event) - activityStart(item.event) > options.acousticBackchannelMaxSeconds + EPSILON)) continue;
    const genericStructuralRequiresSurroundingHolder = item.candidate === 'explicit_structural_listener_feedback'
      && !['surrounding_holder_continuation', 'concurrent_holder_vocalisation'].includes(item.support.kind);
    if (genericStructuralRequiresSurroundingHolder) continue;
    const onlyCircularCandidateSupport = item.support.evidenceIds.length > 0
      && item.support.evidenceIds.every((id) => tentativeIds.has(id));
    if (!onlyCircularCandidateSupport) accepted.set(item.event.id, item);
  }
  const classified = ordered.map((event) => {
    const item = accepted.get(event.id);
    if (!item) {
      const response = responseAnchors.get(event.id);
      return response ? {
        ...event,
        floor_eligible: response.floor_eligible ?? event.floor_eligible,
        pre_floor_response_onset: response.floor_eligible === true,
        pre_floor_response_boundary_candidate: response.evidence_kind === 'acoustic_response_boundary_candidate',
        pre_floor_response_kind: response.response_kind || response.evidence_kind,
        pre_floor_response_reason_code: response.reason_code,
        response_support_speaker: response.preceding_question_speaker,
        response_question_event_id: response.question_event_id,
        response_continuation_event_id: response.continuation_event_id,
        response_runtime_evidence_ids: response.runtime_evidence_ids,
      } : event;
    }
    const { candidate, support } = item;
    eventIds.add(event.id);
    const record = {
      event_id: event.id,
      speaker: event.speaker,
      support_speaker: support.speaker,
      candidate_kind: candidate,
      support_kind: support.kind,
      start: round(activityStart(event)),
      end: round(activityEnd(event)),
      duration_seconds: round(activityEnd(event) - activityStart(event)),
      runtime_evidence_ids: support.evidenceIds,
      floor_eligible: false,
      turn_projector: false,
    };
    evidence.push(record);
    flags.push(makeFlag(
      record.start,
      record.end,
      candidate === 'acoustic_nonlexical' ? 'runtime_acoustic_backchannel_candidate' : 'explicit_backchannel_candidate',
      'review',
      'pre_floor_backchannel',
      event.id,
    ));
    return {
      ...event,
      floor_eligible: false,
      pre_floor_backchannel: true,
      pre_floor_backchannel_kind: candidate,
      pre_floor_backchannel_support_speaker: support.speaker,
      pre_floor_backchannel_evidence_ids: support.evidenceIds,
    };
  });
  return { events: classified, eventIds, evidence, responseEvidence, flags };
}

function questionResponseAcknowledgementEvidence(event, events, options) {
  if (event.semantic_evidence !== 'explicit_asr'
    || event.provisional_kind !== 'vocalisation'
    || event.floor_eligible === false) return null;
  const tokens = localInteractionTokens(event);
  const phrase = tokens.join(' ');
  const acknowledgementLexicon = new Set(options.questionResponseAcknowledgementLexicon);
  if (tokens.length === 0 || !acknowledgementLexicon.has(phrase)) return null;

  const eventStart = activityStart(event);
  const eventEnd = activityEnd(event);
  const question = events
    .filter((candidate) => candidate.id !== event.id
      && candidate.speaker !== event.speaker
      && candidate.semantic_evidence === 'explicit_asr'
      && candidate.provisional_kind === 'vocalisation'
      && candidate.floor_eligible !== false
      && isExplicitQuestionOrTurnProjector(candidate)
      && activityEnd(candidate) <= eventStart + options.questionResponseOverlapToleranceSeconds + EPSILON
      && eventStart - activityEnd(candidate) <= options.questionResponseMaxGapSeconds + EPSILON)
    .sort((left, right) => activityEnd(right) - activityEnd(left) || eventSort(left, right))[0];
  if (!question) return null;

  const continuation = events
    .filter((candidate) => candidate.id !== event.id
      && candidate.speaker === event.speaker
      && candidate.semantic_evidence === 'explicit_asr'
      && candidate.provisional_kind === 'vocalisation'
      && candidate.floor_eligible !== false
      && activityStart(candidate) >= eventEnd - EPSILON
      && activityStart(candidate) - eventEnd <= options.questionResponseContinuationSeconds + EPSILON
      && isSubstantiveLexicalContinuation(candidate, options))
    .sort(eventSort)[0];
  if (!continuation) return null;

  const competingFloorEvent = events.some((candidate) => candidate.id !== event.id
    && candidate.id !== continuation.id
    && candidate.speaker !== event.speaker
    && candidate.semantic_evidence === 'explicit_asr'
    && candidate.provisional_kind === 'vocalisation'
    && candidate.floor_eligible !== false
    && activityStart(candidate) >= eventEnd - EPSILON
    && activityStart(candidate) < activityStart(continuation) - EPSILON
    && isSubstantiveLexicalContinuation(candidate, options));
  if (competingFloorEvent) return null;

  return {
    event_id: event.id,
    speaker: event.speaker,
    preceding_question_speaker: question.speaker,
    question_event_id: question.id,
    continuation_event_id: continuation.id,
    acknowledgement_tokens: tokens,
    question_tokens: localInteractionTokens(question),
    continuation_tokens: localInteractionTokens(continuation),
    start: round(eventStart),
    end: round(eventEnd),
    duration_seconds: round(eventEnd - eventStart),
    question_to_ack_gap_seconds: round(Math.max(0, eventStart - activityEnd(question))),
    acknowledgement_to_continuation_gap_seconds: round(Math.max(0, activityStart(continuation) - eventEnd)),
    runtime_evidence_ids: [question.id, continuation.id],
    response_kind: 'question_response_acknowledgement',
    reason_code: 'question_response_acknowledgement_onset',
    decision: 'floor_eligible_response_onset',
    floor_eligible: true,
  };
}

function isExplicitQuestionOrTurnProjector(event) {
  return event.short_explicit_question === true
    || event.parent_turn_projector_candidate === true
    || event.hard_response_boundary === 'short_turn_projector_question';
}

function isSubstantiveLexicalContinuation(event, options) {
  const tokens = localInteractionTokens(event);
  if (tokens.length === 0) return false;
  const phrase = tokens.join(' ');
  const acknowledgementLexicon = new Set(options.questionResponseAcknowledgementLexicon);
  const acknowledgementFormulas = new Set(options.acknowledgementFormulas);
  return !acknowledgementLexicon.has(phrase) && !acknowledgementFormulas.has(phrase);
}

function localInteractionTokens(event) {
  return (event.tokens || []).map((token) => String(token).trim().toLowerCase()).filter(Boolean);
}

function buildPreliminaryFloor(duration, events, settings) {
  const preliminaryFlags = [];
  const analysis = analyzeEvents(events, duration, settings, preliminaryFlags);
  return buildFloorTier(duration, analysis, settings);
}

export function associateOverlapEvidenceToTransfer(transfer, overlapEvidence = [], settings = {}) {
  const tolerance = Number(settings.overlapAssociationToleranceSeconds ?? 0.1);
  const minimumOverlap = Number(settings.minOverlapSeconds ?? 0.1);
  const pair = [transfer.from, transfer.to].sort();
  const providerMatches = overlapEvidence.filter((evidence) => {
    const evidencePair = Array.isArray(evidence.speakers) ? [...evidence.speakers].sort() : [];
    if (evidencePair.length !== 2 || evidencePair[0] !== pair[0] || evidencePair[1] !== pair[1]) return false;
    return intersectsBoundaryBand(evidence, transfer.outgoing_offset, tolerance)
      || intersectsBoundaryBand(evidence, transfer.incoming_onset, tolerance);
  }).map((evidence) => ({
    ...evidence,
    overlap_class: evidence.overlap_class
      || (Number(evidence.end) - Number(evidence.start) >= minimumOverlap - EPSILON ? 'qualified' : 'subthreshold'),
    evidence_source: evidence.evidence_source || evidence.provider || 'provider_overlap',
  }));

  const rawGap = round(transfer.incoming_onset - transfer.outgoing_offset);
  const transferCandidateIds = sortedUnique(transfer.candidate_ids || [transfer.candidate_id]);
  const derived = rawGap < -EPSILON ? [{
    id: `derived_overlap:${transfer.from}>${transfer.to}:${Number(transfer.incoming_onset).toFixed(6)}:${Number(transfer.outgoing_offset).toFixed(6)}`,
    start: transfer.incoming_onset,
    end: transfer.outgoing_offset,
    duration_seconds: round(-rawGap),
    speakers: pair,
    source_turn_ids: transferCandidateIds,
    overlap_class: -rawGap >= minimumOverlap - EPSILON ? 'qualified' : 'subthreshold',
    evidence_source: 'derived_transfer_turn_timing',
  }] : [];
  const matches = [...providerMatches, ...derived].sort((left, right) =>
    Number(left.start) - Number(right.start) || Number(left.end) - Number(right.end) || String(left.id).localeCompare(String(right.id)),
  );
  if (matches.length === 0) {
    return {
      overlap_class: 'none',
      overlap_start: null,
      overlap_end: null,
      overlap_duration: null,
      evidence_source: 'transfer_turn_timing',
      matched_evidence_ids: [],
      evidence_ids: transferCandidateIds.map((id) => `transfer_candidate:${id}`),
      association_tolerance_sec: round(tolerance),
    };
  }
  const overlapClass = matches.some((item) => item.overlap_class === 'qualified') ? 'qualified' : 'subthreshold';
  return {
    overlap_class: overlapClass,
    overlap_start: round(Math.min(...matches.map((item) => Number(item.start)))),
    overlap_end: round(Math.max(...matches.map((item) => Number(item.end)))),
    overlap_duration: round(unionDuration(matches)),
    evidence_source: sortedUnique(matches.map((item) => item.evidence_source)).join(';'),
    matched_evidence_ids: sortedUnique(matches.map((item) => item.id)),
    evidence_ids: sortedUnique([
      ...matches.map((item) => item.id),
      ...transferCandidateIds.map((id) => `transfer_candidate:${id}`),
    ]),
    association_tolerance_sec: round(tolerance),
  };
}

export function recomputePathACandidateFromStoredEvidence(row, capabilityEvidence) {
  if (!['overlap_present_offset_not_measured', 'subthreshold_overlap_present_offset_not_measured'].includes(row?.fto_status)) {
    throw new Error('stored transition evidence is not a missing-overlap FTO row');
  }
  if (!capabilityEvidence || !Array.isArray(capabilityEvidence.overlap_evidence)
    || !Array.isArray(capabilityEvidence.mapped_attribution_turns)) {
    throw new Error('stored overlap capability evidence is required');
  }
  const evidenceIds = parseEvidenceIds(row.evidence_ids);
  const matchedOverlap = capabilityEvidence.overlap_evidence
    .filter((item) => evidenceIds.includes(String(item.id)));
  if (matchedOverlap.length === 0) throw new Error('stored overlap evidence IDs cannot be resolved');
  const turnsById = new Map(capabilityEvidence.mapped_attribution_turns.map((turn) => [String(turn.id), turn]));
  const candidates = [];
  for (const overlap of matchedOverlap) {
    const turns = (overlap.source_turn_ids || []).map((id) => turnsById.get(String(id))).filter(Boolean);
    const outgoing = turns.filter((turn) => turn.speaker === row.from_speaker);
    const incoming = turns.filter((turn) => turn.speaker === row.to_speaker);
    for (const fromTurn of outgoing) {
      for (const toTurn of incoming) {
        candidates.push({
          evidence_id: String(overlap.id),
          outgoing_turn_id: String(fromTurn.id),
          incoming_turn_id: String(toTurn.id),
          turn_end_sec: Number(fromTurn.end_sec),
          turn_start_sec: Number(toTurn.start_sec),
        });
      }
    }
  }
  if (candidates.length === 0 || candidates.some((item) =>
    !Number.isFinite(item.turn_end_sec) || !Number.isFinite(item.turn_start_sec))) {
    throw new Error('stored overlap source turns cannot reconstruct the transition');
  }
  const anchorEnd = Number(row.turn_end_sec);
  const anchorStart = Number(row.turn_start_sec);
  candidates.sort((left, right) => {
    const leftDistance = Math.abs(left.turn_end_sec - anchorEnd) + Math.abs(left.turn_start_sec - anchorStart);
    const rightDistance = Math.abs(right.turn_end_sec - anchorEnd) + Math.abs(right.turn_start_sec - anchorStart);
    return leftDistance - rightDistance
      || left.turn_start_sec - right.turn_start_sec
      || right.turn_end_sec - left.turn_end_sec
      || left.evidence_id.localeCompare(right.evidence_id);
  });
  const selected = candidates[0];
  const fto = round(selected.turn_start_sec - selected.turn_end_sec);
  return {
    from_speaker: row.from_speaker,
    to_speaker: row.to_speaker,
    turn_end_sec: selected.turn_end_sec,
    turn_start_sec: selected.turn_start_sec,
    fto_sec: fto,
    sign: fto < -EPSILON ? 'negative' : fto > EPSILON ? 'positive' : 'zero',
    status: 'path_a_recomputed_candidate_requires_validation',
    evidence_id: selected.evidence_id,
    outgoing_turn_id: selected.outgoing_turn_id,
    incoming_turn_id: selected.incoming_turn_id,
    evidence_ids: [...evidenceIds],
  };
}

function parseEvidenceIds(value) {
  if (Array.isArray(value)) return sortedUnique(value);
  if (typeof value === 'string' && value.trim().startsWith('[')) {
    const parsed = JSON.parse(value);
    if (!Array.isArray(parsed)) throw new Error('stored evidence IDs must be an array');
    return sortedUnique(parsed);
  }
  return sortedUnique(String(value || '').split(';'));
}

function buildTransitionEvidence(transition, association) {
  return {
    sequence: transition.sequence,
    from: transition.from,
    to: transition.to,
    turn_end: transition.outgoing_offset,
    turn_start: transition.incoming_onset,
    raw_gap: round(transition.incoming_onset - transition.outgoing_offset),
    overlap_start: association.overlap_start,
    overlap_end: association.overlap_end,
    overlap_duration: association.overlap_duration,
    overlap_class: association.overlap_class,
    evidence_source: association.evidence_source,
    evidence_ids: association.evidence_ids,
    fto_status: transition.status,
    review_required: transition.review_required,
  };
}

function intersectsBoundaryBand(evidence, boundary, tolerance) {
  const start = Number(evidence.start);
  const end = Number(evidence.end);
  return Number.isFinite(start) && Number.isFinite(end)
    && end >= Number(boundary) - tolerance - EPSILON
    && start <= Number(boundary) + tolerance + EPSILON;
}

function unionDuration(intervals) {
  const ordered = intervals
    .map((item) => ({ start: Number(item.start), end: Number(item.end) }))
    .sort((left, right) => left.start - right.start || left.end - right.end);
  let total = 0;
  let current = null;
  for (const interval of ordered) {
    if (!current || interval.start > current.end + EPSILON) {
      if (current) total += current.end - current.start;
      current = { ...interval };
    } else current.end = Math.max(current.end, interval.end);
  }
  if (current) total += current.end - current.start;
  return total;
}

function analyzeEvents(events, duration, settings, flags, preclassifiedBackchannelIds = new Set()) {
  const ordered = [...events].sort(eventSort);
  const floorOrdered = ordered.filter((event) => settings.strictEvidenceRoles
    ? event.floor_eligible === true
    : event.floor_eligible !== false);
  const vocalisations = floorOrdered.filter((event) => event.provisional_kind === 'vocalisation');
  const holderRetentionEvents = ordered.filter((event) => event.holder_retention_eligible === true
    && event.floor_eligible === false && event.provisional_kind === 'vocalisation');
  const responseBoundaryCandidates = ordered.filter((event) => event.pre_floor_response_boundary_candidate === true
    && event.floor_eligible === false && event.provisional_kind === 'vocalisation');
  const responseAnchorConfirmations = [];
  const bcEventIds = new Set(preclassifiedBackchannelIds);
  const failedBidIds = new Set();
  const transferCandidates = [];
  const claims = [];
  let holder = null;
  let pendingTransfer = null;

  for (const event of floorOrdered) {
    const eventStart = activityStart(event);
    const eventEnd = activityEnd(event);
    if (pendingTransfer && eventStart >= pendingTransfer.effective_time - EPSILON) {
      holder = pendingTransfer.to;
      pendingTransfer = null;
    }

    if (event.provisional_kind === 'laughter' && event.soft_chuckle && holder) {
      if (evaluateBackchannel(event, holder, floorOrdered, settings).qualifies) bcEventIds.add(event.id);
      continue;
    }
    if (event.provisional_kind !== 'vocalisation') continue;
    if (!holder) {
      holder = event.speaker;
      claims.push({ speaker: event.speaker, onset: eventStart });
      continue;
    }
    if (event.speaker === holder) continue;

    const bc = evaluateBackchannel(event, holder, floorOrdered, settings);
    if (bc.qualifies) {
      bcEventIds.add(event.id);
      continue;
    }

    const overlappingHolder = vocalisations.filter((candidate) =>
      candidate.speaker === holder && eventsOverlapActivity(candidate, event),
    );
    if (overlappingHolder.some((candidate) => activityExtendsThrough(candidate, eventEnd, eventStart))) {
      failedBidIds.add(event.id);
      flags.push(makeFlag(eventStart, eventEnd, 'failed_turn_bid', 'review', 'floor', event.id));
      continue;
    }

    const priorHolder = vocalisations.filter((candidate) =>
      candidate.speaker === holder && activityStart(candidate) < eventStart + EPSILON,
    );
    const priorOffsets = [
      ...priorHolder
      .flatMap((candidate) => activitySegments(candidate).map((segment) => segment.end))
      .filter((end) => end <= eventStart + EPSILON),
      ...holderRetentionEvents
        .filter((candidate) => candidate.speaker === holder && activityStart(candidate) <= eventStart + EPSILON)
        .map((candidate) => activityStart(candidate)),
    ];
    const incomingExplicitProjector = event.short_explicit_question === true
      || event.parent_turn_projector_candidate === true;
    const lastHolderSpeechEnd = priorHolder
      .flatMap((candidate) => activitySegments(candidate).map((segment) => segment.end))
      .filter((end) => end <= eventStart + EPSILON)
      .sort((left, right) => right - left)[0] ?? null;
    const continuityResidual = incomingExplicitProjector && lastHolderSpeechEnd != null
      ? holderRetentionEvents.filter((candidate) => candidate.speaker === holder
        && activityStart(candidate) >= lastHolderSpeechEnd - EPSILON
        && activityStart(candidate) - lastHolderSpeechEnd <= settings.floorReleaseSeconds + EPSILON
        && activityEnd(candidate) <= eventStart + EPSILON
        && eventStart - activityEnd(candidate) <= settings.floorReleaseSeconds + EPSILON)
        .sort((left, right) => activityEnd(right) - activityEnd(left) || eventSort(left, right))[0]
      : null;
    if (continuityResidual) {
      flags.push(makeFlag(
        activityStart(continuityResidual),
        eventStart,
        'prior_holder_residual_continuity_to_question',
        'review',
        'floor',
        `${continuityResidual.id}>${event.id}`,
      ));
    }
    const responseAnchor = responseBoundaryCandidates.filter((candidate) => candidate.speaker === event.speaker
      && candidate.response_support_speaker === holder
      && activityStart(candidate) >= (lastHolderSpeechEnd ?? 0) - EPSILON
      && activityStart(candidate) <= eventStart + EPSILON
      && eventStart - activityStart(candidate) <= settings.acousticResponseConfirmationSeconds + EPSILON
      && event.semantic_evidence === 'explicit_asr'
      && localInteractionTokens(event).length > 0)
      .sort((left, right) => activityStart(left) - activityStart(right) || eventSort(left, right))[0];
    if (responseAnchor) {
      const confirmation = {
        residual_event_id: responseAnchor.id,
        confirming_event_id: event.id,
        speaker: event.speaker,
        preceding_question_speaker: responseAnchor.response_support_speaker,
        boundary_anchor_start: round(activityStart(responseAnchor)),
        confirmation_start: round(eventStart),
        confirmation_gap_seconds: round(eventStart - activityStart(responseAnchor)),
        reason_code: 'acoustic_response_boundary_anchor_confirmed',
        decision: 'provisional_boundary_anchor_confirmed_by_explicit_same_speaker_turn',
        runtime_evidence_ids: [responseAnchor.id, event.id],
      };
      responseAnchorConfirmations.push(confirmation);
      flags.push(makeFlag(
        activityStart(responseAnchor),
        eventStart,
        'acoustic_response_boundary_anchor_confirmed',
        'review',
        'floor',
        `${responseAnchor.id}>${event.id}`,
      ));
    }
    const outgoingOffset = overlappingHolder.length
      ? Math.max(...overlappingHolder.flatMap((candidate) => overlappingActivityEnds(candidate, event)))
      : continuityResidual ? activityEnd(continuityResidual)
        : (priorOffsets.length ? Math.max(...priorOffsets) : eventStart);
    const transfer = {
      from: holder,
      to: event.speaker,
      outgoing_offset: round(outgoingOffset),
      incoming_onset: round(responseAnchor ? activityStart(responseAnchor) : eventStart),
      fto: round((responseAnchor ? activityStart(responseAnchor) : eventStart) - outgoingOffset),
      effective_time: round(Math.max(outgoingOffset, responseAnchor ? activityStart(responseAnchor) : eventStart)),
    };
    transfer.candidate_id = event.id;
    transfer.candidate_end = eventEnd;
    transferCandidates.push(transfer);
    if (transfer.effective_time > eventStart + EPSILON) pendingTransfer = transfer;
    else holder = event.speaker;
  }

  if (pendingTransfer && pendingTransfer.effective_time <= duration + EPSILON) holder = pendingTransfer.to;
  const resolved = resolveCompetingTransfers(transferCandidates, flags);
  return {
    claims,
    transfers: resolved.transfers,
    ambiguities: resolved.ambiguities,
    bcEventIds,
    failedBidIds,
    finalHolder: holder,
    vocalisations,
    holderRetentionEvents,
    responseAnchorConfirmations,
  };
}

function buildFloorTier(duration, analysis, settings) {
  if (analysis.claims.length === 0) return [{ start: 0, end: duration, text: 'FREE', free_kind: 'shs' }];
  const firstClaim = analysis.claims[0];
  const intervals = [];
  if (firstClaim.onset > EPSILON) intervals.push({ start: 0, end: firstClaim.onset, text: 'FREE', free_kind: 'shs' });
  let cursor = firstClaim.onset;
  let holder = firstClaim.speaker;

  const actions = [
    ...analysis.transfers.map((transfer) => ({ ...transfer, kind: 'transfer', sort_time: transfer.outgoing_offset })),
    ...analysis.ambiguities.map((ambiguity) => ({ ...ambiguity, kind: 'ambiguity', sort_time: ambiguity.outgoing_offset })),
  ].sort((left, right) => left.sort_time - right.sort_time || left.kind.localeCompare(right.kind));

  for (const action of actions) {
    if (action.kind === 'ambiguity') {
      const outgoingOffset = Math.max(cursor, action.outgoing_offset);
      const resolutionTime = Math.max(outgoingOffset, action.resolution_time);
      if (resolutionTime > cursor + EPSILON) {
        intervals.push({ start: cursor, end: resolutionTime, text: holder, free_kind: null });
      }
      cursor = resolutionTime;
      holder = action.resolved_to;
      continue;
    }
    const transfer = action;
    const outgoingOffset = Math.max(cursor, transfer.outgoing_offset);
    if (outgoingOffset > cursor + EPSILON) {
      intervals.push({ start: cursor, end: outgoingOffset, text: holder, free_kind: null });
    }
    if (transfer.incoming_onset > outgoingOffset + EPSILON) {
      const gap = transfer.incoming_onset - outgoingOffset;
      intervals.push({
        start: outgoingOffset,
        end: transfer.incoming_onset,
        text: 'FREE',
        free_kind: gap <= settings.floorReleaseSeconds + EPSILON ? 'tr' : 'shs',
      });
      cursor = transfer.incoming_onset;
    } else {
      cursor = outgoingOffset;
    }
    holder = transfer.to;
  }

  if (!holder) {
    if (cursor < duration - EPSILON) intervals.push({ start: cursor, end: duration, text: 'FREE', free_kind: 'shs' });
    return mergeFloorIntervals(fillFloorGaps(intervals, duration));
  }
  const allTransferEnds = analysis.transfers.filter((transfer) => transfer.to === holder).map((transfer) => transfer.incoming_onset);
  const minimumFinalStart = allTransferEnds.length ? Math.max(...allTransferEnds) : cursor;
  const finalSpeechEnd = findFinalHolderEnd(holder, minimumFinalStart, duration, analysis);
  if (finalSpeechEnd > cursor + EPSILON) intervals.push({ start: cursor, end: finalSpeechEnd, text: holder, free_kind: null });
  if (finalSpeechEnd < duration - EPSILON) intervals.push({ start: finalSpeechEnd, end: duration, text: 'FREE', free_kind: 'shs' });
  return mergeFloorIntervals(fillFloorGaps(intervals, duration));
}

function rebuildTransferCandidatesFromFloor(floorTier, eventCandidates) {
  const transfers = [];
  let previousHolder = null;
  let pendingDeparture = null;

  for (const interval of floorTier) {
    if (!SPEAKERS.includes(interval.text)) {
      if (previousHolder && pendingDeparture === null) pendingDeparture = interval.start;
      continue;
    }
    if (!previousHolder) {
      previousHolder = interval.text;
      pendingDeparture = null;
      continue;
    }
    if (interval.text === previousHolder) {
      pendingDeparture = null;
      continue;
    }

    const outgoingOffset = pendingDeparture ?? interval.start;
    const incomingOnset = interval.start;
    const compatible = eventCandidates
      .filter((candidate) => candidate.from === previousHolder && candidate.to === interval.text)
      .sort((left, right) =>
        Math.abs(left.incoming_onset - incomingOnset) - Math.abs(right.incoming_onset - incomingOnset)
        || Math.abs(left.outgoing_offset - outgoingOffset) - Math.abs(right.outgoing_offset - outgoingOffset)
        || String(left.candidate_id).localeCompare(String(right.candidate_id)),
      )[0];
    const candidateId = compatible?.candidate_id
      || `floor_transfer:${previousHolder}>${interval.text}:${Number(incomingOnset).toFixed(6)}`;
    transfers.push({
      ...(compatible || {}),
      from: previousHolder,
      to: interval.text,
      outgoing_offset: round(outgoingOffset),
      incoming_onset: round(incomingOnset),
      fto: round(incomingOnset - outgoingOffset),
      effective_time: round(Math.max(outgoingOffset, incomingOnset)),
      candidate_id: candidateId,
      candidate_ids: compatible?.candidate_ids || [candidateId],
      candidate_end: compatible?.candidate_end ?? interval.end,
      rebuilt_from_floor: true,
    });
    previousHolder = interval.text;
    pendingDeparture = null;
  }
  return transfers;
}

function findFinalHolderEnd(holder, start, duration, analysis) {
  const ends = [
    ...analysis.vocalisations
    .filter((event) => event.speaker === holder && activityEnd(event) >= start - EPSILON)
    .map((event) => activityEnd(event)),
    ...(analysis.holderRetentionEvents || [])
      .filter((event) => event.speaker === holder && activityStart(event) >= start - EPSILON)
      .map((event) => activityStart(event)),
  ];
  return Math.min(duration, ends.length ? Math.max(...ends) : start);
}

function labelForFrame({
  speaker,
  own,
  floor,
  bcEventIds,
  qualifiedOverlap,
  thresholdFilledSpeaker,
  strictEvidenceRoles,
}) {
  const excluded = own.find((event) =>
    event.provisional_kind === 'artifact'
    || (event.provisional_kind === 'laughter' && !bcEventIds.has(event.id)),
  );
  if (excluded) return 'x';
  const vocalisations = own.filter((event) => event.provisional_kind === 'vocalisation');
  const activeBackchannel = own.some((event) => bcEventIds.has(event.id));
  if (qualifiedOverlap && (vocalisations.length > 0 || activeBackchannel)) return 'ol';
  if (activeBackchannel) return 'bc';
  if (vocalisations.length > 0) {
    const allExplicitFilledPauses = vocalisations.every((event) => strictEvidenceRoles
      ? event.semantic_evidence === 'explicit_asr' && event.semantic_class === 'filled_pause'
      : event.lexical_class === 'filled_pause' || event.lexical_class === 'nonlexical');
    return allExplicitFilledPauses ? 'f' : 's';
  }
  if (thresholdFilledSpeaker === speaker && floor.text === speaker) return 's';
  if (floor.text === speaker) return 'op';
  if (SPEAKERS.includes(floor.text)) return 'pf';
  return floor.free_kind || 'shs';
}

function resolveCompetingTransfers(candidates, flags) {
  const groups = new Map();
  for (const candidate of candidates) {
    const key = `${candidate.from}@${candidate.outgoing_offset.toFixed(6)}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(candidate);
  }
  const transfers = [];
  const ambiguities = [];
  for (const group of groups.values()) {
    const ordered = [...group].sort((left, right) =>
      left.incoming_onset - right.incoming_onset
      || left.to.localeCompare(right.to)
      || left.candidate_id.localeCompare(right.candidate_id),
    );
    const targets = consolidateTransferTargets(ordered);
    if (targets.length === 1) {
      transfers.push(targets[0]);
      continue;
    }
    const ranked = [...targets].sort((left, right) =>
      right.candidate_end - left.candidate_end || left.to.localeCompare(right.to),
    );
    const longest = ranked[0];
    const secondEnd = ranked[1].candidate_end;
    const uniquelyContinues = longest.candidate_end > secondEnd + EPSILON;
    const ambiguity = {
      from: targets[0].from,
      outgoing_offset: targets[0].outgoing_offset,
      incoming_onset: Math.min(...targets.map((candidate) => candidate.incoming_onset)),
      resolution_time: round(uniquelyContinues ? secondEnd : Math.max(...targets.map((candidate) => candidate.candidate_end))),
      resolved_to: uniquelyContinues ? longest.to : null,
      candidate_ids: targets.flatMap((candidate) => candidate.candidate_ids).sort(),
    };
    ambiguities.push(ambiguity);
    flags.push(makeFlag(
      ambiguity.incoming_onset,
      ambiguity.resolution_time,
      'ambiguous_competing_transfer',
      'review',
      'floor',
      ambiguity.candidate_ids.join(','),
    ));
  }
  transfers.sort((left, right) => left.effective_time - right.effective_time || left.to.localeCompare(right.to));
  ambiguities.sort((left, right) => left.outgoing_offset - right.outgoing_offset || left.from.localeCompare(right.from));
  return { transfers, ambiguities };
}

function consolidateTransferTargets(candidates) {
  const byTarget = new Map();
  for (const candidate of candidates) {
    if (!byTarget.has(candidate.to)) byTarget.set(candidate.to, []);
    byTarget.get(candidate.to).push(candidate);
  }
  return [...byTarget.entries()].map(([target, targetCandidates]) => {
    const ordered = [...targetCandidates].sort((left, right) =>
      left.incoming_onset - right.incoming_onset || left.candidate_id.localeCompare(right.candidate_id),
    );
    const first = ordered[0];
    const incomingOnset = Math.min(...ordered.map((candidate) => candidate.incoming_onset));
    const outgoingOffset = Math.max(...ordered.map((candidate) => candidate.outgoing_offset));
    const candidateIds = [...new Set(ordered.map((candidate) => candidate.candidate_id))].sort();
    return {
      ...first,
      to: target,
      incoming_onset: round(incomingOnset),
      outgoing_offset: round(outgoingOffset),
      fto: round(incomingOnset - outgoingOffset),
      effective_time: round(Math.max(incomingOnset, outgoingOffset)),
      candidate_end: round(Math.max(...ordered.map((candidate) => candidate.candidate_end))),
      candidate_id: candidateIds[0],
      candidate_ids: candidateIds,
    };
  }).sort((left, right) => left.to.localeCompare(right.to));
}

function bridgeSpeakerForThresholdFill(frame, events, bcEventIds, floor) {
  if (!SPEAKERS.includes(floor.text)) return null;
  const turnTaking = events.filter((event) =>
    event.provisional_kind === 'vocalisation'
    && event.floor_eligible !== false
    && !bcEventIds.has(event.id),
  );
  const before = turnTaking
    .filter((event) => activityEnd(event) <= frame.start + EPSILON)
    .sort((left, right) => activityEnd(right) - activityEnd(left) || eventSort(left, right))[0];
  const after = turnTaking
    .filter((event) => activityStart(event) >= frame.end - EPSILON)
    .sort(eventSort)[0];
  if (!before || !after || before.speaker !== after.speaker) return null;
  return before.speaker === floor.text ? floor.text : null;
}

function qualifyOverlapRuns(frames, rawOverlap, minimumSeconds, flags) {
  const qualified = Array(frames.length).fill(false);
  let start = null;
  for (let index = 0; index <= frames.length; index += 1) {
    const active = index < frames.length && rawOverlap[index];
    if (active && start === null) start = index;
    if (!active && start !== null) {
      const overlapDuration = frames[index - 1].end - frames[start].start;
      if (overlapDuration + EPSILON >= minimumSeconds) {
        for (let frameIndex = start; frameIndex < index; frameIndex += 1) qualified[frameIndex] = true;
      } else {
        flags.push(makeFlag(frames[start].start, frames[index - 1].end, 'subthreshold_overlap', 'review', 'overlap'));
      }
      start = null;
    }
  }
  return qualified;
}

function holderCarriesOn(holder, event, events, {
  lexicon,
  projectors,
  maxWords,
  strictEvidenceRoles,
  continuationWindowSeconds,
}) {
  const holderEvents = events.filter((candidate) =>
    candidate.speaker === holder && candidate.provisional_kind === 'vocalisation',
  );
  const eventStart = activityStart(event);
  const eventEnd = activityEnd(event);
  if (holderEvents.some((candidate) => activityExtendsThrough(candidate, eventEnd, eventStart))) return true;
  const future = events
    .filter((candidate) => candidate.id !== event.id
      && candidate.provisional_kind === 'vocalisation'
      && activityStart(candidate) >= eventEnd - EPSILON)
    .sort(eventSort);
  for (const candidate of future) {
    if (activityStart(candidate) - eventEnd > continuationWindowSeconds + EPSILON) return false;
    if (candidate.speaker === holder) return true;
    if (!passesBasicBackchannel(candidate, lexicon, projectors, maxWords, strictEvidenceRoles)) return false;
  }
  return false;
}

function passesBasicBackchannel(event, lexicon, projectors, maxWords, strictEvidenceRoles) {
  if (strictEvidenceRoles && event.semantic_evidence !== 'explicit_asr') return false;
  const tokens = interactionTokens(event);
  const phrase = tokens.join(' ');
  const pureNonLexical = (event.lexical_class === 'nonlexical' && tokens.length === 0) || event.soft_chuckle === true;
  const lengthPass = pureNonLexical || tokens.length <= maxWords;
  const matched = phrase && lexicon.has(phrase) ? tokens.length : tokens.filter((token) => lexicon.has(token)).length;
  const lexicalPass = pureNonLexical || (tokens.length > 0 && matched > tokens.length / 2);
  const projectorPass = pureNonLexical || !projectors.some((projector) => phrase === projector || phrase.startsWith(`${projector} `));
  return lengthPass && lexicalPass && projectorPass;
}

function preFloorCandidateKind(event, options) {
  if (event.provisional_kind !== 'vocalisation') return null;
  const duration = activityEnd(event) - activityStart(event);
  const localTokens = (event.tokens || []).map((token) => String(token).trim().toLowerCase()).filter(Boolean);
  const tokens = interactionTokens(event).map((token) => String(token).trim().toLowerCase()).filter(Boolean);
  const phrase = tokens.join(' ');
  const localPhrase = localTokens.join(' ');
  const projective = event.short_explicit_question === true
    || event.parent_turn_projector_candidate === true
    || options.turnProjectors.some((projector) => phrase === projector || phrase.startsWith(`${projector} `)
      || localPhrase === projector || localPhrase.startsWith(`${projector} `));
  if (projective) return null;

  if (event.semantic_evidence === 'explicit_asr') {
    if (duration > options.explicitBackchannelMaxSeconds + EPSILON) return null;
    if (localTokens.length === 0 || localTokens.length > options.backchannelMaxWords) return null;
    const lexicon = new Set(options.backchannelLexicon);
    const matched = lexicon.has(localPhrase)
      ? localTokens.length
      : localTokens.filter((token) => lexicon.has(token)).length;
    if (matched > localTokens.length / 2) return 'explicit_lexical';
    if (new Set(options.acknowledgementFormulas).has(localPhrase)) return 'explicit_acknowledgement_formula';
    const propositionStart = new Set(['i', 'we', 'you', 'he', 'she', 'they']);
    return propositionStart.has(localTokens[0]) ? null : 'explicit_structural_listener_feedback';
  }

  const acousticCandidate = event.runtime_acoustic_bc_candidate === true
    && event.semantic_evidence === 'unknown_acoustic'
    && event.floor_eligible === false
    && tokens.length === 0
    && duration >= options.acousticBackchannelMinSeconds - EPSILON
    && duration <= Math.max(options.acousticBackchannelMaxSeconds, options.acousticResponseMaxSeconds) + EPSILON;
  return acousticCandidate ? 'acoustic_nonlexical' : null;
}

function surroundingHolderSupport(event, events, options, preliminaryFloor = null) {
  const eventStart = activityStart(event);
  const eventEnd = activityEnd(event);
  const priorHolder = preliminaryFloor
    ? floorAt(preliminaryFloor, Math.max(0, eventStart - Math.max(EPSILON, FRAME_STEP_SECONDS / 2)))?.text
    : null;
  const eligible = events.filter((candidate) => candidate.id !== event.id
    && candidate.speaker !== event.speaker
    && candidate.provisional_kind === 'vocalisation'
    && candidate.floor_eligible !== false);
  const bySpeaker = new Map();
  for (const candidate of eligible) {
    if (!bySpeaker.has(candidate.speaker)) bySpeaker.set(candidate.speaker, []);
    bySpeaker.get(candidate.speaker).push(candidate);
  }
  const supports = [];
  const preliminaryHolder = preliminaryFloor
    ? floorAt(preliminaryFloor, (eventStart + eventEnd) / 2)?.text
    : null;
  for (const [speaker, candidates] of bySpeaker) {
    if (SPEAKERS.includes(priorHolder) && speaker !== priorHolder) continue;
    const concurrent = candidates.filter((candidate) => activitySegments(candidate).some((segment) =>
      segment.start < eventEnd - EPSILON
      && segment.end > eventStart + EPSILON
      && segment.end >= eventEnd - EPSILON));
    if (concurrent.length > 0) {
      supports.push({
        speaker,
        kind: 'concurrent_holder_vocalisation',
        score: 2,
        evidenceIds: concurrent.map((candidate) => candidate.id).sort(),
      });
      continue;
    }
    const futureContinuation = candidates
      .filter((candidate) => activityStart(candidate) >= eventEnd - EPSILON
        && activityStart(candidate) - eventEnd <= options.holderContinuationWindowSeconds + EPSILON)
      .sort(eventSort)[0];
    if ((speaker === priorHolder || speaker === preliminaryHolder) && futureContinuation) {
      supports.push({
        speaker,
        kind: speaker === priorHolder
          ? 'prior_floor_holder_continues'
          : 'preliminary_floor_holder_continues',
        score: 1.5,
        evidenceIds: [futureContinuation.id],
      });
      continue;
    }
    const before = candidates
      .filter((candidate) => activityStart(candidate) <= eventStart + EPSILON && activityEnd(candidate) <= eventEnd + EPSILON)
      .sort((left, right) => activityEnd(right) - activityEnd(left) || eventSort(left, right))[0];
    const after = candidates
      .filter((candidate) => activityStart(candidate) >= eventEnd - EPSILON
        && activityStart(candidate) - eventEnd <= options.holderContinuationWindowSeconds + EPSILON)
      .sort(eventSort)[0];
    if (before && after) {
      supports.push({
        speaker,
        kind: 'surrounding_holder_continuation',
        score: 1,
        evidenceIds: [before.id, after.id].sort(),
      });
    }
    const recent = candidates
      .filter((candidate) => activityEnd(candidate) <= eventStart + EPSILON
        && eventStart - activityEnd(candidate) <= options.floorReleaseSeconds + EPSILON)
      .sort((left, right) => activityEnd(right) - activityEnd(left) || eventSort(left, right))[0];
    if (recent) {
      const recentWindowStart = eventStart - options.floorReleaseSeconds;
      const recentSeconds = candidates.reduce((sum, candidate) => {
        const start = Math.max(recentWindowStart, activityStart(candidate));
        const end = Math.min(eventStart, activityEnd(candidate));
        return sum + Math.max(0, end - start);
      }, 0);
      const candidateDuration = eventEnd - eventStart;
      if (recentSeconds + EPSILON >= Math.min(candidateDuration, 0.25)) {
        supports.push({
          speaker,
          kind: 'recent_holder_within_L',
          score: 0.75,
          evidenceIds: candidates.filter((candidate) => activityEnd(candidate) > recentWindowStart - EPSILON
            && activityEnd(candidate) <= eventStart + EPSILON).map((candidate) => candidate.id).sort(),
        });
      }
    }
  }
  return supports.sort((left, right) => right.score - left.score
    || left.speaker.localeCompare(right.speaker)
    || left.evidenceIds.join('|').localeCompare(right.evidenceIds.join('|')))[0] || null;
}

function activeEventsAt(events, time) {
  return events.filter((event) => event.activity_eligible !== false
    && activitySegments(event).some((segment) => segment.start <= time + EPSILON && time < segment.end - EPSILON));
}

function interactionTokens(event) {
  return Array.isArray(event.interaction_tokens) && event.interaction_tokens.length
    ? event.interaction_tokens
    : (event.tokens || []);
}

function activitySegments(event) {
  return Array.isArray(event.activity_segments) && event.activity_segments.length
    ? event.activity_segments
    : [{ start: event.start, end: event.end }];
}

function activityStart(event) {
  return Math.min(...activitySegments(event).map((segment) => segment.start));
}

function activityEnd(event) {
  return Math.max(...activitySegments(event).map((segment) => segment.end));
}

function eventsOverlapActivity(left, right) {
  return activitySegments(left).some((leftSegment) => activitySegments(right).some((rightSegment) =>
    leftSegment.start < rightSegment.end - EPSILON && leftSegment.end > rightSegment.start + EPSILON,
  ));
}

function activityExtendsThrough(event, targetEnd, targetStart) {
  return activitySegments(event).some((segment) =>
    segment.start < targetEnd - EPSILON
    && segment.end > targetStart + EPSILON
    && segment.end >= targetEnd - EPSILON,
  );
}

function overlappingActivityEnds(left, right) {
  const ends = [];
  for (const leftSegment of activitySegments(left)) {
    for (const rightSegment of activitySegments(right)) {
      if (leftSegment.start < rightSegment.end - EPSILON && leftSegment.end > rightSegment.start + EPSILON) {
        ends.push(leftSegment.end);
      }
    }
  }
  return ends;
}

function floorAt(intervals, time) {
  return intervals.find((interval) => interval.start <= time + EPSILON && time < interval.end - EPSILON)
    || intervals[intervals.length - 1];
}

function midpoint(frame) {
  return (frame.start + frame.end) / 2;
}

function eventSort(left, right) {
  return activityStart(left) - activityStart(right)
    || activityEnd(left) - activityEnd(right)
    || left.speaker.localeCompare(right.speaker)
    || left.id.localeCompare(right.id);
}

function mergeLabelFrames(frames) {
  const merged = [];
  for (const frame of frames) {
    const previous = merged[merged.length - 1];
    if (previous && previous.text === frame.text && previous.floor === frame.floor && Math.abs(previous.end - frame.start) <= EPSILON) {
      previous.end = frame.end;
    } else {
      merged.push({ ...frame });
    }
  }
  return merged.map((interval) => ({
    start: round(interval.start),
    end: round(interval.end),
    text: interval.text,
    floor: interval.floor,
  }));
}

function fillFloorGaps(intervals, duration) {
  const sorted = intervals
    .filter((interval) => interval.end > interval.start + EPSILON)
    .sort((left, right) => left.start - right.start || left.end - right.end);
  const filled = [];
  let cursor = 0;
  for (const interval of sorted) {
    if (interval.start > cursor + EPSILON) {
      filled.push({ start: cursor, end: interval.start, text: 'FREE', free_kind: 'shs' });
    }
    if (interval.end <= cursor + EPSILON) continue;
    filled.push({ ...interval, start: Math.max(cursor, interval.start) });
    cursor = Math.max(cursor, interval.end);
  }
  if (cursor < duration - EPSILON) filled.push({ start: cursor, end: duration, text: 'FREE', free_kind: 'shs' });
  return filled;
}

function mergeFloorIntervals(intervals) {
  const merged = [];
  for (const interval of intervals) {
    const previous = merged[merged.length - 1];
    if (previous && previous.text === interval.text && previous.free_kind === interval.free_kind && Math.abs(previous.end - interval.start) <= EPSILON) {
      previous.end = interval.end;
    } else {
      merged.push({ ...interval });
    }
  }
  return merged.map((interval) => ({ ...interval, start: round(interval.start), end: round(interval.end) }));
}

function flagLongOwnPauses(speakerTiers, limit, flags) {
  for (const speaker of SPEAKERS) {
    for (const interval of speakerTiers[speaker]) {
      if (interval.text === 'op' && interval.end - interval.start > limit + EPSILON) {
        flags.push(makeFlag(interval.start, interval.end, 'own_pause_exceeds_L', 'review', 'floor', speaker));
      }
    }
  }
}

function formatSigned(value) {
  const numeric = Math.abs(value) < 0.0005 ? 0 : value;
  return `${numeric >= 0 ? '+' : '-'}${Math.abs(numeric).toFixed(3)}`;
}

function summarizeInteraction(duration, speakerTiers, floorTier, transitions) {
  return Object.fromEntries(SPEAKERS.map((speaker) => {
    const totals = Object.fromEntries(SPEAKER_LABELS.map((label) => [label, 0]));
    const counts = Object.fromEntries(SPEAKER_LABELS.map((label) => [label, 0]));
    for (const interval of speakerTiers[speaker]) {
      totals[interval.text] += interval.end - interval.start;
      counts[interval.text] += 1;
    }
    const phonation = Object.entries(totals)
      .filter(([label]) => phonationIncluded(label))
      .reduce((sum, [, seconds]) => sum + seconds, 0);
    return [speaker, {
      total_duration: round(duration),
      phonation_time: round(phonation),
      label_seconds: Object.fromEntries(Object.entries(totals).map(([label, seconds]) => [label, round(seconds)])),
      label_counts: counts,
      floor_turns_held: floorTier.filter((interval) => interval.text === speaker).length,
      incoming_fto_values: transitions
        .filter((transition) => transition.to === speaker && Number.isFinite(transition.fto))
        .map((transition) => formatSigned(transition.fto))
        .join(';'),
    }];
  }));
}
