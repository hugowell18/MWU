#!/usr/bin/env node

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { parseSixTierTextGridFile } from '../io/parse-six-tier-textgrid.mjs';
import { compareSixTierDocuments, deriveFloorHandoffs } from './metrics.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const RECORDING_ID = 'Multilogue04_C_Level30_D1G4';
const CALIBRATION_ROOT = path.join(ROOT, 'outputs', 'multilogue-v2-calibration', RECORDING_ID, 'P025');
const GOLD = path.join(ROOT, 'outputs', 'multilogue-v2-poc', `${RECORDING_ID}_P025_corrected_6tier.TextGrid`);
const ORIGINAL = path.join(ROOT, 'outputs', 'multilogue-v2-poc', RECORDING_ID, 'phase-ii', 'P025', `${RECORDING_ID}.P025.draft.6tier.TextGrid`);
const R19_SCORE = path.join(CALIBRATION_ROOT, 'v2.3n-r19-offset-search-a-20260809', 'score.json');
const LATEST_SCORE = path.join(CALIBRATION_ROOT, 'v2.3za-r32-schema-valid-composition-20260809', 'score.json');
const DEFAULT_OUTPUT = path.join(CALIBRATION_ROOT, 'v2.3za-r32-schema-valid-composition-20260809', 'customer-edge-case-score.json');

const WINDOWS = Object.freeze([
  { id: 'complex_overlap_question_answer', start: 41.5, end: 47 },
  { id: 'tail_spurious_transitions', start: 485, end: 495 },
]);

export function scoreCustomerEdgeCases({
  outputFile = DEFAULT_OUTPUT,
  candidateScoreFile = LATEST_SCORE,
} = {}) {
  const files = {
    original_v21: ORIGINAL,
    r19: readJson(R19_SCORE).winner.textgrid,
    latest: readJson(candidateScoreFile).winner.textgrid,
    gold: GOLD,
  };
  const documents = Object.fromEntries(Object.entries(files).map(([key, file]) => [key, parseSixTierTextGridFile(file)]));
  const report = {
    contract_version: 'customer-edge-case-score-v1',
    gold_usage: 'scorer_only',
    files,
    windows: WINDOWS.map((window) => {
      const gold = clipDocument(documents.gold, window.start, window.end);
      const versions = Object.fromEntries(['original_v21', 'r19', 'latest'].map((version) => {
        const candidate = clipDocument(documents[version], window.start, window.end);
        return [version, summarize(candidate, gold)];
      }));
      return {
        ...window,
        gold: summarizeGold(gold),
        versions,
        delta_latest_vs_original: numericDelta(versions.latest, versions.original_v21),
        delta_latest_vs_r19: numericDelta(versions.latest, versions.r19),
      };
    }),
  };
  mkdirSync(path.dirname(outputFile), { recursive: true });
  writeFileSync(outputFile, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  return report;
}

function summarize(candidate, gold) {
  const metrics = compareSixTierDocuments(candidate, gold);
  return {
    speaker_label_exact_accuracy: metrics.label_agreement.exact_accuracy,
    active_set_exact_accuracy: metrics.active_speaker_set.exact_accuracy,
    active_set_jaccard: metrics.active_speaker_set.time_weighted_jaccard,
    boundary_f1_100ms: metrics.active_boundaries.aggregate['0.100'].combined.f1,
    floor_exact_accuracy: metrics.floor.exact_accuracy,
    bc_precision: metrics.label_agreement.per_label.bc.precision,
    bc_recall: metrics.label_agreement.per_label.bc.recall,
    bc_f1: metrics.label_agreement.per_label.bc.f1,
    tr_interval_precision: metrics.label_agreement.per_label.tr.precision,
    tr_interval_recall: metrics.label_agreement.per_label.tr.recall,
    tr_interval_f1: metrics.label_agreement.per_label.tr.f1,
    bc_seconds: labelSeconds(candidate, 'bc'),
    tr_seconds: labelSeconds(candidate, 'tr'),
    floor_handoffs: deriveFloorHandoffs(candidate),
  };
}

function summarizeGold(document) {
  return {
    bc_seconds: labelSeconds(document, 'bc'),
    tr_seconds: labelSeconds(document, 'tr'),
    floor_handoffs: deriveFloorHandoffs(document),
  };
}

function clipDocument(document, start, end) {
  const duration = end - start;
  return {
    xmin: 0,
    xmax: duration,
    tiers: document.tiers.map((tier) => tier.class === 'TextTier' ? {
      ...tier,
      xmin: 0,
      xmax: duration,
      points: (tier.points || []).filter((point) => point.number >= start && point.number <= end)
        .map((point) => ({ ...point, number: point.number - start })),
    } : {
      ...tier,
      xmin: 0,
      xmax: duration,
      intervals: (tier.intervals || []).map((interval) => ({
        start: Math.max(start, interval.start),
        end: Math.min(end, interval.end),
        text: interval.text,
      })).filter((interval) => interval.end > interval.start)
        .map((interval) => ({ ...interval, start: interval.start - start, end: interval.end - start })),
    }),
  };
}

function labelSeconds(document, label) {
  return Number(document.tiers.filter((tier) => ['S1', 'S2', 'S3'].includes(tier.name))
    .flatMap((tier) => tier.intervals || [])
    .filter((interval) => interval.text === label)
    .reduce((sum, interval) => sum + interval.end - interval.start, 0).toFixed(6));
}

function numericDelta(after, before) {
  return Object.fromEntries(Object.keys(after).filter((key) => Number.isFinite(Number(after[key]))
    && Number.isFinite(Number(before[key]))).map((key) => [key, Number((Number(after[key]) - Number(before[key])).toFixed(9))]));
}

function readJson(file) {
  return JSON.parse(readFileSync(file, 'utf8'));
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const outputIndex = process.argv.indexOf('--output');
  const outputFile = outputIndex >= 0 ? path.resolve(process.argv[outputIndex + 1]) : DEFAULT_OUTPUT;
  const candidateIndex = process.argv.indexOf('--candidate-score');
  const candidateScoreFile = candidateIndex >= 0
    ? path.resolve(process.argv[candidateIndex + 1])
    : LATEST_SCORE;
  const report = scoreCustomerEdgeCases({ outputFile, candidateScoreFile });
  process.stdout.write(`${JSON.stringify({ output: outputFile, windows: report.windows }, null, 2)}\n`);
}
