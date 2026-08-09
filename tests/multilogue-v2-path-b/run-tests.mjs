import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { CSV_SCHEMAS, canonicalJson, sha256 } from '../../scripts/multilogue-v2/core/contracts.mjs';
import { runMultilogueV2, validateInitialFlags } from '../../scripts/multilogue-v2/core/pipeline.mjs';
import { serializeTextGrid } from '../../scripts/multilogue-v2/core/textgrid.mjs';
import { validateSixTierTextGrid } from '../../scripts/multilogue-v2/core/validator.mjs';
import { finalizeReviewedPathB } from '../../scripts/multilogue-v2/finalize-reviewed-path-b.mjs';
import { sha256File } from '../../scripts/multilogue-v2/io/artifact-utils.mjs';
import { parseSixTierTextGridFile } from '../../scripts/multilogue-v2/io/parse-six-tier-textgrid.mjs';
import {
  NO_NETWORK_REQUIRED_SOURCE_IDS,
  evaluateNoNetworkEvidence,
  evaluateReviewStrategyEvidence,
  gateStatusFromChecks,
  noNetworkSourceDocuments,
  runPathBPoc,
} from '../../scripts/multilogue-v2/run-path-b-poc.mjs';
import { syntheticPipelineInput } from '../multilogue-v2/fixtures.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.dirname(path.dirname(here));
const artifactDir = path.join(here, 'artifacts');
rmSync(artifactDir, { recursive: true, force: true });
mkdirSync(artifactDir, { recursive: true });
const tempRoot = mkdtempSync(path.join(os.tmpdir(), 'mwu-g2-path-b-'));
const results = [];

await test('G2 validates, preserves and isolates initial unknown-residual flags', () => {
  const base = syntheticPipelineInput();
  base.interactionConfig.overlapMode = 'path_b_exclusive';
  base.stage1UnknownEvidence = [{
    id: 'unknown-residual-1', speaker: 'S1', start: 3.6, end: 3.7,
    provisional_kind: 'unknown', lexical_class: 'unknown', evidence_state: 'unknown', tokens: [],
  }];
  base.initialFlags = [{
    start: 3.6, end: 3.7, code: 'unclassified_non_word_activity', severity: 'review',
    source: 'stage1_adapter', related_id: 'unknown-residual-1',
  }];
  const withoutUnknown = structuredClone(base);
  withoutUnknown.stage1UnknownEvidence = [];
  withoutUnknown.initialFlags = [];
  const run = runMultilogueV2(base);
  const control = runMultilogueV2(withoutUnknown);
  assert.equal(run.reusable_inputs.initial_flag_accepted_count, 1);
  assert.deepEqual(run.thresholds.P250.rows.nine_label_intervals, control.thresholds.P250.rows.nine_label_intervals);
  assert.equal(run.thresholds.P250.rows.flags.filter((row) => row.related_id === 'unknown-residual-1').length, 1);
  assert.throws(() => validateInitialFlags([...base.initialFlags, ...base.initialFlags], {
    duration: base.duration,
    stage1Evidence: base.stage1Evidence,
    stage1UnknownEvidence: base.stage1UnknownEvidence,
  }), /duplicate evidence/);
});

const firstOutput = path.join(tempRoot, 'first', 'phase-ii');
const secondOutput = path.join(tempRoot, 'second', 'phase-ii');
let firstGate;
let secondGate;

await test('G2 real cached input produces independent P025 and P035 packages', () => {
  firstGate = runPathBPoc({ outputDir: firstOutput });
  assert.equal(firstGate.status, 'pass');
  assert.deepEqual(Object.keys(firstGate.thresholds), ['P025', 'P035']);
  assert.notEqual(firstGate.thresholds.P025.core_output_digest, firstGate.thresholds.P035.core_output_digest);
  assert.equal(firstGate.thresholds.P025.initial_flag_check.preserved_once_count, 771);
  assert.equal(firstGate.thresholds.P035.initial_flag_check.preserved_once_count, 771);
  assert.equal(firstGate.input.provider_overlap_candidate_count, 18);
  assert.equal(firstGate.input.provider_overlap_candidate_duration_sec, 9.451);
  assert.equal(firstGate.input.provider_overlap_subthreshold_count, 7);
  assert.equal(firstGate.input.provider_overlap_subthreshold_duration_sec, 0.403);
});

await test('G2 propagates real provider overlap candidates as review-only evidence', () => {
  for (const key of ['P025', 'P035']) {
    const report = firstGate.thresholds[key];
    assert.equal(report.provider_overlap_check.pass, true);
    assert.equal(report.provider_overlap_check.candidate_count, 18);
    assert.equal(report.provider_overlap_check.candidate_duration_sec, 9.451);
    assert.equal(report.provider_overlap_check.subthreshold_count, 7);
    assert.equal(report.provider_overlap_check.subthreshold_duration_sec, 0.403);
    assert.equal(report.provider_overlap_check.evidence_count, 25);
    assert.equal(report.label_summary.S1.ol.duration_sec, 0);
    const manifest = JSON.parse(readFileSync(path.join(firstOutput, key, 'method-manifest.json')));
    assert.equal(manifest.draft_observation_availability.ol.status, 'unavailable_in_draft');
    assert.equal(manifest.draft_observation_availability.x.status, 'unavailable_in_draft');
  }
});

await test('G2 outputs exactly six valid full-coverage Praat tiers', () => {
  for (const key of ['P025', 'P035']) {
    const file = path.join(firstOutput, key, `Multilogue04_C_Level30_D1G4.${key}.draft.6tier.TextGrid`);
    const document = parseSixTierTextGridFile(file);
    const validation = validateSixTierTextGrid(document);
    assert.equal(document.tiers.length, 6);
    assert.deepEqual(document.tiers.map((tier) => tier.name), ['S1', 'S2', 'S3', 'floor', 'transitions', 'flags']);
    assert.equal(document.xmax, 501.013333);
    assert.equal(validation.valid, true);
    assert.equal(firstGate.thresholds[key].praat_headless.passed, true);
  }
});

await test('G2 Path B publishes no automatic negative FTO', () => {
  for (const key of ['P025', 'P035']) {
    const report = firstGate.thresholds[key];
    assert.equal(report.path_b_counts.emitted_negative, 0);
    assert.equal(report.path_b_counts.negative_withheld, report.path_b_counts.manual_negative_fto_flags);
    assert.equal(
      report.path_b_counts.path_b_transfer_review_flags,
      report.path_b_counts.candidate_positive + report.path_b_counts.candidate_zero + report.path_b_counts.candidate_negative,
    );
    const csv = readFileSync(path.join(firstOutput, key, 'fto_transitions.csv'), 'utf8');
    assert(!csv.includes('"negative"'));
  }
});

await test('G2 overlap transitions publish missing FTO and retained replay evidence', () => {
  for (const key of ['P025', 'P035']) {
    const report = firstGate.thresholds[key];
    assert.equal(report.path_b_counts.emitted_missing, 4);
    assert.equal(report.path_b_counts.overlap_suppressed_qualified, 4);
    assert.equal(report.path_b_counts.overlap_suppressed_subthreshold, 0);
    assert.equal(report.transition_evidence_check.pass, true);
    assert.equal(report.transition_evidence_check.row_count, 22);
    const fto = readFileSync(path.join(firstOutput, key, 'fto_transitions.csv'), 'utf8');
    assert.equal((fto.match(/"","missing","overlap_present_offset_not_measured"/g) || []).length, 4);
    assert(!/"0(?:\.0+)?","(?:zero|positive)","overlap_present_offset_not_measured"/.test(fto));
    const transitionEvidence = readFileSync(path.join(firstOutput, key, 'transition_evidence.csv'), 'utf8');
    assert.equal(transitionEvidence.split('\n')[0], CSV_SCHEMAS.transition_evidence.map((value) => `"${value}"`).join(','));
    assert(transitionEvidence.includes('provider_overlap_q_'));
    const capability = JSON.parse(readFileSync(path.join(firstOutput, key, 'overlap-capability-evidence.json')));
    assert.equal(capability.metrics.qualified_count, 18);
    assert.equal(capability.metrics.subthreshold_count, 7);
    assert.equal(capability.recomputation_contract.provider_rerun_required, false);
    assert.equal(capability.status, 'uncalibrated_draft');
    assert.equal(capability.accuracy, 'unavailable');
  }
});

await test('G2 CSV files preserve frozen column order and safe quoting', () => {
  const names = {
    nine_label_intervals: 'nine_label_intervals.csv',
    interaction_summary: 'interaction_summary.csv',
    fto_transitions: 'fto_transitions.csv',
    transition_evidence: 'transition_evidence.csv',
    flags: 'flags.csv',
  };
  for (const key of ['P025', 'P035']) {
    for (const [table, name] of Object.entries(names)) {
      const header = readFileSync(path.join(firstOutput, key, name), 'utf8').split('\n')[0];
      assert.equal(header, CSV_SCHEMAS[table].map((value) => `"${value}"`).join(','));
    }
  }
});

await test('G2 review strategy remains pending and is not cross-propagated', () => {
  for (const key of ['P025', 'P035']) {
    const manifest = JSON.parse(readFileSync(path.join(firstOutput, key, 'method-manifest.json')));
    assert.equal(manifest.review_strategy, 'awaiting_research_team');
    assert.equal(manifest.cross_threshold_review_propagation, false);
    assert.equal(manifest.phase_i_provenance.input_manifest.sha256.length, 64);
    assert.equal(manifest.provider_models.pyannote.model, 'community-1');
    assert.equal(manifest.provider_models.assemblyai.model, 'universal-3-pro');
    assert.equal(manifest.gap_filling.threshold_sec, key === 'P025' ? 0.25 : 0.35);
    assert.equal(manifest.lexicon_versions.filled_pause, 'en-core-fillers-v1');
    assert.equal(manifest.lexicon_versions.backchannel, 'interaction-core-en-v1');
    assert.equal(typeof manifest.local_rms_vad.options.relativeThresholdDb, 'number');
    assert.equal(manifest.acoustic_activity.calibration_status, 'uncalibrated_draft');
    const phase1Gate = path.join(
      repoRoot,
      'outputs', 'multilogue-v2-poc', 'Multilogue04_C_Level30_D1G4', 'phase-i', 'phase1-gate-report.json',
    );
    assert.equal(manifest.phase_i_provenance.phase1_gate_report.sha256, sha256File(phase1Gate));
  }
});

await test('G2 injected cross-threshold propagation evidence makes Gate fail', () => {
  const thresholdArtifacts = Object.fromEntries(['P025', 'P035'].map((key) => [key, {
    manifest: JSON.parse(readFileSync(path.join(firstOutput, key, 'method-manifest.json'))),
    runSummary: JSON.parse(readFileSync(path.join(firstOutput, key, 'run-summary.json'))),
    manifest_sha256: 'a'.repeat(64),
    run_summary_sha256: 'b'.repeat(64),
  }]));
  const evidence = evaluateReviewStrategyEvidence({
    thresholdArtifacts,
    artifactNames: ['P025/method-manifest.json', 'P035/run-summary.json', 'cross-threshold-propagation.json'],
  });
  assert.equal(evidence.status, 'fail');
  assert.equal(gateStatusFromChecks({ review_strategy_not_propagated: evidence.status }), 'fail');
});

await test('G2 injected network source marker makes Gate fail', () => {
  const evidence = evaluateNoNetworkEvidence({
    sourceDocuments: [{
      identifier: 'injected-runner.mjs',
      sha256: 'c'.repeat(64),
      text: 'fetch("https://example.invalid/upload")',
    }],
    inputContract: {
      artifact: 'phase-i/stage1-evidence.json',
      exists: true,
      sha256: 'd'.repeat(64),
      execution: {
        network_calls_performed: false,
        external_upload_performed: false,
        provider_artifacts: 'cached_only',
      },
    },
  });
  assert.equal(evidence.status, 'fail');
  assert(evidence.forbidden_matches.length > 0);
  assert.equal(gateStatusFromChecks({ no_network_or_upload: evidence.status }), 'fail');
});

await test('G2 every audited processing source rejects an injected network-capability marker', () => {
  const sourceDocuments = noNetworkSourceDocuments(repoRoot);
  assert.deepEqual(sourceDocuments.map((document) => document.identifier), [...NO_NETWORK_REQUIRED_SOURCE_IDS]);
  const inputContract = {
    artifact: 'phase-i/stage1-evidence.json',
    exists: true,
    sha256: 'd'.repeat(64),
    execution: {
      network_calls_performed: false,
      external_upload_performed: false,
      provider_artifacts: 'cached_only',
    },
  };
  assert.equal(evaluateNoNetworkEvidence({ sourceDocuments, inputContract }).status, 'pass');
  for (const identifier of NO_NETWORK_REQUIRED_SOURCE_IDS) {
    const injected = sourceDocuments.map((document) => document.identifier === identifier
      ? { ...document, text: `${document.text}\nfetch("https://provider.invalid/upload")` }
      : document);
    const evidence = evaluateNoNetworkEvidence({ sourceDocuments: injected, inputContract });
    assert.equal(evidence.status, 'fail', `network marker passed in ${identifier}`);
    assert(evidence.forbidden_matches.some((match) => match.source === identifier), `marker not attributed to ${identifier}`);
  }
});

await test('G2 replay is byte-deterministic', () => {
  secondGate = runPathBPoc({ outputDir: secondOutput });
  assert.equal(sha256(firstGate), sha256(secondGate));
  assert.deepEqual(directoryDigests(firstOutput), directoryDigests(secondOutput));
});

await test('G2 real draft finalization is rejected without attestation', () => {
  const actualDraft = path.join(firstOutput, 'P025', 'Multilogue04_C_Level30_D1G4.P025.draft.6tier.TextGrid');
  assert.throws(() => finalizeReviewedPathB({
    sourceDraftPath: actualDraft,
    reviewedTextGridPath: actualDraft,
    threshold: 0.25,
    outputDir: path.join(tempRoot, 'real-draft-rejected'),
  }), /attestation JSON is required/);
});

await test('G2 finalizer rejects unchanged draft digest even with attestation', () => {
  const actualDraft = path.join(firstOutput, 'P025', 'Multilogue04_C_Level30_D1G4.P025.draft.6tier.TextGrid');
  const attestationPath = path.join(tempRoot, 'unchanged.attestation.json');
  const digest = sha256File(actualDraft);
  writeFileSync(attestationPath, canonicalJson(attestation(digest, digest, 0.25, [])));
  assert.throws(() => finalizeReviewedPathB({
    sourceDraftPath: actualDraft,
    reviewedTextGridPath: actualDraft,
    attestationPath,
    threshold: 0.25,
    outputDir: path.join(tempRoot, 'unchanged-rejected'),
  }), /digest equals the source draft/);
});

await test('G2 finalizer rejects checksum mismatch', () => {
  const files = writeSyntheticReviewCase('positive', 'checksum');
  const statement = attestation('0'.repeat(64), sha256File(files.reviewed), 0.25, positiveDecision());
  writeFileSync(files.attestation, canonicalJson(statement));
  assert.throws(() => finalizeCase(files, 0.25), /source draft checksum mismatch/);
});

await test('G2 finalizer rejects reviewed TextGrid with open Tier6 flags', () => {
  const files = writeSyntheticReviewCase('positive', 'open-tier6', { openFlag: true });
  writeAttestation(files, 0.25, positiveDecision());
  assert.throws(() => finalizeCase(files, 0.25), /Tier6 still contains/);
});

await test('G2 finalizer rejects attested boundary contradicting reviewed floor', () => {
  const files = writeSyntheticReviewCase('positive', 'floor-conflict', { earlyOutgoingBoundary: true });
  writeAttestation(files, 0.25, [{
    sequence: 1, from: 'S1', to: 'S2', outgoing_offset_sec: 0.8, incoming_onset_sec: 1.4,
  }]);
  assert.throws(() => finalizeCase(files, 0.25), /contradicts floor departure/);
});

await test('G2 finalizer accepts attested synthetic positive gap FTO', () => {
  const files = writeSyntheticReviewCase('positive', 'valid-positive');
  writeAttestation(files, 0.25, positiveDecision());
  const finalized = finalizeCase(files, 0.25, 'synthetic-positive');
  assert.equal(finalized.transitionRows[0].fto_sec, 0.4);
  assert.equal(finalized.transitionRows[0].status, 'final');
  assert.equal(finalized.auditManifest.provenance.review_attestation.sha256, sha256File(files.attestation));
});

await test('G2 finalizer accepts attested synthetic negative overlap FTO', () => {
  const files = writeSyntheticReviewCase('negative', 'valid-negative');
  writeAttestation(files, 0.35, negativeDecision());
  const finalized = finalizeCase(files, 0.35, 'synthetic-negative');
  assert.equal(finalized.transitionRows[0].fto_sec, -0.3);
  assert.equal(finalized.report.negative_count, 1);
  assert.equal(validateSixTierTextGrid(finalized.document, { transitionStatuses: ['final'] }).valid, true);
});

await test('G2 artifacts contain no network, secret, absolute path or transcript payload', () => {
  const forbidden = ['http' + '://', 'https' + '://', '/' + 'Users' + '/', 'api_' + 'key', 'signed_' + 'url', 'transcript'];
  for (const file of listFiles(firstOutput)) {
    const content = readFileSync(file, 'utf8').toLowerCase();
    for (const marker of forbidden) assert(!content.includes(marker.toLowerCase()), `${path.basename(file)} contains ${marker}`);
  }
});

writeFileSync(path.join(artifactDir, 'test-report.json'), canonicalJson({
  suite: 'multilogue-v2-path-b',
  passed: results.filter((result) => result.status === 'pass').length,
  total: results.length,
  tests: results,
  actual_gate_status: firstGate.status,
  actual_thresholds: Object.fromEntries(Object.entries(firstGate.thresholds).map(([key, report]) => [key, {
    flags_count: report.flags_count,
    transitions_count: report.transitions_count,
    textgrid_bytes: report.textgrid_bytes,
    praat_passed: report.praat_headless.passed,
    negative_withheld: report.path_b_counts.negative_withheld,
  }])),
}));
rmSync(tempRoot, { recursive: true, force: true });
process.stdout.write(`\n${results.length}/${results.length} tests passed\n`);

async function test(name, fn) {
  try {
    await fn();
    results.push({ name, status: 'pass' });
    process.stdout.write(`PASS ${name}\n`);
  } catch (error) {
    results.push({ name, status: 'fail', error: error.message });
    process.stderr.write(`FAIL ${name}: ${error.stack || error.message}\n`);
    process.exitCode = 1;
    throw error;
  }
}

function reviewedFixture(kind, { openFlag = false, earlyOutgoingBoundary = false } = {}) {
  const duration = 3;
  const positive = kind === 'positive';
  const speakerTiers = positive ? {
    S1: earlyOutgoingBoundary
      ? intervals([[0, 0.8, 's'], [0.8, 1, 'op'], [1, 1.4, 'tr'], [1.4, 2.5, 'pf'], [2.5, 3, 'shs']])
      : intervals([[0, 1, 's'], [1, 1.4, 'tr'], [1.4, 2.5, 'pf'], [2.5, 3, 'shs']]),
    S2: intervals([[0, 1, 'pf'], [1, 1.4, 'tr'], [1.4, 2.5, 's'], [2.5, 3, 'shs']]),
    S3: intervals([[0, 1, 'pf'], [1, 1.4, 'tr'], [1.4, 2.5, 'pf'], [2.5, 3, 'shs']]),
  } : {
    S1: intervals([[0, 0.9, 's'], [0.9, 1.2, 'ol'], [1.2, 2.5, 'pf'], [2.5, 3, 'shs']]),
    S2: intervals([[0, 0.9, 'pf'], [0.9, 1.2, 'ol'], [1.2, 2.5, 's'], [2.5, 3, 'shs']]),
    S3: intervals([[0, 1.2, 'pf'], [1.2, 2.5, 'pf'], [2.5, 3, 'shs']]),
  };
  const floor = positive
    ? intervals([[0, 1, 'S1'], [1, 1.4, 'FREE'], [1.4, 2.5, 'S2'], [2.5, 3, 'FREE']])
    : intervals([[0, 1.2, 'S1'], [1.2, 2.5, 'S2'], [2.5, 3, 'FREE']]);
  return {
    xmin: 0,
    xmax: duration,
    tiers: [
      ...['S1', 'S2', 'S3'].map((name) => ({ class: 'IntervalTier', name, xmin: 0, xmax: duration, intervals: speakerTiers[name] })),
      { class: 'IntervalTier', name: 'floor', xmin: 0, xmax: duration, intervals: floor },
      { class: 'TextTier', name: 'transitions', xmin: 0, xmax: duration, points: [] },
      { class: 'IntervalTier', name: 'flags', xmin: 0, xmax: duration, intervals: intervals([[0, 3, openFlag ? 'unresolved_review' : '']]) },
    ],
  };
}

function writeSyntheticReviewCase(kind, suffix, options = {}) {
  const root = path.join(tempRoot, suffix);
  mkdirSync(root, { recursive: true });
  const sourceDraft = path.join(root, 'source.draft.TextGrid');
  const reviewed = path.join(root, 'reviewed.TextGrid');
  const attestationPath = path.join(root, 'review-attestation.json');
  const reviewedDocument = reviewedFixture(kind, options);
  const draftDocument = structuredClone(reviewedDocument);
  draftDocument.tiers.find((tier) => tier.name === 'flags').intervals = intervals([[0, 3, 'draft_review_required']]);
  writeFileSync(sourceDraft, serializeTextGrid(draftDocument));
  writeFileSync(reviewed, serializeTextGrid(reviewedDocument));
  return { sourceDraft, reviewed, attestation: attestationPath, output: path.join(root, 'final') };
}

function attestation(sourceDraftSha256, reviewedSha256, threshold, decisions) {
  return {
    schema: 'multilogue-v2-review-attestation',
    version: '1.0',
    source_draft_sha256: sourceDraftSha256,
    reviewed_textgrid_sha256: reviewedSha256,
    threshold_sec: threshold,
    review_status: 'complete',
    reviewed_tiers: ['S1', 'S2', 'S3', 'floor', 'flags'],
    unresolved_flags: [],
    reviewer_role: 'researcher_or_authorized_rater',
    transition_boundary_decisions: decisions,
  };
}

function writeAttestation(files, threshold, decisions) {
  writeFileSync(files.attestation, canonicalJson(attestation(
    sha256File(files.sourceDraft),
    sha256File(files.reviewed),
    threshold,
    decisions,
  )));
}

function finalizeCase(files, threshold, recordingId = 'synthetic-review') {
  return finalizeReviewedPathB({
    sourceDraftPath: files.sourceDraft,
    reviewedTextGridPath: files.reviewed,
    attestationPath: files.attestation,
    threshold,
    outputDir: files.output,
    recordingId,
  });
}

function positiveDecision() {
  return [{ sequence: 1, from: 'S1', to: 'S2', outgoing_offset_sec: 1, incoming_onset_sec: 1.4 }];
}

function negativeDecision() {
  return [{ sequence: 1, from: 'S1', to: 'S2', outgoing_offset_sec: 1.2, incoming_onset_sec: 0.9 }];
}

function intervals(values) {
  return values.map(([start, end, text]) => ({ start, end, text }));
}

function listFiles(root) {
  const output = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) output.push(...listFiles(full));
    else output.push(full);
  }
  return output;
}

function directoryDigests(root) {
  return Object.fromEntries(listFiles(root).map((file) => [path.relative(root, file), sha256(readFileSync(file))]));
}
