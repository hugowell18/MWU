#!/usr/bin/env node

import { createHash } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import JSZip from 'jszip';

import { scoreTextGrid } from './calibration/v23c-scorer.mjs';
import {
  CSV_SCHEMAS,
  SPEAKERS,
  SPEAKER_LABELS,
  canonicalJson,
  phonationIncluded,
  round,
} from './core/contracts.mjs';
import { validateSixTierTextGrid } from './core/validator.mjs';
import { writeFrozenCsv } from './io/artifact-utils.mjs';
import { parseSixTierTextGridFile } from './io/parse-six-tier-textgrid.mjs';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(SCRIPT_DIR, '../..');
const RECORDING_ID = 'Multilogue04_C_Level30_D1G4';
const TASK_ID = 'Multilogue04';
const THRESHOLD = 0.25;
const PACKAGE_NAME = 'Multilogue04_PathB_v2.1_Calibration_Update.zip';
const GUIDE_NAME = 'Multilogue04 Path B v2.1 Calibration Update.html';
const REVISION_ROOT = path.join(
  ROOT,
  'outputs/multilogue-v2-calibration',
  RECORDING_ID,
  'P025/v2.3za-r32-schema-valid-composition-20260809',
);
const REPLAY_ROOT = path.join(
  ROOT,
  'outputs/multilogue-v2-calibration',
  RECORDING_ID,
  'P025/blind-runner-r32-replay-v3-20260809',
);
const DELIVERY_ROOT = path.join(REVISION_ROOT, 'delivery');
const PACKAGE_ROOT = path.join(DELIVERY_ROOT, 'package');
const ZIP_PATH = path.join(DELIVERY_ROOT, PACKAGE_NAME);
const INITIAL_TEXTGRID = path.join(
  ROOT,
  'outputs/multilogue-v2-poc',
  RECORDING_ID,
  'phase-ii/P025/Multilogue04_C_Level30_D1G4.P025.draft.6tier.TextGrid',
);
const GOLD_TEXTGRID = path.join(
  ROOT,
  'outputs/multilogue-v2-poc/Multilogue04_C_Level30_D1G4_P025_corrected_6tier.TextGrid',
);
const R32_TEXTGRID = path.join(
  REVISION_ROOT,
  'candidates/candidates/r16-5a1550bf9eb3/Multilogue04_C_Level30_D1G4.P025.r16-5a1550bf9eb3.6tier.TextGrid',
);
const REPLAY_TEXTGRID = path.join(
  REPLAY_ROOT,
  'Multilogue04_C_Level30_D1G4.P025.v2.3-blind-draft.6tier.TextGrid',
);
const OVERLAP_EVIDENCE = path.join(
  ROOT,
  'outputs/multilogue-v2-poc',
  RECORDING_ID,
  'phase-ii/P025/overlap-capability-evidence.json',
);
const GUIDE_PATH = path.join(ROOT, 'html', GUIDE_NAME);
const TEST_REPORT = path.join(ROOT, 'tests/multilogue-v2-calibration/artifacts/test-report.json');
const RUNTIME_EVIDENCE = path.join(REPLAY_ROOT, 'runtime-evidence.json');
const METHOD_MANIFEST = path.join(REPLAY_ROOT, 'method-manifest.json');
const SCORE_REPORT = path.join(REVISION_ROOT, 'score.json');
const EDGE_REPORT = path.join(REVISION_ROOT, 'customer-edge-case-score.json');

const ZIP_DATE = new Date('2000-01-01T00:00:00.000Z');
const ALLOWED_EXTENSIONS = new Set(['.json', '.csv', '.textgrid', '.txt', '.html']);
const FORBIDDEN_EXTENSIONS = /\.(wav|mp3|m4a|flac|aac|ogg|rttm|tsv|xlsx)$/i;
const FORBIDDEN_CONTENT = [
  /\b(?:api|secret|access)[_-]?(?:key|token)\b\s*[:=]/i,
  /https?:\/\/[^\s"']+/i,
  /\/Users\/|\/home\/|\/root\//i,
  /"(?:transcript|utterances)"\s*:/i,
  /"words"\s*:\s*\[/i,
];

const FULL_METRICS = Object.freeze([
  ['active_set_exact_accuracy', 'Active-speaker exact accuracy', 'ratio'],
  ['active_set_jaccard', 'Active-speaker time-weighted Jaccard', 'ratio'],
  ['room_activity_f1', 'Room-activity F1', 'ratio'],
  ['boundary_f1_10ms', 'Boundary F1 within 10 ms', 'ratio'],
  ['boundary_f1_100ms', 'Boundary F1 within 100 ms', 'ratio'],
  ['floor_accuracy', 'Floor accuracy', 'ratio'],
  ['floor_mismatch_seconds', 'Floor mismatch', 'seconds'],
  ['macro_f1_observed_labels', 'Observed-label macro F1 (7/9 labels in Gold)', 'ratio'],
  ['schema_wide_macro_f1_9_labels', 'Schema-wide 9-label macro F1 (unsupported classes = 0)', 'ratio'],
  ['f_f1', 'Filled-hesitation F1', 'ratio'],
  ['bc_f1', 'Backchannel F1', 'ratio'],
  ['transition_matched', 'Matched transition events', 'count'],
  ['transition_false_positive', 'Transition false positives', 'count'],
  ['transition_false_negative', 'Transition false negatives', 'count'],
  ['transition_precision', 'Transition precision', 'ratio'],
  ['transition_recall', 'Transition recall', 'ratio'],
  ['tier5_handoff_f1_100ms', 'Tier 5 handoff F1 within 100 ms', 'ratio'],
]);
const CLIENT_PACKAGE_PATHS = Object.freeze([
  'README.txt',
  `P025/${RECORDING_ID}.P025.calibrated-candidate.6tier.TextGrid`,
  'P025/nine_label_intervals.csv',
  'P025/transition_evidence.csv',
  'P025/overlap-capability-evidence.json',
  'comparison/full-recording-metrics.csv',
]);

function readJson(file) {
  return JSON.parse(readFileSync(file, 'utf8'));
}

function writeJson(file, value) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, canonicalJson(value));
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function sha256File(file) {
  return sha256(readFileSync(file));
}

function ensureInputs() {
  for (const file of [
    INITIAL_TEXTGRID,
    GOLD_TEXTGRID,
    R32_TEXTGRID,
    REPLAY_TEXTGRID,
    OVERLAP_EVIDENCE,
    GUIDE_PATH,
    TEST_REPORT,
    RUNTIME_EVIDENCE,
    METHOD_MANIFEST,
    SCORE_REPORT,
    EDGE_REPORT,
  ]) {
    if (!existsSync(file)) throw new Error(`missing delivery input: ${file}`);
  }
}

function tierByName(document, name) {
  const tier = document.tiers.find((item) => item.name === name);
  if (!tier) throw new Error(`missing tier: ${name}`);
  return tier;
}

function intervalAt(intervals, time) {
  return intervals.find((interval) => interval.start <= time + 1e-9 && time < interval.end - 1e-9)
    || intervals.at(-1);
}

function overlapsNonemptyFlag(flags, start, end) {
  return flags.some((flag) => flag.text && flag.start < end - 1e-9 && flag.end > start + 1e-9);
}

function buildNineLabelRows(document) {
  const floorIntervals = tierByName(document, 'floor').intervals;
  const flagIntervals = tierByName(document, 'flags').intervals;
  return SPEAKERS.flatMap((speaker) => tierByName(document, speaker).intervals.map((interval) => {
    const midpoint = (interval.start + interval.end) / 2;
    return {
      recording_id: RECORDING_ID,
      task_id: TASK_ID,
      threshold_sec: THRESHOLD,
      speaker,
      start_sec: round(interval.start),
      end_sec: round(interval.end),
      duration_sec: round(interval.end - interval.start),
      label: interval.text,
      floor: intervalAt(floorIntervals, midpoint)?.text || 'FREE',
      phonation_included_default: phonationIncluded(interval.text),
      review_required: overlapsNonemptyFlag(flagIntervals, interval.start, interval.end),
    };
  }));
}

function buildFlagRows(document) {
  return tierByName(document, 'flags').intervals.flatMap((interval) => {
    if (!interval.text) return [];
    return interval.text.split('|').map((code) => ({
      recording_id: RECORDING_ID,
      task_id: TASK_ID,
      threshold_sec: THRESHOLD,
      start_sec: round(interval.start),
      end_sec: round(interval.end),
      duration_sec: round(interval.end - interval.start),
      code,
      severity: 'review',
      source: 'r32_composed_tier6',
      related_id: '',
    }));
  });
}

function buildTransitionRows(runtime) {
  const evidence = runtime.semantic_lane.interaction_diagnostics.transition_evidence;
  return evidence.map((item) => ({
    recording_id: RECORDING_ID,
    task_id: TASK_ID,
    threshold_sec: THRESHOLD,
    sequence: item.sequence,
    from_speaker: item.from,
    to_speaker: item.to,
    outgoing_offset_sec: round(item.turn_end),
    incoming_onset_sec: round(item.turn_start),
    fto_sec: item.fto_status === 'provisional' ? round(item.raw_gap) : null,
    sign: item.fto_status !== 'provisional' ? 'missing'
      : item.raw_gap > 0 ? 'positive' : item.raw_gap < 0 ? 'negative' : 'zero',
    status: item.fto_status,
    review_required: true,
  }));
}

function buildTransitionEvidenceRows(runtime) {
  return runtime.semantic_lane.interaction_diagnostics.transition_evidence.map((item) => ({
    recording_id: RECORDING_ID,
    task_id: TASK_ID,
    threshold_sec: THRESHOLD,
    sequence: item.sequence,
    from_speaker: item.from,
    to_speaker: item.to,
    turn_end_sec: round(item.turn_end),
    turn_start_sec: round(item.turn_start),
    raw_gap_sec: round(item.raw_gap),
    overlap_start_sec: item.overlap_start == null ? null : round(item.overlap_start),
    overlap_end_sec: item.overlap_end == null ? null : round(item.overlap_end),
    overlap_duration_sec: item.overlap_duration == null ? null : round(item.overlap_duration),
    overlap_class: item.overlap_class,
    evidence_source: item.evidence_source,
    evidence_ids: item.evidence_ids || [],
    fto_status: item.fto_status,
    review_required: item.review_required !== false,
  }));
}

function buildInteractionRows(document, transitionRows) {
  const floorIntervals = tierByName(document, 'floor').intervals;
  return SPEAKERS.map((speaker) => {
    const intervals = tierByName(document, speaker).intervals;
    const totals = Object.fromEntries(SPEAKER_LABELS.map((label) => [label, 0]));
    const counts = Object.fromEntries(SPEAKER_LABELS.map((label) => [label, 0]));
    for (const interval of intervals) {
      totals[interval.text] += interval.end - interval.start;
      counts[interval.text] += 1;
    }
    return {
      recording_id: RECORDING_ID,
      task_id: TASK_ID,
      threshold_sec: THRESHOLD,
      speaker,
      total_duration_sec: round(document.xmax),
      phonation_time_sec: round(intervals
        .filter((interval) => phonationIncluded(interval.text))
        .reduce((sum, interval) => sum + interval.end - interval.start, 0)),
      s_sec: round(totals.s),
      f_sec: round(totals.f),
      bc_sec: round(totals.bc),
      ol_sec: round(totals.ol),
      op_sec: round(totals.op),
      pf_sec: round(totals.pf),
      tr_sec: round(totals.tr),
      shs_sec: round(totals.shs),
      x_sec: round(totals.x),
      op_count: counts.op,
      bc_count: counts.bc,
      ol_count: counts.ol,
      floor_turns_held: floorIntervals.filter((interval) => interval.text === speaker).length,
      incoming_fto_values: transitionRows
        .filter((row) => row.to_speaker === speaker && row.fto_sec != null)
        .map((row) => row.fto_sec),
    };
  });
}

function metricDirection(key, delta) {
  if (Math.abs(delta) < 1e-12) return 'unchanged';
  const lowerIsBetter = key === 'floor_mismatch_seconds'
    || key === 'transition_false_positive'
    || key === 'transition_false_negative';
  return (lowerIsBetter ? delta < 0 : delta > 0) ? 'improved' : 'regressed';
}

function buildMetricRows(initial, calibrated, observedGoldLabelCount) {
  const enrich = (metrics) => ({
    ...metrics,
    schema_wide_macro_f1_9_labels: round(
      metrics.macro_f1_observed_labels * observedGoldLabelCount / SPEAKER_LABELS.length,
    ),
    transition_recall: round(metrics.transition_matched / metrics.transition_gold),
  });
  const initialMetrics = enrich(initial);
  const calibratedMetrics = enrich(calibrated);
  return FULL_METRICS.map(([key, label, unit]) => {
    const delta = round(calibratedMetrics[key] - initialMetrics[key]);
    return {
      metric: label,
      initial_v2_1: initialMetrics[key],
      calibrated_candidate: calibratedMetrics[key],
      delta,
      unit,
      direction: metricDirection(key, delta),
    };
  });
}

function buildEdgeRows(edgeReport) {
  const wanted = [
    ['floor_exact_accuracy', 'Floor accuracy', 'ratio'],
    ['active_set_exact_accuracy', 'Active-speaker exact accuracy', 'ratio'],
    ['boundary_f1_100ms', 'Boundary F1 within 100 ms', 'ratio'],
    ['bc_f1', 'Backchannel F1', 'ratio'],
    ['tr_interval_f1', 'Transition-interval F1', 'ratio'],
    ['bc_seconds', 'Backchannel duration', 'seconds'],
    ['tr_seconds', 'Transition duration', 'seconds'],
  ];
  return edgeReport.windows.flatMap((window) => wanted.map(([key, label, unit]) => ({
    case_id: window.id,
    window_start_sec: window.start,
    window_end_sec: window.end,
    metric: label,
    initial_v2_1: window.versions.original_v21[key],
    calibrated_candidate: window.versions.latest[key],
    delta: round(window.versions.latest[key] - window.versions.original_v21[key]),
    unit,
    outcome: window.id === 'tail_spurious_transitions' ? 'converged_on_benchmark' : 'partially_converged',
  })));
}

function writePackageArtifacts() {
  const initialDocument = parseSixTierTextGridFile(INITIAL_TEXTGRID);
  const goldDocument = parseSixTierTextGridFile(GOLD_TEXTGRID);
  const calibratedDocument = parseSixTierTextGridFile(R32_TEXTGRID);
  const validation = validateSixTierTextGrid(calibratedDocument);
  if (!validation.valid) throw new Error(`R32 schema validation failed: ${validation.errors.join('; ')}`);
  if (Math.abs(initialDocument.xmax - goldDocument.xmax) > 1e-9
      || Math.abs(calibratedDocument.xmax - goldDocument.xmax) > 1e-9) {
    throw new Error('comparison TextGrids do not share the canonical duration');
  }

  const initialMetrics = scoreTextGrid(INITIAL_TEXTGRID, GOLD_TEXTGRID);
  const calibratedMetrics = scoreTextGrid(R32_TEXTGRID, GOLD_TEXTGRID);
  const scoreReport = readJson(SCORE_REPORT);
  const edgeReport = readJson(EDGE_REPORT);
  const runtime = readJson(RUNTIME_EVIDENCE);
  const tests = readJson(TEST_REPORT);
  const methodSource = readJson(METHOD_MANIFEST);

  const p025Dir = path.join(PACKAGE_ROOT, 'P025');
  const comparisonDir = path.join(PACKAGE_ROOT, 'comparison');
  const validationDir = path.join(PACKAGE_ROOT, 'validation');
  mkdirSync(p025Dir, { recursive: true });
  mkdirSync(comparisonDir, { recursive: true });
  mkdirSync(validationDir, { recursive: true });

  copyFileSync(
    R32_TEXTGRID,
    path.join(p025Dir, `${RECORDING_ID}.P025.calibrated-candidate.6tier.TextGrid`),
  );
  copyFileSync(INITIAL_TEXTGRID, path.join(comparisonDir, 'Initial_v2.1.P025.6tier.TextGrid'));
  copyFileSync(GOLD_TEXTGRID, path.join(comparisonDir, 'Researcher_corrected_reference.P025.6tier.TextGrid'));
  copyFileSync(OVERLAP_EVIDENCE, path.join(p025Dir, 'overlap-capability-evidence.json'));
  copyFileSync(TEST_REPORT, path.join(validationDir, 'regression-test-report.json'));
  copyFileSync(GUIDE_PATH, path.join(PACKAGE_ROOT, 'Delivery Guide.html'));

  const transitionRows = buildTransitionRows(runtime);
  const transitionEvidenceRows = buildTransitionEvidenceRows(runtime);
  writeFrozenCsv(path.join(p025Dir, 'nine_label_intervals.csv'), CSV_SCHEMAS.nine_label_intervals, buildNineLabelRows(calibratedDocument));
  writeFrozenCsv(path.join(p025Dir, 'flags.csv'), CSV_SCHEMAS.flags, buildFlagRows(calibratedDocument));
  writeFrozenCsv(path.join(p025Dir, 'fto_transitions.csv'), CSV_SCHEMAS.fto_transitions, transitionRows);
  writeFrozenCsv(path.join(p025Dir, 'transition_evidence.csv'), CSV_SCHEMAS.transition_evidence, transitionEvidenceRows);
  writeFrozenCsv(path.join(p025Dir, 'interaction_summary.csv'), CSV_SCHEMAS.interaction_summary, buildInteractionRows(calibratedDocument, transitionRows));

  const methodManifest = {
    contract_version: 'multilogue-v2.1-calibration-delivery-method-v1',
    status: 'calibrated_candidate_not_frozen',
    recording_id: RECORDING_ID,
    task_id: TASK_ID,
    threshold_seconds: THRESHOLD,
    methodology: {
      path: 'B',
      rule_set: 'R1-R5-v2.1-locked',
      six_tier_schema: methodSource.methodology.six_tier_schema,
      nine_labels: methodSource.methodology.nine_labels,
      frozen_candidate_config: methodSource.methodology.frozen_blind_config,
      acoustic_topology_source: methodSource.methodology.activity_topology_source,
      semantic_floor_source: methodSource.methodology.floor_source,
      transition_source: methodSource.methodology.transition_source,
    },
    provider_roles: {
      pyannoteAI: 'cached speaker-conditioned acoustic evidence',
      AssemblyAI: 'cached semantic and speaker-attribution draft evidence',
      Praat: 'expert inspection and correction environment',
    },
    generation_controls: {
      runtime_gold_access: false,
      network_used_during_candidate_generation: false,
      source_separation_claim: false,
      original_wav_is_master_clock: true,
    },
    assessment: {
      researcher_reference_used_for: ['scoring', 'parameter selection'],
      researcher_reference_used_as_runtime_input: false,
      cross_recording_validation: 'pending',
      expert_review_required: true,
    },
    input_evidence: methodSource.inputs,
  };
  writeJson(path.join(p025Dir, 'method-manifest.json'), methodManifest);
  writeJson(path.join(p025Dir, 'timeline-validation.json'), {
    contract_version: 'multilogue-v2.1-calibration-timeline-validation-v1',
    status: validation.valid ? 'passed' : 'failed',
    ...validation,
    tier5_internal_consistency: readJson(path.join(REPLAY_ROOT, 'validation-summary.json')).tier5_internal_consistency,
  });
  writeJson(path.join(p025Dir, 'run-summary.json'), {
    contract_version: 'multilogue-v2.1-calibration-run-summary-v1',
    status: 'calibrated_candidate_not_frozen',
    recording_id: RECORDING_ID,
    task_id: TASK_ID,
    threshold_seconds: THRESHOLD,
    duration_seconds: calibratedDocument.xmax,
    full_recording_metrics: calibratedMetrics,
    transition_evidence_count: transitionEvidenceRows.length,
    flag_rows: buildFlagRows(calibratedDocument).length,
    review_requirement: 'Expert Praat correction remains required.',
    calibration_boundary: 'Measured only against the Multilogue04 P025 researcher reference.',
  });

  const observedGoldLabelCount = new Set(
    SPEAKERS.flatMap((speaker) => tierByName(goldDocument, speaker).intervals.map((interval) => interval.text)),
  ).size;
  const metricRows = buildMetricRows(initialMetrics, calibratedMetrics, observedGoldLabelCount);
  writeFrozenCsv(
    path.join(comparisonDir, 'full-recording-metrics.csv'),
    ['metric', 'initial_v2_1', 'calibrated_candidate', 'delta', 'unit', 'direction'],
    metricRows,
  );
  writeFrozenCsv(
    path.join(comparisonDir, 'customer-edge-cases.csv'),
    ['case_id', 'window_start_sec', 'window_end_sec', 'metric', 'initial_v2_1', 'calibrated_candidate', 'delta', 'unit', 'outcome'],
    buildEdgeRows(edgeReport),
  );
  writeJson(path.join(comparisonDir, 'comparison-summary.json'), {
    contract_version: 'multilogue-v2.1-calibration-comparison-v1',
    recording_id: RECORDING_ID,
    threshold_seconds: THRESHOLD,
    reference_duration_seconds: goldDocument.xmax,
    initial_v2_1: initialMetrics,
    calibrated_candidate: calibratedMetrics,
    delta: Object.fromEntries(Object.keys(calibratedMetrics)
      .filter((key) => Number.isFinite(initialMetrics[key]) && Number.isFinite(calibratedMetrics[key]))
      .map((key) => [key, round(calibratedMetrics[key] - initialMetrics[key])])),
    customer_reported_edge_cases: edgeReport.windows.map((window) => ({
      id: window.id,
      start_sec: window.start,
      end_sec: window.end,
      outcome: window.id === 'tail_spurious_transitions' ? 'converged_on_benchmark' : 'partially_converged',
      initial_v2_1: window.versions.original_v21,
      calibrated_candidate: window.versions.latest,
    })),
    evidence_boundary: {
      supported: 'Measured improvement on the complete Multilogue04 P025 researcher reference.',
      not_supported: 'Cross-recording accuracy or research-ready output without expert correction.',
    },
  });

  const r32Hash = sha256File(R32_TEXTGRID);
  const replayHash = sha256File(REPLAY_TEXTGRID);
  writeJson(path.join(validationDir, 'replay-integrity.json'), {
    contract_version: 'multilogue-v2.1-calibration-replay-integrity-v1',
    calibrated_candidate: {
      name: path.basename(R32_TEXTGRID),
      bytes: statSync(R32_TEXTGRID).size,
      sha256: r32Hash,
    },
    official_runner_replay: {
      name: path.basename(REPLAY_TEXTGRID),
      bytes: statSync(REPLAY_TEXTGRID).size,
      sha256: replayHash,
    },
    byte_identical: r32Hash === replayHash && readFileSync(R32_TEXTGRID).equals(readFileSync(REPLAY_TEXTGRID)),
    schema_valid: validation.valid,
  });
  writeJson(path.join(validationDir, 'G3-calibration-gate.json'), {
    contract_version: 'multilogue-v2.1-calibration-gate-v1',
    status: 'calibrated_candidate_not_frozen',
    schema_validation: validation.valid ? 'passed' : 'failed',
    regression_tests: { status: tests.status, passed: tests.passed, failed: tests.failed },
    deterministic_replay: r32Hash === replayHash ? 'passed' : 'failed',
    formal_kpi_gate: scoreReport.formal_gate,
    gate_summary: '7 of 8 formal KPIs met; boundary F1 at 100 ms missed the 0.75 target by 0.008887.',
    freeze_allowed: false,
    freeze_blockers: [
      'boundary_f1_100ms_below_0.75_target',
      'complex_overlap_listener_backchannel_only_partially_recovered',
      'independent_multilogue_blind_validation_not_completed',
    ],
  });

  writeFileSync(path.join(PACKAGE_ROOT, 'README.txt'), [
    'Multilogue04 Path B v2.1 Calibration Update',
    '',
    'Purpose',
    'This package compares the initial v2.1 P025 draft with the revised calibrated candidate using the complete researcher-corrected Multilogue04 P025 reference.',
    '',
    'Measured result',
    '- Active-speaker exact accuracy: 78.50% -> 85.83%.',
    '- Boundary F1 within 100 ms: 63.05% -> 74.11%.',
    '- Observed-label macro F1 (7 of 9 labels present in Gold): 66.72% -> 72.26%.',
    '- Schema-wide 9-label macro F1 with unsupported classes scored as zero: 51.89% -> 56.20%.',
    '- Backchannel F1: 23.95% -> 42.65%.',
    '- Tier 5 handoff F1 within 100 ms: 61.90% -> 75.00%.',
    '- Transition recall improved: 76.47% -> 88.24%.',
    '- Transition precision regressed: 76.47% -> 62.50%. Of nine scorer false positives, seven overlap an existing Gold event and two are genuinely spurious near 432 seconds.',
    '- Handoff scoring uses the corrected Tier 4 floor as the authoritative reference; Gold Tier 5 points are not used.',
    '- The Gold contains no ol intervals, so overlap accuracy is not reported.',
    '',
    'Status',
    '- The six-tier schema, nine labels, R1-R5 rules and Path B method are unchanged.',
    '- P025 is calibrated on Multilogue04; P035 is not claimed as calibrated.',
    '- This is a calibrated candidate, not a frozen cross-recording baseline.',
    '- Expert Praat review and correction remain required.',
    '',
    'Security boundary',
    '- No audio, transcript text, provider payload, credentials, URLs or absolute local paths are included.',
    '',
  ].join('\n'));

  return { validation, initialMetrics, calibratedMetrics };
}

function listFiles(directory, base = directory) {
  return readdirSync(directory, { withFileTypes: true })
    .flatMap((entry) => {
      const absolute = path.join(directory, entry.name);
      return entry.isDirectory() ? listFiles(absolute, base) : [path.relative(base, absolute).replaceAll(path.sep, '/')];
    })
    .sort();
}

function scanSafeArtifact(relativePath, content) {
  if (path.isAbsolute(relativePath) || relativePath.includes('..')) throw new Error(`unsafe package path: ${relativePath}`);
  if (FORBIDDEN_EXTENSIONS.test(relativePath)) throw new Error(`forbidden package type: ${relativePath}`);
  const extension = path.extname(relativePath).toLowerCase();
  if (!ALLOWED_EXTENSIONS.has(extension)) throw new Error(`unsupported package type: ${relativePath}`);
  const text = content.toString('utf8');
  for (const rule of FORBIDDEN_CONTENT) {
    if (rule.test(text)) throw new Error(`safety scan failed for ${relativePath}: ${rule}`);
  }
}

async function buildZip() {
  const availablePaths = new Set(listFiles(PACKAGE_ROOT));
  const sourcePaths = [...CLIENT_PACKAGE_PATHS];
  for (const relativePath of sourcePaths) {
    if (!availablePaths.has(relativePath)) throw new Error(`missing client package artifact: ${relativePath}`);
  }
  const sources = sourcePaths.map((relativePath) => {
    const content = readFileSync(path.join(PACKAGE_ROOT, relativePath));
    scanSafeArtifact(relativePath, content);
    return { path: relativePath, content, bytes: content.length, sha256: sha256(content) };
  });
  const contentsDigest = sha256(Buffer.from(canonicalJson(sources.map(({ path: name, bytes, sha256: digest }) => ({
    path: name,
    bytes,
    sha256: digest,
  })))));
  const zip = new JSZip();
  for (const source of sources) zip.file(source.path, source.content, { date: ZIP_DATE, createFolders: false });
  const buffer = await zip.generateAsync({
    type: 'nodebuffer',
    compression: 'DEFLATE',
    compressionOptions: { level: 9 },
  });
  writeFileSync(ZIP_PATH, buffer);
  return {
    zip_path: ZIP_PATH,
    zip_bytes: buffer.length,
    zip_sha256: sha256(buffer),
    entry_count: sources.length,
    contents_sha256: contentsDigest,
    contents: sources.map(({ path: name, bytes, sha256: digest }) => ({ path: name, bytes, sha256: digest })),
  };
}

export async function buildR32CalibrationDelivery() {
  ensureInputs();
  rmSync(DELIVERY_ROOT, { recursive: true, force: true });
  mkdirSync(PACKAGE_ROOT, { recursive: true });
  const metrics = writePackageArtifacts();
  const archive = await buildZip();
  if (archive.entry_count !== 6) throw new Error(`expected 6 ZIP entries; received ${archive.entry_count}`);
  const report = {
    contract_version: 'multilogue-v2.1-calibration-delivery-build-v1',
    status: 'passed',
    ...archive,
    metrics: {
      initial_v2_1: metrics.initialMetrics,
      calibrated_candidate: metrics.calibratedMetrics,
    },
  };
  writeJson(path.join(DELIVERY_ROOT, 'build-report.json'), report);
  return report;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  buildR32CalibrationDelivery()
    .then((report) => process.stdout.write(canonicalJson(report)))
    .catch((error) => {
      process.stderr.write(`${error.stack || error.message}\n`);
      process.exitCode = 1;
    });
}
