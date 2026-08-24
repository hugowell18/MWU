#!/usr/bin/env node

import assert from "node:assert/strict";

import { splitTranscript } from "../../scripts/validation-sprint/lib/transcript-split.mjs";
import {
  buildFeatureTables,
  buildPauseRows,
  buildPseudoGoldReference,
  buildReferenceCentricTiming,
  buildTransitionEvidence,
  findMwuOccurrences,
  rowsToCsv,
  validateReviewedTextGrid,
} from "../../scripts/l2/feasibility-core.mjs";
import {
  buildTimedRawTranscript,
  buildVerifiedTranscriptReference,
  parseVerifiedTranscript,
} from "../../scripts/l2/verified-transcript.mjs";

let passed = 0;
let failed = 0;

test("dynamic N+3 reviewed TextGrid accepts canonical speakers and nine labels", () => {
  const contract = validateReviewedTextGrid(textGridFixture(), 3);
  assert.equal(contract.status, "passed");
  assert.deepEqual(contract.speakers, ["S1", "S2"]);
  assert.equal(contract.tier_count, 5);
  assert.equal(contract.expected_dynamic_tier_count, 5);
  assert.equal(contract.transition_point_count, 2);
  assert.equal(contract.transition_evidence_count, 2);
});

test("TextTier transitions retain measured FTO and Path B overlap evidence", () => {
  const rows = buildTransitionEvidence(validateReviewedTextGrid(textGridFixture(), 3));
  assert.equal(rows.length, 2);
  assert.equal(rows[0].from_speaker, "S1");
  assert.equal(rows[0].fto_sec, 0.42);
  assert.equal(rows[1].fto_sec, null);
  assert.equal(rows[1].overlap_present, true);
  assert.equal(rows[1].offset_measured, false);
});

test("CSV export serializes structured alignment confidence", () => {
  const csv = rowsToCsv([{ word: "hello", alignment_confidence: { status: "needs_review", snr: 7.1 } }]);
  assert.doesNotMatch(csv, /\[object Object\]/);
  assert.match(csv, /needs_review/);
});

test("AssemblyAI pseudo-gold maps provider speakers without claiming Gold accuracy", () => {
  const reference = referenceFixture();
  assert.equal(reference.status, "assemblyai_pseudo_gold");
  assert.equal(reference.accuracy_claim, false);
  assert.deepEqual(reference.speakers, ["S1", "S2"]);
  assert.match(reference.transcript_text, /^S1: hello there/m);
});

test("S1-SN transcript labels split into per-speaker RAW and TIDY outputs", () => {
  const split = splitTranscript("S1: Um hello hello. [bc]\nS2: Right.\n");
  assert.deepEqual(split.speakers.map((speaker) => speaker.name), ["S1", "S2"]);
  assert.match(split.speakers[0].raw, /Um hello hello/);
  assert.doesNotMatch(split.speakers[0].tidy, /\[bc\]/);
});

test("verified transcript accepts canonical participants and excludes tagged Teacher turns", () => {
  const parsed = parseVerifiedTranscript(
    "S1: Um, hello.\n\nS2: Mm. [bc]\n\nTeacher: Stop there. [x]\n",
    ["S1", "S2"],
  );
  assert.equal(parsed.status, "passed");
  assert.equal(parsed.participant_turns.length, 2);
  assert.equal(parsed.excluded_turns.length, 1);
  assert.equal(parsed.participant_turns[1].is_backchannel, true);
});

test("verified transcript remains text truth while AssemblyAI supplies only timing seeds", () => {
  const asr = referenceFixture();
  const reference = buildVerifiedTranscriptReference({
    transcriptText: "S1: Um hello there.\nS2: Right.\nTeacher: Stop. [x]\n",
    asrReference: asr,
    participantSpeakers: ["S1", "S2"],
    durationSeconds: 3,
  });
  assert.equal(reference.transcript_status, "researcher_verified_gold");
  assert.equal(reference.words.map((word) => word.normalized_token).join(" "), "um hello there right");
  assert.equal(reference.excluded_transcript_text.includes("Teacher:"), true);
  assert.equal(reference.timing_accuracy_claim, false);
  assert.equal(reference.timing_seed_summary.assemblyai_token_match_count, 3);
  assert.match(buildTimedRawTranscript(reference, "S1"), /^\[\d{2}:\d{2}:\d{2}\.\d{3} --> \d{2}:\d{2}:\d{2}\.\d{3}\] Um hello there\./);
});

test("unmatched backchannels use reviewed TextGrid activity spans instead of global interpolation", () => {
  const reference = buildVerifiedTranscriptReference({
    transcriptText: "S1: Hello there.\nS2: Mm. [bc]\nS1: Continue now.\n",
    participantSpeakers: ["S1", "S2"],
    durationSeconds: 10,
    asrReference: {
      provider_confidence: 0.9,
      words: [
        { word_id: "A1", speaker: "S1", text: "Hello", normalized_token: "hello", start_sec: 1, end_sec: 1.2, confidence: 0.9 },
        { word_id: "A2", speaker: "S1", text: "there", normalized_token: "there", start_sec: 1.3, end_sec: 1.5, confidence: 0.9 },
        { word_id: "A3", speaker: "S1", text: "Continue", normalized_token: "continue", start_sec: 4, end_sec: 4.3, confidence: 0.9 },
        { word_id: "A4", speaker: "S1", text: "now", normalized_token: "now", start_sec: 4.4, end_sec: 4.6, confidence: 0.9 },
      ],
    },
    acousticTiers: [
      { name: "S1", intervals: [] },
      { name: "S2", intervals: [{ start: 2.2, end: 2.5, text: "bc" }] },
    ],
  });
  const backchannel = reference.utterances.find((utterance) => utterance.is_backchannel);
  assert.equal(backchannel.start_sec, 2.2);
  assert.equal(backchannel.end_sec, 2.5);
  assert.equal(backchannel.words[0].timing_source, "researcher_textgrid_bc_span_seed");
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

function pointTier(name, points, xmax = 3) {
  const lines = [
    '        class = "TextTier"',
    `        name = "${name}"`,
    "        xmin = 0",
    `        xmax = ${xmax}`,
    `        points: size = ${points.length}`,
  ];
  points.forEach((point, index) => {
    lines.push(`        points [${index + 1}]:`);
    lines.push(`            number = ${point[0]}`);
    lines.push(`            mark = "${point[1]}"`);
  });
  return lines;
}

function textGridFixture() {
  const tiers = [
    intervalTier("S1", [[0, 1, "s"], [1, 1.5, "op"], [1.5, 3, "s"]]),
    intervalTier("S2", [[0, 2, "pf"], [2, 2.5, "s"], [2.5, 3, "pf"]]),
    intervalTier("floor", [[0, 2, "S1"], [2, 2.5, "S2"], [2.5, 3, "FREE"]]),
    pointTier("transitions", [
      [1.5, "S1>S2 FTO=+0.420 status=provisional"],
      [2.6, "S2>S1 FTO=NA overlap=qualified status=overlap_present_offset_not_measured"],
    ]),
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
