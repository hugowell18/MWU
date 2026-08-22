#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { compareFloorHandoffs, compareSixTierDocuments } from '../multilogue-v2/calibration/metrics.mjs';
import { parseSixTierTextGridFile } from '../multilogue-v2/io/parse-six-tier-textgrid.mjs';

function parseArgs(argv) {
  const options = {};
  const fields = new Map([
    ['--candidate', 'candidate'],
    ['--gold', 'gold'],
    ['--baseline', 'baseline'],
    ['--out', 'out'],
  ]);
  for (let index = 2; index < argv.length; index += 1) {
    const field = fields.get(argv[index]);
    if (!field || !argv[index + 1]) throw new Error(`unknown or incomplete argument: ${argv[index]}`);
    options[field] = path.resolve(argv[index + 1]);
    index += 1;
  }
  for (const name of ['candidate', 'gold', 'baseline', 'out']) if (!options[name]) throw new Error(`${name} is required`);
  return options;
}

function compact(predicted, reference) {
  const metrics = compareSixTierDocuments(predicted, reference);
  const handoffs = compareFloorHandoffs(predicted, reference);
  return {
    output_activity_score: metrics.output_activity_score,
    active_speaker_set_exact: metrics.active_speaker_set.exact_accuracy,
    active_speaker_set_jaccard: metrics.active_speaker_set.time_weighted_jaccard,
    room_activity_f1: metrics.room_activity.f1,
    room_activity_accuracy: metrics.room_activity.accuracy,
    nine_label_exact_accuracy: metrics.label_agreement.exact_accuracy,
    nine_label_macro_f1_observed: metrics.label_agreement.macro_f1_observed_gold_labels,
    floor_accuracy: metrics.floor.exact_accuracy,
    floor_boundary_f1_100ms: metrics.floor.boundaries['0.100'].f1,
    transition_precision: metrics.transition_events.precision,
    transition_recall: metrics.transition_events.recall,
    transition_f1: metrics.transition_events.f1,
    transition_false_positive: metrics.transition_events.predicted - metrics.transition_events.matched,
    transition_false_negative: metrics.transition_events.gold - metrics.transition_events.matched,
    floor_handoff_precision_100ms: handoffs.precision,
    floor_handoff_recall_100ms: handoffs.recall,
    floor_handoff_f1_100ms: handoffs.f1,
  };
}

function delta(left, right) {
  return Object.fromEntries(Object.keys(left).map((key) => [key, Number((Number(left[key]) - Number(right[key])).toFixed(6))]));
}

export function compareToReference({ candidate, gold, baseline, out }) {
  for (const file of [candidate, gold, baseline]) if (!fs.existsSync(file)) throw new Error(`comparison input is missing: ${file}`);
  const candidateDocument = parseSixTierTextGridFile(candidate);
  const goldDocument = parseSixTierTextGridFile(gold);
  const baselineDocument = parseSixTierTextGridFile(baseline);
  const candidateGold = compact(candidateDocument, goldDocument);
  const baselineGold = compact(baselineDocument, goldDocument);
  const candidateBaseline = compact(candidateDocument, baselineDocument);
  const report = {
    schema_version: 'mwu-l1b-reference-comparison-v1',
    generated_at: new Date().toISOString(),
    evidence_boundary: 'Gold and baseline are used only by this post-generation validator.',
    inputs: { candidate, gold, baseline },
    candidate_vs_gold: candidateGold,
    baseline_vs_gold: baselineGold,
    candidate_delta_vs_baseline_on_gold: delta(candidateGold, baselineGold),
    candidate_vs_baseline: candidateBaseline,
  };
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  return report;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const options = parseArgs(process.argv);
    const report = compareToReference(options);
    process.stdout.write(`${JSON.stringify({ ok: true, out: options.out, candidate_vs_gold: report.candidate_vs_gold }, null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`${error.stack || error.message}\n`);
    process.exitCode = 1;
  }
}
