#!/usr/bin/env node

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { dirname, resolve } from "node:path";
import { computeLocalAcousticVad, defaultVadOptions } from "./local-acoustic-vad.mjs";

const DEFAULT_INPUT =
  "sample-inputs/assemblyai/AMI_ES2002a_Mix-Headset_10min.assemblyai.raw.json";
const DEFAULT_AUDIO = "sample-inputs/AMI_ES2002a_Mix-Headset_10min.wav";
const DEFAULT_OUTPUT =
  "sample-inputs/AMI_ES2002a_Mix-Headset_10min.assemblyai.6tier.TextGrid";
const DEFAULT_PRAAT_SCRIPT = "scripts/praat-silence-to-textgrid.praat";
const MAC_PRAAT_BIN = "/Applications/Praat.app/Contents/MacOS/Praat";
const EPSILON_SECONDS = 0.000001;

function parseArgs(argv) {
  const args = {
    input: DEFAULT_INPUT,
    audio: DEFAULT_AUDIO,
    output: DEFAULT_OUTPUT,
    praatBin: process.env.PRAAT_BIN || (existsSync(MAC_PRAAT_BIN) ? MAC_PRAAT_BIN : "praat"),
    praatScript: DEFAULT_PRAAT_SCRIPT,
    praatMinimumPitchHz: 100,
    praatTimeStepSeconds: 0,
    praatSilenceThresholdDb: -50,
    praatMinimumSilentIntervalSeconds: 0.25,
    praatMinimumSoundingIntervalSeconds: 0.1,
    lowUtteranceConfidence: 0.75,
    lowWordConfidence: 0,
    minUtteranceSeconds: 0.35,
    conflictMinDurationSeconds: 0.05,
    wordMergeGapSeconds: 0.25,
    wordPaddingSeconds: 0.03,
    minWordSeconds: 0.05,
    ...defaultVadOptions(),
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
    } else if (arg === "--output" && next) {
      args.output = next;
      i += 1;
    } else if (arg === "--praat-bin" && next) {
      args.praatBin = next;
      i += 1;
    } else if (arg === "--praat-script" && next) {
      args.praatScript = next;
      i += 1;
    } else if (arg === "--praat-minimum-pitch-hz" && next) {
      args.praatMinimumPitchHz = Number(next);
      i += 1;
    } else if (arg === "--praat-time-step-seconds" && next) {
      args.praatTimeStepSeconds = Number(next);
      i += 1;
    } else if (arg === "--praat-silence-threshold-db" && next) {
      args.praatSilenceThresholdDb = Number(next);
      i += 1;
    } else if (arg === "--praat-minimum-silent-interval-seconds" && next) {
      args.praatMinimumSilentIntervalSeconds = Number(next);
      i += 1;
    } else if (arg === "--praat-minimum-sounding-interval-seconds" && next) {
      args.praatMinimumSoundingIntervalSeconds = Number(next);
      i += 1;
    } else if (arg === "--low-utterance-confidence" && next) {
      args.lowUtteranceConfidence = Number(next);
      i += 1;
    } else if (arg === "--low-word-confidence" && next) {
      args.lowWordConfidence = Number(next);
      i += 1;
    } else if (arg === "--min-utterance-seconds" && next) {
      args.minUtteranceSeconds = Number(next);
      i += 1;
    } else if (arg === "--conflict-min-duration-seconds" && next) {
      args.conflictMinDurationSeconds = Number(next);
      i += 1;
    } else if (arg === "--word-merge-gap-seconds" && next) {
      args.wordMergeGapSeconds = Number(next);
      i += 1;
    } else if (arg === "--word-padding-seconds" && next) {
      args.wordPaddingSeconds = Number(next);
      i += 1;
    } else if (arg === "--min-word-seconds" && next) {
      args.minWordSeconds = Number(next);
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

  for (const [key, value] of Object.entries({
    lowUtteranceConfidence: args.lowUtteranceConfidence,
    lowWordConfidence: args.lowWordConfidence,
    minUtteranceSeconds: args.minUtteranceSeconds,
    wordMergeGapSeconds: args.wordMergeGapSeconds,
    wordPaddingSeconds: args.wordPaddingSeconds,
    minWordSeconds: args.minWordSeconds,
    praatMinimumPitchHz: args.praatMinimumPitchHz,
    praatTimeStepSeconds: args.praatTimeStepSeconds,
    praatSilenceThresholdDb: args.praatSilenceThresholdDb,
    praatMinimumSilentIntervalSeconds: args.praatMinimumSilentIntervalSeconds,
    praatMinimumSoundingIntervalSeconds: args.praatMinimumSoundingIntervalSeconds,
    conflictMinDurationSeconds: args.conflictMinDurationSeconds,
    frameMs: args.frameMs,
    hopMs: args.hopMs,
    noisePercentile: args.noisePercentile,
    thresholdMarginDb: args.thresholdMarginDb,
    relativeThresholdDb: args.relativeThresholdDb,
    minThresholdDb: args.minThresholdDb,
    hysteresisDb: args.hysteresisDb,
    minSoundingSeconds: args.minSoundingSeconds,
    minSilenceSeconds: args.minSilenceSeconds,
    padSoundingSeconds: args.padSoundingSeconds,
  })) {
    if (!Number.isFinite(value)) throw new Error(`${key} must be a number`);
  }

  return args;
}

function printHelp() {
  console.log(`Usage:
  node scripts/assemblyai-json-to-textgrid.mjs [options]

Options:
  --input <path>                       AssemblyAI raw JSON.
  --audio <path>                       Normalized WAV for local acoustic VAD.
  --output <path>                      Output 6-tier TextGrid.
  --praat-bin <path>                   Praat executable. Default: PRAAT_BIN, macOS Praat, or praat.
  --praat-script <path>                Praat silence script. Default: ${DEFAULT_PRAAT_SCRIPT}
  --praat-minimum-pitch-hz <number>    Praat intensity minimum pitch. Default: 100
  --praat-time-step-seconds <number>   Praat intensity time step. Default: 0
  --praat-silence-threshold-db <number>
                                      Praat silence threshold. Default: -50
  --praat-minimum-silent-interval-seconds <number>
                                      Praat minimum silent interval. Default: 0.25
  --praat-minimum-sounding-interval-seconds <number>
                                      Praat minimum sounding interval. Default: 0.1
  --low-utterance-confidence <number>  Review flag threshold. Default: 0.75
  --low-word-confidence <number>       Optional word-level review flag threshold. Default: 0 disables it.
  --min-utterance-seconds <number>     Review flag threshold. Default: 0.35
  --conflict-min-duration-seconds <number>
                                      Ignore shorter Praat/local VAD disagreements. Default: 0.05
  --word-merge-gap-seconds <number>    Merge word speech segments across short gaps. Default: 0.25
  --word-padding-seconds <number>      Pad word speech segments before merging. Default: 0.03
  --min-word-seconds <number>          Minimum duration for zero-length words. Default: 0.05

Acoustic VAD options:
  --frame-ms <number>                  RMS frame size. Default: 20
  --hop-ms <number>                    RMS hop size. Default: 10
  --noise-percentile <number>          Noise floor percentile. Default: 20
  --threshold-margin-db <number>       Threshold above noise floor. Default: 10
  --relative-threshold-db <number>     Threshold below peak. Default: 45
  --min-threshold-db <number>          Absolute floor for threshold. Default: -55
  --min-sounding-seconds <number>      Drop shorter sounding blips. Default: 0.08
  --min-silence-seconds <number>       Merge across shorter silent gaps. Default: 0.2
`);
}

function secondsFromMs(ms) {
  return Number(ms) / 1000;
}

function formatTime(seconds) {
  const normalized = Math.abs(seconds) < EPSILON_SECONDS ? 0 : seconds;
  return normalized.toFixed(6);
}

function escapeTextGridText(value) {
  return String(value ?? "")
    .replace(/\r?\n/g, " ")
    .replaceAll('"', '""')
    .trim();
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function round(value, digits) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function readAssemblyAiJson(inputPath) {
  if (!existsSync(inputPath)) {
    throw new Error(`Input JSON does not exist: ${inputPath}`);
  }
  return JSON.parse(readFileSync(inputPath, "utf8"));
}

function unquoteTextGridString(value) {
  return String(value ?? "").replaceAll('""', '"');
}

function parseTextGrid(text) {
  const tiers = [];
  let currentTier = null;
  let currentInterval = null;

  for (const line of text.split(/\r?\n/)) {
    if (/^\s*item \[\d+\]:\s*$/.test(line)) {
      currentTier = { name: "", intervals: [] };
      currentInterval = null;
      tiers.push(currentTier);
      continue;
    }

    if (!currentTier) continue;

    const nameMatch = line.match(/^\s*name = "(.*)"\s*$/);
    if (nameMatch && !currentInterval) {
      currentTier.name = unquoteTextGridString(nameMatch[1]);
      continue;
    }

    if (/^\s*intervals \[\d+\]:\s*$/.test(line)) {
      currentInterval = { start: Number.NaN, end: Number.NaN, text: "" };
      currentTier.intervals.push(currentInterval);
      continue;
    }

    if (!currentInterval) continue;

    const xminMatch = line.match(/^\s*xmin = ([^\s]+)\s*$/);
    if (xminMatch) {
      currentInterval.start = Number(xminMatch[1]);
      continue;
    }

    const xmaxMatch = line.match(/^\s*xmax = ([^\s]+)\s*$/);
    if (xmaxMatch) {
      currentInterval.end = Number(xmaxMatch[1]);
      continue;
    }

    const textMatch = line.match(/^\s*text = "(.*)"\s*$/);
    if (textMatch) {
      currentInterval.text = unquoteTextGridString(textMatch[1]);
    }
  }

  for (const tier of tiers) {
    tier.intervals = tier.intervals.filter((interval) => {
      return Number.isFinite(interval.start) && Number.isFinite(interval.end) && interval.end > interval.start;
    });
  }

  return tiers.filter((tier) => tier.name);
}

function runPraatSilenceDetection(audioPath, duration, args) {
  const resolvedAudioPath = resolve(audioPath);
  const resolvedPraatScript = resolve(args.praatScript);
  if (!existsSync(resolvedAudioPath)) throw new Error(`Audio file does not exist: ${resolvedAudioPath}`);
  if (!existsSync(resolvedPraatScript)) throw new Error(`Praat script does not exist: ${resolvedPraatScript}`);

  const tempDir = mkdtempSync(path.join(tmpdir(), "ldt-praat-silence-"));
  const outputPath = path.join(tempDir, "praat_silence.TextGrid");
  const commandArgs = [
    "--run",
    resolvedPraatScript,
    resolvedAudioPath,
    outputPath,
    String(args.praatMinimumPitchHz),
    String(args.praatTimeStepSeconds),
    String(args.praatSilenceThresholdDb),
    String(args.praatMinimumSilentIntervalSeconds),
    String(args.praatMinimumSoundingIntervalSeconds),
    "silence",
    "sounding",
  ];

  const result = spawnSync(args.praatBin, commandArgs, {
    encoding: "utf8",
    maxBuffer: 10 * 1024 * 1024,
  });

  try {
    if (result.error) throw result.error;
    if (result.status !== 0) {
      throw new Error(
        [
          `Praat silence detection failed with status ${result.status}.`,
          result.stdout?.trim() ? `stdout:\n${result.stdout.trim()}` : "",
          result.stderr?.trim() ? `stderr:\n${result.stderr.trim()}` : "",
        ]
          .filter(Boolean)
          .join("\n"),
      );
    }
    if (!existsSync(outputPath)) {
      throw new Error(`Praat did not create output TextGrid: ${outputPath}`);
    }

    const parsed = parseTextGrid(readFileSync(outputPath, "utf8"));
    const firstTier = parsed[0];
    if (!firstTier) throw new Error("Praat output TextGrid did not contain any interval tier");
    return normalizeSoundingSilenceIntervals(firstTier.intervals, duration);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

function normalizeSoundingSilenceIntervals(intervals, duration) {
  const normalized = [];
  let cursor = 0;

  for (const interval of intervals.sort((a, b) => a.start - b.start || a.end - b.end)) {
    const start = clamp(interval.start, 0, duration);
    const end = clamp(interval.end, 0, duration);
    if (end <= start + EPSILON_SECONDS) continue;

    if (start > cursor + EPSILON_SECONDS) {
      normalized.push({ start: round(cursor, 6), end: round(start, 6), text: "silence" });
    }

    const label = normalizeSoundingLabel(interval.text);
    normalized.push({
      start: round(Math.max(cursor, start), 6),
      end: round(end, 6),
      text: label,
    });
    cursor = Math.max(cursor, end);
  }

  if (cursor < duration - EPSILON_SECONDS) {
    normalized.push({ start: round(cursor, 6), end: round(duration, 6), text: "silence" });
  }

  return coalesceIntervals(normalized.length ? normalized : [{ start: 0, end: duration, text: "silence" }]);
}

function normalizeSoundingLabel(value) {
  const label = String(value ?? "").trim().toLowerCase();
  if (label === "sounding" || label === "speech" || label === "speaking") return "sounding";
  return "silence";
}

function normalizeUtterances(result) {
  const rawDuration = Number(result.audio_duration);
  const utterances = Array.isArray(result.utterances) ? result.utterances : [];
  const maxUtteranceEnd = utterances.reduce((maxEnd, utterance) => {
    return Math.max(maxEnd, secondsFromMs(utterance.end ?? 0));
  }, 0);
  const duration = Number.isFinite(rawDuration) && rawDuration > 0 ? rawDuration : maxUtteranceEnd;

  const normalized = utterances
    .map((utterance, index) => {
      const start = clamp(secondsFromMs(utterance.start), 0, duration);
      const end = clamp(secondsFromMs(utterance.end), 0, duration);
      return {
        index,
        start,
        end,
        speaker: utterance.speaker == null ? "" : String(utterance.speaker),
        text: utterance.text ?? "",
        confidence: Number(utterance.confidence),
        words: Array.isArray(utterance.words) ? utterance.words : [],
      };
    })
    .filter((utterance) => utterance.end - utterance.start > EPSILON_SECONDS)
    .sort((a, b) => a.start - b.start || a.end - b.end || a.index - b.index);

  return { duration, utterances: normalized };
}

function mergeSegments(segments) {
  const sorted = segments
    .filter((segment) => segment.end - segment.start > EPSILON_SECONDS)
    .sort((a, b) => a.start - b.start || a.end - b.end);
  const merged = [];

  for (const segment of sorted) {
    const previous = merged[merged.length - 1];
    if (previous && segment.start <= previous.end + EPSILON_SECONDS) {
      previous.end = Math.max(previous.end, segment.end);
    } else {
      merged.push({ start: segment.start, end: segment.end });
    }
  }

  return merged;
}

function coalesceIntervals(intervals) {
  const sorted = intervals
    .filter((interval) => interval.end - interval.start > EPSILON_SECONDS)
    .sort((a, b) => a.start - b.start || a.end - b.end);
  const merged = [];

  for (const interval of sorted) {
    const previous = merged[merged.length - 1];
    if (
      previous &&
      Math.abs(previous.end - interval.start) <= EPSILON_SECONDS &&
      previous.text === interval.text
    ) {
      previous.end = interval.end;
    } else {
      merged.push({ ...interval });
    }
  }

  return merged.map((interval) => ({
    start: round(interval.start, 6),
    end: round(interval.end, 6),
    text: interval.text,
  }));
}

function intervalAtMidpoint(intervals, start, end) {
  const midpoint = (start + end) / 2;
  return intervals.find((interval) => interval.start <= midpoint && midpoint <= interval.end) ?? null;
}

function uniqueSortedBoundaries(intervals) {
  const boundaries = new Set(["0.000000"]);
  for (const interval of intervals) {
    if (Number.isFinite(interval.start)) boundaries.add(interval.start.toFixed(6));
    if (Number.isFinite(interval.end)) boundaries.add(interval.end.toFixed(6));
  }
  return [...boundaries].map(Number).sort((a, b) => a - b);
}

function buildSoundingSilenceReviewIntervals(duration, praatIntervals, localVadIntervals, options) {
  const boundaries = uniqueSortedBoundaries([
    { start: 0, end: duration, text: "" },
    ...praatIntervals,
    ...localVadIntervals,
  ]);
  const intervals = [];

  for (let index = 0; index < boundaries.length - 1; index += 1) {
    const start = boundaries[index];
    const end = boundaries[index + 1];
    if (end <= start + EPSILON_SECONDS) continue;

    const praatLabel = intervalAtMidpoint(praatIntervals, start, end)?.text || "silence";
    const localVadLabel = intervalAtMidpoint(localVadIntervals, start, end)?.text || "silence";
    const conflictDuration = end - start;
    const text =
      praatLabel !== localVadLabel && conflictDuration >= options.conflictMinDurationSeconds
        ? `pending: praat=${praatLabel}; local_vad=${localVadLabel}`
        : "";

    intervals.push({
      start: round(start, 6),
      end: round(end, 6),
      text,
    });
  }

  return coalesceIntervals(intervals);
}

function buildSpeechSilenceIntervals(duration, speechSegments) {
  const intervals = [];
  let cursor = 0;

  for (const segment of mergeSegments(speechSegments)) {
    if (segment.start > cursor + EPSILON_SECONDS) {
      intervals.push({ start: cursor, end: segment.start, text: "silence" });
    }
    intervals.push({
      start: Math.max(cursor, segment.start),
      end: segment.end,
      text: "sounding",
    });
    cursor = Math.max(cursor, segment.end);
  }

  if (cursor < duration - EPSILON_SECONDS) {
    intervals.push({ start: cursor, end: duration, text: "silence" });
  }

  return intervals.length ? intervals : [{ start: 0, end: duration, text: "silence" }];
}

function buildWordSpeechSegments(duration, utterances, options) {
  const segments = [];

  for (const utterance of utterances) {
    for (const word of utterance.words) {
      if (!Number.isFinite(Number(word.start)) || !Number.isFinite(Number(word.end))) continue;

      const rawStart = secondsFromMs(word.start);
      let rawEnd = secondsFromMs(word.end);
      if (rawEnd <= rawStart) {
        rawEnd = rawStart + options.minWordSeconds;
      }

      segments.push({
        start: clamp(rawStart - options.wordPaddingSeconds, 0, duration),
        end: clamp(rawEnd + options.wordPaddingSeconds, 0, duration),
      });
    }
  }

  return mergeSegmentsWithGap(segments, options.wordMergeGapSeconds);
}

function mergeSegmentsWithGap(segments, maxGapSeconds) {
  const sorted = segments
    .filter((segment) => segment.end - segment.start > EPSILON_SECONDS)
    .sort((a, b) => a.start - b.start || a.end - b.end);
  const merged = [];

  for (const segment of sorted) {
    const previous = merged[merged.length - 1];
    if (previous && segment.start <= previous.end + maxGapSeconds + EPSILON_SECONDS) {
      previous.end = Math.max(previous.end, segment.end);
    } else {
      merged.push({ start: segment.start, end: segment.end });
    }
  }

  return merged;
}

function buildUtteranceIntervals(duration, utterances, labelForUtterance) {
  const intervals = [];
  let cursor = 0;

  for (const utterance of utterances) {
    const start = Math.max(cursor, utterance.start);
    const end = utterance.end;
    if (utterance.start > cursor + EPSILON_SECONDS) {
      intervals.push({ start: cursor, end: utterance.start, text: "" });
    }
    if (end > start + EPSILON_SECONDS) {
      intervals.push({
        start,
        end,
        text: labelForUtterance(utterance),
      });
      cursor = end;
    }
  }

  if (cursor < duration - EPSILON_SECONDS) {
    intervals.push({ start: cursor, end: duration, text: "" });
  }

  return intervals.length ? intervals : [{ start: 0, end: duration, text: "" }];
}

function reviewFlags(utterance, thresholds) {
  const flags = [];
  const duration = utterance.end - utterance.start;

  if (!utterance.speaker) {
    flags.push("missing_speaker");
  }
  if (Number.isFinite(utterance.confidence) && utterance.confidence < thresholds.lowUtteranceConfidence) {
    flags.push(`low_utt_conf=${utterance.confidence.toFixed(2)}`);
  }
  if (duration < thresholds.minUtteranceSeconds) {
    flags.push(`short_utt=${duration.toFixed(2)}s`);
  }

  if (thresholds.lowWordConfidence > 0) {
    const lowConfidenceWords = utterance.words.filter((word) => {
      return Number.isFinite(Number(word.confidence)) && Number(word.confidence) < thresholds.lowWordConfidence;
    });
    if (lowConfidenceWords.length > 0) {
      flags.push(`low_word_conf=${lowConfidenceWords.length}`);
    }
  }

  const mixedWordSpeakers = new Set(
    utterance.words
      .map((word) => (word.speaker == null ? "" : String(word.speaker)))
      .filter((speaker) => speaker && utterance.speaker && speaker !== utterance.speaker),
  );
  if (mixedWordSpeakers.size > 0) {
    flags.push(`mixed_word_speaker=${[...mixedWordSpeakers].sort().join(",")}`);
  }

  return flags.length ? `check: ${flags.join("; ")}` : "";
}

function reviewStatusLabel(utterance, thresholds) {
  const flags = reviewFlags(utterance, thresholds);
  if (!flags) return "";
  return flags.replace(/^check: /, "pending: ");
}

function renderIntervalTier(index, name, duration, intervals) {
  const lines = [
    `    item [${index}]:`,
    '        class = "IntervalTier"',
    `        name = "${escapeTextGridText(name)}"`,
    "        xmin = 0",
    `        xmax = ${formatTime(duration)}`,
    `        intervals: size = ${intervals.length}`,
  ];

  intervals.forEach((interval, intervalIndex) => {
    lines.push(
      `        intervals [${intervalIndex + 1}]:`,
      `            xmin = ${formatTime(interval.start)}`,
      `            xmax = ${formatTime(interval.end)}`,
      `            text = "${escapeTextGridText(interval.text)}"`,
    );
  });

  return lines.join("\n");
}

function renderTextGrid(duration, tiers) {
  return [
    'File type = "ooTextFile"',
    'Object class = "TextGrid"',
    "",
    "xmin = 0",
    `xmax = ${formatTime(duration)}`,
    "tiers? <exists>",
    `size = ${tiers.length}`,
    "item []:",
    ...tiers.map((tier, index) => renderIntervalTier(index + 1, tier.name, duration, tier.intervals)),
    "",
  ].join("\n");
}

function summarize(utterances, reviewIntervals, praatIntervals, localVadIntervals, conflictIntervals) {
  const speakers = new Set(utterances.map((utterance) => utterance.speaker).filter(Boolean));
  const reviewLabels = reviewIntervals.map((interval) => interval.text).filter(Boolean);
  const pendingCount = reviewLabels.filter((label) => label.startsWith("pending:")).length;
  const flaggedCount = reviewLabels.filter((label) => {
    return label.startsWith("pending:");
  }).length;
  const sumDuration = (intervals, label) => {
    return intervals
      .filter((interval) => !label || interval.text === label)
      .reduce((total, interval) => total + interval.end - interval.start, 0);
  };
  const conflictLabels = conflictIntervals.map((interval) => interval.text).filter(Boolean);
  return {
    utterance_count: utterances.length,
    speakers: [...speakers].sort(),
    praat_interval_count: praatIntervals.length,
    praat_sounding_seconds: round(sumDuration(praatIntervals, "sounding"), 3),
    local_vad_interval_count: localVadIntervals.length,
    local_vad_sounding_seconds: round(sumDuration(localVadIntervals, "sounding"), 3),
    sounding_silence_conflict_count: conflictLabels.length,
    sounding_silence_conflict_seconds: round(sumDuration(conflictIntervals.filter((interval) => interval.text)), 3),
    pending_review_count: pendingCount,
    flagged_utterance_count: flaggedCount,
  };
}

function main() {
  const args = parseArgs(process.argv);
  const inputPath = resolve(args.input);
  const outputPath = resolve(args.output);
  const result = readAssemblyAiJson(inputPath);
  const { duration, utterances } = normalizeUtterances(result);

  const praatIntervals = runPraatSilenceDetection(resolve(args.audio), duration, args);
  const localVad = computeLocalAcousticVad(resolve(args.audio), args);
  const localVadIntervals = normalizeSoundingSilenceIntervals(localVad.intervals, duration);
  const soundingSilenceReviewIntervals = buildSoundingSilenceReviewIntervals(
    duration,
    praatIntervals,
    localVadIntervals,
    args,
  );
  const speakerIntervals = buildUtteranceIntervals(duration, utterances, (utterance) => {
    return utterance.speaker ? `speaker_${utterance.speaker}` : "";
  });
  const transcriptIntervals = buildUtteranceIntervals(duration, utterances, (utterance) => utterance.text);
  const reviewIntervals = buildUtteranceIntervals(duration, utterances, (utterance) => {
    return reviewStatusLabel(utterance, args);
  });

  const textGrid = renderTextGrid(duration, [
    { name: "praat_sounding_silence", intervals: praatIntervals },
    { name: "local_vad_sounding_silence", intervals: localVadIntervals },
    { name: "sounding_silence_review_status", intervals: soundingSilenceReviewIntervals },
    { name: "speaker", intervals: speakerIntervals },
    { name: "transcript", intervals: transcriptIntervals },
    { name: "review_status", intervals: reviewIntervals },
  ]);

  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, textGrid, "utf8");

  const summary = summarize(
    utterances,
    reviewIntervals,
    praatIntervals,
    localVadIntervals,
    soundingSilenceReviewIntervals,
  );
  console.log(`Wrote TextGrid: ${outputPath}`);
  console.log(JSON.stringify({ duration, ...summary }, null, 2));
}

main();
