import { EPSILON, round } from '../core/contracts.mjs';
import { buildV22Stage1Candidate } from './build-v22-stage1-candidate.mjs';
import {
  LOCAL_CROSSING_RULE_VERSION,
  refineProviderBoundariesAtCrossings,
} from '../acoustic/local-boundary-crossing.mjs';

export const V23_RULE_SET_VERSION = 'R1-R5-v2.1-locked';

const DEFAULTS = Object.freeze({
  boundaryRefinementEnabled: true,
  boundarySearchRadiusMs: 150,
  boundarySmoothingMs: 20,
  boundaryHysteresisDb: 1,
  boundaryStableRunMs: 30,
  residualIdentityPolicy: 'bounded_margin',
});

export function buildV23Stage1Candidate(stage1Input, roomSoundingIntervals, userOptions = {}) {
  const options = { ...DEFAULTS, ...userOptions };
  validateOptions(options);
  const v22 = buildV22Stage1Candidate(stage1Input, roomSoundingIntervals, options);
  const overlapEvidence = normalizeOverlapEvidence(stage1Input.providerOverlapEvidence || []);
  const residualPolicy = applyResidualIdentityPolicy(v22.input.stage1Evidence, stage1Input, options);
  const roleEvents = residualPolicy.events.map((event) => assignEvidenceRoles(event, overlapEvidence));
  const refinement = options.boundaryRefinementEnabled
    ? refineProviderBoundariesAtCrossings(roleEvents, {
      frames: options.acousticFrames,
      thresholdDb: options.acousticThresholdDb,
      hopMs: options.acousticHopMs || 10,
      radiusMs: options.boundarySearchRadiusMs,
      smoothingMs: options.boundarySmoothingMs,
      hysteresisDb: options.boundaryHysteresisDb,
      stableRunMs: options.boundaryStableRunMs,
    })
    : { events: roleEvents, flags: [], records: [], stats: emptyCrossingStats() };
  const residualFlags = refinement.events
    .filter((event) => event.semantic_evidence === 'unknown_acoustic')
    .map((event) => ({
      start: activityStart(event),
      end: activityEnd(event),
      code: 'semantic_unknown_acoustic_activity',
      severity: 'review',
      source: 'stage1_v23_evidence_roles',
      related_id: event.id,
    }));
  const retainedFlags = (v22.input.initialFlags || [])
    .filter((flag) => flag.source !== 'stage1_v22_residual_fusion');
  const initialFlags = dedupeFlags([
    ...retainedFlags,
    ...residualFlags,
    ...residualPolicy.flags,
    ...refinement.flags,
  ]);
  const stats = {
    ...v22.stats,
    explicit_semantic_event_count: refinement.events.filter((event) => event.semantic_evidence === 'explicit_asr').length,
    acoustic_unknown_event_count: refinement.events.filter((event) => event.semantic_evidence === 'unknown_acoustic').length,
    floor_candidate_event_count: refinement.events.filter((event) => event.floor_eligible === true).length,
    overlap_eligible_event_count: refinement.events.filter((event) => event.overlap_eligible === true).length,
    residual_identity_withheld_count: residualPolicy.withheldCount,
    boundary_refined_segment_count: refinement.stats.moved_segment_count,
    boundary_missing_crossing_count: refinement.stats.missing_crossing_count,
    boundary_provider_conflict_withheld_count: refinement.stats.provider_conflict_withheld_count,
  };

  return {
    input: {
      ...v22.input,
      methodologyVersion: 'multilogue-v2.3-final-gate-candidate-v1',
      stage1Evidence: refinement.events,
      initialFlags,
      interactionConfig: {
        ...(v22.input.interactionConfig || {}),
        strictEvidenceRoles: true,
        floorRulesVersion: V23_RULE_SET_VERSION,
      },
      adapterMetadata: {
        ...(v22.input.adapterMetadata || {}),
        v23Candidate: {
          runtime_gold_access: false,
          rule_set_version: V23_RULE_SET_VERSION,
          evidence_roles: {
            acoustic_activity: 'activity_eligible=true',
            explicit_semantic: 'semantic_evidence=explicit_asr',
            floor_turn_candidate: 'floor_eligible=true',
            overlap: 'providerOverlapEvidence intersection required',
          },
          boundary_refinement: crossingOptionSnapshot(options),
          residual_identity_policy: options.residualIdentityPolicy,
          stats,
        },
      },
    },
    provenance: {
      contract_version: 'multilogue-v2.3-final-stage1-provenance-v1',
      runtime_gold_access: false,
      rule_set_version: V23_RULE_SET_VERSION,
      parent_response_provenance: v22.provenance,
      boundary_refinement: {
        rule_version: LOCAL_CROSSING_RULE_VERSION,
        options: crossingOptionSnapshot(options),
        stats: refinement.stats,
        records: refinement.records,
      },
      residual_identity: residualPolicy.provenance,
    },
    stats,
  };
}

export function assignEvidenceRoles(event, providerOverlapEvidence = []) {
  const phrase = Array.isArray(event.source_word_ids) && event.source_word_ids.length > 0;
  const residual = Array.isArray(event.source_residual_ids) && event.source_residual_ids.length > 0;
  const supportedOverlap = overlapSupport(event, providerOverlapEvidence);
  if (residual) {
    return {
      ...event,
      activity_eligible: true,
      semantic_evidence: 'unknown_acoustic',
      semantic_class: 'unknown',
      lexical_class: 'unknown',
      floor_eligible: false,
      overlap_eligible: supportedOverlap.length > 0,
      provider_overlap_evidence_ids: supportedOverlap.map((item) => item.id),
      review_codes: [...new Set([...(event.review_codes || []), 'semantic_unknown_acoustic_activity'])],
    };
  }
  if (phrase) {
    return {
      ...event,
      activity_eligible: true,
      semantic_evidence: 'explicit_asr',
      semantic_class: event.lexical_class === 'filled_pause' ? 'filled_pause' : 'lexical',
      floor_eligible: event.provisional_kind === 'vocalisation',
      overlap_eligible: supportedOverlap.length > 0,
      provider_overlap_evidence_ids: supportedOverlap.map((item) => item.id),
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

function applyResidualIdentityPolicy(events, stage1Input, options) {
  const knownEvents = events.filter((event) => Array.isArray(event.source_word_ids) && event.source_word_ids.length > 0);
  const output = [];
  const flags = [];
  const provenance = [];
  let withheldCount = 0;
  for (const event of events) {
    if (!Array.isArray(event.source_residual_ids) || event.source_residual_ids.length === 0) {
      output.push(event);
      continue;
    }
    const conflicting = knownEvents.filter((known) => known.speaker !== event.speaker
      && activitySegments(known).some((left) => activitySegments(event).some((right) => intersects(left, right))));
    const sameSpeaker = knownEvents.filter((known) => known.speaker === event.speaker
      && activitySegments(known).some((left) => activitySegments(event).some((right) => intersects(left, right))));
    const agreement = conflicting.length === 0 && sameSpeaker.length > 0;
    const bounded = conflicting.length === 0;
    const retain = options.residualIdentityPolicy === 'agreement_only' ? agreement : bounded;
    provenance.push({
      event_id: event.id,
      policy: options.residualIdentityPolicy,
      retained: retain,
      same_speaker_support_count: sameSpeaker.length,
      conflicting_speaker_support_count: conflicting.length,
    });
    if (retain) output.push(event);
    else {
      withheldCount += 1;
      flags.push({
        start: activityStart(event),
        end: activityEnd(event),
        code: 'residual_speaker_identity_withheld',
        severity: 'review',
        source: 'stage1_v23_residual_identity',
        related_id: event.id,
      });
    }
  }
  return { events: output, flags, provenance, withheldCount };
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
  })).filter((item) => item.end > item.start + EPSILON
    && ['qualified', 'subthreshold'].includes(item.overlap_class));
}

function activitySegments(event) {
  return Array.isArray(event.activity_segments) && event.activity_segments.length
    ? event.activity_segments
    : [{ start: event.start, end: event.end }];
}

function activityStart(event) {
  return Math.min(...activitySegments(event).map((segment) => Number(segment.start)));
}

function activityEnd(event) {
  return Math.max(...activitySegments(event).map((segment) => Number(segment.end)));
}

function intersects(left, right) {
  return Number(left.start) < Number(right.end) - EPSILON
    && Number(left.end) > Number(right.start) + EPSILON;
}

function crossingOptionSnapshot(options) {
  return {
    enabled: options.boundaryRefinementEnabled === true,
    search_radius_ms: Number(options.boundarySearchRadiusMs),
    smoothing_ms: Number(options.boundarySmoothingMs),
    hysteresis_db: Number(options.boundaryHysteresisDb),
    stable_run_ms: Number(options.boundaryStableRunMs),
    threshold_db: Number(options.acousticThresholdDb),
    provider_conflict_policy: 'no_outward_extension',
  };
}

function emptyCrossingStats() {
  return { moved_segment_count: 0, missing_crossing_count: 0, provider_conflict_withheld_count: 0 };
}

function dedupeFlags(flags) {
  const unique = new Map();
  for (const flag of flags) {
    const normalized = {
      start: round(Number(flag.start), 6),
      end: round(Number(flag.end), 6),
      code: String(flag.code),
      severity: String(flag.severity || 'review'),
      source: String(flag.source || 'stage1_v23'),
      related_id: String(flag.related_id || ''),
    };
    if (!(normalized.end > normalized.start + EPSILON)) continue;
    const key = JSON.stringify(normalized);
    if (!unique.has(key)) unique.set(key, normalized);
  }
  return [...unique.values()].sort((left, right) => left.start - right.start || left.end - right.end
    || left.code.localeCompare(right.code) || left.related_id.localeCompare(right.related_id));
}

function validateOptions(options) {
  if (!['agreement_only', 'bounded_margin'].includes(options.residualIdentityPolicy)) {
    throw new Error('residualIdentityPolicy must be agreement_only or bounded_margin');
  }
  for (const key of ['boundarySearchRadiusMs', 'boundarySmoothingMs', 'boundaryHysteresisDb', 'boundaryStableRunMs']) {
    if (!Number.isFinite(Number(options[key])) || Number(options[key]) < 0) throw new Error(`${key} must be non-negative`);
  }
  if (options.boundaryRefinementEnabled) {
    if (!Array.isArray(options.acousticFrames) || options.acousticFrames.length === 0) {
      throw new Error('boundary refinement requires original WAV acoustic frames');
    }
    if (!Number.isFinite(Number(options.acousticThresholdDb))) {
      throw new Error('boundary refinement requires acousticThresholdDb');
    }
  }
}
