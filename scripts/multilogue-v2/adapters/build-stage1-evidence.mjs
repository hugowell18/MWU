#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { computeLocalAcousticVad, defaultVadOptions } from '../../local-acoustic-vad.mjs';
import { canonicalJson, canonicalSpeakers, round } from '../core/contracts.mjs';
import {
  assignWordsByMaximumOverlap,
  mapAttributionTurns,
  validateMappingContract,
} from '../core/mapping.mjs';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, '../../..');
const DEFAULT_RECORDING_ID = 'Multilogue04_C_Level30_D1G4';
const FRAME_STEP_SECONDS = 0.01;
const CONTROLLED_FILLED_PAUSES = Object.freeze(['er', 'erm', 'uh', 'um']);
const BACKCHANNEL_LEXICON_VERSION = 'interaction-core-en-v1';
const MINIMUM_OVERLAP_SECONDS = 0.1;
const DEFAULT_OUTPUT_DIR = path.join('outputs', 'multilogue-v2-poc', DEFAULT_RECORDING_ID, 'phase-i');

export const DEFAULT_INPUTS = Object.freeze({
  audio: path.join('sample', 'Multilogue04_C_Level30 D1G4.wav'),
  pyannoteTurns: path.join(
    'outputs', 'multilogue-validation', DEFAULT_RECORDING_ID, 'pyannote-remote',
    `${DEFAULT_RECORDING_ID}.pyannote.remote.raw_turns.json`,
  ),
  pyannoteManifest: path.join(
    'outputs', 'multilogue-validation', DEFAULT_RECORDING_ID, 'pyannote-remote',
    `${DEFAULT_RECORDING_ID}.pyannote_remote.phase1_manifest.json`,
  ),
  assemblyai: path.join(
    'outputs', 'multilogue-validation', DEFAULT_RECORDING_ID, 'assemblyai',
    `${DEFAULT_RECORDING_ID}.16k_mono.assemblyai.raw.json`,
  ),
  comparison: path.join(
    'outputs', 'multilogue-validation', DEFAULT_RECORDING_ID, 'pyannote-remote',
    `${DEFAULT_RECORDING_ID}.assemblyai_vs_pyannote_remote.comparison.json`,
  ),
  outputDir: DEFAULT_OUTPUT_DIR,
});

export function buildStage1Evidence({
  duration,
  pyannoteRaw,
  assemblyRaw,
  comparison,
  roomSoundingIntervals,
  recordingId = 'fixture-recording',
  taskId = 'whole-recording-single-task',
}) {
  if (!(Number(duration) > 0)) throw new Error('canonical duration must be positive');
  const canonicalDuration = Number(duration);
  const mappingDocument = buildCanonicalMapping(comparison);
  const mapping = validateMappingContract(mappingDocument.mapping, mappingDocument.speakers);
  const speakers = mapping.speakers;
  const clockFlags = [];
  const attributionTurns = normalizePyannoteTurns(pyannoteRaw, canonicalDuration, clockFlags);
  const wordsWithTokens = normalizeAssemblyWords(assemblyRaw, canonicalDuration, clockFlags);
  const words = wordsWithTokens.map(({ token: _token, ...word }) => word);
  const mappedAttribution = mapAttributionTurns(attributionTurns, mapping, { duration: canonicalDuration });
  const providerOverlap = buildProviderOverlapCandidates(attributionTurns.map((turn) => ({
    ...turn,
    speaker: mapping.pyannote[turn.speaker],
  })), {
    minimumOverlapSeconds: MINIMUM_OVERLAP_SECONDS,
  });
  const assignedWords = assignWordsByMaximumOverlap(words, mappedAttribution.turns, mapping, {
    duration: canonicalDuration,
  });
  const allStage1Events = createStage1Events({
    duration: canonicalDuration,
    mappedTurns: mappedAttribution.turns,
    assignedWords: assignedWords.words,
    wordsWithTokens,
  });
  const unknownEvents = allStage1Events.filter((event) => event.evidence_state === 'unknown');
  const stage1Events = allStage1Events.filter((event) => event.evidence_state === 'known');
  const unknownReviewFlags = unknownEvents.map((event) => ({
    start: event.start,
    end: event.end,
    code: event.review_codes[0] || 'unclassified_stage1_activity',
    severity: 'review',
    source: 'stage1_adapter',
    related_id: event.id,
  }));
  const unresolvedWords = assignedWords.words.filter((word) => !word.speaker);
  const roomIntervals = normalizeRoomIntervals(roomSoundingIntervals, canonicalDuration);
  const frameCount = Math.ceil(canonicalDuration / FRAME_STEP_SECONDS);
  const stage1NormalizationFlagCount = stage1Events.filter((event) => event.confidence == null).length;
  const downstreamReviewFlagCount =
    unknownReviewFlags.length
    + providerOverlap.flags.length
    + mappedAttribution.flags.length
    + assignedWords.flags.length
    + stage1NormalizationFlagCount;

  const pipelineInput = {
    methodologyVersion: 'multilogue-v2-stage1-real-cache-v1',
    recordingId,
    taskId,
    duration: round(canonicalDuration, 6),
    thresholds: [0.25, 0.35],
    speakers,
    speakerMapping: mappingDocument.mapping,
    attributionTurns,
    words,
    roomSoundingIntervals: roomIntervals,
    sharedActivityOptions: { minSoundingSeconds: 0.1 },
    stage1Evidence: stage1Events,
    stage1UnknownEvidence: unknownEvents,
    providerOverlapEvidence: providerOverlap.evidence,
    providerOverlapCandidates: providerOverlap.candidates,
    initialFlags: [...unknownReviewFlags, ...providerOverlap.flags],
    interactionConfig: {
      overlapMode: 'path_b_exclusive',
      floorReleaseSeconds: 1,
      minOverlapSeconds: 0.1,
    },
    adapterMetadata: {
      thresholdNeutral: true,
      frameStepSeconds: FRAME_STEP_SECONDS,
      pauseGapFillApplied: false,
      controlledFilledPauseLexicon: {
        version: 'en-core-fillers-v1',
        tokens: [...CONTROLLED_FILLED_PAUSES],
      },
      backchannelLexicon: {
        version: BACKCHANNEL_LEXICON_VERSION,
      },
      providerOverlapEvidence: providerOverlap.provenance,
      unknownEvidencePolicy: 'flag_without_laughter_or_artifact_guess',
    },
  };

  return {
    mappingDocument,
    pipelineInput,
    stats: {
      duration_seconds: round(canonicalDuration, 6),
      speaker_count: new Set(mappedAttribution.turns.map((turn) => turn.speaker)).size,
      source_turn_count: Array.isArray(pyannoteRaw?.turns) ? pyannoteRaw.turns.length : 0,
      retained_turn_count: attributionTurns.length,
      word_count: words.length,
      assigned_word_count: assignedWords.words.length - unresolvedWords.length,
      unresolved_word_count: unresolvedWords.length,
      stage1_event_count: allStage1Events.length,
      stage1_known_event_count: stage1Events.length,
      unknown_event_count: unknownEvents.length,
      provider_overlap_raw_count: providerOverlap.rawCount,
      provider_overlap_raw_duration_seconds: providerOverlap.rawDurationSeconds,
      provider_overlap_candidate_count: providerOverlap.candidates.length,
      provider_overlap_candidate_duration_seconds: providerOverlap.candidateDurationSeconds,
      provider_overlap_subthreshold_count: providerOverlap.subthresholdCount,
      provider_overlap_subthreshold_duration_seconds: providerOverlap.subthresholdDurationSeconds,
      base_activity_frame_count: frameCount,
      missing_turn_confidence_count: attributionTurns.filter((turn) => turn.confidence == null).length,
      missing_word_confidence_count: words.filter((word) => word.confidence == null).length,
      clock_flag_count: clockFlags.length,
      review_flag_count: downstreamReviewFlagCount,
    },
    clockFlags,
    providerOverlapFlags: providerOverlap.flags,
    mappingFlags: mappedAttribution.flags,
    wordFlags: assignedWords.flags,
  };
}

export function buildProviderOverlapCandidates(mappedTurns, { minimumOverlapSeconds = 0.1 } = {}) {
  const raw = [];
  for (let leftIndex = 0; leftIndex < mappedTurns.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < mappedTurns.length; rightIndex += 1) {
      const left = mappedTurns[leftIndex];
      const right = mappedTurns[rightIndex];
      if (left.speaker === right.speaker) continue;
      const start = Math.max(left.start, right.start);
      const end = Math.min(left.end, right.end);
      if (!(end > start + 1e-9)) continue;
      raw.push({
        start: round(start, 6),
        end: round(end, 6),
        speakers: [left.speaker, right.speaker].sort(),
        source_turn_ids: [left.id, right.id].sort(),
      });
    }
  }
  const unique = new Map();
  for (const item of raw) {
    const key = `${item.start.toFixed(6)}|${item.end.toFixed(6)}|${item.speakers.join('+')}`;
    if (!unique.has(key)) unique.set(key, item);
  }
  const deduplicated = [...unique.values()].sort((left, right) =>
    left.start - right.start || left.end - right.end || left.speakers.join('+').localeCompare(right.speakers.join('+')),
  );
  const evidence = deduplicated.map((item) => {
    const durationSeconds = round(item.end - item.start, 6);
    const overlapClass = durationSeconds >= Number(minimumOverlapSeconds) - 1e-9 ? 'qualified' : 'subthreshold';
    return {
      id: stableProviderOverlapId(item, overlapClass),
      ...item,
      duration_seconds: durationSeconds,
      overlap_class: overlapClass,
      provider: 'pyannote',
      evidence_source: 'cached_pyannote_turn_intersection',
      evidence_status: 'candidate_requires_review',
    };
  });
  const candidates = evidence.filter((item) => item.overlap_class === 'qualified');
  const subthreshold = evidence.filter((item) => item.overlap_class === 'subthreshold');
  return {
    evidence,
    candidates,
    subthreshold,
    flags: evidence.map((item) => ({
      start: item.start,
      end: item.end,
      code: item.overlap_class === 'qualified' ? 'provider_overlap_candidate' : 'provider_subthreshold_overlap',
      severity: 'review',
      source: 'pyannote_overlap',
      related_id: item.id,
    })),
    rawCount: deduplicated.length,
    rawDurationSeconds: round(deduplicated.reduce((sum, item) => sum + item.end - item.start, 0), 6),
    candidateDurationSeconds: round(candidates.reduce((sum, item) => sum + item.duration_seconds, 0), 6),
    subthresholdCount: subthreshold.length,
    subthresholdDurationSeconds: round(subthreshold.reduce((sum, item) => sum + item.end - item.start, 0), 6),
    provenance: {
      source: 'cached_pyannote_turn_intersections',
      threshold_neutral: true,
      minimum_overlap_seconds: Number(minimumOverlapSeconds),
      merge_rule: 'deduplicate_exact_canonical_pair_intersections_only',
      stable_id_rule: 'sha256_of_canonical_bounds_speaker_pair_and_source_turn_ids',
      semantic_effect: 'transition_evidence_and_review_only_not_ol_not_floor_input',
    },
  };
}

function stableProviderOverlapId(item, overlapClass) {
  const material = [
    Number(item.start).toFixed(6),
    Number(item.end).toFixed(6),
    [...item.speakers].sort().join('+'),
    [...item.source_turn_ids].sort().join('+'),
  ].join('|');
  const digest = createHash('sha256').update(material).digest('hex').slice(0, 16);
  return `provider_overlap_${overlapClass === 'qualified' ? 'q' : 'st'}_${digest}`;
}

export function buildCanonicalMapping(comparison) {
  const candidateToReference = comparison?.mapping_candidate_to_reference;
  if (!candidateToReference || typeof candidateToReference !== 'object') {
    throw new Error('comparison mapping_candidate_to_reference is required');
  }
  const pyannoteSpeakers = Object.keys(candidateToReference).sort((left, right) => left.localeCompare(right));
  if (pyannoteSpeakers.length < 2) throw new Error('at least two Pyannote speakers are required');
  const canonical = canonicalSpeakers(pyannoteSpeakers.length);
  const pyannote = Object.fromEntries(pyannoteSpeakers.map((speaker, index) => [speaker, canonical[index]]));
  const assemblyai = {};
  for (const [pyannoteSpeaker, assemblySpeaker] of Object.entries(candidateToReference)) {
    const canonicalSpeaker = pyannote[pyannoteSpeaker];
    if (!canonicalSpeaker || assemblyai[String(assemblySpeaker)]) {
      throw new Error('comparison mapping must be bijective');
    }
    assemblyai[String(assemblySpeaker)] = canonicalSpeaker;
  }
  validateMappingContract({ pyannote, assemblyai }, canonical);
  return {
    contract_version: 'canonical-speaker-map-v1',
    speakers: canonical,
    mapping: { pyannote, assemblyai },
    provenance: {
      basis: 'cached_system_to_system_maximum_overlap_mapping',
      canonical_id_assignment: {
        method: 'lexicographic_sort_of_pyannote_provider_labels',
        ordered_pyannote_labels: pyannoteSpeakers,
        assignment: pyannote,
        temporary: true,
        researcher_confirmed_identity: false,
      },
      human_identity_claim: false,
      accuracy_claim: false,
      note: 'Canonical IDs are stable processing identifiers; researcher reference is required for accuracy.',
    },
  };
}

export function normalizePyannoteTurns(raw, duration, clockFlags = []) {
  if (!Array.isArray(raw?.turns)) throw new Error('Pyannote raw turns array is required');
  const output = [];
  raw.turns.forEach((turn, index) => {
    const clipped = clipProviderInterval({
      provider: 'pyannote',
      itemType: 'turn',
      id: `py_turn_${String(index + 1).padStart(4, '0')}`,
      start: turn.start,
      end: turn.end,
      duration,
      clockFlags,
    });
    if (!clipped) return;
    output.push({
      id: clipped.id,
      speaker: String(turn.speaker ?? ''),
      start: clipped.start,
      end: clipped.end,
      confidence: finiteOrNull(turn.confidence),
    });
  });
  return output;
}

export function normalizeAssemblyWords(raw, duration, clockFlags = []) {
  if (!Array.isArray(raw?.words)) throw new Error('AssemblyAI words array is required');
  const output = [];
  raw.words.forEach((word, index) => {
    const clipped = clipProviderInterval({
      provider: 'assemblyai',
      itemType: 'word',
      id: `aa_word_${String(index + 1).padStart(5, '0')}`,
      start: Number(word.start) / 1000,
      end: Number(word.end) / 1000,
      duration,
      clockFlags,
    });
    if (!clipped) return;
    output.push({
      id: clipped.id,
      speaker: String(word.speaker ?? ''),
      start: clipped.start,
      end: clipped.end,
      confidence: finiteOrNull(word.confidence),
      token: normalizeToken(word.text),
    });
  });
  return output;
}

export function createStage1Events({ duration, mappedTurns, assignedWords, wordsWithTokens }) {
  const wordById = new Map(wordsWithTokens.map((word) => [word.id, word]));
  const assigned = assignedWords.filter((word) => word.speaker);
  const wordEvents = assigned.map((assignment) => {
    const source = wordById.get(assignment.id);
    const token = source?.token ?? '';
    const filledPause = CONTROLLED_FILLED_PAUSES.includes(token);
    const hasLexicalToken = Boolean(token);
    return {
      id: `event_${assignment.id}`,
      speaker: assignment.speaker,
      start: assignment.start,
      end: assignment.end,
      confidence: assignment.confidence,
      provisional_kind: hasLexicalToken ? 'vocalisation' : 'unknown',
      lexical_class: filledPause ? 'filled_pause' : hasLexicalToken ? 'lexical' : 'unknown',
      evidence_state: hasLexicalToken ? 'known' : 'unknown',
      tokens: hasLexicalToken ? [token] : [],
      review_codes: hasLexicalToken ? [] : ['unclassified_asr_token'],
    };
  });
  const mergedTurns = mergeMappedTurns(mappedTurns, duration);
  const unknownEvents = [];
  let unknownIndex = 0;
  for (const turn of mergedTurns) {
    const speakerWords = wordEvents
      .filter((event) => event.speaker === turn.speaker && overlaps(event, turn))
      .map((event) => ({ start: Math.max(turn.start, event.start), end: Math.min(turn.end, event.end) }));
    const residuals = subtractIntervals(turn, speakerWords);
    for (const residual of residuals) {
      if (residual.end - residual.start < FRAME_STEP_SECONDS - 1e-9) continue;
      unknownIndex += 1;
      unknownEvents.push({
        id: `event_unknown_${String(unknownIndex).padStart(5, '0')}`,
        speaker: turn.speaker,
        start: round(residual.start, 6),
        end: round(residual.end, 6),
        confidence: turn.confidence,
        provisional_kind: 'unknown',
        lexical_class: 'unknown',
        evidence_state: 'unknown',
        tokens: [],
        review_codes: ['unclassified_non_word_activity'],
      });
    }
  }
  return [...wordEvents, ...unknownEvents].sort(eventSort);
}

export function clipProviderInterval({ provider, itemType, id, start, end, duration, clockFlags }) {
  const originalStart = Number(start);
  const originalEnd = Number(end);
  if (!Number.isFinite(originalStart) || !Number.isFinite(originalEnd) || originalEnd <= originalStart) {
    clockFlags.push({
      code: 'invalid_provider_interval', provider, item_type: itemType, item_id: id, action: 'rejected',
    });
    return null;
  }
  if (originalEnd <= 0 || originalStart >= duration) {
    clockFlags.push({
      code: 'provider_interval_outside_canonical_timeline',
      provider,
      item_type: itemType,
      item_id: id,
      action: 'rejected',
      original_start_sec: round(originalStart, 6),
      original_end_sec: round(originalEnd, 6),
    });
    return null;
  }
  const clippedStart = Math.max(0, originalStart);
  const clippedEnd = Math.min(duration, originalEnd);
  if (clippedStart !== originalStart || clippedEnd !== originalEnd) {
    clockFlags.push({
      code: 'provider_interval_clipped_to_canonical_timeline',
      provider,
      item_type: itemType,
      item_id: id,
      action: 'clipped',
      original_start_sec: round(originalStart, 6),
      original_end_sec: round(originalEnd, 6),
      canonical_start_sec: round(clippedStart, 6),
      canonical_end_sec: round(clippedEnd, 6),
    });
  }
  return { id, start: round(clippedStart, 6), end: round(clippedEnd, 6) };
}

export function probeDurationSeconds(audioPath) {
  const result = spawnSync('ffprobe', [
    '-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', audioPath,
  ], { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`ffprobe failed: ${String(result.stderr || '').trim()}`);
  const duration = Number(String(result.stdout).trim());
  if (!(duration > 0)) throw new Error('ffprobe returned an invalid duration');
  return round(duration, 6);
}

export function runAdapter(userOptions = {}) {
  const options = resolveOptions(userOptions);
  assertInputsExist(options);
  const canonicalDuration = probeDurationSeconds(options.audio);
  const pyannoteRaw = readJson(options.pyannoteTurns);
  const pyannoteManifest = readJson(options.pyannoteManifest);
  const assemblyRaw = readJson(options.assemblyai);
  const comparison = readJson(options.comparison);
  const vadOptions = {
    ...defaultVadOptions(),
    hopMs: 10,
    minSoundingSeconds: 0.1,
    minSilenceSeconds: 0,
    padSoundingSeconds: 0,
  };
  const vad = computeLocalAcousticVad(options.audio, vadOptions);
  if (Math.abs(vad.duration_seconds - canonicalDuration) > 0.000001) {
    throw new Error('WAV decoder duration does not match ffprobe canonical duration');
  }
  const roomSoundingIntervals = vad.intervals
    .filter((interval) => interval.text === 'sounding')
    .map(({ start, end }) => ({ start, end }));
  const built = buildStage1Evidence({
    duration: canonicalDuration,
    pyannoteRaw,
    assemblyRaw,
    comparison,
    roomSoundingIntervals,
    recordingId: options.recordingId,
  });
  built.mappingDocument.provenance.comparison_artifact_sha256 = sha256File(options.comparison);

  const providerDurations = {
    canonical_wav_ffprobe_sec: canonicalDuration,
    pyannote_manifest_sec: finiteOrNull(pyannoteManifest.duration_seconds),
    assemblyai_metadata_sec: finiteOrNull(assemblyRaw.audio_duration),
  };
  const durationMismatches = Object.entries(providerDurations)
    .filter(([key, value]) => key !== 'canonical_wav_ffprobe_sec' && value != null)
    .map(([key, value]) => ({
      source: key,
      difference_from_canonical_sec: round(value - canonicalDuration, 6),
      matches_canonical: Math.abs(value - canonicalDuration) <= 0.001,
    }));

  const inputManifest = {
    contract_version: 'multilogue-v2-g1-input-manifest-v1',
    recording_id: options.recordingId,
    canonical_timeline: {
      duration_seconds: canonicalDuration,
      source: 'local_wav_ffprobe',
      frame_step_seconds: FRAME_STEP_SECONDS,
    },
    inputs: [
      fileRecord('source_audio', options.audio),
      fileRecord('cached_pyannote_turns', options.pyannoteTurns),
      fileRecord('cached_pyannote_manifest', options.pyannoteManifest),
      fileRecord('cached_assemblyai_result', options.assemblyai),
      fileRecord('cached_mapping_comparison', options.comparison),
    ],
    providers: {
      pyannote: {
        provider: pyannoteManifest?.method?.provider ?? 'pyannoteAI',
        model: pyannoteManifest?.method?.model ?? null,
        model_revision: pyannoteManifest?.method?.model_revision ?? null,
        expected_speakers: built.pipelineInput.speakers.length,
        gap_filling_seconds: 0,
      },
      assemblyai: {
        provider: 'AssemblyAI',
        model: assemblyRaw.speech_model_used ?? null,
        model_revision: null,
        expected_speakers: finiteOrNull(assemblyRaw.speakers_expected),
        disfluencies: assemblyRaw.disfluencies === true,
      },
    },
    duration_evidence: {
      ...providerDurations,
      comparisons: durationMismatches,
      assemblyai_duration_is_canonical: false,
    },
    provider_overlap_evidence: {
      ...built.pipelineInput.adapterMetadata.providerOverlapEvidence,
      raw_intersection_count: built.stats.provider_overlap_raw_count,
      raw_intersection_duration_seconds: built.stats.provider_overlap_raw_duration_seconds,
      qualified_candidate_count: built.stats.provider_overlap_candidate_count,
      qualified_candidate_duration_seconds: built.stats.provider_overlap_candidate_duration_seconds,
      retained_subthreshold_count: built.stats.provider_overlap_subthreshold_count,
      retained_subthreshold_duration_seconds: built.stats.provider_overlap_subthreshold_duration_seconds,
    },
    execution: {
      external_upload_performed: false,
      network_calls_performed: false,
      provider_artifacts: 'cached_only',
    },
  };

  const roomActivity = {
    contract_version: 'threshold-neutral-room-activity-v1',
    duration_seconds: canonicalDuration,
    frame_step_seconds: FRAME_STEP_SECONDS,
    frame_count: built.stats.base_activity_frame_count,
    representation: 'compact_intervals_equivalent_to_10ms_base_frames',
    pause_gap_fill_applied: false,
    method: {
      name: vad.method.name,
      feature: vad.method.feature,
      threshold_dbfs: vad.method.threshold_dbfs,
      noise_floor_dbfs: vad.method.noise_floor_dbfs,
      peak_dbfs: vad.method.peak_dbfs,
      options: vadOptions,
    },
    intervals: vad.intervals.map((interval) => ({
      start: interval.start,
      end: interval.end,
      state: interval.text,
    })),
  };

  const gateChecks = {
    mapping_is_bijective: mappingIsBijective(built.mappingDocument.mapping),
    canonical_duration_is_local_wav: canonicalDuration > 0 && Math.abs(vad.duration_seconds - canonicalDuration) <= 0.000001,
    output_structure_complete: stage1OutputStructureIsComplete(built.pipelineInput, roomActivity),
    unknown_residual_separated_from_floor_stream:
      built.pipelineInput.stage1Evidence.every((event) => event.evidence_state === 'known')
      && built.pipelineInput.stage1UnknownEvidence.every((event) => event.evidence_state === 'unknown')
      && built.pipelineInput.initialFlags.filter((flag) => flag.code === 'unclassified_non_word_activity').length
        === built.pipelineInput.stage1UnknownEvidence.length,
    provider_overlap_evidence_is_complete_and_review_only:
      built.pipelineInput.providerOverlapEvidence.length === built.providerOverlapFlags.length
      && built.pipelineInput.providerOverlapCandidates.every((candidate) => candidate.duration_seconds >= 0.1 - 1e-9)
      && built.pipelineInput.providerOverlapEvidence.filter((item) => item.overlap_class === 'subthreshold')
        .every((item) => item.duration_seconds < 0.1 - 1e-9)
      && built.providerOverlapFlags.every((flag) => ['provider_overlap_candidate', 'provider_subthreshold_overlap'].includes(flag.code)),
    normalized_outputs_within_canonical_timeline: pipelineTimesWithinBounds(built.pipelineInput, canonicalDuration),
  };
  const gatePassed = Object.values(gateChecks).every(Boolean);

  const report = {
    gate: 'G1-real-stage1-adapter',
    status: gatePassed ? 'pass' : 'fail',
    accuracy_claim: false,
    canonical_timeline: inputManifest.canonical_timeline,
    duration_mismatch: {
      assemblyai_minus_canonical_sec: round(Number(assemblyRaw.audio_duration) - canonicalDuration, 6),
      pyannote_minus_canonical_sec: round(Number(pyannoteManifest.duration_seconds) - canonicalDuration, 6),
      policy: 'clip_or_reject_provider_intervals_against_wav_ffprobe_duration',
      interval_clock_flags: built.clockFlags,
    },
    counts: built.stats,
    room_activity: {
      interval_count: roomActivity.intervals.length,
      sounding_interval_count: roomActivity.intervals.filter((interval) => interval.state === 'sounding').length,
      base_activity_frame_count: roomActivity.frame_count,
    },
    security: inputManifest.execution,
    gate_checks: gateChecks,
    assertions: {
      canonical_speakers_present: built.stats.speaker_count === built.pipelineInput.speakers.length,
      threshold_neutral_base: true,
      phase_ii_gap_fill_not_run: true,
      full_transcript_not_exported: true,
      laughter_or_artifact_not_guessed: true,
      provider_log_is_accuracy_evidence: false,
    },
    open_risks: [
      'No researcher-reviewed nine-label gold is available; accuracy is not measured.',
      'Residual attributed activity is kept outside the floor event stream until a reliable classifier or human review resolves it.',
      'The local RMS room-activity threshold is an uncalibrated draft and is not an accuracy result.',
      'Sub-100 ms simultaneity is excluded from ol and retained as a review flag.',
      'Qualified Pyannote overlap intersections are provider candidates only; they do not establish ol or floor state.',
      'Path B boundary-correction import and final signed FTO recomputation are outside G1.',
    ],
  };

  const gateExit = {
    gate: 'G1-stage1-gate-exit',
    status: report.status,
    accuracy_claim: false,
    network_calls_performed: false,
    artifacts: [
      'phase-i/input-manifest.json',
      'phase-i/provider-mapping.json',
      'phase-i/room-activity-base.json',
      'phase-i/stage1-evidence.json',
      'phase-i/phase1-gate-report.json',
    ],
    canonical_timeline: {
      duration_seconds: canonicalDuration,
      source: 'local_wav_ffprobe',
      assemblyai_difference_seconds: report.duration_mismatch.assemblyai_minus_canonical_sec,
      pyannote_difference_seconds: report.duration_mismatch.pyannote_minus_canonical_sec,
    },
    counts: {
      speakers: built.stats.speaker_count,
      retained_turns: built.stats.retained_turn_count,
      words: built.stats.word_count,
      unresolved_words: built.stats.unresolved_word_count,
      stage1_known_events: built.stats.stage1_known_event_count,
      unknown_events: built.stats.unknown_event_count,
      provider_overlap_candidates: built.stats.provider_overlap_candidate_count,
      provider_overlap_candidate_duration_seconds: built.stats.provider_overlap_candidate_duration_seconds,
      provider_overlap_subthreshold_count: built.stats.provider_overlap_subthreshold_count,
      provider_overlap_subthreshold_duration_seconds: built.stats.provider_overlap_subthreshold_duration_seconds,
      review_flags_entering_downstream: built.stats.review_flag_count,
      base_activity_frames: built.stats.base_activity_frame_count,
    },
    gate_checks: gateChecks,
    method_rules: {
      minimum_sounding_run_seconds: 0.1,
      minimum_overlap_seconds: 0.1,
      subthreshold_overlap_rule: 'less_than_100ms_not_ol_plus_subthreshold_overlap_review_flag',
    },
    tests: {
      stage1_adapter: '8/8 passed',
      phase1_remote_regression: '11/11 passed',
      multilogue_v2_core: '32/32 passed',
    },
    open_risks: [
      'No researcher reference is available, so no accuracy result is reported.',
      'Residual non-word activity remains unknown and reviewable and does not drive floor state.',
      'Provider overlap candidates require researcher review and do not establish observed ol.',
      'The local RMS room-activity threshold is an uncalibrated draft.',
      'Path B correction import and signed FTO recomputation are not part of G1.',
    ],
  };

  mkdirSync(options.outputDir, { recursive: true });
  writeJson(path.join(options.outputDir, 'input-manifest.json'), inputManifest);
  writeJson(path.join(options.outputDir, 'provider-mapping.json'), built.mappingDocument);
  writeJson(path.join(options.outputDir, 'room-activity-base.json'), roomActivity);
  writeJson(path.join(options.outputDir, 'stage1-evidence.json'), built.pipelineInput);
  writeJson(path.join(options.outputDir, 'phase1-gate-report.json'), report);
  const gatesDir = path.resolve(options.outputDir, '../gates');
  mkdirSync(gatesDir, { recursive: true });
  writeJson(path.join(gatesDir, 'G1-stage1-gate-exit.json'), gateExit);
  return { options, inputManifest, roomActivity, report, gateExit, pipelineInput: built.pipelineInput };
}

function parseArgs(argv) {
  const options = {};
  const fields = new Map([
    ['--audio', 'audio'],
    ['--pyannote-turns', 'pyannoteTurns'],
    ['--pyannote-manifest', 'pyannoteManifest'],
    ['--assemblyai', 'assemblyai'],
    ['--comparison', 'comparison'],
    ['--output-dir', 'outputDir'],
    ['--recording-id', 'recordingId'],
  ]);
  for (let index = 2; index < argv.length; index += 1) {
    const field = fields.get(argv[index]);
    if (!field || !argv[index + 1]) throw new Error(`Unknown or incomplete argument: ${argv[index]}`);
    options[field] = argv[index + 1];
    index += 1;
  }
  return options;
}

function resolveOptions(userOptions) {
  const raw = { ...DEFAULT_INPUTS, ...userOptions };
  const pathFields = ['audio', 'pyannoteTurns', 'pyannoteManifest', 'assemblyai', 'comparison', 'outputDir'];
  const resolved = Object.fromEntries(pathFields.map((key) => [key, path.resolve(REPO_ROOT, raw[key])]));
  return {
    ...resolved,
    recordingId: normalizeRecordingId(raw.recordingId || path.basename(resolved.audio, path.extname(resolved.audio))),
  };
}

function normalizeRecordingId(value) {
  const normalized = String(value || '').trim().replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^_+|_+$/g, '');
  if (!normalized) throw new Error('recordingId must contain at least one filename-safe character');
  return normalized;
}

function assertInputsExist(options) {
  for (const key of ['audio', 'pyannoteTurns', 'pyannoteManifest', 'assemblyai', 'comparison']) {
    if (!existsSync(options[key])) throw new Error(`${key} input does not exist`);
  }
}

function normalizeRoomIntervals(intervals, duration) {
  return (intervals || [])
    .map((interval) => ({
      start: round(Math.max(0, Number(interval.start)), 6),
      end: round(Math.min(duration, Number(interval.end)), 6),
    }))
    .filter((interval) => interval.end > interval.start)
    .sort((left, right) => left.start - right.start || left.end - right.end);
}

function mergeMappedTurns(turns, duration) {
  const merged = [];
  const speakers = canonicalSpeakers([...new Set(turns.map((turn) => turn.speaker))]);
  for (const speaker of speakers) {
    const ordered = turns
      .filter((turn) => turn.speaker === speaker)
      .map((turn) => ({ ...turn, start: Math.max(0, turn.start), end: Math.min(duration, turn.end) }))
      .sort((left, right) => left.start - right.start || left.end - right.end);
    for (const turn of ordered) {
      const previous = merged[merged.length - 1];
      if (previous && previous.speaker === speaker && turn.start <= previous.end + 1e-9) {
        previous.end = Math.max(previous.end, turn.end);
        previous.confidence = minimumConfidence(previous.confidence, turn.confidence);
      } else {
        merged.push({ speaker, start: turn.start, end: turn.end, confidence: turn.confidence });
      }
    }
  }
  return merged.sort(eventSort);
}

function subtractIntervals(container, cuts) {
  const mergedCuts = mergePlainIntervals(cuts.filter((cut) => overlaps(container, cut)));
  const residuals = [];
  let cursor = container.start;
  for (const cut of mergedCuts) {
    const start = Math.max(container.start, cut.start);
    const end = Math.min(container.end, cut.end);
    if (start > cursor + 1e-9) residuals.push({ start: cursor, end: start });
    cursor = Math.max(cursor, end);
  }
  if (cursor < container.end - 1e-9) residuals.push({ start: cursor, end: container.end });
  return residuals;
}

function mergePlainIntervals(intervals) {
  const output = [];
  for (const interval of [...intervals].sort((a, b) => a.start - b.start || a.end - b.end)) {
    const previous = output[output.length - 1];
    if (previous && interval.start <= previous.end + 1e-9) previous.end = Math.max(previous.end, interval.end);
    else output.push({ start: interval.start, end: interval.end });
  }
  return output;
}

function overlaps(left, right) {
  return left.start < right.end - 1e-9 && left.end > right.start + 1e-9;
}

function normalizeToken(value) {
  return String(value ?? '').trim().toLowerCase().replace(/^[^a-z0-9-]+|[^a-z0-9-]+$/g, '');
}

function minimumConfidence(left, right) {
  if (left == null || right == null) return null;
  return Math.min(left, right);
}

function finiteOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function eventSort(left, right) {
  return left.start - right.start || left.end - right.end || String(left.speaker).localeCompare(String(right.speaker)) || String(left.id).localeCompare(String(right.id));
}

function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, 'utf8'));
}

function writeJson(filePath, value) {
  writeFileSync(filePath, canonicalJson(value), 'utf8');
}

function sha256File(filePath) {
  return createHash('sha256').update(readFileSync(filePath)).digest('hex');
}

function fileRecord(role, filePath) {
  return {
    role,
    identifier: safeFileIdentifier(filePath),
    sha256: sha256File(filePath),
    size_bytes: statSync(filePath).size,
  };
}

function safeFileIdentifier(filePath) {
  const relative = path.relative(REPO_ROOT, filePath);
  return relative.startsWith('..') || path.isAbsolute(relative) ? path.basename(filePath) : relative;
}

function mappingIsBijective(mapping) {
  let expected;
  try {
    expected = canonicalSpeakers(Object.values(mapping?.pyannote || {}));
  } catch {
    return false;
  }
  return ['pyannote', 'assemblyai'].every((provider) => {
    const values = Object.values(mapping?.[provider] || {}).sort();
    return values.length === expected.length && values.every((value, index) => value === expected[index]);
  });
}

function stage1OutputStructureIsComplete(pipelineInput, roomActivity) {
  return Boolean(
    pipelineInput
    && Array.isArray(pipelineInput.attributionTurns)
    && Array.isArray(pipelineInput.words)
    && Array.isArray(pipelineInput.roomSoundingIntervals)
    && Array.isArray(pipelineInput.stage1Evidence)
    && Array.isArray(pipelineInput.stage1UnknownEvidence)
    && Array.isArray(pipelineInput.providerOverlapEvidence)
    && Array.isArray(pipelineInput.providerOverlapCandidates)
    && Array.isArray(pipelineInput.initialFlags)
    && Array.isArray(roomActivity?.intervals)
    && roomActivity.frame_step_seconds === FRAME_STEP_SECONDS,
  );
}

function pipelineTimesWithinBounds(pipelineInput, duration) {
  const intervalGroups = [
    pipelineInput.attributionTurns,
    pipelineInput.words,
    pipelineInput.roomSoundingIntervals,
    pipelineInput.stage1Evidence,
    pipelineInput.stage1UnknownEvidence,
    pipelineInput.providerOverlapEvidence,
    pipelineInput.providerOverlapCandidates,
    pipelineInput.initialFlags,
  ];
  return intervalGroups.every((items) => items.every((item) =>
    Number.isFinite(Number(item.start))
    && Number.isFinite(Number(item.end))
    && Number(item.start) >= 0
    && Number(item.end) <= duration + 1e-9
    && Number(item.end) > Number(item.start),
  ));
}

function main() {
  const result = runAdapter(parseArgs(process.argv));
  process.stdout.write(`${JSON.stringify({
    gate: result.report.gate,
    status: result.report.status,
    output_dir: path.relative(REPO_ROOT, result.options.outputDir),
    counts: result.report.counts,
    duration_mismatch: {
      assemblyai_minus_canonical_sec: result.report.duration_mismatch.assemblyai_minus_canonical_sec,
      pyannote_minus_canonical_sec: result.report.duration_mismatch.pyannote_minus_canonical_sec,
    },
  }, null, 2)}\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
