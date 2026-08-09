import { EPSILON, SPEAKERS, round } from '../core/contracts.mjs';
import { buildV22Stage1Candidate, promoteResidualEvidence } from './build-v22-stage1-candidate.mjs';

export const V23C_RULE_SET_VERSION = 'R1-R5-v2.1-locked';

const DEFAULTS = Object.freeze({
  acousticThresholdMarginDb: 10,
  acousticSupportRatio: 0.5,
  residualIdentityPolicy: 'agreement_only',
  identityMargin: 0.1,
  acousticBridgeSeconds: 0,
  overlapCorroboratedResidualIdentity: false,
  overlapCorroboratedResidualMaxSeconds: 0.6,
  overlapCorroboratedMinimumCoverageRatio: 0.8,
});

export function buildV23cStage1Candidate(stage1Input, speakerAcousticSupport, userOptions = {}) {
  const options = { ...DEFAULTS, ...userOptions };
  validateOptions(options, speakerAcousticSupport);
  const speakerSounding = bridgeSupportWithinTurns(
    speakerAcousticSupport.by_speaker,
    speakerAcousticSupport.provider_turns_by_speaker,
    options.acousticBridgeSeconds,
  );
  const roomSounding = stage1Input.roomSoundingIntervals || [];
  const built = buildV22Stage1Candidate(stage1Input, roomSounding, {
    ...options,
    hardQuestionResponseBoundary: true,
    speakerSoundingIntervals: null,
    residualAcousticSupportRatio: 0,
  });
  const phraseCoverage = built.input.stage1Evidence
    .filter((event) => Array.isArray(event.source_word_ids) && event.source_word_ids.length > 0)
    .flatMap((event) => activitySegments(event).map((segment) => ({
      speaker: event.speaker,
      start: segment.start,
      end: segment.end,
    })));
  const speakerResiduals = promoteResidualEvidence(
    stage1Input.stage1UnknownEvidence || [],
    [],
    phraseCoverage,
    {
      ...options,
      speakerSoundingIntervals: speakerSounding,
      speakerAcousticBridgeSeconds: 0,
      residualAcousticSupportRatio: options.acousticSupportRatio,
    },
  );
  const combinedEvidence = dedupeEvidenceEvents([
    ...built.input.stage1Evidence,
    ...speakerResiduals.events,
  ]);
  const overlapEvidence = normalizeOverlapEvidence(stage1Input.providerOverlapEvidence || []);
  const identity = applySpeakerConditionedIdentity(
    combinedEvidence,
    speakerSounding,
    options,
    overlapEvidence,
  );
  const events = identity.events.map((event) => assignV23cEvidenceRoles(event, overlapEvidence));
  const retainedFlags = (built.input.initialFlags || [])
    .filter((flag) => flag.source !== 'stage1_v22_residual_fusion');
  const residualFlags = events.filter((event) => event.semantic_evidence === 'unknown_acoustic').map((event) => ({
    start: activityStart(event),
    end: activityEnd(event),
    code: 'speaker_conditioned_unknown_acoustic_activity',
    severity: 'review',
    source: 'stage1_v23c_speaker_acoustic',
    related_id: event.id,
  }));
  const initialFlags = dedupeFlags([...retainedFlags, ...identity.flags, ...residualFlags]);
  const stats = {
    ...built.stats,
    explicit_semantic_event_count: events.filter((event) => event.semantic_evidence === 'explicit_asr').length,
    acoustic_unknown_event_count: events.filter((event) => event.semantic_evidence === 'unknown_acoustic').length,
    acoustic_bc_capable_event_count: events.filter((event) => event.runtime_acoustic_bc_candidate === true).length,
    floor_candidate_event_count: events.filter((event) => event.floor_eligible === true).length,
    overlap_eligible_event_count: events.filter((event) => event.overlap_eligible === true).length,
    residual_identity_withheld_count: identity.withheldCount,
    room_boundary_crossing_count: 0,
    speaker_conditioned_promoted_residual_count: speakerResiduals.events.length,
    speaker_conditioned_promoted_residual_seconds: round(speakerResiduals.totalSeconds, 6),
  };
  return {
    input: {
      ...built.input,
      methodologyVersion: 'multilogue-v2.3c-candidate-v1',
      stage1Evidence: events,
      initialFlags,
      interactionConfig: {
        ...(built.input.interactionConfig || {}),
        strictEvidenceRoles: true,
        floorRulesVersion: V23C_RULE_SET_VERSION,
        preFloorBackchannelClassification: true,
      },
      adapterMetadata: {
        ...(built.input.adapterMetadata || {}),
        v23cCandidate: {
          runtime_gold_access: false,
          network_used: false,
          rule_set_version: V23C_RULE_SET_VERSION,
          room_boundary_crossing: false,
          speaker_conditioned_acoustic_support: true,
          source_separation_claim: false,
          options: optionSnapshot(options),
          stats,
        },
      },
    },
    provenance: {
      contract_version: 'multilogue-v2.3c-stage1-provenance-v1',
      runtime_gold_access: false,
      network_used: false,
      rule_set_version: V23C_RULE_SET_VERSION,
      speaker_acoustic_support_version: speakerAcousticSupport.contract_version,
      source_separation_claim: false,
      room_boundary_crossing: false,
      options: optionSnapshot(options),
      residual_identity: identity.provenance,
      parent: built.provenance,
    },
    stats,
  };
}

function dedupeEvidenceEvents(events) {
  const output = [];
  for (const event of [...events].sort((left, right) => Number(left.start) - Number(right.start)
    || Number(left.end) - Number(right.end) || String(left.id).localeCompare(String(right.id)))) {
    const duplicate = output.some((existing) => existing.speaker === event.speaker
      && sameSourceResidual(existing, event)
      && activitySegments(existing).every((left) => activitySegments(event).some((right) =>
        Math.abs(left.start - right.start) <= EPSILON && Math.abs(left.end - right.end) <= EPSILON)));
    if (!duplicate) output.push(event);
  }
  return output;
}

function sameSourceResidual(left, right) {
  const a = left.source_residual_ids || [];
  const b = right.source_residual_ids || [];
  return a.length > 0 && b.length > 0 && a.some((id) => b.includes(id));
}

export function assignV23cEvidenceRoles(event, overlapEvidence = []) {
  const residual = Array.isArray(event.source_residual_ids) && event.source_residual_ids.length > 0;
  const explicit = Array.isArray(event.source_word_ids) && event.source_word_ids.length > 0;
  const overlap = overlapSupport(event, overlapEvidence);
  if (residual) {
    const duration = activityEnd(event) - activityStart(event);
    return {
      ...event,
      activity_eligible: true,
      semantic_evidence: 'unknown_acoustic',
      semantic_class: 'unknown',
      lexical_class: 'unknown',
      floor_eligible: false,
      holder_retention_eligible: true,
      overlap_eligible: overlap.length > 0,
      provider_overlap_evidence_ids: overlap.map((item) => item.id),
      runtime_acoustic_bc_candidate: duration >= 0.12 - EPSILON,
      review_codes: [...new Set([...(event.review_codes || []), 'speaker_conditioned_unknown_acoustic_activity'])],
    };
  }
  if (explicit) {
    return {
      ...event,
      activity_eligible: true,
      semantic_evidence: 'explicit_asr',
      semantic_class: event.lexical_class === 'filled_pause' ? 'filled_pause' : 'lexical',
      floor_eligible: event.provisional_kind === 'vocalisation',
      overlap_eligible: overlap.length > 0,
      provider_overlap_evidence_ids: overlap.map((item) => item.id),
    };
  }
  return {
    ...event,
    activity_eligible: event.provisional_kind !== 'artifact',
    semantic_evidence: 'unknown_other',
    semantic_class: 'unknown',
    floor_eligible: false,
    overlap_eligible: false,
  };
}

export function applySpeakerConditionedIdentity(events, supportBySpeaker, options, overlapEvidence = []) {
  const output = [];
  const flags = [];
  const provenance = [];
  let withheldCount = 0;
  for (const event of events) {
    if (!Array.isArray(event.source_residual_ids) || event.source_residual_ids.length === 0) {
      output.push(event);
      continue;
    }
    const segments = activitySegments(event);
    const duration = segments.reduce((sum, segment) => sum + segment.end - segment.start, 0);
    const ratios = Object.fromEntries(SPEAKERS.map((speaker) => [
      speaker,
      duration > EPSILON ? overlapSeconds(segments, supportBySpeaker[speaker]) / duration : 0,
    ]));
    const own = ratios[event.speaker] || 0;
    const otherRatios = SPEAKERS.filter((speaker) => speaker !== event.speaker)
      .map((speaker) => ({ speaker, ratio: ratios[speaker] || 0 }));
    const other = Math.max(...otherRatios.map((item) => item.ratio));
    const competingSpeakers = otherRatios.filter((item) => Math.abs(item.ratio - other) <= EPSILON)
      .map((item) => item.speaker);
    const identityTie = own + EPSILON >= options.acousticSupportRatio
      && Math.abs(own - other) < options.identityMargin - EPSILON;
    const retainedByAcousticIdentity = options.residualIdentityPolicy === 'agreement_only'
      ? own + EPSILON >= options.acousticSupportRatio && other <= EPSILON
      : (own + EPSILON >= options.acousticSupportRatio && own - other + EPSILON >= options.identityMargin)
        || other <= EPSILON;
    const corroboratingOverlap = overlapSupport(event, overlapEvidence)
      .filter((item) => item.overlap_class === 'qualified'
        && competingSpeakers.some((speaker) => item.speakers.includes(speaker)));
    const overlapCoverageRatio = duration > EPSILON
      ? overlapUnionSeconds(segments, corroboratingOverlap) / duration : 0;
    const retainedByOverlap = options.overlapCorroboratedResidualIdentity === true
      && retainedByAcousticIdentity === false
      && identityTie
      && duration <= options.overlapCorroboratedResidualMaxSeconds + EPSILON
      && overlapCoverageRatio + EPSILON >= options.overlapCorroboratedMinimumCoverageRatio;
    const retained = retainedByAcousticIdentity || retainedByOverlap;
    provenance.push({
      event_id: event.id,
      speaker: event.speaker,
      policy: options.residualIdentityPolicy,
      retained,
      retention_reason: retainedByOverlap
        ? 'qualified_provider_overlap_corroborates_identity_tied_residual'
        : retainedByAcousticIdentity ? 'speaker_conditioned_acoustic_identity' : 'identity_withheld',
      provider_overlap_evidence_ids: corroboratingOverlap.map((item) => item.id),
      provider_overlap_evidence: corroboratingOverlap.map((item) => ({ ...item })),
      provider_overlap_coverage_ratio: round(overlapCoverageRatio, 6),
      identity_tie: identityTie,
      competing_speakers: competingSpeakers,
      identity_tie_delta: round(Math.abs(own - other), 6),
      acoustic_support_ratio_by_speaker: Object.fromEntries(Object.entries(ratios).map(([key, value]) => [key, round(value, 6)])),
      required_support_ratio: Number(options.acousticSupportRatio),
      required_identity_margin: Number(options.identityMargin),
    });
    if (retainedByOverlap) {
      output.push({
        ...event,
        overlap_corroborated_identity: true,
        provider_overlap_evidence_ids: corroboratingOverlap.map((item) => item.id),
        review_codes: [...new Set([
          ...(event.review_codes || []),
          'qualified_overlap_identity_tie_retained_for_review',
        ])],
      });
      flags.push({
        start: activityStart(event),
        end: activityEnd(event),
        code: 'qualified_overlap_identity_tie_retained_for_review',
        severity: 'review',
        source: 'stage1_v23c_identity',
        related_id: event.id,
      });
    } else if (retained) output.push(event);
    else {
      withheldCount += 1;
      flags.push({
        start: activityStart(event),
        end: activityEnd(event),
        code: 'speaker_conditioned_identity_withheld',
        severity: 'review',
        source: 'stage1_v23c_identity',
        related_id: event.id,
      });
    }
  }
  return { events: output, flags, provenance, withheldCount };
}

function overlapSeconds(left, right) {
  let total = 0;
  for (const a of left) for (const b of right || []) {
    total += Math.max(0, Math.min(a.end, b.end) - Math.max(a.start, b.start));
  }
  return total;
}

function overlapUnionSeconds(left, right) {
  const fragments = [];
  for (const a of left) for (const b of right || []) {
    const start = Math.max(a.start, b.start);
    const end = Math.min(a.end, b.end);
    if (end > start + EPSILON) fragments.push({ start, end });
  }
  fragments.sort((a, b) => a.start - b.start || a.end - b.end);
  const merged = [];
  for (const fragment of fragments) {
    const previous = merged[merged.length - 1];
    if (previous && fragment.start <= previous.end + EPSILON) previous.end = Math.max(previous.end, fragment.end);
    else merged.push({ ...fragment });
  }
  return merged.reduce((sum, fragment) => sum + fragment.end - fragment.start, 0);
}

function bridgeSupportWithinTurns(bySpeaker, turnsBySpeaker, maximumGap) {
  const output = {};
  for (const speaker of SPEAKERS) {
    const bridged = [];
    for (const turn of turnsBySpeaker[speaker] || []) {
      const inside = (bySpeaker[speaker] || []).map((item) => ({
        start: Math.max(item.start, turn.start),
        end: Math.min(item.end, turn.end),
      })).filter((item) => item.end > item.start + EPSILON)
        .sort((left, right) => left.start - right.start || left.end - right.end);
      const withinTurn = [];
      for (const interval of inside) {
        const previous = withinTurn[withinTurn.length - 1];
        if (previous && interval.start <= previous.end + Number(maximumGap) + EPSILON) {
          previous.end = Math.min(turn.end, Math.max(previous.end, interval.end));
        } else withinTurn.push({ ...interval });
      }
      bridged.push(...withinTurn);
    }
    output[speaker] = bridged;
  }
  return output;
}

function overlapSupport(event, evidence) {
  return evidence.filter((item) => item.speakers.includes(event.speaker)
    && activitySegments(event).some((segment) => intersects(segment, item)));
}

function normalizeOverlapEvidence(items) {
  return items.map((item) => ({
    id: String(item.id),
    start: Number(item.start),
    end: Number(item.end),
    overlap_class: String(item.overlap_class),
    speakers: Array.isArray(item.speakers) ? item.speakers.map(String) : [],
    provider: String(item.provider || 'unknown'),
    source_turn_ids: Array.isArray(item.source_turn_ids) ? item.source_turn_ids.map(String) : [],
    evidence_source: String(item.evidence_source || 'provider_overlap'),
    evidence_status: String(item.evidence_status || 'candidate_requires_review'),
  })).filter((item) => item.end > item.start + EPSILON
    && ['qualified', 'subthreshold'].includes(item.overlap_class));
}

function dedupeFlags(flags) {
  const output = new Map();
  for (const flag of flags) {
    const normalized = {
      start: round(Number(flag.start), 6),
      end: round(Number(flag.end), 6),
      code: String(flag.code),
      severity: String(flag.severity || 'review'),
      source: String(flag.source || 'stage1_v23c'),
      related_id: String(flag.related_id || ''),
    };
    if (!(normalized.end > normalized.start + EPSILON)) continue;
    const key = JSON.stringify(normalized);
    if (!output.has(key)) output.set(key, normalized);
  }
  return [...output.values()].sort((left, right) => left.start - right.start || left.end - right.end
    || left.code.localeCompare(right.code));
}

function optionSnapshot(options) {
  return {
    acoustic_threshold_margin_db: Number(options.acousticThresholdMarginDb),
    acoustic_support_ratio: Number(options.acousticSupportRatio),
    residual_identity_policy: options.residualIdentityPolicy,
    identity_margin: Number(options.identityMargin),
    acoustic_bridge_seconds: Number(options.acousticBridgeSeconds),
    overlap_corroborated_residual_identity: options.overlapCorroboratedResidualIdentity === true,
    overlap_corroborated_residual_max_seconds: Number(options.overlapCorroboratedResidualMaxSeconds),
    overlap_corroborated_minimum_coverage_ratio: Number(options.overlapCorroboratedMinimumCoverageRatio),
    hard_question_response_boundary: true,
  };
}

function validateOptions(options, support) {
  if (!['agreement_only', 'bounded_margin'].includes(options.residualIdentityPolicy)) {
    throw new Error('residualIdentityPolicy must be agreement_only or bounded_margin');
  }
  for (const key of [
    'acousticThresholdMarginDb',
    'acousticSupportRatio',
    'identityMargin',
    'acousticBridgeSeconds',
    'overlapCorroboratedResidualMaxSeconds',
    'overlapCorroboratedMinimumCoverageRatio',
  ]) {
    if (!Number.isFinite(Number(options[key])) || Number(options[key]) < 0) throw new Error(`${key} must be non-negative`);
  }
  if (typeof options.overlapCorroboratedResidualIdentity !== 'boolean') {
    throw new Error('overlapCorroboratedResidualIdentity must be boolean');
  }
  if (Number(options.overlapCorroboratedMinimumCoverageRatio) > 1) {
    throw new Error('overlapCorroboratedMinimumCoverageRatio must not exceed 1');
  }
  if (!support || support.contract_version == null) throw new Error('speaker acoustic support is required');
  for (const speaker of SPEAKERS) if (!Array.isArray(support.by_speaker?.[speaker])) throw new Error(`${speaker} acoustic support is missing`);
}

function activitySegments(event) {
  return Array.isArray(event.activity_segments) && event.activity_segments.length
    ? event.activity_segments
    : [{ start: Number(event.start), end: Number(event.end) }];
}

function activityStart(event) {
  return Math.min(...activitySegments(event).map((item) => Number(item.start)));
}

function activityEnd(event) {
  return Math.max(...activitySegments(event).map((item) => Number(item.end)));
}

function intersects(left, right) {
  return Number(left.start) < Number(right.end) - EPSILON && Number(left.end) > Number(right.start) + EPSILON;
}
