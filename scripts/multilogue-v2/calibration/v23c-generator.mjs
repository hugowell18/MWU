#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { buildSpeakerAcousticSupport } from '../acoustic/speaker-acoustic-support.mjs';
import { buildV23cStage1Candidate, V23C_RULE_SET_VERSION } from '../adapters/build-v23c-stage1-candidate.mjs';
import { runMultilogueV2 } from '../core/pipeline.mjs';
import { validateTier5Consistency } from './metrics.mjs';
import { structuralDigests } from './frozen-semantic-pass.mjs';
import { applyV23cFillerPass } from './v23c-semantic-pass.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const RECORDING_ID = 'Multilogue04_C_Level30_D1G4';
const DEFAULT_STAGE1 = path.join(ROOT, 'outputs', 'multilogue-v2-poc', RECORDING_ID, 'phase-i', 'stage1-evidence.json');
const DEFAULT_MANIFEST = path.join(ROOT, 'outputs', 'multilogue-validation', RECORDING_ID, 'pyannote-remote', `${RECORDING_ID}.pyannote_remote.phase1_manifest.json`);
const DEFAULT_MAPPING = path.join(ROOT, 'outputs', 'multilogue-v2-poc', RECORDING_ID, 'phase-i', 'provider-mapping.json');

export const V23C_FIXED = Object.freeze({
  pause_threshold_seconds: 0.25,
  floor_release_seconds: 1,
  minimum_overlap_seconds: 0.1,
  overlap_mode: 'path_b_exclusive',
  rule_set_version: V23C_RULE_SET_VERSION,
  six_tier_schema: ['S1', 'S2', 'S3', 'floor', 'transitions', 'flags'],
  nine_labels: ['s', 'f', 'bc', 'ol', 'op', 'pf', 'tr', 'shs', 'x'],
});

export const V23C_METRIC_OWNERSHIP = Object.freeze({
  A: ['active_set_exact_accuracy', 'room_activity_f1', 'boundary_f1_100ms'],
  B: ['bc_f1', 'transition_precision', 'floor_accuracy'],
  C: ['floor_accuracy', 'transition_matched', 'tier5_handoff_matched_100ms'],
  D: ['f_f1', 'macro_f1_observed_labels'],
});

export function generateV23cStage({
  stage,
  outputDir,
  frozenConfig = null,
  stage1File = DEFAULT_STAGE1,
  acousticManifestFile = DEFAULT_MANIFEST,
  mappingFile = DEFAULT_MAPPING,
}) {
  if (!Object.hasOwn(V23C_METRIC_OWNERSHIP, stage)) throw new Error('stage must be A, B, C or D');
  if (!outputDir) throw new Error('outputDir is required');
  if (existsSync(outputDir)) throw new Error(`generator output already exists: ${outputDir}`);
  const stage1 = readJson(stage1File);
  assertFixed(stage1);
  const configs = stageConfigs(stage, frozenConfig);
  const candidatesDir = path.join(outputDir, 'candidates');
  mkdirSync(candidatesDir, { recursive: true });
  const index = [];
  const supportCache = new Map();

  for (const config of configs) {
    const supportKey = Number(config.adapter.acousticThresholdMarginDb).toFixed(3);
    if (!supportCache.has(supportKey)) {
      supportCache.set(supportKey, buildSpeakerAcousticSupport({
        manifestFile: acousticManifestFile,
        mappingFile,
        vadOptions: {
          thresholdMarginDb: config.adapter.acousticThresholdMarginDb,
          relativeThresholdDb: 55,
          minThresholdDb: -65,
        },
      }));
    }
    const support = supportCache.get(supportKey);
    if (Number(support.vad_options.thresholdMarginDb) !== Number(config.adapter.acousticThresholdMarginDb)) {
      throw new Error('speaker acoustic threshold margin drifted from candidate config');
    }
    const candidateId = `v23c-${stage.toLowerCase()}-${hashText(stableJson(config)).slice(0, 12)}`;
    const candidateDir = path.join(candidatesDir, candidateId);
    mkdirSync(candidateDir, { recursive: true });
    const built = buildV23cStage1Candidate(stage1, support, config.adapter);
    built.input.thresholds = [V23C_FIXED.pause_threshold_seconds];
    built.input.sharedActivityOptions = {
      ...(built.input.sharedActivityOptions || {}),
      minSoundingSeconds: 0.5,
    };
    built.input.interactionConfig = {
      ...(built.input.interactionConfig || {}),
      floorReleaseSeconds: V23C_FIXED.floor_release_seconds,
      minOverlapSeconds: V23C_FIXED.minimum_overlap_seconds,
      overlapMode: V23C_FIXED.overlap_mode,
      rebuildTransitionsFromFloor: true,
      strictEvidenceRoles: true,
      floorRulesVersion: V23C_FIXED.rule_set_version,
      preFloorBackchannelClassification: true,
      acousticBackchannelEnabled: config.backchannel.mode === 'explicit_plus_acoustic',
      acousticBackchannelMinSeconds: 0.12,
      acousticBackchannelMaxSeconds: config.backchannel.maxDurationSeconds,
      acousticResponseMaxSeconds: 1,
      explicitBackchannelMaxSeconds: config.backchannel.maxDurationSeconds,
      holderContinuationWindowSeconds: config.backchannel.continuationSeconds,
      backchannelMaxWords: 3,
      questionResponseAcknowledgementEnabled: true,
      questionResponseMaxGapSeconds: 1,
      questionResponseContinuationSeconds: 2,
      questionResponseOverlapToleranceSeconds: 0.1,
      acousticResponseConfirmationSeconds: 3,
    };
    let output = runMultilogueV2(built.input).thresholds.P250;
    const preFiller = structuralDigests(output.textgrid_document);
    if (stage === 'D') output = applyV23cFillerPass(output, built.input.stage1Evidence, support, config.filler);
    const postFiller = structuralDigests(output.textgrid_document);
    assertFrozen(preFiller, postFiller);
    const tier5 = validateTier5Consistency(output);
    if (!tier5.pass) throw new Error(`Tier5 consistency failed: ${tier5.errors.join('; ')}`);

    const textGridFile = path.join(candidateDir, `${RECORDING_ID}.P025.${candidateId}.6tier.TextGrid`);
    const evidenceFile = path.join(candidateDir, 'runtime-evidence.json');
    const manifestFile = path.join(candidateDir, 'generator-manifest.json');
    writeFileSync(textGridFile, output.textgrid, 'utf8');
    writeJson(evidenceFile, {
      contract_version: 'v23c-runtime-evidence-v2',
      candidate_id: candidateId,
      stage,
      config,
      adapter_stats: built.stats,
      adapter_provenance: built.provenance,
      speaker_acoustic_support: support,
      pre_floor_backchannels: output.interaction_diagnostics?.pre_floor_backchannels || [],
      pre_floor_response_acknowledgements: output.interaction_diagnostics?.pre_floor_response_acknowledgements || [],
      acoustic_response_boundary_candidates:
        output.interaction_diagnostics?.acoustic_response_boundary_candidates || [],
      acoustic_response_boundary_confirmations:
        output.interaction_diagnostics?.acoustic_response_boundary_confirmations || [],
      terminal_administrative_cues: output.interaction_diagnostics?.terminal_administrative_cues || [],
      speaker_attribution_disagreements: summarizeAttributionDisagreements(built.input.stage1Evidence),
      filler_pass: output.v23c_filler_pass || null,
      structural_digests: postFiller,
      tier5_internal_consistency: tier5,
    });
    writeJson(manifestFile, {
      contract_version: 'v23c-generator-manifest-v1',
      candidate_id: candidateId,
      stage,
      metric_ownership: V23C_METRIC_OWNERSHIP[stage],
      runtime_gold_access: false,
      network_used: false,
      room_mix_boundary_crossing: false,
      production_defaults_changed: false,
      fixed_research_contract: V23C_FIXED,
      config,
      inputs: {
        stage1: fileRecord(stage1File),
        acoustic_manifest: fileRecord(acousticManifestFile),
        speaker_mapping: fileRecord(mappingFile),
      },
      output_digest: output.digest,
      structural_digests: postFiller,
      tier5_internal_consistency: tier5,
    });
    const hashes = hashFiles([textGridFile, evidenceFile, manifestFile]);
    const aggregate = hashText(stableJson(hashes));
    writeJson(path.join(candidateDir, 'artifact-hashes.json'), {
      contract_version: 'v23c-candidate-hashes-v1',
      candidate_id: candidateId,
      files: hashes,
      aggregate_sha256: aggregate,
    });
    index.push({
      candidate_id: candidateId,
      candidate_dir: `candidates/${candidateId}`,
      config,
      aggregate_sha256: aggregate,
    });
  }
  const indexFile = path.join(outputDir, 'candidate-index.json');
  writeJson(indexFile, {
    contract_version: 'v23c-generator-index-v1',
    stage,
    candidate_count: index.length,
    expected_candidate_count: 8,
    metric_ownership: V23C_METRIC_OWNERSHIP[stage],
    runtime_gold_access: false,
    candidates: index,
  });
  return {
    stage,
    outputDir,
    candidates: index,
    candidateIndexFile: indexFile,
    candidateIndexSha256: fileRecord(indexFile).sha256,
  };
}

export function stageConfigs(stage, frozenConfig = null) {
  const base = frozenConfig ? structuredClone(frozenConfig) : baseConfig();
  const configs = [];
  if (stage === 'A') {
    for (const marginDb of [5, 7.5]) for (const support of [0.5, 0.7]) {
      for (const identity of ['agreement_only', 'bounded_margin']) {
        const config = baseConfig();
        Object.assign(config.adapter, {
          acousticThresholdMarginDb: marginDb,
          acousticSupportRatio: support,
          residualIdentityPolicy: identity,
          acousticBridgeSeconds: 0,
        });
        configs.push(config);
      }
    }
  } else if (stage === 'B') {
    for (const mode of ['explicit_only', 'explicit_plus_acoustic']) for (const maximum of [0.6, 1]) {
      for (const continuation of [0.5, 1]) {
        const config = structuredClone(base);
        config.backchannel = { mode, maxDurationSeconds: maximum, continuationSeconds: continuation };
        configs.push(config);
      }
    }
  } else if (stage === 'C') {
    for (const gap of [0.25, 0.35]) for (const confidence of [0.7, 0.8]) {
      for (const margin of [0.1, 0.2]) {
        const config = structuredClone(base);
        Object.assign(config.adapter, {
          phraseGapSeconds: gap,
          shortQuestionMinAssemblyConfidence: confidence,
          shortQuestionProviderScoreMargin: margin,
        });
        configs.push(config);
      }
    }
  } else {
    for (const mode of ['exact_word', 'acoustic_cell']) for (const cap of [0.6, 1]) {
      for (const support of [0.5, 0.7]) {
        const config = structuredClone(base);
        config.filler = { mode, expansionCapSeconds: cap, acousticSupportRatio: support };
        configs.push(config);
      }
    }
  }
  if (configs.length !== 8) throw new Error(`stage ${stage} grid count drifted`);
  return configs;
}

export function baseConfig() {
  return {
    adapter: {
      phraseGapSeconds: 0.35,
      phraseMaxSeconds: 1.5,
      parentResponseGapSeconds: 0.5,
      parentResponseMaxSeconds: 8,
      activityBridgeSeconds: 0,
      shortTurnAssemblyOverride: true,
      shortTurnMaxWords: 12,
      shortTurnMaxSeconds: 3.2,
      shortTurnMinAssemblyConfidence: 0.7,
      providerScoreMargin: 0.1,
      shortQuestionMinAssemblyConfidence: 0.7,
      shortQuestionProviderScoreMargin: 0.1,
      hardQuestionSpeakerChangeOverride: true,
      hardQuestionAssemblySafetyFloor: 0.75,
      lexicalBackchannelAssemblyOverride: false,
      semanticProjectorScoreBonus: 0.15,
      residualMinSeconds: 0.08,
      residualNonlexicalMaxSeconds: 0.25,
      promoteLongResidual: true,
      rebuildTransitionsFromFloor: true,
      acousticSupportRatio: 0.5,
      acousticThresholdMarginDb: 10,
      residualIdentityPolicy: 'agreement_only',
      identityMargin: 0.1,
      acousticBridgeSeconds: 0,
    },
    backchannel: { mode: 'explicit_only', maxDurationSeconds: 0.6, continuationSeconds: 0.5 },
    filler: { mode: 'exact_word', expansionCapSeconds: 0.6, acousticSupportRatio: 0.5 },
  };
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

function assertFixed(stage1) {
  if (Number(stage1.interactionConfig?.floorReleaseSeconds) !== 1) throw new Error('L must remain 1.0');
  if (Number(stage1.interactionConfig?.minOverlapSeconds) !== 0.1) throw new Error('minimum overlap must remain 0.1');
  if (stage1.interactionConfig?.overlapMode !== 'path_b_exclusive') throw new Error('Path B must remain fixed');
}

function assertFrozen(before, after) {
  for (const key of ['active', 'floor', 'transitions']) {
    if (before[key] !== after[key]) throw new Error(`semantic stage changed frozen ${key}`);
  }
}

function hashFiles(files) {
  return Object.fromEntries(files.map((file) => [path.basename(file), fileRecord(file)]));
}

function fileRecord(file) {
  const bytes = readFileSync(file);
  return { name: path.basename(file), sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length };
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
  if (argv.includes('--gold')) throw new Error('generator rejects Gold inputs');
  const options = {};
  for (let index = 2; index < argv.length; index += 1) {
    const key = argv[index];
    const value = argv[index + 1];
    if (key === '--stage') options.stage = value;
    else if (key === '--output-dir') options.outputDir = path.resolve(value);
    else if (key === '--frozen-config') options.frozenConfig = readJson(path.resolve(value));
    else if (key === '--stage1') options.stage1File = path.resolve(value);
    else if (key === '--acoustic-manifest') options.acousticManifestFile = path.resolve(value);
    else if (key === '--mapping') options.mappingFile = path.resolve(value);
    else throw new Error(`unknown generator argument: ${key}`);
    index += 1;
  }
  return options;
}

function main() {
  const result = generateV23cStage(parseArgs(process.argv));
  process.stdout.write(`${JSON.stringify({
    stage: result.stage,
    candidate_count: result.candidates.length,
    output_dir: result.outputDir,
    candidate_index_sha256: result.candidateIndexSha256,
  })}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) main();
