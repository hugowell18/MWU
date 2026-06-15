#!/usr/bin/env node

// WP2.3 — Pause-location classification (SCAFFOLD, the piece that turns candidates into labels).
//
// Combines:
//   - pause_segments.json   (Stage E: silent pauses >= threshold + nearest-word context)
//   - word_alignment.json   (Stage D: word-level timing + speaker)
//   - clause_segments.json  (WP2.2: clause boundaries)
// into a final pause_location per pause: mid_clause / end_clause / between_turn / leading_pause /
// trailing_pause / unknown.
//
// Rule (Foster et al. 2000 operationalisation; see PRD §5):
//   - previous and next word in the SAME clause          -> mid_clause
//   - previous and next word in DIFFERENT clauses (same speaker) -> end_clause
//   - previous and next word from DIFFERENT speakers     -> between_turn
//
// Because the clause input is currently rule-suggested (WP2.2 Path B), labels are emitted with
// review_status="auto_candidate" and a confidence reflecting the clause source. When the research
// team confirms the clause definition, the same classifier produces defensible labels unchanged.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import { round } from "./textgrid-utils.mjs";

const DEFAULT_PAUSE_SEGMENTS = "outputs/stage-e/elllo-425-reviewed-with-alignment/elllo_425_dinner_plans.reviewed.simulated.pause_segments.json";
const DEFAULT_WORD_ALIGNMENT = "outputs/wp2.0/elllo/word_alignment.json";
const DEFAULT_CLAUSE_SEGMENTS = "outputs/wp2.2/word_alignment.clause_segments.json";
const DEFAULT_OUTPUT_DIR = "outputs/wp2.3";
const EPSILON_SECONDS = 0.000001;

function parseArgs(argv) {
  const args = {
    pauseSegments: DEFAULT_PAUSE_SEGMENTS,
    wordAlignment: DEFAULT_WORD_ALIGNMENT,
    clauseSegments: DEFAULT_CLAUSE_SEGMENTS,
    output: "",
    outputDir: DEFAULT_OUTPUT_DIR,
  };

  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === "--pause-segments-json" && next) {
      args.pauseSegments = next;
      i += 1;
    } else if (arg === "--word-alignment-json" && next) {
      args.wordAlignment = next;
      i += 1;
    } else if (arg === "--clause-segments-json" && next) {
      args.clauseSegments = next;
      i += 1;
    } else if (arg === "--output" && next) {
      args.output = next;
      i += 1;
    } else if (arg === "--output-dir" && next) {
      args.outputDir = next;
      i += 1;
    } else if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`Unknown or incomplete argument: ${arg}`);
    }
  }

  return args;
}

function printHelp() {
  console.log(`Usage:
  node scripts/classify-pause-location.mjs [options]

Options:
  --pause-segments-json <path>   Stage E pause_segments.json. Default: ${DEFAULT_PAUSE_SEGMENTS}
  --word-alignment-json <path>   Stage D word_alignment.json. Default: ${DEFAULT_WORD_ALIGNMENT}
  --clause-segments-json <path>  WP2.2 clause_segments.json. Default: ${DEFAULT_CLAUSE_SEGMENTS}
  --output <path>                Output pause_location.json path.
  --output-dir <path>            Output dir if --output omitted. Default: ${DEFAULT_OUTPUT_DIR}
`);
}

function normalizeText(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function normalizeSpeaker(value) {
  return normalizeText(value).replace(/\s+/g, "_");
}

function readJson(path, label) {
  const resolved = resolve(path);
  if (!existsSync(resolved)) throw new Error(`${label} does not exist: ${resolved}`);
  return JSON.parse(readFileSync(resolved, "utf8"));
}

function readWords(path) {
  const payload = readJson(path, "Word alignment JSON");
  const words = Array.isArray(payload.word_intervals) ? payload.word_intervals : [];
  return words
    .map((word) => ({
      word_id: String(word.word_id ?? ""),
      speaker: normalizeSpeaker(word.speaker),
      text: normalizeText(word.text),
      start_sec: Number(word.start_sec),
      end_sec: Number(word.end_sec),
    }))
    .filter((word) => Number.isFinite(word.start_sec) && Number.isFinite(word.end_sec) && word.end_sec > word.start_sec)
    .sort((a, b) => a.start_sec - b.start_sec || a.end_sec - b.end_sec);
}

// Map each word_id -> clause_id using the contiguous start_word_id..end_word_id ranges.
function buildWordClauseMap(words, clauses) {
  const indexById = new Map(words.map((word, index) => [word.word_id, index]));
  const wordClause = new Map();
  for (const clause of clauses) {
    const startIdx = indexById.get(clause.start_word_id);
    const endIdx = indexById.get(clause.end_word_id);
    if (startIdx === undefined || endIdx === undefined) continue;
    for (let i = startIdx; i <= endIdx; i += 1) {
      wordClause.set(words[i].word_id, clause.clause_id);
    }
  }
  return wordClause;
}

function nearestWordBefore(words, pauseStart) {
  let best = null;
  for (const word of words) {
    if (word.end_sec <= pauseStart + EPSILON_SECONDS) {
      if (!best || word.end_sec > best.end_sec) best = word;
    }
  }
  return best;
}

function nearestWordAfter(words, pauseEnd) {
  let best = null;
  for (const word of words) {
    if (word.start_sec >= pauseEnd - EPSILON_SECONDS) {
      if (!best || word.start_sec < best.start_sec) best = word;
    }
  }
  return best;
}

function classify({ previousWord, nextWord, previousClauseId, nextClauseId }) {
  if (!previousWord && !nextWord) return { pause_location: "no_context", confidence: "low" };
  if (!previousWord) return { pause_location: "leading_pause", confidence: "medium" };
  if (!nextWord) return { pause_location: "trailing_pause", confidence: "medium" };
  if (previousWord.speaker && nextWord.speaker && previousWord.speaker !== nextWord.speaker) {
    return { pause_location: "between_turn", confidence: "medium" };
  }
  if (previousClauseId && nextClauseId) {
    if (previousClauseId === nextClauseId) return { pause_location: "mid_clause", confidence: "low" };
    return { pause_location: "end_clause", confidence: "low" };
  }
  return { pause_location: "unknown", confidence: "low" };
}

function main() {
  const args = parseArgs(process.argv);

  const pausePayload = readJson(args.pauseSegments, "Pause segments JSON");
  const pauses = Array.isArray(pausePayload.pauses) ? pausePayload.pauses : [];
  const words = readWords(args.wordAlignment);
  const clausePayload = readJson(args.clauseSegments, "Clause segments JSON");
  const clauses = Array.isArray(clausePayload.clauses) ? clausePayload.clauses : [];
  const clauseSource = clausePayload.summary?.method ?? "unknown";

  const wordClause = buildWordClauseMap(words, clauses);

  const rows = pauses.map((pause) => {
    const start = Number(pause.start_sec);
    const end = Number(pause.end_sec);
    const previousWord = nearestWordBefore(words, start);
    const nextWord = nearestWordAfter(words, end);
    const previousClauseId = previousWord ? wordClause.get(previousWord.word_id) ?? "" : "";
    const nextClauseId = nextWord ? wordClause.get(nextWord.word_id) ?? "" : "";
    const { pause_location, confidence } = classify({ previousWord, nextWord, previousClauseId, nextClauseId });

    return {
      pause_id: pause.pause_id,
      start_sec: round(start, 6),
      end_sec: round(end, 6),
      duration_sec: Number(pause.duration_sec),
      pause_location,
      location_confidence: confidence,
      location_method: "clause_rule",
      clause_source: clauseSource,
      previous_word: previousWord ? `${previousWord.text} (${previousWord.word_id})` : "",
      next_word: nextWord ? `${nextWord.text} (${nextWord.word_id})` : "",
      previous_clause_id: previousClauseId,
      next_clause_id: nextClauseId,
      previous_speaker: previousWord?.speaker ?? "",
      next_speaker: nextWord?.speaker ?? "",
      review_status: "auto_candidate",
    };
  });

  const byLocation = {};
  for (const row of rows) byLocation[row.pause_location] = (byLocation[row.pause_location] ?? 0) + 1;

  const summary = {
    stage: "wp2.3-pause-location-classification",
    clause_source: clauseSource,
    source_pause_segments: resolve(args.pauseSegments),
    source_word_alignment: resolve(args.wordAlignment),
    source_clause_segments: resolve(args.clauseSegments),
    pause_count: rows.length,
    mid_clause_count: byLocation.mid_clause ?? 0,
    end_clause_count: byLocation.end_clause ?? 0,
    between_turn_count: byLocation.between_turn ?? 0,
    unknown_count: byLocation.unknown ?? 0,
    by_pause_location: byLocation,
    review_note:
      clauseSource === "rule_suggested"
        ? "Labels derive from auto-suggested clauses (WP2.2 Path B); confirm clause definition before research use."
        : "Labels derive from confirmed clause boundaries.",
  };

  const base = basename(resolve(args.pauseSegments)).replace(/\.pause_segments\.json$|\.json$/i, "");
  const outputJson = args.output ? resolve(args.output) : resolve(args.outputDir, `${base}.pause_location.json`);
  mkdirSync(resolve(outputJson, ".."), { recursive: true });
  writeFileSync(outputJson, `${JSON.stringify({ summary, pauses: rows }, null, 2)}\n`);

  console.log(JSON.stringify({ output_json: outputJson, ...summary }, null, 2));
}

main();
