#!/usr/bin/env node

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  computeLocalAcousticVad,
  computeLocalAcousticVadFromPrepared,
  defaultVadOptions,
  estimateThreshold,
  prepareLocalAcousticVad,
} from '../../scripts/local-acoustic-vad.mjs';
import { runP025Calibration } from '../../scripts/multilogue-v2/calibration/run-p025-calibration.mjs';
import { runP025V22Calibration } from '../../scripts/multilogue-v2/calibration/run-p025-v22-calibration.mjs';
import {
  compareFloorHandoffs,
  compareSixTierDocuments,
  deriveFloorHandoffs,
  validateTier5Consistency,
} from '../../scripts/multilogue-v2/calibration/metrics.mjs';
import { parseSixTierTextGridFile } from '../../scripts/multilogue-v2/io/parse-six-tier-textgrid.mjs';
import { runInteractionEngine } from '../../scripts/multilogue-v2/core/interaction-engine.mjs';
import { validateSixTierTextGrid } from '../../scripts/multilogue-v2/core/validator.mjs';
import {
  buildBaseActivityFrames,
  deriveSharedActivity,
  normalizeStage1Evidence,
} from '../../scripts/multilogue-v2/core/timeline.mjs';
import {
  buildPhraseEvents,
  buildV22Stage1Candidate,
  promoteResidualEvidence,
} from '../../scripts/multilogue-v2/adapters/build-v22-stage1-candidate.mjs';
import {
  applySpeakerConditionedIdentity,
  assignV23cEvidenceRoles,
} from '../../scripts/multilogue-v2/adapters/build-v23c-stage1-candidate.mjs';
import {
  assignEvidenceRoles,
} from '../../scripts/multilogue-v2/adapters/build-v23-stage1-candidate.mjs';
import {
  findStableBoundaryCrossing,
  prepareSmoothedCrossingEvidence,
  refineProviderBoundariesAtCrossings,
} from '../../scripts/multilogue-v2/acoustic/local-boundary-crossing.mjs';
import { stageConfigs } from '../../scripts/multilogue-v2/calibration/v23-final-generator.mjs';
import { verifyCandidateHashes, verifyCandidateSet } from '../../scripts/multilogue-v2/calibration/v23-final-scorer.mjs';
import { generateV23cStage } from '../../scripts/multilogue-v2/calibration/v23c-generator.mjs';
import { scoreV23cStage } from '../../scripts/multilogue-v2/calibration/v23c-scorer.mjs';
import { refineSpeakerLocalPhraseBoundaries } from '../../scripts/multilogue-v2/acoustic/speaker-local-boundary-refinement.mjs';
import { splitSpeakerLocalInternalGaps } from '../../scripts/multilogue-v2/acoustic/speaker-local-internal-gap-refinement.mjs';
import { promoteUncoveredSpeakerActivity } from '../../scripts/multilogue-v2/acoustic/speaker-local-uncovered-activity.mjs';
import { composeActivityTopologyWithSemantics } from '../../scripts/multilogue-v2/calibration/activity-semantic-composer.mjs';
import {
  classifyEvidenceMode,
  FROZEN_BLIND_CONFIG,
} from '../../scripts/multilogue-v2/blind/generate-frozen-v23-blind-draft.mjs';

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(TEST_DIR, '../..');
const GOLD = path.join(ROOT, 'outputs', 'multilogue-v2-poc', 'Multilogue04_C_Level30_D1G4_P025_corrected_6tier.TextGrid');
const BASELINE = path.join(
  ROOT,
  'outputs', 'multilogue-v2-poc', 'Multilogue04_C_Level30_D1G4', 'phase-ii', 'P025',
  'Multilogue04_C_Level30_D1G4.P025.draft.6tier.TextGrid',
);
const ARTIFACT = path.join(TEST_DIR, 'artifacts', 'test-report.json');
const V23_FINAL = path.join(
  ROOT, 'outputs', 'multilogue-v2-calibration', 'Multilogue04_C_Level30_D1G4', 'P025', 'v2.3-final',
);
const results = [];

function test(name, body) {
  try {
    body();
    results.push({ name, status: 'passed' });
  } catch (error) {
    results.push({ name, status: 'failed', error: String(error?.stack || error) });
  }
}

test('default VAD parameters remain unchanged', () => {
  assert.deepEqual(defaultVadOptions(), {
    frameMs: 20,
    hopMs: 10,
    noisePercentile: 20,
    thresholdMarginDb: 10,
    relativeThresholdDb: 45,
    minThresholdDb: -55,
    hysteresisDb: 3,
    minSoundingSeconds: 0.08,
    minSilenceSeconds: 0.2,
    padSoundingSeconds: 0.02,
  });
});

test('threshold diagnostics identify the effective controller', () => {
  const threshold = estimateThreshold([-50, -45, -40, -20], defaultVadOptions());
  assert.equal(threshold.controller, 'noise_margin');
  assert.equal(threshold.thresholdDb, threshold.components.noise_margin);
  assert.ok(threshold.components.noise_margin > threshold.components.peak_relative);
});

test('prepared VAD replay is bit-for-bit equivalent to direct VAD', () => {
  const temp = mkdtempSync(path.join(os.tmpdir(), 'mwu-vad-unit-'));
  const wav = path.join(temp, 'fixture.wav');
  writeFixtureWav(wav);
  const options = { ...defaultVadOptions(), minSilenceSeconds: 0, padSoundingSeconds: 0 };
  const direct = computeLocalAcousticVad(wav, options);
  const prepared = prepareLocalAcousticVad(wav, options);
  const replay = computeLocalAcousticVadFromPrepared(prepared, options);
  assert.deepEqual(replay, direct);
});

test('gold self-comparison is exact', () => {
  const gold = parseSixTierTextGridFile(GOLD);
  const metrics = compareSixTierDocuments(gold, gold);
  assert.equal(metrics.label_agreement.exact_accuracy, 1);
  assert.equal(metrics.active_speaker_set.exact_accuracy, 1);
  assert.equal(metrics.floor.exact_accuracy, 1);
  assert.equal(metrics.room_activity.f1, 1);
});

test('baseline metrics reproduce the locked exact-integration evidence', () => {
  const metrics = compareSixTierDocuments(
    parseSixTierTextGridFile(BASELINE),
    parseSixTierTextGridFile(GOLD),
  );
  close(metrics.label_agreement.exact_accuracy, 0.910097, 0.000001);
  close(metrics.label_agreement.macro_f1_observed_gold_labels, 0.667195, 0.000001);
  close(metrics.active_speaker_set.exact_accuracy, 0.785012, 0.000001);
  close(metrics.floor.exact_accuracy, 0.981449, 0.000001);
});

test('quick calibration is non-destructive and keeps room VAD separate from six-tier selection', () => {
  const temp = mkdtempSync(path.join(os.tmpdir(), 'mwu-calibration-integration-'));
  const baselineHashBefore = sha256(BASELINE);
  const outputDir = path.join(temp, 'run');
  const run = runP025Calibration({ grid: 'quick', runId: 'integration-test', outputDir, writeLatest: false });
  const baselineHashAfter = sha256(BASELINE);
  assert.equal(baselineHashAfter, baselineHashBefore);
  assert.ok(existsSync(path.join(outputDir, 'input-lock.json')));
  assert.ok(existsSync(path.join(outputDir, 'experiment-results.json')));
  assert.ok(existsSync(path.join(outputDir, 'experiment-results.csv')));
  assert.ok(existsSync(path.join(outputDir, 'calibration-report.md')));
  assert.ok(existsSync(path.join(outputDir, 'best-candidate', 'praat-validation.json')));
  assert.ok(existsSync(run.bestTextGridPath));
  assert.ok(run.experiment.deltas_vs_existing_baseline.active_set_exact_accuracy > 0);
  assert.equal(run.experiment.room_vad_best_diagnostic_only.vad_options.thresholdMarginDb, 5);
  assert.equal(run.experiment.selected_best_candidate.config.vad.thresholdMarginDb, 10);
  assert.equal(run.experiment.selected_best_candidate.config.shared_min_sounding_seconds, 0.5);
  const lock = JSON.parse(readFileSync(path.join(outputDir, 'input-lock.json'), 'utf8'));
  assert.equal(lock.research_definitions_locked.pause_threshold_seconds, 0.25);
  assert.equal(lock.research_definitions_locked.minimum_overlap_seconds, 0.1);
  assert.equal(lock.selection_policy.production_default_change, false);
  const best = parseSixTierTextGridFile(run.bestTextGridPath);
  assert.deepEqual(best.tiers.map((tier) => tier.name), ['S1', 'S2', 'S3', 'floor', 'transitions', 'flags']);
  close(best.xmax, 501.013333, 0.000001);
});

test('v2.2 phrase fusion is local, deterministic and preserves timed word provenance', () => {
  const words = [
    wordEvent('w1', 'S3', 0, 0.2, 'do', 'S2', 0.95),
    wordEvent('w2', 'S3', 0.25, 0.45, 'you', 'S2', 0.95),
    wordEvent('w3', 'S3', 1, 1.2, "that's", 'S1', 0.95),
    wordEvent('w4', 'S3', 1.25, 1.45, 'good', 'S1', 0.95),
  ];
  const first = buildPhraseEvents(words, { phraseGapSeconds: 0.5 });
  const second = buildPhraseEvents(words, { phraseGapSeconds: 0.5 });
  assert.deepEqual(first, second);
  assert.equal(first.events.length, 2);
  assert.equal(first.events[0].speaker, 'S2');
  assert.equal(first.events[0].speaker_fusion.decision, 'assembly_short_turn_override');
  assert.deepEqual(first.events[0].source_word_ids, ['w1', 'w2']);
  assert.equal(first.events[1].speaker, 'S3');
  assert.equal(first.events[1].speaker_fusion.decision, 'pyannote_local_majority_retained');
});

test('v2.2 parent response survives Pyannote flicker and propagates a question projector to child phrases', () => {
  const words = [
    wordEvent('q1', 'S3', 0, 0.2, 'do', 'S2', 0.98),
    wordEvent('q2', 'S2', 0.22, 0.4, 'you', 'S2', 0.98),
    wordEvent('q3', 'S3', 0.42, 0.7, 'agree', 'S2', 0.98),
  ];
  const built = buildPhraseEvents(words, {
    parentResponseGapSeconds: 0.5,
    parentResponseMaxSeconds: 4,
    phraseGapSeconds: 0.5,
    phraseMaxSeconds: 0.3,
    activityBridgeSeconds: 0,
  });
  assert.ok(built.events.length >= 2);
  assert.equal(new Set(built.events.map((event) => event.parent_response_id)).size, 1);
  assert.ok(built.events.every((event) => event.speaker === 'S2'));
  assert.ok(built.events.every((event) => event.parent_turn_projector_candidate));
  assert.ok(built.events.every((event) => event.speaker_fusion.decision === 'assembly_short_turn_override'));
  assert.ok(built.events.every((event) => event.activity_segments.every((segment) => segment.end - segment.start <= 0.3 + 1e-9)));
});

test('activity-only interaction preserves question-answer handoffs instead of treating phrase-envelope gaps as speech', () => {
  const events = [
    activityEvent('holder', 'S1', 0, 1.2, ['explain'], [{ start: 0, end: 0.3 }, { start: 1, end: 1.2 }]),
    activityEvent('question', 'S2', 0.5, 0.7, ['do', 'you'], [{ start: 0.5, end: 0.7 }]),
    activityEvent('answer', 'S3', 0.8, 0.95, ['yes'], [{ start: 0.8, end: 0.95 }]),
  ];
  const interaction = runSyntheticInteraction(1.5, events);
  assert.deepEqual(interaction.diagnostics.floor_transfers.map((item) => `${item.from}>${item.to}`), [
    'S1>S2', 'S2>S3',
  ]);
  assert.equal(interaction.diagnostics.failed_bid_event_ids.includes('question'), false);
});

test('continuous backchannel child segments retain the holder and emit no floor transfer', () => {
  const events = [
    activityEvent('holder-a', 'S1', 0, 0.3, ['explain'], [{ start: 0, end: 0.3 }]),
    {
      ...activityEvent('bc-a', 'S2', 0.4, 0.5, ['yes'], [{ start: 0.4, end: 0.5 }]),
      interaction_tokens: ['yes', 'yes'],
      parent_response_id: 'response-bc',
    },
    {
      ...activityEvent('bc-b', 'S2', 0.6, 0.7, ['yes'], [{ start: 0.6, end: 0.7 }]),
      interaction_tokens: ['yes', 'yes'],
      parent_response_id: 'response-bc',
    },
    activityEvent('holder-b', 'S1', 0.8, 1.2, ['continue'], [{ start: 0.8, end: 1.2 }]),
  ];
  const interaction = runSyntheticInteraction(1.5, events);
  assert.deepEqual(interaction.diagnostics.bc_event_ids, ['bc-a', 'bc-b']);
  assert.equal(interaction.diagnostics.floor_transfers.length, 0);
  assert.ok(interaction.floorTier.filter((item) => item.text !== 'FREE').every((item) => item.text === 'S1'));
});

test('v2.3 evidence roles keep residual activity active but semantically unknown and floor-ineligible', () => {
  const residual = assignEvidenceRoles({
    ...activityEvent('residual', 'S2', 0.4, 0.6, [], [{ start: 0.4, end: 0.6 }]),
    source_residual_ids: ['py-residual'],
    lexical_class: 'nonlexical',
  });
  assert.equal(residual.activity_eligible, true);
  assert.equal(residual.semantic_evidence, 'unknown_acoustic');
  assert.equal(residual.semantic_class, 'unknown');
  assert.equal(residual.lexical_class, 'unknown');
  assert.equal(residual.floor_eligible, false);

  const holderEvents = [
    {
      ...activityEvent('holder-a', 'S1', 0, 0.3, ['explain'], [{ start: 0, end: 0.3 }]),
      semantic_evidence: 'explicit_asr', semantic_class: 'lexical',
    },
    residual,
    {
      ...activityEvent('holder-b', 'S1', 0.7, 1, ['continue'], [{ start: 0.7, end: 1 }]),
      semantic_evidence: 'explicit_asr', semantic_class: 'lexical',
    },
  ];
  const interaction = runSyntheticInteraction(1.2, holderEvents, { strictEvidenceRoles: true });
  assert.equal(interaction.diagnostics.floor_transfers.length, 0);
  assert.equal(interaction.diagnostics.bc_event_ids.includes('residual'), false);
  const s2Labels = interaction.speakerTiers.S2.filter((interval) => interval.end > 0.4 && interval.start < 0.6);
  assert.ok(s2Labels.some((interval) => interval.text === 's'));
  assert.ok(s2Labels.every((interval) => interval.text !== 'f' && interval.text !== 'bc'));
});

test('v2.3 explicit ASR backchannel never transfers floor', () => {
  const events = [
    {
      ...activityEvent('holder-a', 'S1', 0, 0.3, ['explain'], [{ start: 0, end: 0.3 }]),
      semantic_evidence: 'explicit_asr', semantic_class: 'lexical',
    },
    {
      ...activityEvent('explicit-bc', 'S2', 0.4, 0.5, ['yes'], [{ start: 0.4, end: 0.5 }]),
      semantic_evidence: 'explicit_asr', semantic_class: 'lexical',
    },
    {
      ...activityEvent('holder-b', 'S1', 0.6, 0.9, ['continue'], [{ start: 0.6, end: 0.9 }]),
      semantic_evidence: 'explicit_asr', semantic_class: 'lexical',
    },
  ];
  const interaction = runSyntheticInteraction(1.1, events, { strictEvidenceRoles: true });
  assert.deepEqual(interaction.diagnostics.bc_event_ids, ['explicit-bc']);
  assert.equal(interaction.diagnostics.floor_transfers.length, 0);
});

test('v2.3e question then Oh and same-speaker answer treats Oh as a floor-eligible response onset', () => {
  const interaction = runSyntheticInteraction(3, [
    explicitEvent(activityEvent('question', 'S1', 0, 0.7, ['how', 'about', 'you'], [{ start: 0, end: 0.7 }]), {
      short_explicit_question: true,
      parent_turn_projector_candidate: true,
    }),
    explicitEvent(activityEvent('ack', 'S2', 0.82, 0.98, ['Oh'], [{ start: 0.82, end: 0.98 }])),
    explicitEvent(activityEvent('answer', 'S2', 1.2, 2.5, ['I', 'think', 'so'], [{ start: 1.2, end: 2.5 }])),
  ], {
    preFloorBackchannelClassification: true,
    strictEvidenceRoles: true,
  });

  assert.equal(interaction.diagnostics.bc_event_ids.includes('ack'), false);
  assert.equal(speakerLabelAt(interaction, 'S2', 0.9), 's');
  assert.equal(interaction.diagnostics.floor_transfers[0].incoming_onset, 0.82);
  const evidence = interaction.diagnostics.pre_floor_response_acknowledgements.find((item) => item.event_id === 'ack');
  assert.equal(evidence?.reason_code, 'question_response_acknowledgement_onset');
  assert.equal(evidence?.continuation_event_id, 'answer');
  assert.deepEqual(evidence?.acknowledgement_tokens, ['oh']);
  assert.deepEqual(evidence?.question_tokens, ['how', 'about', 'you']);
  assert.deepEqual(evidence?.continuation_tokens, ['i', 'think', 'so']);
});

test('v2.3e question then Yes and same-speaker answer treats Yes as a floor-eligible response onset', () => {
  const interaction = runSyntheticInteraction(3, [
    explicitEvent(activityEvent('question', 'S1', 0, 0.8, ['do', 'you', 'agree'], [{ start: 0, end: 0.8 }]), {
      short_explicit_question: true,
    }),
    explicitEvent(activityEvent('ack', 'S3', 0.9, 1.08, ['Yes'], [{ start: 0.9, end: 1.08 }])),
    explicitEvent(activityEvent('answer', 'S3', 1.3, 2.6, ['my', 'answer'], [{ start: 1.3, end: 2.6 }])),
  ], {
    preFloorBackchannelClassification: true,
    strictEvidenceRoles: true,
  });

  assert.equal(interaction.diagnostics.bc_event_ids.includes('ack'), false);
  assert.notEqual(intervalValueAt(interaction.floorTier, 1), 'S2');
  assert.equal(interaction.diagnostics.floor_transfers[0].incoming_onset, 0.9);
  assert.ok(interaction.flags.some((flag) => flag.code === 'question_response_acknowledgement_onset'));
});

test('v2.3e isolated Yes remains bc while the current holder continues', () => {
  const interaction = runSyntheticInteraction(2, [
    explicitEvent(activityEvent('holder-a', 'S1', 0, 0.6, ['main', 'point'], [{ start: 0, end: 0.6 }])),
    explicitEvent(activityEvent('isolated-yes', 'S2', 0.72, 0.9, ['Yes'], [{ start: 0.72, end: 0.9 }])),
    explicitEvent(activityEvent('holder-b', 'S1', 1.02, 1.8, ['continues', 'speaking'], [{ start: 1.02, end: 1.8 }])),
  ], {
    preFloorBackchannelClassification: true,
    strictEvidenceRoles: true,
  });

  assert.equal(speakerLabelAt(interaction, 'S2', 0.8), 'bc');
  assert.equal(interaction.diagnostics.bc_event_ids.includes('isolated-yes'), true);
  assert.equal(interaction.diagnostics.floor_transfers.length, 0);
  assert.equal(interaction.diagnostics.pre_floor_response_acknowledgements.length, 0);
});

test('v2.3e acoustic response residual alone remains floor-ineligible and cannot transfer floor', () => {
  const interaction = runSyntheticInteraction(3, [
    explicitEvent(activityEvent('question', 'S2', 0, 0.8, ['do', 'you'], [{ start: 0, end: 0.8 }]), {
      short_explicit_question: true,
      parent_turn_projector_candidate: true,
    }),
    {
      ...activityEvent('residual', 'S3', 1, 1.3, [], [{ start: 1, end: 1.3 }]),
      semantic_evidence: 'unknown_acoustic',
      lexical_class: 'unknown',
      floor_eligible: false,
      runtime_acoustic_bc_candidate: true,
    },
  ], {
    preFloorBackchannelClassification: true,
    strictEvidenceRoles: true,
    acousticBackchannelEnabled: true,
  });

  assert.equal(interaction.diagnostics.floor_transfers.length, 0);
  assert.equal(interaction.diagnostics.acoustic_response_boundary_candidates[0]?.event_id, 'residual');
  assert.equal(interaction.diagnostics.acoustic_response_boundary_confirmations.length, 0);
  assert.equal(interaction.diagnostics.acoustic_response_boundary_candidates[0]?.floor_eligible, false);
});

test('v2.3e confirmed acoustic residual may backdate a boundary with paired audit evidence', () => {
  const interaction = runSyntheticInteraction(4, [
    explicitEvent(activityEvent('question', 'S2', 0, 0.8, ['do', 'you'], [{ start: 0, end: 0.8 }]), {
      short_explicit_question: true,
      parent_turn_projector_candidate: true,
    }),
    {
      ...activityEvent('residual', 'S3', 1, 1.3, [], [{ start: 1, end: 1.3 }]),
      semantic_evidence: 'unknown_acoustic',
      lexical_class: 'unknown',
      floor_eligible: false,
      runtime_acoustic_bc_candidate: true,
    },
    explicitEvent(activityEvent('confirmation', 'S3', 1.8, 3, ['my', 'answer'], [{ start: 1.8, end: 3 }])),
  ], {
    preFloorBackchannelClassification: true,
    strictEvidenceRoles: true,
    acousticBackchannelEnabled: true,
  });

  const transfer = interaction.diagnostics.floor_transfers.find((item) => item.from === 'S2' && item.to === 'S3');
  assert.equal(transfer?.incoming_onset, 1);
  assert.equal(transfer?.candidate_id, 'confirmation');
  assert.deepEqual(interaction.diagnostics.acoustic_response_boundary_confirmations[0]?.runtime_evidence_ids, [
    'residual', 'confirmation',
  ]);
  assert.ok(interaction.flags.some((flag) => flag.code === 'acoustic_response_boundary_anchor_confirmed'));
});

test('v2.3e competing explicit continuation rejects acoustic residual boundary backdating', () => {
  const interaction = runSyntheticInteraction(4, [
    explicitEvent(activityEvent('question', 'S2', 0, 0.8, ['do', 'you'], [{ start: 0, end: 0.8 }]), {
      short_explicit_question: true,
      parent_turn_projector_candidate: true,
    }),
    {
      ...activityEvent('residual', 'S3', 1, 1.3, [], [{ start: 1, end: 1.3 }]),
      semantic_evidence: 'unknown_acoustic',
      lexical_class: 'unknown',
      floor_eligible: false,
      runtime_acoustic_bc_candidate: true,
    },
    explicitEvent(activityEvent('competing', 'S1', 1.5, 2, ['another', 'turn'], [{ start: 1.5, end: 2 }])),
    explicitEvent(activityEvent('late-confirmation', 'S3', 2.2, 3.5, ['my', 'answer'], [{ start: 2.2, end: 3.5 }])),
  ], {
    preFloorBackchannelClassification: true,
    strictEvidenceRoles: true,
    acousticBackchannelEnabled: true,
  });

  assert.equal(interaction.diagnostics.acoustic_response_boundary_confirmations.length, 0);
  assert.equal(interaction.diagnostics.floor_transfers.some((item) => item.incoming_onset === 1), false);
  assert.ok(interaction.flags.some((flag) => flag.code === 'competing_floor_claims'
    || flag.code === 'path_b_transfer_review_required'));
});

test('v2.3c edge A keeps dual listener bc then preserves the S1>S2>S3 question-answer sequence', () => {
  const explicit = (event) => ({
    ...event,
    semantic_evidence: 'explicit_asr',
    semantic_class: 'lexical',
  });
  const interaction = runSyntheticInteraction(5, [
    explicit(activityEvent('primary-holder', 'S1', 0, 1.5, ['main', 'point'], [{ start: 0, end: 1.5 }])),
    explicit(activityEvent('listener-two-bc', 'S2', 0.8, 0.98, ['yeah'], [{ start: 0.8, end: 0.98 }])),
    explicit(activityEvent('listener-three-bc', 'S3', 0.82, 1, ['right'], [{ start: 0.82, end: 1 }])),
    {
      ...explicit(activityEvent('listener-two-question', 'S2', 1.6, 2, ['what', 'about', 'you'], [{ start: 1.6, end: 2 }])),
      short_explicit_question: true,
      parent_turn_projector_candidate: true,
      hard_response_boundary: 'short_turn_projector_question',
    },
    explicit(activityEvent('listener-three-answer', 'S3', 2.1, 4.5, ['my', 'answer'], [{ start: 2.1, end: 4.5 }])),
  ], {
    preFloorBackchannelClassification: true,
    strictEvidenceRoles: true,
  });

  assert.equal(speakerLabelAt(interaction, 'S2', 0.9), 'bc');
  assert.equal(speakerLabelAt(interaction, 'S3', 0.9), 'bc');
  assert.deepEqual(
    interaction.diagnostics.floor_transfers.map((item) => `${item.from}>${item.to}`),
    ['S1>S2', 'S2>S3'],
  );
  assert.equal(intervalValueAt(interaction.floorTier, 1.8), 'S2');
  assert.equal(intervalValueAt(interaction.floorTier, 3), 'S3');
});

test('v2.3c edge B keeps the primary holder through short ending listener bc without tr', () => {
  const explicit = (event) => ({
    ...event,
    semantic_evidence: 'explicit_asr',
    semantic_class: 'lexical',
  });
  const interaction = runSyntheticInteraction(4.5, [
    explicit(activityEvent('primary-through-end', 'S1', 0, 4.2, ['continuous', 'turn'], [{ start: 0, end: 4.2 }])),
    explicit(activityEvent('ending-bc-two', 'S2', 3.5, 3.68, ['yeah'], [{ start: 3.5, end: 3.68 }])),
    explicit(activityEvent('ending-bc-three', 'S3', 3.72, 3.9, ['right'], [{ start: 3.72, end: 3.9 }])),
  ], {
    preFloorBackchannelClassification: true,
    strictEvidenceRoles: true,
  });

  assert.equal(speakerLabelAt(interaction, 'S2', 3.6), 'bc');
  assert.equal(speakerLabelAt(interaction, 'S3', 3.8), 'bc');
  assert.equal(interaction.diagnostics.floor_transfers.length, 0);
  assert.equal(intervalValueAt(interaction.floorTier, 3.8), 'S1');
  assert.ok(interaction.floorTier
    .filter((item) => item.text !== 'FREE')
    .every((item) => item.text === 'S1'));
});

test('qualified provider overlap retains an identity-tied residual only as reviewable floor-ineligible evidence', () => {
  const residual = {
    id: 'identity-tied-listener-residual',
    speaker: 'S2',
    start: 1,
    end: 1.3,
    provisional_kind: 'vocalisation',
    floor_eligible: true,
    source_residual_ids: ['unknown-S2'],
    review_codes: [],
  };
  const support = {
    S1: [],
    S2: [{ start: 1, end: 1.3 }],
    S3: [{ start: 1, end: 1.3 }],
  };
  const options = {
    residualIdentityPolicy: 'bounded_margin',
    acousticSupportRatio: 0.5,
    identityMargin: 0.1,
    overlapCorroboratedResidualIdentity: true,
    overlapCorroboratedResidualMaxSeconds: 0.6,
    overlapCorroboratedMinimumCoverageRatio: 0.8,
  };
  const overlap = [{
    id: 'qualified-S2-S3-overlap',
    start: 0.95,
    end: 1.35,
    overlap_class: 'qualified',
    speakers: ['S2', 'S3'],
    provider: 'pyannote',
    source_turn_ids: ['turn-S2', 'turn-S3'],
    evidence_source: 'provider_turn_intersection',
    evidence_status: 'candidate_requires_review',
  }];

  const identity = applySpeakerConditionedIdentity([residual], support, options, overlap);
  assert.equal(identity.events.length, 1);
  assert.equal(identity.events[0].overlap_corroborated_identity, true);
  assert.equal(identity.provenance[0].retention_reason,
    'qualified_provider_overlap_corroborates_identity_tied_residual');
  assert.equal(identity.provenance[0].identity_tie, true);
  assert.deepEqual(identity.provenance[0].competing_speakers, ['S3']);
  assert.deepEqual(identity.provenance[0].provider_overlap_evidence[0].source_turn_ids,
    ['turn-S2', 'turn-S3']);
  assert.ok(identity.flags.some((flag) =>
    flag.code === 'qualified_overlap_identity_tie_retained_for_review'));

  const assigned = assignV23cEvidenceRoles(identity.events[0], overlap);
  assert.equal(assigned.semantic_evidence, 'unknown_acoustic');
  assert.equal(assigned.floor_eligible, false);
  assert.equal(assigned.overlap_eligible, true);
});

test('identity-tied residual remains withheld without matching qualified overlap', () => {
  const residual = {
    id: 'identity-tied-without-qualified-overlap',
    speaker: 'S2',
    start: 2,
    end: 2.3,
    provisional_kind: 'vocalisation',
    source_residual_ids: ['unknown-S2'],
  };
  const support = {
    S1: [],
    S2: [{ start: 2, end: 2.3 }],
    S3: [{ start: 2, end: 2.3 }],
  };
  const options = {
    residualIdentityPolicy: 'bounded_margin',
    acousticSupportRatio: 0.5,
    identityMargin: 0.1,
    overlapCorroboratedResidualIdentity: true,
    overlapCorroboratedResidualMaxSeconds: 0.6,
    overlapCorroboratedMinimumCoverageRatio: 0.8,
  };
  const subthreshold = [{
    id: 'subthreshold-S2-S3-overlap',
    start: 1.95,
    end: 2.35,
    overlap_class: 'subthreshold',
    speakers: ['S2', 'S3'],
  }];

  const identity = applySpeakerConditionedIdentity([residual], support, options, subthreshold);
  assert.equal(identity.events.length, 0);
  assert.equal(identity.withheldCount, 1);
  assert.equal(identity.provenance[0].retention_reason, 'identity_withheld');
});

test('qualified overlap must cover most of an identity-tied residual before it is retained', () => {
  const residual = {
    id: 'partially-overlapped-residual',
    speaker: 'S2',
    start: 3,
    end: 3.4,
    provisional_kind: 'vocalisation',
    source_residual_ids: ['unknown-S2'],
  };
  const support = {
    S1: [],
    S2: [{ start: 3, end: 3.4 }],
    S3: [{ start: 3, end: 3.4 }],
  };
  const options = {
    residualIdentityPolicy: 'bounded_margin',
    acousticSupportRatio: 0.5,
    identityMargin: 0.1,
    overlapCorroboratedResidualIdentity: true,
    overlapCorroboratedResidualMaxSeconds: 0.6,
    overlapCorroboratedMinimumCoverageRatio: 0.8,
  };
  const overlap = [{
    id: 'short-qualified-overlap',
    start: 3,
    end: 3.1,
    overlap_class: 'qualified',
    speakers: ['S2', 'S3'],
  }];

  const identity = applySpeakerConditionedIdentity([residual], support, options, overlap);
  assert.equal(identity.events.length, 0);
  assert.equal(identity.provenance[0].provider_overlap_coverage_ratio, 0.25);
});

test('qualified overlap must contain the competing speaker that caused the identity tie', () => {
  const residual = {
    id: 'wrong-competitor-overlap',
    speaker: 'S2',
    start: 4,
    end: 4.3,
    provisional_kind: 'vocalisation',
    source_residual_ids: ['unknown-S2'],
  };
  const support = {
    S1: [],
    S2: [{ start: 4, end: 4.3 }],
    S3: [{ start: 4, end: 4.3 }],
  };
  const options = {
    residualIdentityPolicy: 'bounded_margin',
    acousticSupportRatio: 0.5,
    identityMargin: 0.1,
    overlapCorroboratedResidualIdentity: true,
    overlapCorroboratedResidualMaxSeconds: 0.6,
    overlapCorroboratedMinimumCoverageRatio: 0.8,
  };
  const overlap = [{
    id: 'qualified-wrong-pair',
    start: 4,
    end: 4.3,
    overlap_class: 'qualified',
    speakers: ['S1', 'S2'],
  }];

  const identity = applySpeakerConditionedIdentity([residual], support, options, overlap);
  assert.equal(identity.events.length, 0);
  assert.equal(identity.provenance[0].identity_tie, true);
  assert.deepEqual(identity.provenance[0].competing_speakers, ['S3']);
  assert.deepEqual(identity.provenance[0].provider_overlap_evidence_ids, []);
});

test('overlap-corroborated listener residual cannot backdate a later floor transfer', () => {
  const explicit = (event) => ({
    ...event,
    semantic_evidence: 'explicit_asr',
    semantic_class: 'lexical',
  });
  const interaction = runSyntheticInteraction(3, [
    {
      ...explicit(activityEvent('holder-question', 'S3', 0, 0.7, ['do', 'you'], [{ start: 0, end: 0.7 }])),
      short_explicit_question: true,
      parent_turn_projector_candidate: true,
    },
    {
      ...activityEvent('identity-tied-overlap', 'S2', 0.8, 1.1, [], [{ start: 0.8, end: 1.1 }]),
      semantic_evidence: 'unknown_acoustic',
      semantic_class: 'unknown',
      lexical_class: 'unknown',
      floor_eligible: false,
      holder_retention_eligible: true,
      runtime_acoustic_bc_candidate: true,
      overlap_corroborated_identity: true,
    },
    explicit(activityEvent('explicit-S2-turn', 'S2', 1.5, 2.5, ['my', 'answer'], [{ start: 1.5, end: 2.5 }])),
  ], {
    preFloorBackchannelClassification: true,
    strictEvidenceRoles: true,
    acousticBackchannelEnabled: true,
  });

  assert.equal(interaction.diagnostics.acoustic_response_boundary_confirmations.length, 0);
  assert.equal(interaction.diagnostics.floor_transfers.length, 1);
  assert.equal(interaction.diagnostics.floor_transfers[0].incoming_onset, 1.5);
  assert.notEqual(intervalValueAt(interaction.floorTier, 1), 'S2');
});

test('stage1 normalization preserves overlap-corroborated identity safety evidence', () => {
  const normalized = normalizeStage1Evidence([{
    id: 'overlap-safety-evidence',
    speaker: 'S2',
    start: 0.1,
    end: 0.3,
    provisional_kind: 'vocalisation',
    lexical_class: 'unknown',
    source_residual_ids: ['unknown-S2'],
    floor_eligible: false,
    overlap_corroborated_identity: true,
  }], { duration: 1 });
  assert.equal(normalized.events[0].overlap_corroborated_identity, true);
  assert.equal(normalized.events[0].floor_eligible, false);
});

test('v2.3c residual continuity ends at the acoustic offset instead of the next event start', () => {
  const explicit = (event) => ({
    ...event,
    semantic_evidence: 'explicit_asr',
    semantic_class: 'lexical',
  });
  const residual = {
    ...activityEvent('holder-residual', 'S1', 1.2, 1.6, [], [{ start: 1.2, end: 1.6 }]),
    semantic_evidence: 'unknown_acoustic',
    semantic_class: 'unknown',
    lexical_class: 'unknown',
    floor_eligible: false,
    holder_retention_eligible: true,
    runtime_acoustic_bc_candidate: true,
  };
  const interaction = runSyntheticInteraction(3, [
    explicit(activityEvent('established-holder', 'S1', 0, 1, ['main'], [{ start: 0, end: 1 }])),
    residual,
    {
      ...explicit(activityEvent('explicit-question', 'S2', 1.72, 2.2, ['do', 'you'], [{ start: 1.72, end: 2.2 }])),
      short_explicit_question: true,
      parent_turn_projector_candidate: true,
    },
  ], {
    preFloorBackchannelClassification: true,
    strictEvidenceRoles: true,
  });

  assert.equal(interaction.diagnostics.floor_transfers.length, 1);
  assert.equal(interaction.diagnostics.floor_transfers[0].outgoing_offset, 1.6);
  assert.equal(interaction.diagnostics.floor_transfers[0].incoming_onset, 1.72);
  assert.equal(speakerLabelAt(interaction, 'S1', 1.66), 'tr');
  assert.equal(
    interaction.diagnostics.event_floor_transfer_candidates
      .some((item) => item.candidate_id === residual.id),
    false,
  );
});

test('v2.3c Stage A plumbs each acoustic VAD margin into runtime evidence', () => {
  const temp = mkdtempSync(path.join(os.tmpdir(), 'mwu-v23c-vad-plumbing-'));
  const outputDir = path.join(temp, 'stage-A');
  const generated = generateV23cStage({ stage: 'A', outputDir });
  assert.equal(generated.candidates.length, 8);

  const supportDigestsByMargin = new Map();
  let pairedConfirmationCount = 0;
  for (const candidate of generated.candidates) {
    const candidateDir = path.join(outputDir, candidate.candidate_dir);
    const manifest = JSON.parse(readFileSync(path.join(candidateDir, 'generator-manifest.json'), 'utf8'));
    const evidence = JSON.parse(readFileSync(path.join(candidateDir, 'runtime-evidence.json'), 'utf8'));
    const configuredMargin = Number(manifest.config.adapter.acousticThresholdMarginDb);
    assert.equal(Number(evidence.speaker_acoustic_support.vad_options.thresholdMarginDb), configuredMargin);
    assert.equal(Number(evidence.speaker_acoustic_support.vad_options.relativeThresholdDb), 55);
    assert.equal(Number(evidence.speaker_acoustic_support.vad_options.minThresholdDb), -65);
    assert.equal(evidence.contract_version, 'v23c-runtime-evidence-v2');
    assert.ok(Array.isArray(evidence.pre_floor_response_acknowledgements));
    assert.ok(Array.isArray(evidence.acoustic_response_boundary_candidates));
    assert.ok(Array.isArray(evidence.acoustic_response_boundary_confirmations));
    assert.equal(Object.hasOwn(evidence, 'pre_floor_response_onset_flags'), false);
    pairedConfirmationCount += evidence.acoustic_response_boundary_confirmations.filter((item) =>
      item.residual_event_id && item.confirming_event_id
      && Array.isArray(item.runtime_evidence_ids)
      && item.runtime_evidence_ids.length === 2).length;
    if (!supportDigestsByMargin.has(configuredMargin)) {
      supportDigestsByMargin.set(
        configuredMargin,
        createHash('sha256')
          .update(JSON.stringify(evidence.speaker_acoustic_support.by_speaker))
          .digest('hex'),
      );
    }
  }
  assert.deepEqual([...supportDigestsByMargin.keys()].sort((a, b) => a - b), [5, 7.5]);
  assert.notEqual(supportDigestsByMargin.get(5), supportDigestsByMargin.get(7.5));
  assert.ok(pairedConfirmationCount > 0);
  const scored = scoreV23cStage({
    stage: 'A',
    candidateRoot: outputDir,
    goldFile: GOLD,
    outputFile: path.join(temp, 'stage-A-score.json'),
    expectedIndexSha256: generated.candidateIndexSha256,
  });
  assert.equal(Number(scored.winner.config.adapter.acousticThresholdMarginDb), 5);
  assert.ok(scored.winner.hard_response_evidence_matches > 0);
  assert.ok(scored.winner.real_gold_diagnostics.question_response_acoustic_confirmation_evidence.matched > 0);
});

test('R11 speaker-local refinement retains boundaries when no stable crossing exists', () => {
  const event = explicitEvent(activityEvent('phrase', 'S1', 0.4, 0.6, ['hello'], [{ start: 0.4, end: 0.6 }]));
  const result = refineSpeakerLocalPhraseBoundaries([event], boundarySupport(() => -30));
  assert.deepEqual(result.events[0].activity_segments, [{ start: 0.4, end: 0.6 }]);
  assert.equal(result.stats.moved_boundary_count, 0);
});

test('R11 speaker-local refinement applies unique onset and offset crossings', () => {
  const event = explicitEvent(activityEvent('phrase', 'S1', 0.4, 0.6, ['hello'], [{ start: 0.4, end: 0.6 }]));
  const result = refineSpeakerLocalPhraseBoundaries([event], boundarySupport((time) =>
    time >= 0.35 && time < 0.66 ? -30 : -60));
  assert.ok(result.events[0].activity_segments[0].start < 0.4);
  assert.ok(result.events[0].activity_segments[0].end > 0.6);
  assert.equal(result.stats.moved_boundary_count, 2);
  assert.ok(result.moves.every((move) => move.evidence_source == null
    || move.reason === 'unique_strong_speaker_local_crossing_applied'));
});

test('R11 speaker-local refinement withholds an ambiguous multiple crossing', () => {
  const event = explicitEvent(activityEvent('phrase', 'S1', 0.36, 0.7, ['hello'], [{ start: 0.36, end: 0.7 }]));
  const result = refineSpeakerLocalPhraseBoundaries([event], boundarySupport((time) =>
    (time >= 0.25 && time < 0.34) || (time >= 0.46 && time < 0.74) ? -30 : -60));
  const record = result.records[0];
  assert.equal(record.onset.reason, 'multiple_ambiguous_crossings');
  assert.equal(record.onset.applied, false);
  assert.equal(result.events[0].activity_segments[0].start, 0.36);
});

test('R11 speaker-local refinement cannot cross provider turns or change speaker identity', () => {
  const event = explicitEvent(activityEvent('phrase', 'S1', 0.32, 0.6, ['hello'], [{ start: 0.32, end: 0.6 }]));
  const support = boundarySupport((time) => time >= 0.2 && time < 0.65 ? -30 : -60, { start: 0.3, end: 0.8 });
  const result = refineSpeakerLocalPhraseBoundaries([event], support);
  assert.equal(result.events[0].speaker, 'S1');
  assert.ok(result.events[0].activity_segments[0].start >= 0.3);
  assert.ok(result.events[0].activity_segments[0].end <= 0.8);
  assert.ok(result.moves.every((move) => move.speaker === 'S1' && move.provider_turn_id === 'turn-S1'));
});

test('R13 boundary displacement policy can retain weak or directionally unsafe crossings', () => {
  const event = explicitEvent(activityEvent('phrase', 'S1', 0.4, 0.6, ['hello'], [{ start: 0.4, end: 0.6 }]));
  const support = boundarySupport((time) => time >= 0.35 && time < 0.66 ? -30 : -60);
  const bounded = refineSpeakerLocalPhraseBoundaries([event], support, {
    minimumContrastDb: 8,
    minimumDisplacementMs: 80,
    maximumDisplacementMs: 200,
    movePolicy: 'inward_only',
  });
  assert.deepEqual(bounded.events[0].activity_segments, [{ start: 0.4, end: 0.6 }]);
  assert.ok(bounded.records[0].retained_reasons.includes('onset_rejected_by_displacement_policy'));
  assert.ok(bounded.records[0].retained_reasons.includes('offset_rejected_by_displacement_policy'));
});

test('R12 inserts only an internal speaker-local acoustic gap and preserves outer boundaries', () => {
  const event = explicitEvent(activityEvent('phrase', 'S1', 0.2, 0.8, ['hello'], [{ start: 0.2, end: 0.8 }]));
  const support = internalGapSupport([
    { start: 0.1, end: 0.42 },
    { start: 0.52, end: 0.9 },
  ]);
  const result = splitSpeakerLocalInternalGaps([event], support, {
    minimumGapSeconds: 0.08,
    maximumGapSeconds: 0.2,
    minimumFlankingSoundingSeconds: 0.05,
  });
  assert.deepEqual(result.events[0].activity_segments, [
    { start: 0.2, end: 0.42 },
    { start: 0.52, end: 0.8 },
  ]);
  assert.equal(result.events[0].speaker, 'S1');
  assert.deepEqual(result.events[0].tokens, ['hello']);
  assert.equal(result.stats.inserted_gap_count, 1);
  assert.equal(result.outer_boundaries_moved, false);
});

test('R12 rejects short, edge and cross-provider internal gaps', () => {
  const event = explicitEvent(activityEvent('phrase', 'S1', 0.2, 0.8, ['hello'], [{ start: 0.2, end: 0.8 }]));
  const shortGap = splitSpeakerLocalInternalGaps([event], internalGapSupport([
    { start: 0.1, end: 0.45 },
    { start: 0.49, end: 0.9 },
  ]), { minimumGapSeconds: 0.08 });
  assert.deepEqual(shortGap.events[0].activity_segments, [{ start: 0.2, end: 0.8 }]);

  const unresolvedTurn = internalGapSupport([
    { start: 0.1, end: 0.42 },
    { start: 0.52, end: 0.9 },
  ]);
  unresolvedTurn.provider_turns_by_speaker.S1 = [
    { id: 'turn-a', start: 0, end: 0.5 },
    { id: 'turn-b', start: 0.5, end: 1 },
  ];
  const retained = splitSpeakerLocalInternalGaps([event], unresolvedTurn, { minimumGapSeconds: 0.08 });
  assert.deepEqual(retained.events[0].activity_segments, [{ start: 0.2, end: 0.8 }]);
  assert.equal(retained.records[0].reason, 'no_unique_containing_provider_turn');
});

test('R14 adds only uncovered speaker-local activity as floor-ineligible review evidence', () => {
  const covered = explicitEvent(activityEvent('covered', 'S1', 0.2, 0.4, ['hello'], [{ start: 0.2, end: 0.4 }]));
  const support = internalGapSupport([{ start: 0.1, end: 0.8 }]);
  const result = promoteUncoveredSpeakerActivity([covered], support, [], {
    minimumDurationSeconds: 0.1,
    maximumDurationSeconds: 1,
    edgeExclusionSeconds: 0,
  });
  assert.deepEqual(result.additions.map((event) => [event.start, event.end]), [[0.1, 0.2], [0.4, 0.8]]);
  assert.ok(result.additions.every((event) => event.floor_eligible === false && event.activity_eligible === true));
  assert.ok(result.additions.every((event) => event.semantic_evidence === 'unknown_acoustic'));
  assert.equal(result.floor_eligible_addition_count, 0);
  assert.equal(result.flags.length, 2);
});

test('R14 rejects uncovered fragments below the configured duration', () => {
  const covered = explicitEvent(activityEvent('covered', 'S1', 0.2, 0.4, ['hello'], [{ start: 0.2, end: 0.4 }]));
  const support = internalGapSupport([{ start: 0.15, end: 0.45 }]);
  const result = promoteUncoveredSpeakerActivity([covered], support, [], {
    minimumDurationSeconds: 0.08,
    maximumDurationSeconds: 1,
    edgeExclusionSeconds: 0,
  });
  assert.equal(result.additions.length, 0);
});

test('R15 composer takes active topology from acoustic lane and preserves semantic floor and transitions', () => {
  const topology = composerDocument({
    S1: [{ start: 0, end: 0.2, text: 'pf' }, { start: 0.2, end: 0.8, text: 's' }, { start: 0.8, end: 1, text: 'pf' }],
  });
  const semantic = composerDocument({
    S1: [{ start: 0, end: 0.3, text: 'pf' }, { start: 0.3, end: 0.5, text: 'bc' }, { start: 0.5, end: 0.9, text: 's' }, { start: 0.9, end: 1, text: 'pf' }],
  });
  semantic.tiers.find((tier) => tier.name === 'transitions').points = [{ number: 0.6, mark: 'S2>S1' }];
  const result = composeActivityTopologyWithSemantics(topology, semantic);
  const s1 = result.document.tiers.find((tier) => tier.name === 'S1');
  assert.equal(intervalValueAt(s1.intervals, 0.25), 's');
  assert.equal(intervalValueAt(s1.intervals, 0.4), 'bc');
  assert.equal(intervalValueAt(s1.intervals, 0.85), 'pf');
  assert.deepEqual(
    result.document.tiers.find((tier) => tier.name === 'floor').intervals,
    semantic.tiers.find((tier) => tier.name === 'floor').intervals,
  );
  assert.deepEqual(
    result.document.tiers.find((tier) => tier.name === 'transitions').points,
    semantic.tiers.find((tier) => tier.name === 'transitions').points,
  );
  assert.ok(result.mismatches.length > 0);
});

test('composer can preserve qualified-overlap bc semantics without changing floor or transitions', () => {
  const topology = composerDocument({
    S2: [{ start: 0, end: 1, text: 'pf' }],
  });
  const semantic = composerDocument({
    S2: [{ start: 0, end: 0.2, text: 'pf' }, { start: 0.2, end: 0.5, text: 'bc' }, { start: 0.5, end: 1, text: 'pf' }],
  });
  semantic.tiers.find((tier) => tier.name === 'transitions').points = [{ number: 0.7, mark: 'S1>S3' }];
  const result = composeActivityTopologyWithSemantics(topology, semantic, {
    preserveSemanticActivityIntervals: [{
      speaker: 'S2', start: 0.2, end: 0.5, evidence_id: 'qualified-overlap-bc',
    }],
  });
  const s2 = result.document.tiers.find((tier) => tier.name === 'S2');
  assert.equal(intervalValueAt(s2.intervals, 0.35), 'bc');
  assert.equal(result.stats.preserved_interval_count, 1);
  assert.ok(result.document.tiers.find((tier) => tier.name === 'flags').intervals
    .some((item) => item.text.includes('qualified_overlap_semantic_activity_preserved:S2')));
  assert.deepEqual(
    result.document.tiers.find((tier) => tier.name === 'floor').intervals,
    semantic.tiers.find((tier) => tier.name === 'floor').intervals,
  );
  assert.deepEqual(
    result.document.tiers.find((tier) => tier.name === 'transitions').points,
    semantic.tiers.find((tier) => tier.name === 'transitions').points,
  );
});

test('qualified-overlap backchannel evidence cannot create one-sided ol', () => {
  const topology = composerDocument({
    S2: [{ start: 0, end: 1, text: 'pf' }],
  });
  const semantic = composerDocument({
    S2: [{ start: 0, end: 0.2, text: 'pf' }, { start: 0.2, end: 0.5, text: 'ol' }, { start: 0.5, end: 1, text: 'pf' }],
  });
  const result = composeActivityTopologyWithSemantics(topology, semantic, {
    preserveSemanticActivityIntervals: [{
      speaker: 'S2', start: 0.2, end: 0.5, evidence_id: 'qualified-overlap-bc', label: 'bc',
    }],
  });
  const s2 = result.document.tiers.find((tier) => tier.name === 'S2');
  assert.equal(intervalValueAt(s2.intervals, 0.35), 'bc');
  assert.equal(s2.intervals.some((item) => item.text === 'ol'), false);
});

test('composer downgrades any remaining one-sided ol and flags the repair', () => {
  const topology = composerDocument({
    S1: [{ start: 0, end: 1, text: 'ol' }],
    S2: [{ start: 0, end: 1, text: 'pf' }],
    S3: [{ start: 0, end: 1, text: 'pf' }],
  });
  const semantic = structuredClone(topology);
  const result = composeActivityTopologyWithSemantics(topology, semantic);
  assert.equal(intervalValueAt(result.document.tiers.find((tier) => tier.name === 'S1').intervals, 0.5), 'bc');
  assert.equal(result.stats.one_sided_overlap_repair_count, 1);
  assert.ok(result.document.tiers.find((tier) => tier.name === 'flags').intervals
    .some((item) => item.text.includes('one_sided_overlap_downgraded:S1')));
  assert.equal(validateSixTierTextGrid(result.document).valid, true);
});

test('blind runner distinguishes dual-provider evidence from a single-provider smoke test', () => {
  assert.equal(classifyEvidenceMode('pyannoteAI'), 'dual_provider_blind');
  assert.equal(classifyEvidenceMode('AssemblyAI'), 'single_provider_degraded_smoke_test');
  assert.equal(classifyEvidenceMode('unknown'), 'single_provider_degraded_smoke_test');
});

test('blind runner pins the R32 overlap and semantic-composition policy', () => {
  assert.equal(FROZEN_BLIND_CONFIG.overlap_identity.enabled, true);
  assert.equal(FROZEN_BLIND_CONFIG.overlap_identity.maximumSeconds, 0.35);
  assert.equal(FROZEN_BLIND_CONFIG.overlap_identity.minimumCoverageRatio, 0.8);
  assert.equal(FROZEN_BLIND_CONFIG.semantic_boundary.enabled, false);
  assert.equal(FROZEN_BLIND_CONFIG.semantic_preservation.policy, 'concurrent_question_or_prior');
});

test('v2.3 local crossing precomputation is equivalent and retains a missing side', () => {
  const frames = Array.from({ length: 100 }, (_, index) => ({
    start: index / 100,
    end: (index + 2) / 100,
    db: index < 50 ? -60 : -30,
  }));
  const direct = findStableBoundaryCrossing({
    frames, boundary: 0.48, direction: 'onset', thresholdDb: -45,
    radiusMs: 120, smoothingMs: 20, hysteresisDb: 1, stableRunMs: 30, hopMs: 10,
  });
  const prepared = prepareSmoothedCrossingEvidence(frames, 20, 10);
  const replay = findStableBoundaryCrossing({
    prepared, boundary: 0.48, direction: 'onset', thresholdDb: -45,
    radiusMs: 120, smoothingMs: 20, hysteresisDb: 1, stableRunMs: 30, hopMs: 10,
  });
  assert.deepEqual(replay, direct);
  assert.equal(direct.found, true);

  const target = {
    ...activityEvent('target', 'S1', 0.48, 0.8, ['hello'], [{ start: 0.48, end: 0.8 }]),
    semantic_evidence: 'explicit_asr', semantic_class: 'lexical', source_word_ids: ['w1'],
  };
  const result = refineProviderBoundariesAtCrossings([target], {
    frames, thresholdDb: -45, hopMs: 10, radiusMs: 120,
    smoothingMs: 20, hysteresisDb: 1, stableRunMs: 30,
  });
  const refined = result.events.find((event) => event.id === 'target').activity_segments[0];
  assert.equal(refined.start, direct.time);
  assert.equal(refined.end, 0.8);
  assert.equal(result.records[0].retained_original_sides.offset, true);
  assert.equal(result.records[0].applied_sides.onset, true);
});

test('v2.3 overlap eligibility requires qualified or subthreshold provider evidence', () => {
  const residual = {
    ...activityEvent('residual', 'S2', 1, 1.2, [], [{ start: 1, end: 1.2 }]),
    source_residual_ids: ['residual-source'],
  };
  assert.equal(assignEvidenceRoles(residual, []).overlap_eligible, false);
  const evidence = [{ id: 'ov1', start: 1.05, end: 1.08, overlap_class: 'subthreshold', speakers: ['S1', 'S2'] }];
  const supported = assignEvidenceRoles(residual, evidence);
  assert.equal(supported.overlap_eligible, true);
  assert.deepEqual(supported.provider_overlap_evidence_ids, ['ov1']);
});

test('v2.3 R5 resolves same-holder, short transfer gap and long lapse retrospectively', () => {
  const explicit = (event) => ({ ...event, semantic_evidence: 'explicit_asr', semantic_class: 'lexical' });
  const sameHolder = runSyntheticInteraction(1, [
    explicit(activityEvent('a1', 'S1', 0, 0.2, ['one'], [{ start: 0, end: 0.2 }])),
    explicit(activityEvent('a2', 'S1', 0.5, 0.7, ['two'], [{ start: 0.5, end: 0.7 }])),
  ], { strictEvidenceRoles: true });
  assert.ok(sameHolder.speakerTiers.S1.some((interval) => interval.text === 'op' && interval.start <= 0.2 && interval.end >= 0.5));

  const shortGap = runSyntheticInteraction(1.5, [
    explicit(activityEvent('s1', 'S1', 0, 0.2, ['one'], [{ start: 0, end: 0.2 }])),
    explicit(activityEvent('s2', 'S2', 0.8, 1, ['answer'], [{ start: 0.8, end: 1 }])),
  ], { strictEvidenceRoles: true });
  assert.ok(shortGap.speakerTiers.S1.some((interval) => interval.text === 'tr' && interval.start <= 0.2 && interval.end >= 0.8));

  const longGap = runSyntheticInteraction(2, [
    explicit(activityEvent('l1', 'S1', 0, 0.2, ['one'], [{ start: 0, end: 0.2 }])),
    explicit(activityEvent('l2', 'S2', 1.4, 1.6, ['answer'], [{ start: 1.4, end: 1.6 }])),
  ], { strictEvidenceRoles: true });
  assert.ok(longGap.speakerTiers.S1.some((interval) => interval.text === 'shs' && interval.start <= 0.2 && interval.end >= 1.4));
});

test('v2.2 residual promotion requires acoustic intersection and keeps long unknown activity out of floor claims', () => {
  const result = promoteResidualEvidence(
    [{ id: 'u1', speaker: 'S1', start: 0, end: 1, confidence: null }],
    [{ start: 0.2, end: 0.4 }, { start: 0.5, end: 0.9 }],
    [],
    { residualMinSeconds: 0.08, residualNonlexicalMaxSeconds: 0.25, promoteLongResidual: true },
  );
  assert.equal(result.events.length, 2);
  assert.equal(result.events[0].lexical_class, 'nonlexical');
  assert.equal(result.events[0].floor_eligible, true);
  assert.equal(result.events[1].lexical_class, 'unknown');
  assert.equal(result.events[1].floor_eligible, false);
  assert.ok(result.events.every((event) => event.acoustic_support === 'local_room_vad_intersection'));
});

test('v2.2 candidate adapter does not require or expose a gold runtime input', () => {
  const stage1 = JSON.parse(readFileSync(path.join(
    ROOT, 'outputs', 'multilogue-v2-poc', 'Multilogue04_C_Level30_D1G4', 'phase-i', 'stage1-evidence.json',
  ), 'utf8'));
  const built = buildV22Stage1Candidate(stage1, stage1.roomSoundingIntervals);
  assert.equal(built.provenance.runtime_gold_access, false);
  assert.equal(Object.hasOwn(built.input, 'gold'), false);
  assert.ok(built.stats.phrase_event_count < built.stats.source_word_event_count);
  assert.ok(built.provenance.phrase_candidates.every((phrase) => phrase.source_word_ids.length > 0));
});

test('v2.2 bounded calibration emits deterministic before-after evidence and floor-derived Tier 5', () => {
  const temp = mkdtempSync(path.join(os.tmpdir(), 'mwu-v22-calibration-'));
  const runA = runP025V22Calibration({ runId: 'deterministic-a', outputDir: path.join(temp, 'a') });
  const runB = runP025V22Calibration({ runId: 'deterministic-b', outputDir: path.join(temp, 'b') });
  assert.deepEqual(runA.beforeAfter, runB.beforeAfter);
  assert.equal(runA.best.output.digest, runB.best.output.digest);
  assert.equal(runA.best.floor_transfer_count, runA.best.tier5_point_count);
  assert.equal(validateTier5Consistency(runA.best.output).pass, true);
  assert.equal(runA.best.tier5_consistency.pass, true);
  assert.equal(runA.best.floor_handoff_agreement.gold, 20);
  assert.equal(
    runA.beforeAfter.goal_results.floor.met,
    runA.beforeAfter.selected_v22_candidate.floor_accuracy >= 0.98,
  );
  assert.ok(runA.beforeAfter.selected_v22_candidate.active_set_exact_accuracy
    > runA.beforeAfter.baseline_original_draft.active_set_exact_accuracy);
  const allMet = Object.values(runA.beforeAfter.goal_results).every((item) => item.met);
  assert.equal(runA.beforeAfter.status, allMet ? 'HUGO_QA_GATE_PASS' : 'HUGO_QA_GATE_FAIL');
  assert.equal(runA.beforeAfter.formal_gate.pass, allMet);
  assert.equal(runA.beforeAfter.formal_gate.status, runA.beforeAfter.status);
  const lateHandoffs = deriveFloorHandoffs(runA.best.output.textgrid_document)
    .filter((handoff) => handoff.turn_start >= 486 && handoff.turn_start <= 497);
  assert.deepEqual(lateHandoffs, []);
  const goldComparison = compareFloorHandoffs(
    runA.best.output.textgrid_document,
    parseSixTierTextGridFile(GOLD),
    { tolerance: 0.1 },
  );
  assert.equal(goldComparison.gold, 20);
  assert.equal(goldComparison.predicted, runA.best.tier5_point_count);
  const lock = JSON.parse(readFileSync(path.join(runA.outputDir, 'input-lock.json'), 'utf8'));
  assert.equal(lock.network_used, false);
  assert.equal(lock.gold_used_by_runtime_generation, false);
  assert.equal(lock.production_defaults_changed, false);
  for (const file of [
    'before-after.json', 'candidate-results.json', 'candidate-results.csv', 'calibration-report.md',
    path.join('best-candidate', 'stage1-provenance.json'),
    path.join('best-candidate', 'method-manifest.json'),
    path.join('best-candidate', 'tier5-validation.json'),
  ]) assert.ok(existsSync(path.join(runA.outputDir, file)), `${file} missing`);
});

test('v2.3 final staged grid is exactly 24 + 8 + 8 + 4 with locked metric ownership', () => {
  assert.equal(stageConfigs('A').length, 24);
  const stageAConfig = stageConfigs('A')[0];
  assert.equal(stageConfigs('B', stageAConfig).length, 8);
  assert.equal(stageConfigs('C', stageAConfig).length, 8);
  assert.equal(stageConfigs('D', stageAConfig).length, 4);
  const expected = {
    A: ['active_set_exact_accuracy', 'room_activity_f1', 'boundary_f1_100ms'],
    B: ['active_set_exact_accuracy', 'boundary_f1_100ms'],
    C: ['active_set_exact_accuracy', 'floor_accuracy', 'transition_matched', 'tier5_handoff_matched_100ms'],
    D: ['macro_f1_observed_labels', 'f_f1', 'bc_f1'],
  };
  for (const stage of ['A', 'B', 'C', 'D']) {
    const score = JSON.parse(readFileSync(path.join(V23_FINAL, 'scores', `stage-${stage}.json`), 'utf8'));
    assert.deepEqual(score.metric_ownership, expected[stage]);
    assert.deepEqual(Object.keys(score.winner.owned_metrics), expected[stage]);
  }
});

test('v2.3 final generator rejects Gold parameters and scorer detects hash tampering', () => {
  const temp = mkdtempSync(path.join(os.tmpdir(), 'mwu-v23-final-isolation-'));
  const generator = path.join(ROOT, 'scripts', 'multilogue-v2', 'calibration', 'v23-final-generator.mjs');
  const rejected = spawnSync(process.execPath, [
    generator, '--stage', 'A', '--output-dir', path.join(temp, 'rejected'), '--gold', GOLD,
  ], { cwd: ROOT, encoding: 'utf8' });
  assert.notEqual(rejected.status, 0);
  assert.equal(existsSync(path.join(temp, 'rejected')), false);

  const copy = path.join(temp, 'candidate');
  cpSync(path.join(V23_FINAL, 'selected-candidate'), copy, { recursive: true });
  assert.doesNotThrow(() => verifyCandidateHashes(copy));
  const textGrid = readFileSync(path.join(copy, readdirTextGrid(copy)), 'utf8');
  writeFileSync(path.join(copy, readdirTextGrid(copy)), `${textGrid}\n`, 'utf8');
  assert.throws(() => verifyCandidateHashes(copy), /hash mismatch/);
});

test('v2.3 scorer rejects an unindexed candidate directory', () => {
  const root = copyStageFixture('D', 'injected');
  const indexSha = sha256(path.join(root, 'candidate-index.json'));
  const source = path.join(root, 'candidates', readdirSync(path.join(root, 'candidates'))[0]);
  cpSync(source, path.join(root, 'candidates', 'v23f-d-injected'), { recursive: true });
  assert.throws(
    () => verifyCandidateSet({ stage: 'D', candidateRoot: root, expectedIndexSha256: indexSha }),
    /directory set does not match frozen index/,
  );
});

test('v2.3 scorer rejects a missing indexed candidate', () => {
  const root = copyStageFixture('D', 'missing');
  const indexSha = sha256(path.join(root, 'candidate-index.json'));
  const missing = readdirSync(path.join(root, 'candidates'))[0];
  rmSync(path.join(root, 'candidates', missing), { recursive: true, force: true });
  assert.throws(
    () => verifyCandidateSet({ stage: 'D', candidateRoot: root, expectedIndexSha256: indexSha }),
    /directory set does not match frozen index/,
  );
});

test('v2.3 scorer rejects candidate index mutation after generation', () => {
  const root = copyStageFixture('D', 'mutated-index');
  const indexFile = path.join(root, 'candidate-index.json');
  const indexSha = sha256(indexFile);
  const index = JSON.parse(readFileSync(indexFile, 'utf8'));
  index.candidates[0].aggregate_sha256 = '0'.repeat(64);
  writeFileSync(indexFile, `${JSON.stringify(index, null, 2)}\n`, 'utf8');
  assert.throws(
    () => verifyCandidateSet({ stage: 'D', candidateRoot: root, expectedIndexSha256: indexSha }),
    /candidate index SHA256 mismatch/,
  );
});

test('v2.3 scorer accepts only the exact frozen A B C D candidate sets', () => {
  for (const [stage, expected] of Object.entries({ A: 24, B: 8, C: 8, D: 4 })) {
    const root = path.join(V23_FINAL, `stage-${stage}`);
    const verified = verifyCandidateSet({
      stage,
      candidateRoot: root,
      expectedIndexSha256: sha256(path.join(root, 'candidate-index.json')),
    });
    assert.equal(verified.candidates.length, expected);
  }
});

test('v2.3 final Gate is honest, semantic ceiling is explicit and Stage D preserves frozen artifacts', () => {
  const report = JSON.parse(readFileSync(path.join(V23_FINAL, 'final-gate.json'), 'utf8'));
  assert.equal(report.total_candidates, 44);
  assert.equal(report.formal_gate.required_kpi_count, 8);
  const allMet = Object.values(report.formal_gate.results).every((item) => item.met);
  assert.equal(report.formal_gate.pass, allMet);
  assert.equal(report.status, allMet ? 'V23_FINAL_GATE_PASS' : 'V23_FINAL_GATE_FAIL');
  const semanticMet = ['macro_f1_observed_labels', 'f_f1', 'bc_f1']
    .every((key) => report.formal_gate.results[key].met);
  assert.equal(report.semantic_status, semanticMet
    ? 'SEMANTIC_EVIDENCE_TARGETS_MET' : 'SEMANTIC_EVIDENCE_CEILING_BLOCKED');
  assert.equal(report.safeguards.generator_and_scorer_separate_processes, true);
  assert.equal(report.safeguards.generator_received_gold, false);
  assert.equal(report.safeguards.candidate_hash_verified_before_scoring, true);
  const stageC = report.stage_winners.find((item) => item.stage === 'C').structural_digests;
  const stageD = report.stage_winners.find((item) => item.stage === 'D').structural_digests;
  assert.deepEqual(stageD, stageC);

  const runtimeSource = [
    'scripts/multilogue-v2/acoustic/local-boundary-crossing.mjs',
    'scripts/multilogue-v2/adapters/build-v23-stage1-candidate.mjs',
    'scripts/multilogue-v2/calibration/v23-final-generator.mjs',
  ].map((file) => readFileSync(path.join(ROOT, file), 'utf8')).join('\n');
  assert.doesNotMatch(runtimeSource, /42\.7|45\.5|486|497|that's good|yes yes/i);
});

const failed = results.filter((item) => item.status === 'failed');
const report = {
  suite: 'multilogue-v2-p025-calibration',
  status: failed.length ? 'failed' : 'passed',
  passed: results.length - failed.length,
  failed: failed.length,
  results,
};
mkdirSync(path.dirname(ARTIFACT), { recursive: true });
writeFileSync(ARTIFACT, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
if (failed.length) process.exitCode = 1;

function close(actual, expected, tolerance) {
  assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} differs from ${expected} by more than ${tolerance}`);
}

function sha256(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

function readdirTextGrid(directory) {
  const file = readdirSync(directory).find((name) => name.endsWith('.TextGrid'));
  if (!file) throw new Error(`TextGrid missing in ${directory}`);
  return file;
}

function copyStageFixture(stage, suffix) {
  const temp = mkdtempSync(path.join(os.tmpdir(), `mwu-v23-${suffix}-`));
  const target = path.join(temp, `stage-${stage}`);
  cpSync(path.join(V23_FINAL, `stage-${stage}`), target, { recursive: true });
  return target;
}

function writeFixtureWav(file) {
  const sampleRate = 16000;
  const seconds = 1;
  const sampleCount = sampleRate * seconds;
  const data = Buffer.alloc(sampleCount * 2);
  for (let index = 0; index < sampleCount; index += 1) {
    const active = index >= sampleRate * 0.25 && index < sampleRate * 0.75;
    const sample = active ? Math.round(Math.sin((2 * Math.PI * 220 * index) / sampleRate) * 8000) : 0;
    data.writeInt16LE(sample, index * 2);
  }
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(data.length, 40);
  writeFileSync(file, Buffer.concat([header, data]));
}

function wordEvent(id, speaker, start, end, token, assemblySpeaker, confidence) {
  return {
    id,
    speaker,
    start,
    end,
    tokens: [token],
    lexical_class: 'lexical',
    provisional_kind: 'vocalisation',
    evidence_state: 'known',
    source_word_id: id,
    assembly_speaker: assemblySpeaker,
    assembly_confidence: confidence,
  };
}

function activityEvent(id, speaker, start, end, tokens, activitySegments) {
  return {
    id,
    speaker,
    start,
    end,
    tokens,
    interaction_tokens: tokens,
    activity_segments: activitySegments,
    lexical_class: 'lexical',
    provisional_kind: 'vocalisation',
    evidence_state: 'known',
    floor_eligible: true,
    overlap_eligible: true,
  };
}

function explicitEvent(event, overrides = {}) {
  return {
    ...event,
    semantic_evidence: 'explicit_asr',
    semantic_class: 'lexical',
    ...overrides,
  };
}

function boundarySupport(dbAt, providerTurn = { start: 0, end: 1 }) {
  const frames = Array.from({ length: 100 }, (_, index) => {
    const start = index / 100;
    return { start, end: start + 0.02, db: dbAt(start + 0.01) };
  });
  return {
    contract_version: 'synthetic-speaker-support',
    boundary_frames_by_speaker: { S1: frames, S2: [], S3: [] },
    provider_turns_by_speaker: {
      S1: [{ id: 'turn-S1', provider_speaker: 'synthetic', ...providerTurn }],
      S2: [],
      S3: [],
    },
    speaker_records: [
      { canonical_speaker: 'S1', threshold_dbfs: -45 },
      { canonical_speaker: 'S2', threshold_dbfs: -45 },
      { canonical_speaker: 'S3', threshold_dbfs: -45 },
    ],
  };
}

function internalGapSupport(sounding) {
  return {
    contract_version: 'synthetic-speaker-support',
    by_speaker: { S1: sounding, S2: [], S3: [] },
    provider_turns_by_speaker: {
      S1: [{ id: 'turn-S1', provider_speaker: 'synthetic', start: 0, end: 1 }],
      S2: [],
      S3: [],
    },
  };
}

function composerDocument({ S1 = null, S2 = null, S3 = null } = {}) {
  const fallback = [{ start: 0, end: 1, text: 'pf' }];
  return {
    xmin: 0,
    xmax: 1,
    tiers: [
      { class: 'IntervalTier', name: 'S1', xmin: 0, xmax: 1, intervals: S1 || fallback },
      { class: 'IntervalTier', name: 'S2', xmin: 0, xmax: 1, intervals: S2 || fallback },
      { class: 'IntervalTier', name: 'S3', xmin: 0, xmax: 1, intervals: S3 || fallback },
      { class: 'IntervalTier', name: 'floor', xmin: 0, xmax: 1, intervals: [{ start: 0, end: 1, text: 'S2' }] },
      { class: 'TextTier', name: 'transitions', xmin: 0, xmax: 1, points: [] },
      { class: 'IntervalTier', name: 'flags', xmin: 0, xmax: 1, intervals: [{ start: 0, end: 1, text: '' }] },
    ],
  };
}

function runSyntheticInteraction(duration, events, config = {}) {
  const frames = buildBaseActivityFrames(duration, [{ start: 0, end: duration }]);
  return runInteractionEngine({
    duration,
    sharedActivity: deriveSharedActivity(frames, 0.25),
    events,
    config: {
      floorReleaseSeconds: 1,
      minOverlapSeconds: 0.1,
      overlapMode: 'path_b_exclusive',
      rebuildTransitionsFromFloor: true,
      ...config,
    },
  });
}

function speakerLabelAt(interaction, speaker, time) {
  return intervalValueAt(interaction.speakerTiers[speaker], time);
}

function intervalValueAt(intervals, time) {
  const interval = intervals.find((item) => item.start <= time && item.end > time);
  return interval?.text ?? null;
}
