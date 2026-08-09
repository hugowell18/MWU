import { EPSILON, round } from '../core/contracts.mjs';

export const LOCAL_CROSSING_RULE_VERSION = 'local-frame-db-crossing-v1';

export function smoothFrameDbs(frames, smoothingMs, hopMs = 10) {
  const width = Math.max(1, Math.round(Number(smoothingMs) / Number(hopMs)));
  const radiusLeft = Math.floor((width - 1) / 2);
  const radiusRight = width - radiusLeft - 1;
  return frames.map((frame, index) => {
    const start = Math.max(0, index - radiusLeft);
    const end = Math.min(frames.length, index + radiusRight + 1);
    const db = frames.slice(start, end).reduce((sum, item) => sum + Number(item.db), 0) / (end - start);
    return { start: Number(frame.start), end: Number(frame.end), db };
  });
}

export function prepareSmoothedCrossingEvidence(frames, smoothingMs, hopMs = 10) {
  return {
    frames: smoothFrameDbs(frames, smoothingMs, hopMs),
    smoothing_ms: Number(smoothingMs),
    hop_ms: Number(hopMs),
  };
}

export function findStableBoundaryCrossing({
  frames,
  prepared,
  boundary,
  direction,
  thresholdDb,
  radiusMs,
  smoothingMs,
  hysteresisDb,
  stableRunMs,
  hopMs = 10,
}) {
  if (!['onset', 'offset'].includes(direction)) throw new Error(`unsupported crossing direction: ${direction}`);
  const smoothed = prepared?.frames || smoothFrameDbs(frames, smoothingMs, hopMs);
  const radiusSeconds = Number(radiusMs) / 1000;
  const stableFrames = Math.max(1, Math.ceil(Number(stableRunMs) / Number(hopMs)));
  const low = Number(thresholdDb) - Number(hysteresisDb) / 2;
  const high = Number(thresholdDb) + Number(hysteresisDb) / 2;
  const candidates = [];
  const transitionFrames = Math.max(1, Math.ceil(Number(smoothingMs) / Number(hopMs)));
  const first = Math.max(stableFrames - 1, lowerBound(smoothed, Number(boundary) - radiusSeconds) - transitionFrames);
  const last = Math.min(smoothed.length - stableFrames - 1, upperBound(smoothed, Number(boundary) + radiusSeconds));
  for (let leftEnd = first; leftEnd <= last; leftEnd += 1) {
    const before = smoothed.slice(leftEnd - stableFrames + 1, leftEnd + 1);
    const beforeStable = direction === 'onset'
      ? before.every((frame) => frame.db <= low)
      : before.every((frame) => frame.db >= high);
    if (!beforeStable) continue;
    const rightLimit = Math.min(smoothed.length - stableFrames, leftEnd + transitionFrames + 1);
    for (let rightStart = leftEnd + 1; rightStart <= rightLimit; rightStart += 1) {
      const after = smoothed.slice(rightStart, rightStart + stableFrames);
      const afterStable = direction === 'onset'
        ? after.every((frame) => frame.db >= high)
        : after.every((frame) => frame.db <= low);
      if (!afterStable) continue;
      const time = (smoothed[leftEnd].end + smoothed[rightStart].start) / 2;
      if (Math.abs(time - Number(boundary)) <= radiusSeconds + EPSILON) {
        candidates.push({ time, index: rightStart, transition_frame_count: rightStart - leftEnd - 1 });
      }
    }
  }

  const selected = candidates.sort((left, right) =>
    Math.abs(left.time - boundary) - Math.abs(right.time - boundary) || left.time - right.time)[0];
  return selected
    ? {
      found: true,
      time: round(selected.time, 6),
      frame_index: selected.index,
      transition_frame_count: selected.transition_frame_count,
      distance_seconds: round(Math.abs(selected.time - boundary), 6),
      threshold_db: round(thresholdDb, 6),
      low_db: round(low, 6),
      high_db: round(high, 6),
      stable_frame_count: stableFrames,
    }
    : {
      found: false,
      time: round(boundary, 6),
      threshold_db: round(thresholdDb, 6),
      low_db: round(low, 6),
      high_db: round(high, 6),
      stable_frame_count: stableFrames,
    };
}

export function findUniqueStableBoundaryCrossing({
  frames,
  prepared,
  boundary,
  direction,
  thresholdDb,
  radiusMs,
  smoothingMs,
  hysteresisDb,
  stableRunMs,
  minimumContrastDb = 3,
  hopMs = 10,
}) {
  if (!['onset', 'offset'].includes(direction)) throw new Error(`unsupported crossing direction: ${direction}`);
  const smoothed = prepared?.frames || smoothFrameDbs(frames, smoothingMs, hopMs);
  const radiusSeconds = Number(radiusMs) / 1000;
  const stableFrames = Math.max(1, Math.ceil(Number(stableRunMs) / Number(hopMs)));
  const low = Number(thresholdDb) - Number(hysteresisDb) / 2;
  const high = Number(thresholdDb) + Number(hysteresisDb) / 2;
  const transitionFrames = Math.max(1, Math.ceil(Number(smoothingMs) / Number(hopMs)));
  const first = Math.max(stableFrames - 1, lowerBound(smoothed, Number(boundary) - radiusSeconds) - transitionFrames);
  const last = Math.min(smoothed.length - stableFrames - 1, upperBound(smoothed, Number(boundary) + radiusSeconds));
  const raw = [];
  for (let leftEnd = first; leftEnd <= last; leftEnd += 1) {
    const before = smoothed.slice(leftEnd - stableFrames + 1, leftEnd + 1);
    const beforeStable = direction === 'onset'
      ? before.every((frame) => frame.db <= low)
      : before.every((frame) => frame.db >= high);
    if (!beforeStable) continue;
    const rightLimit = Math.min(smoothed.length - stableFrames, leftEnd + transitionFrames + 1);
    for (let rightStart = leftEnd + 1; rightStart <= rightLimit; rightStart += 1) {
      const after = smoothed.slice(rightStart, rightStart + stableFrames);
      const afterStable = direction === 'onset'
        ? after.every((frame) => frame.db >= high)
        : after.every((frame) => frame.db <= low);
      if (!afterStable) continue;
      const time = (smoothed[leftEnd].end + smoothed[rightStart].start) / 2;
      if (Math.abs(time - Number(boundary)) > radiusSeconds + EPSILON) continue;
      const beforeMean = meanDb(before);
      const afterMean = meanDb(after);
      const contrast = direction === 'onset' ? afterMean - beforeMean : beforeMean - afterMean;
      if (contrast + EPSILON < Number(minimumContrastDb)) continue;
      raw.push({
        time,
        index: rightStart,
        transition_frame_count: rightStart - leftEnd - 1,
        before_mean_db: beforeMean,
        after_mean_db: afterMean,
        contrast_db: contrast,
      });
    }
  }
  const clusters = clusterCrossings(raw, Math.max(Number(hopMs) * 2, Number(smoothingMs)) / 1000);
  if (clusters.length !== 1) {
    return {
      found: false,
      unique: false,
      reason: clusters.length === 0 ? 'no_strong_crossing' : 'multiple_ambiguous_crossings',
      time: round(boundary, 6),
      crossing_cluster_count: clusters.length,
      candidate_count: raw.length,
      threshold_db: round(thresholdDb, 6),
      stable_frame_count: stableFrames,
    };
  }
  const selected = [...clusters[0]].sort((left, right) =>
    Math.abs(left.time - boundary) - Math.abs(right.time - boundary)
    || right.contrast_db - left.contrast_db
    || left.time - right.time)[0];
  return {
    found: true,
    unique: true,
    reason: 'unique_strong_stable_crossing',
    time: round(selected.time, 6),
    frame_index: selected.index,
    transition_frame_count: selected.transition_frame_count,
    distance_seconds: round(Math.abs(selected.time - boundary), 6),
    delta_seconds: round(selected.time - boundary, 6),
    threshold_db: round(thresholdDb, 6),
    before_mean_db: round(selected.before_mean_db, 6),
    after_mean_db: round(selected.after_mean_db, 6),
    contrast_db: round(selected.contrast_db, 6),
    stable_frame_count: stableFrames,
    crossing_cluster_count: 1,
    candidate_count: raw.length,
  };
}

export function refineProviderBoundariesAtCrossings(events, {
  frames,
  thresholdDb,
  hopMs = 10,
  radiusMs,
  smoothingMs,
  hysteresisDb,
  stableRunMs,
}) {
  if (!Array.isArray(frames) || frames.length === 0) throw new Error('original WAV frame dB evidence is required');
  const prepared = prepareSmoothedCrossingEvidence(frames, smoothingMs, hopMs);
  const providerSegments = events
    .filter((event) => event.semantic_evidence === 'explicit_asr')
    .flatMap((event) => activitySegments(event).map((segment) => ({ ...segment, speaker: event.speaker, event_id: event.id })));
  const flags = [];
  const records = [];
  let moved = 0;
  let missing = 0;
  let conflictWithheld = 0;

  const output = events.map((event) => {
    if (event.semantic_evidence !== 'explicit_asr') return structuredClone(event);
    let eventChanged = false;
    const refined = activitySegments(event).map((segment) => {
      const onset = findStableBoundaryCrossing({
        prepared, boundary: segment.start, direction: 'onset', thresholdDb, radiusMs,
        smoothingMs, hysteresisDb, stableRunMs, hopMs,
      });
      const offset = findStableBoundaryCrossing({
        prepared, boundary: segment.end, direction: 'offset', thresholdDb, radiusMs,
        smoothingMs, hysteresisDb, stableRunMs, hopMs,
      });
      let start = onset.time;
      let end = offset.time;
      const withheld = [];

      if (!onset.found) missing += 1;
      if (!offset.found) missing += 1;
      const disagreement = event.speaker_fusion?.disagreement === true;
      if (start < segment.start - EPSILON && (disagreement || hasProviderConflict(
        { start, end: segment.start }, event, providerSegments,
      ))) {
        start = segment.start;
        withheld.push('onset_extension');
      }
      if (end > segment.end + EPSILON && (disagreement || hasProviderConflict(
        { start: segment.end, end }, event, providerSegments,
      ))) {
        end = segment.end;
        withheld.push('offset_extension');
      }
      if (withheld.length) conflictWithheld += withheld.length;
      if (!(end > start + EPSILON)) {
        start = segment.start;
        end = segment.end;
        withheld.push('invalid_crossing_order');
      }
      const changed = Math.abs(start - segment.start) > EPSILON || Math.abs(end - segment.end) > EPSILON;
      if (changed) {
        moved += 1;
        eventChanged = true;
      }
      const status = !onset.found || !offset.found
        ? 'crossing_missing_original_boundary_retained'
        : withheld.length ? 'crossing_extension_withheld_provider_conflict'
          : changed ? 'stable_crossing_applied' : 'stable_crossing_unchanged';
      if (!onset.found || !offset.found || withheld.length) {
        flags.push({
          start: segment.start,
          end: segment.end,
          code: !onset.found || !offset.found
            ? 'local_boundary_crossing_not_found'
            : 'local_boundary_crossing_withheld_provider_conflict',
          severity: 'review',
          source: 'stage1_v23_local_crossing',
          related_id: event.id,
        });
      }
      records.push({
        event_id: event.id,
        speaker: event.speaker,
        before: roundInterval(segment),
        after: roundInterval({ start, end }),
        onset,
        offset,
        applied_sides: {
          onset: onset.found && Math.abs(start - segment.start) > EPSILON,
          offset: offset.found && Math.abs(end - segment.end) > EPSILON,
        },
        retained_original_sides: {
          onset: !onset.found || withheld.includes('onset_extension'),
          offset: !offset.found || withheld.includes('offset_extension'),
        },
        withheld,
        status,
      });
      return roundInterval({ start, end });
    });
    return {
      ...event,
      activity_segments: mergeIntervals(refined),
      boundary_refinement: eventChanged ? LOCAL_CROSSING_RULE_VERSION : 'unchanged',
    };
  });

  return {
    events: output,
    flags,
    records,
    stats: {
      moved_segment_count: moved,
      missing_crossing_count: missing,
      provider_conflict_withheld_count: conflictWithheld,
    },
  };
}

function lowerBound(frames, time) {
  let low = 0;
  let high = frames.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (frames[middle].start < time) low = middle + 1;
    else high = middle;
  }
  return low;
}

function upperBound(frames, time) {
  let low = 0;
  let high = frames.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (frames[middle].start <= time) low = middle + 1;
    else high = middle;
  }
  return Math.max(0, low - 1);
}

function clusterCrossings(items, maximumGapSeconds) {
  const clusters = [];
  for (const item of [...items].sort((left, right) => left.time - right.time || left.index - right.index)) {
    const cluster = clusters[clusters.length - 1];
    if (cluster && item.time - cluster.at(-1).time <= maximumGapSeconds + EPSILON) cluster.push(item);
    else clusters.push([item]);
  }
  return clusters;
}

function meanDb(frames) {
  return frames.reduce((sum, frame) => sum + Number(frame.db), 0) / frames.length;
}

function hasProviderConflict(extension, event, providerSegments) {
  return providerSegments.some((candidate) => candidate.event_id !== event.id
    && candidate.speaker !== event.speaker
    && candidate.start < extension.end - EPSILON
    && candidate.end > extension.start + EPSILON);
}

function activitySegments(event) {
  return Array.isArray(event.activity_segments) && event.activity_segments.length
    ? event.activity_segments
    : [{ start: Number(event.start), end: Number(event.end) }];
}

function mergeIntervals(intervals) {
  const output = [];
  for (const interval of [...intervals].sort((left, right) => left.start - right.start || left.end - right.end)) {
    const previous = output[output.length - 1];
    if (previous && interval.start <= previous.end + EPSILON) previous.end = Math.max(previous.end, interval.end);
    else output.push({ ...interval });
  }
  return output.map(roundInterval);
}

function roundInterval(interval) {
  return { start: round(Number(interval.start), 6), end: round(Number(interval.end), 6) };
}
