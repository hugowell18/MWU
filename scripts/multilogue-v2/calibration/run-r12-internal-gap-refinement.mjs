#!/usr/bin/env node

import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const RECORDING_ID = 'Multilogue04_C_Level30_D1G4';
const GENERATOR = path.join(ROOT, 'scripts', 'multilogue-v2', 'calibration', 'r12-internal-gap-generator.mjs');
const SCORER = path.join(ROOT, 'scripts', 'multilogue-v2', 'calibration', 'r12-internal-gap-scorer.mjs');
const GOLD = path.join(ROOT, 'outputs', 'multilogue-v2-poc', `${RECORDING_ID}_P025_corrected_6tier.TextGrid`);

export function runR12InternalGapRefinement({ outputDir, goldFile = GOLD } = {}) {
  if (!outputDir) throw new Error('outputDir is required');
  if (existsSync(outputDir)) throw new Error(`R12 output already exists: ${outputDir}`);
  mkdirSync(outputDir, { recursive: true });
  const generated = parseLastJson(runChild([
    GENERATOR, '--output-dir', path.join(outputDir, 'internal-gap-candidates'),
  ], 'R12 generator').stdout);
  const scoreFile = path.join(outputDir, 'internal-gap-score.json');
  runChild([
    SCORER, '--candidate-root', path.join(outputDir, 'internal-gap-candidates'),
    '--expected-index-sha256', generated.candidate_index_sha256,
    '--gold', goldFile, '--output', scoreFile,
  ], 'R12 scorer');
  const score = readJson(scoreFile);
  const selectedDir = path.join(outputDir, 'selected-candidate');
  mkdirSync(selectedDir, { recursive: true });
  for (const name of readdirSync(score.winner.candidate_dir)) {
    copyFileSync(path.join(score.winner.candidate_dir, name), path.join(selectedDir, name));
  }
  const result = {
    contract_version: 'r12-internal-gap-final-v1',
    status: score.formal_gate.pass ? 'R12_FORMAL_GATE_PASS' : 'R12_FORMAL_GATE_FAIL',
    calibration_status: 'customer_gold_calibration_only_not_holdout_validation',
    formal_gate: score.formal_gate,
    control_relative_gate: score.control_relative_gate,
    selected_candidate: {
      candidate_id: score.winner.candidate_id,
      internal_gap_config: score.winner.internal_gap_config,
      internal_gap_stats: score.winner.internal_gap_stats,
      metrics: score.winner.metrics,
      textgrid: readdirSync(selectedDir).find((name) => name.endsWith('.TextGrid')),
    },
    control_metrics: score.control.metrics,
    safeguards: {
      generator_received_gold: false,
      generator_and_scorer_separate_processes: true,
      room_mix_boundary_crossing: false,
      provider_turn_clipping_required: true,
      outer_boundaries_moved: false,
      frozen_r10_semantic_config: true,
      semantic_digest_unchanged: score.winner.semantic_digest_unchanged,
      tier5_consistent: score.winner.tier5_consistent,
      network_used: false,
    },
    recommendation: score.formal_gate.pass
      ? 'R12 may proceed to customer-scenario regression and unseen multilogue validation.'
      : 'Do not promote R12; retain R10 and continue evidence-led refinement.',
  };
  writeFileSync(path.join(outputDir, 'formal-gate.json'), `${JSON.stringify(result, null, 2)}\n`, 'utf8');
  return result;
}

function runChild(args, label) {
  const result = spawnSync(process.execPath, args, {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...process.env, MWU_NETWORK_DISABLED: '1' },
    maxBuffer: 200 * 1024 * 1024,
  });
  if (result.status !== 0) throw new Error(`${label} failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  return result;
}
function parseLastJson(stdout) { return JSON.parse(String(stdout).trim().split(/\r?\n/).filter(Boolean).at(-1)); }
function readJson(file) { return JSON.parse(readFileSync(file, 'utf8')); }
function parseArgs(argv) {
  const options = {};
  for (let index = 2; index < argv.length; index += 2) {
    const key = argv[index]; const value = argv[index + 1];
    if (key === '--output-dir') options.outputDir = path.resolve(value);
    else if (key === '--gold') options.goldFile = path.resolve(value);
    else throw new Error(`unknown R12 runner argument: ${key}`);
  }
  return options;
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const result = runR12InternalGapRefinement(parseArgs(process.argv));
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}
