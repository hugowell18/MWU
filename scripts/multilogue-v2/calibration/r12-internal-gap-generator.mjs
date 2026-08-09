#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { buildSpeakerAcousticSupport } from '../acoustic/speaker-acoustic-support.mjs';
import { splitSpeakerLocalInternalGaps } from '../acoustic/speaker-local-internal-gap-refinement.mjs';
import { buildV23cStage1Candidate } from '../adapters/build-v23c-stage1-candidate.mjs';
import { runMultilogueV2 } from '../core/pipeline.mjs';
import { validateTier5Consistency } from './metrics.mjs';
import { applyV23cFillerPass } from './v23c-semantic-pass.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const RECORDING_ID = 'Multilogue04_C_Level30_D1G4';
const DEFAULT_STAGE1 = path.join(ROOT, 'outputs', 'multilogue-v2-poc', RECORDING_ID, 'phase-i', 'stage1-evidence.json');
const DEFAULT_MANIFEST = path.join(ROOT, 'outputs', 'multilogue-validation', RECORDING_ID, 'pyannote-remote', `${RECORDING_ID}.pyannote_remote.phase1_manifest.json`);
const DEFAULT_MAPPING = path.join(ROOT, 'outputs', 'multilogue-v2-poc', RECORDING_ID, 'phase-i', 'provider-mapping.json');
const DEFAULT_R10_CONFIG = path.join(
  ROOT, 'outputs', 'multilogue-v2-calibration', RECORDING_ID, 'P025',
  'v2.3e-r10-evidence-contract-final-20260809', 'frozen-after-D.json',
);

export const R12_INTERNAL_GAP_CONFIGS = Object.freeze([
  { enabled: false, name: 'r10_control' },
  ...[0.03, 0.05, 0.08, 0.1, 0.12, 0.15, 0.2, 0.25].map((minimumGapSeconds) => ({
    enabled: true,
    name: `internal_gap_${String(Math.round(minimumGapSeconds * 1000)).padStart(3, '0')}ms`,
    minimumGapSeconds,
    maximumGapSeconds: 0.35,
    minimumFlankingSoundingSeconds: 0.05,
  })),
]);

export function generateR12InternalGapCandidates({
  outputDir,
  frozenConfigFile = DEFAULT_R10_CONFIG,
  stage1File = DEFAULT_STAGE1,
  acousticManifestFile = DEFAULT_MANIFEST,
  mappingFile = DEFAULT_MAPPING,
  configs = R12_INTERNAL_GAP_CONFIGS,
} = {}) {
  if (!outputDir) throw new Error('outputDir is required');
  if (existsSync(outputDir)) throw new Error(`R12 generator output already exists: ${outputDir}`);
  if (!Array.isArray(configs) || configs.length < 2) throw new Error('R12 requires control and internal-gap candidates');
  const frozenConfig = readJson(frozenConfigFile);
  assertR10Config(frozenConfig);
  const stage1 = readJson(stage1File);
  const support = buildSpeakerAcousticSupport({
    manifestFile: acousticManifestFile,
    mappingFile,
    vadOptions: { thresholdMarginDb: frozenConfig.adapter.acousticThresholdMarginDb, relativeThresholdDb: 55, minThresholdDb: -65 },
  });
  const candidatesDir = path.join(outputDir, 'candidates');
  mkdirSync(candidatesDir, { recursive: true });
  const index = [];

  for (const gapConfig of configs) {
    const candidateId = `r12-${hashText(stableJson(gapConfig)).slice(0, 12)}`;
    const candidateDir = path.join(candidatesDir, candidateId);
    mkdirSync(candidateDir, { recursive: true });
    const built = buildV23cStage1Candidate(stage1, support, frozenConfig.adapter);
    const semanticDigestBefore = semanticDigest(built.input.stage1Evidence);
    const refinement = splitSpeakerLocalInternalGaps(built.input.stage1Evidence, support, gapConfig);
    const semanticDigestAfter = semanticDigest(refinement.events);
    if (semanticDigestAfter !== semanticDigestBefore) throw new Error('internal-gap refinement changed semantic identity');
    built.input.stage1Evidence = refinement.events;
    built.input.initialFlags = dedupeFlags([...(built.input.initialFlags || []), ...refinement.flags]);
    built.input.thresholds = [0.25];
    built.input.sharedActivityOptions = { ...(built.input.sharedActivityOptions || {}), minSoundingSeconds: 0.5 };
    built.input.interactionConfig = {
      ...(built.input.interactionConfig || {}),
      floorReleaseSeconds: 1,
      minOverlapSeconds: 0.1,
      overlapMode: 'path_b_exclusive',
      rebuildTransitionsFromFloor: true,
      strictEvidenceRoles: true,
      floorRulesVersion: 'R1-R5-v2.1-locked',
      preFloorBackchannelClassification: true,
      acousticBackchannelEnabled: frozenConfig.backchannel.mode === 'explicit_plus_acoustic',
      acousticBackchannelMinSeconds: 0.12,
      acousticBackchannelMaxSeconds: frozenConfig.backchannel.maxDurationSeconds,
      acousticResponseMaxSeconds: 1,
      explicitBackchannelMaxSeconds: frozenConfig.backchannel.maxDurationSeconds,
      holderContinuationWindowSeconds: frozenConfig.backchannel.continuationSeconds,
      backchannelMaxWords: 3,
      questionResponseAcknowledgementEnabled: true,
      questionResponseMaxGapSeconds: 1,
      questionResponseContinuationSeconds: 2,
      questionResponseOverlapToleranceSeconds: 0.1,
      acousticResponseConfirmationSeconds: 3,
    };
    let output = runMultilogueV2(built.input).thresholds.P250;
    output = applyV23cFillerPass(output, built.input.stage1Evidence, support, frozenConfig.filler);
    const tier5 = validateTier5Consistency(output);
    if (!tier5.pass) throw new Error(`R12 Tier5 consistency failed: ${tier5.errors.join('; ')}`);

    const textGridFile = path.join(candidateDir, `${RECORDING_ID}.P025.${candidateId}.6tier.TextGrid`);
    const evidenceFile = path.join(candidateDir, 'runtime-evidence.json');
    const manifestFile = path.join(candidateDir, 'generator-manifest.json');
    writeFileSync(textGridFile, output.textgrid, 'utf8');
    writeJson(evidenceFile, {
      contract_version: 'r12-internal-gap-runtime-evidence-v1',
      candidate_id: candidateId,
      internal_gap_config: gapConfig,
      internal_gap_refinement: refinement,
      pre_floor_backchannels: output.interaction_diagnostics?.pre_floor_backchannels || [],
      pre_floor_response_acknowledgements: output.interaction_diagnostics?.pre_floor_response_acknowledgements || [],
      acoustic_response_boundary_candidates: output.interaction_diagnostics?.acoustic_response_boundary_candidates || [],
      acoustic_response_boundary_confirmations: output.interaction_diagnostics?.acoustic_response_boundary_confirmations || [],
      terminal_administrative_cues: output.interaction_diagnostics?.terminal_administrative_cues || [],
      semantic_digest_before: semanticDigestBefore,
      semantic_digest_after: semanticDigestAfter,
      tier5_internal_consistency: tier5,
    });
    writeJson(manifestFile, {
      contract_version: 'r12-internal-gap-generator-manifest-v1',
      candidate_id: candidateId,
      runtime_gold_access: false,
      network_used: false,
      room_mix_boundary_crossing: false,
      outer_boundaries_moved: false,
      provider_turn_clipping_required: true,
      frozen_r10_semantic_config: frozenConfig,
      internal_gap_config: gapConfig,
      semantic_digest: semanticDigestAfter,
      inputs: {
        stage1: fileRecord(stage1File), acoustic_manifest: fileRecord(acousticManifestFile),
        speaker_mapping: fileRecord(mappingFile), frozen_r10_config: fileRecord(frozenConfigFile),
      },
      output_digest: output.digest,
      tier5_internal_consistency: tier5,
    });
    const hashes = hashFiles([textGridFile, evidenceFile, manifestFile]);
    const aggregate = hashText(stableJson(hashes));
    writeJson(path.join(candidateDir, 'artifact-hashes.json'), {
      contract_version: 'r12-internal-gap-candidate-hashes-v1', candidate_id: candidateId,
      files: hashes, aggregate_sha256: aggregate,
    });
    index.push({
      candidate_id: candidateId,
      candidate_dir: `candidates/${candidateId}`,
      internal_gap_config: gapConfig,
      aggregate_sha256: aggregate,
    });
  }
  const indexFile = path.join(outputDir, 'candidate-index.json');
  writeJson(indexFile, {
    contract_version: 'r12-internal-gap-candidate-index-v1', candidate_count: index.length,
    expected_candidate_count: configs.length, runtime_gold_access: false, network_used: false,
    frozen_r10_semantic_config_sha256: fileRecord(frozenConfigFile).sha256, candidates: index,
  });
  return { outputDir, candidateIndexFile: indexFile, candidateIndexSha256: fileRecord(indexFile).sha256, candidates: index };
}

function assertR10Config(config) {
  if (Number(config.adapter?.acousticThresholdMarginDb) !== 5) throw new Error('R12 requires frozen R10 margin 5');
  if (config.adapter?.residualIdentityPolicy !== 'bounded_margin') throw new Error('R12 requires frozen R10 identity policy');
  if (config.backchannel?.mode !== 'explicit_plus_acoustic') throw new Error('R12 requires frozen R10 backchannel mode');
}
function semanticDigest(events) {
  return hashText(stableJson(events.map((event) => ({
    id: event.id, speaker: event.speaker, tokens: event.tokens || [], source_word_ids: event.source_word_ids || [],
    semantic_evidence: event.semantic_evidence, semantic_class: event.semantic_class,
    provisional_kind: event.provisional_kind, floor_eligible: event.floor_eligible,
  }))));
}
function dedupeFlags(flags) { return [...new Map(flags.map((flag) => [stableJson(flag), flag])).values()]; }
function hashFiles(files) { return Object.fromEntries(files.map((file) => [path.basename(file), fileRecord(file)])); }
function fileRecord(file) { const bytes = readFileSync(file); return { name: path.basename(file), sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length }; }
function hashText(value) { return createHash('sha256').update(value).digest('hex'); }
function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}
function readJson(file) { return JSON.parse(readFileSync(file, 'utf8')); }
function writeJson(file, value) { mkdirSync(path.dirname(file), { recursive: true }); writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8'); }
function parseArgs(argv) {
  if (argv.includes('--gold')) throw new Error('R12 generator rejects Gold inputs');
  const options = {};
  for (let index = 2; index < argv.length; index += 2) {
    const key = argv[index]; const value = argv[index + 1];
    if (key === '--output-dir') options.outputDir = path.resolve(value);
    else if (key === '--frozen-config') options.frozenConfigFile = path.resolve(value);
    else throw new Error(`unknown R12 generator argument: ${key}`);
  }
  return options;
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const result = generateR12InternalGapCandidates(parseArgs(process.argv));
  process.stdout.write(`${JSON.stringify({ candidate_count: result.candidates.length, candidate_index_sha256: result.candidateIndexSha256 })}\n`);
}
