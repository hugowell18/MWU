#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { CSV_SCHEMAS, SPEAKERS, SPEAKER_LABELS, canonicalJson, round } from './core/contracts.mjs';
import { runMultilogueV2 } from './core/pipeline.mjs';
import { digestFiles, sha256File, writeCanonicalJson, writeFrozenCsv } from './io/artifact-utils.mjs';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, '../..');
const RECORDING_ID = 'Multilogue04_C_Level30_D1G4';
const CANONICAL_DURATION = 501.013333;
const REQUIRED_THRESHOLDS = Object.freeze([0.25, 0.35]);
const DEFAULT_POC_ROOT = path.join(REPO_ROOT, 'outputs', 'multilogue-v2-poc', RECORDING_ID);
const POC_ROOT = path.resolve(process.env.MWU_V2_POC_ROOT || DEFAULT_POC_ROOT);
const DEFAULT_INPUT = path.join(POC_ROOT, 'phase-i', 'stage1-evidence.json');
const DEFAULT_OUTPUT = path.join(POC_ROOT, 'phase-ii');
const PRAAT_EXECUTABLE = '/Applications/Praat.app/Contents/MacOS/Praat';
const PRAAT_CHECK_SCRIPT = path.join(REPO_ROOT, 'scripts', 'check_review_6tier_textgrid_in_praat.praat');
const CORE_SOURCE_IDS = readdirSync(path.join(SCRIPT_DIR, 'core'))
  .filter((name) => name.endsWith('.mjs'))
  .sort()
  .map((name) => `scripts/multilogue-v2/core/${name}`);
const IO_SOURCE_IDS = readdirSync(path.join(SCRIPT_DIR, 'io'))
  .filter((name) => name.endsWith('.mjs'))
  .sort()
  .map((name) => `scripts/multilogue-v2/io/${name}`);
export const NO_NETWORK_REQUIRED_SOURCE_IDS = Object.freeze([
  'scripts/multilogue-v2/adapters/build-stage1-evidence.mjs',
  'scripts/multilogue-v2/run-path-b-poc.mjs',
  'scripts/multilogue-v2/run-validation-poc.mjs',
  ...CORE_SOURCE_IDS,
  ...IO_SOURCE_IDS,
]);

export function runPathBPoc({
  inputPath = DEFAULT_INPUT,
  outputDir = DEFAULT_OUTPUT,
  clean = true,
  praatExecutable = PRAAT_EXECUTABLE,
  onThresholdComplete = null,
} = {}) {
  if (!existsSync(inputPath)) throw new Error('G1 stage1-evidence input is missing');
  const input = JSON.parse(readFileSync(inputPath, 'utf8'));
  validateG1Contract(input);
  const phaseIProvenance = loadPhaseIProvenance(inputPath);
  const inputDigest = sha256File(inputPath);
  const runInput = {
    ...input,
    interactionConfig: {
      ...(input.interactionConfig || {}),
      overlapMode: 'path_b_exclusive',
    },
  };
  if (clean) rmSync(outputDir, { recursive: true, force: true });
  mkdirSync(outputDir, { recursive: true });

  const result = { thresholds: {}, reusable_inputs: null };
  const thresholdReports = {};
  for (const threshold of REQUIRED_THRESHOLDS) {
    const singleResult = runMultilogueV2({ ...runInput, thresholds: [threshold] });
    const entries = Object.entries(singleResult.thresholds);
    if (entries.length !== 1) throw new Error(`single-threshold run produced ${entries.length} outputs`);
    const [coreThresholdKey, output] = entries[0];
    result.thresholds[coreThresholdKey] = output;
    if (result.reusable_inputs == null) result.reusable_inputs = singleResult.reusable_inputs;
    else if (canonicalJson(result.reusable_inputs) !== canonicalJson(singleResult.reusable_inputs)) {
      throw new Error('single-threshold runs did not preserve identical threshold-neutral inputs');
    }
    const thresholdKey = deliveryThresholdKey(output.manifest.threshold_sec);
    const directory = path.join(outputDir, thresholdKey);
    mkdirSync(directory, { recursive: true });
    const stem = `${RECORDING_ID}.${thresholdKey}`;
    const fileNames = {
      textgrid: `${stem}.draft.6tier.TextGrid`,
      nine: 'nine_label_intervals.csv',
      summary: 'interaction_summary.csv',
      fto: 'fto_transitions.csv',
      transitionEvidence: 'transition_evidence.csv',
      overlapCapability: 'overlap-capability-evidence.json',
      flags: 'flags.csv',
      manifest: 'method-manifest.json',
      validation: 'timeline-validation.json',
      runSummary: 'run-summary.json',
    };

    writeFileSync(path.join(directory, fileNames.textgrid), output.textgrid);
    writeFrozenCsv(path.join(directory, fileNames.nine), CSV_SCHEMAS.nine_label_intervals, output.rows.nine_label_intervals);
    writeFrozenCsv(path.join(directory, fileNames.summary), CSV_SCHEMAS.interaction_summary, output.rows.interaction_summary);
    writeFrozenCsv(path.join(directory, fileNames.fto), CSV_SCHEMAS.fto_transitions, output.rows.fto_transitions);
    writeFrozenCsv(
      path.join(directory, fileNames.transitionEvidence),
      CSV_SCHEMAS.transition_evidence,
      output.rows.transition_evidence,
    );
    writeCanonicalJson(path.join(directory, fileNames.overlapCapability), output.overlap_capability_evidence);
    writeFrozenCsv(path.join(directory, fileNames.flags), CSV_SCHEMAS.flags, output.rows.flags);

    const initialFlagCheck = checkInitialFlagPropagation(runInput.initialFlags, output.rows.flags);
    const providerOverlapCheck = checkProviderOverlapPropagation(runInput.providerOverlapEvidence, output.rows.flags);
    const transitionEvidenceCheck = checkTransitionEvidence(output.rows.fto_transitions, output.rows.transition_evidence);
    const praat = runPraatValidation(path.join(directory, fileNames.textgrid), praatExecutable);
    const counts = output.path_b_counts;
    if (counts.emitted_negative !== 0) throw new Error(`${thresholdKey} emitted an automatic negative FTO`);
    if (counts.negative_withheld !== counts.manual_negative_fto_flags) {
      throw new Error(`${thresholdKey} negative FTO withholding is not fully review-flagged`);
    }
    if (!initialFlagCheck.pass) throw new Error(`${thresholdKey} did not preserve every G1 initial flag exactly once`);
    if (!providerOverlapCheck.pass) throw new Error(`${thresholdKey} did not preserve provider overlap review evidence`);
    if (!transitionEvidenceCheck.pass) throw new Error(`${thresholdKey} transition evidence is incomplete or inconsistent`);
    if (counts.path_b_transfer_review_flags
      !== counts.candidate_positive + counts.candidate_zero + counts.candidate_negative) {
      throw new Error(`${thresholdKey} does not review-flag every Path B floor transfer`);
    }

    const methodManifest = {
      ...output.manifest,
      package_status: 'draft_integration_evidence',
      path: 'B',
      path_b_exclusive: true,
      review_strategy: 'awaiting_research_team',
      cross_threshold_review_propagation: false,
      accuracy: 'unavailable_without_researcher_reference',
      canonical_timeline_sec: CANONICAL_DURATION,
      input_artifact: 'phase-i/stage1-evidence.json',
      input_sha256: inputDigest,
      core_output_digest: output.digest,
      core_threshold_key: coreThresholdKey,
      phase_i_provenance: phaseIProvenance.manifestBinding,
      canonical_clock: phaseIProvenance.inputManifest.canonical_timeline,
      provider_models: phaseIProvenance.inputManifest.providers,
      gap_filling: {
        threshold_sec: output.manifest.threshold_sec,
        rule: 'fill_internal_threshold_neutral_room_silence_shorter_than_P',
        comparison: 'strictly_less_than_threshold',
        minimum_sounding_run_sec: Number(runInput.sharedActivityOptions?.minSoundingSeconds ?? 0.1),
      },
      local_rms_vad: phaseIProvenance.roomActivity.method,
      acoustic_activity: {
        calibration_status: 'uncalibrated_draft',
        source: 'phase-i/room-activity-base.json',
        source_sha256: phaseIProvenance.manifestBinding.room_activity_base.sha256,
      },
      lexicon_versions: {
        filled_pause: runInput.adapterMetadata?.controlledFilledPauseLexicon?.version ?? null,
        backchannel: runInput.adapterMetadata?.backchannelLexicon?.version ?? null,
      },
      provider_overlap_evidence: providerOverlapCheck.summary,
      transition_evidence: {
        artifact: fileNames.transitionEvidence,
        overlap_capability_artifact: fileNames.overlapCapability,
        ...transitionEvidenceCheck.summary,
      },
      draft_observation_availability: draftObservationAvailability(),
      network_used: false,
    };
    writeCanonicalJson(path.join(directory, fileNames.manifest), methodManifest);
    writeCanonicalJson(path.join(directory, fileNames.validation), {
      ...output.validation,
      canonical_duration_match: output.validation.duration === CANONICAL_DURATION,
      praat_headless: praat,
    });

    const labelSummary = summarizeLabels(output.rows.nine_label_intervals);
    const runSummary = {
      recording_id: RECORDING_ID,
      threshold_key: thresholdKey,
      threshold_sec: output.manifest.threshold_sec,
      status: 'draft_integration_evidence',
      label_summary: labelSummary,
      flags_count: output.rows.flags.length,
      transitions_count: output.rows.fto_transitions.length,
      path_b_counts: counts,
      initial_flags: initialFlagCheck,
      provider_overlap_candidates: providerOverlapCheck.summary,
      transition_evidence: transitionEvidenceCheck.summary,
      draft_observation_availability: draftObservationAvailability(),
      manual_negative_interpretation: manualNegativeInterpretation(counts),
      review_strategy: 'awaiting_research_team',
      accuracy: 'unavailable',
      praat_headless: praat,
    };
    writeCanonicalJson(path.join(directory, fileNames.runSummary), runSummary);

    const allNames = Object.values(fileNames);
    const fileDigests = digestFiles(directory, allNames);
    thresholdReports[thresholdKey] = {
      threshold_sec: output.manifest.threshold_sec,
      core_output_digest: output.digest,
      label_summary: labelSummary,
      flags_count: output.rows.flags.length,
      transitions_count: output.rows.fto_transitions.length,
      path_b_counts: counts,
      initial_flag_check: initialFlagCheck,
      provider_overlap_check: providerOverlapCheck,
      transition_evidence_check: transitionEvidenceCheck,
      textgrid_bytes: statSync(path.join(directory, fileNames.textgrid)).size,
      timeline_valid: output.validation.valid,
      timeline_duration_sec: output.validation.duration,
      praat_headless: praat,
      output_sha256: fileDigests,
    };
    if (typeof onThresholdComplete === 'function') {
      onThresholdComplete({
        threshold_key: thresholdKey,
        threshold_sec: output.manifest.threshold_sec,
        directory,
        report: thresholdReports[thresholdKey],
        artifacts: allNames.map((name) => path.join(directory, name)),
      });
    }
  }

  const thresholdKeys = Object.keys(thresholdReports);
  if (thresholdKeys.join(',') !== 'P025,P035') throw new Error('exact P025 and P035 outputs are required');
  if (thresholdReports.P025.core_output_digest === thresholdReports.P035.core_output_digest) {
    throw new Error('threshold runs must have independent output digests');
  }
  const actualFinalFiles = listFiles(outputDir).filter((file) =>
    file.includes('.final.') || path.basename(file).startsWith('finalization-'));
  const operationalEvidence = {
    reviewStrategy: collectReviewStrategyEvidence(outputDir),
    noNetwork: collectNoNetworkEvidence(inputPath, phaseIProvenance.inputManifest),
  };
  const gate = buildGateReport({
    inputDigest,
    result,
    thresholdReports,
    phaseIProvenance,
    actualFinalFiles,
    operationalEvidence,
  });
  const gateDir = path.join(path.dirname(outputDir), 'gates');
  mkdirSync(gateDir, { recursive: true });
  writeCanonicalJson(path.join(gateDir, 'G2-path-b-gate-exit.json'), gate);
  return gate;
}

function validateG1Contract(input) {
  if (input.recordingId !== RECORDING_ID) throw new Error('unexpected G1 recording identifier');
  if (Number(input.duration) !== CANONICAL_DURATION) throw new Error('G1 canonical WAV duration mismatch');
  if (input.interactionConfig?.overlapMode !== 'path_b_exclusive') throw new Error('G1 must request Path B exclusive');
  if (!Array.isArray(input.stage1UnknownEvidence) || !Array.isArray(input.initialFlags)) {
    throw new Error('G1 unknown evidence and initial flags are required');
  }
  if (!Array.isArray(input.providerOverlapCandidates) || !Array.isArray(input.providerOverlapEvidence)) {
    throw new Error('G1 structured provider overlap evidence is required');
  }
}

function loadPhaseIProvenance(stage1Path) {
  const phaseIDir = path.dirname(stage1Path);
  const paths = {
    inputManifest: path.join(phaseIDir, 'input-manifest.json'),
    roomActivity: path.join(phaseIDir, 'room-activity-base.json'),
    providerMapping: path.join(phaseIDir, 'provider-mapping.json'),
    phase1GateReport: path.join(phaseIDir, 'phase1-gate-report.json'),
  };
  for (const [name, filePath] of Object.entries(paths)) {
    if (!existsSync(filePath)) throw new Error(`required G1 provenance artifact is missing: ${name}`);
  }
  const inputManifest = JSON.parse(readFileSync(paths.inputManifest, 'utf8'));
  const roomActivity = JSON.parse(readFileSync(paths.roomActivity, 'utf8'));
  if (Number(inputManifest.canonical_timeline?.duration_seconds) !== CANONICAL_DURATION
    || Number(roomActivity.duration_seconds) !== CANONICAL_DURATION) {
    throw new Error('G1 provenance canonical clock mismatch');
  }
  return {
    inputManifest,
    roomActivity,
    manifestBinding: {
      input_manifest: { artifact: 'phase-i/input-manifest.json', sha256: sha256File(paths.inputManifest) },
      room_activity_base: { artifact: 'phase-i/room-activity-base.json', sha256: sha256File(paths.roomActivity) },
      provider_mapping: { artifact: 'phase-i/provider-mapping.json', sha256: sha256File(paths.providerMapping) },
      phase1_gate_report: { artifact: 'phase-i/phase1-gate-report.json', sha256: sha256File(paths.phase1GateReport) },
      stage1_evidence: { artifact: 'phase-i/stage1-evidence.json', sha256: sha256File(stage1Path) },
    },
  };
}

function checkInitialFlagPropagation(initialFlags, outputFlags) {
  const key = (flag) => [
    round(flag.start ?? flag.start_sec), round(flag.end ?? flag.end_sec),
    flag.code, flag.severity, flag.source, String(flag.related_id || ''),
  ].join('|');
  const outputCounts = new Map();
  for (const flag of outputFlags) outputCounts.set(key(flag), (outputCounts.get(key(flag)) || 0) + 1);
  const missing = [];
  const duplicated = [];
  for (const flag of initialFlags) {
    const count = outputCounts.get(key(flag)) || 0;
    if (count === 0) missing.push(String(flag.related_id || flag.code));
    if (count > 1) duplicated.push(String(flag.related_id || flag.code));
  }
  return {
    pass: missing.length === 0 && duplicated.length === 0,
    input_count: initialFlags.length,
    preserved_once_count: initialFlags.length - missing.length - duplicated.length,
    missing_count: missing.length,
    duplicated_count: duplicated.length,
  };
}

function checkProviderOverlapPropagation(evidence = [], outputFlags) {
  const ids = new Set(evidence.map((item) => item.id));
  const rows = outputFlags.filter((flag) =>
    flag.code === 'provider_overlap_candidate' || flag.code === 'provider_subthreshold_overlap');
  const counts = new Map();
  for (const row of rows) counts.set(row.related_id, (counts.get(row.related_id) || 0) + 1);
  const missing = [...ids].filter((id) => !counts.has(id));
  const duplicated = [...ids].filter((id) => (counts.get(id) || 0) > 1);
  const unexpected = rows.filter((row) => !ids.has(row.related_id));
  const durationSec = round(evidence.reduce((sum, item) => sum + Number(item.end) - Number(item.start), 0));
  const qualified = evidence.filter((item) => item.overlap_class === 'qualified');
  const subthreshold = evidence.filter((item) => item.overlap_class === 'subthreshold');
  return {
    pass: missing.length === 0 && duplicated.length === 0 && unexpected.length === 0,
    candidate_count: qualified.length,
    candidate_duration_sec: round(qualified.reduce((sum, item) => sum + Number(item.end) - Number(item.start), 0)),
    subthreshold_count: subthreshold.length,
    subthreshold_duration_sec: round(subthreshold.reduce((sum, item) => sum + Number(item.end) - Number(item.start), 0)),
    evidence_count: ids.size,
    evidence_duration_sec: durationSec,
    propagated_once_count: ids.size - missing.length - duplicated.length,
    missing_count: missing.length,
    duplicated_count: duplicated.length,
    unexpected_count: unexpected.length,
    summary: {
      status: 'provider_candidate_requires_researcher_review',
      region_count: ids.size,
      duration_sec: durationSec,
      qualified_count: qualified.length,
      subthreshold_count: subthreshold.length,
      semantic_effect: 'transition_evidence_and_review_only_not_confirmed_ol_not_floor_input',
    },
  };
}

function checkTransitionEvidence(ftoRows, evidenceRows) {
  const bySequence = new Map(evidenceRows.map((row) => [Number(row.sequence), row]));
  const missing = [];
  const inconsistent = [];
  let qualifiedSuppressed = 0;
  let subthresholdSuppressed = 0;
  for (const row of ftoRows) {
    const evidence = bySequence.get(Number(row.sequence));
    if (!evidence) {
      missing.push(Number(row.sequence));
      continue;
    }
    const overlapMissing = row.status === 'overlap_present_offset_not_measured'
      || row.status === 'subthreshold_overlap_present_offset_not_measured';
    if (overlapMissing) {
      if (row.fto_sec !== null || row.sign !== 'missing' || evidence.fto_status !== row.status
        || !['qualified', 'subthreshold'].includes(evidence.overlap_class)
        || !Array.isArray(evidence.evidence_ids) || evidence.evidence_ids.length === 0) {
        inconsistent.push(Number(row.sequence));
      }
      if (row.status === 'overlap_present_offset_not_measured') qualifiedSuppressed += 1;
      else subthresholdSuppressed += 1;
    } else if (row.fto_sec == null || evidence.overlap_class !== 'none') {
      inconsistent.push(Number(row.sequence));
    }
  }
  const extra = evidenceRows.filter((row) => !ftoRows.some((item) => Number(item.sequence) === Number(row.sequence)))
    .map((row) => Number(row.sequence));
  return {
    pass: missing.length === 0 && inconsistent.length === 0 && extra.length === 0,
    row_count: evidenceRows.length,
    qualified_overlap_fto_suppressed: qualifiedSuppressed,
    subthreshold_overlap_fto_suppressed: subthresholdSuppressed,
    missing_sequences: missing,
    inconsistent_sequences: inconsistent,
    extra_sequences: extra,
    summary: {
      status: 'uncalibrated_draft',
      row_count: evidenceRows.length,
      qualified_overlap_fto_suppressed: qualifiedSuppressed,
      subthreshold_overlap_fto_suppressed: subthresholdSuppressed,
      path_a_recomputation_supported: true,
      researcher_validation_required: true,
    },
  };
}

function draftObservationAvailability() {
  return {
    ol: {
      status: 'unavailable_in_draft',
      reason: 'Path B provider overlap candidates require researcher confirmation.',
    },
    x: {
      status: 'unavailable_in_draft',
      reason: 'The Stage-1 non-word event classifier is not implemented.',
    },
  };
}

function manualNegativeInterpretation(counts) {
  return counts.manual_negative_fto_flags === 0
    ? 'No manual-negative flag was emitted because corrected human boundaries are not yet available; this does not mean manual review is unnecessary.'
    : 'Negative transfer candidates are withheld until attested human boundary decisions are supplied.';
}

function summarizeLabels(rows) {
  const bySpeaker = Object.fromEntries(SPEAKERS.map((speaker) => [speaker, Object.fromEntries(
    SPEAKER_LABELS.map((label) => [label, { interval_count: 0, duration_sec: 0 }]),
  )]));
  for (const row of rows) {
    bySpeaker[row.speaker][row.label].interval_count += 1;
    bySpeaker[row.speaker][row.label].duration_sec = round(
      bySpeaker[row.speaker][row.label].duration_sec + Number(row.duration_sec),
    );
  }
  return bySpeaker;
}

function runPraatValidation(textGridPath, executable) {
  if (!existsSync(executable)) return { available: false, passed: false, reason: 'Praat executable not found' };
  const result = spawnSync(executable, ['--run', PRAAT_CHECK_SCRIPT, textGridPath], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    timeout: 30000,
  });
  const output = `${result.stdout || ''}${result.stderr || ''}`.trim();
  return {
    available: true,
    passed: result.status === 0 && output.includes('tiers=6')
      && output.includes('tier1=S1') && output.includes('tier6=flags'),
    exit_code: result.status,
    result: output.replaceAll(textGridPath, '[textgrid]'),
  };
}

function collectReviewStrategyEvidence(outputDir) {
  const thresholdArtifacts = {};
  for (const thresholdKey of ['P025', 'P035']) {
    const directory = path.join(outputDir, thresholdKey);
    const manifestPath = path.join(directory, 'method-manifest.json');
    const summaryPath = path.join(directory, 'run-summary.json');
    thresholdArtifacts[thresholdKey] = {
      manifest: existsSync(manifestPath) ? JSON.parse(readFileSync(manifestPath, 'utf8')) : null,
      runSummary: existsSync(summaryPath) ? JSON.parse(readFileSync(summaryPath, 'utf8')) : null,
      manifest_sha256: existsSync(manifestPath) ? sha256File(manifestPath) : null,
      run_summary_sha256: existsSync(summaryPath) ? sha256File(summaryPath) : null,
    };
  }
  return evaluateReviewStrategyEvidence({
    thresholdArtifacts,
    artifactNames: listFiles(outputDir).map((file) => path.relative(outputDir, file)),
  });
}

export function evaluateReviewStrategyEvidence({ thresholdArtifacts, artifactNames }) {
  const expected = ['P025', 'P035'];
  if (!thresholdArtifacts || !Array.isArray(artifactNames)) {
    return { status: 'unknown', reason: 'review evidence inputs are incomplete' };
  }
  const missing = [];
  const violations = [];
  const inspected = {};
  for (const key of expected) {
    const evidence = thresholdArtifacts[key];
    if (!evidence?.manifest || !evidence?.runSummary) {
      missing.push(key);
      continue;
    }
    const manifestAwaiting = evidence.manifest.review_strategy === 'awaiting_research_team';
    const summaryAwaiting = evidence.runSummary.review_strategy === 'awaiting_research_team';
    const propagationDisabled = evidence.manifest.cross_threshold_review_propagation === false;
    if (!manifestAwaiting) violations.push(`${key}:manifest_review_strategy`);
    if (!summaryAwaiting) violations.push(`${key}:run_summary_review_strategy`);
    if (!propagationDisabled) violations.push(`${key}:cross_threshold_review_propagation`);
    inspected[key] = {
      manifest_sha256: evidence.manifest_sha256 ?? null,
      run_summary_sha256: evidence.run_summary_sha256 ?? null,
      manifest_review_strategy: evidence.manifest.review_strategy ?? null,
      run_summary_review_strategy: evidence.runSummary.review_strategy ?? null,
      cross_threshold_review_propagation: evidence.manifest.cross_threshold_review_propagation ?? null,
    };
  }
  const forbiddenArtifacts = artifactNames.filter((name) => {
    const base = path.basename(name).toLowerCase();
    return base.includes('.final.')
      || base.startsWith('finalization-')
      || base.includes('attestation')
      || base.includes('.reviewed.')
      || base.startsWith('reviewed')
      || base.includes('cross-threshold')
      || base.includes('cross_threshold')
      || base.includes('propagation');
  });
  if (forbiddenArtifacts.length) violations.push('reviewed_final_or_cross_threshold_artifact_present');
  const status = missing.length ? 'unknown' : violations.length ? 'fail' : 'pass';
  return {
    status,
    expected_thresholds: expected,
    inspected,
    missing_threshold_evidence: missing,
    forbidden_artifacts: forbiddenArtifacts,
    violations,
    artifact_count: artifactNames.length,
  };
}

function collectNoNetworkEvidence(inputPath, inputManifest) {
  const sourceDocuments = noNetworkSourceDocuments();
  return evaluateNoNetworkEvidence({
    sourceDocuments,
    inputContract: {
      artifact: 'phase-i/stage1-evidence.json',
      exists: existsSync(inputPath),
      sha256: existsSync(inputPath) ? sha256File(inputPath) : null,
      execution: inputManifest?.execution ?? null,
    },
  });
}

export function noNetworkSourceDocuments(repoRoot = REPO_ROOT) {
  return NO_NETWORK_REQUIRED_SOURCE_IDS.map((identifier) => {
    const filePath = path.join(repoRoot, identifier);
    if (!existsSync(filePath)) throw new Error(`required no-network source is missing: ${identifier}`);
    return {
      identifier,
      sha256: sha256File(filePath),
      text: readFileSync(filePath, 'utf8'),
    };
  });
}

export function evaluateNoNetworkEvidence({ sourceDocuments, inputContract }) {
  if (!Array.isArray(sourceDocuments) || sourceDocuments.length === 0 || !inputContract?.execution) {
    return { status: 'unknown', reason: 'source or local input evidence is incomplete' };
  }
  const fetchToken = ['fet', 'ch'].join('');
  const protocolPattern = ['ht', 'tps?'].join('');
  const clientTokens = [['ax', 'ios'], ['XMLHttp', 'Request'], ['Web', 'Socket'], ['Event', 'Source']]
    .map((parts) => parts.join(''));
  const shellTokens = [['cu', 'rl'], ['wg', 'et']].map((parts) => parts.join(''));
  const rules = [
    ['fetch_call', new RegExp(`\\b${fetchToken}\\s*\\(`, 'g')],
    ['network_module_import', new RegExp(`(?:from\\s+['"]node:(?:${['ht', 'tp'].join('')}|${['ht', 'tps'].join('')}|net|tls)['"]|require\\(['"](?:${['ht', 'tp'].join('')}|${['ht', 'tps'].join('')}|net|tls)['"]\\))`, 'g')],
    ['network_url', new RegExp(`${protocolPattern}:\\/\\/`, 'g')],
    ['network_client', new RegExp(`\\b(?:${clientTokens.join('|')})\\b`, 'g')],
    ['upload_call', new RegExp(`(?:\\b${['up', 'load'].join('')}[A-Za-z0-9_]*\\s*\\(|\\.${['up', 'load'].join('')}\\s*\\()`, 'g')],
    ['shell_network_client', new RegExp(`\\b(?:${shellTokens.join('|')})\\b`, 'g')],
  ];
  const matches = [];
  for (const document of sourceDocuments) {
    if (typeof document?.text !== 'string' || !document.identifier) {
      return { status: 'unknown', reason: 'a source document cannot be inspected' };
    }
    for (const [rule, pattern] of rules) {
      pattern.lastIndex = 0;
      if (pattern.test(document.text)) matches.push({ source: document.identifier, rule });
    }
  }
  const execution = inputContract.execution;
  const localInputVerified = inputContract.exists === true
    && typeof inputContract.sha256 === 'string'
    && inputContract.sha256.length === 64
    && execution.network_calls_performed === false
    && execution.external_upload_performed === false
    && execution.provider_artifacts === 'cached_only';
  const status = matches.length ? 'fail' : localInputVerified ? 'pass' : 'unknown';
  return {
    status,
    scanner_version: 'g2-static-network-scan-v2',
    evidence_scope: {
      kind: 'static_source_capability_scan_plus_cached_input_contract',
      static_source_capability_scan: true,
      cached_only_input_contract: true,
      runtime_packet_audit_performed: false,
      claim_limit: 'No forbidden network capability was found in the inspected processing sources; this is not a full runtime packet audit.',
    },
    source_files: sourceDocuments.map((document) => ({
      identifier: document.identifier,
      sha256: document.sha256 ?? null,
    })),
    forbidden_matches: matches,
    local_input_contract: {
      artifact: inputContract.artifact ?? null,
      exists: inputContract.exists === true,
      sha256: inputContract.sha256 ?? null,
      network_calls_performed: execution.network_calls_performed ?? null,
      external_upload_performed: execution.external_upload_performed ?? null,
      provider_artifacts: execution.provider_artifacts ?? null,
      verified: localInputVerified,
    },
  };
}

function buildGateReport({
  inputDigest,
  result,
  thresholdReports,
  phaseIProvenance,
  actualFinalFiles,
  operationalEvidence,
}) {
  const reports = Object.values(thresholdReports);
  const checks = {
    exact_thresholds: result.thresholds.P250 && result.thresholds.P350 ? 'pass' : 'fail',
    canonical_duration: reports.every((report) =>
      report.timeline_valid && report.timeline_duration_sec === CANONICAL_DURATION) ? 'pass' : 'fail',
    path_b_no_automatic_negative_fto: reports.every((report) => report.path_b_counts.emitted_negative === 0) ? 'pass' : 'fail',
    negative_candidates_withheld_and_flagged: reports.every((report) =>
      report.path_b_counts.negative_withheld === report.path_b_counts.manual_negative_fto_flags) ? 'pass' : 'fail',
    initial_flags_preserved_once: reports.every((report) => report.initial_flag_check.pass) ? 'pass' : 'fail',
    provider_overlap_candidates_propagated_once: reports.every((report) => report.provider_overlap_check.pass) ? 'pass' : 'fail',
    transition_overlap_fto_is_missing_and_evidenced: reports.every((report) => report.transition_evidence_check.pass) ? 'pass' : 'fail',
    every_path_b_transfer_review_flagged: reports.every((report) =>
      report.path_b_counts.path_b_transfer_review_flags
        === report.path_b_counts.candidate_positive
          + report.path_b_counts.candidate_zero
          + report.path_b_counts.candidate_negative) ? 'pass' : 'fail',
    exactly_six_praat_readable_tiers: reports.every((report) => report.praat_headless.passed) ? 'pass' : 'fail',
    independent_threshold_digests: thresholdReports.P025.core_output_digest !== thresholdReports.P035.core_output_digest ? 'pass' : 'fail',
    review_strategy_not_propagated: operationalEvidence.reviewStrategy.status,
    actual_final_fto_not_fabricated_without_attestation: actualFinalFiles.length === 0 ? 'pass' : 'fail',
    no_network_or_upload: operationalEvidence.noNetwork.status,
  };
  return {
    gate: 'G2-path-b',
    status: gateStatusFromChecks(checks),
    package_status: 'draft_integration_evidence',
    method_contract: {
      thresholds_sec: [...REQUIRED_THRESHOLDS],
      overlap_mode: 'path_b_exclusive',
      canonical_duration_sec: CANONICAL_DURATION,
      review_strategy: 'awaiting_research_team',
      cross_threshold_review_propagation: false,
      actual_finalization_status: 'not_run_no_valid_review_attestation',
    },
    input: {
      artifact: 'phase-i/stage1-evidence.json',
      sha256: inputDigest,
      unknown_residual_count: result.reusable_inputs.stage1_unknown_evidence_count,
      initial_flag_count: result.reusable_inputs.initial_flag_accepted_count,
      phase_i_provenance: phaseIProvenance.manifestBinding,
      provider_overlap_candidate_count: result.reusable_inputs.provider_overlap_candidate_count,
      provider_overlap_candidate_duration_sec: result.reusable_inputs.provider_overlap_candidate_duration_sec,
      provider_overlap_subthreshold_count: result.reusable_inputs.provider_overlap_subthreshold_count,
      provider_overlap_subthreshold_duration_sec: result.reusable_inputs.provider_overlap_subthreshold_duration_sec,
    },
    checks,
    operational_evidence: {
      review_strategy_not_propagated: operationalEvidence.reviewStrategy,
      no_network_or_upload: operationalEvidence.noNetwork,
    },
    thresholds: thresholdReports,
    actual_finalization: {
      attestation_supplied: false,
      final_package_file_count: actualFinalFiles.length,
      status: actualFinalFiles.length === 0 ? 'correctly_not_created' : 'fail_unattested_final_files_present',
    },
    accuracy: 'unavailable_without_researcher-reviewed_reference',
    network: operationalEvidence.noNetwork,
    open_risks: [
      'Research-team review strategy is not yet selected.',
      'Unknown non-word residuals remain review flags and do not drive the floor stream.',
      'Canonical S1/S2/S3 identities remain temporary until researcher confirmation.',
      'Provider overlap candidates are not confirmed ol observations.',
      'The x label is unavailable until a Stage-1 non-word classifier or researcher coding is supplied.',
      'No actual reviewed Multilogue04 TextGrid was supplied, so no final signed FTO is produced.',
    ],
  };
}

export function gateStatusFromChecks(checks) {
  const values = Object.values(checks || {});
  if (values.some((value) => value === 'fail')) return 'fail';
  if (values.length === 0 || values.some((value) => value === 'unknown')) return 'unknown';
  return values.every((value) => value === 'pass') ? 'pass' : 'unknown';
}

function listFiles(root) {
  const output = [];
  if (!existsSync(root)) return output;
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const fullPath = path.join(root, entry.name);
    if (entry.isDirectory()) output.push(...listFiles(fullPath));
    else output.push(fullPath);
  }
  return output;
}

function deliveryThresholdKey(threshold) {
  return `P${Math.round(Number(threshold) * 100).toString().padStart(3, '0')}`;
}

function parseArgs(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === '--input') values.inputPath = path.resolve(argv[++index]);
    else if (value === '--output') values.outputDir = path.resolve(argv[++index]);
    else throw new Error(`unknown argument: ${value}`);
  }
  return values;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const gate = runPathBPoc(parseArgs(process.argv.slice(2)));
  process.stdout.write(canonicalJson({ gate: gate.gate, status: gate.status, thresholds: Object.keys(gate.thresholds) }));
}
