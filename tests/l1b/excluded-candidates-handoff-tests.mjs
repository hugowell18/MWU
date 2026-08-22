import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { buildL1aPathBEvidence } from '../../scripts/l1a/build-path-b-evidence.mjs';
import {
  completeProviderRun,
  confirmReview,
  createL1aRun,
  saveReviewDraft,
} from '../../scripts/l1a/review-core.mjs';
import { runFromAcceptedL1a } from '../../scripts/l1b/run-from-l1a.mjs';
import { parseSixTierTextGridFile } from '../../scripts/multilogue-v2/io/parse-six-tier-textgrid.mjs';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mwu-l1b-exclude-'));
let passed = 0;
let failed = 0;

try {
  await runCase([1], 3);
  await runCase([1, 3], 2);
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}

process.stdout.write(`\nL1B EXCLUDED CANDIDATES: ${passed} passed / ${failed} failed\n`);
if (failed) process.exitCode = 1;

async function runCase(excludedIndexes, expectedSpeakers) {
  const title = `four candidates excluding ${excludedIndexes.length} produces ${expectedSpeakers}-speaker L1b`;
  try {
    const fixture = await buildAcceptedL1a(excludedIndexes);
    assert.deepEqual(fixture.manifest.speakers, canonicalSpeakers(expectedSpeakers));
    assert.equal(fixture.manifest.outputs.muted_mirror_wavs.length, expectedSpeakers);

    const acceptedTurns = JSON.parse(fs.readFileSync(fixture.manifest.outputs.speaker_turns_json, 'utf8')).turns;
    assert.deepEqual([...new Set(acceptedTurns.map((turn) => turn.speaker))].sort(), canonicalSpeakers(expectedSpeakers));

    const assemblyPath = path.join(fixture.acceptedDir, 'assemblyai-with-all-four-candidates.json');
    fs.writeFileSync(assemblyPath, `${JSON.stringify(assemblyEvidence(), null, 2)}\n`);
    const pathB = buildL1aPathBEvidence({ manifestPath: fixture.manifestPath, assemblyaiPath: assemblyPath });
    assert.equal(pathB.ready_for_path_b, true, JSON.stringify(pathB.blockers));
    assert.equal(Object.keys(pathB.provider_comparison.mapping_candidate_to_reference).length, expectedSpeakers);
    assert.equal(pathB.provider_comparison.reference.speaker_count, 4);
    assert.equal(pathB.provider_comparison.candidate.speaker_count, expectedSpeakers);

    const l1b = await runFromAcceptedL1a({
      manifestPath: fixture.manifestPath,
      out: path.join(fixture.caseRoot, 'L1b-output'),
      thresholds: [0.25, 0.35],
      progressFile: path.join(fixture.caseRoot, 'progress.json'),
    });
    assert.equal(l1b.report.status, 'ready_for_praat_review');
    assert.equal(l1b.report.speaker_count, expectedSpeakers);
    assert.equal(l1b.report.tier_count, expectedSpeakers + 3);

    for (const threshold of l1b.report.threshold_reports) {
      const document = parseSixTierTextGridFile(threshold.textgrid);
      assert.deepEqual(
        document.tiers.map((tier) => tier.name),
        [...canonicalSpeakers(expectedSpeakers), 'floor', 'transitions', 'flags'],
      );
      const serialized = fs.readFileSync(threshold.textgrid, 'utf8');
      assert.doesNotMatch(serialized, /P[0-3]|A[0-3]|SPEAKER_/);
      for (const excludedIndex of excludedIndexes) {
        const midpoint = (providerTurns()[excludedIndex].start + providerTurns()[excludedIndex].end) / 2;
        for (const speaker of canonicalSpeakers(expectedSpeakers)) {
          const tier = document.tiers.find((item) => item.name === speaker);
          assert.equal(labelAt(tier, midpoint), 'x', `${speaker} must mark excluded activity as x at ${midpoint}`);
        }
      }
    }
    passed += 1;
    process.stdout.write(`PASS ${title}\n`);
  } catch (error) {
    failed += 1;
    process.stderr.write(`FAIL ${title}\n${error.stack || error.message}\n`);
  }
}

async function buildAcceptedL1a(excludedIndexes) {
  const key = excludedIndexes.join('-') || 'none';
  const caseRoot = path.join(root, `exclude-${key}`);
  const reviewRoot = path.join(caseRoot, 'sessions');
  const acceptedRoot = path.join(caseRoot, 'accepted');
  const runId = `exclude-${key}-run`;
  const created = createL1aRun({
    root: reviewRoot,
    filename: `exclude-${key}.wav`,
    wavBuffer: wavBuffer(4),
    runId,
  });
  completeProviderRun({
    root: reviewRoot,
    runId,
    turns: providerTurns(),
    provider: { source: 'synthetic-four-candidate-provider', model: 'fixture' },
  });
  const excluded = new Set(excludedIndexes);
  let canonicalIndex = 0;
  const decisions = providerTurns().map((turn, index) => {
    if (excluded.has(index)) {
      return {
        candidate_id: turn.speaker,
        decision: 'exclude',
        role: 'other_or_incidental',
        canonical_speaker: null,
        merge_into: null,
        note: 'Excluded by researcher fixture',
      };
    }
    canonicalIndex += 1;
    return {
      candidate_id: turn.speaker,
      decision: 'include',
      role: 'participant',
      canonical_speaker: `S${canonicalIndex}`,
      merge_into: null,
      note: '',
    };
  });
  saveReviewDraft({ root: reviewRoot, runId, payload: { reviewer: 'exclude-e2e-rater', decisions } });
  const confirmed = await confirmReview({ root: reviewRoot, acceptedRoot, runId: created.state.run_id });
  return {
    caseRoot,
    acceptedDir: confirmed.acceptedDir,
    manifest: confirmed.manifest,
    manifestPath: confirmed.manifestPath,
  };
}

function providerTurns() {
  return [
    { speaker: 'P0', start: 0.2, end: 0.7, confidence: 0.95 },
    { speaker: 'P1', start: 1.0, end: 1.5, confidence: 0.95 },
    { speaker: 'P2', start: 1.8, end: 2.3, confidence: 0.95 },
    { speaker: 'P3', start: 2.6, end: 3.1, confidence: 0.95 },
  ];
}

function assemblyEvidence() {
  const utterances = providerTurns().map((turn, index) => ({
    speaker: `A${index}`,
    start: Math.round(turn.start * 1000),
    end: Math.round(turn.end * 1000),
    confidence: 0.95,
    text: `word${index + 1}`,
  }));
  return {
    audio_duration: 4,
    speech_model_used: 'synthetic-four-speaker-evidence',
    speakers_expected: 4,
    disfluencies: true,
    utterances,
    words: utterances.map((utterance) => ({ ...utterance })),
  };
}

function labelAt(tier, time) {
  return tier.intervals.find((interval) => interval.start <= time && time < interval.end)?.text || null;
}

function canonicalSpeakers(count) {
  return Array.from({ length: count }, (_, index) => `S${index + 1}`);
}

function wavBuffer(durationSeconds) {
  const sampleRate = 16_000;
  const sampleCount = Math.ceil(durationSeconds * sampleRate);
  const dataBytes = sampleCount * 2;
  const buffer = Buffer.alloc(44 + dataBytes);
  buffer.write('RIFF', 0);
  buffer.writeUInt32LE(36 + dataBytes, 4);
  buffer.write('WAVEfmt ', 8);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * 2, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write('data', 36);
  buffer.writeUInt32LE(dataBytes, 40);
  for (let index = 0; index < sampleCount; index += 1) {
    buffer.writeInt16LE(Math.round(Math.sin(2 * Math.PI * 220 * index / sampleRate) * 10_000), 44 + index * 2);
  }
  return buffer;
}
