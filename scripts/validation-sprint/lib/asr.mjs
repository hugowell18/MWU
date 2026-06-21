// Real speech recognition for Phase III validation — AssemblyAI (reuses the repo's proven flow).
// Used to produce an INDEPENDENT transcript of the .wav, then compare it to the client's standard.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const BASE_URL = 'https://api.assemblyai.com';

export function loadEnv(envPath = '.env') {
  const p = path.resolve(envPath);
  if (!fs.existsSync(p)) return;
  for (const line of fs.readFileSync(p, 'utf8').split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const i = t.indexOf('=');
    if (i === -1) continue;
    const k = t.slice(0, i).trim();
    let v = t.slice(i + 1).trim();
    if (!k || process.env[k] != null) continue;
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    process.env[k] = v;
  }
}

export function getApiKey() {
  loadEnv();
  const k = process.env.ASSEMBLYAI_API_KEY;
  if (!k || k.includes('paste_your')) return null;
  return k;
}

async function parseJson(res, ctx) {
  const text = await res.text();
  let body;
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    body = { raw: text };
  }
  if (!res.ok) throw new Error(`${ctx} HTTP ${res.status}: ${JSON.stringify(body).slice(0, 300)}`);
  return body;
}

function uploadWithCurl(wav, key) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aai-up-'));
  const cfg = path.join(dir, 'curl.conf');
  const esc = (s) => String(s).replaceAll('\\', '\\\\').replaceAll('"', '\\"');
  try {
    fs.writeFileSync(cfg, [`url = "${BASE_URL}/v2/upload"`, 'request = POST', `header = "authorization: ${esc(key)}"`, 'header = "Content-Type: application/octet-stream"', `data-binary = "@${esc(wav)}"`, 'http1.1', 'silent', 'show-error', 'fail-with-body'].join('\n') + '\n', { mode: 0o600 });
    const r = spawnSync('curl', ['--config', cfg], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    if (r.status !== 0) throw new Error(`curl upload exit ${r.status}: ${r.stderr || r.stdout}`);
    return JSON.parse(r.stdout);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// Compress to a small mp3 before upload (same speech → same transcript, but a tiny upload).
function compressForUpload(wav, log) {
  try {
    const out = path.join(os.tmpdir(), `sprint-asr-${process.pid}-${Date.now()}.mp3`);
    const r = spawnSync('ffmpeg', ['-y', '-i', wav, '-ac', '1', '-ar', '16000', '-b:a', '64k', out], { encoding: 'utf8' });
    if (r.status === 0 && fs.existsSync(out)) {
      if (log) log(`compressed to mp3 (${(fs.statSync(out).size / 1e6).toFixed(2)} MB) for upload`);
      return { path: out, cleanup: () => fs.rmSync(out, { force: true }) };
    }
  } catch {
    /* ffmpeg missing → upload original */
  }
  return { path: wav, cleanup: () => {} };
}

async function uploadAudio(wav, key) {
  let body;
  try {
    const res = await fetch(`${BASE_URL}/v2/upload`, {
      method: 'POST',
      headers: { authorization: key, 'Content-Type': 'application/octet-stream', 'Content-Length': String(fs.statSync(wav).size) },
      body: fs.readFileSync(wav),
    });
    body = await parseJson(res, 'Upload');
  } catch {
    body = uploadWithCurl(wav, key);
  }
  if (!body.upload_url) throw new Error('upload returned no upload_url');
  return body.upload_url;
}

async function submit(uploadUrl, key, models) {
  const res = await fetch(`${BASE_URL}/v2/transcript`, {
    method: 'POST',
    headers: { authorization: key, 'Content-Type': 'application/json' },
    // disfluencies:true keeps uh/um etc. so RAW-TIMING is truly verbatim (TIDY then removes them).
    body: JSON.stringify({ audio_url: uploadUrl, speech_models: models, language_code: 'en', speaker_labels: false, disfluencies: true }),
  });
  const body = await parseJson(res, 'Submit');
  if (!body.id) throw new Error('submit returned no id');
  return body.id;
}

async function poll(id, key, pollMs, log) {
  for (let n = 1; ; n++) {
    const res = await fetch(`${BASE_URL}/v2/transcript/${id}`, { headers: { authorization: key } });
    const body = await parseJson(res, 'Poll');
    if (log) log(`[asr poll ${n}] ${body.status}`);
    if (body.status === 'completed') return body;
    if (body.status === 'error') throw new Error(`AssemblyAI error: ${body.error}`);
    await new Promise((r) => setTimeout(r, pollMs));
  }
}

// Transcribe a wav with AssemblyAI → { text, words, audio_duration, confidence, id }
export async function transcribe(wav, { apiKey, models = ['universal-3-pro', 'universal-2'], pollMs = 3000, log } = {}) {
  if (!apiKey) throw new Error('no ASSEMBLYAI_API_KEY');
  const compact = compressForUpload(wav, log);
  let uploadUrl;
  try {
    uploadUrl = await uploadAudio(compact.path, apiKey);
  } finally {
    compact.cleanup();
  }
  if (log) log('uploaded to AssemblyAI');
  const id = await submit(uploadUrl, apiKey, models);
  if (log) log(`transcript submitted: ${id}`);
  const r = await poll(id, apiKey, pollMs, log);
  return { id: r.id, text: r.text || '', words: r.words || [], audio_duration: r.audio_duration, confidence: r.confidence, model: (r.speech_model || models[0]) };
}
