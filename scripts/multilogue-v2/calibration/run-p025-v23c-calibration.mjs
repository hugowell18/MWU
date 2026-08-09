#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { scoreTextGrid } from './v23c-scorer.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const RECORDING_ID = 'Multilogue04_C_Level30_D1G4';
const GENERATOR = path.join(ROOT, 'scripts', 'multilogue-v2', 'calibration', 'v23c-generator.mjs');
const SCORER = path.join(ROOT, 'scripts', 'multilogue-v2', 'calibration', 'v23c-scorer.mjs');
const GOLD = path.join(ROOT, 'outputs', 'multilogue-v2-poc', `${RECORDING_ID}_P025_corrected_6tier.TextGrid`);
const CONTROL = path.join(ROOT, 'outputs', 'multilogue-v2-calibration', RECORDING_ID, 'P025', 'v2.3-gate-b078af791adc62f9', 'best-candidate', `${RECORDING_ID}.P025.v2.3-calibrated-draft.6tier.TextGrid`);
const V22 = path.join(ROOT, 'outputs', 'multilogue-v2-calibration', RECORDING_ID, 'P025', 'v2.2-gate-final-e244e79529aaed20', 'best-candidate', `${RECORDING_ID}.P025.v2.2-calibrated-draft.6tier.TextGrid`);
const CONTROL_SHA = 'f0363834c4620ba10ac5b33632366ac25bb995a2b4cc1cf96cb3203c48589f76';
const CONTROL_METRICS = Object.freeze({
  active_set_exact_accuracy: 0.854857,
  boundary_f1_100ms: 0.728302,
  floor_accuracy: 0.976653,
  transition_matched: 13,
  tier5_handoff_matched_100ms: 13,
  macro_f1_observed_labels: 0.644141,
  f_f1: 0.254642,
  bc_f1: 0.251555,
});
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

export function runV23cCalibration({ outputDir, goldFile = GOLD } = {}) {
  const resolvedOutput = outputDir || defaultOutputDir();
  if (existsSync(resolvedOutput)) throw new Error(`v2.3c output already exists: ${resolvedOutput}`);
  mkdirSync(path.join(resolvedOutput, 'scores'), { recursive: true });

  const control = verifyFrozenControl(goldFile);
  const v22 = scoreTextGrid(V22, goldFile);
  writeJson(path.join(resolvedOutput, 'control-check.json'), control);
  writeJson(path.join(resolvedOutput, 'v2.2-reference-metrics.json'), v22);

  let selectedTextGrid = null;
  let selectedConfig = null;
  let selectedCandidateDir = null;
  let selectedId = null;
  let frozenConfigFile = null;
  let goldSchemaConsistency = null;
  const stageWinners = [];

  for (const stage of ['A', 'B', 'C', 'D']) {
    const stageDir = path.join(resolvedOutput, `stage-${stage}`);
    const generatorArgs = [GENERATOR, '--stage', stage, '--output-dir', stageDir];
    if (frozenConfigFile) generatorArgs.push('--frozen-config', frozenConfigFile);
    const generated = parseChildJson(runChild(generatorArgs, `Stage ${stage} generator`).stdout);
    const scoreFile = path.join(resolvedOutput, 'scores', `stage-${stage}.json`);
    const scorerArgs = [
      SCORER, '--stage', stage, '--candidate-root', stageDir,
      '--expected-index-sha256', generated.candidate_index_sha256,
      '--gold', goldFile, '--output', scoreFile,
    ];
    if (selectedTextGrid) scorerArgs.push('--baseline-textgrid', selectedTextGrid, '--baseline-id', selectedId);
    runChild(scorerArgs, `Stage ${stage} scorer`);
    const scored = readJson(scoreFile);
    goldSchemaConsistency = scored.gold_schema_consistency;
    if (!scored.prior_winner_retained) {
      selectedCandidateDir = scored.winner.candidate_dir;
      selectedConfig = scored.winner.config;
      selectedId = scored.winner.candidate_id;
      selectedTextGrid = textGridInDirectory(selectedCandidateDir);
    }
    stageWinners.push({
      stage,
      candidate_id: selectedId,
      source: scored.prior_winner_retained ? 'retained_prior_stage' : 'stage_candidate',
      metric_ownership: scored.metric_ownership,
      owned_metrics: scored.winner.owned_metrics,
      selection_score: scored.winner.selection_score,
      candidate_index_sha256: generated.candidate_index_sha256,
      real_gold_diagnostics: scored.winner.real_gold_diagnostics,
      hard_acceptance_failures: scored.winner.hard_acceptance_failures,
      config: selectedConfig,
    });
    frozenConfigFile = path.join(resolvedOutput, `frozen-after-${stage}.json`);
    writeJson(frozenConfigFile, selectedConfig);
  }

  const selectedMetrics = scoreTextGrid(selectedTextGrid, goldFile);
  const gate = formalGate(selectedMetrics);
  const selectedDir = path.join(resolvedOutput, 'selected-candidate');
  mkdirSync(selectedDir, { recursive: true });
  for (const name of readdirSync(selectedCandidateDir)) copyFileSync(path.join(selectedCandidateDir, name), path.join(selectedDir, name));
  const selectedEvidence = readJson(path.join(selectedCandidateDir, 'runtime-evidence.json'));
  const result = {
    contract_version: 'v23c-calibration-final-gate-v1',
    status: gate.pass ? 'V23C_FORMAL_GATE_PASS' : 'V23C_FORMAL_GATE_FAIL',
    calibration_status: 'customer_gold_calibration_only_not_holdout_validation',
    formal_gate: gate,
    selected_metrics: selectedMetrics,
    comparison: {
      v2_2: compareMetrics(selectedMetrics, v22),
      frozen_first_v2_3_control: compareMetrics(selectedMetrics, control.metrics),
    },
    control_check: control,
    stage_winners: stageWinners,
    total_candidates: 33,
    stage_candidate_counts: { control: 1, A: 8, B: 8, C: 8, D: 8 },
    evidence_coverage: {
      speaker_acoustic: summarizeSpeakerSupport(selectedEvidence.speaker_acoustic_support),
      pre_floor_backchannels: selectedEvidence.pre_floor_backchannels || [],
      pre_floor_response_acknowledgements: selectedEvidence.pre_floor_response_acknowledgements || [],
      acoustic_response_boundary_candidates: selectedEvidence.acoustic_response_boundary_candidates || [],
      acoustic_response_boundary_confirmations: selectedEvidence.acoustic_response_boundary_confirmations || [],
      terminal_administrative_cues: selectedEvidence.terminal_administrative_cues || [],
      speaker_attribution_disagreements: selectedEvidence.speaker_attribution_disagreements || [],
      filler_pass: selectedEvidence.filler_pass || null,
    },
    customer_edge_case_diagnostics: stageWinners.at(-1).real_gold_diagnostics,
    gold_schema_consistency: goldSchemaConsistency,
    safeguards: {
      generator_and_scorer_separate_processes: true,
      generator_received_gold: false,
      candidate_set_index_verified_before_scoring: true,
      no_room_mix_boundary_crossing: true,
      speaker_support_clipped_to_provider_turns: true,
      residuals_never_floor_eligible: true,
      overlap_requires_provider_evidence: true,
      network_used: false,
      formal_poc_artifacts_written: false,
      gold_hardcoded_runtime_rules: false,
    },
    selected_candidate: {
      candidate_id: selectedId,
      source_directory: relative(selectedCandidateDir),
      packaged_directory: relative(selectedDir),
      textgrid: relative(path.join(selectedDir, path.basename(selectedTextGrid))),
      textgrid_sha256: fileRecord(selectedTextGrid).sha256,
    },
  };
  writeJson(path.join(resolvedOutput, 'before-after.json'), {
    metrics: result.comparison,
    control: control.metrics,
    v2_2: v22,
    v2_3c: selectedMetrics,
  });
  writeJson(path.join(resolvedOutput, 'formal-gate.json'), result);
  writeFileSync(path.join(resolvedOutput, 'calibration-report.md'), buildReport(result), 'utf8');
  return { outputDir: resolvedOutput, result };
}

function verifyFrozenControl(goldFile) {
  const sha = fileRecord(CONTROL).sha256;
  if (sha !== CONTROL_SHA) throw new Error(`frozen first-v2.3 control hash mismatch: ${sha}`);
  const actual = scoreTextGrid(CONTROL, goldFile);
  for (const [key, expected] of Object.entries(CONTROL_METRICS)) {
    if (Math.abs(Number(actual[key]) - expected) > 0.000001) {
      throw new Error(`frozen control metric mismatch ${key}: ${actual[key]} != ${expected}`);
    }
  }
  return { pass: true, textgrid_sha256: sha, metrics: actual, expected_metrics: CONTROL_METRICS };
}

function formalGate(metrics) {
  const results = Object.fromEntries(Object.entries(TARGETS).map(([key, target]) => [key, {
    target,
    actual: Number(metrics[key]),
    met: Number(metrics[key]) >= target,
  }]));
  const passed = Object.values(results).filter((item) => item.met).length;
  return { pass: passed === 8, passed_kpi_count: passed, required_kpi_count: 8, results };
}

function compareMetrics(selected, reference) {
  return Object.fromEntries(Object.keys(TARGETS).map((key) => [key, {
    reference: Number(reference[key]),
    selected: Number(selected[key]),
    delta: Number((Number(selected[key]) - Number(reference[key])).toFixed(6)),
  }]));
}

function summarizeSpeakerSupport(support) {
  return {
    contract_version: support.contract_version,
    source_separation_claim: support.source_separation_claim,
    usage_boundary: support.usage_boundary,
    by_speaker: Object.fromEntries(Object.entries(support.by_speaker).map(([speaker, intervals]) => [speaker, {
      interval_count: intervals.length,
      sounding_seconds: Number(intervals.reduce((sum, item) => sum + item.end - item.start, 0).toFixed(6)),
    }])),
  };
}

function buildReport(result) {
  const rows = Object.entries(result.formal_gate.results).map(([key, value]) =>
    `| ${key} | ${value.target} | ${value.actual} | ${value.met ? 'PASS' : 'FAIL'} |`);
  const goldConsistency = result.gold_schema_consistency;
  const goldWarning = goldConsistency && goldConsistency.consistent === false
    ? [
      '## Gold Schema Warning',
      '',
      `The corrected Gold contains ${goldConsistency.gold_tier5_point_count} Tier 5 transition points, while its corrected floor tier yields ${goldConsistency.floor_derived_handoff_count} handoffs. These sources are internally inconsistent.`,
      '',
      `Scoring truth remains \`${goldConsistency.runtime_truth_source}\`; unmatched Gold Tier 5 points are diagnostic only and are never used as runtime or generator truth.`,
      '',
      `Unmatched Tier 5 point times: ${goldConsistency.stale_tier5_points.map((item) => item.number).join(', ')}.`,
      '',
    ]
    : [];
  return [
    '# Multilogue04 v2.3c Calibration',
    '',
    `**${result.status}: ${result.formal_gate.passed_kpi_count}/8 KPIs passed.**`,
    '',
    '| KPI | Target | Actual | Result |',
    '|---|---:|---:|---|',
    ...rows,
    '',
    'This run evaluated one frozen control plus 32 bounded staged candidates. Gold was available only to scorer processes.',
    '',
    `Selected candidate: \`${result.selected_candidate.candidate_id}\``,
    '',
    `Transition diagnostics: predicted ${result.customer_edge_case_diagnostics.transitions.predicted}, matched ${result.customer_edge_case_diagnostics.transitions.matched}, false-positive ${result.customer_edge_case_diagnostics.transitions.false_positive}.`,
    '',
    ...goldWarning,
  ].join('\n');
}

function runChild(args, label) {
  const result = spawnSync(process.execPath, args, {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...process.env, MWU_NETWORK_DISABLED: '1' },
    maxBuffer: 100 * 1024 * 1024,
  });
  if (result.status !== 0) throw new Error(`${label} failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  return result;
}

function parseChildJson(stdout) {
  const lines = String(stdout || '').trim().split(/\r?\n/).filter(Boolean);
  if (!lines.length) throw new Error('child returned no JSON');
  return JSON.parse(lines.at(-1));
}

function defaultOutputDir() {
  const digest = createHash('sha256').update([
    fileRecord(CONTROL).sha256,
    fileRecord(GOLD).sha256,
    fileRecord(GENERATOR).sha256,
    fileRecord(SCORER).sha256,
  ].join('|')).digest('hex').slice(0, 12);
  return path.join(ROOT, 'outputs', 'multilogue-v2-calibration', RECORDING_ID, 'P025', `v2.3c-${digest}`);
}

function textGridInDirectory(directory) {
  const name = readdirSync(directory).find((item) => item.endsWith('.TextGrid'));
  if (!name) throw new Error(`candidate TextGrid missing: ${directory}`);
  return path.join(directory, name);
}

function relative(file) {
  return path.relative(ROOT, file).replaceAll(path.sep, '/');
}

function fileRecord(file) {
  const bytes = readFileSync(file);
  return { sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length };
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
    else throw new Error(`unknown v2.3c runner argument: ${key}`);
    index += 1;
  }
  return options;
}

function main() {
  const run = runV23cCalibration(parseArgs(process.argv));
  process.stdout.write(`${JSON.stringify({
    status: run.result.status,
    output_directory: relative(run.outputDir),
    formal_gate: run.result.formal_gate,
    metrics: run.result.selected_metrics,
    selected_candidate: run.result.selected_candidate,
  }, null, 2)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) main();
