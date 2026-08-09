import {
  EPSILON,
  FLOOR_LABELS,
  FTO_STATUSES,
  SPEAKERS,
  SPEAKER_LABELS,
  round,
  sortedUnique,
} from './contracts.mjs';

const EXPECTED_TIERS = Object.freeze([
  ['S1', 'IntervalTier'],
  ['S2', 'IntervalTier'],
  ['S3', 'IntervalTier'],
  ['floor', 'IntervalTier'],
  ['transitions', 'TextTier'],
  ['flags', 'IntervalTier'],
]);

export function validateSixTierTextGrid(document, { transitionStatuses = FTO_STATUSES } = {}) {
  const errors = [];
  const warnings = [];
  const tierReports = [];
  if (!document || !Array.isArray(document.tiers)) {
    return { valid: false, errors: ['document.tiers is required'], warnings, duration: null, tier_reports: [] };
  }
  if (document.tiers.length !== EXPECTED_TIERS.length) errors.push(`expected 6 tiers; received ${document.tiers.length}`);

  EXPECTED_TIERS.forEach(([name, className], index) => {
    const tier = document.tiers[index];
    if (!tier) return;
    if (tier.name !== name) errors.push(`tier ${index + 1} name must be ${name}`);
    if (tier.class !== className) errors.push(`tier ${name} class must be ${className}`);
    if (className === 'IntervalTier') {
      tierReports.push(validateIntervalTier(tier, document.xmax, errors));
    } else {
      validateTransitions(tier, document.xmax, errors, transitionStatuses);
    }
  });
  validateOverlapReciprocity(document, errors);
  return {
    valid: errors.length === 0,
    errors,
    warnings,
    duration: round(document.xmax),
    tier_reports: tierReports,
  };
}

function validateIntervalTier(tier, duration, errors) {
  const intervals = Array.isArray(tier.intervals) ? tier.intervals : [];
  let cursor = 0;
  let maxGap = 0;
  let maxOverlap = 0;
  const vocabulary = [];
  if (intervals.length === 0) errors.push(`${tier.name} has no intervals`);
  for (const [index, interval] of intervals.entries()) {
    if (!(interval.end > interval.start + EPSILON)) errors.push(`${tier.name}[${index}] has non-positive duration`);
    const delta = interval.start - cursor;
    if (delta > EPSILON) {
      maxGap = Math.max(maxGap, delta);
      errors.push(`${tier.name}[${index}] starts after previous interval`);
    }
    if (delta < -EPSILON) {
      maxOverlap = Math.max(maxOverlap, -delta);
      errors.push(`${tier.name}[${index}] overlaps previous interval`);
    }
    cursor = interval.end;
    vocabulary.push(String(interval.text ?? ''));
    validateVocabulary(tier.name, String(interval.text ?? ''), errors, index);
  }
  if (intervals.length > 0 && Math.abs(intervals[0].start) > EPSILON) errors.push(`${tier.name} does not start at zero`);
  if (Math.abs(cursor - duration) > EPSILON) errors.push(`${tier.name} does not end at task duration`);
  return {
    name: tier.name,
    class: tier.class,
    interval_count: intervals.length,
    starts_at_zero: intervals.length > 0 && Math.abs(intervals[0].start) <= EPSILON,
    ends_at_duration: Math.abs(cursor - duration) <= EPSILON,
    max_gap_sec: round(maxGap),
    max_overlap_sec: round(maxOverlap),
    vocabulary: sortedUnique(vocabulary),
  };
}

function validateVocabulary(tierName, text, errors, index) {
  if (SPEAKERS.includes(tierName) && !SPEAKER_LABELS.includes(text)) {
    errors.push(`${tierName}[${index}] has invalid nine-label value ${text}`);
  }
  if (tierName === 'floor' && !FLOOR_LABELS.includes(text)) {
    errors.push(`floor[${index}] has invalid holder ${text}`);
  }
  if (tierName === 'flags' && text) {
    const codes = text.split('|');
    if (codes.some((code) => !code)) errors.push(`flags[${index}] contains an empty flag code`);
    if (codes.join('|') !== sortedUnique(codes).join('|')) errors.push(`flags[${index}] is not sorted and unique`);
  }
}

function validateTransitions(tier, duration, errors, transitionStatuses) {
  const statusPattern = transitionStatuses.map(escapeRegex).join('|');
  const signedStatuses = transitionStatuses.filter((status) =>
    status !== 'overlap_present_offset_not_measured'
    && status !== 'subthreshold_overlap_present_offset_not_measured');
  const signedPattern = signedStatuses.length
    ? new RegExp(`^S[123]>S[123] FTO=[+-]\\d+\\.\\d{3} status=(${signedStatuses.map(escapeRegex).join('|')})$`)
    : /$a/;
  const missingQualifiedPattern = /^S[123]>S[123] FTO=NA overlap=qualified status=overlap_present_offset_not_measured$/;
  const missingSubthresholdPattern = /^S[123]>S[123] FTO=NA overlap=subthreshold status=subthreshold_overlap_present_offset_not_measured$/;
  const points = Array.isArray(tier.points) ? tier.points : [];
  let previous = -Infinity;
  for (const [index, point] of points.entries()) {
    if (point.number < -EPSILON || point.number > duration + EPSILON) errors.push(`transitions[${index}] is outside task duration`);
    if (point.number < previous - EPSILON) errors.push(`transitions[${index}] is not sorted`);
    const mark = String(point.mark ?? '');
    const status = mark.match(/ status=([^ ]+)$/)?.[1] || '';
    const permitted = new RegExp(`^(${statusPattern})$`).test(status);
    if (!permitted || (!signedPattern.test(mark) && !missingQualifiedPattern.test(mark) && !missingSubthresholdPattern.test(mark))) {
      errors.push(`transitions[${index}] has invalid mark format`);
    }
    previous = point.number;
  }
}

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function validateOverlapReciprocity(document, errors) {
  const speakerTiers = document.tiers.slice(0, 3);
  if (speakerTiers.some((tier) => !tier || !Array.isArray(tier.intervals))) return;
  const boundaries = sortedUnique(
    speakerTiers.flatMap((tier) => tier.intervals.flatMap((interval) => [interval.start, interval.end])),
  ).map(Number).sort((left, right) => left - right);
  for (let index = 0; index < boundaries.length - 1; index += 1) {
    const start = boundaries[index];
    const end = boundaries[index + 1];
    if (!(end > start + EPSILON)) continue;
    const mid = (start + end) / 2;
    const overlapSpeakers = speakerTiers.filter((tier) => intervalAt(tier.intervals, mid)?.text === 'ol');
    if (overlapSpeakers.length === 1) errors.push(`ol is not reciprocal at ${start.toFixed(3)}-${end.toFixed(3)}`);
  }
}

function intervalAt(intervals, time) {
  return intervals.find((interval) => interval.start <= time + EPSILON && time < interval.end - EPSILON)
    || intervals[intervals.length - 1];
}
