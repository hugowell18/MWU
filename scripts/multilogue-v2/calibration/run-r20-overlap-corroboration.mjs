#!/usr/bin/env node

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { generateV23cStage } from './v23c-generator.mjs';
import { scoreV23cStage } from './v23c-scorer.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const RECORDING_ID = 'Multilogue04_C_Level30_D1G4';
const CALIBRATION_ROOT = path.join(ROOT, 'outputs', 'multilogue-v2-calibration', RECORDING_ID, 'P025');
const DEFAULT_OUTPUT = path.join(CALIBRATION_ROOT, 'v2.3o-r20-overlap-corroboration-20260809');
const R10_ROOT = path.join(CALIBRATION_ROOT, 'v2.3e-r10-evidence-contract-final-20260809');
const GOLD = path.join(ROOT, 'outputs', 'multilogue-v2-poc', `${RECORDING_ID}_P025_corrected_6tier.TextGrid`);

export function runR20OverlapCorroboration({
  outputDir = DEFAULT_OUTPUT,
  maximumSeconds = 0.6,
  minimumCoverageRatio = 0.8,
  stage = 'D',
} = {}) {
  if (existsSync(outputDir)) throw new Error(`R20 output already exists: ${outputDir}`);
  const frozen = JSON.parse(readFileSync(path.join(R10_ROOT, 'frozen-after-D.json'), 'utf8'));
  frozen.adapter.overlapCorroboratedResidualIdentity = true;
  frozen.adapter.overlapCorroboratedResidualMaxSeconds = Number(maximumSeconds);
  frozen.adapter.overlapCorroboratedMinimumCoverageRatio = Number(minimumCoverageRatio);

  const candidateRoot = path.join(outputDir, `stage-${stage}`);
  const generated = generateV23cStage({
    stage,
    outputDir: candidateRoot,
    frozenConfig: frozen,
  });
  const baselineTextGrid = findTextGrid(path.join(R10_ROOT, 'selected-candidate'));
  mkdirSync(outputDir, { recursive: true });
  const scoreFile = path.join(outputDir, 'score.json');
  const score = scoreV23cStage({
    stage,
    candidateRoot,
    goldFile: GOLD,
    outputFile: scoreFile,
    expectedIndexSha256: generated.candidateIndexSha256,
    baselineTextGrid,
    baselineId: 'r10-frozen-control',
  });
  const report = {
    contract_version: 'r20-overlap-corroboration-report-v1',
    runtime_gold_access: false,
    generation_network_used: false,
    gold_usage: 'scorer_only',
    change: 'retain identity-tied residual only when qualified provider overlap corroborates the residual speaker',
    safety_boundary: 'retained residual remains floor-ineligible and review-flagged',
    overlap_corroboration_parameters: {
      maximum_seconds: Number(maximumSeconds),
      minimum_coverage_ratio: Number(minimumCoverageRatio),
    },
    calibration_stage: stage,
    baseline: compact(score.baseline),
    winner: compact(score.winner),
    delta: metricDelta(score.winner.metrics, score.baseline.metrics),
    promoted: score.winner.source === 'candidate',
  };
  writeFileSync(path.join(outputDir, 'r20-report.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  return { outputDir, score, report };
}

function compact(row) {
  return {
    candidate_id: row.candidate_id,
    source: row.source,
    config: row.config,
    metrics: row.metrics,
  };
}

function metricDelta(after, before) {
  return Object.fromEntries(Object.keys(after).filter((key) => Number.isFinite(Number(after[key]))
    && Number.isFinite(Number(before[key]))).map((key) => [key, Number((Number(after[key]) - Number(before[key])).toFixed(9))]));
}

function findTextGrid(dir) {
  const name = readdirSync(dir).find((item) => item.endsWith('.TextGrid'));
  if (!name) throw new Error(`TextGrid missing in ${dir}`);
  return path.join(dir, name);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const args = Object.fromEntries(process.argv.slice(2).reduce((rows, value, index, all) => {
    if (value.startsWith('--')) rows.push([value, all[index + 1]]);
    return rows;
  }, []));
  const outputDir = args['--output-dir'] ? path.resolve(args['--output-dir']) : DEFAULT_OUTPUT;
  const result = runR20OverlapCorroboration({
    outputDir,
    maximumSeconds: Number(args['--max-seconds'] ?? 0.6),
    minimumCoverageRatio: Number(args['--coverage'] ?? 0.8),
    stage: String(args['--stage'] ?? 'D'),
  });
  process.stdout.write(`${JSON.stringify({
    output_dir: result.outputDir,
    promoted: result.report.promoted,
    baseline_bc_f1: result.report.baseline.metrics.bc_f1,
    winner_bc_f1: result.report.winner.metrics.bc_f1,
    floor_accuracy: result.report.winner.metrics.floor_accuracy,
    transition_precision: result.report.winner.metrics.transition_precision,
  })}\n`);
}
