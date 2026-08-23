#!/usr/bin/env node

import assert from "node:assert/strict";

import {
  buildMatrixRows,
  compareGoldDerived,
  fieldProvenanceRows,
  goldDerivedRows,
  parseCsv,
  provisionalCodebook,
  validateMatrix,
} from "../../scripts/l3/feasibility-core.mjs";

let passed = 0;
let failed = 0;

test("CSV parser preserves quoted commas and escaped quotes", () => {
  const rows = parseCsv('speaker,note,value\nS1,"hello, ""there""",2\n');
  assert.deepEqual(rows, [{ speaker: "S1", note: 'hello, "there"', value: "2" }]);
});

test("Layer 2 tables merge into one participant-level matrix row", () => {
  const rows = matrixFixture();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].speaker, "S1");
  assert.equal(rows[0].word_count, 10);
  assert.equal(rows[0].own_pause_labeled_duration_sec, 0.5);
  assert.equal(rows[0].qualifying_own_pause_duration_sec, 0.5);
  assert.equal(rows[0].pause_within_utterance_candidate_count, 1);
  assert.equal(rows[0].pause_inside_mwu_candidate_count, 1);
  assert.equal(rows[0].word_timing_mfa_support_ratio, 0.9);
  assert.equal(rows[0].false_start_count, null);
  assert.equal(rows[0].l3_release_ready, false);
});

test("provisional codebook covers every matrix field with provenance", () => {
  const rows = matrixFixture();
  const codebook = provisionalCodebook();
  const validation = validateMatrix(rows, codebook);
  assert.equal(validation.status, "passed", JSON.stringify(validation.errors));
  assert.deepEqual(Object.keys(rows[0]), codebook.map((field) => field.field_name));
  assert.equal(fieldProvenanceRows(codebook).length, codebook.length);
});

test("Gold-derived values independently reconcile to matrix values", () => {
  const rows = matrixFixture();
  const gold = goldDerivedRows(contractFixture(), 0.25);
  const comparisons = compareGoldDerived(rows, gold);
  assert.equal(comparisons.length, 5);
  assert.equal(comparisons.every((comparison) => comparison.status === "passed"), true);
});

test("Gold comparison detects a corrupted matrix value", () => {
  const rows = matrixFixture();
  rows[0].own_pause_count = 2;
  const comparisons = compareGoldDerived(rows, goldDerivedRows(contractFixture(), 0.25));
  assert.equal(comparisons.find((comparison) => comparison.field === "own_pause_count").status, "failed");
});

process.stdout.write(`\nL3 FEASIBILITY: ${passed} passed / ${failed} failed\n`);
if (failed) process.exitCode = 1;

function test(name, fn) {
  try {
    fn();
    passed += 1;
    process.stdout.write(`PASS ${name}\n`);
  } catch (error) {
    failed += 1;
    process.stderr.write(`FAIL ${name}\n${error.stack || error.message}\n`);
  }
}

function matrixFixture() {
  return buildMatrixRows({
    handoffRows: [
      {
        recording_id: "R1",
        participant_id: "SIM_P01",
        speaker: "S1",
        word_count: "10",
        active_vocal_duration_sec: "1.5",
        own_pause_duration_sec: "0.5",
        own_pause_count: "1",
        mean_own_pause_sec: "0.5",
        articulation_rate_words_per_sec: "6.666667",
        speech_rate_words_per_sec: "5",
        pause_density_per_100_words: "10",
        mwu_occurrence_count: "1",
        mfa_timed_word_count: "9",
        assemblyai_fallback_word_count: "1",
        unresolved_item_count: "7",
      },
    ],
    lexicalRows: [
      {
        speaker: "S1",
        token_count: "10",
        type_count: "8",
        type_token_ratio: "0.8",
        mean_token_length: "4.2",
        external_tool_status: "TAALES_TAALED_AntConc_not_configured",
      },
    ],
    repairRows: [
      {
        speaker: "S1",
        filler_count: "1",
        adjacent_repetition_count: "1",
        false_start_count: "",
        repair_count: "",
      },
    ],
    pauseRows: [
      {
        speaker: "S1",
        duration_sec: "0.5",
        clause_location_candidate: "within_utterance_candidate",
        mwu_relation_candidate: "inside_mwu",
      },
    ],
  });
}

function contractFixture() {
  return {
    speakers: ["S1"],
    tiers: [
      {
        name: "S1",
        intervals: [
          { start: 0, end: 1.5, text: "s" },
          { start: 1.5, end: 2, text: "op" },
          { start: 2, end: 3, text: "pf" },
        ],
      },
    ],
  };
}
