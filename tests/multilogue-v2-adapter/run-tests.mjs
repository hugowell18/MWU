#!/usr/bin/env node

import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildCanonicalMapping,
  buildStage1Evidence,
  clipProviderInterval,
  probeDurationSeconds,
  runAdapter,
} from '../../scripts/multilogue-v2/adapters/build-stage1-evidence.mjs';
import { runMultilogueV2 } from '../../scripts/multilogue-v2/core/pipeline.mjs';

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const ADAPTER_PATH = path.resolve(TEST_DIR, '../../scripts/multilogue-v2/adapters/build-stage1-evidence.mjs');
const ARTIFACT_DIR = path.join(TEST_DIR, 'artifacts');
const tests = [];

function test(name, fn) {
  tests.push({ name, fn });
}

function comparisonFixture() {
  return {
    mapping_candidate_to_reference: {
      P0: 'A',
      P1: 'C',
      P2: 'B',
    },
  };
}

function providerFixture({ includeUnresolved = false } = {}) {
  const words = [
    { start: 100, end: 220, speaker: 'A', confidence: 0.9, text: 'Um' },
    { start: 260, end: 480, speaker: 'A', confidence: 0.95, text: 'topic' },
    { start: 800, end: 980, speaker: 'C', confidence: 0.92, text: 'yes' },
    { start: 1250, end: 1450, speaker: 'B', confidence: 0.91, text: 'next' },
  ];
  if (includeUnresolved) words.push({ start: 1750, end: 1850, speaker: 'A', confidence: 0.8, text: 'outside' });
  return {
    pyannoteRaw: {
      turns: [
        { start: 0, end: 0.7, speaker: 'P0', confidence: null },
        { start: 0.75, end: 1.05, speaker: 'P1', confidence: null },
        { start: 1.15, end: 1.6, speaker: 'P2', confidence: null },
      ],
    },
    assemblyRaw: { words },
  };
}

test('builds an explicit bijective provider mapping with provenance', () => {
  const result = buildCanonicalMapping(comparisonFixture());
  assert.deepEqual(result.mapping.pyannote, { P0: 'S1', P1: 'S2', P2: 'S3' });
  assert.deepEqual(result.mapping.assemblyai, { A: 'S1', C: 'S2', B: 'S3' });
  assert.deepEqual(result.provenance.canonical_id_assignment.ordered_pyannote_labels, ['P0', 'P1', 'P2']);
  assert.equal(result.provenance.canonical_id_assignment.temporary, true);
  assert.equal(result.provenance.canonical_id_assignment.researcher_confirmed_identity, false);
  assert.equal(result.provenance.accuracy_claim, false);
});

test('assigns words and applies only the controlled filled-pause rule', () => {
  const fixture = providerFixture();
  const result = buildStage1Evidence({
    duration: 2,
    ...fixture,
    comparison: comparisonFixture(),
    roomSoundingIntervals: [{ start: 0, end: 1.6 }],
  });
  const filler = result.pipelineInput.stage1Evidence.find((event) => event.tokens.includes('um'));
  const lexical = result.pipelineInput.stage1Evidence.find((event) => event.tokens.includes('topic'));
  assert.equal(filler.speaker, 'S1');
  assert.equal(filler.lexical_class, 'filled_pause');
  assert.equal(lexical.lexical_class, 'lexical');
  assert.equal(result.stats.assigned_word_count, 4);
});

test('keeps a zero-overlap word unresolved instead of trusting its provider label', () => {
  const fixture = providerFixture({ includeUnresolved: true });
  const result = buildStage1Evidence({
    duration: 2,
    ...fixture,
    comparison: comparisonFixture(),
    roomSoundingIntervals: [{ start: 0, end: 1.6 }],
  });
  assert.equal(result.stats.unresolved_word_count, 1);
  assert(result.wordFlags.some((flag) => flag.code === 'unresolved_word_assignment'));
  const expectedDownstreamFlags =
    result.pipelineInput.initialFlags.length
    + result.mappingFlags.length
    + result.wordFlags.length
    + result.pipelineInput.stage1Evidence.filter((event) => event.confidence == null).length;
  assert.equal(result.stats.review_flag_count, expectedDownstreamFlags);
});

test('preserves non-word attributed activity as unknown review evidence', () => {
  const fixture = providerFixture();
  const result = buildStage1Evidence({
    duration: 2,
    ...fixture,
    comparison: comparisonFixture(),
    roomSoundingIntervals: [{ start: 0, end: 1.6 }],
  });
  const unknown = result.pipelineInput.stage1UnknownEvidence;
  assert(unknown.length > 0);
  assert(unknown.every((event) => event.lexical_class === 'unknown'));
  assert(unknown.every((event) => event.review_codes.includes('unclassified_non_word_activity')));
  assert(unknown.every((event) => event.provisional_kind === 'unknown'));
  assert(result.pipelineInput.stage1Evidence.every((event) => event.evidence_state === 'known'));
  assert.equal(
    result.pipelineInput.initialFlags.filter((flag) => flag.code === 'unclassified_non_word_activity').length,
    unknown.length,
  );
  assert(result.pipelineInput.initialFlags.filter((flag) => flag.code === 'provider_overlap_candidate')
    .every((flag) => result.pipelineInput.providerOverlapCandidates.some((candidate) => candidate.id === flag.related_id)));
});

test('clips intersecting intervals and rejects wholly out-of-range evidence', () => {
  const flags = [];
  const clipped = clipProviderInterval({
    provider: 'provider-a', itemType: 'word', id: 'w1', start: 1.8, end: 2.2, duration: 2, clockFlags: flags,
  });
  const rejected = clipProviderInterval({
    provider: 'provider-a', itemType: 'word', id: 'w2', start: 2.1, end: 2.2, duration: 2, clockFlags: flags,
  });
  assert.deepEqual(clipped, { id: 'w1', start: 1.8, end: 2 });
  assert.equal(rejected, null);
  assert.deepEqual(flags.map((flag) => flag.action), ['clipped', 'rejected']);
});

test('produces input that the deterministic core can consume', () => {
  const fixture = providerFixture();
  const result = buildStage1Evidence({
    duration: 2,
    ...fixture,
    comparison: comparisonFixture(),
    roomSoundingIntervals: [{ start: 0, end: 1.6 }],
  });
  const output = runMultilogueV2(result.pipelineInput);
  assert.deepEqual(Object.keys(output.thresholds), ['P250', 'P350']);
  assert(Object.values(output.thresholds).every((entry) => entry.validation.valid));
});

test('contains no network client or provider SDK path', () => {
  const source = readFileSync(ADAPTER_PATH, 'utf8');
  const forbidden = [
    /\bfetch\s*\(/,
    /from\s+['"]node:https?['"]/,
    /https?:\/\//,
    /axios/,
    /@assemblyai\//,
    /pyannote.*sdk/i,
  ];
  assert.deepEqual(forbidden.filter((pattern) => pattern.test(source)), []);
});

test('runs the local cache-only integration path on a generic fixture', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'stage1-cache-test-'));
  try {
    const audio = path.join(root, 'input.wav');
    const pyannoteTurns = path.join(root, 'turns.json');
    const pyannoteManifest = path.join(root, 'manifest.json');
    const assemblyai = path.join(root, 'words.json');
    const comparison = path.join(root, 'mapping.json');
    const outputDir = path.join(root, 'out');
    writeTestWav(audio, 2);
    const fixture = providerFixture();
    writeJson(pyannoteTurns, fixture.pyannoteRaw);
    writeJson(pyannoteManifest, {
      duration_seconds: 2,
      method: { provider: 'provider-a', model: 'model-a', model_revision: null },
    });
    writeJson(assemblyai, {
      ...fixture.assemblyRaw,
      audio_duration: 2,
      speech_model_used: 'model-b',
      speakers_expected: 3,
      disfluencies: true,
    });
    writeJson(comparison, comparisonFixture());
    const result = runAdapter({ audio, pyannoteTurns, pyannoteManifest, assemblyai, comparison, outputDir });
    assert.equal(probeDurationSeconds(audio), 2);
    assert.equal(result.pipelineInput.recordingId, 'input');
    assert.equal(result.inputManifest.recording_id, 'input');
    assert.equal(result.report.status, 'pass');
    assert(Object.values(result.report.gate_checks).every(Boolean));
    assert.equal(result.report.security.network_calls_performed, false);
    const serialized = [
      'input-manifest.json', 'provider-mapping.json', 'room-activity-base.json',
      'stage1-evidence.json', 'phase1-gate-report.json',
    ].map((name) => readFileSync(path.join(outputDir, name), 'utf8')).join('\n');
    assert(!serialized.includes(root));
    assert(!serialized.includes('audio_url'));
    assert(!serialized.includes('api_key'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

let passed = 0;
const failures = [];
for (const entry of tests) {
  try {
    await entry.fn();
    passed += 1;
    process.stdout.write(`PASS ${entry.name}\n`);
  } catch (error) {
    failures.push({ name: entry.name, message: error.message, stack: error.stack });
    process.stderr.write(`FAIL ${entry.name}: ${error.message}\n`);
  }
}

mkdirSync(ARTIFACT_DIR, { recursive: true });
writeJson(path.join(ARTIFACT_DIR, 'test-report.json'), {
  suite: 'multilogue-v2-stage1-adapter',
  passed,
  failed: failures.length,
  tests: tests.map((entry) => ({ name: entry.name, status: failures.some((failure) => failure.name === entry.name) ? 'fail' : 'pass' })),
  failures: failures.map(({ name, message }) => ({ name, message })),
  fixture_policy: 'synthetic_generic_only',
  network_calls_performed: false,
});

process.stdout.write(`\n${passed} passed, ${failures.length} failed\n`);
if (failures.length) process.exitCode = 1;

function writeJson(filePath, value) {
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function writeTestWav(filePath, durationSeconds) {
  const sampleRate = 16000;
  const sampleCount = sampleRate * durationSeconds;
  const dataBytes = sampleCount * 2;
  const buffer = Buffer.alloc(44 + dataBytes);
  buffer.write('RIFF', 0);
  buffer.writeUInt32LE(36 + dataBytes, 4);
  buffer.write('WAVE', 8);
  buffer.write('fmt ', 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * 2, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write('data', 36);
  buffer.writeUInt32LE(dataBytes, 40);
  for (let index = 0; index < sampleCount; index += 1) {
    const active = index > sampleRate * 0.1 && index < sampleRate * 1.6;
    const sample = active ? Math.round(Math.sin((2 * Math.PI * 220 * index) / sampleRate) * 8000) : 0;
    buffer.writeInt16LE(sample, 44 + index * 2);
  }
  writeFileSync(filePath, buffer);
}
