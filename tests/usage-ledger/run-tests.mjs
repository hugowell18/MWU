#!/usr/bin/env node

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  recordProviderUsage,
  summarizeProviderUsage,
} from '../../scripts/usage/provider-usage-ledger.mjs';

const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'mwu-usage-ledger-'));
const ledgerPath = path.join(temporary, 'usage.json');
const audioA = path.join(temporary, 'source-a.wav');
const audioB = path.join(temporary, 'source-b.wav');
const cases = [];

fs.writeFileSync(audioA, Buffer.from('source-a'));
fs.writeFileSync(audioB, Buffer.from('source-b'));

async function test(name, fn) {
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

await test('empty summary initializes a real zero-value ledger', async () => {
  const summary = summarizeProviderUsage({ ledgerPath, limitHours: 5 });
  assert.equal(summary.allowance.used_hours, 0);
  assert.equal(summary.source_audio.unique_files, 0);
  assert.equal(summary.completed_calls, 0);
  assert.equal(summary.historical_backfill, false);
  assert.ok(fs.existsSync(ledgerPath));
});

await test('completed provider calls accumulate while unique source audio is deduplicated', async () => {
  await recordProviderUsage({ provider: 'assemblyai', jobId: 'a-1', durationSeconds: 3600, sourceAudioPath: audioA, requestedModel: 'u3', ledgerPath });
  await recordProviderUsage({ provider: 'assemblyai', jobId: 'a-2', durationSeconds: 3600, sourceAudioPath: audioA, requestedModel: 'u3', ledgerPath });
  await recordProviderUsage({ provider: 'pyannoteai', jobId: 'p-1', durationSeconds: 7200, sourceAudioPath: audioB, requestedModel: 'community-1', ledgerPath });
  const summary = summarizeProviderUsage({ ledgerPath, limitHours: 5, warningPercent: 80, criticalPercent: 95 });
  assert.equal(summary.allowance.used_hours, 4);
  assert.equal(summary.allowance.usage_percent, 80);
  assert.equal(summary.allowance.state, 'warning');
  assert.equal(summary.source_audio.unique_files, 2);
  assert.equal(summary.source_audio.unique_hours, 3);
  assert.deepEqual(summary.providers.assemblyai, { hours: 2, calls: 2 });
  assert.deepEqual(summary.providers.pyannoteai, { hours: 2, calls: 1 });
});

await test('provider job IDs are idempotent but a new rerun counts again', async () => {
  const duplicate = await recordProviderUsage({ provider: 'pyannoteai', jobId: 'p-1', durationSeconds: 7200, sourceAudioPath: audioB, ledgerPath });
  assert.equal(duplicate.recorded, false);
  assert.equal(summarizeProviderUsage({ ledgerPath, limitHours: 5 }).allowance.used_hours, 4);

  await recordProviderUsage({ provider: 'pyannoteai', jobId: 'p-2', durationSeconds: 3600, sourceAudioPath: audioA, ledgerPath });
  const summary = summarizeProviderUsage({ ledgerPath, limitHours: 5 });
  assert.equal(summary.allowance.used_hours, 5);
  assert.equal(summary.allowance.state, 'exceeded');
  assert.equal(summary.source_audio.unique_files, 2);
});

await test('ledger stores no absolute source path or credentials', async () => {
  const raw = fs.readFileSync(ledgerPath, 'utf8');
  assert.ok(!raw.includes(temporary));
  assert.ok(!raw.includes('api_key'));
  assert.ok(raw.includes('source-a.wav'));
});

const report = {
  schema_version: 'mwu-usage-ledger-test-report-v1',
  generated_at: new Date().toISOString(),
  requirements: ['SYS-012', 'UI-015'],
  passed: cases.filter((item) => item.status === 'passed').length,
  failed: cases.filter((item) => item.status === 'failed').length,
  cases,
};

const artifactDir = path.resolve('tests/usage-ledger/artifacts');
fs.mkdirSync(artifactDir, { recursive: true });
fs.writeFileSync(path.join(artifactDir, 'usage-ledger-test-report.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
console.log(`\n${report.passed} passed / ${report.failed} failed`);
if (report.failed) process.exitCode = 1;
