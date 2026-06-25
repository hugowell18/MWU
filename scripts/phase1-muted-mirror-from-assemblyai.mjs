#!/usr/bin/env node

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { basename, extname, resolve } from "node:path";

const EPSILON_SECONDS = 0.000001;

function parseArgs(argv) {
  const args = {
    input: "",
    audio: "",
    outDir: "",
    prefix: "",
    durationSeconds: null,
  };

  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === "--input" && next) {
      args.input = next;
      i += 1;
    } else if (arg === "--audio" && next) {
      args.audio = next;
      i += 1;
    } else if (arg === "--out-dir" && next) {
      args.outDir = next;
      i += 1;
    } else if (arg === "--prefix" && next) {
      args.prefix = next;
      i += 1;
    } else if (arg === "--duration-seconds" && next) {
      args.durationSeconds = Number(next);
      i += 1;
    } else if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`Unknown or incomplete argument: ${arg}`);
    }
  }

  if (!args.input) throw new Error("--input is required");
  if (!args.audio) throw new Error("--audio is required");
  if (!args.outDir) throw new Error("--out-dir is required");
  if (args.durationSeconds != null && (!Number.isFinite(args.durationSeconds) || args.durationSeconds <= 0)) {
    throw new Error("--duration-seconds must be a positive number");
  }

  return args;
}

function printHelp() {
  console.log(`Usage:
  node scripts/phase1-muted-mirror-from-assemblyai.mjs --input <assemblyai.raw.json> --audio <wav> --out-dir <dir> [options]

Options:
  --prefix <name>              Output filename prefix. Default: audio stem.
  --duration-seconds <number>  Optional timeline duration override, usually local WAV duration.
`);
}

function secondsFromMs(ms) {
  return Number(ms) / 1000;
}

function round(value, digits = 6) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function sanitizeName(value) {
  return String(value ?? "unknown").replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^_+|_+$/g, "") || "unknown";
}

function csvCell(value) {
  const text = String(value ?? "");
  if (!/[",\n\r]/.test(text)) return text;
  return `"${text.replaceAll('"', '""')}"`;
}

function readAssemblyAiJson(inputPath) {
  const resolved = resolve(inputPath);
  if (!existsSync(resolved)) throw new Error(`Input JSON does not exist: ${resolved}`);
  return JSON.parse(readFileSync(resolved, "utf8"));
}

function normalizeUtterances(result, duration) {
  const utterances = Array.isArray(result.utterances) ? result.utterances : [];
  return utterances
    .map((utterance, index) => {
      const start = clamp(secondsFromMs(utterance.start), 0, duration);
      const end = clamp(secondsFromMs(utterance.end), 0, duration);
      return {
        index,
        speaker: utterance.speaker == null ? "" : String(utterance.speaker),
        start,
        end,
        confidence: Number(utterance.confidence),
        text: utterance.text ?? "",
      };
    })
    .filter((utterance) => utterance.speaker && utterance.end - utterance.start > EPSILON_SECONDS)
    .sort((a, b) => a.start - b.start || a.end - b.end || a.index - b.index);
}

function readWavForMuting(audioPath) {
  const resolved = resolve(audioPath);
  if (!existsSync(resolved)) throw new Error(`Audio file does not exist: ${resolved}`);

  const buffer = readFileSync(resolved);
  if (buffer.toString("ascii", 0, 4) !== "RIFF" || buffer.toString("ascii", 8, 12) !== "WAVE") {
    throw new Error(`Only RIFF/WAVE files are supported: ${resolved}`);
  }

  let offset = 12;
  let fmt = null;
  let data = null;
  while (offset + 8 <= buffer.length) {
    const chunkId = buffer.toString("ascii", offset, offset + 4);
    const chunkSize = buffer.readUInt32LE(offset + 4);
    const chunkStart = offset + 8;
    const chunkEnd = chunkStart + chunkSize;

    if (chunkId === "fmt ") {
      fmt = {
        audioFormat: buffer.readUInt16LE(chunkStart),
        channels: buffer.readUInt16LE(chunkStart + 2),
        sampleRate: buffer.readUInt32LE(chunkStart + 4),
        bitsPerSample: buffer.readUInt16LE(chunkStart + 14),
      };
    } else if (chunkId === "data") {
      data = { start: chunkStart, end: chunkEnd, size: chunkSize };
    }

    offset = chunkEnd + (chunkSize % 2);
  }

  if (!fmt) throw new Error(`WAV fmt chunk not found: ${resolved}`);
  if (!data) throw new Error(`WAV data chunk not found: ${resolved}`);
  if (![1, 3].includes(fmt.audioFormat)) {
    throw new Error(`Only PCM or IEEE float WAV is supported. audioFormat=${fmt.audioFormat}`);
  }
  if (![8, 16, 24, 32].includes(fmt.bitsPerSample)) {
    throw new Error(`Unsupported bitsPerSample=${fmt.bitsPerSample}`);
  }
  if (fmt.channels < 1) throw new Error("WAV must have at least one channel");

  const bytesPerSample = fmt.bitsPerSample / 8;
  const frameBytes = bytesPerSample * fmt.channels;
  const frameCount = Math.floor(data.size / frameBytes);
  return {
    path: resolved,
    buffer,
    fmt,
    data,
    bytesPerSample,
    frameBytes,
    frameCount,
    durationSeconds: frameCount / fmt.sampleRate,
  };
}

function mergeIntervals(intervals) {
  const sorted = intervals
    .filter((interval) => interval.end - interval.start > EPSILON_SECONDS)
    .sort((a, b) => a.start - b.start || a.end - b.end);
  const merged = [];

  for (const interval of sorted) {
    const previous = merged[merged.length - 1];
    if (previous && interval.start <= previous.end + EPSILON_SECONDS) {
      previous.end = Math.max(previous.end, interval.end);
    } else {
      merged.push({ ...interval });
    }
  }

  return merged;
}

function groupIntervalsBySpeaker(utterances) {
  const groups = new Map();
  for (const utterance of utterances) {
    if (!groups.has(utterance.speaker)) groups.set(utterance.speaker, []);
    groups.get(utterance.speaker).push({ start: utterance.start, end: utterance.end });
  }

  return new Map([...groups.entries()].map(([speaker, intervals]) => [speaker, mergeIntervals(intervals)]));
}

function countOverlaps(utterances) {
  let count = 0;
  let seconds = 0;
  for (let i = 0; i < utterances.length; i += 1) {
    for (let j = i + 1; j < utterances.length; j += 1) {
      if (utterances[j].start >= utterances[i].end) break;
      if (utterances[i].speaker === utterances[j].speaker) continue;
      const start = Math.max(utterances[i].start, utterances[j].start);
      const end = Math.min(utterances[i].end, utterances[j].end);
      if (end > start + EPSILON_SECONDS) {
        count += 1;
        seconds += end - start;
      }
    }
  }
  return { count, seconds: round(seconds, 3) };
}

function intervalMask(frameCount, sampleRate, intervals) {
  const mask = new Uint8Array(frameCount);
  for (const interval of intervals) {
    const startFrame = clamp(Math.floor(interval.start * sampleRate), 0, frameCount);
    const endFrame = clamp(Math.ceil(interval.end * sampleRate), 0, frameCount);
    for (let frame = startFrame; frame < endFrame; frame += 1) {
      mask[frame] = 1;
    }
  }
  return mask;
}

function writeSilenceFrame(buffer, offset, fmt, bytesPerSample) {
  for (let channel = 0; channel < fmt.channels; channel += 1) {
    const sampleOffset = offset + channel * bytesPerSample;
    if (fmt.audioFormat === 1 && fmt.bitsPerSample === 8) {
      buffer.writeUInt8(128, sampleOffset);
    } else {
      buffer.fill(0, sampleOffset, sampleOffset + bytesPerSample);
    }
  }
}

function writeMutedMirrorWav(wav, intervals, outputPath) {
  const mask = intervalMask(wav.frameCount, wav.fmt.sampleRate, intervals);
  const outputBuffer = Buffer.from(wav.buffer);

  for (let frame = 0; frame < wav.frameCount; frame += 1) {
    if (mask[frame]) continue;
    const frameOffset = wav.data.start + frame * wav.frameBytes;
    writeSilenceFrame(outputBuffer, frameOffset, wav.fmt, wav.bytesPerSample);
  }

  writeFileSync(outputPath, outputBuffer);
}

function writeSpeakerTurnsCsv(outputPath, utterances) {
  const rows = [
    ["index", "speaker", "start_sec", "end_sec", "duration_sec", "confidence", "text"],
    ...utterances.map((utterance, index) => [
      index + 1,
      `speaker_${utterance.speaker}`,
      round(utterance.start, 3).toFixed(3),
      round(utterance.end, 3).toFixed(3),
      round(utterance.end - utterance.start, 3).toFixed(3),
      Number.isFinite(utterance.confidence) ? round(utterance.confidence, 4).toFixed(4) : "",
      utterance.text,
    ]),
  ];
  writeFileSync(outputPath, `${rows.map((row) => row.map(csvCell).join(",")).join("\n")}\n`, "utf8");
}

function main() {
  const args = parseArgs(process.argv);
  const inputPath = resolve(args.input);
  const audioPath = resolve(args.audio);
  const outDir = resolve(args.outDir);
  mkdirSync(outDir, { recursive: true });

  const wav = readWavForMuting(audioPath);
  const duration = args.durationSeconds ?? wav.durationSeconds;
  const result = readAssemblyAiJson(inputPath);
  const utterances = normalizeUtterances(result, duration);
  const speakerIntervals = groupIntervalsBySpeaker(utterances);
  const speakers = [...speakerIntervals.keys()].sort();
  const prefix = sanitizeName(args.prefix || basename(audioPath, extname(audioPath)));

  const speakerTurnPath = path.join(outDir, `${prefix}.speaker_turns.csv`);
  writeSpeakerTurnsCsv(speakerTurnPath, utterances);

  const outputs = [];
  for (const speaker of speakers) {
    const safeSpeaker = sanitizeName(`speaker_${speaker}`);
    const intervals = speakerIntervals.get(speaker);
    const outputPath = path.join(outDir, `${prefix}.${safeSpeaker}.muted_mirror.wav`);
    writeMutedMirrorWav(wav, intervals, outputPath);
    outputs.push({
      speaker: `speaker_${speaker}`,
      path: outputPath,
      interval_count: intervals.length,
      active_seconds: round(intervals.reduce((total, interval) => total + interval.end - interval.start, 0), 3),
    });
  }

  const overlap = countOverlaps(utterances);
  const manifest = {
    generated_at: new Date().toISOString(),
    source_audio: audioPath,
    source_assemblyai_json: inputPath,
    duration_seconds: round(duration, 6),
    wav: {
      sample_rate: wav.fmt.sampleRate,
      channels: wav.fmt.channels,
      bits_per_sample: wav.fmt.bitsPerSample,
      audio_format: wav.fmt.audioFormat,
    },
    method: {
      name: "phase1_muted_mirror_from_assemblyai_diarization",
      provider: "AssemblyAI",
      note:
        "Draft Phase I artifact for review. Each muted-mirror WAV preserves the original mono mix only during the selected speaker's diarized turns and mutes the rest. It is not source separation; overlapping voices in the original mix cannot be removed by this step.",
    },
    utterance_count: utterances.length,
    speakers,
    overlap,
    outputs: {
      speaker_turns_csv: speakerTurnPath,
      muted_mirror_wavs: outputs,
    },
  };
  const manifestPath = path.join(outDir, `${prefix}.phase1_manifest.json`);
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

  console.log(`Wrote speaker turns: ${speakerTurnPath}`);
  for (const output of outputs) {
    console.log(`Wrote muted mirror: ${output.speaker} -> ${output.path}`);
  }
  console.log(`Wrote manifest: ${manifestPath}`);
  console.log(JSON.stringify({
    duration_seconds: manifest.duration_seconds,
    utterance_count: manifest.utterance_count,
    speakers: manifest.speakers,
    overlap: manifest.overlap,
    outputs: outputs.length,
  }, null, 2));
}

main();
