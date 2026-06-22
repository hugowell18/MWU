// AssemblyAI adapter for Phase III validation.
// Default behavior is a real AssemblyAI API run through the repo's shared script.
// Set ASSEMBLYAI_SOURCE=cache or cache-first only when an offline replay is needed.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../../..');
const TRANSCRIBE_SCRIPT = path.join(ROOT, 'scripts', 'assemblyai-transcribe-test.mjs');

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

function stemForAudio(wav) {
  return path.basename(wav, path.extname(wav));
}

function tokenCount(text) {
  return (String(text || '').match(/\S+/g) || []).length;
}

function normalizeResult(result, { source, path: sourcePath, fallbackModel = 'unknown' } = {}) {
  const text = result.text || '';
  const words = Array.isArray(result.words)
    ? result.words
    : Array.from({ length: Number(result.word_count) || tokenCount(text) }, () => ({}));
  return {
    id: result.id || null,
    text,
    words,
    audio_duration: result.audio_duration,
    confidence: result.confidence,
    model: result.speech_model || result.model || fallbackModel,
    source,
    source_path: sourcePath,
  };
}

function readJsonIfPresent(file) {
  if (!file || !fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function readCachedTranscript({ cacheJson, cacheText, cacheDir, wav, models }) {
  const candidates = [];
  if (cacheJson) candidates.push(cacheJson);
  if (cacheDir && wav) candidates.push(path.join(cacheDir, `${stemForAudio(wav)}.assemblyai.raw.json`));

  for (const file of candidates) {
    const json = readJsonIfPresent(file);
    if (json && json.text) return normalizeResult(json, { source: 'cached_assemblyai_json', path: file, fallbackModel: models?.[0] });
  }

  if (cacheText && fs.existsSync(cacheText)) {
    const text = fs.readFileSync(cacheText, 'utf8').trim();
    if (text) return normalizeResult({ text }, { source: 'cached_assemblyai_text', path: cacheText, fallbackModel: models?.[0] });
  }
  return null;
}

function runExistingAssemblyAiScript(wav, { apiKey, outDir, speakersExpected, pollMs, models, log }) {
  if (!apiKey) throw new Error('no ASSEMBLYAI_API_KEY');
  if (!fs.existsSync(TRANSCRIBE_SCRIPT)) throw new Error(`AssemblyAI script missing: ${TRANSCRIBE_SCRIPT}`);

  fs.mkdirSync(outDir, { recursive: true });
  const args = [
    TRANSCRIBE_SCRIPT,
    '--audio', wav,
    '--out-dir', outDir,
    '--speakers', String(speakersExpected),
    '--poll-ms', String(pollMs),
    '--model', models[0] || 'universal-3-pro',
  ];
  if (models[1]) args.push('--fallback-model', models[1]);

  const res = spawnSync(process.execPath, args, {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 10 * 60 * 1000,
    maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, ASSEMBLYAI_API_KEY: apiKey },
  });
  if (log && res.stdout) for (const line of res.stdout.trim().split(/\r?\n/).filter(Boolean)) log(`[assemblyai script] ${line}`);
  if (log && res.stderr) for (const line of res.stderr.trim().split(/\r?\n/).filter(Boolean)) log(`[assemblyai script stderr] ${line}`);
  if (res.error) throw res.error;
  if (res.status !== 0) throw new Error(`assemblyai script exit ${res.status}: ${res.stderr || res.stdout}`);

  const rawPath = path.join(outDir, `${stemForAudio(wav)}.assemblyai.raw.json`);
  const raw = readJsonIfPresent(rawPath);
  if (!raw || !raw.text) throw new Error(`assemblyai script did not write usable raw JSON: ${rawPath}`);
  return normalizeResult(raw, { source: 'assemblyai_api', path: rawPath, fallbackModel: models?.[0] });
}

// Transcribe a wav with AssemblyAI or reuse cached output when explicitly requested.
// Default: real provider run. ASSEMBLYAI_SOURCE=cache/cache-first enables offline replay.
export async function transcribe(wav, {
  apiKey,
  models = ['universal-3-pro', 'universal-2'],
  pollMs = 3000,
  speakersExpected = 1,
  cacheJson,
  cacheText,
  cacheDir,
  forceApi = false,
  log,
} = {}) {
  const sourceMode = process.env.ASSEMBLYAI_SOURCE || 'api';
  const preferCache = !forceApi && (sourceMode === 'cache' || sourceMode === 'cache-first');
  const outDir = cacheDir || path.join(path.dirname(cacheJson || wav), 'assemblyai-cache');

  if (preferCache) {
    const cached = readCachedTranscript({ cacheJson, cacheText, cacheDir: outDir, wav, models });
    if (cached) {
      if (log) log(`using cached AssemblyAI result: ${cached.source_path}`);
      return cached;
    }
    if (sourceMode === 'cache') throw new Error('no cached AssemblyAI result available');
  }

  if (log) log(`running existing AssemblyAI script: ${path.relative(ROOT, TRANSCRIBE_SCRIPT)}`);
  return runExistingAssemblyAiScript(wav, { apiKey, outDir, speakersExpected, pollMs, models, log });
}
