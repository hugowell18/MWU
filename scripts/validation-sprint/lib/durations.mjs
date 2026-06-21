// Script 2 core: segment durations + aggregates from a parsed TextGrid tier.
// NO re-filtering: every interval labelled `silent` is counted, including sub-0.25s ones.

export function findTier(grid, name = 'silences') {
  return grid.tiers.find((t) => t.name === name) || grid.tiers[0];
}

export function segmentDurations(tier) {
  return tier.intervals.map((iv) => ({
    label: iv.text,
    start: iv.xmin,
    end: iv.xmax,
    duration: iv.xmax - iv.xmin,
  }));
}

export function aggregate(tier, { soundingLabel = 'sounding', silentLabel = 'silent' } = {}) {
  const segments = segmentDurations(tier);
  const sounding = segments.filter((s) => s.label === soundingLabel);
  const silent = segments.filter((s) => s.label === silentLabel);
  const sum = (a) => a.reduce((x, s) => x + s.duration, 0);
  const total_sounding = sum(sounding);
  const total_silent = sum(silent);
  const silDur = silent.map((s) => s.duration);
  return {
    total_duration: tier.xmax - tier.xmin,
    interval_count: tier.intervals.length,
    sounding_count: sounding.length,
    silent_count: silent.length,
    total_sounding,
    total_silent,
    mean_silent: silent.length ? total_silent / silent.length : 0,
    max_silent: silDur.length ? Math.max(...silDur) : 0,
    min_silent: silDur.length ? Math.min(...silDur) : 0,
    segments,
  };
}

// silent intervals at/above a pause threshold (used for generated drafts / matrix density)
export function pausesAtThreshold(agg, t) {
  return agg.segments.filter((s) => s.label === 'silent' && s.duration >= t);
}

// articulation rate as the workbook computes it: syllables / speaking-minutes
export function articulationRate(syllables, speakingTimeSec) {
  return syllables / (speakingTimeSec / 60);
}

// ---- Script 2 (segment durations) parity layer ----
// segments from a parsed TextGrid tier (JS / CLI-equivalent path)
export function segmentsFromTier(tier) {
  return tier.intervals
    .filter((iv) => iv.text !== '')
    .map((iv) => ({ label: iv.text, start: iv.xmin, end: iv.xmax, duration: iv.xmax - iv.xmin }));
}

// parse calculate_segment_durations.praat output: `label \t duration \t start \t end`
export function parseScript2(text) {
  return text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => {
      const [label, d, s, e] = l.split('\t');
      return { label, duration: Number(d), start: Number(s), end: Number(e) };
    });
}

// unified summary over Script-2 segments — includes sounding/silent/INVALID, pause values, ranges.
export function summarize(segments, { soundingLabel = 'sounding', silentLabel = 'silent', invalidLabel = 'invalid' } = {}) {
  const sum = (a) => a.reduce((x, s) => x + s.duration, 0);
  const sounding = segments.filter((s) => s.label === soundingLabel);
  const silent = segments.filter((s) => s.label === silentLabel);
  const invalid = segments.filter((s) => s.label === invalidLabel);
  const silDur = silent.map((s) => s.duration);
  const total_sounding = sum(sounding);
  const total_silent = sum(silent);
  const total_invalid = sum(invalid);
  return {
    total_duration: total_sounding + total_silent + total_invalid,
    interval_count: segments.length,
    sounding_count: sounding.length,
    silent_count: silent.length,
    invalid_count: invalid.length,
    total_sounding,
    total_silent,
    total_invalid,
    mean_silent: silent.length ? total_silent / silent.length : 0,
    max_silent: silDur.length ? Math.max(...silDur) : 0,
    min_silent: silDur.length ? Math.min(...silDur) : 0,
    pause_values: silDur, // individual pause values (email: "single pause values")
    sounding_ranges: sounding.map((s) => ({ start: s.start, end: s.end })), // sounding timestamps
    segments,
  };
}
