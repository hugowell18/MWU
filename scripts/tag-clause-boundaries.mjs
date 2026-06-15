#!/usr/bin/env node

// WP2.2 — AS-Unit / clause boundary tagging (SCAFFOLD).
//
// Produces a clause_segments.json by grouping forced-aligned words into clause-like
// units. Two paths:
//   Path B (default, implemented): rule-based auto-suggestion using configurable signals
//     (speaker/turn change, long inter-word gap, clause-initial conjunctions). Every clause
//     is marked review_status="auto_suggested" — these are CANDIDATES for human confirmation,
//     not final AS-units.
//   Path A (--as-unit-file, reserved): ingest researcher-supplied AS-unit transcripts
//     (blank-line separated, per HOLLIS Step 3). Not wired yet because those files are still
//     TBA on the research side; the flag is recognised so the interface is stable.
//
// All thresholds/word lists are CLI-overridable so the research team's confirmed clause
// definition can be dropped in by swapping values — no code change.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import { round } from "./textgrid-utils.mjs";

const DEFAULT_WORD_ALIGNMENT =
  "outputs/wp2.0/elllo/word_alignment.json";
const DEFAULT_OUTPUT_DIR = "outputs/wp2.2";
const DEFAULT_CLAUSE_GAP_SECONDS = 0.4;
const DEFAULT_MIN_WORDS_BEFORE_CONJUNCTION = 2;
// Conservative default list of clause-initial coordinators/subordinators (lowercase).
// Swap with the research team's confirmed list via --conjunctions.
const DEFAULT_CONJUNCTIONS = [
  "and",
  "but",
  "so",
  "or",
  "because",
  "when",
  "while",
  "if",
  "although",
  "though",
  "since",
  "before",
  "after",
  "then",
  "that",
  "which",
  "who",
];

function parseArgs(argv) {
  const args = {
    wordAlignment: DEFAULT_WORD_ALIGNMENT,
    output: "",
    outputDir: DEFAULT_OUTPUT_DIR,
    clauseGapSeconds: DEFAULT_CLAUSE_GAP_SECONDS,
    minWordsBeforeConjunction: DEFAULT_MIN_WORDS_BEFORE_CONJUNCTION,
    conjunctions: DEFAULT_CONJUNCTIONS,
    asUnitFile: "",
  };

  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === "--word-alignment-json" && next) {
      args.wordAlignment = next;
      i += 1;
    } else if (arg === "--output" && next) {
      args.output = next;
      i += 1;
    } else if (arg === "--output-dir" && next) {
      args.outputDir = next;
      i += 1;
    } else if (arg === "--clause-gap-seconds" && next) {
      args.clauseGapSeconds = Number(next);
      i += 1;
    } else if (arg === "--min-words-before-conjunction" && next) {
      args.minWordsBeforeConjunction = Number(next);
      i += 1;
    } else if (arg === "--conjunctions" && next) {
      args.conjunctions = next
        .split(",")
        .map((w) => w.trim().toLowerCase())
        .filter(Boolean);
      i += 1;
    } else if (arg === "--as-unit-file" && next) {
      args.asUnitFile = next;
      i += 1;
    } else if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`Unknown or incomplete argument: ${arg}`);
    }
  }

  if (!Number.isFinite(args.clauseGapSeconds) || args.clauseGapSeconds < 0) {
    throw new Error("clause-gap-seconds must be a non-negative number");
  }
  if (!Number.isFinite(args.minWordsBeforeConjunction) || args.minWordsBeforeConjunction < 0) {
    throw new Error("min-words-before-conjunction must be a non-negative number");
  }

  return args;
}

function printHelp() {
  console.log(`Usage:
  node scripts/tag-clause-boundaries.mjs [options]

Path B (default) — rule-based clause-boundary suggestion from forced alignment.

Options:
  --word-alignment-json <path>          Stage D word_alignment.json. Default: ${DEFAULT_WORD_ALIGNMENT}
  --output <path>                        Output clause_segments.json path.
  --output-dir <path>                    Output dir if --output omitted. Default: ${DEFAULT_OUTPUT_DIR}
  --clause-gap-seconds <n>               Inter-word gap (same speaker) that starts a new clause.
                                          Default: ${DEFAULT_CLAUSE_GAP_SECONDS}
  --min-words-before-conjunction <n>     Minimum words already in the current clause before a
                                          clause-initial conjunction can start a new one.
                                          Default: ${DEFAULT_MIN_WORDS_BEFORE_CONJUNCTION}
  --conjunctions <csv>                   Comma-separated clause-initial word list (lowercase).
                                          Default: ${DEFAULT_CONJUNCTIONS.join(",")}
  --as-unit-file <path>                  RESERVED (Path A): researcher AS-unit transcript.
                                          Not yet wired (AS-unit files TBA); see WP2.2 in the PRD.

NOTE: every clause is review_status="auto_suggested". These are candidates for human
confirmation, not final AS-units. Confirm the definition with Chris/Gavin (PRD §5/Phase 0).
`);
}

function normalizeText(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function normalizeSpeaker(value) {
  return normalizeText(value).replace(/\s+/g, "_");
}

function readWordIntervals(path) {
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
    .filter((word) => Number.isFinite(word.start_sec) && Number.isFinite(word.end_sec) && word.end_sec > word.start_sec)
    .sort((a, b) => a.start_sec - b.start_sec || a.end_sec - b.end_sec);
}

function suggestClauses(words, args) {
  const clauses = [];
  let current = null;

  const flush = () => {
    if (!current) return;
    clauses.push({
      clause_id: `c_${String(clauses.length + 1).padStart(4, "0")}`,
      speaker: current.speaker,
      utt_ids: [...current.uttIds],
      start_word_id: current.words[0].word_id,
      end_word_id: current.words.at(-1).word_id,
      start_sec: round(current.words[0].start_sec, 6),
      end_sec: round(current.words.at(-1).end_sec, 6),
      word_count: current.words.length,
      text: current.words.map((w) => w.text).join(" "),
      source: "rule_suggested",
      boundary_trigger: current.trigger,
      review_status: "auto_suggested",
    });
    current = null;
  };

  let previous = null;
  for (const word of words) {
    let trigger = null;
    if (!current) {
      trigger = "start";
    } else if (word.speaker !== previous.speaker) {
      trigger = "speaker_change";
    } else if (word.start_sec - previous.end_sec >= args.clauseGapSeconds) {
      trigger = "long_gap";
    } else if (
      args.conjunctions.includes(word.text.toLowerCase()) &&
      current.words.length >= args.minWordsBeforeConjunction
    ) {
      trigger = "clause_initial_conjunction";
    }

    if (trigger) {
      flush();
      current = { speaker: word.speaker, uttIds: new Set([word.utt_id]), words: [word], trigger };
    } else {
      current.words.push(word);
      current.uttIds.add(word.utt_id);
    }
    previous = word;
  }
  flush();

  return clauses.map((clause) => ({ ...clause, utt_ids: clause.utt_ids }));
}

function main() {
  const args = parseArgs(process.argv);

  if (args.asUnitFile) {
    throw new Error(
      "Path A (--as-unit-file) is reserved but not yet wired: researcher AS-unit transcripts are still TBA. " +
        "Run without --as-unit-file to use rule-based Path B for now (see WP2.2 in the PRD).",
    );
  }

  const words = readWordIntervals(args.wordAlignment);
  const clauses = suggestClauses(words, args);

  const triggerCounts = {};
  for (const clause of clauses) {
    triggerCounts[clause.boundary_trigger] = (triggerCounts[clause.boundary_trigger] ?? 0) + 1;
  }

  const summary = {
    stage: "wp2.2-clause-boundary-tagging",
    method: "rule_suggested",
    source_word_alignment: resolve(args.wordAlignment),
    params: {
      clause_gap_seconds: args.clauseGapSeconds,
      min_words_before_conjunction: args.minWordsBeforeConjunction,
      conjunctions: args.conjunctions,
    },
    word_count: words.length,
    clause_count: clauses.length,
    mean_words_per_clause: clauses.length ? round(words.length / clauses.length, 3) : 0,
    boundary_trigger_counts: triggerCounts,
    review_note:
      "All clauses are auto_suggested candidates and require human confirmation before mid/end-clause analysis.",
  };

  const base = basename(resolve(args.wordAlignment)).replace(/\.word_alignment\.json$|\.json$/i, "");
  const outputJson = args.output ? resolve(args.output) : resolve(args.outputDir, `${base}.clause_segments.json`);
  mkdirSync(resolve(outputJson, ".."), { recursive: true });
  writeFileSync(outputJson, `${JSON.stringify({ summary, clauses }, null, 2)}\n`);

  console.log(JSON.stringify({ output_json: outputJson, ...summary }, null, 2));
}

main();
