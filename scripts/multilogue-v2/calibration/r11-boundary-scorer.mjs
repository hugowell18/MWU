#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { scoreTextGrid } from './v23c-scorer.mjs';

export const R11_TARGETS = Object.freeze({
  active_set_exact_accuracy: 0.85,
  boundary_f1_100ms: 0.75,
  floor_accuracy: 0.98,
  transition_matched: 15,
  tier5_handoff_matched_100ms: 15,
  macro_f1_observed_labels: 0.67609,
  f_f1: 0.27108,
  bc_f1: 0.32302,
});

export function scoreR11BoundaryCandidates({ candidateRoot, expectedIndexSha256, goldFile, outputFile }) {
  const indexFile = path.join(candidateRoot, 'candidate-index.json');
  if (fileRecord(indexFile).sha256 !== expectedIndexSha256) throw new Error('R11 candidate index SHA mismatch');
  const index = readJson(indexFile);
  if (index.runtime_gold_access !== false || index.candidate_count !== index.expected_candidate_count) throw new Error('R11 index contract invalid');
  const actualNames = readdirSync(path.join(candidateRoot, 'candidates'), { withFileTypes: true })
    .filter((item) => item.isDirectory()).map((item) => item.name).sort();
  const indexedNames = index.candidates.map((item) => item.candidate_id).sort();
  if (JSON.stringify(actualNames) !== JSON.stringify(indexedNames)) throw new Error('R11 candidate set mismatch');
  const rows = index.candidates.map((candidate) => scoreCandidate(candidateRoot, candidate, goldFile));
  const control = rows.find((row) => row.boundary_config.enabled === false);
  if (!control) throw new Error('R11 control candidate missing');
  const eligible = rows.filter((row) => semanticGate(row.metrics));
  const ranked = (eligible.length ? eligible : rows).sort(compareRows);
  const winner = ranked[0];
  const report = {
    contract_version: 'r11-boundary-score-v1',
    candidate_index_sha256: expectedIndexSha256,
    candidate_count: rows.length,
    control,
    winner,
    formal_gate: formalGate(winner.metrics),
    candidates: rows.sort((left, right) => left.candidate_id.localeCompare(right.candidate_id)),
    selection_policy: 'retain seven R10 semantic KPI gates, then maximize boundary_f1_100ms',
    gold_usage: 'scorer_only',
  };
  writeFileSync(outputFile, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  return report;
}

function scoreCandidate(root, candidate, goldFile) {
  const dir = path.join(root, candidate.candidate_dir);
  const manifest = readJson(path.join(dir, 'generator-manifest.json'));
  if (manifest.runtime_gold_access !== false || manifest.network_used !== false || manifest.room_mix_boundary_crossing !== false) {
    throw new Error('R11 candidate runtime isolation violation');
  }
  verifyHashes(dir, candidate.aggregate_sha256);
  const textGridName = readdirSync(dir).find((name) => name.endsWith('.TextGrid'));
  const metrics = scoreTextGrid(path.join(dir, textGridName), goldFile);
  const evidence = readJson(path.join(dir, 'runtime-evidence.json'));
  return {
    candidate_id: candidate.candidate_id,
    candidate_dir: dir,
    textgrid: path.join(dir, textGridName),
    boundary_config: candidate.boundary_config,
    boundary_stats: evidence.boundary_refinement.stats,
    boundary_move_count: evidence.boundary_refinement.moves.length,
    semantic_digest_unchanged: evidence.semantic_digest_before === evidence.semantic_digest_after,
    tier5_consistent: evidence.tier5_internal_consistency.pass,
    metrics,
    gate: formalGate(metrics),
  };
}

function semanticGate(metrics) {
  return Object.entries(R11_TARGETS).every(([key, target]) => key === 'boundary_f1_100ms' || Number(metrics[key]) >= target);
}

function compareRows(left, right) {
  return Number(right.metrics.boundary_f1_100ms) - Number(left.metrics.boundary_f1_100ms)
    || Number(right.metrics.active_set_exact_accuracy) - Number(left.metrics.active_set_exact_accuracy)
    || left.boundary_move_count - right.boundary_move_count
    || left.candidate_id.localeCompare(right.candidate_id);
}

function formalGate(metrics) {
  const results = Object.fromEntries(Object.entries(R11_TARGETS).map(([key, target]) => [key, {
    target, actual: Number(metrics[key]), met: Number(metrics[key]) >= target,
  }]));
  const passed = Object.values(results).filter((item) => item.met).length;
  return { pass: passed === 8, passed_kpi_count: passed, required_kpi_count: 8, results };
}

function verifyHashes(dir, aggregateExpected) {
  const document = readJson(path.join(dir, 'artifact-hashes.json'));
  for (const [name, expected] of Object.entries(document.files)) {
    const actual = fileRecord(path.join(dir, name));
    if (actual.sha256 !== expected.sha256 || actual.bytes !== expected.bytes) throw new Error(`R11 hash mismatch: ${name}`);
  }
  if (hashText(stableJson(document.files)) !== aggregateExpected) throw new Error('R11 aggregate hash mismatch');
}

function fileRecord(file) { const bytes = readFileSync(file); return { sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length }; }
function hashText(value) { return createHash('sha256').update(value).digest('hex'); }
function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}
function readJson(file) { return JSON.parse(readFileSync(file, 'utf8')); }

function parseArgs(argv) {
  const options = {};
  for (let index = 2; index < argv.length; index += 2) {
    const key = argv[index]; const value = argv[index + 1];
    if (key === '--candidate-root') options.candidateRoot = path.resolve(value);
    else if (key === '--expected-index-sha256') options.expectedIndexSha256 = value;
    else if (key === '--gold') options.goldFile = path.resolve(value);
    else if (key === '--output') options.outputFile = path.resolve(value);
    else throw new Error(`unknown R11 scorer argument: ${key}`);
  }
  return options;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const report = scoreR11BoundaryCandidates(parseArgs(process.argv));
  process.stdout.write(`${JSON.stringify({ winner: report.winner.candidate_id, gate: report.formal_gate })}\n`);
}
