import assert from 'node:assert/strict';
import { readdirSync, readFileSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  CSV_SCHEMAS,
  PROVISIONAL_KINDS,
  SPEAKER_LABELS,
  canonicalJson,
  phonationIncluded,
  sha256,
} from '../../scripts/multilogue-v2/core/contracts.mjs';
import {
  evaluateBackchannel,
  recomputePathACandidateFromStoredEvidence,
  runInteractionEngine,
} from '../../scripts/multilogue-v2/core/interaction-engine.mjs';
import {
  assignWordsByMaximumOverlap,
  mapAttributionTurns,
  validateMappingContract,
} from '../../scripts/multilogue-v2/core/mapping.mjs';
import { runMultilogueV2 } from '../../scripts/multilogue-v2/core/pipeline.mjs';
import {
  buildBaseActivityFrames,
  deriveSharedActivity,
  flagsToFrameText,
  normalizeStage1Evidence,
} from '../../scripts/multilogue-v2/core/timeline.mjs';
import { buildSixTierTextGrid, serializeTextGrid } from '../../scripts/multilogue-v2/core/textgrid.mjs';
import { validateSixTierTextGrid } from '../../scripts/multilogue-v2/core/validator.mjs';
import { buildPhraseEvents } from '../../scripts/multilogue-v2/adapters/build-v22-stage1-candidate.mjs';
import {
  SYNTHETIC_MAPPING,
  artifact,
  laughter,
  syntheticPipelineInput,
  vocal,
} from './fixtures.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = dirname(dirname(here));
const artifactDir = join(here, 'artifacts');
rmSync(artifactDir, { recursive: true, force: true });
mkdirSync(artifactDir, { recursive: true });

const results = [];
let fullRun = null;

await test('Q1-DES-001 validates explicit provider mappings', () => {
  const mapping = validateMappingContract(SYNTHETIC_MAPPING);
  assert.equal(mapping.pyannote.voice_alpha, 'S1');
  assert.equal(mapping.assemblyai.channel_blue, 'S3');
  assert.throws(() => validateMappingContract({
    pyannote: { a: 'S1', b: 'S1', c: 'S3' },
    assemblyai: SYNTHETIC_MAPPING.assemblyai,
  }), /bijective/);
});

await test('Q1-DES-001 preserves null confidence and flags provider uncertainty', () => {
  const mapping = validateMappingContract(SYNTHETIC_MAPPING);
  const mapped = mapAttributionTurns([
    { id: 'null-score', speaker: 'voice_alpha', start: 0, end: 0.5, confidence: null },
  ], mapping, { duration: 1 });
  assert.equal(mapped.turns[0].confidence, null);
  assert(mapped.flags.some((flag) => flag.code === 'confidence_unavailable'));
});

await test('Q1-DES-001 assigns words by overlap and all deterministic tie breaks', () => {
  const mapping = validateMappingContract(SYNTHETIC_MAPPING);
  const turns = mapAttributionTurns([
    { id: 'a', speaker: 'voice_alpha', start: 0, end: 1, confidence: 1 },
    { id: 'b', speaker: 'voice_beta', start: 0, end: 1, confidence: 1 },
    { id: 'a-early', speaker: 'voice_alpha', start: 1.0, end: 2, confidence: 1 },
    { id: 'b-late', speaker: 'voice_beta', start: 1.1, end: 2.1, confidence: 1 },
    { id: 'a-same', speaker: 'voice_alpha', start: 2.2, end: 3, confidence: 1 },
    { id: 'b-same', speaker: 'voice_beta', start: 2.2, end: 3, confidence: 1 },
  ], mapping, { duration: 5 }).turns;
  const assigned = assignWordsByMaximumOverlap([
    { id: 'source-break', speaker: 'channel_green', start: 0.2, end: 0.8, confidence: 1 },
    { id: 'onset-break', speaker: 'unmapped-source', start: 1.2, end: 1.8, confidence: 1 },
    { id: 'canonical-break', speaker: 'unmapped-source', start: 2.3, end: 2.9, confidence: 1 },
    { id: 'no-overlap', speaker: 'channel_red', start: 4, end: 4.2, confidence: null },
  ], turns, mapping, { duration: 5 });
  assert.deepEqual(assigned.words.map((word) => word.speaker), ['S2', 'S1', 'S1', null]);
  assert(assigned.flags.some((flag) => flag.code === 'unresolved_word_assignment'));
  assert(assigned.flags.some((flag) => flag.code === 'word_confidence_unavailable'));
});

await test('Q1-DES-002 derives 0.25 and 0.35 shared activity independently', () => {
  const base = buildBaseActivityFrames(2, [{ start: 0, end: 1 }, { start: 1.3, end: 2 }]);
  const p25 = deriveSharedActivity(base, 0.25);
  const p35 = deriveSharedActivity(base, 0.35);
  assert.equal(valueAt(p25.intervals, 1.15), 'silence');
  assert.equal(valueAt(p35.intervals, 1.15), 'sounding');
  assert.equal(base.find((frame) => frame.start === 1.1).sounding, false);
});

await test('Appendix section 4 discards sounding runs shorter than 100 ms as noise', () => {
  const base = buildBaseActivityFrames(0.3, [{ start: 0.1, end: 0.18 }]);
  const activity = deriveSharedActivity(base, 0.25, { minSoundingSeconds: 0.1 });
  assert(activity.frames.every((frame) => frame.sounding === false));
  assert(activity.frames.some((frame) => frame.discarded_short_sounding));
});

await test('Q2-IMP-001 threshold-filled gaps change op and phonation metrics', () => {
  const events = [
    vocal('threshold-before', 'S1', 0, 1),
    vocal('threshold-after', 'S1', 1.3, 2),
  ];
  const soundingIntervals = [{ start: 0, end: 1 }, { start: 1.3, end: 2 }];
  const p25 = scenario(2.2, events, { soundingIntervals, threshold: 0.25 });
  const p35 = scenario(2.2, events, { soundingIntervals, threshold: 0.35 });
  assert.equal(labelAt(p25, 'S1', 1.15), 'op');
  assert.notEqual(labelAt(p35, 'S1', 1.15), 'op');
  assert(p35.metrics.S1.phonation_time > p25.metrics.S1.phonation_time);
});

await test('Q1-DES-003 keeps unknown internal and restricts provisional kinds', () => {
  const normalized = normalizeStage1Evidence([
    vocal('uncertain', 'S1', 0, 0.5, ['token'], { confidence: null, lexical_class: 'unknown', evidence_state: 'unknown' }),
  ], { duration: 1 });
  assert(PROVISIONAL_KINDS.includes(normalized.events[0].provisional_kind));
  assert.equal(normalized.events[0].confidence, null);
  assert(normalized.flags.some((flag) => flag.code === 'evidence_uncertain'));
  assert.throws(() => normalizeStage1Evidence([
    { ...vocal('bad-kind', 'S1', 0, 0.5), provisional_kind: 'unknown' },
  ], { duration: 1 }), /provisional_kind/);
});

await test('Appendix 10.1 within-turn pause with backchannel', () => {
  const run = scenario(3.5, [
    vocal('holder-before', 'S1', 0, 1, ['main']),
    vocal('listener-bc', 'S2', 1.3, 1.5, ['mhm']),
    vocal('holder-after', 'S1', 1.9, 3, ['continues']),
  ]);
  assert.equal(labelAt(run, 'S1', 1.4), 'op');
  assert.equal(labelAt(run, 'S2', 1.4), 'bc');
  assert.equal(run.transitions.length, 0);
});

await test('Appendix 10.2 overlap transfer emits negative provisional FTO on Path A', () => {
  const run = scenario(3.4, [
    vocal('outgoing', 'S1', 0, 2, ['view']),
    vocal('incoming', 'S2', 1.82, 3, ['but', 'disagree']),
  ]);
  assert.equal(labelAt(run, 'S1', 1.9), 'ol');
  assert.equal(labelAt(run, 'S2', 1.9), 'ol');
  assert.equal(run.transitions[0].fto, -0.18);
  assert.equal(run.transitions[0].label, 'S1>S2 FTO=-0.180 status=provisional');
});

await test('Appendix 10.3 failed bid marks overlap without FTO', () => {
  const run = scenario(3.2, [
    vocal('holder', 'S1', 0, 3, ['continues']),
    vocal('failed', 'S2', 1, 1.5, ['well', 'i']),
  ]);
  assert.equal(labelAt(run, 'S1', 1.2), 'ol');
  assert.equal(labelAt(run, 'S2', 1.2), 'ol');
  assert.equal(run.transitions.length, 0);
  assert(run.flags.some((flag) => flag.code === 'failed_turn_bid'));
});

await test('Appendix 10.4 lapse is wholly shs with positive FTO', () => {
  const run = scenario(4.2, [
    vocal('first', 'S1', 0, 1, ['done']),
    vocal('second', 'S2', 3.4, 4, ['shall', 'we']),
  ]);
  assert.equal(labelAt(run, 'S1', 2), 'shs');
  assert.equal(labelAt(run, 'S2', 2), 'shs');
  assert.equal(run.transitions[0].fto, 2.4);
});

await test('Appendix 10.5 filled pause, transition and artifact', () => {
  const run = scenario(3.2, [
    vocal('first-a', 'S1', 0, 0.5, ['start']),
    vocal('filled', 'S1', 0.5, 0.7, ['um'], { lexical_class: 'filled_pause' }),
    vocal('first-b', 'S1', 0.7, 1.5, ['finish']),
    artifact('noise', 'S3', 1.5, 1.65),
    vocal('second', 'S2', 2, 3, ['next']),
  ]);
  assert.equal(labelAt(run, 'S1', 0.6), 'f');
  assert.equal(labelAt(run, 'S1', 1.8), 'tr');
  assert.equal(labelAt(run, 'S3', 1.55), 'x');
  assert.equal(run.transitions[0].fto, 0.5);
});

await test('Appendix 10.6 unattributed sounding is flagged and appears as op', () => {
  const run = scenario(3.2, [
    vocal('part-a', 'S1', 0, 1, ['before']),
    vocal('part-b', 'S1', 2, 3, ['after']),
  ], { soundingIntervals: [{ start: 0, end: 3 }] });
  assert.equal(labelAt(run, 'S1', 1.5), 'op');
  assert(run.flags.some((flag) => flag.code === 'unattributed_sounding' && flag.start <= 1 && flag.end >= 2));
});

await test('Q1-DES-005 rejects backchannel when any one of four conditions fails', () => {
  const holderEvents = [vocal('h1', 'S1', 0, 1, ['talk']), vocal('h2', 'S1', 2, 3, ['resume'])];
  const cases = [
    [vocal('too-long', 'S2', 1.1, 1.2, ['yeah', 'yes', 'right', 'okay']), 'short_or_nonlexical'],
    [vocal('not-majority', 'S2', 1.1, 1.2, ['yeah', 'topic']), 'lexical_majority'],
    [vocal('projector', 'S2', 1.1, 1.2, ['but', 'yeah', 'yes']), 'non_projecting_start'],
  ];
  for (const [candidate, failedCondition] of cases) {
    const result = evaluateBackchannel(candidate, 'S1', [...holderEvents, candidate]);
    assert.equal(result.qualifies, false);
    assert.equal(result.conditions[failedCondition], false);
  }
  const noCarry = vocal('no-carry', 'S2', 1.1, 1.2, ['yeah']);
  const result = evaluateBackchannel(noCarry, 'S1', [holderEvents[0], noCarry]);
  assert.equal(result.qualifies, false);
  assert.equal(result.conditions.holder_carries_on, false);
});

await test('Q1-DES-005 treats turn-projecting starts as turn attempts', () => {
  for (const projector of ['what', 'but', 'so', 'well', 'actually', 'no']) {
    const candidate = vocal(`project-${projector}`, 'S2', 0.5, 0.7, [projector, 'yeah', 'yes']);
    const holder = vocal(`holder-${projector}`, 'S1', 0, 1, ['talk']);
    assert.equal(evaluateBackchannel(candidate, 'S1', [holder, candidate]).conditions.non_projecting_start, false);
  }
  const think = vocal('project-think', 'S2', 0.5, 0.7, ['i', 'think', 'yeah']);
  assert.equal(evaluateBackchannel(think, 'S1', [vocal('holder-think', 'S1', 0, 1), think]).conditions.non_projecting_start, false);
});

await test('Q1-DES-005 admits a soft chuckle as bc only when holder carries on', () => {
  const run = scenario(2.2, [
    vocal('holder-a', 'S1', 0, 0.8),
    laughter('chuckle', 'S2', 0.9, 1.05, { soft_chuckle: true }),
    vocal('holder-b', 'S1', 1.2, 2),
  ]);
  assert.equal(labelAt(run, 'S2', 0.95), 'bc');
});

await test('V23C edge A preserves simultaneous bc then emits S1>S2>S3 question-answer sequence', () => {
  const explicit = { semantic_evidence: 'explicit_asr', floor_eligible: true };
  const run = scenario(5, [
    vocal('primary-holder', 'S1', 0, 1.5, ['main', 'point'], explicit),
    vocal('listener-two-bc', 'S2', 0.8, 0.98, ['yeah'], explicit),
    vocal('listener-three-bc', 'S3', 0.82, 1.0, ['right'], explicit),
    vocal('listener-two-question', 'S2', 1.6, 2.0, ['what', 'about', 'you'], {
      ...explicit,
      short_explicit_question: true,
      hard_response_boundary: 'short_turn_projector_question',
    }),
    vocal('listener-three-answer', 'S3', 2.1, 4.5, ['my', 'answer'], explicit),
  ], { preFloorBackchannels: true });
  assert.equal(labelAt(run, 'S2', 0.9), 'bc');
  assert.equal(labelAt(run, 'S3', 0.9), 'bc');
  assert.deepEqual(run.transitions.map((item) => `${item.from}>${item.to}`), ['S1>S2', 'S2>S3']);
  assert.equal(valueAt(run.floorTier, 1.8), 'S2');
  assert.equal(valueAt(run.floorTier, 3), 'S3');
});

await test('V23C edge A uses bounded Assembly question identity but keeps lexical bc on local Pyannote identity', () => {
  const word = (id, speaker, assemblySpeaker, start, end, token, confidence, utterance) => ({
    id,
    speaker,
    assembly_speaker: assemblySpeaker,
    assembly_confidence: confidence,
    assembly_utterance_id: utterance,
    source_word_id: id,
    start,
    end,
    tokens: [token],
    lexical_class: 'lexical',
    provisional_kind: 'vocalisation',
  });
  const built = buildPhraseEvents([
    word('holder', 'S1', 'S1', 0, 0.2, 'continue', 0.95, 'u-holder'),
    word('question-1', 'S3', 'S2', 0.5, 0.62, 'do', 0.761, 'u-question'),
    word('question-2', 'S3', 'S2', 0.64, 0.82, 'you', 0.761, 'u-question'),
    word('answer', 'S3', 'S3', 1.1, 2.4, 'answer', 0.95, 'u-answer'),
    word('listener-bc', 'S1', 'S2', 2.7, 2.95, 'okay', 0.824, 'u-bc'),
  ], {
    hardQuestionResponseBoundary: true,
    hardQuestionSpeakerChangeOverride: true,
    lexicalBackchannelAssemblyOverride: false,
    shortQuestionMinAssemblyConfidence: 0.8,
    shortQuestionProviderScoreMargin: 0.1,
    hardQuestionAssemblySafetyFloor: 0.75,
    phraseGapSeconds: 0.35,
    activityBridgeSeconds: 0,
  });
  const question = built.events.find((event) => event.source_word_ids.includes('question-1'));
  const answer = built.events.find((event) => event.source_word_ids.includes('answer'));
  const listenerBc = built.events.find((event) => event.source_word_ids.includes('listener-bc'));
  assert.equal(question.speaker, 'S2');
  assert.equal(question.speaker_fusion.decision, 'assembly_short_question_override');
  assert.equal(question.hard_response_boundary, 'assembly_speaker_change');
  assert.equal(answer.speaker, 'S3');
  assert.equal(listenerBc.speaker, 'S1');
  assert.equal(listenerBc.speaker_fusion.decision, 'pyannote_local_majority_retained');
});

await test('V23C residual continuity ends at acoustic offset and preserves the short tr before a question', () => {
  const explicit = { semantic_evidence: 'explicit_asr', floor_eligible: true };
  const residual = vocal('holder-residual', 'S1', 1.2, 1.6, [], {
    semantic_evidence: 'unknown_acoustic',
    lexical_class: 'unknown',
    floor_eligible: false,
    holder_retention_eligible: true,
    runtime_acoustic_bc_candidate: true,
  });
  const run = scenario(3, [
    vocal('established-holder', 'S1', 0, 1, ['main'], explicit),
    residual,
    vocal('explicit-question', 'S2', 1.72, 2.2, ['do', 'you'], {
      ...explicit,
      short_explicit_question: true,
      parent_turn_projector_candidate: true,
    }),
  ], { preFloorBackchannels: true });
  assert.equal(run.transitions.length, 1);
  assert.equal(run.transitions[0].from, 'S1');
  assert.equal(run.transitions[0].to, 'S2');
  assert.equal(run.transitions[0].outgoing_offset, 1.6);
  assert.equal(run.transitions[0].incoming_onset, 1.72);
  assert.equal(labelAt(run, 'S1', 1.66), 'tr');
  assert.equal(run.diagnostics.event_floor_transfer_candidates.some((item) => item.candidate_id === residual.id), false);
});

await test('V23C acoustic response onset requires later explicit same-speaker confirmation before anchoring a transfer', () => {
  const explicit = { semantic_evidence: 'explicit_asr', floor_eligible: true };
  const run = scenario(4.5, [
    vocal('prior-holder', 'S1', 0, 1, ['main'], explicit),
    vocal('question-holder', 'S2', 1.2, 1.8, ['do', 'you'], {
      ...explicit,
      short_explicit_question: true,
      parent_turn_projector_candidate: true,
    }),
    vocal('response-acoustic-anchor', 'S3', 2.1, 2.5, [], {
      semantic_evidence: 'unknown_acoustic',
      lexical_class: 'unknown',
      floor_eligible: false,
      runtime_acoustic_bc_candidate: true,
    }),
    vocal('response-explicit-confirmation', 'S3', 3.0, 4, ['answer'], explicit),
  ], { preFloorBackchannels: true });
  const responseTransfer = run.transitions.find((item) => item.from === 'S2' && item.to === 'S3');
  assert(responseTransfer);
  assert.equal(responseTransfer.incoming_onset, 2.1);
  assert.equal(responseTransfer.candidate_id, 'response-explicit-confirmation');
  assert(run.flags.some((flag) => flag.code === 'acoustic_response_boundary_anchor_confirmed'));
  assert.deepEqual(run.diagnostics.acoustic_response_boundary_confirmations[0].runtime_evidence_ids, [
    'response-acoustic-anchor', 'response-explicit-confirmation',
  ]);
  assert.equal(run.diagnostics.event_floor_transfer_candidates.some((item) => item.candidate_id === 'response-acoustic-anchor'), false);
});

await test('V23C edge B classifies two ending listener responses before floor and emits no tr', () => {
  const explicit = { semantic_evidence: 'explicit_asr', floor_eligible: true };
  const run = scenario(4.5, [
    vocal('primary-through-end', 'S1', 0, 4.2, ['continuous', 'turn'], explicit),
    vocal('ending-bc-two', 'S2', 3.5, 3.68, ['yeah'], explicit),
    vocal('ending-bc-three', 'S3', 3.72, 3.9, ['right'], explicit),
    vocal('terminal-stop-cue', 'S2', 4.0, 4.3, ['okay', 'stop'], explicit),
  ], { preFloorBackchannels: true });
  assert.equal(labelAt(run, 'S2', 3.6), 'bc');
  assert.equal(labelAt(run, 'S3', 3.8), 'bc');
  assert.equal(run.transitions.length, 0);
  assert.equal(valueAt(run.floorTier, 3.8), 'S1');
  assert.equal(run.diagnostics.pre_floor_backchannels.length, 2);
  assert.equal(labelAt(run, 'S2', 4.1), 'x');
  assert.equal(run.diagnostics.terminal_administrative_cues.length, 1);
});

await test('Appendix section 4 keeps sub-100 ms simultaneity out of ol and flags it', () => {
  const run = scenario(1.2, [
    vocal('holder', 'S1', 0, 1),
    vocal('brief', 'S2', 0.9, 0.98, ['well']),
  ]);
  const holderLabel = labelAt(run, 'S1', 0.94);
  const briefLabel = labelAt(run, 'S2', 0.94);
  assert.equal(holderLabel, 's');
  assert.equal(briefLabel, 's');
  assert(['S1', 'S2', 'S3'].every((speaker) => labelAt(run, speaker, 0.94) !== 'ol'));
  assert(phonationIncluded(holderLabel));
  assert(phonationIncluded(briefLabel));
  assert(run.flags.some((flag) => flag.code === 'subthreshold_overlap'));
});

await test('Appendix section 4 marks overlap at 100 ms as reciprocal ol', () => {
  const run = scenario(1.2, [
    vocal('holder-qualified', 'S1', 0, 1),
    vocal('qualified', 'S2', 0.9, 1.1, ['well']),
  ]);
  assert.equal(labelAt(run, 'S1', 0.95), 'ol');
  assert.equal(labelAt(run, 'S2', 0.95), 'ol');
});

await test('Q2-IMP-002 competing simultaneous bids are flagged without duplicate FTO', () => {
  const run = scenario(3.5, [
    vocal('competition-holder', 'S1', 0, 2),
    vocal('competition-bid-a', 'S2', 1.8, 3, ['but', 'one']),
    vocal('competition-bid-b', 'S3', 1.8, 3.2, ['no', 'two']),
  ]);
  assert.equal(run.transitions.length, 0);
  assert(run.flags.some((flag) => flag.code === 'ambiguous_competing_transfer'));
  assert.equal(valueAt(run.floorTier, 2.5), 'S1');
  assert.equal(valueAt(run.floorTier, 3.1), 'S3');
  const transferKeys = run.transitions.map((transition) => `${transition.from}@${transition.point_time}`);
  assert.equal(new Set(transferKeys).size, transferKeys.length);
});

await test('Q2-IMP-002 duplicate candidates for one target collapse to one transfer', () => {
  const run = scenario(3.2, [
    vocal('duplicate-holder', 'S1', 0, 2),
    vocal('duplicate-target-a', 'S2', 1.8, 2.5, ['but']),
    vocal('duplicate-target-b', 'S2', 1.9, 3, ['continue']),
  ]);
  assert.equal(run.transitions.length, 1);
  assert.equal(run.transitions[0].from, 'S1');
  assert.equal(run.transitions[0].to, 'S2');
});

await test('Q2-IMP-002 consolidates duplicate targets before competing-target resolution', () => {
  const run = scenario(3.8, [
    vocal('combined-holder', 'S1', 0, 2),
    vocal('combined-s2-a', 'S2', 1.8, 3.5, ['but', 'first']),
    vocal('combined-s2-b', 'S2', 1.9, 3.4, ['continue']),
    vocal('combined-s3', 'S3', 1.8, 3, ['no', 'other']),
  ]);
  assert.equal(run.transitions.length, 0);
  assert(run.flags.some((flag) => flag.code === 'ambiguous_competing_transfer'));
  assert.equal(valueAt(run.floorTier, 2.5), 'S1');
  assert.equal(valueAt(run.floorTier, 3.1), 'S2');
  assert.equal(run.diagnostics.ambiguous_transfers[0].resolution_time, 3);
  assert.deepEqual(run.diagnostics.ambiguous_transfers[0].candidate_ids, [
    'combined-s2-a',
    'combined-s2-b',
    'combined-s3',
  ]);
});

await test('Q2-IMP-004 genuine overlap promotes every active vocalizer including concurrent bc to ol', () => {
  const run = scenario(3, [
    vocal('bc-overlap-holder', 'S1', 0, 2),
    vocal('bc-overlap-bid', 'S2', 1, 2.5, ['but', 'continue']),
    vocal('bc-overlap-listener', 'S3', 1.2, 1.4, ['yeah']),
  ]);
  assert.equal(labelAt(run, 'S1', 1.3), 'ol');
  assert.equal(labelAt(run, 'S2', 1.3), 'ol');
  assert.equal(labelAt(run, 'S3', 1.3), 'ol');
});

await test('Q1-DES-005 marks reciprocal two-way and three-way overlap', () => {
  const run = scenario(2.2, [
    vocal('holder', 'S1', 0, 2),
    vocal('bid-two', 'S2', 0.5, 1, ['well']),
    vocal('bid-three', 'S3', 0.6, 0.9, ['no']),
  ]);
  assert.equal(labelAt(run, 'S1', 0.55), 'ol');
  assert.equal(labelAt(run, 'S2', 0.55), 'ol');
  assert.equal(labelAt(run, 'S1', 0.7), 'ol');
  assert.equal(labelAt(run, 'S2', 0.7), 'ol');
  assert.equal(labelAt(run, 'S3', 0.7), 'ol');
});

await test('Q1-DES-005 flags own pauses longer than L and task-end shs', () => {
  const run = scenario(3.2, [
    vocal('before', 'S1', 0, 0.5),
    vocal('after', 'S1', 2, 2.5),
  ]);
  assert.equal(labelAt(run, 'S1', 1.2), 'op');
  assert(run.flags.some((flag) => flag.code === 'own_pause_exceeds_L'));
  assert.equal(labelAt(run, 'S1', 2.8), 'shs');
  assert.equal(labelAt(run, 'S2', 2.8), 'shs');
});

await test('Q1-DES-005 includes s/f/ol and excludes bc/x/pause labels from default phonation', () => {
  assert.deepEqual(
    SPEAKER_LABELS.filter((label) => phonationIncluded(label)),
    ['s', 'f', 'ol'],
  );
});

await test('Q1-DES-005 Path B never publishes automatic negative FTO', () => {
  const run = scenario(3.2, [
    vocal('outgoing', 'S1', 0, 2),
    vocal('incoming', 'S2', 1.8, 3, ['but']),
  ], { overlapMode: 'path_b_exclusive' });
  assert.equal(run.transitions.length, 1);
  assert.equal(run.transitions[0].fto, null);
  assert.equal(run.transitions[0].sign, 'missing');
  assert.equal(run.transitions[0].status, 'overlap_present_offset_not_measured');
  assert(run.flags.some((flag) => flag.code === 'manual_negative_fto_required'));
  assert.equal(valueAt(run.floorTier, 2.2), 'S2');
});

await test('PB21 qualified transition overlap suppresses a small positive FTO', () => {
  const run = scenario(2.4, [
    vocal('qualified-out', 'S1', 0, 1),
    vocal('qualified-in', 'S2', 1.05, 2.2, ['next']),
  ], {
    overlapMode: 'path_b_exclusive',
    overlapEvidence: [{
      id: 'overlap-qualified', start: 0.98, end: 1.08, duration_seconds: 0.1,
      speakers: ['S1', 'S2'], source_turn_ids: ['turn-out', 'turn-in'],
      overlap_class: 'qualified', evidence_source: 'fixture_provider',
    }],
  });
  assert.equal(run.transitions[0].fto, null);
  assert.equal(run.transitions[0].sign, 'missing');
  assert.equal(run.transitions[0].status, 'overlap_present_offset_not_measured');
  assert.match(run.transitions[0].label, /FTO=NA overlap=qualified/);
  assert.deepEqual(run.transitionEvidence[0].evidence_ids, ['overlap-qualified', 'transfer_candidate:qualified-in']);
});

await test('PB21 subthreshold transition overlap stays visible without ol or numeric FTO', () => {
  const run = scenario(2.4, [
    vocal('sub-out', 'S1', 0, 1),
    vocal('sub-in', 'S2', 1.05, 2.2, ['next']),
  ], {
    overlapMode: 'path_b_exclusive',
    overlapEvidence: [{
      id: 'overlap-subthreshold', start: 1.02, end: 1.08, duration_seconds: 0.06,
      speakers: ['S1', 'S2'], source_turn_ids: ['turn-out', 'turn-in'],
      overlap_class: 'subthreshold', evidence_source: 'fixture_provider',
    }],
  });
  assert.equal(run.transitions[0].fto, null);
  assert.equal(run.transitions[0].status, 'subthreshold_overlap_present_offset_not_measured');
  assert.match(run.transitions[0].label, /FTO=NA overlap=subthreshold/);
  assert(run.flags.some((flag) => flag.code === 'subthreshold_overlap_present_offset_not_measured'));
  assert(['S1', 'S2', 'S3'].every((speaker) =>
    run.speakerTiers[speaker].every((interval) => interval.text !== 'ol')));
});

await test('PB21 overlap away from a transition does not suppress an unrelated FTO', () => {
  const run = scenario(3, [
    vocal('away-out', 'S1', 0, 1),
    vocal('away-in', 'S2', 1.5, 2.8, ['next']),
  ], {
    overlapMode: 'path_b_exclusive',
    overlapEvidence: [{
      id: 'overlap-away', start: 2.2, end: 2.35, duration_seconds: 0.15,
      speakers: ['S1', 'S2'], source_turn_ids: ['turn-away-a', 'turn-away-b'],
      overlap_class: 'qualified', evidence_source: 'fixture_provider',
    }],
  });
  assert.equal(run.transitions[0].fto, 0.5);
  assert.equal(run.transitions[0].status, 'provisional');
});

await test('PB21 retained evidence recomputes a Path A signed overlap candidate', () => {
  const row = {
    from_speaker: 'S1', to_speaker: 'S2', turn_end_sec: 1, turn_start_sec: 1.05,
    fto_status: 'overlap_present_offset_not_measured',
    evidence_ids: '["provider-q","transfer_candidate:incoming"]',
  };
  const capability = {
    overlap_evidence: [{
      id: 'provider-q', source_turn_ids: ['outgoing-turn', 'incoming-turn'],
    }],
    mapped_attribution_turns: [
      { id: 'outgoing-turn', speaker: 'S1', start_sec: 0, end_sec: 1.1 },
      { id: 'incoming-turn', speaker: 'S2', start_sec: 1.02, end_sec: 2 },
    ],
  };
  const recomputed = recomputePathACandidateFromStoredEvidence(row, capability);
  assert.equal(recomputed.fto_sec, -0.08);
  assert.equal(recomputed.sign, 'negative');
  assert.equal(recomputed.outgoing_turn_id, 'outgoing-turn');
  assert.equal(recomputed.incoming_turn_id, 'incoming-turn');
});

await test('Q1-DES-004 flags are sorted, joined and Praat quotes are escaped', () => {
  const frames = buildBaseActivityFrames(0.02, []);
  const tier = flagsToFrameText(frames, [
    { start: 0, end: 0.02, code: 'beta' },
    { start: 0, end: 0.02, code: 'alpha' },
    { start: 0, end: 0.02, code: 'alpha' },
  ]);
  assert.equal(tier[0].text, 'alpha|beta');
  const text = serializeTextGrid({
    xmin: 0,
    xmax: 0.02,
    tiers: [{ class: 'IntervalTier', name: 'quote', xmin: 0, xmax: 0.02, intervals: [{ start: 0, end: 0.02, text: 'needs"review' }] }],
  });
  assert(text.includes('text = "needs""review"'));
});

await test('Q1-DES-004 produces exactly six valid, full-coverage tiers', () => {
  fullRun = runMultilogueV2(syntheticPipelineInput());
  for (const output of Object.values(fullRun.thresholds)) {
    assert.equal(output.textgrid_document.tiers.length, 6);
    assert.deepEqual(output.textgrid_document.tiers.map((tier) => tier.name), ['S1', 'S2', 'S3', 'floor', 'transitions', 'flags']);
    assert.equal(output.validation.valid, true);
    assert(output.validation.tier_reports.every((report) => report.starts_at_zero && report.ends_at_duration));
    assert(output.validation.tier_reports.every((report) => report.max_gap_sec === 0 && report.max_overlap_sec === 0));
  }
});

await test('Q1-DES-008 package rows preserve every frozen CSV schema', () => {
  assert(fullRun);
  for (const output of Object.values(fullRun.thresholds)) {
    assert.deepEqual(output.schemas, CSV_SCHEMAS);
    for (const [table, schema] of Object.entries(CSV_SCHEMAS)) {
      for (const row of output.rows[table]) assert.deepEqual(Object.keys(row), [...schema]);
    }
  }
});

await test('Q1-DES-006 legacy binary seed is disabled and never imports semantics', () => {
  const disabled = syntheticPipelineInput();
  const disabledRun = runMultilogueV2(disabled);
  assert.deepEqual(disabledRun.thresholds.P250.manifest.legacy_boundary_seed, {
    enabled: false,
    identifier: null,
    checksum: null,
    candidate_only: true,
    semantic_import: false,
    used_by_core: false,
  });
  const enabled = syntheticPipelineInput();
  enabled.legacyBoundarySeed = { enabled: true, identifier: 'legacy-seed-01', checksum: 'a'.repeat(64) };
  const enabledRun = runMultilogueV2(enabled);
  assert.equal(enabledRun.thresholds.P250.manifest.legacy_boundary_seed.enabled, true);
  assert.equal(enabledRun.thresholds.P250.manifest.legacy_boundary_seed.semantic_import, false);
  assert.equal(enabledRun.thresholds.P250.manifest.legacy_boundary_seed.used_by_core, false);
});

await test('Q1-DES-002 and Q1-DES-007 replay is deterministic and package-safe', () => {
  const first = runMultilogueV2(syntheticPipelineInput());
  const second = runMultilogueV2(syntheticPipelineInput());
  assert.equal(sha256(first), sha256(second));
  assert.notStrictEqual(first.thresholds.P250, first.thresholds.P350);
  assert.equal(first.thresholds.P250.manifest.threshold_sec, 0.25);
  assert.equal(first.thresholds.P350.manifest.threshold_sec, 0.35);
  const serialized = canonicalJson(first);
  for (const forbidden of [
    'http' + '://',
    'https' + '://',
    '/' + 'Users' + '/',
    'api_' + 'key',
    'signed_' + 'url',
  ]) assert(!serialized.includes(forbidden));
});

await test('Q1-DES-007 source and fixtures contain no network or client-data markers', () => {
  const roots = [join(repoRoot, 'scripts', 'multilogue-v2', 'core'), join(repoRoot, 'tests', 'multilogue-v2')];
  const files = roots.flatMap(listSourceFiles).filter((path) => !path.includes(`${join('tests', 'multilogue-v2', 'artifacts')}`));
  const forbidden = [
    'Multilogue' + '04',
    'http' + '://',
    'https' + '://',
    '/' + 'Users' + '/',
    'signed_' + 'url',
    'PYANNOTE_' + 'API_KEY',
  ];
  for (const path of files) {
    const source = readFileSync(path, 'utf8');
    for (const marker of forbidden) assert(!source.includes(marker), `${relative(repoRoot, path)} contains forbidden marker ${marker}`);
  }
});

if (!fullRun) fullRun = runMultilogueV2(syntheticPipelineInput());
const exemplar = fullRun.thresholds.P250;
writeFileSync(join(artifactDir, 'synthetic-six-tier.TextGrid'), exemplar.textgrid, 'utf8');
writeFileSync(join(artifactDir, 'timeline-invariant-report.json'), canonicalJson(exemplar.validation), 'utf8');

const replayA = runMultilogueV2(syntheticPipelineInput());
const replayB = runMultilogueV2(syntheticPipelineInput());
const replayReport = {
  deterministic: sha256(replayA) === sha256(replayB),
  first_digest: sha256(replayA),
  second_digest: sha256(replayB),
  threshold_digests: Object.fromEntries(Object.entries(replayA.thresholds).map(([key, value]) => [key, value.digest])),
};
writeFileSync(join(artifactDir, 'deterministic-replay.json'), canonicalJson(replayReport), 'utf8');

const report = {
  suite: 'multilogue-v2-first-slice',
  generated_at: new Date().toISOString(),
  totals: {
    tests: results.length,
    passed: results.filter((result) => result.status === 'passed').length,
    failed: results.filter((result) => result.status === 'failed').length,
  },
  deterministic_replay: replayReport,
  artifacts: [
    'synthetic-six-tier.TextGrid',
    'timeline-invariant-report.json',
    'deterministic-replay.json',
    'test-report.json',
  ],
  changed_files: [
    'specs/multilogue-v2/requirements.md',
    'specs/multilogue-v2/design.md',
    'specs/multilogue-v2/tasks.md',
    'specs/multilogue-v2/quality-round-2.md',
    'scripts/multilogue-v2/core/contracts.mjs',
    'scripts/multilogue-v2/core/mapping.mjs',
    'scripts/multilogue-v2/core/timeline.mjs',
    'scripts/multilogue-v2/core/interaction-engine.mjs',
    'scripts/multilogue-v2/core/textgrid.mjs',
    'scripts/multilogue-v2/core/validator.mjs',
    'scripts/multilogue-v2/core/pipeline.mjs',
    'tests/multilogue-v2/fixtures.mjs',
    'tests/multilogue-v2/run-tests.mjs',
    'tests/multilogue-v2/artifacts/test-report.json',
    'tests/multilogue-v2/artifacts/synthetic-six-tier.TextGrid',
    'tests/multilogue-v2/artifacts/timeline-invariant-report.json',
    'tests/multilogue-v2/artifacts/deterministic-replay.json',
  ],
  known_limitations: [
    'Synthetic deterministic core only; no client audio or human-gold accuracy claim.',
    'Real audio, Pyannote, AssemblyAI, Praat, UI, server, CSV-file and ZIP adapters are not in this slice.',
    'Actual overlap capability remains unresolved; Path B and unknown modes do not publish automatic negative FTO.',
    'Stage-1 vocalisation/laughter/artifact classifications are validated inputs, not produced by a real classifier yet.',
    'Exactly three speakers and one supplied task boundary are supported.',
    'Legacy binary TextGrid provenance is recorded but its boundaries are not parsed or reconciled.',
    'Initial backchannel lexicon and all provisional FTO boundaries require calibration and expert review.',
  ],
  results,
};
writeFileSync(join(artifactDir, 'test-report.json'), canonicalJson(report), 'utf8');

for (const result of results) {
  const prefix = result.status === 'passed' ? 'PASS' : 'FAIL';
  process.stdout.write(`${prefix} ${result.name}${result.error ? `: ${result.error}` : ''}\n`);
}
process.stdout.write(`\n${report.totals.passed}/${report.totals.tests} tests passed\n`);
if (report.totals.failed > 0) process.exitCode = 1;

async function test(name, fn) {
  const started = process.hrtime.bigint();
  try {
    await fn();
    results.push({ name, status: 'passed', duration_ms: elapsedMs(started) });
  } catch (error) {
    results.push({ name, status: 'failed', duration_ms: elapsedMs(started), error: error instanceof Error ? error.message : String(error) });
  }
}

function scenario(duration, rawEvents, options = {}) {
  const stage1 = normalizeStage1Evidence(rawEvents, { duration });
  const soundingIntervals = options.soundingIntervals || rawEvents.map((event) => ({ start: event.start, end: event.end }));
  const sharedActivity = deriveSharedActivity(
    buildBaseActivityFrames(duration, soundingIntervals),
    options.threshold ?? 0.25,
  );
  return runInteractionEngine({
    duration,
    sharedActivity,
    events: stage1.events,
    overlapEvidence: options.overlapEvidence || [],
    initialFlags: stage1.flags,
    config: {
      overlapMode: options.overlapMode || 'path_a_candidate',
      floorReleaseSeconds: 1,
      minOverlapSeconds: 0.1,
      preFloorBackchannelClassification: options.preFloorBackchannels === true,
      strictEvidenceRoles: options.preFloorBackchannels === true,
      acousticBackchannelEnabled: options.acousticBackchannelEnabled === true,
      holderContinuationWindowSeconds: options.holderContinuationWindowSeconds ?? 1,
    },
  });
}

function labelAt(run, speaker, time) {
  return valueAt(run.speakerTiers[speaker], time);
}

function valueAt(intervals, time) {
  const interval = intervals.find((candidate) => candidate.start <= time && time < candidate.end) || intervals[intervals.length - 1];
  return interval.text ?? interval.value;
}

function listSourceFiles(root) {
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const path = join(root, entry.name);
    if (entry.isDirectory()) return listSourceFiles(path);
    return entry.name.endsWith('.mjs') ? [path] : [];
  });
}

function elapsedMs(started) {
  return Number(process.hrtime.bigint() - started) / 1e6;
}
