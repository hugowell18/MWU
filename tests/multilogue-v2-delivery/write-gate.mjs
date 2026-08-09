#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import JSZip from 'jszip';

import { PROGRESS_ORDER } from '../../scripts/multilogue-v2/run-validation-poc.mjs';
import { NO_NETWORK_REQUIRED_SOURCE_IDS } from '../../scripts/multilogue-v2/run-path-b-poc.mjs';

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(TEST_DIR, '../..');
const DEFAULT_POC_ROOT = path.join(ROOT, 'outputs', 'multilogue-v2-poc', 'Multilogue04_C_Level30_D1G4');
const POC_ROOT = path.resolve(process.env.MWU_V2_POC_ROOT || DEFAULT_POC_ROOT);
const REPORT_FILE = path.join(POC_ROOT, 'delivery', 'ui-report.json');
const PROGRESS_FILE = path.join(POC_ROOT, 'delivery', 'progress.json');
const ZIP_FILE = path.join(POC_ROOT, 'delivery', 'Multilogue04_PathB_PoC_Draft.zip');
const G2_GATE_FILE = path.join(POC_ROOT, 'gates', 'G2-path-b-gate-exit.json');
const GATE_FILE = path.join(POC_ROOT, 'gates', 'G3-ui-delivery-gate-exit.json');
const BROWSER_REPORT_FILE = path.join(TEST_DIR, 'artifacts', 'browser-qa-report.json');

function json(file) {
  return JSON.parse(readFileSync(file, 'utf8'));
}

function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

function passOrFail(condition) {
  return condition ? 'pass' : 'fail';
}

function safeArtifactFile(pocRoot, relative) {
  if (!relative || path.isAbsolute(relative) || relative.split('/').includes('..')) return null;
  const resolvedRoot = path.resolve(pocRoot);
  const resolved = path.resolve(resolvedRoot, relative);
  return resolved.startsWith(`${resolvedRoot}${path.sep}`) ? resolved : null;
}

function eventPayload(event) {
  const { event_sha256: ignored, ...payload } = event;
  return payload;
}

export function evaluateProgressEvidence(progress, pocRoot = POC_ROOT) {
  const events = Array.isArray(progress?.events) ? progress.events : [];
  const checks = {
    terminal_ready_draft: passOrFail(progress?.status === 'ready_draft' && progress?.done === true),
    exact_event_order: passOrFail(events.length === PROGRESS_ORDER.length
      && events.every((event, index) => event.key === PROGRESS_ORDER[index])),
    monotonic_sequence: passOrFail(events.every((event, index) => event.sequence === index + 1)),
    monotonic_timestamps: passOrFail(events.every((event, index) => index === 0
      || Date.parse(event.occurred_at) > Date.parse(events[index - 1].occurred_at))),
    immutable_hash_chain: 'pass',
    artifact_hashes: 'pass',
    stage_artifact_contract: 'pass',
    derived_steps_match_events: 'pass',
  };
  const evidenceEvents = [];
  const requiredStagePaths = {
    phase_i_evidence: (names) => names.some((name) => name === 'phase-i/stage1-evidence.json')
      && names.some((name) => name === 'gates/G1-stage1-gate-exit.json'),
    P025: (names) => names.length >= 8 && names.every((name) => name.startsWith('phase-ii/P025/')),
    P035: (names) => names.length >= 8 && names.every((name) => name.startsWith('phase-ii/P035/')),
    gate_qa: (names) => ['gates/G0-method-contract.json', 'gates/G1-stage1-gate-exit.json', 'gates/G2-path-b-gate-exit.json']
      .every((required) => names.includes(required)),
    delivery_package: (names) => ['delivery/Multilogue04_PathB_PoC_Draft.zip', 'delivery/delivery-manifest.json', 'delivery/README.txt']
      .every((required) => names.includes(required)),
  };

  for (let index = 0; index < events.length; index += 1) {
    const event = events[index];
    const previous = events[index - 1] || null;
    const calculatedEventHash = sha256(Buffer.from(JSON.stringify(eventPayload(event))));
    const hashChainPass = event.status === 'passed'
      && event.previous_event_sha256 === (previous?.event_sha256 || null)
      && calculatedEventHash === event.event_sha256;
    if (!hashChainPass) checks.immutable_hash_chain = 'fail';

    const artifacts = Array.isArray(event.artifacts) ? event.artifacts : [];
    const artifactChecks = artifacts.map((artifact) => {
      const file = safeArtifactFile(pocRoot, artifact.path);
      const exists = Boolean(file && existsSync(file));
      const content = exists ? readFileSync(file) : null;
      const valid = exists && content.length === artifact.bytes && sha256(content) === artifact.sha256;
      return { path: artifact.path, exists, bytes_match: exists && content.length === artifact.bytes, sha256_match: valid };
    });
    if (!artifacts.length || artifactChecks.some((item) => !item.sha256_match)) checks.artifact_hashes = 'fail';
    const names = artifacts.map((artifact) => artifact.path);
    if (!requiredStagePaths[event.key]?.(names)) checks.stage_artifact_contract = 'fail';
    evidenceEvents.push({
      sequence: event.sequence,
      key: event.key,
      occurred_at: event.occurred_at,
      event_sha256: event.event_sha256,
      artifacts: artifactChecks,
    });
  }

  const steps = Array.isArray(progress?.steps) ? progress.steps : [];
  if (steps.length !== PROGRESS_ORDER.length || steps.some((step, index) => (
    step.key !== PROGRESS_ORDER[index]
      || step.status !== 'passed'
      || step.updated_at !== events[index]?.occurred_at
  ))) checks.derived_steps_match_events = 'fail';

  const status = Object.values(checks).every((value) => value === 'pass') ? 'pass' : 'fail';
  return { status, checks, events: evidenceEvents };
}

export function evaluateNetworkEvidence(g2Gate, repoRoot = ROOT) {
  const evidence = g2Gate?.operational_evidence?.no_network_or_upload || g2Gate?.network;
  if (!evidence) return { status: 'unknown', checks: { evidence_present: 'fail' }, source: null };
  const local = evidence.local_input_contract || {};
  const sourceFiles = Array.isArray(evidence.source_files) ? evidence.source_files : [];
  const identifiers = sourceFiles.map((item) => item.identifier);
  const sourceHashesMatch = sourceFiles.length > 0 && sourceFiles.every((item) => {
    if (!item.identifier || path.isAbsolute(item.identifier) || item.identifier.split('/').includes('..')) return false;
    const file = path.resolve(repoRoot, item.identifier);
    if (!file.startsWith(`${path.resolve(repoRoot)}${path.sep}`) || !existsSync(file)) return false;
    return /^[a-f0-9]{64}$/.test(item.sha256 || '') && sha256(readFileSync(file)) === item.sha256;
  });
  const scope = evidence.evidence_scope || {};
  const checks = {
    scanner_passed: passOrFail(evidence.status === 'pass'),
    no_forbidden_source_matches: passOrFail(Array.isArray(evidence.forbidden_matches) && evidence.forbidden_matches.length === 0),
    required_processing_sources_covered: passOrFail(NO_NETWORK_REQUIRED_SOURCE_IDS.every((identifier) => identifiers.includes(identifier))),
    source_identifiers_unique: passOrFail(new Set(identifiers).size === identifiers.length),
    current_source_hashes_match: passOrFail(sourceHashesMatch),
    static_scope_explicit_and_bounded: passOrFail(
      evidence.scanner_version === 'g2-static-network-scan-v2'
      && scope.kind === 'static_source_capability_scan_plus_cached_input_contract'
      && scope.static_source_capability_scan === true
      && scope.cached_only_input_contract === true
      && scope.runtime_packet_audit_performed === false
      && typeof scope.claim_limit === 'string'
      && scope.claim_limit.includes('not a full runtime packet audit')
    ),
    local_input_verified: passOrFail(local.verified === true && local.exists === true && local.provider_artifacts === 'cached_only'),
    cached_input_declares_no_network_calls: passOrFail(local.network_calls_performed === false),
    cached_input_declares_no_external_upload: passOrFail(local.external_upload_performed === false),
  };
  const status = Object.values(checks).every((value) => value === 'pass') ? 'pass' : 'fail';
  return {
    status,
    checks,
    source: {
      scanner_version: evidence.scanner_version || null,
      evidence_scope: scope,
      source_file_count: sourceFiles.length,
      required_source_count: NO_NETWORK_REQUIRED_SOURCE_IDS.length,
      covered_identifiers: identifiers,
      local_artifact: local.artifact || null,
      local_sha256: local.sha256 || null,
    },
  };
}

function evaluateBrowserEvidence(browser) {
  const viewports = browser?.viewports || {};
  const checks = {
    report_passed: passOrFail(browser?.status === 'pass'),
    actual_ui_run_completed: passOrFail(browser?.actual_ui_run?.status === 'ready_draft'
      && JSON.stringify(browser?.actual_ui_run?.event_keys) === JSON.stringify(PROGRESS_ORDER)),
    desktop_machine_qa: passOrFail(viewports.desktop?.status === 'pass'),
    mobile_machine_qa: passOrFail(viewports.mobile?.status === 'pass'),
    no_console_errors_or_warnings: passOrFail(Object.values(viewports).every((viewport) => (
      viewport?.console?.errors === 0 && viewport?.console?.warnings === 0
    ))),
    screenshots_written: passOrFail(Object.values(viewports).every((viewport) => viewport?.screenshot?.exists === true)),
  };
  return {
    status: Object.values(checks).every((value) => value === 'pass') ? 'pass' : 'fail',
    checks,
    viewports,
  };
}

export async function writeGate() {
  const regression = json(path.join(TEST_DIR, 'artifacts', 'regression-report.json'));
  const deliveryTests = json(path.join(TEST_DIR, 'artifacts', 'test-report.json'));
  const uiTests = json(path.join(ROOT, 'outputs', 'validation-sprint', '8_STEM_SpeakerX', 'test-results', 'ui-test-results.json'));
  const browserQa = json(BROWSER_REPORT_FILE);
  const progressEvidence = evaluateProgressEvidence(json(PROGRESS_FILE));
  const networkEvidence = evaluateNetworkEvidence(json(G2_GATE_FILE));
  const browserEvidence = evaluateBrowserEvidence(browserQa);
  const report = json(REPORT_FILE);
  const zipBuffer = readFileSync(ZIP_FILE);
  const zip = await JSZip.loadAsync(zipBuffer);
  const zipFiles = Object.values(zip.files).filter((entry) => !entry.dir);

  const checks = {
    actual_api_and_evidence_tests: passOrFail(deliveryTests.failed === 0 && deliveryTests.passed === deliveryTests.cases?.length),
    immutable_progress_evidence: progressEvidence.status,
    no_network_or_upload_evidence: networkEvidence.status,
    machine_browser_qa: browserEvidence.status,
    validation_ui_tests: passOrFail(uiTests.failed === 0 && uiTests.passed >= 14),
    regression_and_build: passOrFail(regression.failed === 0 && regression.passed === regression.results.length),
    exact_safe_zip_file_count: passOrFail(zipFiles.length === 25),
    zip_digest_matches_report: passOrFail(sha256(zipBuffer) === report.delivery.sha256),
    draft_status_contract: passOrFail(report.status === 'ready_draft' && report.accuracy === 'unavailable'
      && report.review_strategy === 'awaiting_research_team'),
    unavailable_categories_not_zero_claims: passOrFail(report.capabilities?.ol === 'unavailable_in_draft'
      && report.capabilities?.x === 'unavailable_in_draft'),
  };
  const status = Object.values(checks).every((value) => value === 'pass') ? 'pass' : 'fail';
  const gate = {
    gate: 'G3-ui-delivery',
    status,
    package_status: 'draft_integration_evidence',
    accuracy: 'unavailable',
    review_strategy: 'awaiting_research_team',
    checks,
    actual_end_to_end: {
      api_run_elapsed_ms: deliveryTests.actual_api_run_elapsed_ms,
      pipeline: progressEvidence.events.map((event) => event.key),
      progress_evidence: progressEvidence,
      network_evidence: networkEvidence,
      browser_evidence: browserEvidence,
    },
    tests: {
      delivery: { passed: deliveryTests.passed, failed: deliveryTests.failed },
      validation_ui: { passed: uiTests.passed, failed: uiTests.failed },
      regression_suites: regression.results.map(({ name, status: suiteStatus, counts, elapsed_ms }) => ({ name, status: suiteStatus, counts, elapsed_ms })),
    },
    screenshots: Object.fromEntries(Object.entries(browserEvidence.viewports).map(([key, viewport]) => [key, viewport.screenshot])),
    delivery: {
      artifact: 'delivery/Multilogue04_PathB_PoC_Draft.zip',
      file_count: zipFiles.length,
      bytes: zipBuffer.length,
      sha256: report.delivery.sha256,
    },
    open_risks: [
      'Accuracy remains unavailable until a researcher-reviewed Multilogue04 reference is supplied.',
      'The research team has not selected the cross-threshold review strategy.',
      'Provider overlap evidence remains review-only; ol is unavailable in the draft.',
      'The Stage-1 non-word classifier is unavailable; x is unavailable in the draft.',
      'Temporary S1/S2/S3 identifiers are not researcher-confirmed identities.',
    ],
    generated_at: new Date().toISOString(),
  };
  writeFileSync(GATE_FILE, `${JSON.stringify(gate, null, 2)}\n`);
  console.log(JSON.stringify({ gate: gate.gate, status: gate.status, checks: gate.checks }));
  if (status !== 'pass') process.exitCode = 1;
  return gate;
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  writeGate().catch((error) => {
    console.error(error.stack || error.message);
    process.exitCode = 1;
  });
}
