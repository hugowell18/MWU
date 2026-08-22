#!/usr/bin/env node

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  completeProviderRun,
  confirmReview,
  createL1aRun,
  getRunSnapshot,
  resolveAcceptedArtifact,
  saveReviewDraft,
  verifySealedManifest,
} from '../../scripts/l1a/review-core.mjs';
import { assessL1aHandoff } from '../../scripts/l1a/handoff-gate.mjs';
import {
  assessL1aPathBReadiness,
  buildL1aPathBEvidence,
} from '../../scripts/l1a/build-path-b-evidence.mjs';
import { readWavForMuting } from '../../scripts/phase1/lib/diarization-artifacts.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SERVER = path.join(ROOT, 'scripts', 'validation-sprint', 'server.mjs');
const ARTIFACT_DIR = path.join(ROOT, 'tests', 'l1a', 'artifacts');
const cases = [];
let fixtureSequence = 0;

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
  for (let frame = 0; frame < frames; frame += 1) {
    buffer.writeInt16LE(Math.round(Math.sin(frame / 20) * 1200), 44 + frame * 2);
  }
  return buffer;
}

function turnsFor(count, duration = 2.4) {
  const turns = [];
  const slot = duration / (count * 3 + 1);
  let cursor = slot / 2;
  for (let round = 0; round < 3; round += 1) {
    for (let index = 0; index < count; index += 1) {
      turns.push({
        speaker: `SPEAKER_${String(index).padStart(2, '0')}`,
        start: cursor,
        end: Math.min(duration, cursor + slot * 0.7),
        confidence: 0.9,
      });
      cursor += slot;
    }
  }
  return turns;
}

function decisionsFor(count, { merge = false, exclude = false } = {}) {
  const result = [];
  let canonical = 1;
  for (let index = 0; index < count; index += 1) {
    const candidate = `SPEAKER_${String(index).padStart(2, '0')}`;
    if (merge && index === count - 2) {
      result.push({ candidate_id: candidate, decision: 'merge', role: 'participant', merge_into: 'SPEAKER_00' });
    } else if (exclude && index === count - 1) {
      result.push({ candidate_id: candidate, decision: 'exclude', role: 'other_or_incidental' });
    } else {
      result.push({ candidate_id: candidate, decision: 'include', role: 'participant', canonical_speaker: `S${canonical}` });
      canonical += 1;
    }
  }
  return result;
}

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function makeFixture(base, count) {
  fixtureSequence += 1;
  const fixtureId = `${count}-${fixtureSequence}`;
  const root = path.join(base, `review-${fixtureId}`);
  const acceptedRoot = path.join(base, `accepted-${fixtureId}`);
  const created = createL1aRun({ root, filename: `group-${count}.wav`, wavBuffer: wavBuffer(), runId: `fixture-${fixtureId}` });
  completeProviderRun({ root, runId: created.state.run_id, turns: turnsFor(count), provider: { source: 'synthetic', model: 'test' } });
  return { root, acceptedRoot, runId: created.state.run_id };
}

function findArtifact(manifest, predicate) {
  const files = [
    manifest.outputs.speaker_turns_json,
    manifest.outputs.speaker_turns_csv,
    manifest.outputs.rttm,
    manifest.outputs.speaker_textgrid,
    ...(manifest.outputs.muted_mirror_wavs || []).map((item) => item.muted_mirror_wav),
  ];
  return files.find(predicate);
}

function acceptedFixture(base, count, suffix = '') {
  const fixture = makeFixture(base, count);
  const review = saveReviewDraft({
    root: fixture.root,
    runId: fixture.runId,
    payload: { reviewer: `qa${suffix}`, decisions: decisionsFor(count) },
  });
  const confirmed = confirmReview({ root: fixture.root, acceptedRoot: fixture.acceptedRoot, runId: fixture.runId });
  return { ...fixture, review, confirmed };
}

function syntheticAssemblyRaw(manifest) {
  const providerByCanonical = new Map(manifest.speakers.map((speaker, index) => [speaker, String.fromCharCode(65 + index)]));
  const turns = JSON.parse(fs.readFileSync(manifest.outputs.speaker_turns_json, 'utf8')).turns;
  const utterances = turns.map((turn, index) => ({
    speaker: providerByCanonical.get(String(turn.speaker).replace(/^speaker_/, '')),
    start: Math.round(Number(turn.start) * 1000),
    end: Math.round(Number(turn.end) * 1000),
    confidence: 0.95,
    text: `word${index + 1}`,
  }));
  return {
    audio_duration: manifest.duration_seconds,
    speech_model_used: 'synthetic-timed-words',
    speakers_expected: manifest.speakers.length,
    disfluencies: true,
    utterances,
    words: utterances.map((utterance, index) => ({ ...utterance, text: index % 5 === 0 ? 'um' : `word${index + 1}` })),
  };
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close(() => resolve(address.port));
    });
    server.on('error', reject);
  });
}

async function waitForServer(baseUrl) {
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${baseUrl}/api/l1a/runs`);
      if (response.ok) return;
    } catch { /* server is still starting */ }
    await new Promise((resolve) => setTimeout(resolve, 80));
  }
  throw new Error('L1a test server did not start');
}

async function main() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'mwu-l1a-tests-'));

  await test('truncated WAV input is rejected before provider execution', () => {
    const root = path.join(base, 'truncated-input');
    const truncated = wavBuffer().subarray(0, wavBuffer().length - 1);
    assert.throws(
      () => createL1aRun({ root, filename: 'truncated.wav', wavBuffer: truncated, runId: 'truncated-fixture' }),
      /WAV data is truncated/,
    );
    assert.equal(fs.existsSync(path.join(root, 'truncated-fixture')), false);
  });

  await test('candidate review order follows first detected speech rather than provider label', () => {
    const root = path.join(base, 'chronological-candidates');
    const created = createL1aRun({ root, filename: 'chronological.wav', wavBuffer: wavBuffer(), runId: 'chronological-fixture' });
    completeProviderRun({
      root,
      runId: created.state.run_id,
      turns: [
        { speaker: 'SPEAKER_00', start: 1.2, end: 1.5, confidence: 0.9 },
        { speaker: 'SPEAKER_09', start: 0.2, end: 0.5, confidence: 0.9 },
        { speaker: 'SPEAKER_04', start: 0.7, end: 1.0, confidence: 0.9 },
      ],
      provider: { source: 'synthetic', model: 'test' },
    });
    const snapshot = getRunSnapshot({ root, runId: created.state.run_id });
    assert.deepEqual(
      snapshot.candidates.candidates.map((candidate) => candidate.candidate_id),
      ['SPEAKER_09', 'SPEAKER_04', 'SPEAKER_00'],
    );
  });

  for (const count of [2, 3, 4]) {
    await test(`${count}-candidate fixture completes review, canonical mapping and Phase II handoff`, () => {
      const fixture = makeFixture(base, count);
      const decisions = decisionsFor(count);
      const review = saveReviewDraft({ root: fixture.root, runId: fixture.runId, payload: { reviewer: 'qa', decisions } });
      assert.equal(review.schema_version, 'l1a-candidate-review-v1');
      const confirmed = confirmReview({ root: fixture.root, acceptedRoot: fixture.acceptedRoot, runId: fixture.runId });
      assert.equal(confirmed.manifest.review.status, 'accepted');
      assert.equal(confirmed.manifest.phase_ii_handoff.review_status, 'accepted');
      assert.equal(confirmed.manifest.speakers.length, count);
      assert.deepEqual(confirmed.manifest.speakers, Array.from({ length: count }, (_, index) => `S${index + 1}`));
      assert.equal(confirmed.manifest.outputs.muted_mirror_wavs.length, count);
      for (const item of confirmed.manifest.outputs.muted_mirror_wavs) {
        assert.equal(readWavForMuting(item.muted_mirror_wav).durationSeconds, 2.4);
      }
      assert.ok(findArtifact(confirmed.manifest, (file) => file.endsWith('.TextGrid')));
      assert.ok(fs.existsSync(confirmed.manifest.outputs.provider_evidence_summary));
      assert.ok(fs.existsSync(confirmed.manifest.outputs.review_flags));
      assert.ok(fs.existsSync(confirmed.manifest.outputs.phase_ii_handoff_manifest));
      assert.equal(confirmed.manifest.recording_id, `group-${count}`);
      assert.equal(verifySealedManifest(confirmed.manifestPath).ok, true);
      assert.ok(confirmed.acceptedDir.includes(`${path.sep}sessions${path.sep}${fixture.runId}${path.sep}L1a${path.sep}revisions${path.sep}`));
      const layerManifest = JSON.parse(fs.readFileSync(confirmed.state.layer_manifest, 'utf8'));
      const sessionManifest = JSON.parse(fs.readFileSync(confirmed.state.session_manifest, 'utf8'));
      assert.equal(layerManifest.client_delivery_contract, 'l1a-poc-n-plus-3-v1');
      assert.equal(layerManifest.client_deliverables.length, count + 3);
      assert.equal(layerManifest.next_layer_input.layer, 'L1b');
      assert.equal(layerManifest.next_layer_input.ready, true);
      assert.deepEqual(sessionManifest.layer_order, ['L1a', 'L1b', 'L2', 'L3']);
      assert.equal(sessionManifest.layers.L1a.status, 'accepted');
      assert.equal(sessionManifest.layers.L1b.status, 'not_started');
    });
  }

  await test('Merge and Exclude produce two canonical speakers while excluded activity remains invalid evidence', () => {
    const fixture = makeFixture(base, 4);
    saveReviewDraft({ root: fixture.root, runId: fixture.runId, payload: { reviewer: 'qa', decisions: decisionsFor(4, { merge: true, exclude: true }) } });
    const confirmed = confirmReview({ root: fixture.root, acceptedRoot: fixture.acceptedRoot, runId: fixture.runId });
    assert.deepEqual(confirmed.manifest.speakers, ['S1', 'S2']);
    const excludedTurn = turnsFor(4).find((turn) => turn.speaker === 'SPEAKER_03');
    const invalid = fs.readFileSync(confirmed.manifest.outputs.muted_mirror_wavs[0].invalid_intervals_tsv, 'utf8')
      .trim().split(/\r?\n/).filter(Boolean).map((line) => line.split('\t').map(Number));
    assert.ok(invalid.some(([start, end]) => start <= excludedTurn.start + 0.000001 && end >= excludedTurn.end - 0.000001), 'excluded candidate activity disappeared from invalid evidence');
  });

  await test('Uncertain candidate is versioned but blocked at confirmation', () => {
    const fixture = makeFixture(base, 3);
    const decisions = decisionsFor(3);
    decisions[2] = { candidate_id: 'SPEAKER_02', decision: 'uncertain', role: 'uncertain' };
    const review = saveReviewDraft({ root: fixture.root, runId: fixture.runId, payload: { reviewer: 'qa', decisions } });
    assert.equal(review.revision, 1);
    assert.throws(() => confirmReview({ root: fixture.root, acceptedRoot: fixture.acceptedRoot, runId: fixture.runId }), /Uncertain candidates/);
  });

  await test('Reviewer identity is explicit and cannot be silently defaulted', () => {
    const fixture = makeFixture(base, 2);
    const review = saveReviewDraft({ root: fixture.root, runId: fixture.runId, payload: { decisions: decisionsFor(2) } });
    assert.equal(review.reviewer, '');
    assert.match(review.errors.join('; '), /Reviewer or rater ID is required/);
    assert.throws(() => confirmReview({ root: fixture.root, acceptedRoot: fixture.acceptedRoot, runId: fixture.runId }), /Reviewer or rater ID/);
  });

  await test('Representative clips prefer clean turns and flag overlap-only evidence', () => {
    const cleanRoot = path.join(base, 'overlap-clean');
    const clean = createL1aRun({ root: cleanRoot, filename: 'overlap-clean.wav', wavBuffer: wavBuffer(), runId: 'overlap-clean' });
    completeProviderRun({
      root: cleanRoot,
      runId: clean.state.run_id,
      turns: [
        { speaker: 'SPEAKER_00', start: 0.1, end: 0.6 },
        { speaker: 'SPEAKER_00', start: 1.2, end: 1.7 },
        { speaker: 'SPEAKER_01', start: 0.3, end: 0.55 },
        { speaker: 'SPEAKER_01', start: 1.8, end: 2.2 },
      ],
      provider: { source: 'synthetic_overlap', model: 'none' },
    });
    const cleanSnapshot = getRunSnapshot({ root: cleanRoot, runId: clean.state.run_id });
    const speaker0 = cleanSnapshot.candidates.candidates.find((candidate) => candidate.candidate_id === 'SPEAKER_00');
    assert.equal(speaker0.evidence_quality, 'clean_non_overlap');
    assert.ok(speaker0.clips.every((clip) => clip.contains_overlap === false));

    const overlapRoot = path.join(base, 'overlap-only');
    const overlap = createL1aRun({ root: overlapRoot, filename: 'overlap-only.wav', wavBuffer: wavBuffer(), runId: 'overlap-only' });
    completeProviderRun({
      root: overlapRoot,
      runId: overlap.state.run_id,
      turns: [
        { speaker: 'SPEAKER_00', start: 0.1, end: 0.9 },
        { speaker: 'SPEAKER_01', start: 0.1, end: 0.9 },
        { speaker: 'SPEAKER_00', start: 1.1, end: 1.8 },
        { speaker: 'SPEAKER_01', start: 1.1, end: 1.8 },
      ],
      provider: { source: 'synthetic_overlap', model: 'none' },
    });
    const overlapSnapshot = getRunSnapshot({ root: overlapRoot, runId: overlap.state.run_id });
    assert.ok(overlapSnapshot.candidates.candidates.every((candidate) => candidate.evidence_quality === 'low_overlap_only'));
    assert.ok(overlapSnapshot.candidates.candidates.every((candidate) => candidate.clips.every((clip) => clip.review_required && clip.contains_overlap)));
  });

  await test('Representative clips rank a clear sustained segment ahead of a short sample', () => {
    const root = path.join(base, 'quality-ranked-clips');
    const created = createL1aRun({
      root,
      filename: 'quality-ranked.wav',
      wavBuffer: wavBuffer({ seconds: 9 }),
      runId: 'quality-ranked',
    });
    completeProviderRun({
      root,
      runId: created.state.run_id,
      turns: [
        { speaker: 'SPEAKER_00', start: 0.1, end: 0.45, confidence: 0.95 },
        { speaker: 'SPEAKER_01', start: 0.6, end: 1.5, confidence: 0.95 },
        { speaker: 'SPEAKER_00', start: 2, end: 8, confidence: 0.95 },
      ],
      provider: { source: 'synthetic_quality', model: 'none' },
    });
    const snapshot = getRunSnapshot({ root, runId: created.state.run_id });
    const candidate = snapshot.candidates.candidates.find((item) => item.candidate_id === 'SPEAKER_00');
    assert.equal(candidate.clips[0].label, 'Best 1');
    assert.ok(candidate.clips[0].start >= 2);
    assert.ok(candidate.clips[0].duration_seconds >= 3.9 && candidate.clips[0].duration_seconds <= 5);
    assert.ok(Number.isFinite(candidate.clips[0].quality_score));
    assert.equal(candidate.clips[0].contains_overlap, false);
    assert.equal(snapshot.candidates.clip_selection_policy.version, 'speaker-identification-clips-v2');
  });

  await test('Changing an accepted mapping invalidates downstream evidence before rebuild', () => {
    const fixture = makeFixture(base, 2);
    saveReviewDraft({ root: fixture.root, runId: fixture.runId, payload: { reviewer: 'qa', decisions: decisionsFor(2) } });
    const first = confirmReview({ root: fixture.root, acceptedRoot: fixture.acceptedRoot, runId: fixture.runId });
    const firstHash = sha256(first.manifestPath);
    const swapped = decisionsFor(2);
    swapped[0].canonical_speaker = 'S2';
    swapped[1].canonical_speaker = 'S1';
    saveReviewDraft({ root: fixture.root, runId: fixture.runId, payload: { reviewer: 'qa', decisions: swapped } });
    const invalidated = getRunSnapshot({ root: fixture.root, runId: fixture.runId });
    assert.equal(invalidated.state.downstream_invalidated, true);
    assert.equal(invalidated.invalidation.reason, 'accepted_candidate_mapping_changed');
    const supersededManifest = JSON.parse(fs.readFileSync(first.manifestPath, 'utf8'));
    const supersededHandoff = JSON.parse(fs.readFileSync(supersededManifest.outputs.phase_ii_handoff_manifest, 'utf8'));
    assert.equal(supersededManifest.lifecycle.status, 'superseded');
    assert.equal(supersededManifest.phase_ii_handoff.ready, false);
    assert.equal(supersededHandoff.ready, false);
    const supersededGate = assessL1aHandoff({ manifestPath: first.manifestPath });
    assert.equal(supersededGate.passed, false);
    assert.ok(supersededGate.blockers.some((item) => item.code === 'accepted_lifecycle'));
    const second = confirmReview({ root: fixture.root, acceptedRoot: fixture.acceptedRoot, runId: fixture.runId });
    assert.notEqual(sha256(second.manifestPath), firstHash);
    assert.equal(second.state.downstream_invalidated, false);
  });

  await test('handoff gate rejects a missing required output file', () => {
    const fixture = acceptedFixture(base, 2, '-missing');
    const missing = fixture.confirmed.manifest.outputs.muted_mirror_wavs[0].invalid_intervals_tsv;
    fs.rmSync(missing);
    const gate = assessL1aHandoff({ manifestPath: fixture.confirmed.manifestPath });
    assert.equal(gate.passed, false);
    assert.ok(gate.blockers.some((item) => item.code === 'sealed_speaker_S1_invalid_intervals_tsv'));
  });

  await test('handoff gate rejects a required output hash mismatch', () => {
    const fixture = acceptedFixture(base, 2, '-hash');
    fs.appendFileSync(fixture.confirmed.manifest.outputs.speaker_turns_csv, 'tampered\n');
    const gate = assessL1aHandoff({ manifestPath: fixture.confirmed.manifestPath });
    assert.equal(gate.passed, false);
    assert.ok(gate.blockers.some((item) => item.code === 'sealed_speaker_turns_csv'));
  });

  await test('handoff gate rejects non-contiguous canonical speaker mappings', () => {
    const fixture = acceptedFixture(base, 3, '-mapping');
    const manifest = JSON.parse(fs.readFileSync(fixture.confirmed.manifestPath, 'utf8'));
    manifest.speakers = ['S1', 'S3', 'S4'];
    fs.writeFileSync(fixture.confirmed.manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    const gate = assessL1aHandoff({ manifestPath: fixture.confirmed.manifestPath });
    assert.equal(gate.passed, false);
    assert.ok(gate.blockers.some((item) => item.code === 'canonical_speakers_contiguous_unique'));
  });

  await test('handoff identity preserves recording_id independently of source.wav basename', () => {
    const fixture = acceptedFixture(base, 4, '-recording-id');
    const gate = assessL1aHandoff({
      manifestPath: fixture.confirmed.manifestPath,
      expectedRecordingId: 'group-4',
      expectedRunId: fixture.runId,
      expectedSessionId: fixture.runId,
    });
    assert.equal(path.basename(fixture.confirmed.manifest.sealed_evidence.source_wav.path), 'source.wav');
    assert.equal(gate.passed, true, JSON.stringify(gate.blockers));
    assert.equal(gate.sealed_handoff_identity.recording_id, 'group-4');
    assert.equal(gate.sealed_handoff_identity.recording_id_source, 'accepted_phase1_manifest');
  });

  await test('offline Path B evidence builder reuses Stage-1 adapter and gates enhanced handoff on G1', () => {
    const fixture = acceptedFixture(base, 3, '-path-b');
    const assemblyPath = path.join(fixture.confirmed.acceptedDir, 'synthetic.assemblyai.raw.json');
    fs.writeFileSync(assemblyPath, `${JSON.stringify(syntheticAssemblyRaw(fixture.confirmed.manifest), null, 2)}\n`);
    const layerManifestBefore = JSON.parse(fs.readFileSync(fixture.confirmed.state.layer_manifest, 'utf8'));
    const result = buildL1aPathBEvidence({
      manifestPath: fixture.confirmed.manifestPath,
      assemblyaiPath: assemblyPath,
    });
    assert.equal(result.passed, true, JSON.stringify(result.blockers));
    assert.equal(result.ready_for_path_b, true);
    assert.deepEqual(result.artifacts.map((item) => item.role), [
      'provider_comparison',
      'input_manifest',
      'provider_mapping',
      'room_activity_base',
      'stage1_evidence',
      'phase1_gate_report',
    ]);
    assert.ok(result.artifacts.every((item) => fs.existsSync(item.path) && sha256(item.path) === item.sha256));
    const providerMapping = JSON.parse(fs.readFileSync(
      result.artifacts.find((item) => item.role === 'provider_mapping').path,
      'utf8',
    ));
    assert.equal(providerMapping.provenance.canonical_id_assignment.temporary, false);
    assert.equal(providerMapping.provenance.canonical_id_assignment.researcher_confirmed_identity, true);
    const handoff = JSON.parse(fs.readFileSync(fixture.confirmed.manifest.outputs.phase_ii_handoff_manifest, 'utf8'));
    assert.equal(handoff.ready_for_path_b, true);
    assert.equal(handoff.path_b_gate.status, 'pass');
    const layerManifestAfter = JSON.parse(fs.readFileSync(fixture.confirmed.state.layer_manifest, 'utf8'));
    assert.deepEqual(layerManifestAfter.client_deliverables, layerManifestBefore.client_deliverables);
    assert.equal(layerManifestAfter.client_deliverables.length, 6);
    assert.ok(layerManifestAfter.client_deliverables.every((item) => !item.relative_path.includes('internal_evidence')));
    const stage1Evidence = result.artifacts.find((item) => item.role === 'stage1_evidence').path;
    fs.appendFileSync(stage1Evidence, 'tampered\n');
    const tamperedReadiness = assessL1aPathBReadiness({ manifestPath: fixture.confirmed.manifestPath });
    assert.equal(tamperedReadiness.passed, false);
    assert.ok(tamperedReadiness.blockers.some((item) => item.code === 'path_b_stage1_evidence'));
  });

  await test('Path B evidence builder supports a two-speaker accepted L1a handoff', () => {
    const fixture = acceptedFixture(base, 2, '-path-b-blocked');
    const assemblyPath = path.join(fixture.confirmed.acceptedDir, 'synthetic.assemblyai.raw.json');
    fs.writeFileSync(assemblyPath, `${JSON.stringify(syntheticAssemblyRaw(fixture.confirmed.manifest), null, 2)}\n`);
    const result = buildL1aPathBEvidence({ manifestPath: fixture.confirmed.manifestPath, assemblyaiPath: assemblyPath });
    assert.equal(result.passed, true, JSON.stringify(result.blockers));
    assert.equal(result.ready_for_path_b, true);
    assert.equal(Object.keys(result.provider_comparison.mapping_candidate_to_reference || {}).length, 2);
    const handoff = JSON.parse(fs.readFileSync(fixture.confirmed.manifest.outputs.phase_ii_handoff_manifest, 'utf8'));
    assert.equal(handoff.ready_for_path_b, true);
    assert.equal(handoff.path_b_gate.status, 'pass');
  });

  await test('Accepted artifact resolver rejects path traversal', () => {
    const fixture = makeFixture(base, 2);
    saveReviewDraft({ root: fixture.root, runId: fixture.runId, payload: { reviewer: 'qa', decisions: decisionsFor(2) } });
    confirmReview({ root: fixture.root, acceptedRoot: fixture.acceptedRoot, runId: fixture.runId });
    assert.throws(() => resolveAcceptedArtifact({ root: fixture.root, runId: fixture.runId, relativePath: '../../outside' }), /outside/);
  });

  await test('HTTP workflow uploads WAV, exposes all candidates, streams ranges, reviews and confirms', async () => {
    const port = await freePort();
    const reviewRoot = path.join(base, 'server-review');
    const acceptedRoot = path.join(base, 'server-accepted');
    const child = spawn(process.execPath, [SERVER, '--port', String(port)], {
      cwd: ROOT,
      env: { ...process.env, MWU_L1A_TEST_MODE: '1', MWU_L1A_ROOT: reviewRoot, MWU_MULTILOGUE_OUT: acceptedRoot },
      stdio: 'ignore',
    });
    const baseUrl = `http://127.0.0.1:${port}`;
    try {
      await waitForServer(baseUrl);
      const upload = await fetch(`${baseUrl}/api/l1a/run?filename=api-fixture.wav`, {
        method: 'POST',
        headers: { 'content-type': 'audio/wav', 'x-mwu-test-candidate-count': '4' },
        body: wavBuffer(),
      });
      assert.equal(upload.status, 201);
      const created = await upload.json();
      const candidatesResponse = await fetch(`${baseUrl}/api/l1a/runs/${created.run_id}/candidates`);
      const snapshot = await candidatesResponse.json();
      assert.equal(snapshot.candidates.candidate_count, 4);
      assert.ok(snapshot.candidates.candidates.every((candidate) => candidate.clips.length >= 1));
      const range = await fetch(`${baseUrl}/api/l1a/runs/${created.run_id}/audio`, { headers: { range: 'bytes=0-127' } });
      assert.equal(range.status, 206);
      assert.equal((await range.arrayBuffer()).byteLength, 128);
      const confirm = await fetch(`${baseUrl}/api/l1a/runs/${created.run_id}/confirm`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ reviewer: 'qa', decisions: decisionsFor(4, { merge: true, exclude: true }) }),
      });
      assert.equal(confirm.status, 200, await confirm.text());
      const accepted = await fetch(`${baseUrl}/api/l1a/runs/${created.run_id}/candidates`).then((response) => response.json());
      assert.equal(accepted.state.status, 'accepted');
      assert.ok(accepted.artifacts.some((artifact) => artifact.name.endsWith('.TextGrid')));
      const clientDeliverables = accepted.artifacts.filter((artifact) => artifact.client_delivery);
      assert.equal(clientDeliverables.length, 5, 'two retained speakers must expose N + 3 PoC deliverables');
      assert.deepEqual(clientDeliverables.map((artifact) => artifact.kind).sort(), ['csv', 'rttm', 'textgrid', 'wav', 'wav']);
      assert.ok(accepted.artifacts.some((artifact) => !artifact.client_delivery), 'internal handoff evidence must remain available to the pipeline');
      const forbidden = await fetch(`${baseUrl}/api/l1a/runs/${created.run_id}/artifact?path=${encodeURIComponent('../../outside')}`);
      assert.equal(forbidden.status, 404);
    } finally {
      child.kill('SIGTERM');
    }
  });

  const report = {
    schema_version: 'l1a-test-report-v1',
    generated_at: new Date().toISOString(),
    suite: 'Layer 1a candidate review and Phase II handoff',
    requirements: ['L1A-001', 'L1A-002', 'L1A-003', 'L1A-004', 'L1A-005', 'L1A-006', 'L1A-007', 'L1A-008', 'L1A-009', 'L1A-011', 'L1A-013'],
    passed: cases.filter((item) => item.status === 'passed').length,
    failed: cases.filter((item) => item.status === 'failed').length,
    cases,
    data_boundary: 'Synthetic WAV and synthetic candidate turns only; no participant data or provider credentials used.',
  };
  fs.mkdirSync(ARTIFACT_DIR, { recursive: true });
  fs.writeFileSync(path.join(ARTIFACT_DIR, 'l1a-test-report.json'), `${JSON.stringify(report, null, 2)}\n`);
  console.log(`\n${report.passed} passed / ${report.failed} failed`);
  if (report.failed) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
