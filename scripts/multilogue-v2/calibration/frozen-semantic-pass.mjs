import { DEFAULT_BACKCHANNEL_LEXICON, DEFAULT_TURN_PROJECTORS } from '../core/interaction-engine.mjs';
import { EPSILON, SPEAKERS, canonicalJson, round, sha256 } from '../core/contracts.mjs';
import { serializeTextGrid } from '../core/textgrid.mjs';

export function applyFrozenFloorSemanticPass(baseOutput, events, userOptions = {}) {
  const options = {
    backchannelMaxWords: 3,
    holderContinuationWindowSeconds: 1,
    backchannelLexicon: DEFAULT_BACKCHANNEL_LEXICON,
    turnProjectors: DEFAULT_TURN_PROJECTORS,
    ...userOptions,
  };
  const before = structuralDigests(baseOutput.textgrid_document);
  const document = structuredClone(baseOutput.textgrid_document);
  const floorTier = document.tiers.find((tier) => tier.name === 'floor');
  const explicit = events.filter((event) => event.semantic_evidence === 'explicit_asr');
  const classified = new Map();
  let fillerCount = 0;
  let backchannelCount = 0;

  for (const event of explicit) {
    let label = null;
    if (event.semantic_class === 'filled_pause' || event.lexical_class === 'filled_pause') label = 'f';
    else if (isFrozenFloorBackchannel(event, explicit, floorTier, options)) label = 'bc';
    if (label) {
      classified.set(event.id, label);
      if (label === 'f') fillerCount += 1;
      else backchannelCount += 1;
    }
  }

  for (const speaker of SPEAKERS) {
    const tier = document.tiers.find((item) => item.name === speaker);
    tier.intervals = splitAndRelabel(tier.intervals, explicit.filter((event) => event.speaker === speaker), classified);
  }
  const after = structuralDigests(document);
  for (const key of ['active', 'floor', 'transitions']) {
    if (before[key] !== after[key]) throw new Error(`semantic stage changed frozen ${key} artifact`);
  }
  const textgrid = serializeTextGrid(document);
  return {
    ...baseOutput,
    textgrid_document: document,
    textgrid,
    digest: sha256(textgrid),
    semantic_pass: {
      config: {
        backchannel_max_words: Number(options.backchannelMaxWords),
        holder_continuation_window_seconds: Number(options.holderContinuationWindowSeconds),
      },
      explicit_event_count: explicit.length,
      filler_candidate_count: fillerCount,
      backchannel_candidate_count: backchannelCount,
      unknown_residual_event_count: events.filter((event) => event.semantic_evidence === 'unknown_acoustic').length,
      frozen_digests: after,
    },
  };
}

export function structuralDigests(document) {
  const active = SPEAKERS.map((speaker) => {
    const tier = document.tiers.find((item) => item.name === speaker);
    return {
      speaker,
      intervals: mergeActiveIntervals(tier.intervals
        .filter((interval) => ['s', 'f', 'bc', 'ol'].includes(interval.text))
        .map((interval) => ({ start: interval.start, end: interval.end }))),
    };
  });
  return {
    active: sha256(canonicalJson(active)),
    floor: sha256(canonicalJson(document.tiers.find((tier) => tier.name === 'floor').intervals)),
    transitions: sha256(canonicalJson(document.tiers.find((tier) => tier.name === 'transitions').points)),
  };
}

function mergeActiveIntervals(intervals) {
  const output = [];
  for (const interval of intervals) {
    const previous = output[output.length - 1];
    if (previous && interval.start <= previous.end + EPSILON) previous.end = Math.max(previous.end, interval.end);
    else output.push({ ...interval });
  }
  return output;
}

function isFrozenFloorBackchannel(event, events, floorTier, options) {
  const mid = (activityStart(event) + activityEnd(event)) / 2;
  const holder = floorTier.intervals.find((interval) => interval.start <= mid + EPSILON && mid < interval.end - EPSILON)?.text;
  if (!SPEAKERS.includes(holder) || holder === event.speaker) return false;
  const tokens = interactionTokens(event);
  if (tokens.length === 0 || tokens.length > Number(options.backchannelMaxWords)) return false;
  const lexicon = new Set(options.backchannelLexicon);
  const phrase = tokens.join(' ');
  const matched = lexicon.has(phrase) ? tokens.length : tokens.filter((token) => lexicon.has(token)).length;
  if (matched <= tokens.length / 2) return false;
  if (options.turnProjectors.some((projector) => phrase === projector || phrase.startsWith(`${projector} `))) return false;
  const eventStart = activityStart(event);
  const eventEnd = activityEnd(event);
  return events.some((candidate) => candidate.speaker === holder
    && candidate.provisional_kind === 'vocalisation'
    && candidate.id !== event.id
    && (activitySegments(candidate).some((segment) => segment.start <= eventEnd + EPSILON
      && segment.end >= eventStart - EPSILON)
      || (activityStart(candidate) >= eventEnd - EPSILON
        && activityStart(candidate) - eventEnd <= Number(options.holderContinuationWindowSeconds) + EPSILON)));
}

function splitAndRelabel(intervals, events, classified) {
  const output = [];
  for (const interval of intervals) {
    if (interval.text !== 's') {
      appendMerged(output, interval);
      continue;
    }
    const relevant = events.filter((event) => classified.has(event.id)
      && activitySegments(event).some((segment) => segment.start < interval.end - EPSILON
        && segment.end > interval.start + EPSILON));
    const cuts = new Set([Number(interval.start), Number(interval.end)]);
    for (const event of relevant) {
      for (const segment of activitySegments(event)) {
        cuts.add(Math.max(interval.start, segment.start));
        cuts.add(Math.min(interval.end, segment.end));
      }
    }
    const ordered = [...cuts].filter(Number.isFinite).sort((left, right) => left - right);
    for (let index = 0; index < ordered.length - 1; index += 1) {
      const start = ordered[index];
      const end = ordered[index + 1];
      if (!(end > start + EPSILON)) continue;
      const mid = (start + end) / 2;
      const event = relevant.find((candidate) => activitySegments(candidate)
        .some((segment) => segment.start <= mid + EPSILON && mid < segment.end - EPSILON));
      appendMerged(output, { start: round(start, 6), end: round(end, 6), text: event ? classified.get(event.id) : 's' });
    }
  }
  return output;
}

function appendMerged(output, interval) {
  const previous = output[output.length - 1];
  if (previous && previous.text === interval.text && Math.abs(previous.end - interval.start) <= EPSILON) {
    previous.end = round(interval.end, 6);
  } else output.push({ start: round(interval.start, 6), end: round(interval.end, 6), text: interval.text });
}

function activitySegments(event) {
  return Array.isArray(event.activity_segments) && event.activity_segments.length
    ? event.activity_segments
    : [{ start: Number(event.start), end: Number(event.end) }];
}

function activityStart(event) {
  return Math.min(...activitySegments(event).map((segment) => Number(segment.start)));
}

function activityEnd(event) {
  return Math.max(...activitySegments(event).map((segment) => Number(segment.end)));
}

function interactionTokens(event) {
  const source = Array.isArray(event.interaction_tokens) && event.interaction_tokens.length
    ? event.interaction_tokens
    : event.tokens || [];
  return source.map((token) => String(token).trim().toLowerCase()).filter(Boolean);
}
