#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { parseSixTierTextGridFile } from '../io/parse-six-tier-textgrid.mjs';
import { compareFloorHandoffs, compareSixTierDocuments, deriveFloorHandoffs } from './metrics.mjs';
import { V23C_METRIC_OWNERSHIP } from './v23c-generator.mjs';

const NORMALIZERS = Object.freeze({
  active_set_exact_accuracy: 0.85,
  room_activity_f1: 1,
  boundary_f1_100ms: 0.75,
  bc_f1: 0.32302,
  transition_precision: 0.75,
  floor_accuracy: 0.98,
  transition_matched: 15,
  tier5_handoff_matched_100ms: 15,
  f_f1: 0.27108,
  macro_f1_observed_labels: 0.67609,
});

export function scoreV23cStage({
  stage,
  candidateRoot,
  goldFile,
  outputFile,
  expectedIndexSha256,
  baselineTextGrid = null,
  baselineId = null,
}) {
  const candidateSet = verifyV23cCandidateSet({ stage, candidateRoot, expectedIndexSha256 });
  const gold = parseSixTierTextGridFile(goldFile);
  const rows = candidateSet.candidates.map(({ candidateDir, aggregateSha256 }) =>
    scoreCandidate(stage, candidateDir, aggregateSha256, gold));
  rows.sort(compareRows);
  const bestCandidate = rows[0];
  const baselineEvidence = baselineTextGrid ? baselineRuntimeEvidence(baselineTextGrid) : {};
  const baseline = baselineTextGrid
    ? scoreDocument(stage, parseSixTierTextGridFile(baselineTextGrid), gold, {
      candidate_id: baselineId || 'frozen-prior-winner',
      candidate_dir: baselineTextGrid,
      aggregate_sha256: fileRecord(baselineTextGrid).sha256,
      config: null,
      structural_digests: null,
      attributionEvidence: baselineEvidence.speaker_attribution_disagreements || [],
      responseAcknowledgements: baselineEvidence.pre_floor_response_acknowledgements || [],
      responseConfirmations: baselineEvidence.acoustic_response_boundary_confirmations || [],
      source: 'baseline',
    })
    : null;
  const retainBaseline = baseline && compareRows(bestCandidate, baseline) > 0;
  const winner = retainBaseline ? baseline : bestCandidate;
  const report = {
    contract_version: 'v23c-stage-score-v1',
    stage,
    metric_ownership: V23C_METRIC_OWNERSHIP[stage],
    candidate_index_sha256: candidateSet.candidateIndexSha256,
    candidate_count: rows.length,
    baseline,
    prior_winner_retained: retainBaseline,
    winner,
    candidates: rows,
    gold_schema_consistency: diagnoseGoldTier5Consistency(gold),
  };
  writeFileSync(outputFile, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  return report;
}

export function scoreTextGrid(textGridFile, goldFile) {
  const gold = parseSixTierTextGridFile(goldFile);
  const candidate = parseSixTierTextGridFile(textGridFile);
  return compactMetrics(compareSixTierDocuments(candidate, gold), compareFloorHandoffs(candidate, gold, { tolerance: 0.1 }));
}

export function diagnoseGoldTier5Consistency(gold) {
  const derived = deriveFloorHandoffs(gold);
  const tier = gold.tiers.find((item) => item.name === 'transitions');
  const points = (tier?.points || []).map((point) => {
    const direction = String(point.mark || '').match(/\b(S[123])>(S[123])\b/);
    return {
      number: Number(point.number),
      mark: String(point.mark || ''),
      from: direction?.[1] || null,
      to: direction?.[2] || null,
    };
  });
  const used = new Set();
  const stale = [];
  for (const point of points) {
    const match = derived.findIndex((handoff, index) => !used.has(index)
      && point.from === handoff.from && point.to === handoff.to
      && Math.abs(point.number - handoff.turn_start) <= 0.1 + 1e-9);
    if (match >= 0) used.add(match);
    else stale.push(point);
  }
  return {
    consistent: stale.length === 0 && used.size === derived.length,
    runtime_truth_source: 'floor_derived_handoffs_not_gold_tier5_points',
    gold_tier5_point_count: points.length,
    floor_derived_handoff_count: derived.length,
    stale_tier5_points: stale,
    floor_handoffs_missing_from_tier5: derived.filter((_, index) => !used.has(index)),
  };
}

export function verifyV23cCandidateSet({ stage, candidateRoot, expectedIndexSha256 }) {
  if (!Object.hasOwn(V23C_METRIC_OWNERSHIP, stage)) throw new Error('invalid stage');
  if (!/^[a-f0-9]{64}$/i.test(expectedIndexSha256 || '')) throw new Error('expected index SHA256 is required');
  const indexFile = path.join(candidateRoot, 'candidate-index.json');
  const actualIndexSha = fileRecord(indexFile).sha256;
  if (actualIndexSha !== expectedIndexSha256) throw new Error('candidate index SHA256 mismatch');
  const index = readJson(indexFile);
  if (index.stage !== stage || index.candidate_count !== 8 || index.expected_candidate_count !== 8 || index.candidates?.length !== 8) {
    throw new Error('candidate index count or stage mismatch');
  }
  if (!sameArray(index.metric_ownership, V23C_METRIC_OWNERSHIP[stage])) throw new Error('candidate index metric ownership mismatch');
  const candidatesRoot = path.join(candidateRoot, 'candidates');
  const actualEntries = readdirSync(candidatesRoot, { withFileTypes: true });
  if (actualEntries.some((entry) => !entry.isDirectory())) throw new Error('unexpected candidate-root file');
  const actualNames = actualEntries.map((entry) => entry.name).sort();
  const indexedNames = index.candidates.map((entry) => entry.candidate_id).sort();
  if (!sameArray(actualNames, indexedNames) || new Set(indexedNames).size !== 8) throw new Error('candidate directory set mismatch');
  const candidates = index.candidates.map((entry) => {
    if (entry.candidate_dir !== `candidates/${entry.candidate_id}`) throw new Error('candidate directory contract mismatch');
    const candidateDir = path.join(candidatesRoot, entry.candidate_id);
    const aggregateSha256 = verifyCandidate(candidateDir);
    const manifest = readJson(path.join(candidateDir, 'generator-manifest.json'));
    if (manifest.candidate_id !== entry.candidate_id || manifest.stage !== stage) throw new Error('candidate manifest identity mismatch');
    if (!sameArray(manifest.metric_ownership, V23C_METRIC_OWNERSHIP[stage])) throw new Error('candidate ownership mismatch');
    if (stableJson(manifest.config) !== stableJson(entry.config)) throw new Error('candidate config mismatch');
    if (entry.aggregate_sha256 !== aggregateSha256) throw new Error('candidate aggregate mismatch');
    return { candidateDir, aggregateSha256 };
  });
  return { candidateIndexSha256: actualIndexSha, candidates };
}

function scoreCandidate(stage, candidateDir, aggregate, gold) {
  const manifest = readJson(path.join(candidateDir, 'generator-manifest.json'));
  if (manifest.runtime_gold_access !== false || manifest.network_used !== false || manifest.room_mix_boundary_crossing !== false) {
    throw new Error('candidate violates runtime isolation contract');
  }
  const hashes = readJson(path.join(candidateDir, 'artifact-hashes.json'));
  const textGridName = Object.keys(hashes.files).find((name) => name.endsWith('.TextGrid'));
  const evidence = readJson(path.join(candidateDir, 'runtime-evidence.json'));
  return scoreDocument(stage, parseSixTierTextGridFile(path.join(candidateDir, textGridName)), gold, {
    candidate_id: manifest.candidate_id,
    candidate_dir: candidateDir,
    aggregate_sha256: aggregate,
    config: manifest.config,
    structural_digests: manifest.structural_digests,
    attributionEvidence: evidence.speaker_attribution_disagreements || [],
    responseAcknowledgements: evidence.pre_floor_response_acknowledgements || [],
    responseConfirmations: evidence.acoustic_response_boundary_confirmations || [],
    source: 'candidate',
  });
}

function scoreDocument(stage, candidate, gold, metadata) {
  const metrics = compactMetrics(
    compareSixTierDocuments(candidate, gold),
    compareFloorHandoffs(candidate, gold, { tolerance: 0.1 }),
  );
  const owned = Object.fromEntries(V23C_METRIC_OWNERSHIP[stage].map((key) => [key, metrics[key]]));
  const selectionScore = V23C_METRIC_OWNERSHIP[stage]
    .reduce((sum, key) => sum + Number(metrics[key]) / NORMALIZERS[key], 0);
  const questionAttribution = scoreQuestionAttribution(metadata.attributionEvidence, gold);
  const responseEvidence = scoreResponseEvidence(metadata.responseConfirmations, gold);
  return {
    ...metadata,
    owned_metrics: owned,
    selection_score: Number(selectionScore.toFixed(9)),
    hard_acceptance_failures: questionAttribution.mismatched,
    hard_response_evidence_matches: responseEvidence.matched,
    metrics,
    real_gold_diagnostics: {
      transitions: {
        predicted: metrics.transition_predicted,
        matched: metrics.transition_matched,
        false_positive: metrics.transition_false_positive,
        false_negative: metrics.transition_false_negative,
      },
      speaker_attribution_disagreement_count: metadata.attributionEvidence.length,
      speaker_attribution_disagreement_evidence: metadata.attributionEvidence,
      short_question_attribution: questionAttribution,
      question_response_acknowledgements: metadata.responseAcknowledgements,
      question_response_acoustic_confirmation_evidence: responseEvidence,
    },
  };
}

function compactMetrics(metrics, handoffs) {
  const labels = metrics.label_agreement.per_label;
  const transitionPrecision = metrics.transition_events.predicted > 0
    ? metrics.transition_events.matched / metrics.transition_events.predicted : 0;
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
    transition_precision: Number(transitionPrecision.toFixed(6)),
    transition_false_positive: metrics.transition_events.predicted - metrics.transition_events.matched,
    transition_false_negative: metrics.transition_events.gold - metrics.transition_events.matched,
    macro_f1_observed_labels: metrics.label_agreement.macro_f1_observed_gold_labels,
    f_f1: labels.f.f1,
    bc_f1: labels.bc.f1,
    tier5_handoff_matched_100ms: handoffs.matched,
    tier5_handoff_predicted: handoffs.predicted,
    tier5_handoff_gold: handoffs.gold,
    tier5_handoff_f1_100ms: handoffs.f1,
  };
}

function verifyCandidate(candidateDir) {
  const hashes = readJson(path.join(candidateDir, 'artifact-hashes.json'));
  for (const [name, expected] of Object.entries(hashes.files)) {
    const actual = fileRecord(path.join(candidateDir, name));
    if (actual.sha256 !== expected.sha256 || actual.bytes !== expected.bytes) throw new Error(`candidate hash mismatch: ${name}`);
  }
  const aggregate = hashText(stableJson(hashes.files));
  if (aggregate !== hashes.aggregate_sha256) throw new Error('candidate aggregate mismatch');
  return aggregate;
}

function compareRows(left, right) {
  return left.hard_acceptance_failures - right.hard_acceptance_failures
    || right.hard_response_evidence_matches - left.hard_response_evidence_matches
    || right.selection_score - left.selection_score
    || left.candidate_id.localeCompare(right.candidate_id);
}

function scoreQuestionAttribution(evidence, gold) {
  const questions = (evidence || []).filter((item) => item.short_explicit_question === true
    && item.hard_response_boundary != null);
  const rows = questions.map((item) => {
    const time = (Number(item.start) + Number(item.end)) / 2;
    const goldActive = ['S1', 'S2', 'S3'].filter((speaker) => {
      const tier = gold.tiers.find((candidate) => candidate.name === speaker);
      const interval = tier?.intervals.find((candidate) => candidate.start <= time + 1e-9 && time < candidate.end - 1e-9);
      return ['s', 'f', 'bc', 'ol'].includes(interval?.text);
    });
    return {
      event_id: item.event_id,
      selected_speaker: item.selected_speaker,
      gold_active_speakers: goldActive,
      matched: goldActive.includes(item.selected_speaker),
      runtime_rule: item.decision,
    };
  });
  return {
    evaluated: rows.length,
    matched: rows.filter((item) => item.matched).length,
    mismatched: rows.filter((item) => !item.matched).length,
    rows,
  };
}

function scoreResponseEvidence(evidence, gold) {
  const handoffs = deriveFloorHandoffs(gold);
  const rows = (evidence || []).map((item) => {
    const match = handoffs.find((handoff) => handoff.from === item.preceding_question_speaker
      && handoff.to === item.speaker
      && Math.abs(handoff.turn_start - Number(item.boundary_anchor_start)) <= 0.1 + 1e-9);
    return {
      residual_event_id: item.residual_event_id,
      confirming_event_id: item.confirming_event_id,
      speaker: item.speaker,
      preceding_question_speaker: item.preceding_question_speaker,
      acoustic_onset: Number(item.boundary_anchor_start),
      matched_floor_handoff_sequence: match?.sequence ?? null,
      boundary_error_seconds: match ? Math.abs(match.turn_start - Number(item.boundary_anchor_start)) : null,
      matched: Boolean(match),
      decision: item.decision,
      runtime_evidence_ids: item.runtime_evidence_ids,
    };
  });
  return {
    evaluated: rows.length,
    matched: rows.filter((item) => item.matched).length,
    unmatched: rows.filter((item) => !item.matched).length,
    rows,
  };
}

function baselineRuntimeEvidence(textGridFile) {
  const evidenceFile = path.join(path.dirname(textGridFile), 'runtime-evidence.json');
  return existsSync(evidenceFile) ? readJson(evidenceFile) : {};
}

function sameArray(left, right) {
  return Array.isArray(left) && left.length === right.length && left.every((value, index) => value === right[index]);
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
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
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
    else if (key === '--baseline-textgrid') options.baselineTextGrid = path.resolve(value);
    else if (key === '--baseline-id') options.baselineId = value;
    else throw new Error(`unknown scorer argument: ${key}`);
    index += 1;
  }
  return options;
}

function main() {
  const report = scoreV23cStage(parseArgs(process.argv));
  process.stdout.write(`${JSON.stringify({ stage: report.stage, winner: report.winner.candidate_id, source: report.winner.source })}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) main();
