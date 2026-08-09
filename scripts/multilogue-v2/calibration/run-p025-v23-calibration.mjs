#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  computeLocalAcousticVadFromPrepared,
  defaultVadOptions,
  prepareLocalAcousticVad,
} from '../../local-acoustic-vad.mjs';
import { buildV23Stage1Candidate } from '../adapters/build-v23-stage1-candidate.mjs';
import { runMultilogueV2 } from '../core/pipeline.mjs';
import { parseSixTierTextGridFile } from '../io/parse-six-tier-textgrid.mjs';
import {
  compareFloorHandoffs,
  compareSixTierDocuments,
  validateTier5Consistency,
} from './metrics.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const RECORDING_ID = 'Multilogue04_C_Level30_D1G4';
const FIXED = Object.freeze({
  pause_threshold_seconds: 0.25,
  floor_release_seconds: 1,
  minimum_overlap_seconds: 0.1,
  overlap_mode: 'path_b_exclusive',
  label_vocabulary: ['s', 'f', 'bc', 'ol', 'op', 'pf', 'tr', 'shs', 'x'],
  floor_rules: ['R1', 'R2', 'R3', 'R4', 'R5'],
});
const GOALS = Object.freeze({
  active_set_exact_accuracy: 0.85,
  boundary_f1_100ms: 0.75,
  floor_accuracy: 0.98,
  transition_matched: 15,
  transition_gold: 17,
  tier5_handoff_matched_100ms: 15,
  tier5_handoff_gold: 20,
  macro_f1_observed_labels: 0.67609,
  f_f1: 0.27108,
  bc_f1: 0.32302,
});
const DEFAULTS = Object.freeze({
  audio: path.join(ROOT, 'sample', 'Multilogue04_C_Level30 D1G4.wav'),
  gold: path.join(ROOT, 'outputs', 'multilogue-v2-poc', 'Multilogue04_C_Level30_D1G4_P025_corrected_6tier.TextGrid'),
  stage1: path.join(ROOT, 'outputs', 'multilogue-v2-poc', RECORDING_ID, 'phase-i', 'stage1-evidence.json'),
  baseline: path.join(
    ROOT, 'outputs', 'multilogue-v2-poc', RECORDING_ID, 'phase-ii', 'P025',
    `${RECORDING_ID}.P025.draft.6tier.TextGrid`,
  ),
  v22Before: path.join(
    ROOT, 'outputs', 'multilogue-v2-calibration', RECORDING_ID, 'P025',
    'v2.2-gate-final-e244e79529aaed20', 'before-after.json',
  ),
});

export function runP025V23Calibration(userOptions = {}) {
  const options = { ...DEFAULTS, ...userOptions };
  for (const key of ['audio', 'gold', 'stage1', 'baseline']) {
    if (!existsSync(options[key])) throw new Error(`${key} input does not exist`);
  }
  const stage1 = readJson(options.stage1);
  assertFixedDefinitions(stage1);
  const prepared = prepareLocalAcousticVad(options.audio, defaultVadOptions());
  if (Math.abs(prepared.duration_seconds - Number(stage1.duration)) > 1e-6) {
    throw new Error('audio and Stage 1 duration differ');
  }

  // Runtime generation is complete before the corrected reference is parsed.
  const generatedCandidates = candidateConfigs().map((config) => generateCandidate(stage1, prepared, config));

  const gold = parseSixTierTextGridFile(options.gold);
  if (Math.abs(Number(gold.xmax) - Number(stage1.duration)) > 1e-6) {
    throw new Error('gold duration differs from the canonical runtime clock');
  }
  const baselineMetrics = compareSixTierDocuments(parseSixTierTextGridFile(options.baseline), gold);
  const v22Before = loadPreviousMetrics(options.v22Before);
  const candidates = generatedCandidates.map((candidate) => scoreCandidate(candidate, gold));
  candidates.sort(compareCandidates);
  const best = candidates[0];
  const gate = formalGate(best);
  const runId = options.runId || buildRunId(options, best.config);
  const outputDir = options.outputDir || path.join(
    ROOT, 'outputs', 'multilogue-v2-calibration', RECORDING_ID, 'P025', `v2.3-gate-${runId}`,
  );
  if (existsSync(outputDir) && !options.allowExistingOutput) throw new Error('v2.3 output directory already exists');
  const bestDir = path.join(outputDir, 'best-candidate');
  mkdirSync(bestDir, { recursive: true });

  const selected = compactMetrics(best.metrics);
  const beforeAfter = {
    contract_version: 'multilogue-v2.3-gate-before-after-v1',
    status: gate.status,
    calibration_status: 'calibration_only_not_holdout_validation',
    fixed_research_definitions: FIXED,
    goals: GOALS,
    baseline_original_draft: compactMetrics(baselineMetrics),
    baseline_v22_gate_candidate: v22Before,
    selected_v23_candidate: selected,
    deltas_vs_v22: v22Before ? deltas(v22Before, selected) : null,
    formal_gate: gate,
    tier5_floor_consistency: best.tier5_consistency,
    tier5_vs_gold_floor_handoffs_100ms: best.floor_handoff_agreement,
    selection_policy: {
      ranking: ['formal_gate_pass_count', 'normalized_gate_deficit', 'active_set', 'boundary_100ms', 'floor', 'macro_f1'],
      total_candidate_count: candidates.length,
      gold_available_to_runtime_generation: false,
    },
  };
  const inputLock = {
    contract_version: 'multilogue-v2.3-input-lock-v1',
    run_id: runId,
    network_used: false,
    gold_used_by_runtime_generation: false,
    production_defaults_changed: false,
    generation_completed_before_gold_parse: true,
    inputs: Object.fromEntries(['audio', 'gold', 'stage1', 'baseline'].map((key) => [key, fileRecord(options[key])])),
    fixed_research_definitions: FIXED,
    candidate_space: candidateConfigs(),
  };
  const rows = candidates.map(compactCandidate);
  const bestTextGridPath = path.join(bestDir, `${RECORDING_ID}.P025.v2.3-calibrated-draft.6tier.TextGrid`);
  writeFileSync(bestTextGridPath, best.output.textgrid, 'utf8');
  writeJson(path.join(outputDir, 'input-lock.json'), inputLock);
  writeJson(path.join(outputDir, 'before-after.json'), beforeAfter);
  writeJson(path.join(outputDir, 'candidate-results.json'), rows);
  writeCsv(path.join(outputDir, 'candidate-results.csv'), rows);
  writeJson(path.join(bestDir, 'metrics.json'), best.metrics);
  writeJson(path.join(bestDir, 'stage1-provenance.json'), best.provenance);
  writeJson(path.join(bestDir, 'tier5-validation.json'), {
    internal_consistency: best.tier5_consistency,
    comparison_to_gold_floor_handoffs_100ms: best.floor_handoff_agreement,
    note: 'Internal synchronization is not an accuracy claim; gold handoffs are derived from the corrected floor tier.',
  });
  writeJson(path.join(bestDir, 'method-manifest.json'), {
    contract_version: 'multilogue-v2.3-method-manifest-v1',
    status: gate.status,
    calibration_status: 'calibrated_draft_not_holdout_validated_not_research_ready',
    formal_gate: gate,
    selected_config: best.config,
    adapter_stats: best.adapter_stats,
    evidence_roles: {
      activity: 'all activity_eligible events contribute to active labels',
      semantic: 'only explicit_asr evidence can become f or bc',
      floor: 'only floor_eligible turn candidates drive floor and transitions',
    },
    tier5_floor_consistency: best.tier5_consistency,
    tier5_vs_gold_floor_handoffs_100ms: best.floor_handoff_agreement,
    network_used: false,
    gold_used_by_runtime_generation: false,
    production_defaults_changed: false,
    required_next_gate: gate.pass ? 'locked_unseen_multilogue_validation' : 'method_review_before_any_further_calibration',
  });
  writeFileSync(path.join(outputDir, 'calibration-report.md'), buildReport(beforeAfter, best), 'utf8');
  return { runId, outputDir, bestTextGridPath, beforeAfter, best, candidates };
}

function generateCandidate(stage1, prepared, config) {
  const vad = computeLocalAcousticVadFromPrepared(prepared, config.vad);
  const roomSounding = vad.intervals
    .filter((interval) => interval.text === 'sounding')
    .map(({ start, end }) => ({ start, end }));
  const built = buildV23Stage1Candidate(stage1, roomSounding, {
    ...config.adapter,
    acousticFrames: prepared.frames,
    acousticThresholdDb: vad.method.threshold_dbfs,
    acousticHopMs: prepared.hop_ms,
  });
  built.input.thresholds = [FIXED.pause_threshold_seconds];
  built.input.sharedActivityOptions = {
    ...(built.input.sharedActivityOptions || {}),
    minSoundingSeconds: config.shared_min_sounding_seconds,
  };
  built.input.interactionConfig = {
    ...(built.input.interactionConfig || {}),
    floorReleaseSeconds: FIXED.floor_release_seconds,
    minOverlapSeconds: FIXED.minimum_overlap_seconds,
    overlapMode: FIXED.overlap_mode,
  };
  const output = runMultilogueV2(built.input).thresholds.P250;
  const tier5Consistency = validateTier5Consistency(output);
  if (!tier5Consistency.pass) throw new Error(`Tier5 consistency failed: ${tier5Consistency.errors.join('; ')}`);
  return {
    id: candidateId(config),
    config,
    output,
    provenance: built.provenance,
    adapter_stats: built.stats,
    vad_method: vad.method,
    tier5_consistency: tier5Consistency,
  };
}

function scoreCandidate(candidate, gold) {
  return {
    ...candidate,
    metrics: compareSixTierDocuments(candidate.output.textgrid_document, gold),
    floor_handoff_agreement: compareFloorHandoffs(candidate.output.textgrid_document, gold, { tolerance: 0.1 }),
  };
}

function candidateConfigs() {
  const base = { ...defaultVadOptions(), minSilenceSeconds: 0, padSoundingSeconds: 0, minSoundingSeconds: 0.1 };
  const vadConfigs = [base, { ...base, noisePercentile: 15, thresholdMarginDb: 8, hysteresisDb: 1 }];
  const refinementProfiles = [
    { boundaryRefinementEnabled: false, boundaryRefineMaxGapSeconds: 0, boundaryRefineMaxExtensionSeconds: 0 },
    { boundaryRefinementEnabled: true, boundaryRefineMaxGapSeconds: 0.05, boundaryRefineMaxExtensionSeconds: 0.1 },
    { boundaryRefinementEnabled: true, boundaryRefineMaxGapSeconds: 0.1, boundaryRefineMaxExtensionSeconds: 0.2 },
  ];
  const configs = [];
  for (const vad of vadConfigs) {
    for (const phraseGapSeconds of [0.25, 0.35]) {
      for (const activityBridgeSeconds of [0, 0.05]) {
        for (const refinement of refinementProfiles) {
          configs.push({
            vad,
            shared_min_sounding_seconds: 0.5,
            adapter: {
              phraseGapSeconds,
              phraseMaxSeconds: 1.5,
              parentResponseGapSeconds: 0.5,
              parentResponseMaxSeconds: 8,
              activityBridgeSeconds,
              shortTurnAssemblyOverride: true,
              shortTurnMaxWords: 12,
              shortTurnMaxSeconds: 3.2,
              shortTurnMinAssemblyConfidence: 0.7,
              residualMinSeconds: 0.08,
              residualNonlexicalMaxSeconds: 0.25,
              promoteLongResidual: true,
              rebuildTransitionsFromFloor: true,
              ...refinement,
            },
          });
        }
      }
    }
  }
  return configs;
}

function compactMetrics(metrics) {
  const labels = metrics.label_agreement.per_label;
  return {
    active_set_exact_accuracy: metrics.active_speaker_set.exact_accuracy,
    active_set_jaccard: metrics.active_speaker_set.time_weighted_jaccard,
    room_activity_f1: metrics.room_activity.f1,
    boundary_f1_10ms: metrics.active_boundaries.aggregate['0.010'].combined.f1,
    boundary_f1_100ms: metrics.active_boundaries.aggregate['0.100'].combined.f1,
    macro_f1_observed_labels: metrics.label_agreement.macro_f1_observed_gold_labels,
    floor_accuracy: metrics.floor.exact_accuracy,
    floor_mismatch_seconds: metrics.floor.mismatch_seconds,
    transition_matched: metrics.transition_events.matched,
    transition_predicted: metrics.transition_events.predicted,
    transition_gold: metrics.transition_events.gold,
    transition_f1: metrics.transition_events.f1,
    f_f1: labels.f.f1,
    bc_f1: labels.bc.f1,
  };
}

function gateResults(candidate) {
  const metric = compactMetrics(candidate.metrics);
  const handoffs = candidate.floor_handoff_agreement;
  return {
    active_set: result(GOALS.active_set_exact_accuracy, metric.active_set_exact_accuracy),
    boundary_100ms: result(GOALS.boundary_f1_100ms, metric.boundary_f1_100ms),
    floor: result(GOALS.floor_accuracy, metric.floor_accuracy),
    transitions: result(GOALS.transition_matched, metric.transition_matched, GOALS.transition_gold),
    tier5_direction_boundary_100ms: result(
      GOALS.tier5_handoff_matched_100ms,
      handoffs.matched,
      GOALS.tier5_handoff_gold,
    ),
    macro_f1: result(GOALS.macro_f1_observed_labels, metric.macro_f1_observed_labels),
    filled_pause_f1: result(GOALS.f_f1, metric.f_f1),
    backchannel_f1: result(GOALS.bc_f1, metric.bc_f1),
  };
}

function formalGate(candidate) {
  const results = gateResults(candidate);
  const passCount = Object.values(results).filter((item) => item.met).length;
  const pass = passCount === Object.keys(results).length;
  return {
    contract_version: 'multilogue-v2.3-formal-gate-v1',
    status: pass ? 'V23_FORMAL_GATE_PASS' : 'V23_FORMAL_GATE_FAIL',
    pass,
    passed_kpi_count: passCount,
    required_kpi_count: Object.keys(results).length,
    normalized_deficit: normalizedDeficit(results),
    results,
  };
}

function result(target, actual, denominator = null) {
  return { target, ...(denominator == null ? {} : { denominator }), actual, met: actual >= target };
}

function normalizedDeficit(results) {
  return Number(Object.values(results)
    .reduce((sum, item) => sum + Math.max(0, item.target - item.actual) / item.target, 0)
    .toFixed(9));
}

function compareCandidates(left, right) {
  const leftGate = formalGate(left);
  const rightGate = formalGate(right);
  const leftMetrics = compactMetrics(left.metrics);
  const rightMetrics = compactMetrics(right.metrics);
  return rightGate.passed_kpi_count - leftGate.passed_kpi_count
    || leftGate.normalized_deficit - rightGate.normalized_deficit
    || rightMetrics.active_set_exact_accuracy - leftMetrics.active_set_exact_accuracy
    || rightMetrics.boundary_f1_100ms - leftMetrics.boundary_f1_100ms
    || rightMetrics.floor_accuracy - leftMetrics.floor_accuracy
    || rightMetrics.macro_f1_observed_labels - leftMetrics.macro_f1_observed_labels
    || left.id.localeCompare(right.id);
}

function compactCandidate(candidate) {
  const gate = formalGate(candidate);
  return {
    candidate_id: candidate.id,
    config: candidate.config,
    threshold_dbfs: candidate.vad_method.threshold_dbfs,
    ...compactMetrics(candidate.metrics),
    tier5_handoff_predicted: candidate.floor_handoff_agreement.predicted,
    tier5_handoff_gold: candidate.floor_handoff_agreement.gold,
    tier5_handoff_matched_100ms: candidate.floor_handoff_agreement.matched,
    tier5_handoff_f1_100ms: candidate.floor_handoff_agreement.f1,
    formal_gate_status: gate.status,
    formal_gate_pass_count: gate.passed_kpi_count,
    normalized_gate_deficit: gate.normalized_deficit,
    adapter_stats: candidate.adapter_stats,
  };
}

function buildReport(beforeAfter, best) {
  const before = beforeAfter.baseline_v22_gate_candidate;
  const after = beforeAfter.selected_v23_candidate;
  const percent = (value) => `${(Number(value) * 100).toFixed(3)}%`;
  const rows = [
    ['Active-set exact', 'active_set_exact_accuracy', percent],
    ['Boundary F1 @100ms', 'boundary_f1_100ms', percent],
    ['Floor exact', 'floor_accuracy', percent],
    ['Speaker-tier tr matched', 'transition_matched', String],
    ['Macro F1', 'macro_f1_observed_labels', percent],
    ['Filled-pause F1', 'f_f1', percent],
    ['Backchannel F1', 'bc_f1', percent],
  ];
  return [
    '# Multilogue04 v2.3 bounded calibration',
    '',
    `**Gate status: ${beforeAfter.status} (${beforeAfter.formal_gate.passed_kpi_count}/${beforeAfter.formal_gate.required_kpi_count})**`,
    '',
    '- All candidates were generated before the corrected reference was parsed.',
    '- Runtime used cached provider evidence and local acoustic processing only.',
    '- Six tiers, nine labels, R1-R5, P=.25, L=1, overlap=.1 and Path B remained fixed.',
    '- Production defaults remain unchanged.',
    '',
    '| Metric | v2.2 Gate | v2.3 |',
    '|---|---:|---:|',
    ...rows.map(([label, key, format]) => `| ${label} | ${before ? format(before[key]) : 'n/a'} | ${format(after[key])} |`),
    `| Tier5 direction + boundary @100ms | n/a | ${best.floor_handoff_agreement.matched}/${best.floor_handoff_agreement.gold} |`,
    '',
    '## Evidence roles',
    '',
    '- Acoustic activity contributes to active labels but does not automatically claim the floor.',
    '- Only explicit ASR phrase evidence can become f or bc.',
    '- Residual activity remains s with a Tier6 review flag and never becomes f or bc.',
    '- Only floor-eligible turn candidates drive floor and Tier5.',
    '',
    '## Boundary refinement',
    '',
    `- Refined events: ${best.adapter_stats.boundary_refined_event_count}.`,
    `- Extension: ${best.adapter_stats.boundary_extension_seconds}s; contraction: ${best.adapter_stats.boundary_contraction_seconds}s.`,
    `- Provider-conflict expansions withheld: ${best.adapter_stats.boundary_provider_conflict_withheld_count}.`,
    '',
    '## Decision',
    '',
    `- ${beforeAfter.status}. Any unmet KPI keeps the candidate out of production/research use.`,
    '- No further parameter expansion was performed.',
    '',
  ].join('\n');
}

function deltas(before, after) {
  return Object.fromEntries(Object.keys(after)
    .filter((key) => Number.isFinite(after[key]) && Number.isFinite(before[key]))
    .map((key) => [key, after[key] - before[key]]));
}

function loadPreviousMetrics(file) {
  if (!file || !existsSync(file)) return null;
  return readJson(file).selected_v22_candidate || null;
}

function assertFixedDefinitions(stage1) {
  if (Number(stage1.interactionConfig?.floorReleaseSeconds) !== 1) throw new Error('L must remain 1.0');
  if (Number(stage1.interactionConfig?.minOverlapSeconds) !== 0.1) throw new Error('minimum overlap must remain 0.1');
  if (stage1.interactionConfig?.overlapMode !== 'path_b_exclusive') throw new Error('Path B must remain fixed');
}

function candidateId(config) {
  return `v23-${createHash('sha256').update(stableJson(config)).digest('hex').slice(0, 12)}`;
}

function buildRunId(options, config) {
  return createHash('sha256')
    .update(readFileSync(options.gold))
    .update(readFileSync(options.stage1))
    .update(stableJson(config))
    .digest('hex')
    .slice(0, 16);
}

function fileRecord(file) {
  const bytes = readFileSync(file);
  return {
    identifier: path.relative(ROOT, file).replaceAll(path.sep, '/'),
    sha256: createHash('sha256').update(bytes).digest('hex'),
    bytes: bytes.length,
  };
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function readJson(file) {
  return JSON.parse(readFileSync(file, 'utf8'));
}

function writeJson(file, value) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function writeCsv(file, rows) {
  const flattened = rows.map((row) => ({
    candidate_id: row.candidate_id,
    threshold_dbfs: row.threshold_dbfs,
    refinement_enabled: row.config.adapter.boundaryRefinementEnabled,
    refinement_gap_sec: row.config.adapter.boundaryRefineMaxGapSeconds,
    refinement_extension_sec: row.config.adapter.boundaryRefineMaxExtensionSeconds,
    active_set_exact_accuracy: row.active_set_exact_accuracy,
    boundary_f1_100ms: row.boundary_f1_100ms,
    floor_accuracy: row.floor_accuracy,
    transition_matched: row.transition_matched,
    tier5_handoff_matched_100ms: row.tier5_handoff_matched_100ms,
    macro_f1_observed_labels: row.macro_f1_observed_labels,
    f_f1: row.f_f1,
    bc_f1: row.bc_f1,
    formal_gate_status: row.formal_gate_status,
    formal_gate_pass_count: row.formal_gate_pass_count,
    normalized_gate_deficit: row.normalized_gate_deficit,
  }));
  const columns = Object.keys(flattened[0]);
  const quote = (value) => /[",\n]/.test(String(value)) ? `"${String(value).replaceAll('"', '""')}"` : String(value);
  writeFileSync(file, `${columns.join(',')}\n${flattened.map((row) => columns.map((key) => quote(row[key])).join(',')).join('\n')}\n`, 'utf8');
}

function main() {
  const run = runP025V23Calibration();
  process.stdout.write(`${JSON.stringify({
    status: run.beforeAfter.status,
    output_directory: path.relative(ROOT, run.outputDir).replaceAll(path.sep, '/'),
    best_textgrid: path.relative(ROOT, run.bestTextGridPath).replaceAll(path.sep, '/'),
    metrics: run.beforeAfter.selected_v23_candidate,
    formal_gate: run.beforeAfter.formal_gate,
    tier5: run.beforeAfter.tier5_vs_gold_floor_handoffs_100ms,
  }, null, 2)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) main();
