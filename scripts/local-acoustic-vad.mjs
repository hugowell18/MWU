#!/usr/bin/env node

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const DEFAULT_AUDIO = "sample-inputs/AMI_ES2002a_Mix-Headset_10min.wav";
const DEFAULT_OUTPUT = "sample-inputs/AMI_ES2002a_Mix-Headset_10min.local-vad.json";
const EPSILON_SECONDS = 0.000001;

export function defaultVadOptions() {
  return {
    frameMs: 20,
    hopMs: 10,
    noisePercentile: 20,
    thresholdMarginDb: 10,
    relativeThresholdDb: 45,
    minThresholdDb: -55,
    hysteresisDb: 3,
    minSoundingSeconds: 0.08,
    minSilenceSeconds: 0.2,
    padSoundingSeconds: 0.02,
  };
}

function parseArgs(argv) {
  const args = {
    audio: DEFAULT_AUDIO,
    output: DEFAULT_OUTPUT,
    ...defaultVadOptions(),
  };

  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === "--audio" && next) {
      args.audio = next;
      i += 1;
    } else if (arg === "--output" && next) {
      args.output = next;
      i += 1;
    } else if (arg === "--frame-ms" && next) {
      args.frameMs = Number(next);
      i += 1;
    } else if (arg === "--hop-ms" && next) {
      args.hopMs = Number(next);
      i += 1;
    } else if (arg === "--noise-percentile" && next) {
      args.noisePercentile = Number(next);
      i += 1;
    } else if (arg === "--threshold-margin-db" && next) {
      args.thresholdMarginDb = Number(next);
      i += 1;
    } else if (arg === "--relative-threshold-db" && next) {
      args.relativeThresholdDb = Number(next);
      i += 1;
    } else if (arg === "--min-threshold-db" && next) {
      args.minThresholdDb = Number(next);
      i += 1;
    } else if (arg === "--hysteresis-db" && next) {
      args.hysteresisDb = Number(next);
      i += 1;
    } else if (arg === "--min-sounding-seconds" && next) {
      args.minSoundingSeconds = Number(next);
      i += 1;
    } else if (arg === "--min-silence-seconds" && next) {
      args.minSilenceSeconds = Number(next);
      i += 1;
    } else if (arg === "--pad-sounding-seconds" && next) {
      args.padSoundingSeconds = Number(next);
      i += 1;
    } else if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`Unknown or incomplete argument: ${arg}`);
    }
  }

  validateOptions(args);
  return args;
}

function printHelp() {
  console.log(`Usage:
  node scripts/local-acoustic-vad.mjs [options]

Options:
  --audio <path>                   Input normalized WAV. Default: ${DEFAULT_AUDIO}
  --output <path>                  Output JSON. Default: ${DEFAULT_OUTPUT}
  --frame-ms <number>              RMS frame size. Default: 20
  --hop-ms <number>                RMS hop size. Default: 10
  --noise-percentile <number>      Noise floor percentile. Default: 20
  --threshold-margin-db <number>   Threshold above noise floor. Default: 10
  --relative-threshold-db <number> Threshold below peak. Default: 45
  --min-threshold-db <number>      Absolute floor for threshold. Default: -55
  --hysteresis-db <number>         Off threshold is this many dB lower. Default: 3
  --min-sounding-seconds <number>  Drop shorter sounding blips. Default: 0.08
  --min-silence-seconds <number>   Merge across shorter silent gaps. Default: 0.2
  --pad-sounding-seconds <number>  Pad sounding intervals before final merge. Default: 0.02
`);
}

function validateOptions(options) {
  const numberKeys = [
    "frameMs",
    "hopMs",
    "noisePercentile",
    "thresholdMarginDb",
    "relativeThresholdDb",
    "minThresholdDb",
    "hysteresisDb",
    "minSoundingSeconds",
    "minSilenceSeconds",
    "padSoundingSeconds",
  ];
  for (const key of numberKeys) {
    if (!Number.isFinite(options[key])) throw new Error(`${key} must be a number`);
  }
  if (options.frameMs <= 0 || options.hopMs <= 0) {
    throw new Error("frameMs and hopMs must be positive");
  }
  if (options.noisePercentile < 0 || options.noisePercentile > 100) {
    throw new Error("noisePercentile must be between 0 and 100");
  }
}

export function computeLocalAcousticVad(audioPath, userOptions = {}) {
  const options = { ...defaultVadOptions(), ...userOptions };
  validateOptions(options);

  const wav = readPcmWav(audioPath);
  const frames = computeRmsFrames(wav.samples, wav.sampleRate, options);
  const threshold = estimateThreshold(frames.map((frame) => frame.db), options);
  const rawSounding = framesToSoundingSegments(frames, threshold, options);
  const sounding = smoothSoundingSegments(rawSounding, wav.duration, options);
  const intervals = buildSpeechSilenceIntervals(wav.duration, sounding);

  return {
    audio_path: resolve(audioPath),
    duration_seconds: round(wav.duration, 6),
    sample_rate: wav.sampleRate,
    channels: wav.channels,
    method: {
      name: "local_acoustic_vad",
      feature: "frame_rms_dbfs",
      threshold_dbfs: round(threshold.thresholdDb, 3),
      noise_floor_dbfs: round(threshold.noiseFloorDb, 3),
      peak_dbfs: round(threshold.peakDb, 3),
      options,
      note:
        "Draft acoustic sounding/silence intervals. Chris must verify/correct boundaries in Praat before final analysis.",
    },
    intervals,
  };
}

function readPcmWav(audioPath) {
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
      data = buffer.subarray(chunkStart, chunkEnd);
    }

    offset = chunkEnd + (chunkSize % 2);
  }

  if (!fmt) throw new Error(`WAV fmt chunk not found: ${resolved}`);
  if (!data) throw new Error(`WAV data chunk not found: ${resolved}`);
  if (![1, 3].includes(fmt.audioFormat)) {
    throw new Error(`Only PCM or IEEE float WAV is supported. audioFormat=${fmt.audioFormat}`);
  }
  if (fmt.channels < 1) throw new Error("WAV must have at least one channel");

  const samples = decodeWavSamplesToMono(data, fmt);
  return {
    samples,
    sampleRate: fmt.sampleRate,
    channels: fmt.channels,
    duration: samples.length / fmt.sampleRate,
  };
}

function decodeWavSamplesToMono(data, fmt) {
  const bytesPerSample = fmt.bitsPerSample / 8;
  if (!Number.isInteger(bytesPerSample) || bytesPerSample <= 0) {
    throw new Error(`Unsupported bitsPerSample=${fmt.bitsPerSample}`);
  }

  const frameBytes = bytesPerSample * fmt.channels;
  const frameCount = Math.floor(data.length / frameBytes);
  const samples = new Float32Array(frameCount);

  for (let frame = 0; frame < frameCount; frame += 1) {
    let sum = 0;
    for (let channel = 0; channel < fmt.channels; channel += 1) {
      const sampleOffset = frame * frameBytes + channel * bytesPerSample;
      sum += readWavSample(data, sampleOffset, fmt);
    }
    samples[frame] = sum / fmt.channels;
  }

  return samples;
}

function readWavSample(data, offset, fmt) {
  if (fmt.audioFormat === 3 && fmt.bitsPerSample === 32) {
    return data.readFloatLE(offset);
  }
  if (fmt.audioFormat !== 1) {
    throw new Error(`Unsupported WAV audioFormat=${fmt.audioFormat}`);
  }

  if (fmt.bitsPerSample === 8) {
    return (data.readUInt8(offset) - 128) / 128;
  }
  if (fmt.bitsPerSample === 16) {
    return data.readInt16LE(offset) / 32768;
  }
  if (fmt.bitsPerSample === 24) {
    const raw = data.readIntLE(offset, 3);
    return raw / 8388608;
  }
  if (fmt.bitsPerSample === 32) {
    return data.readInt32LE(offset) / 2147483648;
  }

  throw new Error(`Unsupported PCM bitsPerSample=${fmt.bitsPerSample}`);
}

function computeRmsFrames(samples, sampleRate, options) {
  const frameSize = Math.max(1, Math.round((options.frameMs / 1000) * sampleRate));
  const hopSize = Math.max(1, Math.round((options.hopMs / 1000) * sampleRate));
  const frames = [];

  for (let start = 0; start < samples.length; start += hopSize) {
    const end = Math.min(samples.length, start + frameSize);
    if (end <= start) break;

    let sumSquares = 0;
    for (let i = start; i < end; i += 1) {
      sumSquares += samples[i] * samples[i];
    }
    const rms = Math.sqrt(sumSquares / (end - start));
    const db = 20 * Math.log10(Math.max(rms, 1e-8));
    frames.push({
      start: start / sampleRate,
      end: end / sampleRate,
      db,
    });

    if (end === samples.length) break;
  }

  return frames;
}

function estimateThreshold(frameDbs, options) {
  if (frameDbs.length === 0) {
    throw new Error("Cannot estimate VAD threshold from an empty audio file");
  }

  const noiseFloorDb = percentile(frameDbs, options.noisePercentile);
  const peakDb = Math.max(...frameDbs);
  const thresholdDb = Math.max(
    noiseFloorDb + options.thresholdMarginDb,
    peakDb - options.relativeThresholdDb,
    options.minThresholdDb,
  );
  return { thresholdDb, noiseFloorDb, peakDb };
}

function framesToSoundingSegments(frames, threshold, options) {
  const thresholdOn = threshold.thresholdDb;
  const thresholdOff = threshold.thresholdDb - options.hysteresisDb;
  const segments = [];
  let active = false;
  let segmentStart = null;

  for (const frame of frames) {
    if (!active && frame.db >= thresholdOn) {
      active = true;
      segmentStart = frame.start;
    } else if (active && frame.db < thresholdOff) {
      segments.push({ start: segmentStart, end: frame.end });
      active = false;
      segmentStart = null;
    }
  }

  if (active && segmentStart != null) {
    const last = frames[frames.length - 1];
    segments.push({ start: segmentStart, end: last.end });
  }

  return segments;
}

function smoothSoundingSegments(segments, duration, options) {
  const padded = segments
    .map((segment) => ({
      start: clamp(segment.start - options.padSoundingSeconds, 0, duration),
      end: clamp(segment.end + options.padSoundingSeconds, 0, duration),
    }))
    .filter((segment) => segment.end - segment.start >= options.minSoundingSeconds);

  const merged = mergeSegmentsWithGap(padded, options.minSilenceSeconds);
  return merged.filter((segment) => segment.end - segment.start >= options.minSoundingSeconds);
}

function mergeSegmentsWithGap(segments, maxGapSeconds) {
  const sorted = [...segments].sort((a, b) => a.start - b.start || a.end - b.end);
  const merged = [];
  for (const segment of sorted) {
    const previous = merged[merged.length - 1];
    if (previous && segment.start <= previous.end + maxGapSeconds + EPSILON_SECONDS) {
      previous.end = Math.max(previous.end, segment.end);
    } else {
      merged.push({ ...segment });
    }
  }
  return merged;
}

function buildSpeechSilenceIntervals(duration, soundingSegments) {
  const intervals = [];
  let cursor = 0;

  for (const segment of soundingSegments) {
    if (segment.start > cursor + EPSILON_SECONDS) {
      intervals.push({
        start: round(cursor, 6),
        end: round(segment.start, 6),
        text: "silence",
      });
    }
    intervals.push({
      start: round(Math.max(cursor, segment.start), 6),
      end: round(segment.end, 6),
      text: "sounding",
    });
    cursor = Math.max(cursor, segment.end);
  }

  if (cursor < duration - EPSILON_SECONDS) {
    intervals.push({
      start: round(cursor, 6),
      end: round(duration, 6),
      text: "silence",
    });
  }

  return intervals.length ? intervals : [{ start: 0, end: round(duration, 6), text: "silence" }];
}

function percentile(values, percentileValue) {
  const sorted = [...values].sort((a, b) => a - b);
  if (sorted.length === 1) return sorted[0];
  const index = (percentileValue / 100) * (sorted.length - 1);
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  if (lower === upper) return sorted[lower];
  const weight = index - lower;
  return sorted[lower] * (1 - weight) + sorted[upper] * weight;
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function round(value, digits) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function summarizeIntervals(intervals) {
  const sounding = intervals.filter((interval) => interval.text === "sounding");
  const silence = intervals.filter((interval) => interval.text === "silence");
  const sumDuration = (items) => items.reduce((total, item) => total + item.end - item.start, 0);
  return {
    interval_count: intervals.length,
    sounding_count: sounding.length,
    silence_count: silence.length,
    sounding_seconds: round(sumDuration(sounding), 3),
    silence_seconds: round(sumDuration(silence), 3),
  };
}

function main() {
  const args = parseArgs(process.argv);
  const outputPath = resolve(args.output);
  const vad = computeLocalAcousticVad(args.audio, args);
  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, `${JSON.stringify(vad, null, 2)}\n`, "utf8");
  console.log(`Wrote local VAD JSON: ${outputPath}`);
  console.log(
    JSON.stringify(
      {
        audio: basename(args.audio),
        duration_seconds: vad.duration_seconds,
        ...summarizeIntervals(vad.intervals),
        threshold_dbfs: vad.method.threshold_dbfs,
        noise_floor_dbfs: vad.method.noise_floor_dbfs,
        peak_dbfs: vad.method.peak_dbfs,
      },
      null,
      2,
    ),
  );
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main();
}
