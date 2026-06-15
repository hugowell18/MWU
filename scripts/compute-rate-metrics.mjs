#!/usr/bin/env node

// WP2.1 — Speech / articulation rate metrics (SCAFFOLD).
//
// Computes the building blocks the research team's fluency analysis needs, from:
//   - reviewed TextGrid Tier 1 (praat_sounding_silence) -> phonation / speaking time
//   - reviewed TextGrid Tier 4 (speaker)                -> per-speaker attribution
//   - word_alignment.json (Stage D)                     -> word counts (+ per utterance)
//
// Counting unit (PRD §5): syllables. The syllable source is PLUGGABLE:
//   --syllable-source heuristic  (default) English vowel-group ESTIMATE — clearly provisional.
//   --syllable-source nuclei-csv  de Jong & Wempe (2009) nuclei timestamps (one time per line,
//                                 or a CSV with a `time`/`time_sec` column). Swap this in once the
//                                 PI confirms the nuclei method/parameters — no code change.
//   --syllable-source none        Report word-based rates only.
//
// Definitions are intentionally transparent and emitted side by side so the team can pick the
// confirmed denominator (PRD §5 default: speaking time, excl. silence). Articulation rate uses
// phonation time; speech rate uses speaking time and total time.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import { getTier, overlapSeconds, parseTextGrid, round } from "./textgrid-utils.mjs";

const DEFAULT_TEXTGRID =
  "sample-inputs/simple-dialogue/elllo-425-dinner-plans/elllo_425_dinner_plans.reviewed.simulated.TextGrid";
const DEFAULT_WORD_ALIGNMENT = "outputs/wp2.0/elllo/word_alignment.json";
const DEFAULT_OUTPUT_DIR = "outputs/wp2.1";
const DEFAULT_PAUSE_THRESHOLD_SECONDS = 0.25;
const SOUNDING_TIER = "praat_sounding_silence";
const SPEAKER_TIER = "speaker";

function parseArgs(argv) {
  const args = {
    textgrid: DEFAULT_TEXTGRID,
    wordAlignment: DEFAULT_WORD_ALIGNMENT,
    output: "",
    outputDir: DEFAULT_OUTPUT_DIR,
    pauseThresholdSeconds: DEFAULT_PAUSE_THRESHOLD_SECONDS,
    syllableSource: "heuristic",
    syllableNucleiCsv: "",
  };

  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === "--textgrid" && next) {
      args.textgrid = next;
      i += 1;
    } else if (arg === "--word-alignment-json" && next) {
      args.wordAlignment = next;
      i += 1;
    } else if (arg === "--output" && next) {
      args.output = next;
      i += 1;
    } else if (arg === "--output-dir" && next) {
      args.outputDir = next;
      i += 1;
    } else if (arg === "--pause-threshold-seconds" && next) {
      args.pauseThresholdSeconds = Number(next);
      i += 1;
    } else if (arg === "--syllable-source" && next) {
      args.syllableSource = next;
      i += 1;
    } else if (arg === "--syllable-nuclei-csv" && next) {
      args.syllableNucleiCsv = next;
      i += 1;
    } else if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`Unknown or incomplete argument: ${arg}`);
    }
  }

  if (!Number.isFinite(args.pauseThresholdSeconds) || args.pauseThresholdSeconds < 0) {
    throw new Error("pause-threshold-seconds must be a non-negative number");
  }
  if (!["heuristic", "nuclei-csv", "none"].includes(args.syllableSource)) {
    throw new Error("syllable-source must be one of: heuristic, nuclei-csv, none");
  }
  if (args.syllableSource === "nuclei-csv" && !args.syllableNucleiCsv) {
    throw new Error("syllable-source=nuclei-csv requires --syllable-nuclei-csv <path>");
  }

  return args;
}

function printHelp() {
  console.log(`Usage:
  node scripts/compute-rate-metrics.mjs [options]

Options:
  --textgrid <path>                Reviewed TextGrid (needs ${SOUNDING_TIER} + ${SPEAKER_TIER}).
                                    Default: ${DEFAULT_TEXTGRID}
  --word-alignment-json <path>     Stage D word_alignment.json. Default: ${DEFAULT_WORD_ALIGNMENT}
  --output <path>                  Output rate_metrics.json path.
  --output-dir <path>              Output dir if --output omitted. Default: ${DEFAULT_OUTPUT_DIR}
  --pause-threshold-seconds <n>    Silent pause threshold for pause counts. Default: ${DEFAULT_PAUSE_THRESHOLD_SECONDS}
  --syllable-source <mode>         heuristic | nuclei-csv | none. Default: heuristic
  --syllable-nuclei-csv <path>     de Jong & Wempe nuclei timestamps (required if mode=nuclei-csv).
`);
}

function normalizeText(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function normalizeSpeaker(value) {
  return normalizeText(value).replace(/\s+/g, "_");
}

// Provisional English syllable estimate (vowel groups). Replace by confirmed nuclei method.
function estimateSyllables(text) {
  const word = String(text ?? "").toLowerCase().replace(/[^a-z]/g, "");
  if (!word) return 0;
  const groups = word.match(/[aeiouy]+/g);
  let count = groups ? groups.length : 0;
  if (word.endsWith("e") && !word.endsWith("le") && count > 1) count -= 1;
  return Math.max(1, count);
}

function readNucleiTimes(path) {
  const resolved = resolve(path);
  if (!existsSync(resolved)) throw new Error(`Syllable nuclei CSV does not exist: ${resolved}`);
  const text = readFileSync(resolved, "utf8").trim();
  if (!text) return [];
  const lines = text.split(/\r?\n/);
  const header = lines[0].split(",").map((h) => h.trim().toLowerCase());
  const timeIdx = header.indexOf("time_sec") !== -1 ? header.indexOf("time_sec") : header.indexOf("time");
  const hasHeader = timeIdx !== -1 || Number.isNaN(Number(lines[0].split(",")[0]));
  const times = [];
  for (let i = hasHeader ? 1 : 0; i < lines.length; i += 1) {
    if (!lines[i].trim()) continue;
    const cols = lines[i].split(",");
    const raw = timeIdx !== -1 ? cols[timeIdx] : cols[0];
    const value = Number(String(raw).trim());
    if (Number.isFinite(value)) times.push(value);
  }
  return times.sort((a, b) => a - b);
}

function readWords(path) {
  const resolved = resolve(path);
  if (!existsSync(resolved)) throw new Error(`Word alignment JSON does not exist: ${resolved}`);
  const payload = JSON.parse(readFileSync(resolved, "utf8"));
  const words = Array.isArray(payload.word_intervals) ? payload.word_intervals : [];
  return words
    .map((word) => ({
      word_id: String(word.word_id ?? ""),
      utt_id: String(word.utt_id ?? ""),
      speaker: normalizeSpeaker(word.speaker),
      text: normalizeText(word.text),
      start_sec: Number(word.start_sec),
      end_sec: Number(word.end_sec),
    }))
    .filter((word) => Number.isFinite(word.start_sec) && Number.isFinite(word.end_sec) && word.end_sec > word.start_sec);
}

function sumDuration(intervals) {
  return intervals.reduce((total, interval) => total + (interval.end - interval.start), 0);
}

function sumOverlap(intervals, spans) {
  let total = 0;
  for (const interval of intervals) {
    for (const span of spans) total += overlapSeconds(interval, span);
  }
  return total;
}

function countNucleiInSpans(times, spans) {
  return times.filter((time) => spans.some((span) => time >= span.start && time < span.end)).length;
}

function rates({ wordCount, syllableCount, phonation, speakingTime, totalTime, hasSyllables }) {
  const div = (num, den) => (den > 0 ? round(num / den, 3) : null);
  const out = {
    articulation_rate_words_per_sec: div(wordCount, phonation),
    speech_rate_words_per_sec: div(wordCount, speakingTime),
    speech_rate_words_per_sec_total: div(wordCount, totalTime),
  };
  if (hasSyllables) {
    out.articulation_rate_syllables_per_sec = div(syllableCount, phonation);
    out.speech_rate_syllables_per_sec = div(syllableCount, speakingTime);
    out.speech_rate_syllables_per_sec_total = div(syllableCount, totalTime);
  }
  return out;
}

function main() {
  const args = parseArgs(process.argv);
  const textgridPath = resolve(args.textgrid);
  if (!existsSync(textgridPath)) throw new Error(`TextGrid does not exist: ${textgridPath}`);

  const tiers = parseTextGrid(readFileSync(textgridPath, "utf8"));
  const soundingTier = getTier(tiers, SOUNDING_TIER);
  const speakerTier = getTier(tiers, SPEAKER_TIER);
  const words = readWords(args.wordAlignment);

  const hasSyllables = args.syllableSource !== "none";
  const nucleiTimes = args.syllableSource === "nuclei-csv" ? readNucleiTimes(args.syllableNucleiCsv) : [];
  const syllablesForWord = (text) => (args.syllableSource === "heuristic" ? estimateSyllables(text) : 0);

  // --- Acoustic durations from reviewed Tier 1 ---
  const soundingIntervals = soundingTier.intervals
    .filter((i) => normalizeText(i.text).toLowerCase() === "sounding")
    .map((i) => ({ start: i.start, end: i.end }));
  const silenceIntervals = soundingTier.intervals
    .filter((i) => normalizeText(i.text).toLowerCase() === "silence")
    .map((i) => ({ start: i.start, end: i.end }));

  const allIntervals = soundingTier.intervals;
  const timelineStart = allIntervals.length ? allIntervals[0].start : 0;
  const timelineEnd = allIntervals.length ? allIntervals.at(-1).end : 0;
  const totalDuration = timelineEnd - timelineStart;

  const firstSounding = soundingIntervals[0] ?? null;
  const lastSounding = soundingIntervals.at(-1) ?? null;
  const leadingInvalid = firstSounding ? Math.max(0, firstSounding.start - timelineStart) : totalDuration;
  const trailingInvalid = lastSounding ? Math.max(0, timelineEnd - lastSounding.end) : 0;

  const phonationTime = sumDuration(soundingIntervals);
  const speakingTime = Math.max(0, totalDuration - leadingInvalid - trailingInvalid);

  // Internal silent pauses = silence intervals that are not the leading/trailing dead air.
  const internalSilences = silenceIntervals.filter(
    (i) => i.start > timelineStart + 1e-9 && i.end < timelineEnd - 1e-9,
  );
  const silentPauses = internalSilences.filter((i) => i.end - i.start + 1e-9 >= args.pauseThresholdSeconds);
  const silentPauseTime = sumDuration(silentPauses);

  // --- Counts ---
  const globalWordCount = words.length;
  const globalSyllableCount = hasSyllables
    ? args.syllableSource === "nuclei-csv"
      ? nucleiTimes.length
      : words.reduce((total, word) => total + syllablesForWord(word.text), 0)
    : 0;

  const speakingMinutes = speakingTime / 60;

  const globalMetrics = {
    total_duration_sec: round(totalDuration, 3),
    leading_invalid_sec: round(leadingInvalid, 3),
    trailing_invalid_sec: round(trailingInvalid, 3),
    phonation_time_sec: round(phonationTime, 3),
    speaking_time_sec: round(speakingTime, 3),
    silent_pause_time_sec: round(silentPauseTime, 3),
    phonation_time_ratio: speakingTime > 0 ? round(phonationTime / speakingTime, 3) : null,
    word_count: globalWordCount,
    syllable_count: hasSyllables ? globalSyllableCount : null,
    silent_pause_count: silentPauses.length,
    silent_pauses_per_min: speakingMinutes > 0 ? round(silentPauses.length / speakingMinutes, 3) : null,
    mean_silent_pause_duration_sec: silentPauses.length ? round(silentPauseTime / silentPauses.length, 3) : null,
    ...rates({
      wordCount: globalWordCount,
      syllableCount: globalSyllableCount,
      phonation: phonationTime,
      speakingTime,
      totalTime: totalDuration,
      hasSyllables,
    }),
  };

  // --- Per speaker (turns from Tier 4) ---
  const speakerNames = [...new Set(speakerTier.intervals.map((i) => normalizeSpeaker(i.text)).filter(Boolean))].sort();
  const speakerMetrics = speakerNames.map((speaker) => {
    const turns = speakerTier.intervals
      .filter((i) => normalizeSpeaker(i.text) === speaker)
      .map((i) => ({ start: i.start, end: i.end }));
    const turnDuration = sumDuration(turns);
    const phonation = sumOverlap(soundingIntervals, turns);
    const speakerWords = words.filter((word) => word.speaker === speaker);
    const wordCount = speakerWords.length;
    const syllableCount = hasSyllables
      ? args.syllableSource === "nuclei-csv"
        ? countNucleiInSpans(nucleiTimes, turns)
        : speakerWords.reduce((total, word) => total + syllablesForWord(word.text), 0)
      : 0;
    return {
      speaker,
      turn_count: turns.length,
      turn_duration_sec: round(turnDuration, 3),
      phonation_time_sec: round(phonation, 3),
      word_count: wordCount,
      syllable_count: hasSyllables ? syllableCount : null,
      ...rates({
        wordCount,
        syllableCount,
        phonation,
        speakingTime: turnDuration,
        totalTime: turnDuration,
        hasSyllables,
      }),
    };
  });

  // --- Per utterance (from word alignment) ---
  const byUtt = new Map();
  for (const word of words) {
    if (!byUtt.has(word.utt_id)) byUtt.set(word.utt_id, []);
    byUtt.get(word.utt_id).push(word);
  }
  const utteranceMetrics = [...byUtt.entries()]
    .map(([uttId, uttWords]) => {
      const start = Math.min(...uttWords.map((w) => w.start_sec));
      const end = Math.max(...uttWords.map((w) => w.end_sec));
      const span = [{ start, end }];
      const phonation = sumOverlap(soundingIntervals, span);
      const wordCount = uttWords.length;
      const syllableCount = hasSyllables
        ? args.syllableSource === "nuclei-csv"
          ? countNucleiInSpans(nucleiTimes, span)
          : uttWords.reduce((total, word) => total + syllablesForWord(word.text), 0)
        : 0;
      const spanDuration = end - start;
      return {
        utt_id: uttId,
        speaker: uttWords[0].speaker,
        start_sec: round(start, 6),
        end_sec: round(end, 6),
        span_duration_sec: round(spanDuration, 3),
        phonation_time_sec: round(phonation, 3),
        word_count: wordCount,
        syllable_count: hasSyllables ? syllableCount : null,
        ...rates({
          wordCount,
          syllableCount,
          phonation,
          speakingTime: spanDuration,
          totalTime: spanDuration,
          hasSyllables,
        }),
      };
    })
    .sort((a, b) => a.start_sec - b.start_sec);

  const summary = {
    stage: "wp2.1-rate-metrics",
    source_textgrid: textgridPath,
    source_word_alignment: resolve(args.wordAlignment),
    pause_threshold_seconds: args.pauseThresholdSeconds,
    syllable_source: args.syllableSource,
    syllable_method_note:
      args.syllableSource === "heuristic"
        ? "PROVISIONAL vowel-group estimate; replace with de Jong & Wempe (2009) nuclei output once confirmed."
        : args.syllableSource === "nuclei-csv"
          ? `nuclei timestamps from ${resolve(args.syllableNucleiCsv)}`
          : "syllable metrics disabled",
    normalization_default: "speaking_time (excl. leading/trailing dead air); also reports total-time rates",
    session: globalMetrics,
  };

  const base = basename(textgridPath).replace(/\.TextGrid$/i, "");
  const outputJson = args.output ? resolve(args.output) : resolve(args.outputDir, `${base}.rate_metrics.json`);
  mkdirSync(resolve(outputJson, ".."), { recursive: true });
  writeFileSync(
    outputJson,
    `${JSON.stringify({ summary, speakers: speakerMetrics, utterances: utteranceMetrics }, null, 2)}\n`,
  );

  console.log(JSON.stringify({ output_json: outputJson, ...summary, speaker_count: speakerMetrics.length }, null, 2));
}

main();
