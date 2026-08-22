import {
  EPSILON,
  SPEAKERS,
  canonicalSpeakers,
  invariant,
  normalizeConfidence,
  round,
} from './contracts.mjs';

function validateProviderMap(provider, value, speakers) {
  invariant(value && typeof value === 'object' && !Array.isArray(value), `${provider} mapping must be an object`);
  const entries = Object.entries(value);
  invariant(entries.length === speakers.length, `${provider} mapping must contain exactly ${speakers.length} provider speakers`);
  const canonical = entries.map(([, target]) => target);
  invariant(canonical.every((target) => speakers.includes(target)), `${provider} mapping contains a non-canonical speaker`);
  invariant(new Set(canonical).size === speakers.length, `${provider} mapping must be bijective onto ${speakers.join('/')}`);
  return Object.freeze(Object.fromEntries(entries.map(([source, target]) => [String(source), target])));
}

export function validateMappingContract(mapping, requestedSpeakers = null) {
  invariant(mapping && typeof mapping === 'object', 'speaker mapping contract is required');
  const inferred = requestedSpeakers || Object.values(mapping.pyannote || {});
  const speakers = canonicalSpeakers(inferred.length ? inferred : SPEAKERS);
  return Object.freeze({
    speakers,
    pyannote: validateProviderMap('pyannote', mapping.pyannote, speakers),
    assemblyai: validateProviderMap('assemblyai', mapping.assemblyai, speakers),
  });
}

export function mapAttributionTurns(turns, mappingContract, { frameStep = 0.01, duration } = {}) {
  const flags = [];
  const mapped = [];
  for (const [index, turn] of turns.entries()) {
    const sourceSpeaker = String(turn.speaker ?? '');
    const speaker = mappingContract.pyannote[sourceSpeaker];
    const start = snapTime(turn.start, frameStep, duration);
    const end = snapTime(turn.end, frameStep, duration);
    const relatedId = String(turn.id ?? `turn_${index + 1}`);
    if (!speaker) {
      flags.push(makeFlag(start, end, 'unmapped_attribution_speaker', 'error', 'mapping', relatedId));
      continue;
    }
    if (!(end > start + EPSILON)) {
      flags.push(makeFlag(start, Math.min(duration, start + frameStep), 'invalid_attribution_interval', 'error', 'mapping', relatedId));
      continue;
    }
    const confidence = normalizeConfidence(turn.confidence);
    if (confidence === null) {
      flags.push(makeFlag(start, end, 'confidence_unavailable', 'review', 'pyannote', relatedId));
    }
    mapped.push({
      id: relatedId,
      speaker,
      source_speaker: sourceSpeaker,
      start,
      end,
      confidence,
      source: 'pyannote',
    });
  }
  mapped.sort(intervalSort);
  return { turns: mapped, flags: flags.sort(flagSort) };
}

export function assignWordsByMaximumOverlap(words, mappedTurns, mappingContract, { frameStep = 0.01, duration } = {}) {
  const assigned = [];
  const flags = [];
  for (const [index, word] of words.entries()) {
    const id = String(word.id ?? `word_${index + 1}`);
    const start = snapTime(word.start, frameStep, duration);
    const end = snapTime(word.end, frameStep, duration);
    const confidence = normalizeConfidence(word.confidence);
    if (confidence === null) {
      flags.push(makeFlag(start, end, 'word_confidence_unavailable', 'review', 'assemblyai', id));
    }
    if (!(end > start + EPSILON)) {
      flags.push(makeFlag(start, Math.min(duration, start + frameStep), 'invalid_word_interval', 'error', 'word_assignment', id));
      assigned.push({ id, start, end, speaker: null, assignment: 'unresolved' });
      continue;
    }

    const speakers = mappingContract.speakers || SPEAKERS;
    const bySpeaker = new Map(speakers.map((speaker) => [speaker, []]));
    for (const turn of mappedTurns) {
      const overlapStart = Math.max(start, turn.start);
      const overlapEnd = Math.min(end, turn.end);
      if (overlapEnd > overlapStart + EPSILON) bySpeaker.get(turn.speaker).push({ start: overlapStart, end: overlapEnd, turnStart: turn.start });
    }

    const scores = speakers.map((speaker) => {
      const merged = mergeClipped(bySpeaker.get(speaker));
      return {
        speaker,
        overlap: merged.reduce((sum, interval) => sum + interval.end - interval.start, 0),
        earliest: bySpeaker.get(speaker).length ? Math.min(...bySpeaker.get(speaker).map((item) => item.turnStart)) : Number.POSITIVE_INFINITY,
      };
    });
    const maximum = Math.max(...scores.map((score) => score.overlap));
    if (!(maximum > EPSILON)) {
      flags.push(makeFlag(start, end, 'unresolved_word_assignment', 'review', 'word_assignment', id));
      assigned.push({ id, start, end, speaker: null, assignment: 'unresolved', confidence });
      continue;
    }

    let tied = scores.filter((score) => Math.abs(score.overlap - maximum) <= EPSILON);
    const mappedSource = mappingContract.assemblyai[String(word.speaker ?? '')] ?? null;
    let winner;
    if (mappedSource && tied.some((score) => score.speaker === mappedSource)) {
      winner = tied.find((score) => score.speaker === mappedSource);
    } else {
      const earliest = Math.min(...tied.map((score) => score.earliest));
      tied = tied.filter((score) => Math.abs(score.earliest - earliest) <= EPSILON);
      winner = tied.sort((left, right) => speakers.indexOf(left.speaker) - speakers.indexOf(right.speaker))[0];
    }
    assigned.push({
      id,
      start,
      end,
      speaker: winner.speaker,
      assignment: 'maximum_overlap',
      overlap_seconds: round(winner.overlap),
      confidence,
    });
  }
  assigned.sort((left, right) => left.start - right.start || left.end - right.end || left.id.localeCompare(right.id));
  return { words: assigned, flags: flags.sort(flagSort) };
}

export function snapTime(value, frameStep, duration) {
  const numeric = Number(value);
  invariant(Number.isFinite(numeric), `invalid time value: ${value}`);
  const snapped = Math.round(numeric / frameStep) * frameStep;
  return round(Math.max(0, Math.min(Number(duration), snapped)), 6);
}

export function makeFlag(start, end, code, severity = 'review', source = 'core', relatedId = '') {
  return { start: round(start), end: round(end), code, severity, source, related_id: String(relatedId || '') };
}

export function flagSort(left, right) {
  return left.start - right.start || left.end - right.end || left.code.localeCompare(right.code) || left.related_id.localeCompare(right.related_id);
}

function intervalSort(left, right) {
  return left.start - right.start || left.end - right.end || left.speaker.localeCompare(right.speaker) || left.id.localeCompare(right.id);
}

function mergeClipped(intervals) {
  const sorted = intervals.map(({ start, end }) => ({ start, end })).sort((a, b) => a.start - b.start || a.end - b.end);
  const merged = [];
  for (const interval of sorted) {
    const previous = merged[merged.length - 1];
    if (previous && interval.start <= previous.end + EPSILON) previous.end = Math.max(previous.end, interval.end);
    else merged.push({ ...interval });
  }
  return merged;
}
