import { EPSILON, SPEAKERS, round } from '../core/contracts.mjs';

export const SPEAKER_LOCAL_INTERNAL_GAP_VERSION = 'speaker-local-internal-gap-v1';

export const DEFAULT_INTERNAL_GAP_OPTIONS = Object.freeze({
  enabled: true,
  minimumGapSeconds: 0.1,
  maximumGapSeconds: 0.35,
  minimumFlankingSoundingSeconds: 0.05,
});

export function splitSpeakerLocalInternalGaps(events, support, userOptions = {}) {
  const options = { ...DEFAULT_INTERNAL_GAP_OPTIONS, ...userOptions };
  validateInputs(events, support, options);
  if (options.enabled !== true) return unchangedResult(events, options);

  const records = [];
  const flags = [];
  let splitEventCount = 0;
  let insertedGapCount = 0;
  let insertedGapSeconds = 0;

  const refinedEvents = events.map((event) => {
    if (event.semantic_evidence !== 'explicit_asr' || event.provisional_kind !== 'vocalisation') {
      return structuredClone(event);
    }
    const originalSegments = activitySegments(event);
    const refinedSegments = [];
    let eventSplit = false;

    for (let segmentIndex = 0; segmentIndex < originalSegments.length; segmentIndex += 1) {
      const segment = originalSegments[segmentIndex];
      const containingTurns = (support.provider_turns_by_speaker[event.speaker] || []).filter((turn) =>
        segment.start >= turn.start - EPSILON && segment.end <= turn.end + EPSILON);
      if (containingTurns.length !== 1) {
        refinedSegments.push({ ...segment });
        records.push(retainedRecord(event, segment, segmentIndex, 'no_unique_containing_provider_turn'));
        continue;
      }
      const turn = containingTurns[0];
      const sounding = mergeIntervals((support.by_speaker[event.speaker] || [])
        .map((interval) => ({
          start: Math.max(segment.start, turn.start, Number(interval.start)),
          end: Math.min(segment.end, turn.end, Number(interval.end)),
        }))
        .filter((interval) => interval.end > interval.start + EPSILON));
      const acceptedGaps = [];
      for (let index = 1; index < sounding.length; index += 1) {
        const left = sounding[index - 1];
        const right = sounding[index];
        const gap = { start: left.end, end: right.start };
        const duration = gap.end - gap.start;
        const leftSounding = left.end - left.start;
        const rightSounding = right.end - right.start;
        if (duration + EPSILON < options.minimumGapSeconds
          || duration > options.maximumGapSeconds + EPSILON
          || leftSounding + EPSILON < options.minimumFlankingSoundingSeconds
          || rightSounding + EPSILON < options.minimumFlankingSoundingSeconds
          || gap.start <= segment.start + EPSILON
          || gap.end >= segment.end - EPSILON) continue;
        acceptedGaps.push(gap);
      }
      if (acceptedGaps.length === 0) {
        refinedSegments.push({ ...segment });
        records.push(retainedRecord(event, segment, segmentIndex, 'no_eligible_internal_acoustic_gap', turn));
        continue;
      }

      const split = subtractGaps(segment, acceptedGaps);
      if (Math.abs(split[0].start - segment.start) > EPSILON
        || Math.abs(split.at(-1).end - segment.end) > EPSILON) {
        throw new Error('internal-gap refinement moved an outer boundary');
      }
      refinedSegments.push(...split);
      eventSplit = true;
      insertedGapCount += acceptedGaps.length;
      insertedGapSeconds += acceptedGaps.reduce((sum, gap) => sum + gap.end - gap.start, 0);
      records.push({
        event_id: event.id,
        segment_index: segmentIndex,
        speaker: event.speaker,
        provider_turn_id: turn.id,
        before: roundInterval(segment),
        after: split.map(roundInterval),
        inserted_gaps: acceptedGaps.map(roundInterval),
        reason: 'stable_internal_speaker_local_gap_inserted',
        evidence_source: 'speaker_conditioned_muted_mirror_within_provider_turn',
      });
      for (const gap of acceptedGaps) {
        flags.push({
          start: round(gap.start, 6),
          end: round(gap.end, 6),
          code: 'speaker_local_internal_acoustic_gap',
          severity: 'review',
          source: 'speaker_local_internal_gap_refinement',
          related_id: event.id,
        });
      }
    }
    if (eventSplit) splitEventCount += 1;
    return {
      ...event,
      activity_segments: mergeIntervals(refinedSegments).map(roundInterval),
      speaker_local_internal_gap_refinement: SPEAKER_LOCAL_INTERNAL_GAP_VERSION,
    };
  });

  assertSemanticIdentity(events, refinedEvents);
  return {
    events: refinedEvents,
    flags,
    records,
    stats: {
      eligible_explicit_event_count: events.filter((event) =>
        event.semantic_evidence === 'explicit_asr' && event.provisional_kind === 'vocalisation').length,
      split_event_count: splitEventCount,
      inserted_gap_count: insertedGapCount,
      inserted_gap_seconds: round(insertedGapSeconds, 6),
    },
    options,
    contract_version: SPEAKER_LOCAL_INTERNAL_GAP_VERSION,
    runtime_gold_access: false,
    network_used: false,
    room_mix_boundary_crossing: false,
    outer_boundaries_moved: false,
  };
}

function unchangedResult(events, options) {
  return {
    events: structuredClone(events), flags: [], records: [],
    stats: { eligible_explicit_event_count: 0, split_event_count: 0, inserted_gap_count: 0, inserted_gap_seconds: 0 },
    options, contract_version: SPEAKER_LOCAL_INTERNAL_GAP_VERSION,
    runtime_gold_access: false, network_used: false, room_mix_boundary_crossing: false, outer_boundaries_moved: false,
  };
}

function retainedRecord(event, segment, segmentIndex, reason, turn = null) {
  return {
    event_id: event.id,
    segment_index: segmentIndex,
    speaker: event.speaker,
    provider_turn_id: turn?.id || null,
    before: roundInterval(segment),
    after: [roundInterval(segment)],
    inserted_gaps: [],
    reason,
    evidence_source: 'speaker_conditioned_muted_mirror_within_provider_turn',
  };
}

function subtractGaps(segment, gaps) {
  const output = [];
  let cursor = segment.start;
  for (const gap of gaps) {
    if (gap.start > cursor + EPSILON) output.push({ start: cursor, end: gap.start });
    cursor = Math.max(cursor, gap.end);
  }
  if (segment.end > cursor + EPSILON) output.push({ start: cursor, end: segment.end });
  return output;
}

function activitySegments(event) {
  return (Array.isArray(event.activity_segments) && event.activity_segments.length
    ? event.activity_segments
    : [{ start: event.start, end: event.end }])
    .map((segment) => ({ start: Number(segment.start), end: Number(segment.end) }));
}

function mergeIntervals(intervals) {
  const output = [];
  for (const interval of [...intervals].sort((left, right) => left.start - right.start || left.end - right.end)) {
    const previous = output.at(-1);
    if (previous && interval.start <= previous.end + EPSILON) previous.end = Math.max(previous.end, interval.end);
    else output.push({ ...interval });
  }
  return output;
}

function roundInterval(interval) {
  return { start: round(Number(interval.start), 6), end: round(Number(interval.end), 6) };
}

function assertSemanticIdentity(before, after) {
  if (before.length !== after.length) throw new Error('internal-gap refinement changed event count');
  for (let index = 0; index < before.length; index += 1) {
    for (const field of ['id', 'speaker', 'semantic_evidence', 'semantic_class', 'provisional_kind', 'floor_eligible']) {
      if (before[index][field] !== after[index][field]) throw new Error(`internal-gap refinement changed ${field}`);
    }
    if (JSON.stringify(before[index].tokens || []) !== JSON.stringify(after[index].tokens || [])) {
      throw new Error('internal-gap refinement changed tokens');
    }
  }
}

function validateInputs(events, support, options) {
  if (!Array.isArray(events)) throw new Error('events are required');
  if (!support?.by_speaker || !support?.provider_turns_by_speaker) throw new Error('speaker acoustic support is required');
  for (const speaker of SPEAKERS) {
    if (!Array.isArray(support.by_speaker[speaker])) throw new Error(`${speaker} sounding support missing`);
    if (!Array.isArray(support.provider_turns_by_speaker[speaker])) throw new Error(`${speaker} provider turns missing`);
  }
  for (const key of ['minimumGapSeconds', 'maximumGapSeconds', 'minimumFlankingSoundingSeconds']) {
    if (!Number.isFinite(Number(options[key])) || Number(options[key]) < 0) throw new Error(`${key} must be non-negative`);
  }
  if (options.maximumGapSeconds + EPSILON < options.minimumGapSeconds) {
    throw new Error('maximumGapSeconds must be at least minimumGapSeconds');
  }
}
