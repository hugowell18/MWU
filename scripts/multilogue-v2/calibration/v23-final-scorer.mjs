#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { parseSixTierTextGridFile } from '../io/parse-six-tier-textgrid.mjs';
import { compareFloorHandoffs, compareSixTierDocuments } from './metrics.mjs';

const OWNER = Object.freeze({
  A: ['active_set_exact_accuracy', 'room_activity_f1', 'boundary_f1_100ms'],
  B: ['active_set_exact_accuracy', 'boundary_f1_100ms'],
  C: ['active_set_exact_accuracy', 'floor_accuracy', 'transition_matched', 'tier5_handoff_matched_100ms'],
  D: ['macro_f1_observed_labels', 'f_f1', 'bc_f1'],
});
const NORMALIZERS = Object.freeze({
  active_set_exact_accuracy: 0.85,
  room_activity_f1: 1,
  boundary_f1_100ms: 0.75,
  floor_accuracy: 0.98,
  transition_matched: 15,
  tier5_handoff_matched_100ms: 15,
  macro_f1_observed_labels: 0.67609,
  f_f1: 0.27108,
  bc_f1: 0.32302,
});

export function scoreV23FinalStage({
  stage,
  candidateRoot,
  goldFile,
  outputFile,
  expectedIndexSha256,
}) {
  if (!Object.hasOwn(OWNER, stage)) throw new Error('invalid scoring stage');
  const candidateSet = verifyCandidateSet({
    stage,
    candidateRoot,
    expectedIndexSha256,
  });
  const gold = parseSixTierTextGridFile(goldFile);
  const rows = candidateSet.candidates.map(({ candidateDir, aggregateSha256 }) => (
    scoreCandidate(stage, candidateDir, aggregateSha256, gold)
  ));
  rows.sort(compareRows);
  const winner = rows[0];
  const report = {
    contract_version: 'v23-final-stage-score-v1',
    stage,
    metric_ownership: OWNER[stage],
    hash_verification: 'candidate_index_and_artifacts_passed_before_gold_scoring',
    candidate_index_sha256: candidateSet.candidateIndexSha256,
    candidate_count: rows.length,
    winner,
    candidates: rows,
  };
  writeFileSync(outputFile, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  return report;
}

export function verifyCandidateSet({ stage, candidateRoot, expectedIndexSha256 }) {
  if (!Object.hasOwn(OWNER, stage)) throw new Error('invalid candidate-set stage');
  if (!/^[a-f0-9]{64}$/i.test(expectedIndexSha256 || '')) {
    throw new Error('expected candidate index SHA256 is required');
  }
  const indexFile = path.join(candidateRoot, 'candidate-index.json');
  const candidateIndexSha256 = fileRecord(indexFile).sha256;
  if (candidateIndexSha256 !== expectedIndexSha256) {
    throw new Error('candidate index SHA256 mismatch');
  }
  const index = readJson(indexFile);
  const expectedCandidateCount = expectedCount(stage);
  if (index.stage !== stage) throw new Error('candidate index stage mismatch');
  if (index.candidate_count !== expectedCandidateCount
    || index.expected_candidate_count !== expectedCandidateCount
    || index.candidates?.length !== expectedCandidateCount) {
    throw new Error('candidate index count mismatch');
  }
  if (!sameArray(index.metric_ownership, OWNER[stage])) {
    throw new Error('candidate index metric ownership mismatch');
  }

  const candidatesRoot = path.join(candidateRoot, 'candidates');
  const actualEntries = readdirSync(candidatesRoot, { withFileTypes: true });
  if (actualEntries.some((item) => !item.isDirectory())) {
    throw new Error('candidate directory set contains an unexpected non-directory entry');
  }
  const actualNames = actualEntries.map((item) => item.name).sort();
  const indexedNames = index.candidates.map((entry) => {
    if (typeof entry.candidate_id !== 'string' || !entry.candidate_id) {
      throw new Error('candidate index id is invalid');
    }
    const expectedRelativeDir = `candidates/${entry.candidate_id}`;
    if (entry.candidate_dir !== expectedRelativeDir) {
      throw new Error(`candidate index directory mismatch: ${entry.candidate_id}`);
    }
    return entry.candidate_id;
  }).sort();
  if (new Set(indexedNames).size !== indexedNames.length) {
    throw new Error('candidate index contains duplicate ids');
  }
  if (!sameArray(actualNames, indexedNames)) {
    throw new Error('candidate directory set does not match frozen index');
  }

  const candidates = index.candidates.map((entry) => {
    const candidateDir = path.join(candidatesRoot, entry.candidate_id);
    const aggregateSha256 = verifyCandidateHashes(candidateDir);
    const hashes = readJson(path.join(candidateDir, 'artifact-hashes.json'));
    const manifest = readJson(path.join(candidateDir, 'generator-manifest.json'));
    if (hashes.candidate_id !== entry.candidate_id || manifest.candidate_id !== entry.candidate_id) {
      throw new Error(`candidate id mismatch: ${entry.candidate_id}`);
    }
    if (manifest.stage !== stage) throw new Error(`candidate stage mismatch: ${entry.candidate_id}`);
    if (!sameArray(manifest.metric_ownership, OWNER[stage])) {
      throw new Error(`candidate metric ownership mismatch: ${entry.candidate_id}`);
    }
    if (stableJson(entry.config) !== stableJson(manifest.config)) {
      throw new Error(`candidate config mismatch: ${entry.candidate_id}`);
    }
    if (entry.aggregate_sha256 !== aggregateSha256 || hashes.aggregate_sha256 !== aggregateSha256) {
      throw new Error(`candidate aggregate hash mismatch: ${entry.candidate_id}`);
    }
    return { candidateDir, aggregateSha256 };
  });
  return { candidateIndexSha256, candidates };
}

export function verifyCandidateHashes(candidateDir) {
  const record = readJson(path.join(candidateDir, 'artifact-hashes.json'));
  for (const [name, expected] of Object.entries(record.files)) {
    const file = path.join(candidateDir, name);
    const actual = fileRecord(file);
    if (actual.sha256 !== expected.sha256 || actual.bytes !== expected.bytes) {
      throw new Error(`candidate hash mismatch: ${name}`);
    }
  }
  const aggregate = hashText(stableJson(record.files));
  if (aggregate !== record.aggregate_sha256) throw new Error('candidate aggregate hash mismatch');
  return record.aggregate_sha256;
}

function scoreCandidate(stage, candidateDir, aggregate, gold) {
  const manifest = readJson(path.join(candidateDir, 'generator-manifest.json'));
  if (manifest.runtime_gold_access !== false) throw new Error('generator manifest does not assert Gold isolation');
  const textGridName = Object.keys(readJson(path.join(candidateDir, 'artifact-hashes.json')).files)
    .find((name) => name.endsWith('.TextGrid'));
  const candidate = parseSixTierTextGridFile(path.join(candidateDir, textGridName));
  const metrics = compareSixTierDocuments(candidate, gold);
  const handoffs = compareFloorHandoffs(candidate, gold, { tolerance: 0.1 });
  const compact = compactMetrics(metrics, handoffs);
  const owned = Object.fromEntries(OWNER[stage].map((key) => [key, compact[key]]));
  const selectionScore = OWNER[stage]
    .reduce((sum, key) => sum + Number(compact[key]) / NORMALIZERS[key], 0);
  return {
    candidate_id: manifest.candidate_id,
    candidate_dir: candidateDir,
    aggregate_sha256: aggregate,
    config: manifest.config,
    structural_digests: manifest.structural_digests,
    owned_metrics: owned,
    selection_score: Number(selectionScore.toFixed(9)),
    metrics: compact,
  };
}

function expectedCount(stage) {
  return { A: 24, B: 8, C: 8, D: 4 }[stage];
}

function sameArray(left, right) {
  return Array.isArray(left) && left.length === right.length
    && left.every((value, index) => value === right[index]);
}

function compactMetrics(metrics, handoffs) {
  const labels = metrics.label_agreement.per_label;
  return {
    active_set_exact_accuracy: metrics.active_speaker_set.exact_accuracy,
    active_set_jaccard: metrics.active_speaker_set.time_weighted_jaccard,
    room_activity_f1: metrics.room_activity.f1,
    boundary_f1_10ms: metrics.active_boundaries.aggregate['0.010'].combined.f1,
    boundary_f1_100ms: metrics.active_boundaries.aggregate['0.100'].combined.f1,
    floor_accuracy: metrics.floor.exact_accuracy,
    floor_mismatch_seconds: metrics.floor.mismatch_seconds,
    transition_matched: metrics.transition_events.matched,
    transition_predicted: metrics.transition_events.predicted,
    transition_gold: metrics.transition_events.gold,
    macro_f1_observed_labels: metrics.label_agreement.macro_f1_observed_gold_labels,
    f_f1: labels.f.f1,
    bc_f1: labels.bc.f1,
    tier5_handoff_matched_100ms: handoffs.matched,
    tier5_handoff_predicted: handoffs.predicted,
    tier5_handoff_gold: handoffs.gold,
    tier5_handoff_f1_100ms: handoffs.f1,
  };
}

function compareRows(left, right) {
  return right.selection_score - left.selection_score || left.candidate_id.localeCompare(right.candidate_id);
}

function fileRecord(file) {
  const bytes = readFileSync(file);
  return { sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length };
}

function hashText(value) {
  return createHash('sha256').update(value).digest('hex');
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function readJson(file) {
  return JSON.parse(readFileSync(file, 'utf8'));
}

function parseArgs(argv) {
  const options = {};
  for (let index = 2; index < argv.length; index += 1) {
    const key = argv[index];
    const value = argv[index + 1];
    if (key === '--stage') options.stage = value;
    else if (key === '--candidate-root') options.candidateRoot = path.resolve(value);
    else if (key === '--expected-index-sha256') options.expectedIndexSha256 = value;
    else if (key === '--gold') options.goldFile = path.resolve(value);
    else if (key === '--output') options.outputFile = path.resolve(value);
    else throw new Error(`unknown scorer argument: ${key}`);
    index += 1;
  }
  return options;
}

function main() {
  const report = scoreV23FinalStage(parseArgs(process.argv));
  process.stdout.write(`${JSON.stringify({ stage: report.stage, winner: report.winner.candidate_id })}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) main();
