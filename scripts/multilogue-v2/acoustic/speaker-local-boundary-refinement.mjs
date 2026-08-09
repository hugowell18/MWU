import { EPSILON, SPEAKERS, round } from '../core/contracts.mjs';
import { findUniqueStableBoundaryCrossing, prepareSmoothedCrossingEvidence } from './local-boundary-crossing.mjs';

export const SPEAKER_LOCAL_BOUNDARY_REFINEMENT_VERSION = 'speaker-local-provider-clipped-boundary-v1';

export const DEFAULT_SPEAKER_LOCAL_BOUNDARY_OPTIONS = Object.freeze({
  enabled: true,
  onsetRadiusMs: 250,
  offsetRadiusMs: 250,
  smoothingMs: 20,
  hysteresisDb: 3,
  onsetStableRunMs: 20,
  offsetStableRunMs: 20,
  minimumContrastDb: 3,
  minimumDisplacementMs: 0,
  maximumDisplacementMs: 250,
  movePolicy: 'all',
  onsetEnabled: true,
  offsetEnabled: true,
  onsetMinimumContrastDb: null,
  offsetMinimumContrastDb: null,
  onsetMinimumDisplacementMs: null,
  offsetMinimumDisplacementMs: null,
  onsetMaximumDisplacementMs: null,
  offsetMaximumDisplacementMs: null,
  onsetMovePolicy: null,
  offsetMovePolicy: null,
  hopMs: 10,
});

export function refineSpeakerLocalPhraseBoundaries(events, support, userOptions = {}) {
  const options = { ...DEFAULT_SPEAKER_LOCAL_BOUNDARY_OPTIONS, ...userOptions };
  validateInputs(events, support, options);
  if (options.enabled !== true) return unchangedResult(events, options);

  const records = [];
  const flags = [];
  const framesBySpeaker = support.boundary_frames_by_speaker;
  const turnsBySpeaker = support.provider_turns_by_speaker;
  const thresholdBySpeaker = Object.fromEntries(
    support.speaker_records.map((item) => [item.canonical_speaker, Number(item.threshold_dbfs)]),
  );
  const preparedByTurn = new Map();
  let movedOnsets = 0;
  let movedOffsets = 0;

  const refinedEvents = events.map((event) => {
    if (event.semantic_evidence !== 'explicit_asr' || event.provisional_kind !== 'vocalisation') {
      return structuredClone(event);
    }
    const originalSpeaker = event.speaker;
    const segments = activitySegments(event);
    const refinedSegments = segments.map((segment, segmentIndex) => {
      const containingTurns = (turnsBySpeaker[event.speaker] || []).filter((turn) =>
        segment.start >= turn.start - EPSILON && segment.end <= turn.end + EPSILON);
      if (containingTurns.length !== 1) {
        records.push(retainedRecord(event, segment, segmentIndex, 'no_unique_containing_provider_turn'));
        flags.push(reviewFlag(segment, event.id, 'speaker_local_boundary_provider_turn_unresolved'));
        return { ...segment };
      }
      const turn = containingTurns[0];
      const cacheKey = `${event.speaker}:${turn.id}:${options.smoothingMs}`;
      if (!preparedByTurn.has(cacheKey)) {
        const clippedFrames = (framesBySpeaker[event.speaker] || []).filter((frame) =>
          frame.end > turn.start + EPSILON && frame.start < turn.end - EPSILON);
        preparedByTurn.set(cacheKey, {
          raw: clippedFrames,
          prepared: prepareSmoothedCrossingEvidence(clippedFrames, options.smoothingMs, options.hopMs),
        });
      }
      const frameEvidence = preparedByTurn.get(cacheKey);
      if (!frameEvidence.raw.length || !Number.isFinite(thresholdBySpeaker[event.speaker])) {
        records.push(retainedRecord(event, segment, segmentIndex, 'speaker_local_frames_or_threshold_missing', turn));
        flags.push(reviewFlag(segment, event.id, 'speaker_local_boundary_evidence_missing'));
        return { ...segment };
      }
      const common = {
        frames: frameEvidence.raw,
        prepared: frameEvidence.prepared,
        thresholdDb: thresholdBySpeaker[event.speaker],
        smoothingMs: options.smoothingMs,
        hysteresisDb: options.hysteresisDb,
        minimumContrastDb: options.minimumContrastDb,
        hopMs: options.hopMs,
      };
      const onset = findUniqueStableBoundaryCrossing({
        ...common,
        minimumContrastDb: options.onsetMinimumContrastDb ?? options.minimumContrastDb,
        boundary: segment.start,
        direction: 'onset',
        radiusMs: options.onsetRadiusMs,
        stableRunMs: options.onsetStableRunMs,
      });
      const offset = findUniqueStableBoundaryCrossing({
        ...common,
        minimumContrastDb: options.offsetMinimumContrastDb ?? options.minimumContrastDb,
        boundary: segment.end,
        direction: 'offset',
        radiusMs: options.offsetRadiusMs,
        stableRunMs: options.offsetStableRunMs,
      });
      const onsetMoveAllowed = onset.found && moveAllowed('onset', segment.start, onset.time, options);
      const offsetMoveAllowed = offset.found && moveAllowed('offset', segment.end, offset.time, options);
      let start = onsetMoveAllowed ? onset.time : segment.start;
      let end = offsetMoveAllowed ? offset.time : segment.end;
      const retainedReasons = [];
      if (onset.found && !onsetMoveAllowed) retainedReasons.push('onset_rejected_by_displacement_policy');
      if (offset.found && !offsetMoveAllowed) retainedReasons.push('offset_rejected_by_displacement_policy');
      if (start < turn.start - EPSILON || start > turn.end + EPSILON) {
        start = segment.start;
        retainedReasons.push('onset_would_cross_provider_turn');
      }
      if (end < turn.start - EPSILON || end > turn.end + EPSILON) {
        end = segment.end;
        retainedReasons.push('offset_would_cross_provider_turn');
      }
      if (!(end > start + EPSILON)) {
        start = segment.start;
        end = segment.end;
        retainedReasons.push('refined_boundary_order_invalid');
      }
      const onsetMoved = Math.abs(start - segment.start) > EPSILON;
      const offsetMoved = Math.abs(end - segment.end) > EPSILON;
      if (onsetMoved) movedOnsets += 1;
      if (offsetMoved) movedOffsets += 1;
      records.push({
        event_id: event.id,
        segment_index: segmentIndex,
        speaker: event.speaker,
        provider_turn_id: turn.id,
        before: roundInterval(segment),
        after: roundInterval({ start, end }),
        onset: { ...onset, applied: onsetMoved, from: round(segment.start, 6), to: round(start, 6) },
        offset: { ...offset, applied: offsetMoved, from: round(segment.end, 6), to: round(end, 6) },
        retained_reasons: retainedReasons,
        reason: onsetMoved || offsetMoved ? 'unique_strong_speaker_local_crossing_applied' : 'original_boundaries_retained',
        evidence_source: 'speaker_conditioned_muted_mirror_within_provider_turn',
      });
      if ((!onset.found && onset.reason === 'multiple_ambiguous_crossings')
        || (!offset.found && offset.reason === 'multiple_ambiguous_crossings')) {
        flags.push(reviewFlag(segment, event.id, 'speaker_local_boundary_ambiguous_crossings'));
      }
      return roundInterval({ start, end });
    });
    if (event.speaker !== originalSpeaker) throw new Error('speaker-local boundary refinement changed speaker identity');
    return {
      ...event,
      activity_segments: mergeIntervals(refinedSegments),
      speaker_local_boundary_refinement: SPEAKER_LOCAL_BOUNDARY_REFINEMENT_VERSION,
    };
  });

  assertMovesWithinProviderTurns(records, turnsBySpeaker);
  return {
    events: refinedEvents,
    flags,
    records,
    moves: records.flatMap((record) => ['onset', 'offset']
      .filter((side) => record[side]?.applied)
      .map((side) => ({
        event_id: record.event_id,
        speaker: record.speaker,
        provider_turn_id: record.provider_turn_id,
        side,
        from: record[side].from,
        to: record[side].to,
        delta_seconds: round(record[side].to - record[side].from, 6),
        evidence: record[side],
        reason: record.reason,
      }))),
    stats: {
      explicit_event_count: refinedEvents.filter((event) => event.semantic_evidence === 'explicit_asr').length,
      moved_onset_count: movedOnsets,
      moved_offset_count: movedOffsets,
      moved_boundary_count: movedOnsets + movedOffsets,
      ambiguous_side_count: records.reduce((sum, record) => sum
        + Number(record.onset?.reason === 'multiple_ambiguous_crossings')
        + Number(record.offset?.reason === 'multiple_ambiguous_crossings'), 0),
    },
    options,
    contract_version: SPEAKER_LOCAL_BOUNDARY_REFINEMENT_VERSION,
    runtime_gold_access: false,
    room_mix_boundary_crossing: false,
  };
}

function unchangedResult(events, options) {
  return {
    events: structuredClone(events), flags: [], records: [], moves: [],
    stats: { explicit_event_count: 0, moved_onset_count: 0, moved_offset_count: 0, moved_boundary_count: 0, ambiguous_side_count: 0 },
    options, contract_version: SPEAKER_LOCAL_BOUNDARY_REFINEMENT_VERSION,
    runtime_gold_access: false, room_mix_boundary_crossing: false,
  };
}

function retainedRecord(event, segment, segmentIndex, reason, turn = null) {
  return {
    event_id: event.id, segment_index: segmentIndex, speaker: event.speaker,
    provider_turn_id: turn?.id || null, before: roundInterval(segment), after: roundInterval(segment),
    onset: { found: false, applied: false, from: round(segment.start, 6), to: round(segment.start, 6), reason },
    offset: { found: false, applied: false, from: round(segment.end, 6), to: round(segment.end, 6), reason },
    retained_reasons: [reason], reason: 'original_boundaries_retained',
    evidence_source: 'speaker_conditioned_muted_mirror_within_provider_turn',
  };
}

function reviewFlag(segment, eventId, code) {
  return {
    start: round(segment.start, 6), end: round(segment.end, 6), code,
    severity: 'review', source: 'speaker_local_boundary_refinement', related_id: eventId,
  };
}

function assertMovesWithinProviderTurns(records, turnsBySpeaker) {
  for (const record of records.filter((item) => item.onset?.applied || item.offset?.applied)) {
    const contained = (turnsBySpeaker[record.speaker] || []).some((turn) =>
      turn.id === record.provider_turn_id
      && record.after.start >= turn.start - EPSILON
      && record.after.end <= turn.end + EPSILON);
    if (!contained) throw new Error(`refined ${record.event_id} crosses provider turn for ${record.speaker}`);
  }
}

function validateInputs(events, support, options) {
  if (!Array.isArray(events)) throw new Error('events are required');
  if (!support?.boundary_frames_by_speaker) throw new Error('speaker-local boundary frames are required');
  for (const speaker of SPEAKERS) {
    if (!Array.isArray(support.boundary_frames_by_speaker[speaker])) throw new Error(`${speaker} boundary frames missing`);
    if (!Array.isArray(support.provider_turns_by_speaker?.[speaker])) throw new Error(`${speaker} provider turns missing`);
  }
  for (const key of ['onsetRadiusMs', 'offsetRadiusMs', 'smoothingMs', 'hysteresisDb', 'onsetStableRunMs', 'offsetStableRunMs', 'minimumContrastDb', 'minimumDisplacementMs', 'maximumDisplacementMs', 'hopMs']) {
    if (!Number.isFinite(Number(options[key])) || Number(options[key]) < 0) throw new Error(`${key} must be non-negative`);
  }
  if (Number(options.onsetRadiusMs) > 250 || Number(options.offsetRadiusMs) > 250) {
    throw new Error('speaker-local boundary search radius cannot exceed 250 ms');
  }
  if (Number(options.maximumDisplacementMs) + EPSILON < Number(options.minimumDisplacementMs)) {
    throw new Error('maximumDisplacementMs must be at least minimumDisplacementMs');
  }
  if (!['all', 'outward_only', 'inward_only'].includes(options.movePolicy)) {
    throw new Error('movePolicy must be all, outward_only or inward_only');
  }
  for (const key of [
    'onsetMinimumContrastDb', 'offsetMinimumContrastDb',
    'onsetMinimumDisplacementMs', 'offsetMinimumDisplacementMs',
    'onsetMaximumDisplacementMs', 'offsetMaximumDisplacementMs',
  ]) {
    if (options[key] != null && (!Number.isFinite(Number(options[key])) || Number(options[key]) < 0)) {
      throw new Error(`${key} must be null or non-negative`);
    }
  }
  for (const key of ['onsetMovePolicy', 'offsetMovePolicy']) {
    if (options[key] != null && !['all', 'outward_only', 'inward_only'].includes(options[key])) {
      throw new Error(`${key} must be null, all, outward_only or inward_only`);
    }
  }
  for (const side of ['onset', 'offset']) {
    const minimum = Number(options[`${side}MinimumDisplacementMs`] ?? options.minimumDisplacementMs);
    const maximum = Number(options[`${side}MaximumDisplacementMs`] ?? options.maximumDisplacementMs);
    if (maximum + EPSILON < minimum) throw new Error(`${side} maximum displacement must be at least minimum`);
  }
}

function moveAllowed(side, from, to, options) {
  if (side === 'onset' && options.onsetEnabled === false) return false;
  if (side === 'offset' && options.offsetEnabled === false) return false;
  const minimumDisplacementMs = Number(
    (side === 'onset' ? options.onsetMinimumDisplacementMs : options.offsetMinimumDisplacementMs)
      ?? options.minimumDisplacementMs,
  );
  const maximumDisplacementMs = Number(
    (side === 'onset' ? options.onsetMaximumDisplacementMs : options.offsetMaximumDisplacementMs)
      ?? options.maximumDisplacementMs,
  );
  const movePolicy = (side === 'onset' ? options.onsetMovePolicy : options.offsetMovePolicy)
    ?? options.movePolicy;
  const displacementMs = Math.abs(Number(to) - Number(from)) * 1000;
  if (displacementMs + EPSILON < minimumDisplacementMs
    || displacementMs > maximumDisplacementMs + EPSILON) return false;
  if (movePolicy === 'outward_only') {
    return side === 'onset' ? Number(to) < Number(from) : Number(to) > Number(from);
  }
  if (movePolicy === 'inward_only') {
    return side === 'onset' ? Number(to) > Number(from) : Number(to) < Number(from);
  }
  return true;
}

function activitySegments(event) {
  return Array.isArray(event.activity_segments) && event.activity_segments.length
    ? event.activity_segments.map((item) => ({ start: Number(item.start), end: Number(item.end) }))
    : [{ start: Number(event.start), end: Number(event.end) }];
}

function mergeIntervals(intervals) {
  const output = [];
  for (const interval of [...intervals].sort((left, right) => left.start - right.start || left.end - right.end)) {
    const previous = output.at(-1);
    if (previous && interval.start <= previous.end + EPSILON) previous.end = Math.max(previous.end, interval.end);
    else output.push({ ...interval });
  }
  return output.map(roundInterval);
}

function roundInterval(interval) {
  return { start: round(Number(interval.start), 6), end: round(Number(interval.end), 6) };
}
