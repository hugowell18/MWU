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
import { buildV22Stage1Candidate } from '../adapters/build-v22-stage1-candidate.mjs';
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
});
const GOALS = Object.freeze({
  active_set_exact_accuracy: 0.85,
  boundary_f1_100ms: 0.75,
  transition_matched: 15,
  transition_gold: 17,
  floor_accuracy: 0.98,
});
const DEFAULTS = Object.freeze({
  audio: path.join(ROOT, 'sample', 'Multilogue04_C_Level30 D1G4.wav'),
  gold: path.join(ROOT, 'outputs', 'multilogue-v2-poc', 'Multilogue04_C_Level30_D1G4_P025_corrected_6tier.TextGrid'),
  stage1: path.join(ROOT, 'outputs', 'multilogue-v2-poc', RECORDING_ID, 'phase-i', 'stage1-evidence.json'),
  baseline: path.join(
    ROOT, 'outputs', 'multilogue-v2-poc', RECORDING_ID, 'phase-ii', 'P025',
    `${RECORDING_ID}.P025.draft.6tier.TextGrid`,
  ),
  v21Latest: path.join(ROOT, 'outputs', 'multilogue-v2-calibration', RECORDING_ID, 'P025', 'latest-run.json'),
  v22Before: path.join(
    ROOT, 'outputs', 'multilogue-v2-calibration', RECORDING_ID, 'P025',
    'v2.2-ca4fe2903299b868', 'before-after.json',
  ),
});

export function runP025V22Calibration(userOptions = {}) {
  const options = { ...DEFAULTS, ...userOptions };
  for (const key of ['audio', 'gold', 'stage1', 'baseline']) {
    if (!existsSync(options[key])) throw new Error(`${key} input does not exist`);
  }
  const stage1 = readJson(options.stage1);
  assertFixedDefinitions(stage1);
  const gold = parseSixTierTextGridFile(options.gold);
  if (Number(gold.xmax) !== Number(stage1.duration)) throw new Error('gold duration differs from the canonical runtime clock');
  const baselineDocument = parseSixTierTextGridFile(options.baseline);
  const baselineMetrics = compareSixTierDocuments(baselineDocument, gold);
  const v21 = loadV21Metrics(options.v21Latest, gold);
  const v22Before = loadPreviousV22Metrics(options.v22Before);
  const prepared = prepareLocalAcousticVad(options.audio, defaultVadOptions());
  if (Math.abs(prepared.duration_seconds - gold.xmax) > 1e-6) throw new Error('audio and gold durations differ');

  const candidates = [];
  for (const config of candidateConfigs()) {
    const vad = computeLocalAcousticVadFromPrepared(prepared, config.vad);
    const roomSounding = vad.intervals
      .filter((interval) => interval.text === 'sounding')
      .map(({ start, end }) => ({ start, end }));
    const generated = buildV22Stage1Candidate(stage1, roomSounding, config.adapter);
    generated.input.thresholds = [FIXED.pause_threshold_seconds];
    generated.input.sharedActivityOptions = {
      ...(generated.input.sharedActivityOptions || {}),
      minSoundingSeconds: config.shared_min_sounding_seconds,
    };
    generated.input.interactionConfig = {
      ...(generated.input.interactionConfig || {}),
      floorReleaseSeconds: FIXED.floor_release_seconds,
      minOverlapSeconds: FIXED.minimum_overlap_seconds,
      overlapMode: FIXED.overlap_mode,
    };
    const core = runMultilogueV2(generated.input);
    const output = core.thresholds.P250;
    const metrics = compareSixTierDocuments(output.textgrid_document, gold);
    const floorTransferCount = countFloorTransfers(output.textgrid_document);
    const tier5Count = output.textgrid_document.tiers.find((tier) => tier.name === 'transitions').points.length;
    if (floorTransferCount !== tier5Count) throw new Error('Tier 5 was not rebuilt from the generated floor');
    const tier5Consistency = validateTier5Consistency(output);
    if (!tier5Consistency.pass) throw new Error(`Tier 5 consistency failed: ${tier5Consistency.errors.join('; ')}`);
    const floorHandoffAgreement = compareFloorHandoffs(output.textgrid_document, gold, { tolerance: 0.1 });
    candidates.push({
      id: candidateId(config),
      config,
      adapter_stats: generated.stats,
      adapter_provenance: generated.provenance,
      vad_method: vad.method,
      metrics,
      floor_transfer_count: floorTransferCount,
      tier5_point_count: tier5Count,
      tier5_consistency: tier5Consistency,
      floor_handoff_agreement: floorHandoffAgreement,
      output,
    });
  }

  const eligible = candidates.filter((candidate) => candidate.metrics.floor.exact_accuracy >= GOALS.floor_accuracy);
  const selectionPool = eligible.length ? eligible : candidates;
  selectionPool.sort(compareCandidates);
  const best = selectionPool[0];
  const runId = options.runId || buildRunId(options, best.config);
  const outputDir = options.outputDir || path.join(
    ROOT, 'outputs', 'multilogue-v2-calibration', RECORDING_ID, 'P025', `v2.2-gate-${runId}`,
  );
  if (existsSync(outputDir) && !options.allowExistingOutput) throw new Error('v2.2 output directory already exists');
  const bestDir = path.join(outputDir, 'best-candidate');
  mkdirSync(bestDir, { recursive: true });

  const gate = formalGate(best.metrics);
  const beforeAfter = {
    contract_version: 'multilogue-v2.2-hugo-qa-before-after-v1',
    status: gate.status,
    calibration_status: 'calibration_only_not_holdout_validation',
    fixed_research_definitions: FIXED,
    goals: GOALS,
    baseline_original_draft: compactMetrics(baselineMetrics),
    baseline_v21_calibrated_candidate: v21,
    baseline_v22_pre_gate_candidate: v22Before,
    selected_v22_candidate: compactMetrics(best.metrics),
    deltas_vs_original: deltas(baselineMetrics, best.metrics),
    deltas_vs_v21: v21 ? compactDeltas(v21, compactMetrics(best.metrics)) : null,
    deltas_vs_v22_pre_gate: v22Before ? compactDeltas(v22Before, compactMetrics(best.metrics)) : null,
    goal_results: gate.results,
    formal_gate: gate,
    tier5_floor_consistency: best.tier5_consistency,
    tier5_vs_gold_floor_handoffs_100ms: best.floor_handoff_agreement,
    selection_policy: {
      calibration_preference: 'floor_accuracy >= 0.98',
      fallback_when_no_candidate_meets_preference: 'rank all bounded candidates and emit HUGO_QA_GATE_FAIL',
      ranking: ['active_set_exact_accuracy', 'boundary_f1_100ms', 'macro_f1_observed_labels', 'transition_matched'],
      formal_gate_after_selection: [
        'active_set_exact_accuracy >= 0.85',
        'boundary_f1_100ms >= 0.75',
        'transition_matched >= 15 of 17',
        'floor_accuracy >= 0.98',
      ],
      eligible_candidate_count: eligible.length,
      total_candidate_count: candidates.length,
    },
  };
  const inputLock = {
    contract_version: 'multilogue-v2.2-input-lock-v1',
    run_id: runId,
    network_used: false,
    gold_used_by_runtime_generation: false,
    production_defaults_changed: false,
    inputs: Object.fromEntries(['audio', 'gold', 'stage1', 'baseline'].map((key) => [key, fileRecord(options[key])])),
    fixed_research_definitions: FIXED,
    candidate_space: candidateConfigs().map((config) => sanitizeConfig(config)),
  };
  const candidateRows = candidates.map((candidate) => compactCandidate(candidate));
  const bestTextGridPath = path.join(bestDir, `${RECORDING_ID}.P025.v2.2-calibrated-draft.6tier.TextGrid`);
  writeFileSync(bestTextGridPath, best.output.textgrid, 'utf8');
  writeJson(path.join(outputDir, 'input-lock.json'), inputLock);
  writeJson(path.join(outputDir, 'before-after.json'), beforeAfter);
  writeJson(path.join(outputDir, 'candidate-results.json'), candidateRows);
  writeCsv(path.join(outputDir, 'candidate-results.csv'), candidateRows);
  writeJson(path.join(bestDir, 'metrics.json'), best.metrics);
  writeJson(path.join(bestDir, 'tier5-validation.json'), {
    internal_consistency: best.tier5_consistency,
    comparison_to_gold_floor_handoffs_100ms: best.floor_handoff_agreement,
    note: 'Tier5 internal synchronization is not an accuracy claim; gold handoffs are derived from the corrected floor tier.',
  });
  writeJson(path.join(bestDir, 'stage1-provenance.json'), best.adapter_provenance);
  writeJson(path.join(bestDir, 'method-manifest.json'), {
    contract_version: 'multilogue-v2.2-calibrated-draft-manifest-v1',
    status: gate.status,
    calibration_status: 'calibrated_draft_not_holdout_validated_not_research_ready',
    formal_gate: gate,
    selected_config: sanitizeConfig(best.config),
    adapter_stats: best.adapter_stats,
    floor_transfer_count: best.floor_transfer_count,
    tier5_point_count: best.tier5_point_count,
    tier5_floor_consistency: best.tier5_consistency,
    tier5_vs_gold_floor_handoffs_100ms: best.floor_handoff_agreement,
    core_validation: best.output.validation,
    core_digest: best.output.digest,
    network_used: false,
    gold_used_by_runtime_generation: false,
    production_defaults_changed: false,
    required_next_gate: 'locked_candidate_blind_validation_on_unseen_multilogue',
  });
  writeFileSync(path.join(outputDir, 'calibration-report.md'), buildReport(beforeAfter, best), 'utf8');

  return { runId, outputDir, bestTextGridPath, beforeAfter, best, candidates };
}

function candidateConfigs() {
  const base = { ...defaultVadOptions(), minSilenceSeconds: 0, padSoundingSeconds: 0, minSoundingSeconds: 0.1 };
  const vadConfigs = [
    { ...base },
    { ...base, noisePercentile: 15, thresholdMarginDb: 8, hysteresisDb: 1 },
  ];
  const configs = [];
  for (const vad of vadConfigs) {
    for (const phraseGapSeconds of [0.1, 0.25, 0.35]) {
      for (const activityBridgeSeconds of [0, 0.05]) {
        for (const residualNonlexicalMaxSeconds of [0.25, 0.4]) {
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
              residualNonlexicalMaxSeconds,
              promoteLongResidual: true,
              rebuildTransitionsFromFloor: true,
            },
          });
        }
      }
    }
  }
  return configs;
}

function compareCandidates(left, right) {
  const l = compactMetrics(left.metrics);
  const r = compactMetrics(right.metrics);
  return r.active_set_exact_accuracy - l.active_set_exact_accuracy
    || r.boundary_f1_100ms - l.boundary_f1_100ms
    || r.macro_f1_observed_labels - l.macro_f1_observed_labels
    || r.transition_matched - l.transition_matched
    || left.id.localeCompare(right.id);
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

function compactCandidate(candidate) {
  const gate = formalGate(candidate.metrics);
  return {
    candidate_id: candidate.id,
    config: sanitizeConfig(candidate.config),
    threshold_dbfs: candidate.vad_method.threshold_dbfs,
    ...compactMetrics(candidate.metrics),
    floor_transfer_count: candidate.floor_transfer_count,
    tier5_point_count: candidate.tier5_point_count,
    formal_gate_status: gate.status,
    formal_gate_pass: gate.pass,
    tier5_floor_consistency_pass: candidate.tier5_consistency.pass,
    gold_floor_handoff_count: candidate.floor_handoff_agreement.gold,
    floor_handoff_matched_100ms: candidate.floor_handoff_agreement.matched,
    adapter_stats: candidate.adapter_stats,
  };
}

function goalResults(metrics) {
  const compact = compactMetrics(metrics);
  return {
    active_set: { target: GOALS.active_set_exact_accuracy, actual: compact.active_set_exact_accuracy, met: compact.active_set_exact_accuracy >= GOALS.active_set_exact_accuracy },
    boundary_100ms: { target: GOALS.boundary_f1_100ms, actual: compact.boundary_f1_100ms, met: compact.boundary_f1_100ms >= GOALS.boundary_f1_100ms },
    transitions: { target: GOALS.transition_matched, denominator: GOALS.transition_gold, actual: compact.transition_matched, met: compact.transition_matched >= GOALS.transition_matched },
    floor: { target: GOALS.floor_accuracy, actual: compact.floor_accuracy, met: compact.floor_accuracy >= GOALS.floor_accuracy },
  };
}

function formalGate(metrics) {
  const results = goalResults(metrics);
  const pass = Object.values(results).every((item) => item.met);
  return {
    contract_version: 'multilogue-v2.2-hugo-qa-gate-v1',
    status: pass ? 'HUGO_QA_GATE_PASS' : 'HUGO_QA_GATE_FAIL',
    pass,
    results,
  };
}

function deltas(before, after) {
  return compactDeltas(compactMetrics(before), compactMetrics(after));
}

function compactDeltas(before, after) {
  return Object.fromEntries(Object.keys(after)
    .filter((key) => Number.isFinite(after[key]) && Number.isFinite(before[key]))
    .map((key) => [key, after[key] - before[key]]));
}

function countFloorTransfers(document) {
  const floor = document.tiers.find((tier) => tier.name === 'floor');
  let previous = null;
  let count = 0;
  for (const interval of floor.intervals) {
    if (!['S1', 'S2', 'S3'].includes(interval.text)) continue;
    if (previous && previous !== interval.text) count += 1;
    previous = interval.text;
  }
  return count;
}

function loadV21Metrics(latestFile, gold) {
  if (!existsSync(latestFile)) return null;
  const latest = readJson(latestFile);
  const file = path.resolve(ROOT, latest.best_candidate_textgrid || '');
  if (!existsSync(file)) return null;
  return compactMetrics(compareSixTierDocuments(parseSixTierTextGridFile(file), gold));
}

function loadPreviousV22Metrics(file) {
  if (!file || !existsSync(file)) return null;
  const report = readJson(file);
  return report.selected_v22_candidate || null;
}

function buildReport(beforeAfter, best) {
  const rows = [
    ['Active-speaker-set exact', 'active_set_exact_accuracy'],
    ['Boundary F1 at 100 ms', 'boundary_f1_100ms'],
    ['Macro F1, observed labels', 'macro_f1_observed_labels'],
    ['Floor exact accuracy', 'floor_accuracy'],
    ['Transition matched', 'transition_matched'],
    ['Filled-pause F1', 'f_f1'],
    ['Backchannel F1', 'bc_f1'],
  ];
  const before = beforeAfter.baseline_original_draft;
  const v21 = beforeAfter.baseline_v21_calibrated_candidate;
  const v22Before = beforeAfter.baseline_v22_pre_gate_candidate;
  const after = beforeAfter.selected_v22_candidate;
  const fmt = (value, key) => key === 'transition_matched' ? String(value) : `${(value * 100).toFixed(3)}%`;
  return [
    '# Multilogue04 v2.2 Hugo QA Gate',
    '',
    `**Gate status: ${beforeAfter.formal_gate.status}**`,
    '',
    '- The customer-corrected TextGrid was used only after generation to score candidates.',
    '- Runtime generation used cached Pyannote, AssemblyAI and local acoustic evidence only.',
    '- This is calibration on Multilogue04, not an unseen validation result.',
    '- Production defaults remain unchanged.',
    '',
    '| Metric | Original draft | v2.1 candidate | v2.2 before Gate | v2.2 Gate candidate |',
    '|---|---:|---:|---:|---:|',
    ...rows.map(([label, key]) => `| ${label} | ${fmt(before[key], key)} | ${v21 ? fmt(v21[key], key) : 'n/a'} | ${v22Before ? fmt(v22Before[key], key) : 'n/a'} | ${fmt(after[key], key)} |`),
    '',
    '## v2.2 evidence changes',
    '',
    `- ${best.adapter_stats.source_word_event_count} timed word events were grouped into ${best.adapter_stats.parent_response_count} AssemblyAI parent responses and ${best.adapter_stats.phrase_event_count} child phrase candidates.`,
    `- ${best.adapter_stats.promoted_residual_count} acoustic-supported residual candidates were retained with review provenance.`,
    `- ${best.adapter_stats.phrase_override_count} short phrase speaker decisions used the bounded provider-disagreement rule.`,
    `- Tier 5 contains ${best.tier5_point_count} points and passes internal direction/turn_end/turn_start consistency against ${best.floor_transfer_count} generated floor handoffs.`,
    `- The corrected gold floor contains ${best.floor_handoff_agreement.gold} handoffs; the candidate predicts ${best.floor_handoff_agreement.predicted}, with ${best.floor_handoff_agreement.matched} direction-and-boundary matches at 100 ms.`,
    '- Internal Tier 5 synchronization is not reported as an accuracy measure.',
    '',
    '## Remaining limits',
    '',
    `- Formal Gate result: ${beforeAfter.formal_gate.status}. Every KPI is mandatory; any unmet KPI makes the report FAIL.`,
    '- Filled pauses and backchannels remain the weakest semantic labels.',
    '- The selected candidate must be locked and tested on an unseen multilogue before any production claim.',
    '- Gold Tier 5 and Tier 6 are not used as scoring truth because their correction status remains ambiguous.',
    '',
  ].join('\n');
}

function sanitizeConfig(config) {
  return JSON.parse(JSON.stringify(config));
}

function assertFixedDefinitions(stage1) {
  if (Number(stage1.interactionConfig?.floorReleaseSeconds) !== 1) throw new Error('L must remain 1.0');
  if (Number(stage1.interactionConfig?.minOverlapSeconds) !== 0.1) throw new Error('minimum overlap must remain 0.1');
  if (stage1.interactionConfig?.overlapMode !== 'path_b_exclusive') throw new Error('Path B must remain fixed');
}

function candidateId(config) {
  return `v22-${createHash('sha256').update(stableJson(config)).digest('hex').slice(0, 12)}`;
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
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
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
    noise_percentile: row.config.vad.noisePercentile,
    threshold_margin_db: row.config.vad.thresholdMarginDb,
    hysteresis_db: row.config.vad.hysteresisDb,
    phrase_gap_seconds: row.config.adapter.phraseGapSeconds,
    activity_bridge_seconds: row.config.adapter.activityBridgeSeconds,
    residual_nonlexical_max_seconds: row.config.adapter.residualNonlexicalMaxSeconds,
    active_set_exact_accuracy: row.active_set_exact_accuracy,
    boundary_f1_100ms: row.boundary_f1_100ms,
    macro_f1_observed_labels: row.macro_f1_observed_labels,
    floor_accuracy: row.floor_accuracy,
    transition_matched: row.transition_matched,
    transition_predicted: row.transition_predicted,
    formal_gate_status: row.formal_gate_status,
    tier5_floor_consistency_pass: row.tier5_floor_consistency_pass,
    gold_floor_handoff_count: row.gold_floor_handoff_count,
    floor_handoff_matched_100ms: row.floor_handoff_matched_100ms,
    f_f1: row.f_f1,
    bc_f1: row.bc_f1,
  }));
  const columns = Object.keys(flattened[0]);
  const quote = (value) => /[",\n]/.test(String(value)) ? `"${String(value).replaceAll('"', '""')}"` : String(value);
  writeFileSync(file, `${columns.join(',')}\n${flattened.map((row) => columns.map((key) => quote(row[key])).join(',')).join('\n')}\n`, 'utf8');
}

function main() {
  const result = runP025V22Calibration();
  process.stdout.write(`${JSON.stringify({
    status: result.beforeAfter.status,
    calibration_complete: true,
    output_directory: path.relative(ROOT, result.outputDir).replaceAll(path.sep, '/'),
    best_textgrid: path.relative(ROOT, result.bestTextGridPath).replaceAll(path.sep, '/'),
    metrics: result.beforeAfter.selected_v22_candidate,
    goals: result.beforeAfter.goal_results,
  }, null, 2)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) main();
