// Script 2 (segment durations) — runs the real calculate_segment_durations.praat when Praat is
// available, otherwise a parity-tested CLI equivalent (durations.mjs), EXPLICITLY labelled.
import { runScript2 } from './praat.mjs';
import { parseTextGrid } from './textgrid.mjs';
import { findTier, segmentsFromTier, parseScript2, summarize } from './durations.mjs';
import { readText } from './fsutil.mjs';

export function segmentDurations(textgrid, outTxt, { praatOk }) {
  if (praatOk) {
    const r = runScript2(textgrid, outTxt);
    if (r.ok) {
      const segments = parseScript2(r.text);
      return { method: 'praat', script: 'calculate_segment_durations.praat', command: r.command, segments, summary: summarize(segments) };
    }
  }
  // parity-tested CLI equivalent (verified to match the Praat macro to < 1e-12 s)
  const segments = segmentsFromTier(findTier(parseTextGrid(readText(textgrid)), 'silences'));
  return {
    method: 'cli_equivalent',
    script: 'durations.mjs (parity-tested equivalent of calculate_segment_durations.praat)',
    command: null,
    segments,
    summary: summarize(segments),
  };
}
