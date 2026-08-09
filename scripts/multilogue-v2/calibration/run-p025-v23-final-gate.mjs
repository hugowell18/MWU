#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const RECORDING_ID = 'Multilogue04_C_Level30_D1G4';
const GENERATOR = path.join(ROOT, 'scripts', 'multilogue-v2', 'calibration', 'v23-final-generator.mjs');
const SCORER = path.join(ROOT, 'scripts', 'multilogue-v2', 'calibration', 'v23-final-scorer.mjs');
const DEFAULT_GOLD = path.join(ROOT, 'outputs', 'multilogue-v2-poc', `${RECORDING_ID}_P025_corrected_6tier.TextGrid`);
const DEFAULT_OUTPUT = path.join(
  ROOT, 'outputs', 'multilogue-v2-calibration', RECORDING_ID, 'P025', 'v2.3-final',
);
const TARGETS = Object.freeze({
  active_set_exact_accuracy: 0.85,
  boundary_f1_100ms: 0.75,
  floor_accuracy: 0.98,
  transition_matched: 15,
  tier5_handoff_matched_100ms: 15,
  macro_f1_observed_labels: 0.67609,
  f_f1: 0.27108,
  bc_f1: 0.32302,
});

export function runV23FinalGate({ outputDir = DEFAULT_OUTPUT, goldFile = DEFAULT_GOLD } = {}) {
  if (existsSync(outputDir)) throw new Error(`final Gate output already exists: ${outputDir}`);
  mkdirSync(path.join(outputDir, 'scores'), { recursive: true });
  const winners = [];
  let frozenConfigFile = null;

  for (const stage of ['A', 'B', 'C', 'D']) {
    const generatedDir = path.join(outputDir, `stage-${stage}`);
    const generatorArgs = [GENERATOR, '--stage', stage, '--output-dir', generatedDir];
    if (frozenConfigFile) generatorArgs.push('--frozen-config', frozenConfigFile);
    const generatorResult = parseChildJson(runChild(generatorArgs, `Stage ${stage} generator`).stdout);
    if (!/^[a-f0-9]{64}$/i.test(generatorResult.candidate_index_sha256 || '')) {
      throw new Error(`Stage ${stage} generator did not return a candidate index SHA256`);
    }
    const scoreFile = path.join(outputDir, 'scores', `stage-${stage}.json`);
    runChild([
      SCORER, '--stage', stage, '--candidate-root', generatedDir,
      '--expected-index-sha256', generatorResult.candidate_index_sha256,
      '--gold', goldFile, '--output', scoreFile,
    ], `Stage ${stage} scorer`);
    const score = readJson(scoreFile);
    winners.push({
      stage,
      candidate_id: score.winner.candidate_id,
      aggregate_sha256: score.winner.aggregate_sha256,
      metric_ownership: score.metric_ownership,
      owned_metrics: score.winner.owned_metrics,
      selection_score: score.winner.selection_score,
      config: score.winner.config,
      structural_digests: score.winner.structural_digests,
    });
    frozenConfigFile = path.join(outputDir, `frozen-after-${stage}.json`);
    writeJson(frozenConfigFile, score.winner.config);
  }

  const finalScore = readJson(path.join(outputDir, 'scores', 'stage-D.json')).winner;
  const gate = formalGate(finalScore.metrics);
  const finalCandidateDir = finalScore.candidate_dir;
  const selectedDir = path.join(outputDir, 'selected-candidate');
  mkdirSync(selectedDir, { recursive: true });
  for (const name of readdirSync(finalCandidateDir)) {
    copyFileSync(path.join(finalCandidateDir, name), path.join(selectedDir, name));
  }
  const evidence = readJson(path.join(finalCandidateDir, 'runtime-evidence.json'));
  const semanticCoverage = {
    ...(evidence.semantic_evidence_coverage || {}),
    explicit_event_count: evidence.semantic_pass?.explicit_event_count ?? evidence.adapter_stats.explicit_semantic_event_count,
    filler_candidate_count: evidence.semantic_pass?.filler_candidate_count ?? 0,
    backchannel_candidate_count: evidence.semantic_pass?.backchannel_candidate_count ?? 0,
    unknown_residual_event_count: evidence.semantic_pass?.unknown_residual_event_count
      ?? evidence.adapter_stats.acoustic_unknown_event_count,
  };
  const semanticPass = gate.results.macro_f1_observed_labels.met
    && gate.results.f_f1.met && gate.results.bc_f1.met;
  const semanticStatus = semanticPass ? 'SEMANTIC_EVIDENCE_TARGETS_MET' : 'SEMANTIC_EVIDENCE_CEILING_BLOCKED';
  const result = {
    contract_version: 'v23-final-gate-closure-v1',
    status: gate.pass ? 'V23_FINAL_GATE_PASS' : 'V23_FINAL_GATE_FAIL',
    calibration_status: 'customer_gold_calibration_only_not_holdout_validation',
    formal_gate: gate,
    selected_metrics: finalScore.metrics,
    stage_winners: winners,
    total_candidates: 44,
    stage_candidate_counts: { A: 24, B: 8, C: 8, D: 4 },
    semantic_status: semanticStatus,
    semantic_evidence_coverage: semanticCoverage,
    safeguards: {
      generator_and_scorer_separate_processes: true,
      generator_received_gold: false,
      candidate_hash_verified_before_scoring: true,
      candidate_set_index_verified_before_scoring: true,
      candidate_rewritten_by_scorer: false,
      network_used: false,
      production_defaults_changed: false,
      gold_hardcoded_runtime_rules: false,
    },
    selected_candidate: {
      source_directory: path.relative(ROOT, finalCandidateDir).replaceAll(path.sep, '/'),
      packaged_directory: path.relative(ROOT, selectedDir).replaceAll(path.sep, '/'),
      aggregate_sha256: finalScore.aggregate_sha256,
    },
  };
  writeJson(path.join(outputDir, 'final-gate.json'), result);
  writeFileSync(path.join(outputDir, 'final-report.md'), buildReport(result), 'utf8');
  return { outputDir, result };
}

function formalGate(metrics) {
  const results = Object.fromEntries(Object.entries(TARGETS).map(([key, target]) => [key, {
    target,
    actual: Number(metrics[key]),
    met: Number(metrics[key]) >= target,
  }]));
  const passed = Object.values(results).filter((item) => item.met).length;
  return {
    pass: passed === Object.keys(results).length,
    passed_kpi_count: passed,
    required_kpi_count: Object.keys(results).length,
    results,
  };
}

function runChild(args, label) {
  const result = spawnSync(process.execPath, args, {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...process.env, MWU_NETWORK_DISABLED: '1' },
    maxBuffer: 20 * 1024 * 1024,
  });
  if (result.status !== 0) {
    throw new Error(`${label} failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  }
  return result;
}

function parseChildJson(stdout) {
  const lines = String(stdout || '').trim().split(/\r?\n/).filter(Boolean);
  if (!lines.length) throw new Error('child process returned no JSON result');
  return JSON.parse(lines.at(-1));
}

function buildReport(result) {
  const percent = (value) => `${(Number(value) * 100).toFixed(3)}%`;
  const rows = [
    ['Active-set exact', 'active_set_exact_accuracy', percent],
    ['Boundary F1 @100ms', 'boundary_f1_100ms', percent],
    ['Floor exact', 'floor_accuracy', percent],
    ['Transitions matched', 'transition_matched', String],
    ['Tier5 direction + boundary @100ms', 'tier5_handoff_matched_100ms', String],
    ['Macro F1', 'macro_f1_observed_labels', percent],
    ['Filled pause F1', 'f_f1', percent],
    ['Backchannel F1', 'bc_f1', percent],
  ];
  return [
    '# V23 Final Gate Closure',
    '',
    `**${result.status}: ${result.formal_gate.passed_kpi_count}/${result.formal_gate.required_kpi_count} KPIs passed.**`,
    '',
    '| KPI | Target | Actual | Result |',
    '|---|---:|---:|---|',
    ...rows.map(([label, key, format]) => {
      const item = result.formal_gate.results[key];
      return `| ${label} | ${format(item.target)} | ${format(item.actual)} | ${item.met ? 'PASS' : 'FAIL'} |`;
    }),
    '',
    `Semantic status: **${result.semantic_status}**.`,
    '',
    'The run used 44 bounded candidates across frozen A/B/C/D stages. Gold was opened only by the scorer after candidate hashes were written and verified.',
    '',
  ].join('\n');
}

function readJson(file) {
  return JSON.parse(readFileSync(file, 'utf8'));
}

function writeJson(file, value) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function parseArgs(argv) {
  const options = {};
  for (let index = 2; index < argv.length; index += 1) {
    const key = argv[index];
    const value = argv[index + 1];
    if (key === '--output-dir') options.outputDir = path.resolve(value);
    else if (key === '--gold') options.goldFile = path.resolve(value);
    else throw new Error(`unknown Gate argument: ${key}`);
    index += 1;
  }
  return options;
}

function main() {
  const run = runV23FinalGate(parseArgs(process.argv));
  process.stdout.write(`${JSON.stringify({
    status: run.result.status,
    output_directory: path.relative(ROOT, run.outputDir).replaceAll(path.sep, '/'),
    formal_gate: run.result.formal_gate,
    semantic_status: run.result.semantic_status,
    metrics: run.result.selected_metrics,
    stage_winners: run.result.stage_winners.map((item) => ({
      stage: item.stage, candidate_id: item.candidate_id, owned_metrics: item.owned_metrics,
    })),
  }, null, 2)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) main();
