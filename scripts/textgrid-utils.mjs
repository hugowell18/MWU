export function unquoteTextGridString(value) {
  return String(value ?? "").replaceAll('""', '"');
}

export function parseTextGrid(text) {
  const tiers = [];
  let currentTier = null;
  let currentInterval = null;
  let currentPoint = null;

  for (const line of text.split(/\r?\n/)) {
    if (/^\s*item \[\d+\]:\s*$/.test(line)) {
      currentTier = { name: "", class: "", intervals: [], points: [] };
      currentInterval = null;
      currentPoint = null;
      tiers.push(currentTier);
      continue;
    }

    if (!currentTier) continue;

    const classMatch = line.match(/^\s*class = "(.*)"\s*$/);
    if (classMatch && !currentInterval && !currentPoint) {
      currentTier.class = unquoteTextGridString(classMatch[1]);
      continue;
    }

    const nameMatch = line.match(/^\s*name = "(.*)"\s*$/);
    if (nameMatch && !currentInterval && !currentPoint) {
      currentTier.name = unquoteTextGridString(nameMatch[1]);
      continue;
    }

    if (/^\s*intervals \[\d+\]:\s*$/.test(line)) {
      currentInterval = { start: Number.NaN, end: Number.NaN, text: "" };
      currentPoint = null;
      currentTier.intervals.push(currentInterval);
      continue;
    }

    if (/^\s*points \[\d+\]:\s*$/.test(line)) {
      currentPoint = { number: Number.NaN, mark: "" };
      currentInterval = null;
      currentTier.points.push(currentPoint);
      continue;
    }

    if (currentPoint) {
      const numberMatch = line.match(/^\s*number = ([^\s]+)\s*$/);
      if (numberMatch) {
        currentPoint.number = Number(numberMatch[1]);
        continue;
      }
      const markMatch = line.match(/^\s*mark = "(.*)"\s*$/);
      if (markMatch) {
        currentPoint.mark = unquoteTextGridString(markMatch[1]);
      }
      continue;
    }

    if (!currentInterval) continue;

    const xminMatch = line.match(/^\s*xmin = ([^\s]+)\s*$/);
    if (xminMatch) {
      currentInterval.start = Number(xminMatch[1]);
      continue;
    }

    const xmaxMatch = line.match(/^\s*xmax = ([^\s]+)\s*$/);
    if (xmaxMatch) {
      currentInterval.end = Number(xmaxMatch[1]);
      continue;
    }

    const textMatch = line.match(/^\s*text = "(.*)"\s*$/);
    if (textMatch) {
      currentInterval.text = unquoteTextGridString(textMatch[1]);
    }
  }

  for (const tier of tiers) {
    tier.intervals = tier.intervals.filter((interval) => {
      return Number.isFinite(interval.start) && Number.isFinite(interval.end) && interval.end > interval.start;
    });
    tier.points = tier.points.filter((point) => Number.isFinite(point.number));
  }

  return tiers.filter((tier) => tier.name);
}

export function getTier(tiers, name) {
  const tier = tiers.find((candidate) => candidate.name === name);
  if (!tier) throw new Error(`Missing required TextGrid tier: ${name}`);
  return tier;
}

export function getOptionalTier(tiers, name) {
  return tiers.find((candidate) => candidate.name === name) ?? null;
}

export function overlapSeconds(a, b) {
  return Math.max(0, Math.min(a.end, b.end) - Math.max(a.start, b.start));
}

export function intervalAtMidpoint(intervals, start, end) {
  const midpoint = (start + end) / 2;
  return intervals.find((interval) => interval.start <= midpoint && midpoint <= interval.end) ?? null;
}

export function bestOverlappingInterval(intervals, target, options = {}) {
  const minOverlapSeconds = options.minOverlapSeconds ?? 0;
  let best = null;
  let bestOverlap = 0;

  for (const interval of intervals) {
    const overlap = overlapSeconds(interval, target);
    if (overlap > bestOverlap) {
      best = interval;
      bestOverlap = overlap;
    }
  }

  if (best && bestOverlap > minOverlapSeconds) {
    return { interval: best, overlap: bestOverlap };
  }

  const midpointMatch = intervalAtMidpoint(intervals, target.start, target.end);
  return midpointMatch ? { interval: midpointMatch, overlap: 0 } : { interval: null, overlap: 0 };
}

export function round(value, digits = 6) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}
