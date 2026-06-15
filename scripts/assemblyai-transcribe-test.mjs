#!/usr/bin/env node

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { basename, extname, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const BASE_URL = "https://api.assemblyai.com";
const DEFAULT_AUDIO = "sample-inputs/AMI_ES2002a_Mix-Headset_10min.wav";
const DEFAULT_OUT_DIR = "sample-inputs/assemblyai";

function loadLocalEnv(envPath = ".env") {
  const resolvedEnvPath = resolve(envPath);
  if (!existsSync(resolvedEnvPath)) return;

  const lines = readFileSync(resolvedEnvPath, "utf8").split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    const separatorIndex = trimmed.indexOf("=");
    if (separatorIndex === -1) continue;

    const key = trimmed.slice(0, separatorIndex).trim();
    let value = trimmed.slice(separatorIndex + 1).trim();
    if (!key || process.env[key] != null) continue;

    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  }
}

function parseArgs(argv) {
  const args = {
    audio: DEFAULT_AUDIO,
    outDir: DEFAULT_OUT_DIR,
    speakersExpected: 3,
    pollMs: 3000,
    model: "universal-3-pro",
    fallbackModel: "universal-2",
  };

  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === "--audio" && next) {
      args.audio = next;
      i += 1;
    } else if (arg === "--out-dir" && next) {
      args.outDir = next;
      i += 1;
    } else if (arg === "--speakers" && next) {
      args.speakersExpected = Number(next);
      i += 1;
    } else if (arg === "--poll-ms" && next) {
      args.pollMs = Number(next);
      i += 1;
    } else if (arg === "--model" && next) {
      args.model = next;
      i += 1;
    } else if (arg === "--fallback-model" && next) {
      args.fallbackModel = next;
      i += 1;
    } else if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`Unknown or incomplete argument: ${arg}`);
    }
  }

  if (!Number.isFinite(args.speakersExpected) || args.speakersExpected < 1) {
    throw new Error("--speakers must be a positive number");
  }
  if (!Number.isFinite(args.pollMs) || args.pollMs < 1000) {
    throw new Error("--poll-ms must be at least 1000");
  }
  return args;
}

function printHelp() {
  console.log(`Usage:
  ASSEMBLYAI_API_KEY=... node scripts/assemblyai-transcribe-test.mjs [options]

Options:
  --audio <path>            Audio file path. Default: ${DEFAULT_AUDIO}
  --out-dir <path>          Output directory. Default: ${DEFAULT_OUT_DIR}
  --speakers <number>       Expected speaker count. Default: 3
  --model <name>            Primary AssemblyAI model. Default: universal-3-pro
  --fallback-model <name>   Fallback model. Default: universal-2
  --poll-ms <ms>            Poll interval. Default: 3000
`);
}

function requireApiKey() {
  const apiKey = process.env.ASSEMBLYAI_API_KEY;
  if (!apiKey || apiKey.includes("paste_your")) {
    throw new Error("Missing ASSEMBLYAI_API_KEY. Put it in .env or export it in your shell.");
  }
  return apiKey;
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
    throw new Error(`${context} failed with HTTP ${response.status}: ${JSON.stringify(body)}`);
  }
  return body;
}

async function uploadAudio(audioPath, apiKey) {
  const stats = statSync(audioPath);
  const audioBuffer = readFileSync(audioPath);
  let body;

  try {
    const response = await fetch(`${BASE_URL}/v2/upload`, {
      method: "POST",
      headers: {
        authorization: apiKey,
        "Content-Type": "application/octet-stream",
        "Content-Length": String(stats.size),
      },
      body: audioBuffer,
    });
    body = await parseJsonResponse(response, "Upload");
  } catch (error) {
    console.warn(`Node upload failed (${error.cause?.message ?? error.message}); retrying with curl.`);
    body = uploadAudioWithCurl(audioPath, apiKey);
  }

  if (!body.upload_url) {
    throw new Error(`Upload response did not include upload_url: ${JSON.stringify(body)}`);
  }
  return body.upload_url;
}

function curlConfigValue(value) {
  return String(value).replaceAll("\\", "\\\\").replaceAll('"', '\\"');
}

function uploadAudioWithCurl(audioPath, apiKey) {
  const tempDir = mkdtempSync(path.join(tmpdir(), "assemblyai-upload-"));
  const configPath = path.join(tempDir, "curl.conf");
  const config = [
    `url = "${BASE_URL}/v2/upload"`,
    "request = POST",
    `header = "authorization: ${curlConfigValue(apiKey)}"`,
    'header = "Content-Type: application/octet-stream"',
    `data-binary = "@${curlConfigValue(audioPath)}"`,
    "silent",
    "show-error",
    "fail-with-body",
  ].join("\n");

  try {
    writeFileSync(configPath, `${config}\n`, { encoding: "utf8", mode: 0o600 });
    const result = spawnSync("curl", ["--config", configPath], {
      encoding: "utf8",
      maxBuffer: 10 * 1024 * 1024,
    });

    if (result.error) {
      throw result.error;
    }
    if (result.status !== 0) {
      throw new Error(`curl upload failed with exit ${result.status}: ${result.stderr || result.stdout}`);
    }

    try {
      return JSON.parse(result.stdout);
    } catch {
      throw new Error(`curl upload returned non-JSON response: ${result.stdout.slice(0, 500)}`);
    }
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

async function submitTranscript(uploadUrl, apiKey, config) {
  const speechModels = [config.model];
  if (config.fallbackModel && config.fallbackModel !== config.model) {
    speechModels.push(config.fallbackModel);
  }

  const payload = {
    audio_url: uploadUrl,
    speech_models: speechModels,
    language_code: "en",
    speaker_labels: true,
    speakers_expected: config.speakersExpected,
  };

  const response = await fetch(`${BASE_URL}/v2/transcript`, {
    method: "POST",
    headers: {
      authorization: apiKey,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });
  const body = await parseJsonResponse(response, "Transcript submit");
  if (!body.id) {
    throw new Error(`Transcript submit response did not include id: ${JSON.stringify(body)}`);
  }
  return { transcriptId: body.id, payload };
}

async function pollTranscript(transcriptId, apiKey, pollMs) {
  const endpoint = `${BASE_URL}/v2/transcript/${transcriptId}`;
  let attempt = 0;

  while (true) {
    attempt += 1;
    const response = await fetch(endpoint, {
      headers: { authorization: apiKey },
    });
    const body = await parseJsonResponse(response, "Transcript poll");
    const status = body.status ?? "unknown";
    console.log(`[poll ${attempt}] status=${status}`);

    if (status === "completed") return body;
    if (status === "error") {
      throw new Error(`AssemblyAI transcription failed: ${body.error ?? "unknown error"}`);
    }

    await new Promise((resolveDone) => setTimeout(resolveDone, pollMs));
  }
}

function summarizeResult(result) {
  const utterances = Array.isArray(result.utterances) ? result.utterances : [];
  const words = Array.isArray(result.words) ? result.words : [];
  const speakers = new Set();
  for (const utterance of utterances) {
    if (utterance.speaker != null) speakers.add(String(utterance.speaker));
  }

  return {
    id: result.id,
    status: result.status,
    audio_duration: result.audio_duration,
    language_code: result.language_code,
    confidence: result.confidence,
    utterance_count: utterances.length,
    word_count: words.length,
    speakers: [...speakers].sort(),
    sample_utterances: utterances.slice(0, 8).map((utterance) => ({
      speaker: utterance.speaker,
      start_ms: utterance.start,
      end_ms: utterance.end,
      confidence: utterance.confidence,
      text: utterance.text,
    })),
  };
}

function writeOutputs(result, metadata, outDir, audioPath) {
  mkdirSync(outDir, { recursive: true });
  const stem = basename(audioPath, extname(audioPath));
  const rawPath = path.join(outDir, `${stem}.assemblyai.raw.json`);
  const summaryPath = path.join(outDir, `${stem}.assemblyai.summary.json`);

  const summary = {
    metadata,
    summary: summarizeResult(result),
  };

  writeFileSync(rawPath, `${JSON.stringify(result, null, 2)}\n`, "utf8");
  writeFileSync(summaryPath, `${JSON.stringify(summary, null, 2)}\n`, "utf8");

  return { rawPath, summaryPath, summary };
}

async function main() {
  loadLocalEnv();
  const args = parseArgs(process.argv);
  const apiKey = requireApiKey();
  const audioPath = resolve(args.audio);
  const outDir = resolve(args.outDir);

  if (!existsSync(audioPath)) {
    throw new Error(`Audio file does not exist: ${audioPath}`);
  }

  const stats = statSync(audioPath);
  console.log(`Audio: ${audioPath}`);
  console.log(`Size: ${(stats.size / 1024 / 1024).toFixed(2)} MB`);
  console.log(`Speakers expected: ${args.speakersExpected}`);
  console.log(`Models: ${args.model}${args.fallbackModel ? `, ${args.fallbackModel}` : ""}`);

  console.log("Uploading audio to AssemblyAI...");
  const uploadUrl = await uploadAudio(audioPath, apiKey);
  console.log("Upload complete.");

  console.log("Submitting transcription job...");
  const { transcriptId, payload } = await submitTranscript(uploadUrl, apiKey, args);
  console.log(`Transcript ID: ${transcriptId}`);

  console.log("Polling transcription job...");
  const result = await pollTranscript(transcriptId, apiKey, args.pollMs);

  const metadata = {
    provider: "assemblyai",
    created_at: new Date().toISOString(),
    audio_path: audioPath,
    output_dir: outDir,
    request_payload: {
      ...payload,
      audio_url: "[redacted upload_url]",
    },
  };
  const { rawPath, summaryPath, summary } = writeOutputs(result, metadata, outDir, audioPath);

  console.log("Done.");
  console.log(`Raw JSON: ${rawPath}`);
  console.log(`Summary JSON: ${summaryPath}`);
  console.log(JSON.stringify(summary.summary, null, 2));
}

main().catch((error) => {
  console.error(error.message);
  if (error.cause) {
    console.error(`Cause: ${error.cause.message ?? String(error.cause)}`);
  }
  process.exitCode = 1;
});
