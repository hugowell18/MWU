// Local server for the interactive Validation Console.
// Serves the React build + API: upload files, run in background, poll progress, fetch report, download artifacts.
// Usage: node scripts/validation-sprint/server.mjs [--port 4173]
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { OUT_DIR, ROOT, SAMPLE_DIR } from './config.mjs';
import {
  artifactIndex,
  completeProviderRun,
  confirmReview,
  createL1aRun,
  getRunSnapshot,
  listL1aReviewRuns,
  pathsForRun,
  resolveAcceptedArtifact,
  resolveRunAudio,
  saveReviewDraft,
  setRunFailure,
  setRunStatus,
} from '../l1a/review-core.mjs';
import { assessL1aHandoff } from '../l1a/handoff-gate.mjs';
import { assessL1aPathBReadiness } from '../l1a/build-path-b-evidence.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BUILD_DIR = path.join(ROOT, 'build-validation');
const RUN_SPRINT = path.join(__dirname, 'run-sprint.mjs');
const REPORT = path.join(OUT_DIR, 'validation', 'validation_report.json');
const UPLOAD_DIR = path.join(ROOT, 'outputs', 'validation-sprint', '_uploads');
const PROGRESS = path.join(OUT_DIR, 'logs', 'progress.json');
const RUN_L1B = path.join(ROOT, 'scripts', 'l1b', 'run-from-l1a.mjs');
const MULTILOGUE_OUT = path.resolve(process.env.MWU_MULTILOGUE_OUT || path.join(ROOT, 'outputs', 'multilogue-validation'));
const L1A_LEGACY_REVIEW_OUT = path.join(ROOT, 'outputs', 'l1a-candidate-runs');
const L1A_REVIEW_OUT = path.resolve(process.env.MWU_L1A_ROOT || path.join(MULTILOGUE_OUT, 'sessions'));
const L1A_REVIEW_ROOTS = process.env.MWU_L1A_ROOT
  ? [L1A_REVIEW_OUT]
  : [L1A_REVIEW_OUT, L1A_LEGACY_REVIEW_OUT];
const RUN_L1A_PROVIDER = path.join(ROOT, 'scripts', 'phase1-pyannote-remote.mjs');
const L1B_LEGACY_OUT = path.resolve(process.env.MWU_L1B_ROOT || path.join(ROOT, 'outputs', 'l1b'));
const FINALIZE_L1B = path.join(ROOT, 'scripts', 'l1b', 'finalize-reviewed.mjs');
const MULTILOGUE_V2_RECORDING = 'Multilogue04_C_Level30_D1G4';
const MULTILOGUE_V2_DEFAULT_OUT = path.join(ROOT, 'outputs', 'multilogue-v2-poc', MULTILOGUE_V2_RECORDING);
const MULTILOGUE_V2_OUT = path.resolve(process.env.MWU_V2_POC_ROOT || MULTILOGUE_V2_DEFAULT_OUT);
const MULTILOGUE_V2_RUNNER = path.join(ROOT, 'scripts', 'multilogue-v2', 'run-validation-poc.mjs');
const MULTILOGUE_V2_PROGRESS = path.join(MULTILOGUE_V2_OUT, 'delivery', 'progress.json');
const MULTILOGUE_V2_REPORT = path.join(MULTILOGUE_V2_OUT, 'delivery', 'ui-report.json');

// canonical filenames the pipeline expects, keyed by upload role
const ROLE_FILE = {
  wav: '8_STEM_SpeakerX_checked_and_pruned.wav',
  textgrid: '8 STEM SpeakerX.TextGrid',
  transcript: '8 STEM SpeakerX checked and pruned.txt',
  workbook: 'Example fluency measures calculations SpeakerX.xlsx',
};

const PORT = (() => {
  const i = process.argv.indexOf('--port');
  return i >= 0 ? Number(process.argv[i + 1]) : 4173;
})();

const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json',
  '.svg': 'image/svg+xml', '.map': 'application/json', '.txt': 'text/plain', '.csv': 'text/csv',
  '.TextGrid': 'text/plain', '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', '.wav': 'audio/wav',
  '.zip': 'application/zip', '.tsv': 'text/tab-separated-values',
};

let currentRun = null; // { child, running }
let currentL1aRun = null;
let currentL1bRun = null;
let currentL1bFinalize = null;
let currentMultilogueV2Run = null;
let activeTask = null;

const DEFAULT_MAX_BODY_BYTES = Number(process.env.MWU_MAX_BODY_BYTES || 128 * 1024 * 1024);
const L1A_MAX_WAV_BYTES = Number(process.env.MWU_L1A_MAX_WAV_BYTES || 512 * 1024 * 1024);

function send(res, code, body, type = 'application/json') {
  res.writeHead(code, { 'Content-Type': type, 'Access-Control-Allow-Origin': '*' });
  res.end(body);
}
function readBody(req, { maxBytes = DEFAULT_MAX_BODY_BYTES } = {}) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let bytes = 0;
    let settled = false;
    const fail = (message, statusCode = 400) => {
      if (settled) return;
      settled = true;
      const error = new Error(message);
      error.statusCode = statusCode;
      reject(error);
    };
    const declared = Number(req.headers['content-length']);
    if (Number.isFinite(declared) && declared > maxBytes) {
      req.resume();
      fail(`request body exceeds ${maxBytes} bytes`, 413);
      return;
    }
    req.on('data', (chunk) => {
      if (settled) return;
      bytes += chunk.length;
      if (bytes > maxBytes) {
        fail(`request body exceeds ${maxBytes} bytes`, 413);
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (settled) return;
      settled = true;
      resolve(Buffer.concat(chunks));
    });
    req.on('aborted', () => fail('request body upload was aborted', 400));
    req.on('error', (error) => fail(`request body error: ${error.message}`, 400));
  });
}
function sendJson(res, code, value) {
  return send(res, code, JSON.stringify(value));
}
function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function l1aRootForRun(runId) {
  for (const root of L1A_REVIEW_ROOTS) {
    try {
      if (fs.existsSync(pathsForRun(root, runId).state)) return root;
    } catch {
      // The route-level handler reports malformed run identifiers consistently.
    }
  }
  return L1A_REVIEW_OUT;
}

function allL1aReviewRuns() {
  const byRun = new Map();
  for (const root of L1A_REVIEW_ROOTS) {
    for (const state of listL1aReviewRuns(root)) {
      if (!byRun.has(state.run_id)) byRun.set(state.run_id, state);
    }
  }
  return [...byRun.values()].sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
}

function acquireTask(kind) {
  if (activeTask?.running) return { ok: false, active: activeTask.kind };
  activeTask = { kind, running: true, started_at: new Date().toISOString() };
  return { ok: true };
}

function releaseTask(kind) {
  if (activeTask?.kind === kind) activeTask = null;
}

function bodyError(res, error) {
  if (res.writableEnded || res.destroyed) return;
  return sendJson(res, Number(error?.statusCode) || 400, { error: error?.message || String(error) });
}

function apiRouteError(res, error, fallbackCode = 400) {
  const code = error instanceof URIError ? 404 : fallbackCode;
  return sendJson(res, code, { error: code === 404 ? 'API route not found' : (error?.message || String(error)) });
}
function serveRangeFile(req, res, file, type, disposition = 'inline') {
  const size = fs.statSync(file).size;
  const range = req.headers.range;
  const common = {
    'Content-Type': type,
    'Accept-Ranges': 'bytes',
    'X-Content-Type-Options': 'nosniff',
    'Content-Disposition': `${disposition}; filename="${path.basename(file).replaceAll('"', '')}"`,
  };
  if (!range) {
    res.writeHead(200, { ...common, 'Content-Length': size });
    return fs.createReadStream(file).pipe(res);
  }
  const match = /^bytes=(\d*)-(\d*)$/.exec(range);
  if (!match) {
    res.writeHead(416, { 'Content-Range': `bytes */${size}` });
    return res.end();
  }
  let start;
  let end;
  if (!match[1]) {
    const suffixLength = Number(match[2]);
    if (!Number.isInteger(suffixLength) || suffixLength <= 0) {
      res.writeHead(416, { 'Content-Range': `bytes */${size}` });
      return res.end();
    }
    start = Math.max(0, size - suffixLength);
    end = size - 1;
  } else {
    start = Number(match[1]);
    end = match[2] ? Math.min(Number(match[2]), size - 1) : size - 1;
  }
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end < start || start >= size) {
    res.writeHead(416, { 'Content-Range': `bytes */${size}` });
    return res.end();
  }
  res.writeHead(206, {
    ...common,
    'Content-Length': end - start + 1,
    'Content-Range': `bytes ${start}-${end}/${size}`,
  });
  return fs.createReadStream(file, { start, end }).pipe(res);
}

function syntheticCandidateTurns(count, duration) {
  const speakers = Math.max(2, Math.min(8, Number(count) || 3));
  const turns = [];
  const slot = Math.max(0.08, duration / (speakers * 3 + 2));
  let cursor = Math.min(slot, duration * 0.05);
  for (let round = 0; round < 3; round += 1) {
    for (let index = 0; index < speakers; index += 1) {
      const start = Math.min(cursor, Math.max(0, duration - slot));
      const end = Math.min(duration, start + slot * 0.7);
      if (end > start) turns.push({ speaker: `SPEAKER_${String(index).padStart(2, '0')}`, start, end, confidence: 0.9 - index * 0.01 });
      cursor += slot;
    }
  }
  return turns;
}

function providerUploadDerivative(sourceAudio, inputDir) {
  const output = path.join(inputDir, 'provider.16k_mono.wav');
  const converted = spawnSync('ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-i', sourceAudio,
    '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le',
    output,
  ], { encoding: 'utf8' });
  if (converted.status === 0 && fs.existsSync(output)) return { path: output, derivative: true };
  return { path: sourceAudio, derivative: false, warning: String(converted.stderr || 'ffmpeg conversion unavailable').slice(0, 500) };
}
function serveStatic(res, urlPath) {
  const rel = urlPath === '/' ? '/validation.html' : urlPath;
  const file = path.join(BUILD_DIR, decodeURIComponent(rel));
  if (!file.startsWith(BUILD_DIR) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    const idx = path.join(BUILD_DIR, 'validation.html');
    if (fs.existsSync(idx)) return send(res, 200, fs.readFileSync(idx), 'text/html');
    return send(res, 404, 'not found', 'text/plain');
  }
  send(res, 200, fs.readFileSync(file), MIME[path.extname(file)] || 'application/octet-stream');
}

function sanitize(value) {
  return String(value ?? 'unknown').replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^_+|_+$/g, '') || 'unknown';
}

function rebaseRepoPath(value) {
  if (typeof value !== 'string' || !path.isAbsolute(value)) return value;
  // Session revisions deliberately contain an /outputs/ directory. Preserve
  // valid local paths before applying the legacy cross-machine path rebasing.
  if (fs.existsSync(value)) return value;
  const normalized = value.replace(/\\/g, '/');
  for (const marker of ['/sample/', '/outputs/', '/scripts/', '/tests/', '/build-validation/']) {
    const index = normalized.indexOf(marker);
    if (index >= 0) return path.join(ROOT, ...normalized.slice(index + 1).split('/'));
  }
  return value;
}

function diarizationExitError(runPaths, recordingId, code) {
  const logPath = path.join(runPaths.providerDir, `${recordingId}.pyannote_remote.log.jsonl`);
  try {
    const entries = fs.readFileSync(logPath, 'utf8').trim().split(/\r?\n/).reverse();
    for (const line of entries) {
      const entry = JSON.parse(line);
      if (entry.event === 'error' && entry.message) {
        return new Error(`Diarization failed: ${String(entry.message).slice(0, 500)}`);
      }
    }
  } catch { /* fall back to the provider exit code */ }
  return new Error(`Diarization provider exited with code ${code}`);
}

function rebaseReportPaths(value) {
  if (Array.isArray(value)) return value.map(rebaseReportPaths);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, rebaseReportPaths(child)]));
  }
  return rebaseRepoPath(value);
}

function walkFiles(dir, output = []) {
  if (!fs.existsSync(dir)) return output;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) walkFiles(file, output);
    else output.push(file);
  }
  return output;
}

function l1aManifestSummary(file) {
  try {
    const manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
    const handoff = manifest.phase_ii_handoff;
    const lifecycleStatus = manifest.lifecycle?.status
      || (manifest.review?.status === 'accepted' ? 'accepted' : (handoff?.ready === true ? 'legacy_ready' : 'unknown'));
    const inputs = Array.isArray(handoff?.inputs) ? handoff.inputs : [];
    const filesReady = inputs.length > 0 && inputs.every((input) => fs.existsSync(rebaseRepoPath(input.wav)) && fs.existsSync(rebaseRepoPath(input.invalid_intervals_tsv)));
    const source = rebaseRepoPath(manifest.source_audio || file);
    const externalHandoffPath = rebaseRepoPath(manifest.outputs?.phase_ii_handoff_manifest || '');
    let externalHandoffReady = true;
    if (externalHandoffPath) {
      if (!fs.existsSync(externalHandoffPath)) externalHandoffReady = false;
      else {
        const externalHandoff = JSON.parse(fs.readFileSync(externalHandoffPath, 'utf8'));
        externalHandoffReady = externalHandoff.ready === true
          && (!externalHandoff.source_manifest_sha256 || externalHandoff.source_manifest_sha256 === sha256(file));
      }
    }
    const handoffGate = assessL1aHandoff({ manifestPath: file });
    const pathBReadiness = handoffGate.passed ? assessL1aPathBReadiness({ manifestPath: file }) : null;
    const pathBSupported = inputs.length >= 2;
    const pathBEvidenceReady = pathBReadiness?.passed === true;
    const l1bBlockers = [];
    if (!handoffGate.passed) l1bBlockers.push('Accepted L1a output must be rebuilt under the current sealed handoff contract.');
    if (!pathBSupported) l1bBlockers.push(`L1b requires at least two accepted participants; this session contains ${inputs.length}.`);
    return {
      path: file,
      name: path.basename(file),
      recording_id: sanitize(manifest.recording_id || path.basename(source, path.extname(source))),
      session_id: manifest.session_id || handoff?.session_id || null,
      review_revision: Number(manifest.review?.revision || handoff?.review_revision || 0) || null,
      layer_revision: manifest.layer_revision || null,
      source_audio: `${sanitize(manifest.recording_id || path.basename(source, path.extname(source)))}.wav`,
      generated_at: manifest.generated_at || fs.statSync(file).mtime.toISOString(),
      duration_seconds: manifest.duration_seconds,
      source: manifest.source,
      overlap: manifest.overlap || null,
      lifecycle_status: lifecycleStatus,
      superseded: lifecycleStatus === 'superseded',
      ready: handoffGate.passed,
      handoff_gate: {
        passed: handoffGate.passed,
        blocker_codes: handoffGate.blockers.map((item) => item.code),
        identity_sha256: handoffGate.sealed_handoff_identity?.identity_sha256 || null,
      },
      path_b_evidence: {
        ready: pathBEvidenceReady,
        blocker_codes: pathBReadiness?.blockers?.map((item) => item.code) || [],
        identity_sha256: pathBReadiness?.sealed_evidence_identity?.identity_sha256 || null,
      },
      path_b_supported: pathBSupported,
      l1b_runnable: handoffGate.passed && pathBSupported,
      l1b_blockers: l1bBlockers,
      label_contract: handoff?.expected_labels || [],
      speakers: inputs.map((input) => {
        const wav = rebaseRepoPath(input.wav || '');
        const invalid = rebaseRepoPath(input.invalid_intervals_tsv || '');
        return {
          speaker: String(input.speaker || '').replace(/^speaker_/, ''),
          wav_name: path.basename(wav),
          invalid_name: path.basename(invalid),
          wav_ready: fs.existsSync(wav),
          invalid_ready: fs.existsSync(invalid),
        };
      }),
    };
  } catch {
    return null;
  }
}

function sessionRootForManifest(manifestPath) {
  let cursor = path.dirname(path.resolve(manifestPath));
  while (cursor !== path.dirname(cursor)) {
    if (path.basename(cursor) === 'L1a') return path.dirname(cursor);
    cursor = path.dirname(cursor);
  }
  throw new Error('accepted L1a manifest is not inside a processing session');
}

function nextL1bRevision(manifestPath) {
  const sessionRoot = sessionRootForManifest(manifestPath);
  const layerRoot = path.join(sessionRoot, 'L1b');
  const revisionsRoot = path.join(layerRoot, 'revisions');
  fs.mkdirSync(revisionsRoot, { recursive: true });
  const highest = fs.readdirSync(revisionsRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => /^draft-v(\d+)$/.exec(entry.name)?.[1])
    .filter(Boolean)
    .reduce((max, value) => Math.max(max, Number(value)), 0);
  const revision = `draft-v${String(highest + 1).padStart(4, '0')}`;
  const revisionRoot = path.join(revisionsRoot, revision);
  return {
    sessionRoot,
    layerRoot,
    revision,
    out: path.join(revisionRoot, 'outputs'),
    progress: path.join(revisionRoot, 'logs', 'progress.json'),
    latestPointer: path.join(layerRoot, 'latest.json'),
  };
}

function latestL1bPointer() {
  if (currentL1bRun?.latestPointer && fs.existsSync(currentL1bRun.latestPointer)) return currentL1bRun.latestPointer;
  const pointers = walkFiles(path.join(MULTILOGUE_OUT, 'sessions'))
    .filter((file) => /\/L1b\/latest\.json$/.test(file))
    .sort((left, right) => fs.statSync(right).mtimeMs - fs.statSync(left).mtimeMs);
  if (pointers.length) return pointers[0];
  const legacy = path.join(L1B_LEGACY_OUT, 'latest.json');
  return fs.existsSync(legacy) ? legacy : null;
}

function listL1aRuns() {
  return walkFiles(MULTILOGUE_OUT)
    .filter((file) => /phase1_manifest\.json$/i.test(file))
    .map(l1aManifestSummary)
    .filter(Boolean)
    .sort((a, b) => String(b.generated_at).localeCompare(String(a.generated_at)));
}

function latestAcceptedL1aSessions(runs) {
  const seen = new Set();
  return runs.filter((run) => {
    if (!run.session_id || run.lifecycle_status !== 'accepted' || run.superseded || seen.has(run.session_id)) return false;
    seen.add(run.session_id);
    return true;
  });
}

function latestL1bContext() {
  try {
    const pointerPath = latestL1bPointer();
    if (!pointerPath) return null;
    const pointer = JSON.parse(fs.readFileSync(pointerPath, 'utf8'));
    const reportPath = path.resolve(rebaseRepoPath(pointer.report || ''));
    const allowed = [path.resolve(MULTILOGUE_OUT), path.resolve(L1B_LEGACY_OUT)];
    if (!allowed.some((root) => reportPath.startsWith(root)) || !fs.existsSync(reportPath)) return null;
    const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
    const sourceManifest = rebaseRepoPath(report.source_manifest || '');
    let staleReason = null;
    if (!sourceManifest || !fs.existsSync(sourceManifest)) staleReason = 'source_manifest_missing';
    else {
      const summary = l1aManifestSummary(sourceManifest);
      if (!summary?.ready) staleReason = summary?.superseded ? 'source_manifest_superseded' : 'source_handoff_not_ready';
      else if (report.source_manifest_sha256 && sha256(sourceManifest) !== report.source_manifest_sha256) staleReason = 'source_manifest_changed';
    }
    return { pointerPath, reportPath, outDir: path.dirname(reportPath), report, stale: Boolean(staleReason), staleReason };
  } catch {
    return null;
  }
}

function l1bContextForManifest(manifestPath) {
  try {
    const resolvedManifest = path.resolve(manifestPath || '');
    const acceptedRoot = path.resolve(MULTILOGUE_OUT);
    if (!(resolvedManifest === acceptedRoot || resolvedManifest.startsWith(`${acceptedRoot}${path.sep}`))) return null;
    const sessionRoot = sessionRootForManifest(resolvedManifest);
    const pointerPath = path.join(sessionRoot, 'L1b', 'latest.json');
    if (!fs.existsSync(pointerPath)) return null;
    const pointer = JSON.parse(fs.readFileSync(pointerPath, 'utf8'));
    const reportPath = path.resolve(rebaseRepoPath(pointer.report || ''));
    if (!reportPath.startsWith(`${sessionRoot}${path.sep}`) || !fs.existsSync(reportPath)) return null;
    const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
    if (path.resolve(rebaseRepoPath(report.source_manifest || '')) !== resolvedManifest) return null;
    const summary = l1aManifestSummary(resolvedManifest);
    let staleReason = null;
    if (!summary?.ready) staleReason = summary?.superseded ? 'source_manifest_superseded' : 'source_handoff_not_ready';
    else if (report.source_manifest_sha256 && sha256(resolvedManifest) !== report.source_manifest_sha256) staleReason = 'source_manifest_changed';
    return { pointerPath, reportPath, outDir: path.dirname(reportPath), report, stale: Boolean(staleReason), staleReason };
  } catch {
    return null;
  }
}

function readLatestL1bReport() {
  const context = latestL1bContext();
  if (!context) return null;
  if (context.stale) {
    return JSON.stringify(rebaseReportPaths({
      ...context.report,
      status: 'stale',
      stale: true,
      stale_reason: context.staleReason,
    }));
  }
  return JSON.stringify(rebaseReportPaths(context.report));
}

function readL1bReportForManifest(manifestPath) {
  const context = l1bContextForManifest(manifestPath);
  if (!context) return null;
  if (context.stale) {
    return JSON.stringify(rebaseReportPaths({
      ...context.report,
      status: 'stale',
      stale: true,
      stale_reason: context.staleReason,
    }));
  }
  return JSON.stringify(rebaseReportPaths(context.report));
}

function readMultilogueV2Report() {
  try {
    return JSON.parse(fs.readFileSync(MULTILOGUE_V2_REPORT, 'utf8'));
  } catch {
    return null;
  }
}

function multilogueV2InputStatus() {
  const required = [
    path.join(ROOT, 'sample', 'Multilogue04_C_Level30 D1G4.wav'),
    path.join(ROOT, 'outputs', 'multilogue-validation', MULTILOGUE_V2_RECORDING, 'pyannote-remote', `${MULTILOGUE_V2_RECORDING}.pyannote.remote.raw_turns.json`),
    path.join(ROOT, 'outputs', 'multilogue-validation', MULTILOGUE_V2_RECORDING, 'assemblyai', `${MULTILOGUE_V2_RECORDING}.16k_mono.assemblyai.raw.json`),
  ];
  return {
    ready: required.every((file) => fs.existsSync(file)),
    recording_name: 'Multilogue04_C_Level30 D1G4.wav',
    evidence_source: 'local_audio_and_cached_provider_artifacts',
    external_upload_performed: false,
    required_files_present: required.map((file) => ({ name: path.basename(file), present: fs.existsSync(file) })),
  };
}

function resolveMultilogueV2Artifact(identifier) {
  const report = readMultilogueV2Report();
  if (!report || !Array.isArray(report.artifacts)) return null;
  const artifact = report.artifacts.find((item) => item.id === identifier || item.path === identifier);
  if (!artifact || typeof artifact.path !== 'string' || path.isAbsolute(artifact.path) || artifact.path.includes('..')) return null;
  const file = path.resolve(MULTILOGUE_V2_OUT, artifact.path);
  const root = path.resolve(MULTILOGUE_V2_OUT);
  if (!file.startsWith(`${root}${path.sep}`) || !fs.existsSync(file) || !fs.statSync(file).isFile()) return null;
  return { artifact, file };
}

function reviewedTextGridName(report, job) {
  const threshold = Number(job.threshold).toFixed(2).replace(/0+$/, '').replace(/\.$/, '');
  return `${sanitize(report.recording_id)}_${sanitize(job.speaker)}_${threshold}s.TextGrid`;
}

function l1bReviewContract() {
  const context = latestL1bContext();
  if (!context || context.stale || context.report.status !== 'ready_for_praat_review') return null;
  const reviewsDir = path.join(context.outDir, 'reviewed-inputs');
  const finalDir = path.join(context.outDir, 'reviewed-final');
  const finalReportPath = path.join(finalDir, 'l1b_final_report.json');
  const progressPath = path.join(finalDir, 'progress.json');
  const required = (context.report.jobs || []).map((job) => {
    const name = reviewedTextGridName(context.report, job);
    const uploadPath = path.join(reviewsDir, name);
    return {
      key: `${job.speaker}-${job.threshold}`,
      speaker: job.speaker,
      threshold: job.threshold,
      target_name: name,
      draft_path: job.textgrid,
      draft_name: path.basename(job.textgrid || ''),
      upload_path: uploadPath,
      uploaded: fs.existsSync(uploadPath),
      bytes: fs.existsSync(uploadPath) ? fs.statSync(uploadPath).size : 0,
    };
  });
  let finalReport = null;
  let progress = null;
  try { finalReport = JSON.parse(fs.readFileSync(finalReportPath, 'utf8')); } catch { /* no final run yet */ }
  try { progress = JSON.parse(fs.readFileSync(progressPath, 'utf8')); } catch { /* no final run yet */ }
  return {
    draft_report: context.reportPath,
    draft_status: context.report.status,
    recording_id: context.report.recording_id,
    reviews_dir: reviewsDir,
    final_dir: finalDir,
    required,
    uploaded: required.filter((item) => item.uploaded).length,
    total: required.length,
    ready_to_finalize: required.length > 0 && required.every((item) => item.uploaded),
    final_report: finalReport,
    progress,
  };
}

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, `http://localhost:${PORT}`);

  // ---- L1a: room-mix upload -> provider candidates -> researcher review ----
  if (u.pathname === '/api/l1a/runs' && req.method === 'GET') {
    return sendJson(res, 200, { runs: allL1aReviewRuns() });
  }

  if (u.pathname === '/api/l1a/run' && req.method === 'POST') {
    const gate = acquireTask('l1a');
    if (!gate.ok) return sendJson(res, 409, { error: `cannot start L1a while ${gate.active} is running`, active_task: gate.active });
    const filename = path.basename(u.searchParams.get('filename') || req.headers['x-file-name'] || 'recording.wav');
    if (path.extname(filename).toLowerCase() !== '.wav') {
      releaseTask('l1a');
      return sendJson(res, 400, { error: 'L1a accepts one RIFF/WAVE file' });
    }
    let wavBuffer;
    try {
      wavBuffer = await readBody(req, { maxBytes: L1A_MAX_WAV_BYTES });
    } catch (error) {
      releaseTask('l1a');
      return bodyError(res, error);
    }
    if (!wavBuffer.length) {
      releaseTask('l1a');
      return sendJson(res, 400, { error: 'uploaded WAV is empty' });
    }
    let created;
    try {
      created = createL1aRun({
        root: L1A_REVIEW_OUT,
        filename,
        wavBuffer,
        contentType: req.headers['content-type'] || 'audio/wav',
      });
    } catch (error) {
      releaseTask('l1a');
      return sendJson(res, 400, { error: error.message || String(error) });
    }
    const { state } = created;
    const requestedFixtureCount = Number(req.headers['x-mwu-test-candidate-count']);
    const fixtureCount = Number.isInteger(requestedFixtureCount) ? requestedFixtureCount : 3;
    if (process.env.MWU_L1A_TEST_MODE === '1') {
      const turns = syntheticCandidateTurns(fixtureCount, state.preflight.duration_seconds);
      completeProviderRun({ root: L1A_REVIEW_OUT, runId: state.run_id, turns, provider: { source: 'synthetic_test_fixture', model: 'none' } });
      const holdMs = Math.max(0, Math.min(5000, Number(req.headers['x-mwu-test-hold-ms']) || 0));
      if (holdMs) setTimeout(() => releaseTask('l1a'), holdMs);
      else releaseTask('l1a');
      return sendJson(res, 201, { ok: true, run_id: state.run_id, status: 'candidate_review' });
    }

    const runPaths = pathsForRun(L1A_REVIEW_OUT, state.run_id);
    const uploadAudio = providerUploadDerivative(runPaths.sourceAudio, runPaths.inputDir);
    setRunStatus({
      root: L1A_REVIEW_OUT,
      runId: state.run_id,
      status: 'provider_running',
      provider_upload: { derivative_16k_mono: uploadAudio.derivative, warning: uploadAudio.warning || null },
    });
    const child = spawn(process.execPath, [
      RUN_L1A_PROVIDER,
      '--audio', runPaths.sourceAudio,
      '--upload-audio', uploadAudio.path,
      '--out-dir', runPaths.providerDir,
      '--prefix', state.recording_id,
    ], { cwd: ROOT, env: process.env, stdio: 'ignore' });
    currentL1aRun = { child, running: true, runId: state.run_id };
    child.on('error', (error) => {
      currentL1aRun.running = false;
      releaseTask('l1a');
      setRunFailure({ root: L1A_REVIEW_OUT, runId: state.run_id, error });
    });
    child.on('exit', (code) => {
      currentL1aRun.running = false;
      releaseTask('l1a');
      try {
        if (code !== 0) throw diarizationExitError(runPaths, state.recording_id, code);
        const rawTurnsPath = path.join(runPaths.providerDir, `${state.recording_id}.pyannote.remote.raw_turns.json`);
        const rawTurns = JSON.parse(fs.readFileSync(rawTurnsPath, 'utf8'));
        completeProviderRun({
          root: L1A_REVIEW_OUT,
          runId: state.run_id,
          turns: rawTurns.turns || rawTurns,
          provider: { source: 'pyannoteAI_remote', model: 'community-1' },
        });
      } catch (error) {
        setRunFailure({ root: L1A_REVIEW_OUT, runId: state.run_id, error });
      }
    });
    return sendJson(res, 202, { ok: true, run_id: state.run_id, status: 'provider_running' });
  }

  const l1aCandidateMatch = /^\/api\/l1a\/runs\/([^/]+)\/candidates$/.exec(u.pathname);
  if (l1aCandidateMatch && req.method === 'GET') {
    try {
      const runId = decodeURIComponent(l1aCandidateMatch[1]);
      const snapshot = getRunSnapshot({ root: l1aRootForRun(runId), runId });
      if (!snapshot) return sendJson(res, 404, { error: 'L1a run not found' });
      return sendJson(res, 200, { ...snapshot, artifacts: artifactIndex(snapshot) });
    } catch (error) {
      return apiRouteError(res, error);
    }
  }

  const l1aAudioMatch = /^\/api\/l1a\/runs\/([^/]+)\/audio$/.exec(u.pathname);
  if (l1aAudioMatch && req.method === 'GET') {
    try {
      const runId = decodeURIComponent(l1aAudioMatch[1]);
      const file = resolveRunAudio({ root: l1aRootForRun(runId), runId });
      return serveRangeFile(req, res, file, 'audio/wav');
    } catch (error) {
      return apiRouteError(res, error, 404);
    }
  }

  const l1aConfirmMatch = /^\/api\/l1a\/runs\/([^/]+)\/confirm$/.exec(u.pathname);
  if (l1aConfirmMatch && req.method === 'POST') {
    try {
      const payload = JSON.parse((await readBody(req)).toString() || '{}');
      const runId = decodeURIComponent(l1aConfirmMatch[1]);
      const reviewRoot = l1aRootForRun(runId);
      saveReviewDraft({ root: reviewRoot, runId, payload });
      const result = confirmReview({
        root: reviewRoot,
        acceptedRoot: MULTILOGUE_OUT,
        runId,
      });
      return sendJson(res, 200, {
        ok: true,
        state: result.state,
        manifest: rebaseReportPaths(result.manifest),
        artifacts: artifactIndex(getRunSnapshot({ root: reviewRoot, runId: result.state.run_id })),
      });
    } catch (error) {
      if (error instanceof URIError) return apiRouteError(res, error, 404);
      return sendJson(res, error.validationErrors ? 422 : 400, { error: error.message || String(error), validation_errors: error.validationErrors || [] });
    }
  }

  const l1aArtifactMatch = /^\/api\/l1a\/runs\/([^/]+)\/artifact$/.exec(u.pathname);
  if (l1aArtifactMatch && req.method === 'GET') {
    try {
      const file = resolveAcceptedArtifact({
        root: l1aRootForRun(decodeURIComponent(l1aArtifactMatch[1])),
        runId: decodeURIComponent(l1aArtifactMatch[1]),
        relativePath: u.searchParams.get('path') || '',
      });
      return serveRangeFile(req, res, file, MIME[path.extname(file)] || 'application/octet-stream', 'attachment');
    } catch (error) {
      return apiRouteError(res, error, 404);
    }
  }

  // ---- upload a file for a role (raw body) ----
  if (u.pathname === '/api/upload' && req.method === 'POST') {
    const role = u.searchParams.get('role');
    if (!ROLE_FILE[role]) return send(res, 400, JSON.stringify({ error: 'bad role' }));
    const buf = await readBody(req);
    fs.mkdirSync(UPLOAD_DIR, { recursive: true });
    fs.writeFileSync(path.join(UPLOAD_DIR, ROLE_FILE[role]), buf);
    return send(res, 200, JSON.stringify({ ok: true, role, bytes: buf.length }));
  }

  // ---- start a run for ONE phase (background) ----
  if (u.pathname === '/api/run' && req.method === 'POST') {
    const gate = acquireTask('validation');
    if (!gate.ok) return sendJson(res, 409, { error: `cannot start validation while ${gate.active} is running`, active_task: gate.active });
    let body;
    try { body = JSON.parse((await readBody(req)).toString() || '{}'); }
    catch (error) { releaseTask('validation'); return bodyError(res, error); }
    const phase = ['ii', 'iii', 'v', 'all'].includes(body.phase) ? body.phase : 'all';
    const sampleDir = body.useSample ? SAMPLE_DIR : UPLOAD_DIR;
    // required input roles per phase
    const REQUIRED = {
      ii: ['wav', 'textgrid', 'workbook'],
      iii: ['transcript'],
      v: ['wav', 'textgrid', 'workbook'],
      all: ['wav', 'textgrid', 'transcript', 'workbook'],
    }[phase];
    const missing = REQUIRED.filter((role) => !fs.existsSync(path.join(sampleDir, ROLE_FILE[role])));
    if (missing.length) {
      releaseTask('validation');
      return send(res, 400, JSON.stringify({ error: `missing inputs for Phase ${phase}: ${missing.join(', ')}`, missing }));
    }
    fs.mkdirSync(path.dirname(PROGRESS), { recursive: true });
    fs.writeFileSync(PROGRESS, JSON.stringify({ done: false, ok: true, phase, readiness: 'running', steps: [] }));
    const runArgs = [RUN_SPRINT, '--phase', phase, '--progress', PROGRESS];
    // configurable thresholds from the UI (always includes 0.25 + 0.35; may add a custom one)
    if (Array.isArray(body.thresholds) && body.thresholds.length) {
      const ths = [...new Set(body.thresholds.map(Number).filter((n) => n > 0 && n < 5))];
      if (ths.length) runArgs.push('--thresholds', ths.join(','));
    }
    if (body.noAsr === true) runArgs.push('--no-asr');
    const child = spawn('node', runArgs, {
      env: { ...process.env, SPRINT_SAMPLE_DIR: sampleDir }, stdio: 'ignore',
    });
    currentRun = { child, running: true };
    child.on('error', () => { currentRun.running = false; releaseTask('validation'); });
    child.on('exit', () => { currentRun.running = false; releaseTask('validation'); });
    return send(res, 200, JSON.stringify({ ok: true, started: true, phase }));
  }

  // ---- poll progress ----
  if (u.pathname === '/api/status') {
    if (!fs.existsSync(PROGRESS)) return send(res, 200, JSON.stringify({ idle: true, done: false, steps: [] }));
    return send(res, 200, fs.readFileSync(PROGRESS));
  }

  // ---- report ----
  if (u.pathname === '/api/report') {
    if (!fs.existsSync(REPORT)) return send(res, 200, JSON.stringify({ readiness: 'idle' }));
    return send(res, 200, JSON.stringify(rebaseReportPaths(JSON.parse(fs.readFileSync(REPORT, 'utf8')))));
  }

  // ---- Multilogue04 v2: local-only Phase I -> Phase II draft validation ----
  if (u.pathname === '/api/multilogue-v2/input' && req.method === 'GET') {
    return send(res, 200, JSON.stringify(multilogueV2InputStatus()));
  }

  if (u.pathname === '/api/multilogue-v2/run' && req.method === 'POST') {
    if (currentMultilogueV2Run?.running) {
      return send(res, 409, JSON.stringify({ error: 'a Multilogue04 v2 run is already in progress' }));
    }
    const input = multilogueV2InputStatus();
    if (!input.ready) return send(res, 400, JSON.stringify({ error: 'local Multilogue04 inputs are incomplete' }));
    fs.mkdirSync(path.dirname(MULTILOGUE_V2_PROGRESS), { recursive: true });
    fs.writeFileSync(MULTILOGUE_V2_PROGRESS, JSON.stringify({
      contract_version: 'multilogue-v2-progress-events-v1',
      status: 'starting',
      done: false,
      active_step: 'phase_i_evidence',
      events: [],
      steps: [],
      updated_at: new Date().toISOString(),
    }));
    const child = spawn(process.execPath, [MULTILOGUE_V2_RUNNER], {
      cwd: ROOT,
      env: { ...process.env, MWU_V2_POC_ROOT: MULTILOGUE_V2_OUT },
      stdio: 'ignore',
    });
    currentMultilogueV2Run = { child, running: true };
    child.on('exit', () => { currentMultilogueV2Run.running = false; });
    return send(res, 200, JSON.stringify({ ok: true, started: true, recording_id: MULTILOGUE_V2_RECORDING }));
  }

  if (u.pathname === '/api/multilogue-v2/status' && req.method === 'GET') {
    if (!fs.existsSync(MULTILOGUE_V2_PROGRESS)) {
      return send(res, 200, JSON.stringify({ status: 'idle', idle: true, done: false, events: [], steps: [] }));
    }
    return send(res, 200, fs.readFileSync(MULTILOGUE_V2_PROGRESS));
  }

  if (u.pathname === '/api/multilogue-v2/report' && req.method === 'GET') {
    const report = readMultilogueV2Report();
    return send(res, 200, JSON.stringify(report || { status: 'idle' }));
  }

  if (u.pathname === '/api/multilogue-v2/file' && req.method === 'GET') {
    const resolved = resolveMultilogueV2Artifact(u.searchParams.get('path') || '');
    if (!resolved) return send(res, 404, 'forbidden', 'text/plain');
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(resolved.file)] || 'application/octet-stream',
      'Content-Disposition': `attachment; filename="${path.basename(resolved.file)}"`,
      'X-Content-Type-Options': 'nosniff',
    });
    return res.end(fs.readFileSync(resolved.file));
  }

  // ---- L1b input: latest valid Phase-I handoff plus any other discovered runs ----
  if (u.pathname === '/api/l1b/input') {
    const runs = listL1aRuns();
    const accepted = latestAcceptedL1aSessions(runs);
    const available = accepted.filter((run) => run.l1b_runnable);
    const selected = available[0] || accepted[0] || runs.find((run) => run.ready) || null;
    const ready = Boolean(selected?.ready && selected?.path_b_supported);
    let blocker = null;
    if (selected?.ready && !selected.path_b_supported) {
      blocker = 'L1b requires at least two accepted canonical participants.';
    }
    return send(res, 200, JSON.stringify({
      ready,
      selected,
      accepted,
      available,
      runs,
      blocker,
    }));
  }

  // ---- start deterministic L1b Praat extraction from a Phase-I manifest ----
  if (u.pathname === '/api/l1b/run' && req.method === 'POST') {
    const gate = acquireTask('l1b');
    if (!gate.ok) return sendJson(res, 409, { error: `cannot start L1b while ${gate.active} is running`, active_task: gate.active });
    let body;
    try { body = JSON.parse((await readBody(req)).toString() || '{}'); }
    catch (error) { releaseTask('l1b'); return bodyError(res, error); }
    const runs = listL1aRuns();
    const fallback = runs.find((run) => run.ready);
    const requested = path.resolve(body.manifest || fallback?.path || '');
    const acceptedRoot = path.resolve(MULTILOGUE_OUT);
    if (!(requested === acceptedRoot || requested.startsWith(`${acceptedRoot}${path.sep}`)) || !fs.existsSync(requested)) {
      releaseTask('l1b');
      return send(res, 400, JSON.stringify({ error: 'no valid L1a Phase-I manifest is available' }));
    }
    const chosen = l1aManifestSummary(requested);
    if (!chosen?.ready || !chosen?.path_b_supported) {
      releaseTask('l1b');
      return send(res, 400, JSON.stringify({
        error: !chosen?.ready
          ? 'selected L1a handoff is not ready'
          : 'selected L1a handoff must contain at least two accepted canonical participants',
        lifecycle_status: chosen?.lifecycle_status || 'unknown',
      }));
    }

    const thresholds = [...new Set((Array.isArray(body.thresholds) ? body.thresholds : [0.25, 0.35])
      .map(Number).filter((value) => value > 0 && value < 5))].sort((a, b) => a - b);
    if (!thresholds.length) {
      releaseTask('l1b');
      return send(res, 400, JSON.stringify({ error: 'at least one valid threshold is required' }));
    }

    const revision = nextL1bRevision(requested);
    fs.mkdirSync(path.dirname(revision.progress), { recursive: true });
    fs.writeFileSync(revision.progress, JSON.stringify({
      schema_version: 'mwu-l1b-path-b-progress-v1',
      done: false,
      status: 'starting',
      stages: [{ id: 'l1a_handoff_gate', status: 'passed', detail: chosen.handoff_gate.identity_sha256 }],
      updated_at: new Date().toISOString(),
    }));
    const args = [RUN_L1B, '--manifest', requested, '--out', revision.out, '--thresholds', thresholds.join(','), '--progress', revision.progress, '--latest-pointer', revision.latestPointer];
    const child = spawn('node', args, { cwd: ROOT, env: { ...process.env }, stdio: 'ignore' });
    currentL1bRun = {
      child,
      running: true,
      out: revision.out,
      manifest: requested,
      progress: revision.progress,
      latestPointer: revision.latestPointer,
    };
    child.on('error', () => { currentL1bRun.running = false; releaseTask('l1b'); });
    child.on('exit', () => { currentL1bRun.running = false; releaseTask('l1b'); });
    return send(res, 200, JSON.stringify({ ok: true, started: true, revision: revision.revision, recording_id: chosen.recording_id, thresholds }));
  }

  if (u.pathname === '/api/l1b/status') {
    const progressFile = currentL1bRun?.progress;
    if (!progressFile || !fs.existsSync(progressFile)) return send(res, 200, JSON.stringify({ idle: true, done: false, status: 'idle', stages: [] }));
    return send(res, 200, fs.readFileSync(progressFile));
  }

  if (u.pathname === '/api/l1b/report') {
    const manifest = u.searchParams.get('manifest');
    const report = manifest ? readL1bReportForManifest(manifest) : readLatestL1bReport();
    return report ? send(res, 200, report) : send(res, 200, JSON.stringify({ status: 'idle' }));
  }

  // ---- reviewed TextGrid gate: upload six Praat-reviewed grids before final duration calculation ----
  if (u.pathname === '/api/l1b/review') {
    const contract = l1bReviewContract();
    return contract ? send(res, 200, JSON.stringify(contract)) : send(res, 200, JSON.stringify({ status: 'idle', required: [] }));
  }

  if (u.pathname === '/api/l1b/review-upload' && req.method === 'POST') {
    const contract = l1bReviewContract();
    if (!contract) return send(res, 400, JSON.stringify({ error: 'no L1b draft is ready for review' }));
    const key = u.searchParams.get('key');
    const item = contract.required.find((candidate) => candidate.key === key);
    if (!item) return send(res, 400, JSON.stringify({ error: 'unknown speaker-threshold review slot' }));
    const buf = await readBody(req);
    if (buf.length < 100 || !/TextGrid|ooTextFile/.test(buf.subarray(0, Math.min(buf.length, 500)).toString('utf8'))) {
      return send(res, 400, JSON.stringify({ error: 'uploaded file is not a Praat TextGrid' }));
    }
    fs.mkdirSync(contract.reviews_dir, { recursive: true });
    fs.writeFileSync(item.upload_path, buf);
    return send(res, 200, JSON.stringify({ ok: true, key, target_name: item.target_name, bytes: buf.length }));
  }

  if (u.pathname === '/api/l1b/finalize' && req.method === 'POST') {
    if (currentL1bFinalize?.running) return send(res, 409, JSON.stringify({ error: 'L1b reviewed finalization is already running' }));
    const contract = l1bReviewContract();
    if (!contract) return send(res, 400, JSON.stringify({ error: 'no L1b draft is ready for finalization' }));
    const body = JSON.parse((await readBody(req)).toString() || '{}');
    const reviewer = String(body.reviewer || '').trim();
    if (body.confirmed !== true) return send(res, 400, JSON.stringify({ error: 'Praat review confirmation is required' }));
    if (!reviewer) return send(res, 400, JSON.stringify({ error: 'reviewer or rater ID is required' }));
    if (!contract.ready_to_finalize) {
      return send(res, 400, JSON.stringify({ error: `all reviewed TextGrids are required (${contract.uploaded}/${contract.total} uploaded)` }));
    }
    fs.mkdirSync(contract.final_dir, { recursive: true });
    const progressPath = path.join(contract.final_dir, 'progress.json');
    fs.writeFileSync(progressPath, JSON.stringify({ done: false, status: 'starting', completed: 0, total: contract.total, updated_at: new Date().toISOString() }));
    const args = [
      FINALIZE_L1B,
      '--draft-report', contract.draft_report,
      '--reviews-dir', contract.reviews_dir,
      '--out', contract.final_dir,
      '--reviewer', reviewer,
      '--review-confirmed', 'true',
      '--progress', progressPath,
    ];
    const child = spawn('node', args, { cwd: ROOT, env: { ...process.env }, stdio: 'ignore' });
    currentL1bFinalize = { child, running: true, out: contract.final_dir };
    child.on('exit', () => { currentL1bFinalize.running = false; });
    return send(res, 200, JSON.stringify({ ok: true, started: true, total: contract.total }));
  }

  if (u.pathname === '/api/l1b/finalize-status') {
    const contract = l1bReviewContract();
    if (!contract?.progress) return send(res, 200, JSON.stringify({ status: 'idle', done: false }));
    return send(res, 200, JSON.stringify(contract.progress));
  }

  if (u.pathname === '/api/l1b/final-report') {
    const contract = l1bReviewContract();
    return contract?.final_report ? send(res, 200, JSON.stringify(contract.final_report)) : send(res, 200, JSON.stringify({ status: 'idle' }));
  }

  if (u.pathname === '/api/l1b/file') {
    const p = path.resolve(rebaseRepoPath(u.searchParams.get('path') || ''));
    const allowed = [path.resolve(MULTILOGUE_OUT), path.resolve(L1B_LEGACY_OUT)];
    if (!allowed.some((root) => p.startsWith(root)) || !fs.existsSync(p)) return send(res, 404, 'forbidden', 'text/plain');
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(p)] || 'application/octet-stream',
      'Content-Disposition': `attachment; filename="${path.basename(p)}"`,
    });
    return res.end(fs.readFileSync(p));
  }

  // ---- download an artifact (sandboxed to OUT_DIR) ----
  if (u.pathname === '/api/file') {
    const p = path.resolve(u.searchParams.get('path') || '');
    if (!p.startsWith(OUT_DIR) || !fs.existsSync(p)) return send(res, 404, 'forbidden', 'text/plain');
    res.writeHead(200, { 'Content-Type': MIME[path.extname(p)] || 'application/octet-stream', 'Content-Disposition': `attachment; filename="${path.basename(p)}"` });
    return res.end(fs.readFileSync(p));
  }

  if (u.pathname.startsWith('/api/')) {
    return sendJson(res, 404, { error: 'API route not found', path: u.pathname });
  }

  try {
    return serveStatic(res, u.pathname);
  } catch (error) {
    if (error instanceof URIError) return send(res, 404, 'not found', 'text/plain');
    throw error;
  }
});

server.listen(PORT, () => console.log(`Validation console at http://localhost:${PORT}  (build: ${BUILD_DIR})`));
