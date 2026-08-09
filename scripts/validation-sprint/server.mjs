// Local server for the interactive Validation Console.
// Serves the React build + API: upload files, run in background, poll progress, fetch report, download artifacts.
// Usage: node scripts/validation-sprint/server.mjs [--port 4173]
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { OUT_DIR, ROOT, SAMPLE_DIR } from './config.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BUILD_DIR = path.join(ROOT, 'build-validation');
const RUN_SPRINT = path.join(__dirname, 'run-sprint.mjs');
const REPORT = path.join(OUT_DIR, 'validation', 'validation_report.json');
const UPLOAD_DIR = path.join(ROOT, 'outputs', 'validation-sprint', '_uploads');
const PROGRESS = path.join(OUT_DIR, 'logs', 'progress.json');
const RUN_L1B = path.join(ROOT, 'scripts', 'l1b', 'run-l1b.mjs');
const MULTILOGUE_OUT = path.join(ROOT, 'outputs', 'multilogue-validation');
const L1B_OUT = path.join(ROOT, 'outputs', 'l1b');
const L1B_PROGRESS = path.join(L1B_OUT, 'progress.json');
const L1B_LATEST = path.join(L1B_OUT, 'latest.json');
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
let currentL1bRun = null;
let currentL1bFinalize = null;
let currentMultilogueV2Run = null;

function send(res, code, body, type = 'application/json') {
  res.writeHead(code, { 'Content-Type': type, 'Access-Control-Allow-Origin': '*' });
  res.end(body);
}
function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
  });
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
  const normalized = value.replace(/\\/g, '/');
  for (const marker of ['/sample/', '/outputs/', '/scripts/', '/tests/', '/build-validation/']) {
    const index = normalized.indexOf(marker);
    if (index >= 0) return path.join(ROOT, ...normalized.slice(index + 1).split('/'));
  }
  return value;
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
    const inputs = Array.isArray(handoff?.inputs) ? handoff.inputs : [];
    const filesReady = inputs.length > 0 && inputs.every((input) => fs.existsSync(rebaseRepoPath(input.wav)) && fs.existsSync(rebaseRepoPath(input.invalid_intervals_tsv)));
    const source = rebaseRepoPath(manifest.source_audio || file);
    return {
      path: file,
      name: path.basename(file),
      recording_id: sanitize(path.basename(source, path.extname(source))),
      source_audio: path.basename(source),
      generated_at: manifest.generated_at || fs.statSync(file).mtime.toISOString(),
      duration_seconds: manifest.duration_seconds,
      source: manifest.source,
      overlap: manifest.overlap || null,
      ready: !!handoff?.ready && filesReady,
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

function listL1aRuns() {
  return walkFiles(MULTILOGUE_OUT)
    .filter((file) => /phase1_manifest\.json$/i.test(file))
    .map(l1aManifestSummary)
    .filter(Boolean)
    .sort((a, b) => String(b.generated_at).localeCompare(String(a.generated_at)));
}

function latestL1bContext() {
  try {
    const pointer = JSON.parse(fs.readFileSync(L1B_LATEST, 'utf8'));
    const reportPath = path.resolve(rebaseRepoPath(pointer.report || ''));
    if (!reportPath.startsWith(path.resolve(L1B_OUT)) || !fs.existsSync(reportPath)) return null;
    return { reportPath, outDir: path.dirname(reportPath), report: JSON.parse(fs.readFileSync(reportPath, 'utf8')) };
  } catch {
    return null;
  }
}

function readLatestL1bReport() {
  const context = latestL1bContext();
  return context ? JSON.stringify(rebaseReportPaths(context.report)) : null;
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
  if (!context || context.report.status !== 'ready_for_praat_review') return null;
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
    if (currentRun && currentRun.running) return send(res, 409, JSON.stringify({ error: 'a run is already in progress' }));
    const body = JSON.parse((await readBody(req)).toString() || '{}');
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
    if (missing.length) return send(res, 400, JSON.stringify({ error: `missing inputs for Phase ${phase}: ${missing.join(', ')}`, missing }));
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
    child.on('exit', () => { currentRun.running = false; });
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
    const selected = runs.find((run) => run.ready) || runs[0] || null;
    return send(res, 200, JSON.stringify({ ready: !!selected?.ready, selected, runs }));
  }

  // ---- start deterministic L1b Praat extraction from a Phase-I manifest ----
  if (u.pathname === '/api/l1b/run' && req.method === 'POST') {
    if (currentL1bRun?.running) return send(res, 409, JSON.stringify({ error: 'an L1b run is already in progress' }));
    const body = JSON.parse((await readBody(req)).toString() || '{}');
    const runs = listL1aRuns();
    const fallback = runs.find((run) => run.ready);
    const requested = path.resolve(body.manifest || fallback?.path || '');
    if (!requested.startsWith(path.resolve(MULTILOGUE_OUT)) || !fs.existsSync(requested)) {
      return send(res, 400, JSON.stringify({ error: 'no valid L1a Phase-I manifest is available' }));
    }
    const chosen = l1aManifestSummary(requested);
    if (!chosen?.ready) return send(res, 400, JSON.stringify({ error: 'selected L1a handoff is not ready' }));

    const thresholds = [...new Set((Array.isArray(body.thresholds) ? body.thresholds : [0.25, 0.35])
      .map(Number).filter((value) => value > 0 && value < 5))].sort((a, b) => a - b);
    if (!thresholds.length) return send(res, 400, JSON.stringify({ error: 'at least one valid threshold is required' }));

    const runId = `run-${new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').replace('Z', '')}`;
    const out = path.join(L1B_OUT, chosen.recording_id, runId);
    fs.mkdirSync(L1B_OUT, { recursive: true });
    fs.writeFileSync(L1B_PROGRESS, JSON.stringify({ done: false, status: 'starting', jobs: [], updated_at: new Date().toISOString() }));
    const args = [RUN_L1B, '--manifest', requested, '--out', out, '--thresholds', thresholds.join(','), '--progress', L1B_PROGRESS, '--latest-pointer', L1B_LATEST];
    const child = spawn('node', args, { cwd: ROOT, env: { ...process.env }, stdio: 'ignore' });
    currentL1bRun = { child, running: true, out, manifest: requested };
    child.on('exit', () => { currentL1bRun.running = false; });
    return send(res, 200, JSON.stringify({ ok: true, started: true, run_id: runId, recording_id: chosen.recording_id, thresholds }));
  }

  if (u.pathname === '/api/l1b/status') {
    if (!fs.existsSync(L1B_PROGRESS)) return send(res, 200, JSON.stringify({ idle: true, done: false, status: 'idle', jobs: [] }));
    return send(res, 200, fs.readFileSync(L1B_PROGRESS));
  }

  if (u.pathname === '/api/l1b/report') {
    const report = readLatestL1bReport();
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
    const p = path.resolve(u.searchParams.get('path') || '');
    if (!p.startsWith(path.resolve(L1B_OUT)) || !fs.existsSync(p)) return send(res, 404, 'forbidden', 'text/plain');
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

  serveStatic(res, u.pathname);
});

server.listen(PORT, () => console.log(`Validation console at http://localhost:${PORT}  (build: ${BUILD_DIR})`));
