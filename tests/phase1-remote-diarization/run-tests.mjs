#!/usr/bin/env node

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  buildSpeakerTimelineIntervals,
  compareDiarizations,
  parseRttm,
  readJson,
  readWavForMuting,
  renderSpeakerTextGrid,
  turnsFromPyannoteJson,
} from '../../scripts/phase1/lib/diarization-artifacts.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../..');
const REMOTE_CLI = path.join(ROOT, 'scripts', 'phase1-pyannote-remote.mjs');
const ARTIFACTS_CLI = path.join(ROOT, 'scripts', 'phase1-artifacts-from-turns.mjs');
const COMPARE_CLI = path.join(ROOT, 'scripts', 'phase1-compare-diarization.mjs');
const HANDOFF_CLI = path.join(ROOT, 'scripts', 'phase1-verify-handoff.mjs');

function makeSuite(name) {
  const cases = [];
  const t = (label, fn) => {
    try {
      fn();
      cases.push({ name: label, status: 'passed' });
      console.log(`  passed: ${label}`);
    } catch (error) {
      cases.push({ name: label, status: 'failed', detail: error.message });
      console.log(`  failed: ${label} - ${error.message}`);
    }
  };
  return {
    t,
    summary: () => ({
      suite: name,
      passed: cases.filter((c) => c.status === 'passed').length,
      failed: cases.filter((c) => c.status === 'failed').length,
      cases,
    }),
  };
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

function near(a, b, tol, msg) {
  if (Math.abs(a - b) > tol) throw new Error(`${msg}: ${a} vs ${b}`);
}

function writeTinyWav(file, { duration = 1.2, sampleRate = 8000 } = {}) {
  const frameCount = Math.round(duration * sampleRate);
  const dataSize = frameCount * 2;
  const buffer = Buffer.alloc(44 + dataSize);
  buffer.write('RIFF', 0);
  buffer.writeUInt32LE(36 + dataSize, 4);
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
  buffer.writeUInt32LE(dataSize, 40);
  for (let frame = 0; frame < frameCount; frame += 1) {
    const sample = Math.round(Math.sin((2 * Math.PI * 220 * frame) / sampleRate) * 12000);
    buffer.writeInt16LE(sample, 44 + frame * 2);
  }
  fs.writeFileSync(file, buffer);
}

function runNode(args, opts = {}) {
  return spawnSync('node', args, {
    encoding: 'utf8',
    timeout: 120000,
    maxBuffer: 20 * 1024 * 1024,
    ...opts,
  });
}

function listFiles(dir) {
  return fs.readdirSync(dir).sort();
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function waitForJsonFile(file, timeoutMs = 5000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8'));
    sleepSync(50);
  }
  throw new Error(`Timed out waiting for ${file}`);
}

function startFakePyannoteServer(tempDir, scenario = 'success') {
  const serverId = `${scenario}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const serverFile = path.join(tempDir, `fake-pyannote-server-${serverId}.mjs`);
  const readyFile = path.join(tempDir, `fake-pyannote-ready-${serverId}.json`);
  const captureFile = path.join(tempDir, `fake-pyannote-capture-${serverId}.json`);
  fs.writeFileSync(serverFile, `
import http from 'node:http';
import fs from 'node:fs';

const captureFile = process.argv[2];
const readyFile = process.argv[3];
const scenario = process.argv[4] || 'success';
const capture = {
  mediaCreate: null,
  uploadBytes: 0,
  uploadContentLength: null,
  diarizePayload: null,
  authHeaders: [],
  polls: 0,
  errors: [],
};

function writeCapture() {
  fs.writeFileSync(captureFile, JSON.stringify(capture, null, 2) + '\\n');
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function sendJson(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.url === '/v1/media/input' && req.method === 'POST') {
      capture.authHeaders.push(req.headers.authorization || '');
      const body = JSON.parse((await readBody(req)).toString('utf8') || '{}');
      capture.mediaCreate = body;
      writeCapture();
      const port = server.address().port;
      sendJson(res, 200, { url: 'http://127.0.0.1:' + port + '/upload/audio' });
      return;
    }

    if (req.url === '/upload/audio' && req.method === 'PUT') {
      const body = await readBody(req);
      capture.uploadBytes = body.length;
      capture.uploadContentLength = req.headers['content-length'] || null;
      writeCapture();
      res.writeHead(200);
      res.end('ok');
      return;
    }

    if (req.url === '/v1/diarize' && req.method === 'POST') {
      capture.authHeaders.push(req.headers.authorization || '');
      capture.diarizePayload = JSON.parse((await readBody(req)).toString('utf8') || '{}');
      writeCapture();
      if (scenario === 'submit-429') {
        sendJson(res, 429, { error: 'rate limit for test' });
        return;
      }
      sendJson(res, 200, { jobId: 'job-fake', status: 'pending' });
      return;
    }

    if (req.url === '/v1/jobs/job-fake' && req.method === 'GET') {
      capture.authHeaders.push(req.headers.authorization || '');
      capture.polls += 1;
      writeCapture();
      if (scenario === 'job-failed') {
        sendJson(res, 200, {
          jobId: 'job-fake',
          status: 'failed',
          output: { error: 'synthetic diarization failure' }
        });
        return;
      }
      sendJson(res, 200, {
        jobId: 'job-fake',
        status: 'succeeded',
        output: {
          diarization: [
            { speaker: 'SPEAKER_00', start: 0.1, end: 0.45, confidence: 0.92 },
            { speaker: 'SPEAKER_01', start: 0.55, end: 0.85, confidence: 0.82 },
            { speaker: 'SPEAKER_00', start: 0.78, end: 1.0, confidence: 0.72 }
          ],
          exclusiveDiarization: [
            { speaker: 'SPEAKER_00', start: 0.1, end: 0.45 },
            { speaker: 'SPEAKER_01', start: 0.55, end: 0.78 },
            { speaker: 'SPEAKER_00', start: 0.78, end: 1.0 }
          ]
        }
      });
      return;
    }

    capture.errors.push({ method: req.method, url: req.url });
    writeCapture();
    sendJson(res, 404, { error: 'not found' });
  } catch (error) {
    capture.errors.push({ method: req.method, url: req.url, error: error.message });
    writeCapture();
    sendJson(res, 500, { error: error.message });
  }
});

server.listen(0, '127.0.0.1', () => {
  fs.writeFileSync(readyFile, JSON.stringify({ port: server.address().port }) + '\\n');
});

process.on('SIGTERM', () => server.close(() => process.exit(0)));
`, 'utf8');
  const child = spawn(process.execPath, [serverFile, captureFile, readyFile, scenario], {
    stdio: 'ignore',
  });
  const ready = waitForJsonFile(readyFile, 5000);
  return {
    baseUrl: `http://127.0.0.1:${ready.port}`,
    captureFile,
    stop() {
      child.kill('SIGTERM');
    },
  };
}

function main() {
  const outRoot = path.join(ROOT, 'outputs', 'phase1-remote-diarization-tests');
  fs.rmSync(outRoot, { recursive: true, force: true });
  fs.mkdirSync(outRoot, { recursive: true });
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'phase1-remote-test-'));
  process.env.MWU_USAGE_LEDGER = path.join(temp, 'provider-usage-ledger.json');
  const audio = path.join(temp, 'fixture.wav');
  writeTinyWav(audio);
  const uploadAudio = path.join(temp, 'fixture.16k.wav');
  writeTinyWav(uploadAudio, { duration: 1.2, sampleRate: 16000 });

  const turnsFixture = {
    source: 'fixture',
    turns: [
      { speaker: 'A', start: 0.1, end: 0.45, confidence: 0.9, text: 'alpha' },
      { speaker: 'B', start: 0.55, end: 0.85, confidence: 0.8, text: 'beta' },
      { speaker: 'A', start: 0.78, end: 1.0, confidence: 0.7, text: 'alpha overlap' },
    ],
  };
  const turnsJson = path.join(temp, 'turns.json');
  fs.writeFileSync(turnsJson, `${JSON.stringify(turnsFixture, null, 2)}\n`);
  const mockJobJson = path.join(temp, 'pyannote-job.json');
  fs.writeFileSync(mockJobJson, `${JSON.stringify({
    jobId: 'job-test',
    status: 'succeeded',
    output: {
      diarization: [
        { speaker: 'SPEAKER_00', start: 0.1, end: 0.45, confidence: 0.91 },
        { speaker: 'SPEAKER_01', start: 0.55, end: 0.85, confidence: 0.81 },
        { speaker: 'SPEAKER_00', start: 0.78, end: 1.0, confidence: 0.71 },
      ],
      exclusiveDiarization: [
        { speaker: 'SPEAKER_00', start: 0.1, end: 0.45 },
        { speaker: 'SPEAKER_01', start: 0.55, end: 0.78 },
        { speaker: 'SPEAKER_00', start: 0.78, end: 1.0 },
      ],
    },
  }, null, 2)}\n`);
  const assemblyAiJson = path.join(temp, 'assemblyai.json');
  fs.writeFileSync(assemblyAiJson, `${JSON.stringify({
    audio_duration: 1.2,
    utterances: [
      { speaker: 'A', start: 100, end: 450, confidence: 0.91, text: 'alpha' },
      { speaker: 'B', start: 550, end: 850, confidence: 0.81, text: 'beta' },
      { speaker: 'A', start: 780, end: 1000, confidence: 0.71, text: 'alpha overlap' },
    ],
  }, null, 2)}\n`);

  const { t, summary } = makeSuite('phase1-remote-diarization');

  t('RTTM parser reads speaker turns and rejects malformed lines', () => {
    const turns = parseRttm('SPEAKER file 1 0.100000 0.300000 <NA> <NA> A <NA> <NA>\nSPEAKER file 1 0.500000 0.200000 <NA> <NA> B <NA> <NA>\n', 1.2);
    assert(turns.length === 2, `turns=${turns.length}`);
    near(turns[0].start, 0.1, 1e-9, 'start');
    near(turns[0].end, 0.4, 1e-9, 'end');
    let threw = false;
    try {
      parseRttm('BAD file 1 0 1 <NA> <NA> A <NA> <NA>\n', 1);
    } catch {
      threw = true;
    }
    assert(threw, 'malformed RTTM did not throw');
  });

  t('Speaker tier surfaces overlap instead of flattening it silently', () => {
    const turns = turnsFromPyannoteJson(turnsFixture, 1.2);
    const intervals = buildSpeakerTimelineIntervals(1.2, turns);
    assert(intervals.some((iv) => iv.text === 'overlap:speaker_A+speaker_B'), JSON.stringify(intervals));
    const tg = renderSpeakerTextGrid(1.2, turns);
    assert(/name = "speaker"/.test(tg), 'tier name missing');
    assert(/overlap:speaker_A\+speaker_B/.test(tg), 'overlap label missing');
  });

  t('Remote CLI mock job writes raw job, raw turns, speaker tier, muted mirrors, invalid intervals, Phase II handoff, and AssemblyAI comparison', () => {
    const outDir = path.join(outRoot, 'remote-mock');
    const r = runNode([
      REMOTE_CLI,
      '--audio', audio,
      '--upload-audio', uploadAudio,
      '--out-dir', outDir,
      '--prefix', 'fixture',
      '--mock-job-json', mockJobJson,
      '--speakers', '2',
      '--compare-assemblyai-json', assemblyAiJson,
    ]);
    assert(r.status === 0, `exit=${r.status}\n${r.stderr}\n${r.stdout}`);
    const files = listFiles(outDir);
    for (const expected of [
      'fixture.assemblyai_vs_pyannote_remote.comparison.json',
      'fixture.assemblyai_vs_pyannote_remote.comparison.md',
      'fixture.pyannote.remote.raw_job.json',
      'fixture.pyannote.remote.raw_turns.json',
      'fixture.pyannote_remote.phase1_manifest.json',
      'fixture.pyannote_remote.speaker_turns.csv',
      'fixture.pyannote_remote.speaker_turns.json',
      'fixture.pyannote_remote.speaker_turns.rttm',
      'fixture.pyannote_remote.speaker_tier.TextGrid',
      'fixture.pyannote_remote.speaker_SPEAKER_00.muted_mirror.wav',
      'fixture.pyannote_remote.speaker_SPEAKER_01.muted_mirror.wav',
      'fixture.pyannote_remote.speaker_SPEAKER_00.invalid_intervals.tsv',
      'fixture.pyannote_remote.speaker_SPEAKER_01.invalid_intervals.tsv',
    ]) {
      assert(files.includes(expected), `${expected} missing in ${files.join(', ')}`);
    }
    const manifest = readJson(path.join(outDir, 'fixture.pyannote_remote.phase1_manifest.json'));
    assert(manifest.source === 'pyannoteai_remote', 'wrong source');
    assert(manifest.method.artifact_diarization === 'diarization', JSON.stringify(manifest.method));
    assert(manifest.overlap.count === 1, `default artifacts did not preserve overlap: ${JSON.stringify(manifest.overlap)}`);
    assert(manifest.phase_ii_handoff.ready === true, 'Phase II handoff not ready');
    assert(manifest.phase_ii_handoff.inputs.length === 2, 'handoff inputs not per speaker');
    const handoffReport = path.join(outDir, 'handoff_check.json');
    const h = runNode([HANDOFF_CLI, '--manifest', path.join(outDir, 'fixture.pyannote_remote.phase1_manifest.json'), '--output', handoffReport]);
    assert(h.status === 0, `handoff failed\n${h.stderr}\n${h.stdout}`);
    assert(readJson(handoffReport).status === 'passed', 'handoff report not passed');
    const comparison = readJson(path.join(outDir, 'fixture.assemblyai_vs_pyannote_remote.comparison.json'));
    assert(comparison.reference.speaker_count === 2 && comparison.candidate.speaker_count === 2, 'comparison speaker counts wrong');
    const wavA = readWavForMuting(path.join(outDir, 'fixture.pyannote_remote.speaker_SPEAKER_00.muted_mirror.wav'));
    near(wavA.durationSeconds, 1.2, 1e-9, 'muted mirror duration');
    const log = fs.readFileSync(path.join(outDir, 'fixture.pyannote_remote.log.jsonl'), 'utf8');
    assert(/"event":"mock_job_load"/.test(log) && /"event":"artifacts_done"/.test(log) && /"event":"comparison_done"/.test(log), `log unstable: ${log}`);
    assert(log.includes(uploadAudio), 'upload-audio path was not logged');
  });

  t('Remote CLI HTTP path uploads --upload-audio, submits diarization, polls job, writes logs, and passes Phase II handoff', () => {
    const server = startFakePyannoteServer(temp);
    try {
      const outDir = path.join(outRoot, 'remote-http');
      const env = { ...process.env, PYANNOTE_API_KEY: 'test-key' };
      const r = runNode([
        REMOTE_CLI,
        '--audio', audio,
        '--upload-audio', uploadAudio,
        '--upload-method', 'curl',
        '--out-dir', outDir,
        '--prefix', 'fixture',
        '--api-base-url', server.baseUrl,
        '--object-key', 'mwu/test-fixture.wav',
        '--speakers', '2',
        '--model', 'community-1',
        '--poll-ms', '10',
        '--compare-assemblyai-json', assemblyAiJson,
      ], { env });
      assert(r.status === 0, `exit=${r.status}\n${r.stderr}\n${r.stdout}`);

      const capture = readJson(server.captureFile);
      assert(capture.errors.length === 0, `fake server errors: ${JSON.stringify(capture.errors)}`);
      assert(capture.mediaCreate.url === 'media://mwu/test-fixture.wav', JSON.stringify(capture.mediaCreate));
      assert(capture.uploadBytes === fs.statSync(uploadAudio).size, `uploaded ${capture.uploadBytes}, expected ${fs.statSync(uploadAudio).size}`);
      assert(capture.uploadBytes !== fs.statSync(audio).size, 'remote upload used original audio instead of --upload-audio');
      assert(capture.diarizePayload.url === 'media://mwu/test-fixture.wav', JSON.stringify(capture.diarizePayload));
      assert(capture.diarizePayload.model === 'community-1', JSON.stringify(capture.diarizePayload));
      assert(capture.diarizePayload.numSpeakers === 2, JSON.stringify(capture.diarizePayload));
      assert(!Object.hasOwn(capture.diarizePayload, 'exclusive'), JSON.stringify(capture.diarizePayload));
      assert(!Object.hasOwn(capture.diarizePayload, 'turnLevelConfidence'), JSON.stringify(capture.diarizePayload));
      assert(!Object.hasOwn(capture.diarizePayload, 'confidence'), JSON.stringify(capture.diarizePayload));
      assert(capture.polls === 1, `polls=${capture.polls}`);
      assert(capture.authHeaders.every((value) => value === 'Bearer test-key'), JSON.stringify(capture.authHeaders));

      const manifestPath = path.join(outDir, 'fixture.pyannote_remote.phase1_manifest.json');
      assert(fs.existsSync(manifestPath), 'manifest missing');
      const manifest = readJson(manifestPath);
      assert(manifest.method.artifact_diarization === 'diarization', JSON.stringify(manifest.method));
      assert(manifest.overlap.count === 1, `HTTP artifacts did not preserve overlap: ${JSON.stringify(manifest.overlap)}`);
      const handoffReport = path.join(outDir, 'handoff_check.json');
      const h = runNode([HANDOFF_CLI, '--manifest', manifestPath, '--output', handoffReport]);
      assert(h.status === 0, `handoff failed\n${h.stderr}\n${h.stdout}`);
      assert(readJson(handoffReport).status === 'passed', 'handoff report not passed');
      assert(fs.existsSync(path.join(outDir, 'fixture.assemblyai_vs_pyannote_remote.comparison.json')), 'comparison JSON missing');
      assert(fs.existsSync(path.join(outDir, 'fixture.pyannote.remote.request.json')), 'request audit JSON missing');

      const log = fs.readFileSync(path.join(outDir, 'fixture.pyannote_remote.log.jsonl'), 'utf8');
      for (const event of [
        'media_create_start',
        'media_create_done',
        'media_upload_start',
        'media_upload_done',
        'diarize_submit_start',
        'diarize_submit_done',
        'job_poll',
        'provider_usage_recorded',
        'artifacts_done',
        'comparison_done',
      ]) {
        assert(log.includes(`"event":"${event}"`), `missing log event ${event}: ${log}`);
      }
      assert(log.includes(server.baseUrl), 'api base url not logged');
      const usageLedger = readJson(process.env.MWU_USAGE_LEDGER);
      assert(usageLedger.events.length === 1, JSON.stringify(usageLedger));
      assert(usageLedger.events[0].provider === 'pyannoteai', JSON.stringify(usageLedger.events[0]));
      assert(usageLedger.events[0].duration_seconds === 1.2, JSON.stringify(usageLedger.events[0]));
    } finally {
      server.stop();
    }
  });

  t('Remote CLI omits speaker-count constraints when L1a does not supply one', () => {
    const server = startFakePyannoteServer(temp);
    try {
      const outDir = path.join(outRoot, 'remote-http-unconstrained');
      const env = { ...process.env, PYANNOTE_API_KEY: 'test-key' };
      const r = runNode([
        REMOTE_CLI,
        '--audio', audio,
        '--upload-audio', uploadAudio,
        '--out-dir', outDir,
        '--prefix', 'fixture-auto',
        '--api-base-url', server.baseUrl,
        '--object-key', 'mwu/test-fixture-auto.wav',
        '--model', 'community-1',
        '--poll-ms', '10',
      ], { env });
      assert(r.status === 0, `exit=${r.status}\n${r.stderr}\n${r.stdout}`);
      const capture = readJson(server.captureFile);
      assert(!Object.hasOwn(capture.diarizePayload, 'numSpeakers'), JSON.stringify(capture.diarizePayload));
      assert(!Object.hasOwn(capture.diarizePayload, 'minSpeakers'), JSON.stringify(capture.diarizePayload));
      assert(!Object.hasOwn(capture.diarizePayload, 'maxSpeakers'), JSON.stringify(capture.diarizePayload));
    } finally {
      server.stop();
    }
  });

  t('Remote CLI logs structured runtime error when diarize submit returns HTTP error', () => {
    const server = startFakePyannoteServer(temp, 'submit-429');
    try {
      const outDir = path.join(outRoot, 'remote-submit-error');
      const env = { ...process.env, PYANNOTE_API_KEY: 'test-key' };
      const r = runNode([
        REMOTE_CLI,
        '--audio', audio,
        '--upload-audio', uploadAudio,
        '--out-dir', outDir,
        '--prefix', 'fixture',
        '--api-base-url', server.baseUrl,
        '--object-key', 'mwu/test-submit-error.wav',
        '--speakers', '2',
        '--model', 'community-1',
      ], { env });
      assert(r.status === 1, `expected exit 1, got ${r.status}\n${r.stderr}\n${r.stdout}`);
      const log = fs.readFileSync(path.join(outDir, 'fixture.pyannote_remote.log.jsonl'), 'utf8');
      assert(/"event":"media_upload_done"/.test(log), `upload should complete before submit error: ${log}`);
      assert(/"event":"diarize_submit_start"/.test(log), `submit start missing: ${log}`);
      assert(/"kind":"runtime_error"/.test(log), `runtime error missing: ${log}`);
      assert(/HTTP 429/.test(log), `HTTP status missing from log: ${log}`);
      assert(!fs.existsSync(path.join(outDir, 'fixture.pyannote_remote.phase1_manifest.json')), 'manifest should not exist after submit failure');
    } finally {
      server.stop();
    }
  });

  t('Remote CLI logs structured runtime error when pyannote job fails', () => {
    const server = startFakePyannoteServer(temp, 'job-failed');
    try {
      const outDir = path.join(outRoot, 'remote-job-failed');
      const env = { ...process.env, PYANNOTE_API_KEY: 'test-key' };
      const r = runNode([
        REMOTE_CLI,
        '--audio', audio,
        '--upload-audio', uploadAudio,
        '--out-dir', outDir,
        '--prefix', 'fixture',
        '--api-base-url', server.baseUrl,
        '--object-key', 'mwu/test-job-failed.wav',
        '--speakers', '2',
        '--model', 'community-1',
        '--poll-ms', '10',
      ], { env });
      assert(r.status === 1, `expected exit 1, got ${r.status}\n${r.stderr}\n${r.stdout}`);
      const log = fs.readFileSync(path.join(outDir, 'fixture.pyannote_remote.log.jsonl'), 'utf8');
      assert(/"event":"diarize_submit_done"/.test(log), `submit done missing: ${log}`);
      assert(/"event":"job_poll"/.test(log), `job poll missing: ${log}`);
      assert(/"status":"failed"/.test(log), `failed status missing: ${log}`);
      assert(/"kind":"runtime_error"/.test(log), `runtime error missing: ${log}`);
      assert(/pyannoteAI job failed/.test(log), `job failure message missing: ${log}`);
      assert(!fs.existsSync(path.join(outDir, 'fixture.pyannote_remote.phase1_manifest.json')), 'manifest should not exist after job failure');
    } finally {
      server.stop();
    }
  });

  t('Generic artifact CLI still accepts provider-neutral turns JSON for downstream handoff', () => {
    const outDir = path.join(outRoot, 'artifacts');
    const r = runNode([ARTIFACTS_CLI, '--turns-json', turnsJson, '--audio', audio, '--out-dir', outDir, '--prefix', 'fixture', '--source', 'unit_test']);
    assert(r.status === 0, `exit=${r.status}\n${r.stderr}\n${r.stdout}`);
    const manifest = readJson(path.join(outDir, 'fixture.phase1_manifest.json'));
    assert(manifest.phase_ii_handoff.ready === true, 'Phase II handoff missing');
    assert(manifest.phase_ii_handoff.expected_labels.join(',') === 'sounding,silent,invalid', 'label contract wrong');
  });

  t('Comparison function maps labels and reports disagreement without claiming gold accuracy', () => {
    const ref = turnsFromPyannoteJson(turnsFixture, 1.2);
    const candidate = turnsFromPyannoteJson({ turns: [{ speaker: 'X', start: 0.1, end: 0.45 }, { speaker: 'Y', start: 0.6, end: 0.85 }] }, 1.2);
    const report = compareDiarizations(ref, candidate, { duration: 1.2, frameMs: 100 });
    assert(report.mapping_candidate_to_reference.X === 'A', JSON.stringify(report.mapping_candidate_to_reference));
    assert(report.agreement.speech_activity_agreement < 1, 'expected activity disagreement');
    assert(/not accuracy against human gold/.test(report.note), 'gold boundary note missing');
  });

  t('Comparison CLI writes JSON and markdown report', () => {
    const candidateJson = path.join(temp, 'candidate.json');
    fs.writeFileSync(candidateJson, JSON.stringify({ turns: [{ speaker: 'X', start: 0.1, end: 0.45 }, { speaker: 'Y', start: 0.55, end: 0.85 }] }, null, 2));
    const reportPath = path.join(outRoot, 'comparison.json');
    const r = runNode([COMPARE_CLI, '--reference-turns-json', turnsJson, '--candidate-turns-json', candidateJson, '--duration-seconds', '1.2', '--output', reportPath]);
    assert(r.status === 0, `exit=${r.status}\n${r.stderr}\n${r.stdout}`);
    const report = readJson(reportPath);
    assert(report.agreement.exact_label_frame_agreement > 0.7, JSON.stringify(report.agreement));
    assert(fs.existsSync(reportPath.replace(/\.json$/, '.md')), 'markdown report missing');
  });

  t('Handoff verifier fails on invalid TSV ranges with stable report', () => {
    const outDir = path.join(outRoot, 'remote-mock');
    const manifestPath = path.join(outDir, 'fixture.pyannote_remote.phase1_manifest.json');
    const manifest = readJson(manifestPath);
    const badTsv = path.join(outDir, 'bad.invalid_intervals.tsv');
    fs.writeFileSync(badTsv, '0.900000\t0.800000\n');
    manifest.phase_ii_handoff.inputs[0].invalid_intervals_tsv = badTsv;
    const badManifest = path.join(outRoot, 'bad_manifest.json');
    fs.writeFileSync(badManifest, `${JSON.stringify(manifest, null, 2)}\n`);
    const reportPath = path.join(outRoot, 'bad_handoff_check.json');
    const r = runNode([HANDOFF_CLI, '--manifest', badManifest, '--output', reportPath]);
    assert(r.status !== 0, 'bad handoff should fail');
    const report = readJson(reportPath);
    assert(report.status === 'failed' && report.errors.length > 0, JSON.stringify(report));
  });

  t('Remote CLI fails safely without PYANNOTE_API_KEY and writes structured logs', () => {
    const outDir = path.join(outRoot, 'remote-missing-key');
    const env = { ...process.env };
    delete env.PYANNOTE_API_KEY;
    const r = runNode([
      REMOTE_CLI,
      '--audio', audio,
      '--upload-audio', uploadAudio,
      '--dotenv-file', path.join(temp, 'does-not-exist.env'),
      '--out-dir', outDir,
      '--prefix', 'fixture',
    ], { env });
    assert(r.status === 22, `expected exit 22, got ${r.status}\n${r.stderr}\n${r.stdout}`);
    const logPath = path.join(outDir, 'fixture.pyannote_remote.log.jsonl');
    assert(fs.existsSync(logPath), 'remote log missing');
    const log = fs.readFileSync(logPath, 'utf8');
    assert(/missing_api_key/.test(log), `missing api key not logged: ${log}`);
  });

  const result = summary();
  const resultDir = path.join(outRoot, 'test-results');
  fs.mkdirSync(resultDir, { recursive: true });
  fs.writeFileSync(path.join(resultDir, 'phase1-remote-diarization-test-results.json'), `${JSON.stringify(result, null, 2)}\n`);
  console.log(`\n${result.passed} passed / ${result.failed} failed`);
  if (result.failed > 0) process.exitCode = 1;
}

main();
