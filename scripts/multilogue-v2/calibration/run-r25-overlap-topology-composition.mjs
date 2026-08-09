#!/usr/bin/env node

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { generateR16TopologyCandidates } from './r16-topology-generator.mjs';
import { selectOverlapCorroboratedBackchannels } from './overlap-semantic-preservation.mjs';
import { scoreR16TopologyCandidates } from './r16-topology-scorer.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const RECORDING_ID = 'Multilogue04_C_Level30_D1G4';
const CALIBRATION_ROOT = path.join(ROOT, 'outputs', 'multilogue-v2-calibration', RECORDING_ID, 'P025');
const DEFAULT_OUTPUT = path.join(CALIBRATION_ROOT, 'v2.3t-r25-overlap-topology-composition-20260809');
const R19_SCORE = path.join(CALIBRATION_ROOT, 'v2.3n-r19-offset-search-a-20260809', 'score.json');
const R24_SCORE = path.join(CALIBRATION_ROOT, 'v2.3s-r24-final-pass-20260809', 'score.json');
const GOLD = path.join(ROOT, 'outputs', 'multilogue-v2-poc', `${RECORDING_ID}_P025_corrected_6tier.TextGrid`);

export function runR25OverlapTopologyComposition({
  outputDir = DEFAULT_OUTPUT,
  semanticScoreFile = R24_SCORE,
  preservationPolicy = 'all',
} = {}) {
  if (existsSync(outputDir)) throw new Error(`R25 output already exists: ${outputDir}`);
  const r19 = readJson(R19_SCORE);
  const r24 = readJson(semanticScoreFile);
  if (r24.winner?.source !== 'candidate') throw new Error('R24 overlap-corroboration candidate was not promoted');
  const semanticTextGrid = findCandidateTextGrid(r24.winner.candidate_dir);
  const semanticRuntimeEvidence = readJson(path.join(r24.winner.candidate_dir, 'runtime-evidence.json'));
  const preserveSemanticActivityIntervals = selectOverlapCorroboratedBackchannels(
    semanticRuntimeEvidence,
    preservationPolicy,
  );
  const configs = [
    { mode: 'semantic_control', name: 'r24_semantic_control' },
    { ...r19.winner.topology_config, name: 'r19_frozen_topology_over_r24_semantics' },
  ];
  const candidateRoot = path.join(outputDir, 'candidates');
  const generated = generateR16TopologyCandidates({
    outputDir: candidateRoot,
    semanticTextGridFile: semanticTextGrid,
    configs,
    preserveSemanticActivityIntervals,
  });
  mkdirSync(outputDir, { recursive: true });
  const score = scoreR16TopologyCandidates({
    candidateRoot,
    expectedIndexSha256: generated.candidateIndexSha256,
    goldFile: GOLD,
    outputFile: path.join(outputDir, 'score.json'),
  });
  const report = {
    contract_version: 'r25-overlap-topology-composition-report-v1',
    runtime_gold_access: false,
    generation_network_used: false,
    gold_usage: 'scorer_only',
    semantic_source: semanticTextGrid,
    semantic_score_source: semanticScoreFile,
    topology_source: r19.winner.textgrid,
    preserved_overlap_backchannel_evidence_count: preserveSemanticActivityIntervals.length,
    preserved_overlap_backchannel_evidence: preserveSemanticActivityIntervals,
    preservation_policy: preservationPolicy,
    winner: score.winner,
    control: score.control,
    delta_vs_r24_semantic_control: metricDelta(score.winner.metrics, score.control.metrics),
    formal_gate: score.formal_gate,
  };
  writeFileSync(path.join(outputDir, 'r25-report.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  return { outputDir, report };
}

function findCandidateTextGrid(candidateDir) {
  const hashes = readJson(path.join(candidateDir, 'artifact-hashes.json'));
  const name = Object.keys(hashes.files).find((item) => item.endsWith('.TextGrid'));
  if (!name) throw new Error(`TextGrid missing in ${candidateDir}`);
  return path.join(candidateDir, name);
}

function metricDelta(after, before) {
  return Object.fromEntries(Object.keys(after).filter((key) => Number.isFinite(Number(after[key]))
    && Number.isFinite(Number(before[key]))).map((key) => [key, Number((Number(after[key]) - Number(before[key])).toFixed(9))]));
}

function readJson(file) {
  return JSON.parse(readFileSync(file, 'utf8'));
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const outputIndex = process.argv.indexOf('--output-dir');
  const outputDir = outputIndex >= 0 ? path.resolve(process.argv[outputIndex + 1]) : DEFAULT_OUTPUT;
  const semanticScoreIndex = process.argv.indexOf('--semantic-score');
  const semanticScoreFile = semanticScoreIndex >= 0
    ? path.resolve(process.argv[semanticScoreIndex + 1])
    : R24_SCORE;
  const policyIndex = process.argv.indexOf('--preservation-policy');
  const preservationPolicy = policyIndex >= 0 ? process.argv[policyIndex + 1] : 'all';
  const result = runR25OverlapTopologyComposition({ outputDir, semanticScoreFile, preservationPolicy });
  process.stdout.write(`${JSON.stringify({
    output_dir: result.outputDir,
    winner: result.report.winner.candidate_id,
    metrics: result.report.winner.metrics,
    gate: result.report.formal_gate,
  })}\n`);
}
