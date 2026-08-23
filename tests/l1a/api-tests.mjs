#!/usr/bin/env node

import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SERVER = path.join(ROOT, 'scripts', 'validation-sprint', 'server.mjs');
const ARTIFACT_DIR = path.join(ROOT, 'tests', 'l1a', 'artifacts');
const cases = [];

function wavBuffer({ seconds = 2.4, sampleRate = 16000 } = {}) {
  const frames = Math.floor(seconds * sampleRate);
  const dataSize = frames * 2;
  const buffer = Buffer.alloc(44 + dataSize);
  buffer.write('RIFF', 0, 'ascii');
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write('WAVE', 8, 'ascii');
  buffer.write('fmt ', 12, 'ascii');
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * 2, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write('data', 36, 'ascii');
  buffer.writeUInt32LE(dataSize, 40);
  return buffer;
}

function decisions(count, swapped = false) {
  return Array.from({ length: count }, (_, index) => ({
    candidate_id: `SPEAKER_${String(index).padStart(2, '0')}`,
    decision: 'include',
    role: 'participant',
    canonical_speaker: `S${swapped ? count - index : index + 1}`,
  }));
}

function freePort() {
  return new Promise((resolve, reject) => {
    const socket = net.createServer();
    socket.listen(0, '127.0.0.1', () => {
      const address = socket.address();
      socket.close(() => resolve(address.port));
    });
    socket.on('error', reject);
  });
}

async function waitUntil(check, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await check();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('Timed out waiting for API state');
}

async function json(url, options) {
  const response = await fetch(url, options);
  let body;
  try { body = await response.json(); } catch { body = null; }
  return { response, body };
}

function abortedUpload(port) {
  return new Promise((resolve) => {
    const request = http.request({
      host: '127.0.0.1', port, path: '/api/l1a/run?filename=aborted.wav', method: 'POST',
      headers: { 'content-type': 'audio/wav', 'content-length': '90000' },
    });
    request.on('error', () => resolve());
    request.write(Buffer.alloc(128));
    request.destroy();
    setTimeout(resolve, 150);
  });
}

async function runCase(name, fn) {
  const started = Date.now();
  try {
    await fn();
    cases.push({ name, status: 'passed', duration_ms: Date.now() - started });
    console.log(`PASS ${name}`);
  } catch (error) {
    cases.push({ name, status: 'failed', duration_ms: Date.now() - started, error: error.stack || String(error) });
    console.error(`FAIL ${name}\n${error.stack || error}`);
  }
}

async function main() {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'mwu-l1a-api-'));
  const acceptedRoot = path.join(temporary, 'accepted');
  const reviewRoot = path.join(acceptedRoot, 'sessions');
  const l1bRoot = path.join(temporary, 'l1b');
  const usageLedger = path.join(temporary, 'usage', 'provider-usage-ledger.json');
  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const server = spawn(process.execPath, [SERVER, '--port', String(port)], {
    cwd: ROOT,
    env: {
      ...process.env,
      MWU_AUTH_DISABLED: '1',
      MWU_L1A_TEST_MODE: '1',
      MWU_L1A_ROOT: reviewRoot,
      MWU_MULTILOGUE_OUT: acceptedRoot,
      MWU_L1B_ROOT: l1bRoot,
      MWU_L1A_MAX_WAV_BYTES: '100000',
      MWU_USAGE_LEDGER: usageLedger,
    },
    stdio: 'ignore',
  });

  try {
    await waitUntil(async () => (await fetch(`${baseUrl}/api/l1a/runs`).catch(() => null))?.ok);

    await runCase('workspace usage API exposes an empty real ledger without placeholder values', async () => {
      const result = await json(`${baseUrl}/api/workspace/usage`);
      assert.equal(result.response.status, 200);
      assert.equal(result.body.schema_version, 'mwu-workspace-usage-summary-v1');
      assert.equal(result.body.allowance.limit_hours, 100);
      assert.equal(result.body.allowance.used_hours, 0);
      assert.equal(result.body.source_audio.unique_files, 0);
      assert.equal(result.body.completed_calls, 0);
      assert.equal(result.body.historical_backfill, false);
    });

    await runCase('oversized and aborted L1a uploads are rejected without wedging the server', async () => {
      const oversized = await json(`${baseUrl}/api/l1a/run?filename=too-large.wav`, {
        method: 'POST', headers: { 'content-type': 'audio/wav' }, body: Buffer.alloc(100001),
      });
      assert.equal(oversized.response.status, 413);
      await abortedUpload(port);
      const health = await fetch(`${baseUrl}/api/l1a/runs`);
      assert.equal(health.status, 200);
    });

    let runId;
    await runCase('shared single-task gate blocks L1b while L1a owns the workspace', async () => {
      const upload = await json(`${baseUrl}/api/l1a/run?filename=gate-recording.wav`, {
        method: 'POST',
        headers: { 'content-type': 'audio/wav', 'x-mwu-test-candidate-count': '3', 'x-mwu-test-hold-ms': '700' },
        body: wavBuffer(),
      });
      assert.equal(upload.response.status, 201);
      runId = upload.body.run_id;
      const sessionInput = path.join(acceptedRoot, 'sessions', runId, 'input');
      assert.ok(fs.existsSync(path.join(sessionInput, 'source.wav')));
      const inputManifest = JSON.parse(fs.readFileSync(path.join(sessionInput, 'input_manifest.json'), 'utf8'));
      assert.equal(inputManifest.session_id, runId);
      assert.equal(inputManifest.original_filename, 'gate-recording.wav');
      assert.match(inputManifest.sha256, /^[a-f0-9]{64}$/);
      const blocked = await json(`${baseUrl}/api/l1b/run`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
      });
      assert.equal(blocked.response.status, 409);
      assert.equal(blocked.body.active_task, 'l1a');
      await new Promise((resolve) => setTimeout(resolve, 800));
    });

    await runCase('audio API supports suffix ranges and rejects invalid ranges', async () => {
      const suffix = await fetch(`${baseUrl}/api/l1a/runs/${runId}/audio`, { headers: { range: 'bytes=-64' } });
      assert.equal(suffix.status, 206);
      assert.equal((await suffix.arrayBuffer()).byteLength, 64);
      assert.match(suffix.headers.get('content-range') || '', /^bytes \d+-\d+\/\d+$/);
      const invalid = await fetch(`${baseUrl}/api/l1a/runs/${runId}/audio`, { headers: { range: 'bytes=bad' } });
      assert.equal(invalid.status, 416);
    });

    await runCase('unknown and malformed API paths return structured 404 responses', async () => {
      for (const url of [`${baseUrl}/api/not-a-route`, `${baseUrl}/api/l1a/runs/%E0%A4%A/candidates`]) {
        const result = await json(url);
        assert.equal(result.response.status, 404);
        assert.equal(result.body.error, 'API route not found');
      }
    });

    await runCase('malformed acceptance JSON is rejected without losing the run', async () => {
      const malformed = await json(`${baseUrl}/api/l1a/runs/${runId}/confirm`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: '{not-json',
      });
      assert.equal(malformed.response.status, 400);
      const snapshot = await json(`${baseUrl}/api/l1a/runs/${runId}/candidates`);
      assert.equal(snapshot.response.status, 200);
      assert.equal(snapshot.body.candidates.candidate_count, 3);
    });

    let manifestPath;
    await runCase('single acceptance action records the review and sealed checksums', async () => {
      const confirmation = await json(`${baseUrl}/api/l1a/runs/${runId}/confirm`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ reviewer: 'rater-api-01', decisions: decisions(3) }),
      });
      assert.equal(confirmation.response.status, 200, JSON.stringify(confirmation.body));
      manifestPath = confirmation.body.state.accepted_manifest;
      assert.equal(confirmation.body.manifest.recording_id, 'gate-recording');
      assert.equal(confirmation.body.manifest.lifecycle.status, 'accepted');
      assert.match(confirmation.body.manifest.sealed_evidence.source_wav.sha256, /^[a-f0-9]{64}$/);
      assert.match(confirmation.body.manifest.sealed_evidence.accepted_review.sha256, /^[a-f0-9]{64}$/);
      assert.ok(confirmation.body.manifest.sealed_evidence.artifacts.length >= 8);
      const input = await json(`${baseUrl}/api/l1b/input`);
      assert.equal(input.body.selected.recording_id, 'gate-recording');
      assert.equal(input.body.ready, true);
      assert.equal(input.body.available.length, 1);
      assert.equal(input.body.accepted.length, 1);
      assert.equal(input.body.accepted[0].recording_id, 'gate-recording');
      assert.equal(input.body.accepted[0].l1b_runnable, true);
      assert.equal(input.body.accepted[0].path_b_evidence.ready, false);
      assert.deepEqual(input.body.accepted[0].l1b_blockers, []);
    });

    await runCase('mapping changes supersede the prior L1b handoff', async () => {
      const changed = await json(`${baseUrl}/api/l1a/runs/${runId}/confirm`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ reviewer: 'rater-api-01', decisions: decisions(3, true) }),
      });
      assert.equal(changed.response.status, 200);
      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
      const handoff = JSON.parse(fs.readFileSync(manifest.outputs.phase_ii_handoff_manifest, 'utf8'));
      assert.equal(manifest.lifecycle.status, 'superseded');
      assert.equal(manifest.phase_ii_handoff.ready, false);
      assert.equal(handoff.status, 'superseded');
      assert.equal(handoff.ready, false);

      const input = await json(`${baseUrl}/api/l1b/input`);
      assert.notEqual(input.body.selected, null);
      assert.equal(input.body.ready, true);
      assert.notEqual(input.body.selected.path, manifestPath);
      assert.equal(input.body.accepted.length, 1);
      assert.equal(input.body.accepted[0].l1b_runnable, true);
      assert.equal(input.body.accepted[0].path, input.body.selected.path);
      const explicitOldRun = await json(`${baseUrl}/api/l1b/run`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ manifest: manifestPath }),
      });
      assert.equal(explicitOldRun.response.status, 400);
      assert.equal(explicitOldRun.body.lifecycle_status, 'superseded');
    });
  } finally {
    server.kill('SIGTERM');
  }

  const report = {
    schema_version: 'l1a-api-regression-v1',
    generated_at: new Date().toISOString(),
    suite: 'Layer 1a HTTP, sealed Path B handoff and task-gate regression',
    requirements: ['L1A-001', 'L1A-002', 'L1A-004', 'L1A-006', 'L1A-007', 'L1A-008', 'L1A-009', 'L1A-010', 'L1A-011', 'L1A-012', 'L1A-013', 'L1A-018'],
    passed: cases.filter((item) => item.status === 'passed').length,
    failed: cases.filter((item) => item.status === 'failed').length,
    cases,
    data_boundary: 'Synthetic WAV only; no participant data, credentials or external provider calls.',
  };
  fs.mkdirSync(ARTIFACT_DIR, { recursive: true });
  fs.writeFileSync(path.join(ARTIFACT_DIR, 'l1a-api-test-report.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  console.log(`\n${report.passed} passed / ${report.failed} failed`);
  if (report.failed) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
