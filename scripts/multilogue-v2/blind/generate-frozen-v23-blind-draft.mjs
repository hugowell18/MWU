#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { buildSpeakerAcousticSupport } from '../acoustic/speaker-acoustic-support.mjs';
import { refineSpeakerLocalPhraseBoundaries } from '../acoustic/speaker-local-boundary-refinement.mjs';
import { buildV23cStage1Candidate } from '../adapters/build-v23c-stage1-candidate.mjs';
import { SPEAKERS, round } from '../core/contracts.mjs';
import { runMultilogueV2 } from '../core/pipeline.mjs';
import { serializeTextGrid } from '../core/textgrid.mjs';
import { validateSixTierTextGrid } from '../core/validator.mjs';
import { validateTier5Consistency } from '../calibration/metrics.mjs';
import { composeActivityTopologyWithSemantics } from '../calibration/activity-semantic-composer.mjs';
import { selectOverlapCorroboratedBackchannels } from '../calibration/overlap-semantic-preservation.mjs';
import { applyV23cFillerPass } from '../calibration/v23c-semantic-pass.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const DEFAULT_FROZEN_CONFIG = path.join(
  ROOT,
  'outputs',
  'multilogue-v2-calibration',
  'Multilogue04_C_Level30_D1G4',
  'P025',
  'v2.3e-r10-evidence-contract-final-20260809',
  'frozen-after-D.json',
);

export const FROZEN_BLIND_CONFIG = Object.freeze({
  contract_version: 'multilogue-v2.3-blind-config-v2',
  pause_threshold_seconds: 0.25,
  overlap_identity: Object.freeze({
    enabled: true,
    maximumSeconds: 0.35,
    minimumCoverageRatio: 0.8,
  }),
  semantic_preservation: Object.freeze({
    policy: 'concurrent_question_or_prior',
  }),
  semantic_boundary: Object.freeze({
    enabled: false,
    onsetRadiusMs: 250,
    offsetRadiusMs: 250,
    smoothingMs: 20,
    hysteresisDb: 3,
    onsetStableRunMs: 20,
    offsetStableRunMs: 20,
    hopMs: 10,
    minimumContrastDb: 12,
    minimumDisplacementMs: 80,
    maximumDisplacementMs: 180,
    movePolicy: 'all',
  }),
  topology: Object.freeze({
    acousticThresholdMarginDb: 8.75,
    acousticSupportRatio: 0.6,
    residualIdentityPolicy: 'agreement_only',
    identityMargin: 0.1,
    minSoundingSeconds: 0.12,
    residualMinSeconds: 0.08,
  }),
  topology_boundary: Object.freeze({
    enabled: true,
    onsetRadiusMs: 250,
    offsetRadiusMs: 250,
    smoothingMs: 20,
    hysteresisDb: 3,
    onsetStableRunMs: 20,
    offsetStableRunMs: 20,
    hopMs: 10,
    minimumContrastDb: 12,
    minimumDisplacementMs: 80,
    maximumDisplacementMs: 180,
    movePolicy: 'all',
    offsetMinimumContrastDb: 10,
    offsetMinimumDisplacementMs: 50,
    offsetMaximumDisplacementMs: 150,
    offsetMovePolicy: 'outward_only',
  }),
});

export function generateFrozenBlindDraft({
  recordingId,
  stage1File,
  acousticManifestFile,
  mappingFile,
  outputDir,
  frozenConfigFile = DEFAULT_FROZEN_CONFIG,
} = {}) {
  for (const [name, value] of Object.entries({ recordingId, stage1File, acousticManifestFile, mappingFile, outputDir })) {
    if (!value) throw new Error(`${name} is required`);
  }
  if (existsSync(outputDir)) throw new Error(`blind output already exists: ${outputDir}`);
  for (const file of [stage1File, acousticManifestFile, mappingFile, frozenConfigFile]) {
    if (!existsSync(file)) throw new Error(`blind input does not exist: ${file}`);
  }

  const stage1 = readJson(stage1File);
  if (stage1.recordingId !== recordingId) {
    throw new Error(`recordingId mismatch: stage1=${stage1.recordingId} requested=${recordingId}`);
  }
  const frozen = readJson(frozenConfigFile);
  assertFrozenCalibrationConfig(frozen);
  const acousticManifest = readJson(acousticManifestFile);
  const acousticProvider = String(acousticManifest?.method?.provider || acousticManifest?.source || 'unknown');
  const evidenceMode = classifyEvidenceMode(acousticProvider);

  const semanticSupport = buildSpeakerAcousticSupport({
    manifestFile: acousticManifestFile,
    mappingFile,
    vadOptions: {
      thresholdMarginDb: frozen.adapter.acousticThresholdMarginDb,
      relativeThresholdDb: 55,
      minThresholdDb: -65,
      minSoundingSeconds: 0.08,
    },
  });
  const semanticAdapter = {
    ...frozen.adapter,
    overlapCorroboratedResidualIdentity: FROZEN_BLIND_CONFIG.overlap_identity.enabled,
    overlapCorroboratedResidualMaxSeconds: FROZEN_BLIND_CONFIG.overlap_identity.maximumSeconds,
    overlapCorroboratedMinimumCoverageRatio: FROZEN_BLIND_CONFIG.overlap_identity.minimumCoverageRatio,
  };
  const semanticBuilt = buildV23cStage1Candidate(stage1, semanticSupport, semanticAdapter);
  const semanticRefinement = FROZEN_BLIND_CONFIG.semantic_boundary.enabled
    ? refineSpeakerLocalPhraseBoundaries(
      semanticBuilt.input.stage1Evidence,
      semanticSupport,
      FROZEN_BLIND_CONFIG.semantic_boundary,
    )
    : disabledRefinement(semanticBuilt.input.stage1Evidence, FROZEN_BLIND_CONFIG.semantic_boundary);
  if (FROZEN_BLIND_CONFIG.semantic_boundary.enabled) {
    semanticBuilt.input.stage1Evidence = semanticRefinement.events;
    semanticBuilt.input.initialFlags = dedupeFlags([
      ...(semanticBuilt.input.initialFlags || []),
      ...semanticRefinement.flags,
    ]);
  }
  semanticBuilt.input.thresholds = [FROZEN_BLIND_CONFIG.pause_threshold_seconds];
  semanticBuilt.input.sharedActivityOptions = {
    ...(semanticBuilt.input.sharedActivityOptions || {}),
    minSoundingSeconds: 0.5,
  };
  semanticBuilt.input.interactionConfig = semanticInteractionConfig(frozen);
  let semanticOutput = runMultilogueV2(semanticBuilt.input).thresholds.P250;
  semanticOutput = applyV23cFillerPass(
    semanticOutput,
    semanticBuilt.input.stage1Evidence,
    semanticSupport,
    frozen.filler,
  );
  const semanticTier5 = validateTier5Consistency(semanticOutput);
  if (!semanticTier5.pass) throw new Error(`semantic Tier 5 consistency failed: ${semanticTier5.errors.join('; ')}`);
  const semanticRuntimeEvidence = {
    adapter_provenance: semanticBuilt.provenance,
    pre_floor_backchannels: semanticOutput.interaction_diagnostics?.pre_floor_backchannels || [],
    speaker_attribution_disagreements: summarizeAttributionDisagreements(semanticBuilt.input.stage1Evidence),
  };
  const preserveSemanticActivityIntervals = selectOverlapCorroboratedBackchannels(
    semanticRuntimeEvidence,
    FROZEN_BLIND_CONFIG.semantic_preservation.policy,
  );

  const topologySupport = buildSpeakerAcousticSupport({
    manifestFile: acousticManifestFile,
    mappingFile,
    vadOptions: {
      thresholdMarginDb: FROZEN_BLIND_CONFIG.topology.acousticThresholdMarginDb,
      relativeThresholdDb: 55,
      minThresholdDb: -65,
      minSoundingSeconds: FROZEN_BLIND_CONFIG.topology.minSoundingSeconds,
    },
  });
  const topologyAdapter = {
    ...frozen.adapter,
    acousticThresholdMarginDb: FROZEN_BLIND_CONFIG.topology.acousticThresholdMarginDb,
    acousticSupportRatio: FROZEN_BLIND_CONFIG.topology.acousticSupportRatio,
    residualIdentityPolicy: FROZEN_BLIND_CONFIG.topology.residualIdentityPolicy,
    identityMargin: FROZEN_BLIND_CONFIG.topology.identityMargin,
    residualMinSeconds: FROZEN_BLIND_CONFIG.topology.residualMinSeconds,
  };
  const topologyBuilt = buildV23cStage1Candidate(stage1, topologySupport, topologyAdapter);
  const topologyRefinement = refineSpeakerLocalPhraseBoundaries(
    topologyBuilt.input.stage1Evidence,
    topologySupport,
    FROZEN_BLIND_CONFIG.topology_boundary,
  );
  topologyBuilt.input.stage1Evidence = topologyRefinement.events;
  topologyBuilt.input.initialFlags = dedupeFlags([
    ...(topologyBuilt.input.initialFlags || []),
    ...topologyRefinement.flags,
  ]);
  topologyBuilt.input.thresholds = [FROZEN_BLIND_CONFIG.pause_threshold_seconds];
  topologyBuilt.input.sharedActivityOptions = {
    ...(topologyBuilt.input.sharedActivityOptions || {}),
    minSoundingSeconds: 0.5,
  };
  topologyBuilt.input.interactionConfig = topologyInteractionConfig();
  let topologyOutput = runMultilogueV2(topologyBuilt.input).thresholds.P250;
  topologyOutput = applyV23cFillerPass(
    topologyOutput,
    topologyBuilt.input.stage1Evidence,
    topologySupport,
    { mode: 'exact_word', expansionCapSeconds: 0.6, acousticSupportRatio: 0.5 },
  );

  const composed = composeActivityTopologyWithSemantics(
    topologyOutput.textgrid_document,
    semanticOutput.textgrid_document,
    { preserveSemanticActivityIntervals },
  );
  const validation = validateSixTierTextGrid(composed.document);
  if (!validation.valid) throw new Error(`blind TextGrid validation failed: ${validation.errors.join('; ')}`);
  const textgrid = serializeTextGrid(composed.document);
  const summary = summarizeDocument(composed.document);
  const status = evidenceMode === 'dual_provider_blind'
    ? 'blind_draft_awaiting_researcher_correction'
    : 'degraded_smoke_test_not_for_researcher_scoring';

  mkdirSync(outputDir, { recursive: true });
  const textGridFile = path.join(outputDir, `${recordingId}.P025.v2.3-blind-draft.6tier.TextGrid`);
  const evidenceFile = path.join(outputDir, 'runtime-evidence.json');
  const manifestFile = path.join(outputDir, 'method-manifest.json');
  const validationFile = path.join(outputDir, 'validation-summary.json');
  writeFileSync(textGridFile, textgrid, 'utf8');
  writeJson(evidenceFile, {
    contract_version: 'multilogue-v2.3-blind-runtime-evidence-v2',
    status,
    evidence_mode: evidenceMode,
    acoustic_provider: acousticProvider,
    accuracy_claim: false,
    gold_accessed_during_generation: false,
    semantic_lane: {
      adapter_config: semanticAdapter,
      adapter_stats: semanticBuilt.stats,
      adapter_provenance: semanticBuilt.provenance,
      boundary_refinement: refinementSummary(semanticRefinement),
      interaction_diagnostics: semanticOutput.interaction_diagnostics,
      tier5_internal_consistency: semanticTier5,
    },
    topology_lane: {
      adapter_stats: topologyBuilt.stats,
      boundary_refinement: refinementSummary(topologyRefinement),
      interaction_diagnostics: topologyOutput.interaction_diagnostics,
    },
    composition: {
      contract_version: composed.contract_version,
      floor_source: composed.floor_source,
      transitions_source: composed.transitions_source,
      stats: composed.stats,
      semantic_activity_preservation_policy: FROZEN_BLIND_CONFIG.semantic_preservation.policy,
      preserved_semantic_activity_intervals: preserveSemanticActivityIntervals,
      mismatch_intervals: composed.mismatches,
    },
  });
  writeJson(manifestFile, {
    contract_version: 'multilogue-v2.3-blind-method-manifest-v2',
    recording_id: recordingId,
    status,
    evidence_mode: evidenceMode,
    acoustic_provider: acousticProvider,
    runtime_gold_access: false,
    network_used_during_draft_generation: false,
    provider_artifacts_are_cached_remote_evidence: true,
    room_mix_boundary_crossing: false,
    source_separation_claim: false,
    methodology: {
      rule_set: 'R1-R5-v2.1-locked',
      path: 'B',
      six_tier_schema: ['S1', 'S2', 'S3', 'floor', 'transitions', 'flags'],
      nine_labels: ['s', 'f', 'bc', 'ol', 'op', 'pf', 'tr', 'shs', 'x'],
      frozen_blind_config: FROZEN_BLIND_CONFIG,
      floor_source: 'semantic_lane_unchanged',
      transition_source: 'semantic_lane_unchanged',
      activity_topology_source: 'speaker_conditioned_acoustic_lane',
      overlap_corroborated_residual_role: 'reviewable_bc_activity_only_never_floor_boundary',
      semantic_activity_preservation_policy: FROZEN_BLIND_CONFIG.semantic_preservation.policy,
    },
    inputs: {
      stage1: fileRecord(stage1File),
      acoustic_manifest: fileRecord(acousticManifestFile),
      speaker_mapping: fileRecord(mappingFile),
      calibration_config: fileRecord(frozenConfigFile),
    },
  });
  writeJson(validationFile, {
    contract_version: 'multilogue-v2.3-blind-validation-summary-v1',
    status,
    evidence_mode: evidenceMode,
    schema_and_timeline: validation,
    tier5_internal_consistency: semanticTier5,
    descriptive_summary: summary,
    reportable_without_researcher_gold: true,
    accuracy_metrics_available: false,
    blocked_accuracy_metrics: [
      'speaker-label precision/recall/F1',
      'active-boundary precision/recall/F1',
      'floor accuracy',
      'transition false-positive and false-negative counts',
      'nine-label macro F1',
    ],
  });
  const hashes = hashFiles([textGridFile, evidenceFile, manifestFile, validationFile]);
  const hashesFile = path.join(outputDir, 'artifact-hashes.json');
  writeJson(hashesFile, {
    contract_version: 'multilogue-v2.3-blind-artifact-hashes-v1',
    files: hashes,
    aggregate_sha256: hashText(stableJson(hashes)),
  });

  return {
    status,
    evidenceMode,
    outputDir,
    textGridFile,
    validation,
    tier5Consistency: semanticTier5,
    summary,
    artifactHashesFile: hashesFile,
  };
}

export function classifyEvidenceMode(acousticProvider) {
  return /pyannote/i.test(String(acousticProvider || ''))
    ? 'dual_provider_blind'
    : 'single_provider_degraded_smoke_test';
}

function semanticInteractionConfig(frozen) {
  return {
    floorReleaseSeconds: 1,
    minOverlapSeconds: 0.1,
    overlapMode: 'path_b_exclusive',
    rebuildTransitionsFromFloor: true,
    strictEvidenceRoles: true,
    floorRulesVersion: 'R1-R5-v2.1-locked',
    preFloorBackchannelClassification: true,
    acousticBackchannelEnabled: frozen.backchannel.mode === 'explicit_plus_acoustic',
    acousticBackchannelMinSeconds: 0.12,
    acousticBackchannelMaxSeconds: frozen.backchannel.maxDurationSeconds,
    acousticResponseMaxSeconds: 1,
    explicitBackchannelMaxSeconds: frozen.backchannel.maxDurationSeconds,
    holderContinuationWindowSeconds: frozen.backchannel.continuationSeconds,
    backchannelMaxWords: 3,
    questionResponseAcknowledgementEnabled: true,
    questionResponseMaxGapSeconds: 1,
    questionResponseContinuationSeconds: 2,
    questionResponseOverlapToleranceSeconds: 0.1,
    acousticResponseConfirmationSeconds: 3,
  };
}

function topologyInteractionConfig() {
  return {
    floorReleaseSeconds: 1,
    minOverlapSeconds: 0.1,
    overlapMode: 'path_b_exclusive',
    rebuildTransitionsFromFloor: true,
    strictEvidenceRoles: true,
    floorRulesVersion: 'R1-R5-v2.1-locked',
    preFloorBackchannelClassification: true,
    acousticBackchannelEnabled: false,
    acousticBackchannelMinSeconds: 0.12,
    acousticBackchannelMaxSeconds: 0.6,
    explicitBackchannelMaxSeconds: 0.6,
    holderContinuationWindowSeconds: 0.5,
    backchannelMaxWords: 3,
    questionResponseAcknowledgementEnabled: true,
    questionResponseMaxGapSeconds: 1,
    questionResponseContinuationSeconds: 2,
    questionResponseOverlapToleranceSeconds: 0.1,
    acousticResponseConfirmationSeconds: 3,
  };
}

function assertFrozenCalibrationConfig(config) {
  if (Number(config.adapter?.acousticThresholdMarginDb) !== 5) throw new Error('blind runner requires frozen R10 margin 5');
  if (config.adapter?.residualIdentityPolicy !== 'bounded_margin') throw new Error('blind runner requires frozen R10 identity policy');
  if (config.backchannel?.mode !== 'explicit_plus_acoustic') throw new Error('blind runner requires frozen R10 backchannel mode');
}

function summarizeAttributionDisagreements(events) {
  return events.filter((event) => event.speaker_fusion?.disagreement === true).map((event) => ({
    event_id: event.id,
    start: event.start,
    end: event.end,
    selected_speaker: event.speaker,
    assembly_speaker: event.speaker_fusion.assembly_speaker,
    pyannote_speaker: event.speaker_fusion.pyannote_speaker,
    decision: event.speaker_fusion.decision,
    assembly_mean_confidence: event.speaker_fusion.assembly_mean_confidence,
    provider_score_margin: event.speaker_fusion.provider_score_margin,
    short_explicit_question: event.short_explicit_question === true,
    hard_response_boundary: event.hard_response_boundary,
  }));
}

function refinementSummary(value) {
  return {
    contract_version: value.contract_version,
    config: value.config,
    stats: value.stats,
    evidence: value.evidence,
  };
}

function disabledRefinement(events, config) {
  return {
    contract_version: 'speaker-local-boundary-refinement-disabled-v1',
    config,
    events,
    flags: [],
    stats: { enabled: false, event_count: events.length, moved_boundary_count: 0 },
    evidence: [],
  };
}

function summarizeDocument(document) {
  const labels = ['s', 'f', 'bc', 'ol', 'op', 'pf', 'tr', 'shs', 'x'];
  const bySpeaker = Object.fromEntries(SPEAKERS.map((speaker) => {
    const tier = document.tiers.find((item) => item.name === speaker);
    const durations = Object.fromEntries(labels.map((label) => [label, 0]));
    for (const interval of tier.intervals) durations[interval.text] += interval.end - interval.start;
    return [speaker, {
      interval_count: tier.intervals.length,
      duration_seconds_by_label: Object.fromEntries(labels.map((label) => [label, round(durations[label], 6)])),
    }];
  }));
  const floor = document.tiers.find((item) => item.name === 'floor');
  const transitions = document.tiers.find((item) => item.name === 'transitions');
  const flags = document.tiers.find((item) => item.name === 'flags');
  return {
    duration_seconds: round(document.xmax, 6),
    by_speaker: bySpeaker,
    floor_interval_count: floor.intervals.length,
    transition_point_count: transitions.points.length,
    nonempty_flag_interval_count: flags.intervals.filter((item) => item.text).length,
  };
}

function dedupeFlags(flags) {
  return [...new Map(flags.map((flag) => [stableJson(flag), flag])).values()];
}

function hashFiles(files) {
  return Object.fromEntries(files.map((file) => [path.basename(file), fileRecord(file)]));
}

function fileRecord(file) {
  const bytes = readFileSync(file);
  return {
    name: path.basename(file),
    sha256: createHash('sha256').update(bytes).digest('hex'),
    bytes: bytes.length,
  };
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

function writeJson(file, value) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function parseArgs(argv) {
  if (argv.includes('--gold')) throw new Error('blind generator rejects Gold inputs');
  const options = {};
  const fields = new Map([
    ['--recording-id', 'recordingId'],
    ['--stage1', 'stage1File'],
    ['--acoustic-manifest', 'acousticManifestFile'],
    ['--mapping', 'mappingFile'],
    ['--frozen-config', 'frozenConfigFile'],
    ['--output-dir', 'outputDir'],
  ]);
  for (let index = 2; index < argv.length; index += 1) {
    const field = fields.get(argv[index]);
    if (!field || !argv[index + 1]) throw new Error(`unknown or incomplete blind argument: ${argv[index]}`);
    options[field] = field === 'recordingId' ? argv[index + 1] : path.resolve(argv[index + 1]);
    index += 1;
  }
  return options;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const result = generateFrozenBlindDraft(parseArgs(process.argv));
    process.stdout.write(`${JSON.stringify({
      status: result.status,
      output_dir: result.outputDir,
      textgrid: result.textGridFile,
      transition_point_count: result.summary.transition_point_count,
      schema_valid: result.validation.valid,
      tier5_consistent: result.tier5Consistency.pass,
    }, null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
