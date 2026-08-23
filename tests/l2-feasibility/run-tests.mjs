#!/usr/bin/env node

import assert from "node:assert/strict";

import { splitTranscript } from "../../scripts/validation-sprint/lib/transcript-split.mjs";
import {
  buildFeatureTables,
  buildPauseRows,
  buildPseudoGoldReference,
  buildReferenceCentricTiming,
  findMwuOccurrences,
  validateReviewedTextGrid,
} from "../../scripts/l2/feasibility-core.mjs";

let passed = 0;
let failed = 0;

test("dynamic N+3 reviewed TextGrid accepts canonical speakers and nine labels", () => {
  const contract = validateReviewedTextGrid(textGridFixture(), 3);
  assert.equal(contract.status, "passed");
  assert.deepEqual(contract.speakers, ["S1", "S2"]);
  assert.equal(contract.tier_count, 5);
  assert.equal(contract.expected_dynamic_tier_count, 5);
});

test("AssemblyAI pseudo-gold maps provider speakers without claiming Gold accuracy", () => {
  const reference = referenceFixture();
  assert.equal(reference.status, "assemblyai_pseudo_gold");
  assert.equal(reference.accuracy_claim, false);
  assert.deepEqual(reference.speakers, ["S1", "S2"]);
  assert.match(reference.transcript_text, /^S1: hello there/m);
});

test("S1-SN transcript labels split into per-speaker RAW and TIDY outputs", () => {
  const split = splitTranscript("S1: Um hello hello.\nS2: Right.\n");
  assert.deepEqual(split.speakers.map((speaker) => speaker.name), ["S1", "S2"]);
  assert.match(split.speakers[0].raw, /Um hello hello/);
});

test("reference-centric timing preserves every transcript word and exposes fallback", () => {
  const reference = referenceFixture();
  const timing = buildReferenceCentricTiming(reference.words, [
    aligned("M1", "U0001", "S1", "hello", 0.12, 0.42),
    aligned("M2", "U0002", "S2", "right", 2.12, 2.42),
  ]);
  assert.equal(timing.word_intervals.length, 3);
  assert.equal(timing.summary.mfa_supported_word_count, 2);
  assert.equal(timing.summary.assemblyai_fallback_word_count, 1);
  assert.equal(timing.summary.mfa_support_ratio, 0.666667);
  assert.equal(timing.word_intervals.find((word) => word.text === "there").timing_source, "assemblyai_fallback");
});

test("pause, MWU and speaker features remain generated but definition-scoped", () => {
  const contract = validateReviewedTextGrid(textGridFixture(), 3);
  const reference = referenceFixture();
  const timing = buildReferenceCentricTiming(reference.words, [
    aligned("M1", "U0001", "S1", "hello", 0.12, 0.42),
    aligned("M2", "U0001", "S1", "there", 1.55, 1.86),
    aligned("M3", "U0002", "S2", "right", 2.12, 2.42),
  ]);
  const occurrences = findMwuOccurrences(timing.word_intervals, ["hello there"]);
  const pauses = buildPauseRows(contract, timing.word_intervals, occurrences, 0.25);
  const features = buildFeatureTables(contract, timing.word_intervals, occurrences, pauses);
  assert.equal(occurrences.length, 1);
  assert.equal(pauses.length, 1);
  assert.equal(pauses[0].mwu_relation_candidate, "inside_mwu");
  assert.equal(features.speakerRows.length, 2);
  assert.equal(features.speakerRows[0].definition_status, "simulated_for_feasibility");
});

process.stdout.write(`\nL2 FEASIBILITY: ${passed} passed / ${failed} failed\n`);
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

function referenceFixture() {
  return buildPseudoGoldReference(
    {
      confidence: 0.9,
      utterances: [
        {
          speaker: "A",
          start: 100,
          end: 1900,
          text: "hello there",
          words: [
            { text: "hello", start: 100, end: 400, confidence: 0.9 },
            { text: "there", start: 1500, end: 1850, confidence: 0.8 },
          ],
        },
        {
          speaker: "B",
          start: 2100,
          end: 2500,
          text: "right",
          words: [{ text: "right", start: 2100, end: 2450, confidence: 0.9 }],
        },
      ],
    },
    { A: "S1", B: "S2" },
  );
}

function aligned(wordId, parentUttId, speaker, text, startSec, endSec) {
  return {
    word_id: wordId,
    utt_id: `${parentUttId}_C01`,
    parent_utt_id: parentUttId,
    speaker,
    text,
    start_sec: startSec,
    end_sec: endSec,
    alignment_flags: [],
  };
}

function intervalTier(name, intervals, xmax = 3) {
  const lines = [
    '        class = "IntervalTier"',
    `        name = "${name}"`,
    "        xmin = 0",
    `        xmax = ${xmax}`,
    `        intervals: size = ${intervals.length}`,
  ];
  intervals.forEach((interval, index) => {
    lines.push(`        intervals [${index + 1}]:`);
    lines.push(`            xmin = ${interval[0]}`);
    lines.push(`            xmax = ${interval[1]}`);
    lines.push(`            text = "${interval[2]}"`);
  });
  return lines;
}

function textGridFixture() {
  const tiers = [
    intervalTier("S1", [[0, 1, "s"], [1, 1.5, "op"], [1.5, 3, "s"]]),
    intervalTier("S2", [[0, 2, "pf"], [2, 2.5, "s"], [2.5, 3, "pf"]]),
    intervalTier("floor", [[0, 2, "S1"], [2, 2.5, "S2"], [2.5, 3, "FREE"]]),
    intervalTier("transitions", [[0, 3, ""]]),
    intervalTier("flags", [[0, 3, ""]]),
  ];
  const lines = [
    'File type = "ooTextFile"',
    'Object class = "TextGrid"',
    "",
    "xmin = 0",
    "xmax = 3",
    "tiers? <exists>",
    `size = ${tiers.length}`,
    "item []:",
  ];
  tiers.forEach((tier, index) => {
    lines.push(`    item [${index + 1}]:`);
    lines.push(...tier);
  });
  return `${lines.join("\n")}\n`;
}
