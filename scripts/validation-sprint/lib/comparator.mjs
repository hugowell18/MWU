// Compare gold-replay computed values against the workbook baseline, with tolerances.
import { articulationRate } from './durations.mjs';

export function compare(computed, baseline, tol) {
  const rows = [];
  const durRow = (metric, ours, gold) => ({
    metric,
    ours,
    gold,
    delta: Math.abs(ours - gold),
    tolerance: `<= ${tol.duration}`,
    pass: Math.abs(ours - gold) <= tol.duration,
  });

  // exact count
  rows.push({
    metric: 'No. of silent pauses',
    ours: computed.silent_count,
    gold: baseline.silent_pauses,
    delta: computed.silent_count - baseline.silent_pauses,
    tolerance: 'exact',
    pass: computed.silent_count === baseline.silent_pauses,
  });

  rows.push(durRow('Total audio duration (s)', computed.total_duration, baseline.total_audio));
  rows.push(durRow('Speaking time (s)', computed.total_sounding, baseline.speaking_time));
  rows.push(durRow('Total silent pausing (s)', computed.total_silent, baseline.total_silent_pausing));
  rows.push(durRow('Mean silent pause (s)', computed.mean_silent, baseline.mean_silent_pause));

  if (baseline.syllables) {
    const ours = articulationRate(baseline.syllables, computed.total_sounding);
    rows.push({
      metric: 'Articulation rate (syll/min)',
      ours,
      gold: baseline.articulation_rate,
      delta: Math.abs(ours - baseline.articulation_rate),
      tolerance: `<= ${tol.articulation}`,
      pass: Math.abs(ours - baseline.articulation_rate) <= tol.articulation,
    });
  }

  const passed = rows.every((r) => r.pass);
  return { status: passed ? 'passed' : 'failed', rows };
}
