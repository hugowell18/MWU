import { EPSILON, SPEAKERS, canonicalJson, round, sha256 } from '../core/contracts.mjs';
import { serializeTextGrid } from '../core/textgrid.mjs';
import { structuralDigests } from './frozen-semantic-pass.mjs';

const FILLER_TOKENS = Object.freeze(['uh', 'um', 'er', 'erm']);

export function applyV23cFillerPass(baseOutput, events, speakerAcousticSupport, userOptions = {}) {
  const options = {
    mode: 'exact_word',
    expansionCapSeconds: 0.6,
    acousticSupportRatio: 0.5,
    fillerTokens: FILLER_TOKENS,
    ...userOptions,
  };
  if (!['exact_word', 'acoustic_cell'].includes(options.mode)) throw new Error('invalid filler mode');
  const before = structuralDigests(baseOutput.textgrid_document);
  if (options.mode === 'exact_word') return attachSemanticEvidence(baseOutput, before, options, []);

  const document = structuredClone(baseOutput.textgrid_document);
  const explicit = events.filter((event) => event.semantic_evidence === 'explicit_asr');
  const records = [];
  for (const speaker of SPEAKERS) {
    const tier = document.tiers.find((item) => item.name === speaker);
    const speakerEvents = explicit.filter((event) => event.speaker === speaker).sort(eventSort);
    const activeSpans = tier.intervals.filter((interval) => ['s', 'f', 'bc', 'ol'].includes(interval.text));
    const acoustic = speakerAcousticSupport.by_speaker[speaker] || [];
    const relabelSpans = [];
    for (const [index, event] of speakerEvents.entries()) {
      if (!isExplicitFiller(event, options.fillerTokens)) continue;
      const original = activityEnvelope(event);
      const center = (original.start + original.end) / 2;
      const previous = speakerEvents[index - 1] ? eventCenter(speakerEvents[index - 1]) : null;
      const next = speakerEvents[index + 1] ? eventCenter(speakerEvents[index + 1]) : null;
      const wordCell = {
        start: previous == null ? original.start : (previous + center) / 2,
        end: next == null ? original.end : (center + next) / 2,
      };
      const bounded = {
        start: Math.max(wordCell.start, original.start - Number(options.expansionCapSeconds)),
        end: Math.min(wordCell.end, original.end + Number(options.expansionCapSeconds)),
      };
      const withinActive = intersectIntervals([bounded], activeSpans.filter((item) => item.text === 's' || item.text === 'f'));
      const withinAcoustic = intersectIntervals(withinActive, acoustic);
      const supportRatio = intervalSeconds(withinAcoustic) / Math.max(EPSILON, bounded.end - bounded.start);
      const accepted = supportRatio + EPSILON >= Number(options.acousticSupportRatio)
        ? withinAcoustic
        : intersectIntervals(activitySegments(event), withinAcoustic);
      relabelSpans.push(...accepted);
      records.push({
        event_id: event.id,
        speaker,
        tokens: normalizedTokens(event),
        original,
        word_cell: roundInterval(wordCell),
        bounded_cell: roundInterval(bounded),
        support_ratio: round(supportRatio, 6),
        accepted_spans: accepted.map(roundInterval),
        expansion_applied: accepted.some((span) => span.start < original.start - EPSILON || span.end > original.end + EPSILON),
      });
    }
    tier.intervals = relabelSIntervals(tier.intervals, relabelSpans, 'f');
  }
  const after = structuralDigests(document);
  for (const key of ['active', 'floor', 'transitions']) {
    if (before[key] !== after[key]) throw new Error(`filler pass changed frozen ${key} artifact`);
  }
  const textgrid = serializeTextGrid(document);
  return attachSemanticEvidence({
    ...baseOutput,
    textgrid_document: document,
    textgrid,
    digest: sha256(textgrid),
  }, after, options, records);
}

function attachSemanticEvidence(output, digests, options, records) {
  return {
    ...output,
    v23c_filler_pass: {
      contract_version: 'v23c-filler-pass-v1',
      runtime_gold_access: false,
      mode: options.mode,
      expansion_cap_seconds: Number(options.expansionCapSeconds),
      acoustic_support_ratio: Number(options.acousticSupportRatio),
      filler_lexicon: [...options.fillerTokens],
      records,
      structural_digests: digests,
      evidence_sha256: sha256(canonicalJson(records)),
    },
  };
}

function isExplicitFiller(event, lexicon) {
  if (event.semantic_class === 'filled_pause' || event.lexical_class === 'filled_pause') return true;
  const allowed = new Set(lexicon.map((token) => token.toLowerCase()));
  const tokens = normalizedTokens(event);
  return tokens.length > 0 && tokens.every((token) => allowed.has(token));
}

function relabelSIntervals(intervals, spans, label) {
  const normalized = mergeIntervals(spans);
  const output = [];
  for (const interval of intervals) {
    if (interval.text !== 's') {
      append(output, interval);
      continue;
    }
    const cuts = new Set([interval.start, interval.end]);
    for (const span of normalized) {
      if (span.end <= interval.start + EPSILON || span.start >= interval.end - EPSILON) continue;
      cuts.add(Math.max(interval.start, span.start));
      cuts.add(Math.min(interval.end, span.end));
    }
    const ordered = [...cuts].sort((left, right) => left - right);
    for (let index = 0; index < ordered.length - 1; index += 1) {
      const start = ordered[index];
      const end = ordered[index + 1];
      if (!(end > start + EPSILON)) continue;
      const mid = (start + end) / 2;
      const relabel = normalized.some((span) => span.start <= mid + EPSILON && mid < span.end - EPSILON);
      append(output, { start, end, text: relabel ? label : interval.text });
    }
  }
  return output;
}

function intersectIntervals(leftIntervals, rightIntervals) {
  const output = [];
  for (const left of leftIntervals) for (const right of rightIntervals) {
    const start = Math.max(Number(left.start), Number(right.start));
    const end = Math.min(Number(left.end), Number(right.end));
    if (end > start + EPSILON) output.push({ start, end });
  }
  return mergeIntervals(output);
}

function mergeIntervals(intervals) {
  const output = [];
  for (const interval of [...intervals].sort((left, right) => left.start - right.start || left.end - right.end)) {
    const previous = output[output.length - 1];
    if (previous && interval.start <= previous.end + EPSILON) previous.end = Math.max(previous.end, interval.end);
    else output.push({ start: Number(interval.start), end: Number(interval.end) });
  }
  return output;
}

function append(output, interval) {
  const normalized = { start: round(interval.start, 6), end: round(interval.end, 6), text: interval.text };
  const previous = output[output.length - 1];
  if (previous && previous.text === normalized.text && Math.abs(previous.end - normalized.start) <= EPSILON) {
    previous.end = normalized.end;
  } else output.push(normalized);
}

function activitySegments(event) {
  return Array.isArray(event.activity_segments) && event.activity_segments.length
    ? event.activity_segments
    : [{ start: Number(event.start), end: Number(event.end) }];
}

function activityEnvelope(event) {
  return {
    start: Math.min(...activitySegments(event).map((item) => Number(item.start))),
    end: Math.max(...activitySegments(event).map((item) => Number(item.end))),
  };
}

function eventCenter(event) {
  const envelope = activityEnvelope(event);
  return (envelope.start + envelope.end) / 2;
}

function normalizedTokens(event) {
  return (event.tokens || []).map((token) => String(token).trim().toLowerCase()).filter(Boolean);
}

function intervalSeconds(intervals) {
  return mergeIntervals(intervals).reduce((sum, item) => sum + item.end - item.start, 0);
}

function roundInterval(interval) {
  return { start: round(interval.start, 6), end: round(interval.end, 6) };
}

function eventSort(left, right) {
  return Number(left.start) - Number(right.start) || Number(left.end) - Number(right.end)
    || String(left.id).localeCompare(String(right.id));
}
