#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { validateSixTierTextGrid } from '../core/validator.mjs';
import { parseSixTierTextGridFile } from '../io/parse-six-tier-textgrid.mjs';
import { scoreTextGrid } from './v23c-scorer.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const RECORDING_ID = 'Multilogue04_C_Level30_D1G4';
const CALIBRATION_ROOT = path.join(ROOT, 'outputs', 'multilogue-v2-calibration', RECORDING_ID, 'P025');
const R32_ROOT = path.join(CALIBRATION_ROOT, 'v2.3za-r32-schema-valid-composition-20260809');
const R19_SCORE = path.join(CALIBRATION_ROOT, 'v2.3n-r19-offset-search-a-20260809', 'score.json');
const ORIGINAL = path.join(
  ROOT,
  'outputs',
  'multilogue-v2-poc',
  RECORDING_ID,
  'phase-ii',
  'P025',
  `${RECORDING_ID}.P025.draft.6tier.TextGrid`,
);
const GOLD = path.join(ROOT, 'outputs', 'multilogue-v2-poc', `${RECORDING_ID}_P025_corrected_6tier.TextGrid`);
const BLIND_REPLAY = path.join(
  CALIBRATION_ROOT,
  'blind-runner-r32-replay-v3-20260809',
  `${RECORDING_ID}.P025.v2.3-blind-draft.6tier.TextGrid`,
);
const TEST_REPORT = path.join(ROOT, 'tests', 'multilogue-v2-calibration', 'artifacts', 'test-report.json');

export function buildR32TechnicalAssessment({ outputDir = R32_ROOT } = {}) {
  const r32Report = readJson(path.join(R32_ROOT, 'r25-report.json'));
  const r32 = r32Report.winner.textgrid;
  const r19 = readJson(R19_SCORE).winner.textgrid;
  const files = { original_v21: ORIGINAL, r19, r32, gold: GOLD, blind_replay: BLIND_REPLAY };
  const metrics = {
    original_v21: scoreTextGrid(ORIGINAL, GOLD),
    r19: scoreTextGrid(r19, GOLD),
    r32: scoreTextGrid(r32, GOLD),
  };
  const validation = validateSixTierTextGrid(parseSixTierTextGridFile(r32));
  const testReport = readJson(TEST_REPORT);
  const r32Hash = sha256(r32);
  const blindReplayHash = sha256(BLIND_REPLAY);
  const edgeCases = readJson(path.join(R32_ROOT, 'customer-edge-case-score.json'));
  const report = {
    contract_version: 'multilogue-v2.3-r32-technical-assessment-v1',
    candidate_status: 'calibrated_candidate_pending_dual_provider_blind_validation',
    methodology: {
      path: 'B',
      pause_threshold_seconds: 0.25,
      nine_label_schema_unchanged: true,
      floor_rules_unchanged: 'R1-R5-v2.1-locked',
      runtime_gold_access: false,
      gold_usage: 'assessment_only',
    },
    files,
    integrity: {
      schema_valid: validation.valid,
      schema_errors: validation.errors,
      blind_runner_replay_byte_identical: r32Hash === blindReplayHash,
      r32_sha256: r32Hash,
      blind_replay_sha256: blindReplayHash,
      regression_tests: {
        status: testReport.status,
        passed: testReport.passed,
        failed: testReport.failed,
      },
    },
    full_recording_metrics: metrics,
    delta_r32_vs_original_v21: numericDelta(metrics.r32, metrics.original_v21),
    delta_r32_vs_r19: numericDelta(metrics.r32, metrics.r19),
    customer_reported_edge_cases: edgeCases.windows,
    decision: {
      complex_overlap_question_answer: 'partially_converged',
      tail_spurious_transitions: 'converged_on_calibration_recording',
      freeze_allowed: false,
      freeze_blockers: [
        'boundary_f1_100ms_is_0.741113_below_0.75_gate',
        'complex_window_missing_S1_backchannel_has_no_runtime_input_evidence',
        'second_multilogue_dual_provider_researcher_gold_not_available',
      ],
    },
  };
  if (!validation.valid) throw new Error(`R32 schema validation failed: ${validation.errors.join('; ')}`);
  if (r32Hash !== blindReplayHash) throw new Error('R32 blind runner replay is not byte-identical');
  if (testReport.status !== 'passed' || Number(testReport.failed) !== 0) throw new Error('regression suite is not green');
  mkdirSync(outputDir, { recursive: true });
  const jsonFile = path.join(outputDir, 'technical-assessment.json');
  const markdownFile = path.join(outputDir, 'technical-assessment.md');
  writeJson(jsonFile, report);
  writeFileSync(markdownFile, markdown(report), 'utf8');
  return { report, jsonFile, markdownFile };
}

function markdown(report) {
  const m = report.full_recording_metrics.r32;
  const complex = report.customer_reported_edge_cases.find((item) => item.id === 'complex_overlap_question_answer');
  const tail = report.customer_reported_edge_cases.find((item) => item.id === 'tail_spurious_transitions');
  return `# R32 Technical Assessment\n\n`
    + `Status: **${report.candidate_status}**\n\n`
    + `- Schema valid: ${report.integrity.schema_valid}\n`
    + `- Blind-runner replay byte-identical: ${report.integrity.blind_runner_replay_byte_identical}\n`
    + `- Regression tests: ${report.integrity.regression_tests.passed} passed, ${report.integrity.regression_tests.failed} failed\n`
    + `- Active-set exact accuracy: ${m.active_set_exact_accuracy}\n`
    + `- Boundary F1 at 100 ms: ${m.boundary_f1_100ms}\n`
    + `- Floor accuracy: ${m.floor_accuracy}\n`
    + `- Transition precision: ${m.transition_precision}\n`
    + `- Nine-label macro F1: ${m.macro_f1_observed_labels}\n`
    + `- Backchannel F1: ${m.bc_f1}\n\n`
    + `## Client Edge Cases\n\n`
    + `- Complex overlap/question/answer: partial. bc F1 ${complex.versions.latest.bc_f1}; floor accuracy ${complex.versions.latest.floor_exact_accuracy}; two handoffs retained.\n`
    + `- Tail spurious transitions: converged on this recording. tr seconds ${tail.versions.latest.tr_seconds}; false handoffs ${tail.versions.latest.floor_handoffs.length}; bc F1 ${tail.versions.latest.bc_f1}.\n\n`
    + `## Freeze Decision\n\n`
    + `R32 is not frozen. A second dual-provider multilogue with researcher correction is still required.\n`;
}

function numericDelta(after, before) {
  return Object.fromEntries(Object.keys(after).filter((key) => Number.isFinite(Number(after[key]))
    && Number.isFinite(Number(before[key]))).map((key) => [
      key,
      Number((Number(after[key]) - Number(before[key])).toFixed(9)),
    ]));
}

function sha256(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

function readJson(file) {
  return JSON.parse(readFileSync(file, 'utf8'));
}

function writeJson(file, value) {
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = buildR32TechnicalAssessment();
  process.stdout.write(`${JSON.stringify({ json: result.jsonFile, markdown: result.markdownFile }, null, 2)}\n`);
}
