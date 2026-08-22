#!/usr/bin/env node

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { assessL1aPathBReadiness } from '../../scripts/l1a/build-path-b-evidence.mjs';
import { assessL1aHandoff } from '../../scripts/l1a/handoff-gate.mjs';
import { runFromAcceptedL1a } from '../../scripts/l1b/run-from-l1a.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SESSION_ROOT = path.join(ROOT, 'outputs', 'multilogue-validation', 'sessions');
const LABELS = new Set(['s', 'f', 'bc', 'ol', 'op', 'pf', 'tr', 'shs', 'x']);
const cases = [];

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function walk(dir, output = []) {
  if (!fs.existsSync(dir)) return output;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(file, output);
    else if (entry.name.endsWith('.reviewed.phase1_manifest.json')) output.push(file);
  }
  return output;
}

function currentSealedThreeSpeakerManifest() {
  const candidates = walk(SESSION_ROOT)
    .map((file) => ({ file, mtime: fs.statSync(file).mtimeMs }))
    .sort((left, right) => right.mtime - left.mtime);
  for (const candidate of candidates) {
    const manifest = JSON.parse(fs.readFileSync(candidate.file, 'utf8'));
    if (manifest.speakers?.length !== 3) continue;
    if (!assessL1aHandoff({ manifestPath: candidate.file }).passed) continue;
    if (!assessL1aPathBReadiness({ manifestPath: candidate.file }).passed) continue;
    return candidate.file;
  }
  throw new Error('No sealed three-speaker L1a-to-Path-B fixture is available.');
}

function csvLabels(file) {
  const lines = fs.readFileSync(file, 'utf8').trim().split(/\r?\n/);
  const headers = lines.shift().split(',');
  const labelIndex = headers.indexOf('label');
  assert.notEqual(labelIndex, -1, 'nine-label CSV has no label column');
  return new Set(lines.map((line) => line.split(',')[labelIndex]));
}

async function test(name, fn) {
  try {
    await fn();
    cases.push({ name, status: 'passed' });
    console.log(`PASS ${name}`);
  } catch (error) {
    cases.push({ name, status: 'failed', error: error.stack || String(error) });
    console.error(`FAIL ${name}\n${error.stack || error}`);
  }
}

async function main() {
  const manifestPath = currentSealedThreeSpeakerManifest();
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const gate = assessL1aHandoff({ manifestPath });
  const pathB = assessL1aPathBReadiness({ manifestPath });
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'mwu-l1b-path-b-'));

  try {
    await test('L1a must pass both the accepted handoff and sealed Path B evidence gates', () => {
      assert.equal(gate.passed, true, JSON.stringify(gate.blockers));
      assert.equal(pathB.passed, true, JSON.stringify(pathB.blockers));
      assert.match(gate.sealed_handoff_identity.identity_sha256, /^[a-f0-9]{64}$/);
      assert.match(pathB.sealed_evidence_identity.identity_sha256, /^[a-f0-9]{64}$/);
    });

    await test('L1a customer handoff remains exactly N+3 files', () => {
      const n = manifest.speakers.length;
      const clientFiles = [
        manifest.outputs.speaker_textgrid,
        manifest.outputs.rttm,
        manifest.outputs.speaker_turns_csv,
        ...manifest.outputs.muted_mirror_wavs.map((item) => item.muted_mirror_wav),
      ];
      assert.equal(clientFiles.length, n + 3);
      assert.equal(new Set(clientFiles).size, n + 3);
      assert.ok(clientFiles.every((file) => fs.existsSync(file)));
    });

    const runOnce = async (name) => {
      const out = path.join(temp, name, 'outputs');
      const progress = path.join(temp, name, 'logs', 'progress.json');
      return runFromAcceptedL1a({
        manifestPath,
        out,
        thresholds: [0.25, 0.35],
        progressFile: progress,
      });
    };
    const first = await runOnce('run-a');
    const second = await runOnce('run-b');

    await test('L1b emits separate P025 and P035 Path B drafts from the sealed L1a identity', () => {
      assert.equal(first.report.status, 'ready_for_praat_review');
      assert.deepEqual(first.report.thresholds, [0.25, 0.35]);
      assert.equal(first.report.handoff_gate.l1a_identity_sha256, gate.sealed_handoff_identity.identity_sha256);
      assert.equal(first.report.handoff_gate.path_b_identity_sha256, pathB.sealed_evidence_identity.identity_sha256);
      assert.equal(first.report.threshold_reports.length, 2);
      for (const threshold of first.report.threshold_reports) {
        assert.equal(threshold.schema_valid, true);
        assert.equal(threshold.tier5_consistent, true);
        assert.ok(fs.existsSync(threshold.textgrid));
      }
    });

    await test('each threshold keeps the six-tier Gold instance and controlled nine-label vocabulary', () => {
      for (const threshold of first.report.threshold_reports) {
        const textgrid = fs.readFileSync(threshold.textgrid, 'utf8');
        const tierCount = (textgrid.match(/^\s*item \[\d+\]:/gm) || []).length;
        assert.equal(tierCount, manifest.speakers.length + 3);
        const labels = csvLabels(path.join(path.dirname(threshold.textgrid), 'nine_label_intervals.csv'));
        assert.ok([...labels].every((label) => LABELS.has(label)), `unexpected labels: ${[...labels].filter((label) => !LABELS.has(label)).join(', ')}`);
      }
    });

    await test('sealed evidence replay is byte-deterministic for research-facing tables and TextGrids', () => {
      const comparable = (report) => report.threshold_reports.flatMap((threshold) => [
        threshold.textgrid,
        path.join(path.dirname(threshold.textgrid), 'nine_label_intervals.csv'),
        path.join(path.dirname(threshold.textgrid), 'per_pause.csv'),
        path.join(path.dirname(threshold.textgrid), 'transition_evidence.csv'),
      ]);
      assert.deepEqual(comparable(first.report).map(sha256), comparable(second.report).map(sha256));
    });

    await test('Gold reference is not used as a generation input', () => {
      const payload = JSON.stringify({ report: first.report, progress: JSON.parse(fs.readFileSync(path.join(temp, 'run-a', 'logs', 'progress.json'), 'utf8')) });
      assert.doesNotMatch(payload, /corrected_6tier|gold_script|gold_reference/i);
    });
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }

  const failed = cases.filter((item) => item.status === 'failed').length;
  console.log(`\nL1B PATH B: ${cases.length - failed} passed / ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main();
