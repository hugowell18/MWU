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
};

let currentRun = null; // { child, running }

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
    return send(res, 200, fs.readFileSync(REPORT));
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
