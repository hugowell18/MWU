#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import JSZip from 'jszip';

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(TEST_DIR, '../..');
const RECORDING_ID = 'Multilogue04_C_Level30_D1G4';
const FORMAL_POC_ROOT = path.join(ROOT, 'outputs', 'multilogue-v2-poc', RECORDING_ID);
const TEST_SANDBOX = mkdtempSync(path.join(os.tmpdir(), 'mwu-v2-delivery-'));
const POC_ROOT = path.join(TEST_SANDBOX, RECORDING_ID);
cpSync(FORMAL_POC_ROOT, POC_ROOT, { recursive: true, force: true });
process.env.MWU_V2_POC_ROOT = POC_ROOT;

const {
  PROGRESS_ORDER,
  REPORT_PATH,
  ZIP_PATH,
  deliverySourcePaths,
} = await import('../../scripts/multilogue-v2/run-validation-poc.mjs');
const { evaluateNetworkEvidence, evaluateProgressEvidence } = await import('./write-gate.mjs');
const { NO_NETWORK_REQUIRED_SOURCE_IDS } = await import('../../scripts/multilogue-v2/run-path-b-poc.mjs');

const ARTIFACT_DIR = path.join(TEST_DIR, 'artifacts');
const PORT = Number(process.env.G3_TEST_PORT || 4183);
const BASE = `http://127.0.0.1:${PORT}`;
const cases = [];
const FORMAL_ARTIFACTS = Object.freeze({
  Audio: path.join(ROOT, 'sample', 'Multilogue04_C_Level30 D1G4.wav'),
  Gold: path.join(ROOT, 'outputs', 'multilogue-v2-poc', `${RECORDING_ID}_P025_corrected_6tier.TextGrid`),
  Stage1: path.join(FORMAL_POC_ROOT, 'phase-i', 'stage1-evidence.json'),
  P025: path.join(FORMAL_POC_ROOT, 'phase-ii', 'P025', `${RECORDING_ID}.P025.draft.6tier.TextGrid`),
  P035: path.join(FORMAL_POC_ROOT, 'phase-ii', 'P035', `${RECORDING_ID}.P035.draft.6tier.TextGrid`),
  ZIP: path.join(FORMAL_POC_ROOT, 'delivery', 'Multilogue04_PathB_PoC_Draft.zip'),
});
const formalHashesBefore = hashArtifactSet(FORMAL_ARTIFACTS);

async function test(name, fn) {
  try {
    await fn();
    cases.push({ name, status: 'passed' });
    console.log(`PASS ${name}`);
  } catch (error) {
    cases.push({ name, status: 'failed', detail: error.message });
    console.log(`FAIL ${name}: ${error.message}`);
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function sha256File(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

function hashArtifactSet(artifacts) {
  return Object.fromEntries(Object.entries(artifacts).map(([name, file]) => {
    if (!existsSync(file)) throw new Error(`formal artifact is missing: ${name}`);
    return [name, sha256File(file)];
  }));
}

async function waitForServer(timeoutMs = 10000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      if ((await fetch(`${BASE}/`)).ok) return;
    } catch { /* starting */ }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('validation server did not start');
}

async function waitForRun(timeoutMs = 60000) {
  const start = Date.now();
  const snapshots = [];
  while (Date.now() - start < timeoutMs) {
    const response = await fetch(`${BASE}/api/multilogue-v2/status`);
    const progress = await response.json();
    snapshots.push({
      status: progress.status,
      active_step: progress.active_step,
      event_keys: (progress.events || []).map((event) => event.key),
      updated_at: progress.updated_at,
    });
    if (progress.done) return { progress, snapshots, elapsed_ms: Date.now() - start };
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('API run timed out');
}

function expectedZipFiles() {
  return [
    ...deliverySourcePaths().map((name) => name.replace(/^phase-ii\//, '').replace(/^gates\//, 'gates/')),
    'delivery-manifest.json',
    'README.txt',
  ].sort();
}

async function main() {
  await test('delivery ZIP opens and has the exact 25-file allowlist', async () => {
    const zip = await JSZip.loadAsync(readFileSync(ZIP_PATH));
    const names = Object.entries(zip.files).filter(([, entry]) => !entry.dir).map(([name]) => name).sort();
    assert(names.length === 25, `file count=${names.length}`);
    assert(JSON.stringify(names) === JSON.stringify(expectedZipFiles()), 'ZIP contents differ from the allowlist');
  });

  await test('delivery ZIP denylist and content safety scan pass', async () => {
    const zip = await JSZip.loadAsync(readFileSync(ZIP_PATH));
    const names = Object.entries(zip.files).filter(([, entry]) => !entry.dir).map(([name]) => name);
    for (const name of names) {
      assert(!/\.(wav|mp3|rttm|log)$/i.test(name), `audio/provider payload included: ${name}`);
      assert(!/(?:^|[._-])(final|reviewed|gold|attestation)(?:[._-]|$)/i.test(path.basename(name)), `final-like artifact included: ${name}`);
      const text = await zip.file(name).async('string');
      assert(!/\/Users\/|\/home\/|\/root\//.test(text), `absolute path found: ${name}`);
      assert(!/https?:\/\//.test(text), `URL found: ${name}`);
      assert(!/"(?:transcript|utterances)"\s*:|"words"\s*:\s*\[/.test(text), `transcript payload found: ${name}`);
    }
  });

  await test('UI report carries the draft-only status contract', async () => {
    const report = JSON.parse(readFileSync(REPORT_PATH, 'utf8'));
    assert(report.status === 'ready_draft', `status=${report.status}`);
    assert(report.accuracy === 'unavailable', `accuracy=${report.accuracy}`);
    assert(report.review_strategy === 'awaiting_research_team', `review=${report.review_strategy}`);
    assert(report.capabilities.ol === 'unavailable_in_draft' && report.capabilities.x === 'unavailable_in_draft', 'capability status wrong');
    assert(report.g1.overlap_candidates === 18 && report.g1.overlap_candidate_duration_sec === 9.451, 'overlap evidence wrong');
    assert(report.g1.overlap_subthreshold === 7 && report.g1.overlap_subthreshold_duration_sec === 0.403, 'subthreshold evidence wrong');
    assert(report.g1.unknown_residuals === 746, `unknown=${report.g1.unknown_residuals}`);
    assert(report.thresholds.every((threshold) => threshold.transition_evidence?.qualified_overlap_fto_suppressed === 4), 'overlap FTO suppression missing');
    assert(report.thresholds.every((threshold) => threshold.artifacts.some((item) => item.id.endsWith('_transition_evidence'))), 'transition evidence download missing');
  });

  await test('built UI contains v2 markers and excludes the legacy benchmark entry', async () => {
    const assets = path.join(ROOT, 'build-validation', 'assets');
    const bundle = readFileSync(path.join(assets, readdirSync(assets).find((name) => name.endsWith('.js'))), 'utf8');
    for (const marker of ['Multilogue04 v2', 'Draft integration evidence', 'Accuracy', 'Evidence & limitations', 'Research categories', 'Download package']) {
      assert(bundle.includes(marker), `missing bundle marker: ${marker}`);
    }
    assert(bundle.includes('501.013333s'), 'six-decimal canonical duration literal is absent');
    assert(!bundle.includes('501.013333 s'), 'legacy spaced canonical duration remains');
    for (const legacy of ['Multilogue L1a → L1b', 'Results by speaker', 'Download L1b package', 'Mandatory Human Gate']) {
      assert(!bundle.includes(legacy), `legacy primary entry remains: ${legacy}`);
    }
    assert(bundle.includes('/api/multilogue-v2/run') && bundle.includes('/api/multilogue-v2/file'), 'v2 API wiring absent');
  });

  const server = spawn(process.execPath, ['scripts/validation-sprint/server.mjs', '--port', String(PORT)], {
    cwd: ROOT,
    env: { ...process.env, MWU_V2_POC_ROOT: POC_ROOT },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let serverLog = '';
  server.stdout.on('data', (chunk) => { serverLog += chunk.toString(); });
  server.stderr.on('data', (chunk) => { serverLog += chunk.toString(); });
  let runEvidence = null;
  try {
    await waitForServer();
    await test('sandboxed input, status and report APIs return safe contracts', async () => {
      const input = await (await fetch(`${BASE}/api/multilogue-v2/input`)).json();
      const status = await (await fetch(`${BASE}/api/multilogue-v2/status`)).json();
      const report = await (await fetch(`${BASE}/api/multilogue-v2/report`)).json();
      assert(input.ready && input.recording_name.endsWith('.wav'), 'input not ready');
      assert(!JSON.stringify(input).includes(ROOT), 'input leaked absolute root');
      assert(Array.isArray(status.steps), 'status steps absent');
      assert(Array.isArray(status.events), 'immutable status events absent');
      assert(report.status === 'ready_draft', 'report not ready_draft');
      assert(!JSON.stringify(report).includes(ROOT), 'report leaked absolute root');
    });

    await test('file API rejects traversal, absolute and unlisted paths', async () => {
      for (const value of ['../../package.json', ROOT, 'phase-i/input-manifest.json']) {
        const response = await fetch(`${BASE}/api/multilogue-v2/file?path=${encodeURIComponent(value)}`);
        assert(response.status === 404, `${value} returned ${response.status}`);
      }
    });

    await test('POST run completes the real local G1 to G2 to ZIP path', async () => {
      const response = await fetch(`${BASE}/api/multilogue-v2/run`, { method: 'POST' });
      assert(response.status === 200, `run status=${response.status}`);
      runEvidence = await waitForRun();
      assert(runEvidence.progress.status === 'ready_draft', `progress=${runEvidence.progress.status}`);
      assert(JSON.stringify(runEvidence.progress.events.map((event) => event.key)) === JSON.stringify(PROGRESS_ORDER), 'event history order is wrong');
      for (const key of PROGRESS_ORDER) {
        assert(runEvidence.progress.steps.find((step) => step.key === key)?.status === 'passed', `step not passed: ${key}`);
      }
    });

    await test('progress events are monotonic and pass only after artifact hash evidence exists', async () => {
      const evaluated = evaluateProgressEvidence(runEvidence.progress, POC_ROOT);
      assert(evaluated.status === 'pass', JSON.stringify(evaluated.checks));
      assert(evaluated.events.length === 5, `events=${evaluated.events.length}`);
      assert(evaluated.events.every((event) => event.artifacts.length > 0), 'event lacks artifact proof');
      assert(evaluated.events.every((event) => event.artifacts.every((artifact) => artifact.exists && artifact.bytes_match && artifact.sha256_match)), 'artifact proof mismatch');
      assert(evaluated.events[1].artifacts.every((artifact) => artifact.path.startsWith('phase-ii/P025/')), 'P025 was not independently evidenced');
      assert(evaluated.events[2].artifacts.every((artifact) => artifact.path.startsWith('phase-ii/P035/')), 'P035 was not independently evidenced');
    });

    await test('progress evaluator rejects event reordering and artifact tampering', async () => {
      const reordered = structuredClone(runEvidence.progress);
      [reordered.events[1], reordered.events[2]] = [reordered.events[2], reordered.events[1]];
      assert(evaluateProgressEvidence(reordered, POC_ROOT).status === 'fail', 'reordered history passed');
      const tampered = structuredClone(runEvidence.progress);
      tampered.events[1].artifacts[0].sha256 = '0'.repeat(64);
      assert(evaluateProgressEvidence(tampered, POC_ROOT).status === 'fail', 'tampered artifact hash passed');
    });

    await test('network evidence is derived from G2 and rejects an injected network marker', async () => {
      const g2 = JSON.parse(readFileSync(path.join(POC_ROOT, 'gates', 'G2-path-b-gate-exit.json'), 'utf8'));
      const real = evaluateNetworkEvidence(g2);
      assert(real.status === 'pass', `real G2 local-only evidence did not pass: ${JSON.stringify(real.checks)}`);
      assert(real.source.required_source_count === NO_NETWORK_REQUIRED_SOURCE_IDS.length, 'required source count missing');
      for (const identifier of NO_NETWORK_REQUIRED_SOURCE_IDS) {
        assert(real.source.covered_identifiers.includes(identifier), `source coverage missing: ${identifier}`);
        const injected = structuredClone(g2);
        injected.operational_evidence.no_network_or_upload.forbidden_matches.push({
          source: identifier,
          rule: 'injected_network_capability_marker',
        });
        assert(evaluateNetworkEvidence(injected).status === 'fail', `injected network marker passed: ${identifier}`);
      }
      const staleHash = structuredClone(g2);
      staleHash.operational_evidence.no_network_or_upload.source_files[0].sha256 = '0'.repeat(64);
      assert(evaluateNetworkEvidence(staleHash).status === 'fail', 'stale source hash passed');
    });

    await test('report and package digest refresh after API run', async () => {
      const report = await (await fetch(`${BASE}/api/multilogue-v2/report`)).json();
      const zip = readFileSync(ZIP_PATH);
      assert(report.delivery.sha256 === createHash('sha256').update(zip).digest('hex'), 'ZIP digest mismatch');
      assert(report.delivery.entries === 25, `entries=${report.delivery.entries}`);
    });

    await test('real TextGrid and ZIP downloads return HTTP 200 with correct types', async () => {
      const textgrid = await fetch(`${BASE}/api/multilogue-v2/file?path=p025_textgrid`);
      const zip = await fetch(`${BASE}/api/multilogue-v2/file?path=delivery_zip`);
      assert(textgrid.status === 200 && /text\/plain/.test(textgrid.headers.get('content-type') || ''), 'TextGrid response wrong');
      assert(zip.status === 200 && /application\/zip/.test(zip.headers.get('content-type') || ''), 'ZIP response wrong');
      assert((await textgrid.arrayBuffer()).byteLength > 100000, 'TextGrid download too small');
      assert((await zip.arrayBuffer()).byteLength > 50000, 'ZIP download too small');
    });
  } finally {
    server.kill();
  }

  const formalHashesAfter = hashArtifactSet(FORMAL_ARTIFACTS);
  await test('delivery/API suite leaves all formal PoC artifacts byte-identical', async () => {
    assert(
      JSON.stringify(formalHashesAfter) === JSON.stringify(formalHashesBefore),
      `formal artifact hash changed: ${JSON.stringify({ before: formalHashesBefore, after: formalHashesAfter })}`,
    );
  });

  mkdirSync(ARTIFACT_DIR, { recursive: true });
  const result = {
    suite: 'multilogue-v2-g3-delivery',
    passed: cases.filter((item) => item.status === 'passed').length,
    failed: cases.filter((item) => item.status === 'failed').length,
    cases,
    actual_api_run_elapsed_ms: runEvidence?.elapsed_ms ?? null,
    actual_progress_events: runEvidence?.progress?.events?.map(({ sequence, key, occurred_at, event_sha256, artifacts }) => ({
      sequence, key, occurred_at, event_sha256, artifact_count: artifacts.length,
    })) || [],
    status_snapshots: runEvidence?.snapshots || [],
    server_log_tail: serverLog.trim().split('\n').slice(-5).map((line) => line.replaceAll(ROOT, '<repo>')),
    output_isolation: {
      env: 'MWU_V2_POC_ROOT',
      formal_artifact_hashes_before: formalHashesBefore,
      formal_artifact_hashes_after: formalHashesAfter,
      formal_artifacts_unchanged: JSON.stringify(formalHashesAfter) === JSON.stringify(formalHashesBefore),
    },
    generated_at: new Date().toISOString(),
  };
  writeFileSync(path.join(ARTIFACT_DIR, 'test-report.json'), `${JSON.stringify(result, null, 2)}\n`);
  rmSync(TEST_SANDBOX, { recursive: true, force: true });
  console.log(`\n${result.passed}/${cases.length} tests passed`);
  if (result.failed) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
