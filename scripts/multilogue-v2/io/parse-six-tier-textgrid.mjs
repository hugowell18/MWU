import { readFileSync } from 'node:fs';

export function parseSixTierTextGridFile(filePath) {
  return parseSixTierTextGrid(readFileSync(filePath, 'utf8'));
}

export function parseSixTierTextGrid(text) {
  const lines = String(text).split(/\r?\n/);
  const document = { xmin: 0, xmax: null, tiers: [] };
  let tier = null;
  let interval = null;
  let point = null;
  let beforeFirstTier = true;

  for (const line of lines) {
    const tierMatch = line.match(/^\s*item \[(\d+)\]:\s*$/);
    if (tierMatch) {
      beforeFirstTier = false;
      tier = { class: '', name: '', xmin: 0, xmax: null };
      document.tiers.push(tier);
      interval = null;
      point = null;
      continue;
    }
    if (beforeFirstTier) {
      const xmax = line.match(/^xmax = ([^\s]+)\s*$/);
      if (xmax) document.xmax = finiteNumber(xmax[1], 'TextGrid xmax');
      continue;
    }
    if (!tier) continue;
    const classMatch = line.match(/^\s*class = "(.*)"\s*$/);
    if (classMatch) {
      tier.class = unquote(classMatch[1]);
      tier.intervals = tier.class === 'IntervalTier' ? [] : undefined;
      tier.points = tier.class === 'TextTier' ? [] : undefined;
      continue;
    }
    const nameMatch = line.match(/^\s*name = "(.*)"\s*$/);
    if (nameMatch) {
      tier.name = unquote(nameMatch[1]);
      continue;
    }
    const tierXmax = line.match(/^\s*xmax = ([^\s]+)\s*$/);
    if (tierXmax && !interval && !point) {
      tier.xmax = finiteNumber(tierXmax[1], `${tier.name || 'tier'} xmax`);
      continue;
    }
    if (/^\s*intervals \[\d+\]:\s*$/.test(line)) {
      interval = { start: null, end: null, text: '' };
      point = null;
      tier.intervals.push(interval);
      continue;
    }
    if (/^\s*points \[\d+\]:\s*$/.test(line)) {
      point = { number: null, mark: '' };
      interval = null;
      tier.points.push(point);
      continue;
    }
    if (interval) {
      const start = line.match(/^\s*xmin = ([^\s]+)\s*$/);
      const end = line.match(/^\s*xmax = ([^\s]+)\s*$/);
      const value = line.match(/^\s*text = "(.*)"\s*$/);
      if (start) interval.start = finiteNumber(start[1], `${tier.name} interval start`);
      if (end) interval.end = finiteNumber(end[1], `${tier.name} interval end`);
      if (value) interval.text = unquote(value[1]);
      continue;
    }
    if (point) {
      const number = line.match(/^\s*number = ([^\s]+)\s*$/);
      const mark = line.match(/^\s*mark = "(.*)"\s*$/);
      if (number) point.number = finiteNumber(number[1], `${tier.name} point`);
      if (mark) point.mark = unquote(mark[1]);
    }
  }

  if (!(document.xmax > 0)) throw new Error('TextGrid requires a positive xmax');
  for (const item of document.tiers) {
    item.xmin = 0;
    item.xmax = item.xmax ?? document.xmax;
    if (item.class === 'IntervalTier' && item.intervals.some((value) => value.start == null || value.end == null)) {
      throw new Error(`${item.name} contains an incomplete interval`);
    }
    if (item.class === 'TextTier' && item.points.some((value) => value.number == null)) {
      throw new Error(`${item.name} contains an incomplete point`);
    }
  }
  return document;
}

function finiteNumber(value, field) {
  const number = Number(value);
  if (!Number.isFinite(number)) throw new Error(`${field} must be finite`);
  return number;
}

function unquote(value) {
  return String(value).replaceAll('""', '"');
}
