#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  computeLocalAcousticVadFromPrepared,
  defaultVadOptions,
  prepareLocalAcousticVad,
} from '../../local-acoustic-vad.mjs';
import { runMultilogueV2 } from '../core/pipeline.mjs';
import { parseSixTierTextGridFile } from '../io/parse-six-tier-textgrid.mjs';
import {
  candidateSelectionVector,
  compareSixTierDocuments,
  compareVadToGold,
} from './metrics.mjs';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(SCRIPT_DIR, '../../..');
const RECORDING_ID = 'Multilogue04_C_Level30_D1G4';
const FIXED_RESEARCH_DEFINITIONS = Object.freeze({
  pause_threshold_seconds: 0.25,
  floor_release_seconds: 1,
  minimum_overlap_seconds: 0.1,
  overlap_association_tolerance_seconds: 0.1,
  overlap_mode: 'path_b_exclusive',
  label_vocabulary: ['s', 'f', 'bc', 'ol', 'op', 'pf', 'tr', 'shs', 'x'],
});
const DEFAULT_PRAAT_EXECUTABLE = '/Applications/Praat.app/Contents/MacOS/Praat';
const PRAAT_CHECK_SCRIPT = path.join(ROOT, 'scripts', 'check_review_6tier_textgrid_in_praat.praat');

const DEFAULTS = Object.freeze({
  audio: path.join(ROOT, 'sample', 'Multilogue04_C_Level30 D1G4.wav'),
  gold: path.join(ROOT, 'outputs', 'multilogue-v2-poc', 'Multilogue04_C_Level30_D1G4_P025_corrected_6tier.TextGrid'),
  stage1: path.join(ROOT, 'outputs', 'multilogue-v2-poc', RECORDING_ID, 'phase-i', 'stage1-evidence.json'),
  roomActivity: path.join(ROOT, 'outputs', 'multilogue-v2-poc', RECORDING_ID, 'phase-i', 'room-activity-base.json'),
  baselineTextGrid: path.join(
    ROOT,
    'outputs', 'multilogue-v2-poc', RECORDING_ID, 'phase-ii', 'P025',
    `${RECORDING_ID}.P025.draft.6tier.TextGrid`,
  ),
});

export function runP025Calibration(userOptions = {}) {
  const options = resolveOptions(userOptions);
  assertInputs(options);
  const gold = parseSixTierTextGridFile(options.gold);
  const baselineDocument = parseSixTierTextGridFile(options.baselineTextGrid);
  const stage1Input = readJson(options.stage1);
  const roomActivity = readJson(options.roomActivity);
  assertFixedResearchDefinitions(stage1Input, gold);

  const runId = options.runId || buildRunId(options, stage1Input);
  const outputDir = options.outputDir || path.join(
    ROOT, 'outputs', 'multilogue-v2-calibration', RECORDING_ID, 'P025', runId,
  );
  if (existsSync(outputDir) && !options.allowExistingOutput) {
    throw new Error(`Calibration output already exists: ${outputDir}`);
  }
  mkdirSync(outputDir, { recursive: true });

  const baselineMetrics = compareSixTierDocuments(baselineDocument, gold);
  const baselineVadOptions = {
    ...defaultVadOptions(),
    ...(roomActivity.method?.options || {}),
  };
  const prepared = prepareLocalAcousticVad(options.audio, baselineVadOptions);
  if (Math.abs(Number(prepared.duration_seconds) - Number(gold.xmax)) > 1e-6) {
    throw new Error('Audio and gold TextGrid duration differ');
  }

  const coarseConfigs = buildCoarseConfigs(baselineVadOptions, options.grid);
  const coarseResults = evaluateRawCandidates(coarseConfigs, prepared, gold, 'coarse');
  const fineSeeds = uniqueConfigs([
    baselineVadOptions,
    ...coarseResults.slice(0, options.grid === 'quick' ? 1 : 6).map((item) => item.vad_options),
  ]);
  const fineConfigs = buildFineConfigs(fineSeeds, options.grid);
  const fineResults = evaluateRawCandidates(fineConfigs, prepared, gold, 'fine');
  const rawCandidates = dedupeCandidateResults([...coarseResults, ...fineResults]);
  const roomVadBest = rawCandidates[0];

  const coreSeeds = uniqueConfigs([
    baselineVadOptions,
    ...rawCandidates.slice(0, options.grid === 'quick' ? 1 : 5).map((item) => item.vad_options),
  ]);
  const sharedMinimums = options.grid === 'quick' ? [0.1, 0.5] : [0.1, 0.25, 0.5];
  const fullCandidates = [];
  for (const vadOptions of coreSeeds) {
    const vad = computeLocalAcousticVadFromPrepared(prepared, vadOptions);
    const roomSoundingIntervals = vad.intervals
      .filter((interval) => interval.text === 'sounding')
      .map(({ start, end }) => ({ start, end }));
    const rawMetrics = compareVadToGold(vad.intervals, gold);
    for (const sharedMinSoundingSeconds of sharedMinimums) {
      const pipelineInput = {
        ...stage1Input,
        thresholds: [FIXED_RESEARCH_DEFINITIONS.pause_threshold_seconds],
        roomSoundingIntervals,
        sharedActivityOptions: {
          ...(stage1Input.sharedActivityOptions || {}),
          minSoundingSeconds: sharedMinSoundingSeconds,
        },
        interactionConfig: {
          ...(stage1Input.interactionConfig || {}),
          floorReleaseSeconds: FIXED_RESEARCH_DEFINITIONS.floor_release_seconds,
          minOverlapSeconds: FIXED_RESEARCH_DEFINITIONS.minimum_overlap_seconds,
          overlapAssociationToleranceSeconds: FIXED_RESEARCH_DEFINITIONS.overlap_association_tolerance_seconds,
          overlapMode: FIXED_RESEARCH_DEFINITIONS.overlap_mode,
        },
      };
      const core = runMultilogueV2(pipelineInput);
      const output = core.thresholds.P250;
      if (!output) throw new Error('Core calibration run did not emit fixed P=0.25 output');
      const outputMetrics = compareSixTierDocuments(output.textgrid_document, gold);
      const config = { vad: vadOptions, shared_min_sounding_seconds: sharedMinSoundingSeconds };
      fullCandidates.push({
        candidate_id: candidateId(config),
        config,
        vad_method: vad.method,
        raw_vad_metrics: rawMetrics,
        output_metrics: outputMetrics,
        selection_vector: candidateSelectionVector(rawMetrics, outputMetrics),
        output,
      });
    }
  }
  fullCandidates.sort(compareFullCandidates);
  const best = fullCandidates[0];
  const baselineReplay = fullCandidates.find((item) =>
    sameConfig(item.config.vad, baselineVadOptions) && item.config.shared_min_sounding_seconds === 0.1);
  if (!baselineReplay) throw new Error('Calibration grid omitted the fixed-input baseline replay');

  const inputLock = {
    contract_version: 'multilogue-v2.1-p025-calibration-input-lock-v1',
    run_id: runId,
    recording_id: RECORDING_ID,
    generated_at: new Date().toISOString(),
    network_used: false,
    research_definitions_locked: FIXED_RESEARCH_DEFINITIONS,
    inputs: {
      audio: fileRecord(options.audio),
      gold_textgrid: fileRecord(options.gold),
      stage1_evidence: fileRecord(options.stage1),
      baseline_room_activity: fileRecord(options.roomActivity),
      baseline_textgrid: fileRecord(options.baselineTextGrid),
    },
    selection_policy: {
      primary: 'six_tier_active_speaker_set_exact_accuracy',
      secondary: 'six_tier_output_activity_score',
      tertiary: 'six_tier_macro_f1_observed_gold_labels',
      room_vad_metrics: 'diagnostic_only_never_selected_as_overall_objective',
      production_default_change: false,
      holdout_required_before_default_change: true,
    },
    bounded_parameter_space: {
      noise_percentile: [10, 30],
      threshold_margin_db: [4, 16],
      hysteresis_db: [1, 5],
      vad_minimum_sounding_seconds: [0.05, 0.25],
      sounding_padding_seconds: [0, 0.02],
      phase_ii_minimum_sounding_seconds: [0.1, 0.5],
      vad_gap_fill_seconds: 0,
    },
  };
  const compactRaw = rawCandidates.map(compactRawCandidate);
  const compactFull = fullCandidates.map(compactFullCandidate);
  const experiment = {
    contract_version: 'multilogue-v2.1-p025-parameter-calibration-v1',
    run_id: runId,
    status: 'calibration_only_not_holdout_validation',
    grid: options.grid,
    baseline: {
      existing_draft_metrics: baselineMetrics,
      replay: compactFullCandidate(baselineReplay),
    },
    room_vad_best_diagnostic_only: compactRawCandidate(roomVadBest),
    selected_best_candidate: compactFullCandidate(best),
    deltas_vs_existing_baseline: metricDeltas(baselineMetrics, best.output_metrics),
    raw_vad_candidates: compactRaw,
    full_pipeline_candidates: compactFull,
    limitations: [
      'The same corrected Multilogue04 file is used for calibration and scoring; this is not an unbiased validation result.',
      'Acoustic parameter tuning cannot correct speaker attribution, filler/backchannel semantics, floor handoffs, or stale Tier-5/Tier-6 review semantics.',
      'No production default is changed until a separate unseen multilogue passes the locked holdout test.',
    ],
  };

  const bestDir = path.join(outputDir, 'best-candidate');
  mkdirSync(bestDir, { recursive: true });
  writeJson(path.join(outputDir, 'input-lock.json'), inputLock);
  writeJson(path.join(outputDir, 'experiment-results.json'), experiment);
  writeCsv(path.join(outputDir, 'experiment-results.csv'), compactFull);
  writeJson(path.join(outputDir, 'baseline-metrics.json'), baselineMetrics);
  writeJson(path.join(bestDir, 'config.json'), best.config);
  writeJson(path.join(bestDir, 'metrics.json'), best.output_metrics);
  writeJson(path.join(bestDir, 'raw-vad-metrics.json'), best.raw_vad_metrics);
  const bestTextGridPath = path.join(bestDir, `${RECORDING_ID}.P025.calibrated-draft.6tier.TextGrid`);
  writeFileSync(bestTextGridPath, best.output.textgrid, 'utf8');
  const praatValidation = runPraatValidation(bestTextGridPath, options.praatExecutable || DEFAULT_PRAAT_EXECUTABLE);
  writeJson(path.join(bestDir, 'praat-validation.json'), praatValidation);
  writeJson(
    path.join(bestDir, 'method-manifest.json'),
    buildBestManifest(runId, best, inputLock, baselineMetrics, praatValidation),
  );
  writeFileSync(path.join(outputDir, 'calibration-report.md'), buildReport(experiment, bestTextGridPath), 'utf8');

  if (options.writeLatest !== false) {
    const latestPath = path.join(ROOT, 'outputs', 'multilogue-v2-calibration', RECORDING_ID, 'P025', 'latest-run.json');
    writeJson(latestPath, {
      run_id: runId,
      output_directory: path.relative(ROOT, outputDir).replaceAll(path.sep, '/'),
      best_candidate_textgrid: path.relative(ROOT, bestTextGridPath).replaceAll(path.sep, '/'),
      generated_at: inputLock.generated_at,
    });
  }
  return { runId, outputDir, bestTextGridPath, experiment };
}

function buildCoarseConfigs(baseline, grid) {
  if (grid === 'quick') return uniqueConfigs([baseline, { ...baseline, thresholdMarginDb: 5 }]);
  const configs = [baseline];
  for (const noisePercentile of [10, 15, 20, 25, 30]) {
    for (const thresholdMarginDb of [4, 5, 6, 8, 10, 12, 14, 16]) {
      for (const hysteresisDb of [1, 3, 5]) {
        configs.push({
          ...baseline,
          noisePercentile,
          thresholdMarginDb,
          hysteresisDb,
          minSoundingSeconds: 0.1,
          minSilenceSeconds: 0,
          padSoundingSeconds: 0,
        });
      }
    }
  }
  return uniqueConfigs(configs);
}

function buildFineConfigs(seeds, grid) {
  if (grid === 'quick') return seeds;
  const configs = [];
  for (const seed of seeds) {
    for (const minSoundingSeconds of [0.05, 0.08, 0.1, 0.25]) {
      for (const padSoundingSeconds of [0, 0.02]) {
        configs.push({ ...seed, minSoundingSeconds, minSilenceSeconds: 0, padSoundingSeconds });
      }
    }
  }
  return uniqueConfigs(configs);
}

function evaluateRawCandidates(configs, prepared, gold, stage) {
  return configs.map((vadOptions) => {
    const vad = computeLocalAcousticVadFromPrepared(prepared, vadOptions);
    return {
      candidate_id: candidateId({ vad: vadOptions }),
      stage,
      vad_options: vadOptions,
      vad_method: vad.method,
      raw_vad_metrics: compareVadToGold(vad.intervals, gold),
    };
  }).sort(compareRawCandidates);
}

function compareRawCandidates(left, right) {
  return right.raw_vad_metrics.acoustic_score - left.raw_vad_metrics.acoustic_score
    || right.raw_vad_metrics.activity.f1 - left.raw_vad_metrics.activity.f1
    || right.raw_vad_metrics.boundaries['0.100'].combined.f1 - left.raw_vad_metrics.boundaries['0.100'].combined.f1
    || left.candidate_id.localeCompare(right.candidate_id);
}

function compareFullCandidates(left, right) {
  const l = left.selection_vector;
  const r = right.selection_vector;
  return r.primary_active_set_exact_accuracy - l.primary_active_set_exact_accuracy
    || r.secondary_output_activity_score - l.secondary_output_activity_score
    || r.tertiary_macro_f1 - l.tertiary_macro_f1
    || left.candidate_id.localeCompare(right.candidate_id);
}

function compactRawCandidate(candidate) {
  return {
    candidate_id: candidate.candidate_id,
    stage: candidate.stage,
    vad_options: candidate.vad_options,
    threshold_dbfs: candidate.vad_method.threshold_dbfs,
    threshold_controller: candidate.vad_method.threshold_controller,
    room_activity_f1: candidate.raw_vad_metrics.activity.f1,
    room_boundary_f1_100ms: candidate.raw_vad_metrics.boundaries['0.100'].combined.f1,
    acoustic_score: candidate.raw_vad_metrics.acoustic_score,
  };
}

function compactFullCandidate(candidate) {
  const metrics = candidate.output_metrics;
  return {
    candidate_id: candidate.candidate_id,
    config: candidate.config,
    threshold_dbfs: candidate.vad_method.threshold_dbfs,
    threshold_controller: candidate.vad_method.threshold_controller,
    room_vad_f1: candidate.raw_vad_metrics.activity.f1,
    room_vad_boundary_f1_100ms: candidate.raw_vad_metrics.boundaries['0.100'].combined.f1,
    active_set_exact_accuracy: metrics.active_speaker_set.exact_accuracy,
    active_set_jaccard: metrics.active_speaker_set.time_weighted_jaccard,
    output_room_activity_f1: metrics.room_activity.f1,
    output_boundary_f1_10ms: metrics.active_boundaries.aggregate['0.010'].combined.f1,
    output_boundary_f1_100ms: metrics.active_boundaries.aggregate['0.100'].combined.f1,
    macro_f1_observed_labels: metrics.label_agreement.macro_f1_observed_gold_labels,
    floor_accuracy: metrics.floor.exact_accuracy,
    transition_event_f1: metrics.transition_events.f1,
    selection_vector: candidate.selection_vector,
  };
}

function metricDeltas(baseline, best) {
  return {
    active_set_exact_accuracy: best.active_speaker_set.exact_accuracy - baseline.active_speaker_set.exact_accuracy,
    active_set_jaccard: best.active_speaker_set.time_weighted_jaccard - baseline.active_speaker_set.time_weighted_jaccard,
    room_activity_f1: best.room_activity.f1 - baseline.room_activity.f1,
    boundary_f1_10ms: best.active_boundaries.aggregate['0.010'].combined.f1
      - baseline.active_boundaries.aggregate['0.010'].combined.f1,
    boundary_f1_100ms: best.active_boundaries.aggregate['0.100'].combined.f1
      - baseline.active_boundaries.aggregate['0.100'].combined.f1,
    macro_f1_observed_labels: best.label_agreement.macro_f1_observed_gold_labels
      - baseline.label_agreement.macro_f1_observed_gold_labels,
    floor_accuracy: best.floor.exact_accuracy - baseline.floor.exact_accuracy,
  };
}

function buildBestManifest(runId, best, inputLock, baselineMetrics, praatValidation) {
  return {
    contract_version: 'multilogue-v2.1-p025-calibrated-draft-manifest-v1',
    run_id: runId,
    status: 'calibrated_draft_not_holdout_validated_not_research_ready',
    fixed_research_definitions: FIXED_RESEARCH_DEFINITIONS,
    selected_config: best.config,
    threshold_method: best.vad_method,
    selection_vector: best.selection_vector,
    core_textgrid_validation: best.output.validation,
    core_output_digest: best.output.digest,
    praat_headless_validation: praatValidation,
    delta_vs_existing_baseline: metricDeltas(baselineMetrics, best.output_metrics),
    input_sha256: Object.fromEntries(Object.entries(inputLock.inputs).map(([key, value]) => [key, value.sha256])),
    network_used: false,
    production_default_changed: false,
    required_next_gate: 'locked_method_blind_validation_on_unseen_multilogue',
  };
}

function runPraatValidation(textGridPath, executable) {
  if (!existsSync(executable) || !existsSync(PRAAT_CHECK_SCRIPT)) {
    return { available: false, passed: false, reason: 'Praat executable or validation script not found' };
  }
  const result = spawnSync(executable, ['--run', PRAAT_CHECK_SCRIPT, textGridPath], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 30000,
  });
  const output = `${result.stdout || ''}${result.stderr || ''}`.trim();
  return {
    available: true,
    passed: result.status === 0 && output.includes('tiers=6')
      && output.includes('tier1=S1') && output.includes('tier6=flags'),
    exit_code: result.status,
    result: output.replaceAll(textGridPath, '[textgrid]').replaceAll(ROOT, '[repo]'),
  };
}

function buildReport(experiment, textGridPath) {
  const baseline = experiment.baseline.existing_draft_metrics;
  const best = experiment.selected_best_candidate;
  const rawBest = experiment.room_vad_best_diagnostic_only;
  const pct = (value) => `${(Number(value) * 100).toFixed(3)}%`;
  return [
    '# Multilogue04 P025 calibration report',
    '',
    `Run: ${experiment.run_id}`,
    '',
    '## Decision boundary',
    '',
    '- P=0.25, L=1.0, minimum overlap=0.100, Path B, label definitions, and floor rules were fixed.',
    '- Only local acoustic VAD and minimum-sounding post-processing parameters were swept.',
    '- Room-VAD quality and final six-tier quality were scored separately.',
    '- This uses the customer-corrected file for calibration, so it is not holdout validation.',
    '',
    '## Before and after',
    '',
    '| Metric | Existing draft | Selected candidate |',
    '|---|---:|---:|',
    `| Active-speaker-set exact | ${pct(baseline.active_speaker_set.exact_accuracy)} | ${pct(best.active_set_exact_accuracy)} |`,
    `| Active-set Jaccard | ${pct(baseline.active_speaker_set.time_weighted_jaccard)} | ${pct(best.active_set_jaccard)} |`,
    `| Output room-activity F1 | ${pct(baseline.room_activity.f1)} | ${pct(best.output_room_activity_f1)} |`,
    `| Active-boundary F1 at 10 ms | ${pct(baseline.active_boundaries.aggregate['0.010'].combined.f1)} | ${pct(best.output_boundary_f1_10ms)} |`,
    `| Active-boundary F1 at 100 ms | ${pct(baseline.active_boundaries.aggregate['0.100'].combined.f1)} | ${pct(best.output_boundary_f1_100ms)} |`,
    `| Macro F1, observed labels | ${pct(baseline.label_agreement.macro_f1_observed_gold_labels)} | ${pct(best.macro_f1_observed_labels)} |`,
    `| Floor exact accuracy | ${pct(baseline.floor.exact_accuracy)} | ${pct(best.floor_accuracy)} |`,
    '',
    '## Separate room-VAD result',
    '',
    `The best room-VAD diagnostic candidate reached ${pct(rawBest.room_activity_f1)} activity F1. It was not selected automatically as the overall candidate because final six-tier accuracy is the primary objective.`,
    '',
    '## Output',
    '',
    `Best candidate TextGrid: ${path.basename(textGridPath)}`,
    '',
    '## Residual work not solvable by parameter tuning',
    '',
    '- Filled pauses and backchannels require better transcript/event classification.',
    '- Short-turn speaker misattribution and missed intermediate turns require attribution/floor-logic changes.',
    '- Tier 5 must be regenerated from corrected floor transfers; Tier 6 needs an explicit benchmark-status convention.',
    '- Production defaults remain unchanged until an unseen multilogue passes blind validation.',
    '',
  ].join('\n');
}

function assertFixedResearchDefinitions(stage1Input, gold) {
  if (Number(stage1Input.interactionConfig?.floorReleaseSeconds) !== 1) throw new Error('Floor release L must remain 1.0 seconds');
  if (Number(stage1Input.interactionConfig?.minOverlapSeconds) !== 0.1) throw new Error('Minimum overlap must remain 0.100 seconds');
  if (stage1Input.interactionConfig?.overlapMode !== 'path_b_exclusive') throw new Error('Path B must remain fixed');
  if (Number(gold.xmax) !== Number(stage1Input.duration)) throw new Error('Stage-1 and gold duration mismatch');
  const names = gold.tiers.map((tier) => tier.name).join(',');
  if (names !== 'S1,S2,S3,floor,transitions,flags') throw new Error(`Unexpected gold tier schema: ${names}`);
}

function resolveOptions(userOptions) {
  return {
    ...DEFAULTS,
    ...userOptions,
    grid: userOptions.grid || 'full',
  };
}

function assertInputs(options) {
  for (const key of ['audio', 'gold', 'stage1', 'roomActivity', 'baselineTextGrid']) {
    if (!existsSync(options[key])) throw new Error(`${key} input does not exist: ${options[key]}`);
  }
  if (!['full', 'quick'].includes(options.grid)) throw new Error('grid must be full or quick');
}

function parseArgs(argv) {
  const options = {};
  const fields = new Map([
    ['--audio', 'audio'],
    ['--gold', 'gold'],
    ['--stage1', 'stage1'],
    ['--room-activity', 'roomActivity'],
    ['--baseline-textgrid', 'baselineTextGrid'],
    ['--output-dir', 'outputDir'],
    ['--run-id', 'runId'],
    ['--grid', 'grid'],
  ]);
  for (let index = 2; index < argv.length; index += 1) {
    const field = fields.get(argv[index]);
    if (!field || !argv[index + 1]) throw new Error(`Unknown or incomplete argument: ${argv[index]}`);
    options[field] = field === 'outputDir' ? path.resolve(argv[index + 1]) : argv[index + 1];
    if (['audio', 'gold', 'stage1', 'roomActivity', 'baselineTextGrid'].includes(field)) {
      options[field] = path.resolve(argv[index + 1]);
    }
    index += 1;
  }
  return options;
}

function buildRunId(options, stage1Input) {
  const digest = createHash('sha256')
    .update(readFileSync(options.gold))
    .update(readFileSync(options.stage1))
    .update(JSON.stringify({ grid: options.grid, definitions: FIXED_RESEARCH_DEFINITIONS }))
    .digest('hex')
    .slice(0, 12);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  return `${stamp}-${digest}-${stage1Input.recordingId || RECORDING_ID}`;
}

function candidateId(config) {
  return `candidate-${createHash('sha256').update(stableJson(config)).digest('hex').slice(0, 12)}`;
}

function uniqueConfigs(configs) {
  const unique = new Map();
  for (const config of configs) unique.set(stableJson(config), config);
  return [...unique.values()];
}

function dedupeCandidateResults(results) {
  const unique = new Map();
  for (const result of results) {
    const key = stableJson(result.vad_options);
    const existing = unique.get(key);
    if (!existing || compareRawCandidates(result, existing) < 0) unique.set(key, result);
  }
  return [...unique.values()].sort(compareRawCandidates);
}

function sameConfig(left, right) {
  return stableJson(left) === stableJson(right);
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

function fileRecord(file) {
  return {
    identifier: path.relative(ROOT, file).replaceAll(path.sep, '/'),
    sha256: createHash('sha256').update(readFileSync(file)).digest('hex'),
    bytes: readFileSync(file).length,
  };
}

function writeCsv(file, rows) {
  const columns = [
    'candidate_id', 'threshold_dbfs', 'threshold_controller', 'shared_min_sounding_seconds',
    'noise_percentile', 'threshold_margin_db', 'hysteresis_db', 'vad_min_sounding_seconds', 'pad_sounding_seconds',
    'room_vad_f1', 'room_vad_boundary_f1_100ms', 'active_set_exact_accuracy', 'active_set_jaccard',
    'output_room_activity_f1', 'output_boundary_f1_10ms', 'output_boundary_f1_100ms',
    'macro_f1_observed_labels', 'floor_accuracy', 'transition_event_f1',
  ];
  const values = rows.map((row) => ({
    ...row,
    shared_min_sounding_seconds: row.config.shared_min_sounding_seconds,
    noise_percentile: row.config.vad.noisePercentile,
    threshold_margin_db: row.config.vad.thresholdMarginDb,
    hysteresis_db: row.config.vad.hysteresisDb,
    vad_min_sounding_seconds: row.config.vad.minSoundingSeconds,
    pad_sounding_seconds: row.config.vad.padSoundingSeconds,
  }));
  const quote = (value) => {
    const text = value == null ? '' : String(value);
    return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
  };
  const output = [columns.join(','), ...values.map((row) => columns.map((column) => quote(row[column])).join(','))].join('\n');
  writeFileSync(file, `${output}\n`, 'utf8');
}

function main() {
  const result = runP025Calibration(parseArgs(process.argv));
  process.stdout.write(`${JSON.stringify({
    status: 'calibration_complete',
    run_id: result.runId,
    output_directory: result.outputDir,
    best_candidate_textgrid: result.bestTextGridPath,
    delta_active_set_exact_accuracy: result.experiment.deltas_vs_existing_baseline.active_set_exact_accuracy,
  }, null, 2)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) main();
