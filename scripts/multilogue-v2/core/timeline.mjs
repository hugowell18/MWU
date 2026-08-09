import {
  EPSILON,
  FRAME_STEP_SECONDS,
  PROVISIONAL_KINDS,
  SPEAKERS,
  invariant,
  normalizeConfidence,
  round,
  sortedUnique,
} from './contracts.mjs';
import { flagSort, makeFlag, snapTime } from './mapping.mjs';

export function buildBaseActivityFrames(duration, soundingIntervals, frameStep = FRAME_STEP_SECONDS) {
  invariant(Number.isFinite(Number(duration)) && Number(duration) > 0, 'duration must be positive');
  invariant(Math.abs(frameStep - FRAME_STEP_SECONDS) <= EPSILON, 'First Slice frame step is fixed at 10 ms');
  const frameCount = Math.ceil(Number(duration) / frameStep);
  const frames = Array.from({ length: frameCount }, (_, index) => ({
    index,
    start: round(index * frameStep),
    end: round(Math.min(Number(duration), (index + 1) * frameStep)),
    sounding: false,
    base_sounding: false,
    filled_by_threshold: false,
    discarded_short_sounding: false,
  }));
  for (const interval of soundingIntervals) {
    const start = snapTime(interval.start, frameStep, duration);
    const end = snapTime(interval.end, frameStep, duration);
    if (!(end > start + EPSILON)) continue;
    for (const frame of frames) {
      if (frame.start < end - EPSILON && frame.end > start + EPSILON) frame.sounding = true;
    }
  }
  for (const frame of frames) frame.base_sounding = frame.sounding;
  return frames;
}

export function deriveSharedActivity(baseFrames, threshold, { minSoundingSeconds = 0.1 } = {}) {
  const frames = baseFrames.map((frame) => ({
    ...frame,
    base_sounding: frame.base_sounding ?? frame.sounding,
    filled_by_threshold: false,
    discarded_short_sounding: false,
  }));
  const minimumFrames = Math.ceil((minSoundingSeconds - EPSILON) / FRAME_STEP_SECONDS);
  for (const run of booleanRuns(frames, true)) {
    if (run.endIndex - run.startIndex < minimumFrames) {
      for (let index = run.startIndex; index < run.endIndex; index += 1) {
        frames[index].sounding = false;
        frames[index].discarded_short_sounding = true;
      }
    }
  }
  for (const run of booleanRuns(frames, false)) {
    const duration = frames[run.endIndex - 1].end - frames[run.startIndex].start;
    if (duration < Number(threshold) - EPSILON && run.startIndex > 0 && run.endIndex < frames.length) {
      for (let index = run.startIndex; index < run.endIndex; index += 1) {
        frames[index].sounding = true;
        frames[index].filled_by_threshold = true;
      }
    }
  }
  const provenanceIntervals = mergeFrameValues(frames, activityProvenance);
  return {
    threshold: Number(threshold),
    frames,
    intervals: mergeFrameValues(frames, (frame) => frame.sounding ? 'sounding' : 'silence'),
    provenance_intervals: provenanceIntervals,
    summary: {
      base_sounding_sec: frameSeconds(frames, (frame) => frame.base_sounding && !frame.discarded_short_sounding),
      threshold_filled_sec: frameSeconds(frames, (frame) => frame.filled_by_threshold),
      final_sounding_sec: frameSeconds(frames, (frame) => frame.sounding),
    },
  };
}

export function normalizeStage1Evidence(events, { duration, frameStep = FRAME_STEP_SECONDS } = {}) {
  const normalized = [];
  const flags = [];
  for (const [index, event] of events.entries()) {
    const id = String(event.id ?? `event_${index + 1}`);
    invariant(SPEAKERS.includes(event.speaker), `${id} has invalid canonical speaker`);
    invariant(PROVISIONAL_KINDS.includes(event.provisional_kind), `${id} provisional_kind must be vocalisation/laughter/artifact`);
    const lexicalClass = String(event.lexical_class ?? 'unknown');
    invariant(['lexical', 'filled_pause', 'nonlexical', 'unknown'].includes(lexicalClass), `${id} has invalid lexical_class`);
    const start = snapTime(event.start, frameStep, duration);
    const end = snapTime(event.end, frameStep, duration);
    invariant(end > start + EPSILON, `${id} must have positive duration`);
    const confidence = normalizeConfidence(event.confidence);
    const evidenceState = event.evidence_state === 'unknown' ? 'unknown' : 'known';
    if (confidence === null) flags.push(makeFlag(start, end, 'confidence_unavailable', 'review', 'stage1', id));
    if (evidenceState === 'unknown' || lexicalClass === 'unknown') {
      flags.push(makeFlag(start, end, 'evidence_uncertain', 'review', 'stage1', id));
    }
    normalized.push({
      id,
      speaker: event.speaker,
      start,
      end,
      confidence,
      provisional_kind: event.provisional_kind,
      lexical_class: lexicalClass,
      evidence_state: evidenceState,
      tokens: Array.isArray(event.tokens) ? event.tokens.map(normalizeToken).filter(Boolean) : [],
      interaction_tokens: Array.isArray(event.interaction_tokens)
        ? event.interaction_tokens.map(normalizeToken).filter(Boolean)
        : [],
      parent_response_id: event.parent_response_id == null ? null : String(event.parent_response_id),
      parent_response_sequence: Number.isFinite(Number(event.parent_response_sequence))
        ? Number(event.parent_response_sequence)
        : null,
      child_sequence: Number.isFinite(Number(event.child_sequence)) ? Number(event.child_sequence) : null,
      parent_turn_projector_candidate: event.parent_turn_projector_candidate === true,
      parent_lexical_backchannel_candidate: event.parent_lexical_backchannel_candidate === true,
      short_explicit_question: event.short_explicit_question === true,
      hard_response_boundary: event.hard_response_boundary == null ? null : String(event.hard_response_boundary),
      soft_chuckle: event.soft_chuckle === true,
      activity_segments: normalizeActivitySegments(event.activity_segments, start, end, frameStep, duration),
      source_word_ids: Array.isArray(event.source_word_ids) ? event.source_word_ids.map(String) : [],
      source_event_ids: Array.isArray(event.source_event_ids) ? event.source_event_ids.map(String) : [],
      source_residual_ids: Array.isArray(event.source_residual_ids) ? event.source_residual_ids.map(String) : [],
      speaker_fusion: event.speaker_fusion && typeof event.speaker_fusion === 'object'
        ? structuredClone(event.speaker_fusion)
        : null,
      acoustic_support: event.acoustic_support == null ? null : String(event.acoustic_support),
      activity_eligible: event.activity_eligible !== false,
      semantic_evidence: event.semantic_evidence == null ? null : String(event.semantic_evidence),
      semantic_class: event.semantic_class == null ? null : String(event.semantic_class),
      runtime_acoustic_bc_candidate: event.runtime_acoustic_bc_candidate === true,
      overlap_corroborated_identity: event.overlap_corroborated_identity === true,
      floor_eligible: event.floor_eligible !== false,
      holder_retention_eligible: event.holder_retention_eligible === true,
      pre_floor_response_onset: event.pre_floor_response_onset === true,
      response_support_speaker: event.response_support_speaker == null ? null : String(event.response_support_speaker),
      response_runtime_evidence_ids: Array.isArray(event.response_runtime_evidence_ids)
        ? event.response_runtime_evidence_ids.map(String)
        : [],
      overlap_eligible: event.overlap_eligible !== false,
    });
  }
  normalized.sort((left, right) => left.start - right.start || left.end - right.end || left.speaker.localeCompare(right.speaker) || left.id.localeCompare(right.id));
  return { events: normalized, flags: flags.sort(flagSort) };
}

function normalizeActivitySegments(segments, eventStart, eventEnd, frameStep, duration) {
  if (!Array.isArray(segments) || segments.length === 0) return [{ start: eventStart, end: eventEnd }];
  const normalized = [];
  for (const segment of segments) {
    const start = Math.max(eventStart, snapTime(segment.start, frameStep, duration));
    const end = Math.min(eventEnd, snapTime(segment.end, frameStep, duration));
    if (end > start + EPSILON) normalized.push({ start, end });
  }
  return normalized.length ? normalized : [{ start: eventStart, end: eventEnd }];
}

export function mergeFrameValues(frames, valueForFrame) {
  const intervals = [];
  for (const frame of frames) {
    const value = valueForFrame(frame);
    const previous = intervals[intervals.length - 1];
    if (previous && previous.value === value && Math.abs(previous.end - frame.start) <= EPSILON) previous.end = frame.end;
    else intervals.push({ start: frame.start, end: frame.end, value });
  }
  return intervals.map((interval) => ({ ...interval, start: round(interval.start), end: round(interval.end) }));
}

export function mergeIntervalsByText(intervals) {
  const merged = [];
  for (const interval of intervals) {
    if (!(interval.end > interval.start + EPSILON)) continue;
    const text = String(interval.text ?? '');
    const previous = merged[merged.length - 1];
    if (previous && previous.text === text && Math.abs(previous.end - interval.start) <= EPSILON) previous.end = interval.end;
    else merged.push({ start: interval.start, end: interval.end, text });
  }
  return merged.map((interval) => ({ start: round(interval.start), end: round(interval.end), text: interval.text }));
}

export function flagsToFrameText(frames, flags) {
  return mergeFrameValues(frames, (frame) => sortedUnique(
    flags.filter((flag) => flag.start < frame.end - EPSILON && flag.end > frame.start + EPSILON).map((flag) => flag.code),
  ).join('|')).map(({ start, end, value }) => ({ start, end, text: value }));
}

export function coalesceFlags(flags) {
  const ordered = [...flags].sort(flagSort);
  const merged = [];
  for (const flag of ordered) {
    const previous = merged[merged.length - 1];
    if (
      previous
      && previous.code === flag.code
      && previous.severity === flag.severity
      && previous.source === flag.source
      && previous.related_id === flag.related_id
      && Math.abs(previous.end - flag.start) <= EPSILON
    ) {
      previous.end = round(flag.end);
    } else {
      merged.push({ ...flag });
    }
  }
  return merged;
}

function booleanRuns(frames, value) {
  const runs = [];
  let startIndex = null;
  for (let index = 0; index <= frames.length; index += 1) {
    const matches = index < frames.length && frames[index].sounding === value;
    if (matches && startIndex === null) startIndex = index;
    if (!matches && startIndex !== null) {
      runs.push({ startIndex, endIndex: index });
      startIndex = null;
    }
  }
  return runs;
}

function normalizeToken(value) {
  return String(value ?? '').trim().toLowerCase().replace(/^[^a-z0-9-]+|[^a-z0-9-]+$/g, '');
}

function activityProvenance(frame) {
  if (frame.discarded_short_sounding) return 'discarded_short_sounding';
  if (frame.base_sounding) return 'base_sounding';
  if (frame.filled_by_threshold) return 'threshold_filled';
  return 'silence';
}

function frameSeconds(frames, predicate) {
  return round(frames.filter(predicate).reduce((sum, frame) => sum + frame.end - frame.start, 0));
}
