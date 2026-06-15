#!/usr/bin/env node

import { existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

const nodeBin = process.execPath;
const reviewedTextGrid =
  "sample-inputs/simple-dialogue/elllo-425-dinner-plans/elllo_425_dinner_plans.reviewed.simulated.TextGrid";
const wordAlignmentJson = "outputs/stage-d/elllo-425-reviewed/word_alignment.json";
const outputDir = "outputs/stage-e-test";
const outputJson = `${outputDir}/elllo_425_dinner_plans.reviewed.simulated.pause_segments.json`;

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function run(label, command, args) {
  const result = spawnSync(command, args, {
    cwd: resolve("."),
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });

  if (result.status !== 0) {
    throw new Error(`${label} failed (${result.status})\n${result.stdout}\n${result.stderr}`);
  }

  return result.stdout;
}

assert(existsSync(reviewedTextGrid), `Missing reviewed TextGrid fixture: ${reviewedTextGrid}`);
assert(existsSync(wordAlignmentJson), `Missing word alignment fixture: ${wordAlignmentJson}`);

run("extract pause segments with word alignment", nodeBin, [
  "scripts/extract-pause-segments.mjs",
  "--textgrid",
  reviewedTextGrid,
  "--word-alignment-json",
  wordAlignmentJson,
  "--output-dir",
  outputDir,
]);

assert(existsSync(outputJson), `Missing output JSON: ${outputJson}`);

const payload = JSON.parse(readFileSync(outputJson, "utf8"));
const summary = payload.summary ?? {};
const pauses = Array.isArray(payload.pauses) ? payload.pauses : [];

assert(summary.word_alignment_present === true, "Expected word alignment to be recorded as present");
assert(summary.pause_count === pauses.length, "Summary pause_count must match pause rows");
assert(summary.pause_count > 0, "Expected at least one extracted pause");
assert(summary.silent_pause_threshold_seconds === 0.25, "Expected 250 ms pause threshold");
assert(summary.by_pause_location_candidate.word_gap_requires_clause_boundary > 0, "Expected word-gap pause candidates");
assert(summary.needs_clause_boundary_count > 0, "Expected clause-boundary dependency to be explicit");
assert(pauses.every((pause) => pause.duration_sec >= 0.25), "Every pause must respect the threshold");
assert(
  pauses.some((pause) => pause.previous_word || pause.next_word),
  "Expected at least one pause to carry nearest word context",
);

console.log(
  JSON.stringify(
    {
      ok: true,
      output_json: resolve(outputJson),
      pause_count: summary.pause_count,
      word_gap_requires_clause_boundary:
        summary.by_pause_location_candidate.word_gap_requires_clause_boundary ?? 0,
      turn_boundary_by_word_alignment:
        summary.by_pause_location_candidate.turn_boundary_by_word_alignment ?? 0,
      needs_clause_boundary_count: summary.needs_clause_boundary_count,
    },
    null,
    2,
  ),
);
