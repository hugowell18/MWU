#!/usr/bin/env node

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, extname, resolve } from "node:path";
import { bestOverlappingInterval, getTier, parseTextGrid, round } from "./textgrid-utils.mjs";

const DEFAULT_TEXTGRID =
  "sample-inputs/simple-dialogue/elllo-425-dinner-plans/elllo_425_dinner_plans.reviewed.simulated.TextGrid";
const DEFAULT_OUTPUT_DIR = "outputs/stage-e";
const DEFAULT_PAUSE_THRESHOLD_SECONDS = 0.25;
const DEFAULT_BOUNDARY_WINDOW_SECONDS = 0.1;

const SOUNDING_TIER = "praat_sounding_silence";
const SPEAKER_TIER = "speaker";
const TRANSCRIPT_TIER = "transcript";
const EPSILON_SECONDS = 0.000001;

function parseArgs(argv) {
  const args = {
    textgrid: DEFAULT_TEXTGRID,
    outputJson: "",
    outputCsv: "",
    outputDir: DEFAULT_OUTPUT_DIR,
    pauseThresholdSeconds: DEFAULT_PAUSE_THRESHOLD_SECONDS,
    boundaryWindowSeconds: DEFAULT_BOUNDARY_WINDOW_SECONDS,
    wordAlignmentJson: "",
  };

  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === "--textgrid" && next) {
      args.textgrid = next;
      i += 1;
    } else if (arg === "--output-json" && next) {
      args.outputJson = next;
      i += 1;
    } else if (arg === "--output-csv" && next) {
      args.outputCsv = next;
      i += 1;
    } else if (arg === "--output-dir" && next) {
      args.outputDir = next;
      i += 1;
    } else if (arg === "--pause-threshold-seconds" && next) {
      args.pauseThresholdSeconds = Number(next);
      i += 1;
    } else if (arg === "--boundary-window-seconds" && next) {
      args.boundaryWindowSeconds = Number(next);
      i += 1;
    } else if (arg === "--word-alignment-json" && next) {
      args.wordAlignmentJson = next;
      i += 1;
    } else if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`Unknown or incomplete argument: ${arg}`);
    }
  }

  for (const [key, value] of Object.entries({
    pauseThresholdSeconds: args.pauseThresholdSeconds,
    boundaryWindowSeconds: args.boundaryWindowSeconds,
  })) {
    if (!Number.isFinite(value) || value < 0) throw new Error(`${key} must be a non-negative number`);
  }

  return args;
}

function printHelp() {
  console.log(`Usage:
  node scripts/extract-pause-segments.mjs [options]

Options:
  --textgrid <path>                  Researcher-reviewed 6-tier TextGrid.
                                      Default: ${DEFAULT_TEXTGRID}
  --output-json <path>               Output pause_segments.json path.
  --output-csv <path>                Output pause_segments.csv path.
  --output-dir <path>                Output directory if output paths are omitted.
                                      Default: ${DEFAULT_OUTPUT_DIR}
  --pause-threshold-seconds <n>      Silent pause threshold. Default: ${DEFAULT_PAUSE_THRESHOLD_SECONDS}
  --boundary-window-seconds <n>      Window used to describe near-turn-boundary pauses.
                                      Default: ${DEFAULT_BOUNDARY_WINDOW_SECONDS}
  --word-alignment-json <path>       Optional word_alignment.json from Stage D.
`);
}

function normalizeText(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function normalizeSpeaker(value) {
  return normalizeText(value).replace(/\s+/g, "_");
}

function csvCell(value) {
  const text = String(value ?? "");
  if (/[",\n\r]/.test(text)) return `"${text.replaceAll('"', '""')}"`;
  return text;
}

function writeCsv(path, rows) {
  const headers = [
    "pause_id",
    "start_sec",
    "end_sec",
    "duration_sec",
    "threshold_sec",
    "speaker_context",
    "pause_location_candidate",
    "location_confidence",
    "needs_word_alignment",
    "needs_clause_boundary",
    "previous_utterance_id",
    "previous_speaker",
    "previous_text",
    "next_utterance_id",
    "next_speaker",
    "next_text",
    "containing_utterance_id",
    "containing_speaker",
    "containing_text",
    "overlapping_utterance_id",
    "overlapping_speaker",
    "overlapping_text",
    "previous_word",
    "next_word",
    "word_timing_source",
    "notes",
  ];
  const lines = [
    headers.join(","),
    ...rows.map((row) => headers.map((header) => csvCell(row[header])).join(",")),
  ];
  writeFileSync(path, `${lines.join("\n")}\n`);
}

function readWordIntervals(path) {
  if (!path) return [];
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

function collectUtterances(transcriptTier, speakerTier) {
  return transcriptTier.intervals
    .filter((interval) => normalizeText(interval.text))
    .map((interval, index) => {
      const { interval: speakerInterval } = bestOverlappingInterval(speakerTier.intervals, interval);
      return {
        utterance_id: index + 1,
        start_sec: round(interval.start, 6),
        end_sec: round(interval.end, 6),
        duration_sec: round(interval.end - interval.start, 6),
        speaker: normalizeSpeaker(speakerInterval?.text),
        text: normalizeText(interval.text),
      };
    });
}

function previousUtterance(utterances, pause) {
  let best = null;
  for (const utterance of utterances) {
    if (utterance.end_sec <= pause.start + EPSILON_SECONDS) {
      if (!best || utterance.end_sec > best.end_sec) best = utterance;
    }
  }
  return best;
}

function nextUtterance(utterances, pause) {
  let best = null;
  for (const utterance of utterances) {
    if (utterance.start_sec >= pause.end - EPSILON_SECONDS) {
      if (!best || utterance.start_sec < best.start_sec) best = utterance;
    }
  }
  return best;
}

function containingUtterance(utterances, pause) {
  return (
    utterances.find((utterance) => {
      return pause.start >= utterance.start_sec - EPSILON_SECONDS && pause.end <= utterance.end_sec + EPSILON_SECONDS;
    }) ?? null
  );
}

function overlappingUtterance(utterances, pause) {
  let best = null;
  let bestOverlap = 0;
  for (const utterance of utterances) {
    const overlap = Math.max(0, Math.min(utterance.end_sec, pause.end) - Math.max(utterance.start_sec, pause.start));
    if (overlap > bestOverlap) {
      best = utterance;
      bestOverlap = overlap;
    }
  }
  return bestOverlap > EPSILON_SECONDS ? best : null;
}

function nearestWordBefore(words, pause) {
  let best = null;
  for (const word of words) {
    if (word.end_sec <= pause.start + EPSILON_SECONDS) {
      if (!best || word.end_sec > best.end_sec) best = word;
    }
  }
  return best;
}

function nearestWordAfter(words, pause) {
  let best = null;
  for (const word of words) {
    if (word.start_sec >= pause.end - EPSILON_SECONDS) {
      if (!best || word.start_sec < best.start_sec) best = word;
    }
  }
  return best;
}

function classifyPause({
  pause,
  previous,
  next,
  containing,
  overlapping,
  previousWord,
  nextWord,
  hasWordAlignment,
  boundaryWindowSeconds,
}) {
  const notes = [];
  let pauseLocationCandidate = "unknown";
  let locationConfidence = "low";
  let speakerContext = "";
  let needsWordAlignment = false;
  let needsClauseBoundary = false;

  if (containing) {
    speakerContext = "within_utterance";
  } else if (overlapping) {
    speakerContext = "partial_utterance_overlap";
  } else if (previous && next) {
    speakerContext = previous.speaker && next.speaker && previous.speaker !== next.speaker ? "speaker_change" : "same_speaker";
  } else {
    speakerContext = "unassigned";
  }

  if (hasWordAlignment && previousWord && nextWord) {
    needsClauseBoundary = true;
    pauseLocationCandidate =
      previousWord.speaker && nextWord.speaker && previousWord.speaker !== nextWord.speaker
        ? "turn_boundary_by_word_alignment"
        : "word_gap_requires_clause_boundary";
    locationConfidence = pauseLocationCandidate === "turn_boundary_by_word_alignment" ? "medium" : "low";
    notes.push("word alignment present; clause boundary is still required for mid-clause vs end-clause");
  } else if (containing) {
    const nearStart = Math.abs(pause.start - containing.start_sec) <= boundaryWindowSeconds;
    const nearEnd = Math.abs(containing.end_sec - pause.end) <= boundaryWindowSeconds;
    pauseLocationCandidate =
      nearStart || nearEnd ? "utterance_boundary_requires_word_alignment" : "intra_utterance_requires_word_alignment";
    needsWordAlignment = true;
    needsClauseBoundary = true;
    locationConfidence = "low";
    notes.push("utterance-level transcript cannot determine mid-clause vs end-clause");
  } else if (overlapping) {
    pauseLocationCandidate = "utterance_edge_overlap_requires_word_alignment";
    needsWordAlignment = true;
    needsClauseBoundary = true;
    locationConfidence = "low";
    notes.push("pause partially overlaps an utterance interval; word timing is required before location labeling");
  } else if (previous && next) {
    if (previous.speaker && next.speaker && previous.speaker !== next.speaker) {
      pauseLocationCandidate = "turn_boundary";
      locationConfidence = "medium";
      notes.push("classified from reviewed speaker/utterance boundaries; word timing can refine edge cases");
    } else {
      pauseLocationCandidate = "between_utterances_same_speaker_requires_word_alignment";
      needsWordAlignment = true;
      needsClauseBoundary = true;
      locationConfidence = "low";
      notes.push("same-speaker utterance gap needs word/clause alignment before mid/end-clause labeling");
    }
  } else if (previous) {
    pauseLocationCandidate = "post_utterance_or_trailing_pause";
    locationConfidence = "low";
    notes.push("no following utterance in transcript tier");
  } else if (next) {
    pauseLocationCandidate = "leading_pause";
    locationConfidence = "low";
    notes.push("no previous utterance in transcript tier");
  } else {
    pauseLocationCandidate = "unassigned_pause";
    locationConfidence = "low";
    notes.push("pause has no transcript context");
  }

  return {
    speaker_context: speakerContext,
    pause_location_candidate: pauseLocationCandidate,
    location_confidence: locationConfidence,
    needs_word_alignment: needsWordAlignment,
    needs_clause_boundary: needsClauseBoundary,
    notes: notes.join("; "),
  };
}

function summarize(rows, args, textgridPath, wordIntervals) {
  const byLocation = new Map();
  for (const row of rows) {
    byLocation.set(row.pause_location_candidate, (byLocation.get(row.pause_location_candidate) ?? 0) + 1);
  }

  return {
    stage: "stage-e-pause-segment-extraction",
    source_textgrid: textgridPath,
    pause_source: `${SOUNDING_TIER}`,
    silent_pause_threshold_seconds: args.pauseThresholdSeconds,
    boundary_window_seconds: args.boundaryWindowSeconds,
    word_alignment_json: args.wordAlignmentJson ? resolve(args.wordAlignmentJson) : "",
    word_alignment_present: wordIntervals.length > 0,
    pause_count: rows.length,
    total_pause_duration_seconds: round(
      rows.reduce((total, row) => total + row.duration_sec, 0),
      3,
    ),
    needs_word_alignment_count: rows.filter((row) => row.needs_word_alignment).length,
    needs_clause_boundary_count: rows.filter((row) => row.needs_clause_boundary).length,
    turn_boundary_candidate_count: rows.filter((row) => row.pause_location_candidate.includes("turn_boundary")).length,
    by_pause_location_candidate: Object.fromEntries([...byLocation.entries()].sort((a, b) => a[0].localeCompare(b[0]))),
  };
}

function main() {
  const args = parseArgs(process.argv);
  const textgridPath = resolve(args.textgrid);
  if (!existsSync(textgridPath)) throw new Error(`TextGrid does not exist: ${textgridPath}`);

  const tiers = parseTextGrid(readFileSync(textgridPath, "utf8"));
  const soundingTier = getTier(tiers, SOUNDING_TIER);
  const speakerTier = getTier(tiers, SPEAKER_TIER);
  const transcriptTier = getTier(tiers, TRANSCRIPT_TIER);
  const wordIntervals = readWordIntervals(args.wordAlignmentJson);
  const utterances = collectUtterances(transcriptTier, speakerTier);

  const rawPauses = soundingTier.intervals
    .filter((interval) => normalizeText(interval.text) === "silence")
    .map((interval) => ({ start: interval.start, end: interval.end, duration_sec: interval.end - interval.start }))
    .filter((pause) => pause.duration_sec + EPSILON_SECONDS >= args.pauseThresholdSeconds);

  const rows = rawPauses.map((pause, index) => {
    const previous = previousUtterance(utterances, pause);
    const next = nextUtterance(utterances, pause);
    const containing = containingUtterance(utterances, pause);
    const overlapping = containing ? null : overlappingUtterance(utterances, pause);
    const previousWord = nearestWordBefore(wordIntervals, pause);
    const nextWord = nearestWordAfter(wordIntervals, pause);
    const classification = classifyPause({
      pause,
      previous,
      next,
      containing,
      overlapping,
      previousWord,
      nextWord,
      hasWordAlignment: wordIntervals.length > 0,
      boundaryWindowSeconds: args.boundaryWindowSeconds,
    });

    return {
      pause_id: `p_${String(index + 1).padStart(4, "0")}`,
      start_sec: round(pause.start, 6),
      end_sec: round(pause.end, 6),
      duration_sec: round(pause.duration_sec, 3),
      threshold_sec: args.pauseThresholdSeconds,
      ...classification,
      previous_utterance_id: previous?.utterance_id ?? "",
      previous_speaker: previous?.speaker ?? "",
      previous_text: previous?.text ?? "",
      next_utterance_id: next?.utterance_id ?? "",
      next_speaker: next?.speaker ?? "",
      next_text: next?.text ?? "",
      containing_utterance_id: containing?.utterance_id ?? "",
      containing_speaker: containing?.speaker ?? "",
      containing_text: containing?.text ?? "",
      overlapping_utterance_id: overlapping?.utterance_id ?? "",
      overlapping_speaker: overlapping?.speaker ?? "",
      overlapping_text: overlapping?.text ?? "",
      previous_word: previousWord ? `${previousWord.text} (${previousWord.word_id})` : "",
      next_word: nextWord ? `${nextWord.text} (${nextWord.word_id})` : "",
      word_timing_source: wordIntervals.length > 0 ? "forced_alignment" : "",
    };
  });

  const base = basename(textgridPath, extname(textgridPath));
  const outputJson = args.outputJson ? resolve(args.outputJson) : resolve(args.outputDir, `${base}.pause_segments.json`);
  const outputCsv = args.outputCsv ? resolve(args.outputCsv) : resolve(args.outputDir, `${base}.pause_segments.csv`);
  mkdirSync(resolve(outputJson, ".."), { recursive: true });
  mkdirSync(resolve(outputCsv, ".."), { recursive: true });

  const summary = summarize(rows, args, textgridPath, wordIntervals);
  writeFileSync(outputJson, `${JSON.stringify({ summary, pauses: rows }, null, 2)}\n`);
  writeCsv(outputCsv, rows);

  console.log(JSON.stringify({ output_json: outputJson, output_csv: outputCsv, ...summary }, null, 2));
}

main();
