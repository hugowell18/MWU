import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { generateFrozenBlindDraft } from '../../scripts/multilogue-v2/blind/generate-frozen-v23-blind-draft.mjs';
import { parseSixTierTextGridFile } from '../../scripts/multilogue-v2/io/parse-six-tier-textgrid.mjs';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mwu-dynamic-l1b-'));
let passed = 0;
let failed = 0;

try {
  for (const speakerCount of [2, 3, 4, 6]) {
    await test(`full L1b draft adapts to ${speakerCount} accepted speakers`, () => {
      const fixture = buildFixture(speakerCount);
      const generated = generateFrozenBlindDraft({
        recordingId: fixture.recordingId,
        stage1File: fixture.stage1File,
        acousticManifestFile: fixture.manifestFile,
        mappingFile: fixture.mappingFile,
        outputDir: fixture.outputDir,
        pauseThresholdSeconds: 0.25,
      });
      const document = parseSixTierTextGridFile(generated.textGridFile);
      const expectedSpeakers = canonicalSpeakers(speakerCount);
      assert.deepEqual(
        document.tiers.map((tier) => tier.name),
        [...expectedSpeakers, 'floor', 'transitions', 'flags'],
      );
      assert.equal(document.tiers.length, speakerCount + 3);
      assert.equal(generated.validation.valid, true);
      assert.equal(generated.summary.speaker_count, speakerCount);
      assert.equal(generated.summary.tier_count, speakerCount + 3);
      assert.match(path.basename(generated.textGridFile), new RegExp(`\\.${speakerCount + 3}tier\\.TextGrid$`));
      for (const speaker of expectedSpeakers) {
        const tier = document.tiers.find((item) => item.name === speaker);
        assert.equal(tier.intervals[0].start, 0);
        assert.equal(tier.intervals.at(-1).end, document.xmax);
      }
    });
  }
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}

process.stdout.write(`\nL1B DYNAMIC N+3: ${passed} passed / ${failed} failed\n`);
if (failed) process.exitCode = 1;

async function test(name, fn) {
  try {
    await fn();
    passed += 1;
    process.stdout.write(`PASS ${name}\n`);
  } catch (error) {
    failed += 1;
    process.stderr.write(`FAIL ${name}\n${error.stack || error.message}\n`);
  }
}

function buildFixture(speakerCount) {
  const speakers = canonicalSpeakers(speakerCount);
  const recordingId = `dynamic_${speakerCount}_speaker_fixture`;
  const directory = path.join(root, recordingId);
  fs.mkdirSync(directory, { recursive: true });
  const duration = speakerCount * 0.6 + 0.4;
  const sourceWav = path.join(directory, 'source.wav');
  writeSineWav(sourceWav, duration);

  const pyannote = Object.fromEntries(speakers.map((speaker, index) => [`P${index}`, speaker]));
  const assemblyai = Object.fromEntries(speakers.map((speaker, index) => [`A${index}`, speaker]));
  const turns = speakers.map((speaker, index) => ({
    index,
    id: `turn_${index + 1}`,
    speaker: `P${index}`,
    start: round(0.1 + index * 0.6),
    end: round(0.5 + index * 0.6),
    confidence: 0.95,
  }));
  const turnsFile = path.join(directory, 'turns.json');
  writeJson(turnsFile, { turns });
  const mirrors = turns.map((turn) => {
    const mirror = path.join(directory, `speaker_${turn.speaker}.wav`);
    fs.copyFileSync(sourceWav, mirror);
    return { speaker: `speaker_${turn.speaker}`, muted_mirror_wav: mirror };
  });
  const manifestFile = path.join(directory, 'manifest.json');
  writeJson(manifestFile, {
    duration_seconds: duration,
    method: { provider: 'pyannoteAI-fixture' },
    outputs: { speaker_turns_json: turnsFile, muted_mirror_wavs: mirrors },
  });
  const mappingFile = path.join(directory, 'mapping.json');
  writeJson(mappingFile, { speakers, mapping: { pyannote, assemblyai } });

  const words = speakers.map((speaker, index) => ({
    id: `aa_word_${String(index + 1).padStart(5, '0')}`,
    speaker: `A${index}`,
    start: turns[index].start,
    end: turns[index].end,
    confidence: 0.95,
  }));
  const stage1Evidence = words.map((word, index) => ({
    id: `event_${word.id}`,
    speaker: speakers[index],
    start: word.start,
    end: word.end,
    confidence: word.confidence,
    provisional_kind: 'vocalisation',
    lexical_class: 'lexical',
    evidence_state: 'known',
    tokens: ['hello'],
  }));
  const stage1File = path.join(directory, 'stage1.json');
  writeJson(stage1File, {
    methodologyVersion: 'dynamic-n-plus-3-test-fixture',
    recordingId,
    taskId: 'whole-recording-single-task',
    duration,
    thresholds: [0.25],
    speakers,
    speakerMapping: { pyannote, assemblyai },
    attributionTurns: turns,
    words,
    roomSoundingIntervals: turns.map(({ start, end }) => ({ start, end })),
    sharedActivityOptions: { minSoundingSeconds: 0.1 },
    stage1Evidence,
    stage1UnknownEvidence: [],
    providerOverlapEvidence: [],
    providerOverlapCandidates: [],
    initialFlags: [],
    interactionConfig: { overlapMode: 'path_b_exclusive', floorReleaseSeconds: 1, minOverlapSeconds: 0.1 },
  });
  return { recordingId, stage1File, manifestFile, mappingFile, outputDir: path.join(directory, 'output') };
}

function canonicalSpeakers(count) {
  return Array.from({ length: count }, (_, index) => `S${index + 1}`);
}

function writeJson(file, value) {
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function round(value) {
  return Math.round(value * 1_000_000) / 1_000_000;
}

function writeSineWav(file, durationSeconds) {
  const sampleRate = 16_000;
  const samples = Math.ceil(durationSeconds * sampleRate);
  const dataBytes = samples * 2;
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
  for (let index = 0; index < samples; index += 1) {
    const value = Math.round(Math.sin(2 * Math.PI * 220 * index / sampleRate) * 10_000);
    buffer.writeInt16LE(value, 44 + index * 2);
  }
  fs.writeFileSync(file, buffer);
}
