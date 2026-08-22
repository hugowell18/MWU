#!/usr/bin/env node

import { existsSync, mkdirSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { basename, extname, resolve } from 'node:path';
import {
  compareDiarizations,
  readJson,
  readWavForMuting,
  renderDiarizationComparisonMarkdown,
  sanitizeName,
  turnsFromAssemblyAi,
  turnsFromPyannoteJson,
  writeJson,
  writePhase1Artifacts,
} from './phase1/lib/diarization-artifacts.mjs';

const DEFAULT_API_BASE_URL = 'https://api.pyannote.ai';
const EXIT_MISSING_KEY = 22;
let activeLogPath = null;

function loadEnv(envPath = '.env') {
  const p = resolve(envPath);
  if (!existsSync(p)) return;
  for (const line of readFileSync(p, 'utf8').split(/\r?\n/)) {
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

function parseArgs(argv) {
  const args = {
    audio: '',
    uploadAudio: '',
    uploadMethod: 'node',
    audioUrl: '',
    outDir: '',
    prefix: '',
    speakers: null,
    minSpeakers: null,
    maxSpeakers: null,
    model: 'community-1',
    pollMs: 10000,
    timeoutMs: 30 * 60 * 1000,
    apiKeyEnv: 'PYANNOTE_API_KEY',
    apiBaseUrl: process.env.PYANNOTE_API_BASE_URL || DEFAULT_API_BASE_URL,
    dotenvFile: '.env',
    objectKey: '',
    mockJobJson: '',
    compareAssemblyAiJson: '',
    compareOutput: '',
    compareFrameMs: 100,
    durationSeconds: null,
    artifactDiarization: 'diarization',
    turnLevelConfidence: false,
    exclusive: false,
    confidence: false,
    transcription: false,
  };

  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === '--audio' && next) {
      args.audio = next;
      i += 1;
    } else if (arg === '--upload-audio' && next) {
      args.uploadAudio = next;
      i += 1;
    } else if (arg === '--upload-method' && next) {
      args.uploadMethod = next;
      i += 1;
    } else if (arg === '--audio-url' && next) {
      args.audioUrl = next;
      i += 1;
    } else if (arg === '--out-dir' && next) {
      args.outDir = next;
      i += 1;
    } else if (arg === '--prefix' && next) {
      args.prefix = next;
      i += 1;
    } else if (arg === '--speakers' && next) {
      args.speakers = Number(next);
      i += 1;
    } else if (arg === '--min-speakers' && next) {
      args.minSpeakers = Number(next);
      i += 1;
    } else if (arg === '--max-speakers' && next) {
      args.maxSpeakers = Number(next);
      i += 1;
    } else if (arg === '--model' && next) {
      args.model = next;
      i += 1;
    } else if (arg === '--poll-ms' && next) {
      args.pollMs = Number(next);
      i += 1;
    } else if (arg === '--timeout-ms' && next) {
      args.timeoutMs = Number(next);
      i += 1;
    } else if (arg === '--api-key-env' && next) {
      args.apiKeyEnv = next;
      i += 1;
    } else if (arg === '--api-base-url' && next) {
      args.apiBaseUrl = next;
      i += 1;
    } else if (arg === '--dotenv-file' && next) {
      args.dotenvFile = next;
      i += 1;
    } else if (arg === '--object-key' && next) {
      args.objectKey = next;
      i += 1;
    } else if (arg === '--mock-job-json' && next) {
      args.mockJobJson = next;
      i += 1;
    } else if (arg === '--compare-assemblyai-json' && next) {
      args.compareAssemblyAiJson = next;
      i += 1;
    } else if (arg === '--compare-output' && next) {
      args.compareOutput = next;
      i += 1;
    } else if (arg === '--compare-frame-ms' && next) {
      args.compareFrameMs = Number(next);
      i += 1;
    } else if (arg === '--duration-seconds' && next) {
      args.durationSeconds = Number(next);
      i += 1;
    } else if (arg === '--artifact-diarization' && next) {
      args.artifactDiarization = next;
      i += 1;
    } else if (arg === '--turn-level-confidence') {
      args.turnLevelConfidence = true;
    } else if (arg === '--no-turn-level-confidence') {
      args.turnLevelConfidence = false;
    } else if (arg === '--exclusive') {
      args.exclusive = true;
    } else if (arg === '--no-exclusive') {
      args.exclusive = false;
    } else if (arg === '--confidence') {
      args.confidence = true;
    } else if (arg === '--transcription') {
      args.transcription = true;
    } else if (arg === '--help' || arg === '-h') {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`Unknown or incomplete argument: ${arg}`);
    }
  }

  if (!args.audio) throw new Error('--audio is required because muted-mirror WAV generation needs the local source audio');
  if (!args.outDir) throw new Error('--out-dir is required');
  if (!/^https?:\/\//.test(args.apiBaseUrl)) throw new Error('--api-base-url must start with http:// or https://');
  if (!['node', 'curl'].includes(args.uploadMethod)) throw new Error('--upload-method must be node or curl');
  if (!['diarization', 'exclusiveDiarization'].includes(args.artifactDiarization)) {
    throw new Error('--artifact-diarization must be diarization or exclusiveDiarization');
  }
  for (const key of ['speakers', 'minSpeakers', 'maxSpeakers', 'pollMs', 'timeoutMs', 'compareFrameMs', 'durationSeconds']) {
    if (args[key] != null && !Number.isFinite(args[key])) throw new Error(`--${key} must be a number`);
  }
  return args;
}

function printHelp() {
  console.log(`Usage:
  node scripts/phase1-pyannote-remote.mjs --audio <wav> --out-dir <dir> [options]

Remote provider:
  Uses pyannoteAI Media API + Diarize API. Set PYANNOTE_API_KEY in .env.

Options:
  --audio <path>               Local audio file; uploaded via pyannoteAI Media API.
  --upload-audio <path>        Optional smaller audio for remote upload. --audio remains the local source for muted mirrors.
  --upload-method <node|curl>  Media API presigned upload method. Default: node.
  --audio-url <url>            Public/signed URL or media:// key; skips upload, but --audio is still required for muted mirrors.
  --model <community-1|precision-2>
                               Default: community-1.
  --speakers <n>               Optional exact speaker-count constraint.
  --min-speakers <n>           Optional minSpeakers.
  --max-speakers <n>           Optional maxSpeakers.
  --poll-ms <ms>               Polling interval. Default: 10000.
  --api-key-env <name>         Env var for API key. Default: PYANNOTE_API_KEY.
  --api-base-url <url>         pyannoteAI API base URL. Default: https://api.pyannote.ai.
  --dotenv-file <path>         Local dotenv file to load. Default: .env.
  --object-key <key>           media:// object key. Default generated from prefix/time.
  --mock-job-json <path>       Test mode: use a saved pyannoteAI job JSON, no network.
  --compare-assemblyai-json <path>
                              Optional AssemblyAI raw JSON reference. Writes a system-vs-system comparison after artifacts.
  --compare-output <path>      Optional comparison JSON path. Default: <out-dir>/<prefix>.assemblyai_vs_pyannote_remote.comparison.json.
  --compare-frame-ms <number>  Comparison frame size. Default: 100.
  --artifact-diarization <diarization|exclusiveDiarization>
                              pyannoteAI output key to convert into RTTM/TextGrid/muted mirrors. Default: diarization.
                              Keep default to preserve overlapping speech.
  --turn-level-confidence      Request turn-level confidence values. Usually Precision-2 only.
  --exclusive                  Request exclusiveDiarization output. Usually Precision-2 only; not used for artifacts unless selected.
  --confidence                 Request dense confidence output. Usually Precision-2 only.
  --transcription              Request pyannoteAI transcription output. Default off; ASR stays with AssemblyAI.
  --prefix <name>              Output filename prefix. Default: audio stem.
`);
}

function appendJsonl(file, event, payload = {}) {
  writeFileSync(file, `${JSON.stringify({ event, ts: new Date().toISOString(), ...payload })}\n`, { flag: 'a' });
}

function apiKeyFromEnv(name) {
  const value = process.env[name];
  if (!value || value.includes('paste_your')) return null;
  return value;
}

function apiUrl(baseUrl, pathname) {
  return `${String(baseUrl).replace(/\/+$/, '')}${pathname}`;
}

async function parseJsonResponse(response, context) {
  const text = await response.text();
  let body;
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    body = { raw: text };
  }
  if (!response.ok) {
    const message = body?.message || body?.error || JSON.stringify(body);
    throw new Error(`${context} failed with HTTP ${response.status}: ${message}`);
  }
  return body;
}

async function createMediaInput({ apiKey, apiBaseUrl, objectKey, logPath }) {
  appendJsonl(logPath, 'media_create_start', { object_key: objectKey });
  const response = await fetch(apiUrl(apiBaseUrl, '/v1/media/input'), {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ url: `media://${objectKey}` }),
  });
  const body = await parseJsonResponse(response, 'Create media input');
  if (!body.url) throw new Error(`Create media input response missing presigned url: ${JSON.stringify(body)}`);
  appendJsonl(logPath, 'media_create_done', { object_key: objectKey });
  return body.url;
}

async function uploadAudioToPresignedUrl({ presignedUrl, audioPath, uploadMethod, logPath }) {
  const stats = statSync(audioPath);
  const host = new URL(presignedUrl).host;
  appendJsonl(logPath, 'media_upload_start', { audio: audioPath, bytes: stats.size, method: uploadMethod, host });
  if (uploadMethod === 'curl') {
    const result = spawnSync('curl', [
      '-sS',
      '-o',
      '/dev/null',
      '-w',
      '%{http_code}',
      '-H',
      'Expect:',
      '-X',
      'PUT',
      '--data-binary',
      `@${audioPath}`,
      presignedUrl,
    ], {
      encoding: 'utf8',
      timeout: 5 * 60 * 1000,
      maxBuffer: 1024 * 1024,
    });
    const httpStatus = result.stdout.trim();
    if (result.error) throw result.error;
    if (result.status !== 0 || httpStatus !== '200') {
      throw new Error(`Media upload via curl failed: exit=${result.status} http=${httpStatus || 'n/a'} stderr=${result.stderr.slice(0, 500)}`);
    }
    appendJsonl(logPath, 'media_upload_done', { audio: audioPath, bytes: stats.size, method: uploadMethod, host });
    return;
  }

  const response = await fetch(presignedUrl, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/octet-stream',
      'Content-Length': String(stats.size),
    },
    body: readFileSync(audioPath),
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Media upload failed with HTTP ${response.status}: ${text.slice(0, 500)}`);
  }
  appendJsonl(logPath, 'media_upload_done', { audio: audioPath, bytes: stats.size, method: uploadMethod, host });
}

function buildDiarizePayload(args, url) {
  const payload = {
    url,
    model: args.model,
  };
  if (args.turnLevelConfidence) payload.turnLevelConfidence = true;
  if (args.exclusive) payload.exclusive = true;
  if (args.confidence) payload.confidence = true;
  if (args.transcription) payload.transcription = true;
  if (args.speakers) payload.numSpeakers = args.speakers;
  if (args.minSpeakers) payload.minSpeakers = args.minSpeakers;
  if (args.maxSpeakers) payload.maxSpeakers = args.maxSpeakers;
  return payload;
}

async function submitDiarization({ apiKey, apiBaseUrl, payload, logPath }) {
  appendJsonl(logPath, 'diarize_submit_start', {
    model: payload.model,
    numSpeakers: payload.numSpeakers,
    url_kind: String(payload.url).startsWith('media://') ? 'media' : 'url',
  });
  const response = await fetch(apiUrl(apiBaseUrl, '/v1/diarize'), {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });
  const body = await parseJsonResponse(response, 'Submit diarization');
  if (!body.jobId) throw new Error(`Diarization response missing jobId: ${JSON.stringify(body)}`);
  appendJsonl(logPath, 'diarize_submit_done', { job_id: body.jobId, status: body.status, warning: body.warning });
  return body;
}

async function pollJob({ apiKey, apiBaseUrl, jobId, pollMs, timeoutMs, logPath }) {
  const started = Date.now();
  let attempt = 0;
  while (true) {
    attempt += 1;
    const response = await fetch(apiUrl(apiBaseUrl, `/v1/jobs/${jobId}`), {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    const body = await parseJsonResponse(response, 'Poll job');
    appendJsonl(logPath, 'job_poll', { attempt, job_id: jobId, status: body.status });
    if (body.status === 'succeeded') return body;
    if (['failed', 'canceled'].includes(body.status)) {
      throw new Error(`pyannoteAI job ${body.status}: ${JSON.stringify(body)}`);
    }
    if (Date.now() - started > timeoutMs) {
      throw new Error(`pyannoteAI job timeout after ${timeoutMs}ms: ${jobId}`);
    }
    await new Promise((resolveDone) => setTimeout(resolveDone, pollMs));
  }
}

function turnsFromPyannoteJob(job, artifactDiarization = 'diarization') {
  const output = job.output ?? job;
  const candidates = {
    diarization: output.diarization || output.speakerDiarization,
    exclusiveDiarization: output.exclusiveDiarization,
  };
  const fallbackKey = artifactDiarization === 'diarization' ? 'exclusiveDiarization' : 'diarization';
  const diarization = candidates[artifactDiarization] || candidates[fallbackKey] || [];
  if (!Array.isArray(diarization)) {
    throw new Error(`pyannoteAI job output missing diarization array: ${JSON.stringify(job).slice(0, 1000)}`);
  }
  return {
    source: 'pyannoteai',
    source_diarization_key: candidates[artifactDiarization] ? artifactDiarization : fallbackKey,
    job_id: job.jobId ?? null,
    status: job.status ?? 'succeeded',
    turns: diarization.map((turn, index) => ({
      index: index + 1,
      speaker: turn.speaker ?? turn.label,
      start: turn.start,
      end: turn.end,
      confidence: turn.confidence ?? turn.confidenceScore ?? null,
      source: 'pyannoteai',
    })),
  };
}

async function main() {
  const args = parseArgs(process.argv);
  loadEnv(args.dotenvFile);
  const audioPath = args.audio ? resolve(args.audio) : '';
  if (audioPath && !existsSync(audioPath)) throw new Error(`Audio file does not exist: ${audioPath}`);
  const uploadAudioPath = args.uploadAudio ? resolve(args.uploadAudio) : audioPath;
  if (uploadAudioPath && !existsSync(uploadAudioPath)) throw new Error(`Upload audio file does not exist: ${uploadAudioPath}`);
  const outDir = resolve(args.outDir);
  mkdirSync(outDir, { recursive: true });

  const baseName = audioPath ? basename(audioPath, extname(audioPath)) : 'pyannote_remote_audio';
  const prefix = sanitizeName(args.prefix || baseName);
  const logPath = path.join(outDir, `${prefix}.pyannote_remote.log.jsonl`);
  activeLogPath = logPath;
  writeFileSync(logPath, '', 'utf8');
  appendJsonl(logPath, 'start', {
    provider: 'pyannoteai',
    model: args.model,
    audio: audioPath || null,
    upload_audio: args.audioUrl ? null : uploadAudioPath,
    upload_method: args.audioUrl ? null : args.uploadMethod,
    audio_url: args.audioUrl ? '[provided]' : null,
    speakers: args.speakers,
    api_base_url: args.apiBaseUrl,
    artifact_diarization: args.artifactDiarization,
    mock: Boolean(args.mockJobJson),
  });

  let duration = args.durationSeconds;
  if (duration == null) duration = readWavForMuting(audioPath).durationSeconds;

  const rawJobPath = path.join(outDir, `${prefix}.pyannote.remote.raw_job.json`);
  const rawTurnsPath = path.join(outDir, `${prefix}.pyannote.remote.raw_turns.json`);
  let job;

  if (args.mockJobJson) {
    const mockPath = resolve(args.mockJobJson);
    if (!existsSync(mockPath)) throw new Error(`Mock job JSON does not exist: ${mockPath}`);
    appendJsonl(logPath, 'mock_job_load', { path: mockPath });
    job = readJson(mockPath);
  } else {
    const apiKey = apiKeyFromEnv(args.apiKeyEnv);
    if (!apiKey) {
      appendJsonl(logPath, 'error', {
        kind: 'missing_api_key',
        message: `Set ${args.apiKeyEnv} in .env to use pyannoteAI remote diarization.`,
      });
      process.exitCode = EXIT_MISSING_KEY;
      console.error(`Missing ${args.apiKeyEnv}. Put it in .env to use pyannoteAI remote diarization.`);
      return;
    }
    let diarizeUrl = args.audioUrl;
    if (!diarizeUrl) {
      const objectKey = args.objectKey || `mwu/${prefix}-${Date.now()}.wav`;
      const presignedUrl = await createMediaInput({ apiKey, apiBaseUrl: args.apiBaseUrl, objectKey, logPath });
      await uploadAudioToPresignedUrl({ presignedUrl, audioPath: uploadAudioPath, uploadMethod: args.uploadMethod, logPath });
      diarizeUrl = `media://${objectKey}`;
    }
    const payload = buildDiarizePayload(args, diarizeUrl);
    writeJson(path.join(outDir, `${prefix}.pyannote.remote.request.json`), {
      ...payload,
      url: String(payload.url).startsWith('media://') ? payload.url : '[redacted/provided-url]',
    });
    const submitted = await submitDiarization({ apiKey, apiBaseUrl: args.apiBaseUrl, payload, logPath });
    job = await pollJob({
      apiKey,
      apiBaseUrl: args.apiBaseUrl,
      jobId: submitted.jobId,
      pollMs: args.pollMs,
      timeoutMs: args.timeoutMs,
      logPath,
    });
  }

  writeJson(rawJobPath, job);
  const turnsJson = turnsFromPyannoteJob(job, args.artifactDiarization);
  writeJson(rawTurnsPath, turnsJson);
  const turns = turnsFromPyannoteJson(turnsJson, duration);
  const { manifestPath, manifest } = writePhase1Artifacts({
    turns,
    audioPath,
    outDir,
    prefix: `${prefix}.pyannote_remote`,
    source: 'pyannoteai_remote',
    method: {
      name: 'remote_pyannoteai_speaker_diarization',
      provider: 'pyannoteAI',
      model: args.model,
      artifact_diarization: turnsJson.source_diarization_key,
      request_options: {
        turnLevelConfidence: args.turnLevelConfidence,
        exclusive: args.exclusive,
        confidence: args.confidence,
        transcription: args.transcription,
      },
      note:
        'Remote diarization route. Local audio is uploaded to pyannoteAI Media API unless --audio-url is supplied. Outputs are converted locally into RTTM, speaker TextGrid, muted-mirror WAVs, and Phase II invalid-interval inputs. Default artifact conversion uses output.diarization to preserve overlapping speech.',
    },
    durationSeconds: duration,
  });
  appendJsonl(logPath, 'artifacts_done', { manifest: manifestPath, speakers: manifest.speakers });
  let comparisonPath = null;
  if (args.compareAssemblyAiJson) {
    const referencePath = resolve(args.compareAssemblyAiJson);
    if (!existsSync(referencePath)) throw new Error(`AssemblyAI comparison JSON does not exist: ${referencePath}`);
    comparisonPath =
      args.compareOutput
        ? resolve(args.compareOutput)
        : path.join(outDir, `${prefix}.assemblyai_vs_pyannote_remote.comparison.json`);
    const report = {
      generated_at: new Date().toISOString(),
      reference_source: referencePath,
      candidate_source: rawTurnsPath,
      ...compareDiarizations(turnsFromAssemblyAi(readJson(referencePath), duration), turns, {
        duration,
        frameMs: args.compareFrameMs,
      }),
    };
    writeJson(comparisonPath, report);
    const comparisonMarkdownPath = comparisonPath.replace(/\.json$/i, '.md');
    writeFileSync(comparisonMarkdownPath, renderDiarizationComparisonMarkdown(report), 'utf8');
    appendJsonl(logPath, 'comparison_done', {
      comparison: comparisonPath,
      markdown: comparisonMarkdownPath,
      exact_label_frame_agreement: report.agreement.exact_label_frame_agreement,
      speech_activity_agreement: report.agreement.speech_activity_agreement,
      speaker_agreement_when_both_speech: report.agreement.speaker_agreement_when_both_speech,
    });
  }
  console.log(`Wrote manifest: ${manifestPath}`);
  console.log(JSON.stringify({
    duration_seconds: manifest.duration_seconds,
    speakers: manifest.speakers,
    utterance_count: manifest.utterance_count,
    phase_ii_ready: manifest.phase_ii_handoff.ready,
    raw_job: rawJobPath,
    raw_turns: rawTurnsPath,
    comparison: comparisonPath,
    log: logPath,
  }, null, 2));
}

main().catch((error) => {
  if (activeLogPath) {
    try {
      appendJsonl(activeLogPath, 'error', {
        kind: 'runtime_error',
        message: error.message,
      });
    } catch {
      // Keep stderr as the final fallback if the log path itself is unavailable.
    }
  }
  console.error(error.message);
  process.exitCode = 1;
});
