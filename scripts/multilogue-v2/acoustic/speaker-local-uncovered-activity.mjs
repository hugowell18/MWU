import { createHash } from 'node:crypto';

import { EPSILON, SPEAKERS, round } from '../core/contracts.mjs';

export const SPEAKER_LOCAL_UNCOVERED_ACTIVITY_VERSION = 'speaker-local-uncovered-activity-v1';

export const DEFAULT_UNCOVERED_ACTIVITY_OPTIONS = Object.freeze({
  enabled: true,
  minimumDurationSeconds: 0.12,
  maximumDurationSeconds: 3,
  edgeExclusionSeconds: 0.02,
  acousticBackchannelMinimumSeconds: 0.12,
});

export function promoteUncoveredSpeakerActivity(events, support, providerOverlapEvidence = [], userOptions = {}) {
  const options = { ...DEFAULT_UNCOVERED_ACTIVITY_OPTIONS, ...userOptions };
  validateInputs(events, support, options);
  if (options.enabled !== true) return unchangedResult(events, options);

  const additions = [];
  const flags = [];
  const records = [];
  for (const speaker of SPEAKERS) {
    const coverage = mergeIntervals(events.filter((event) => event.speaker === speaker && event.activity_eligible !== false)
      .flatMap(activitySegments));
    for (const sounding of support.by_speaker[speaker] || []) {
      const containingTurns = (support.provider_turns_by_speaker[speaker] || []).filter((turn) =>
        sounding.start >= turn.start - EPSILON && sounding.end <= turn.end + EPSILON);
      if (containingTurns.length !== 1) continue;
      const turn = containingTurns[0];
      const residuals = subtractIntervals(sounding, coverage)
        .map((interval) => ({
          start: Math.max(interval.start, sounding.start + options.edgeExclusionSeconds),
          end: Math.min(interval.end, sounding.end - options.edgeExclusionSeconds),
        }))
        .filter((interval) => interval.end - interval.start >= options.minimumDurationSeconds - EPSILON
          && interval.end - interval.start <= options.maximumDurationSeconds + EPSILON);
      for (const interval of residuals) {
        const overlapIds = providerOverlapEvidence.filter((item) =>
          Array.isArray(item.speakers) && item.speakers.includes(speaker)
          && Number(item.start) < interval.end - EPSILON && Number(item.end) > interval.start + EPSILON)
          .map((item) => String(item.id));
        const id = `event_local_uncovered_${hashText(`${speaker}:${interval.start.toFixed(6)}:${interval.end.toFixed(6)}`).slice(0, 16)}`;
        const duration = interval.end - interval.start;
        const event = {
          id,
          speaker,
          start: round(interval.start, 6),
          end: round(interval.end, 6),
          activity_segments: [roundInterval(interval)],
          tokens: [],
          interaction_tokens: [],
          source_word_ids: [],
          source_residual_ids: [id],
          lexical_class: 'unknown',
          semantic_class: 'unknown',
          semantic_evidence: 'unknown_acoustic',
          provisional_kind: 'vocalisation',
          evidence_state: 'known',
          activity_eligible: true,
          floor_eligible: false,
          holder_retention_eligible: true,
          overlap_eligible: overlapIds.length > 0,
          provider_overlap_evidence_ids: overlapIds,
          runtime_acoustic_bc_candidate: duration >= options.acousticBackchannelMinimumSeconds - EPSILON,
          review_codes: ['speaker_local_uncovered_acoustic_activity'],
          provider_turn_id: turn.id,
          evidence_source: 'speaker_conditioned_muted_mirror_uncovered_vad',
        };
        additions.push(event);
        flags.push({
          start: event.start,
          end: event.end,
          code: 'speaker_local_uncovered_acoustic_activity',
          severity: 'review',
          source: 'speaker_local_uncovered_activity',
          related_id: id,
        });
        records.push({
          event_id: id,
          speaker,
          provider_turn_id: turn.id,
          interval: roundInterval(interval),
          duration_seconds: round(duration, 6),
          provider_overlap_evidence_ids: overlapIds,
          decision: 'activity_only_floor_ineligible_review_required',
        });
      }
    }
  }
  const combined = [...events.map((event) => structuredClone(event)), ...additions]
    .sort((left, right) => activityStart(left) - activityStart(right)
      || activityEnd(left) - activityEnd(right) || String(left.id).localeCompare(String(right.id)));
  assertAdditions(combined, additions, support);
  return {
    events: combined,
    additions,
    flags,
    records,
    stats: {
      added_event_count: additions.length,
      added_seconds: round(additions.reduce((sum, event) => sum + event.end - event.start, 0), 6),
      by_speaker: Object.fromEntries(SPEAKERS.map((speaker) => [speaker, {
        count: additions.filter((event) => event.speaker === speaker).length,
        seconds: round(additions.filter((event) => event.speaker === speaker)
          .reduce((sum, event) => sum + event.end - event.start, 0), 6),
      }])),
    },
    options,
    contract_version: SPEAKER_LOCAL_UNCOVERED_ACTIVITY_VERSION,
    runtime_gold_access: false,
    network_used: false,
    room_mix_boundary_crossing: false,
    floor_eligible_addition_count: 0,
  };
}

function unchangedResult(events, options) {
  return {
    events: events.map((event) => structuredClone(event)), additions: [], flags: [], records: [],
    stats: { added_event_count: 0, added_seconds: 0, by_speaker: Object.fromEntries(SPEAKERS.map((speaker) => [speaker, { count: 0, seconds: 0 }])) },
    options, contract_version: SPEAKER_LOCAL_UNCOVERED_ACTIVITY_VERSION,
    runtime_gold_access: false, network_used: false, room_mix_boundary_crossing: false, floor_eligible_addition_count: 0,
  };
}

function subtractIntervals(interval, coverage) {
  let parts = [{ start: Number(interval.start), end: Number(interval.end) }];
  for (const covered of coverage) {
    if (covered.end <= interval.start + EPSILON) continue;
    if (covered.start >= interval.end - EPSILON) break;
    parts = parts.flatMap((part) => {
      if (covered.end <= part.start + EPSILON || covered.start >= part.end - EPSILON) return [part];
      return [
        { start: part.start, end: Math.min(part.end, covered.start) },
        { start: Math.max(part.start, covered.end), end: part.end },
      ].filter((item) => item.end > item.start + EPSILON);
    });
  }
  return parts;
}

function mergeIntervals(intervals) {
  const output = [];
  for (const interval of intervals.map((item) => ({ start: Number(item.start), end: Number(item.end) }))
    .filter((item) => item.end > item.start + EPSILON)
    .sort((left, right) => left.start - right.start || left.end - right.end)) {
    const previous = output.at(-1);
    if (previous && interval.start <= previous.end + EPSILON) previous.end = Math.max(previous.end, interval.end);
    else output.push({ ...interval });
  }
  return output;
}

function activitySegments(event) {
  return (Array.isArray(event.activity_segments) && event.activity_segments.length
    ? event.activity_segments : [{ start: event.start, end: event.end }])
    .map((item) => ({ start: Number(item.start), end: Number(item.end) }));
}
function activityStart(event) { return Math.min(...activitySegments(event).map((item) => item.start)); }
function activityEnd(event) { return Math.max(...activitySegments(event).map((item) => item.end)); }
function roundInterval(interval) { return { start: round(Number(interval.start), 6), end: round(Number(interval.end), 6) }; }
function hashText(value) { return createHash('sha256').update(value).digest('hex'); }

function assertAdditions(events, additions, support) {
  const ids = new Set();
  for (const event of events) {
    if (ids.has(event.id)) throw new Error(`duplicate event id: ${event.id}`);
    ids.add(event.id);
  }
  for (const event of additions) {
    if (event.floor_eligible !== false) throw new Error('uncovered acoustic activity cannot be floor eligible');
    const contained = (support.provider_turns_by_speaker[event.speaker] || []).some((turn) =>
      event.start >= turn.start - EPSILON && event.end <= turn.end + EPSILON);
    if (!contained) throw new Error('uncovered acoustic activity crosses provider turn');
  }
}

function validateInputs(events, support, options) {
  if (!Array.isArray(events)) throw new Error('events are required');
  if (!support?.by_speaker || !support?.provider_turns_by_speaker) throw new Error('speaker acoustic support is required');
  for (const speaker of SPEAKERS) {
    if (!Array.isArray(support.by_speaker[speaker])) throw new Error(`${speaker} sounding support missing`);
    if (!Array.isArray(support.provider_turns_by_speaker[speaker])) throw new Error(`${speaker} provider turns missing`);
  }
  for (const key of ['minimumDurationSeconds', 'maximumDurationSeconds', 'edgeExclusionSeconds', 'acousticBackchannelMinimumSeconds']) {
    if (!Number.isFinite(Number(options[key])) || Number(options[key]) < 0) throw new Error(`${key} must be non-negative`);
  }
  if (options.maximumDurationSeconds + EPSILON < options.minimumDurationSeconds) {
    throw new Error('maximumDurationSeconds must be at least minimumDurationSeconds');
  }
}
