#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { buildSpeakerAcousticSupport } from '../acoustic/speaker-acoustic-support.mjs';
import { refineSpeakerLocalPhraseBoundaries } from '../acoustic/speaker-local-boundary-refinement.mjs';
import { buildV23cStage1Candidate } from '../adapters/build-v23c-stage1-candidate.mjs';
import { runMultilogueV2 } from '../core/pipeline.mjs';
import { serializeTextGrid } from '../core/textgrid.mjs';
import { parseSixTierTextGridFile } from '../io/parse-six-tier-textgrid.mjs';
import { composeActivityTopologyWithSemantics } from './activity-semantic-composer.mjs';
import { applyV23cFillerPass } from './v23c-semantic-pass.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const RECORDING_ID = 'Multilogue04_C_Level30_D1G4';
const DEFAULT_STAGE1 = path.join(ROOT, 'outputs', 'multilogue-v2-poc', RECORDING_ID, 'phase-i', 'stage1-evidence.json');
const DEFAULT_MANIFEST = path.join(ROOT, 'outputs', 'multilogue-validation', RECORDING_ID, 'pyannote-remote', `${RECORDING_ID}.pyannote_remote.phase1_manifest.json`);
const DEFAULT_MAPPING = path.join(ROOT, 'outputs', 'multilogue-v2-poc', RECORDING_ID, 'phase-i', 'provider-mapping.json');
const DEFAULT_R10_CONFIG = path.join(ROOT, 'outputs', 'multilogue-v2-calibration', RECORDING_ID, 'P025', 'v2.3e-r10-evidence-contract-final-20260809', 'frozen-after-D.json');
const DEFAULT_SEMANTIC_DIR = path.join(ROOT, 'outputs', 'multilogue-v2-calibration', RECORDING_ID, 'P025', 'v2.3h-r13-selective-boundary-20260809', 'boundary-candidates', 'candidates', 'r11-52666882f2e5');

export const R16_TOPOLOGY_CONFIGS = Object.freeze([
  { mode: 'semantic_control', name: 'r13_semantic_control' },
  ...[6, 7, 7.5, 8, 9, 10].flatMap((acousticThresholdMarginDb) =>
    [0.5, 0.6, 0.7, 0.8].flatMap((acousticSupportRatio) =>
      ['agreement_only', 'bounded_margin'].map((residualIdentityPolicy) => ({
        mode: 'acoustic_topology',
        name: `margin${acousticThresholdMarginDb}_support${acousticSupportRatio}_${residualIdentityPolicy}`,
        acousticThresholdMarginDb,
        acousticSupportRatio,
        residualIdentityPolicy,
        identityMargin: 0.1,
      })))),
]);

export function generateR16TopologyCandidates({
  outputDir,
  frozenConfigFile = DEFAULT_R10_CONFIG,
  semanticTextGridFile = findTextGrid(DEFAULT_SEMANTIC_DIR),
  stage1File = DEFAULT_STAGE1,
  acousticManifestFile = DEFAULT_MANIFEST,
  mappingFile = DEFAULT_MAPPING,
  configs = R16_TOPOLOGY_CONFIGS,
  preserveSemanticActivityIntervals = [],
} = {}) {
  if (!outputDir) throw new Error('outputDir is required');
  if (existsSync(outputDir)) throw new Error(`R16 output already exists: ${outputDir}`);
  const frozen = readJson(frozenConfigFile);
  const stage1 = readJson(stage1File);
  const semantic = parseSixTierTextGridFile(semanticTextGridFile);
  const candidatesDir = path.join(outputDir, 'candidates');
  mkdirSync(candidatesDir, { recursive: true });
  const supportCache = new Map();
  const candidates = [];

  for (const topologyConfig of configs) {
    const candidateId = `r16-${hashText(stableJson(topologyConfig)).slice(0, 12)}`;
    const candidateDir = path.join(candidatesDir, candidateId);
    mkdirSync(candidateDir, { recursive: true });
    let topology = semantic;
    let topologyEvidence = { mode: 'semantic_control', runtime_gold_access: false };
    if (topologyConfig.mode === 'acoustic_topology') {
      const margin = Number(topologyConfig.acousticThresholdMarginDb);
      const minSoundingSeconds = Number(topologyConfig.minSoundingSeconds ?? 0.08);
      const supportKey = `${margin}:${minSoundingSeconds}`;
      if (!supportCache.has(supportKey)) {
        supportCache.set(supportKey, buildSpeakerAcousticSupport({
          manifestFile: acousticManifestFile,
          mappingFile,
          vadOptions: {
            thresholdMarginDb: margin, relativeThresholdDb: 55, minThresholdDb: -65,
            minSoundingSeconds,
          },
        }));
      }
      const support = supportCache.get(supportKey);
      const adapter = {
        ...frozen.adapter,
        acousticThresholdMarginDb: margin,
        acousticSupportRatio: Number(topologyConfig.acousticSupportRatio),
        residualIdentityPolicy: topologyConfig.residualIdentityPolicy,
        identityMargin: Number(topologyConfig.identityMargin),
        residualMinSeconds: Number(topologyConfig.residualMinSeconds ?? frozen.adapter.residualMinSeconds),
      };
      const built = buildV23cStage1Candidate(stage1, support, adapter);
      const boundaryRefinement = topologyConfig.boundaryRefinement
        ? refineSpeakerLocalPhraseBoundaries(built.input.stage1Evidence, support, topologyConfig.boundaryRefinement)
        : null;
      if (boundaryRefinement) {
        built.input.stage1Evidence = boundaryRefinement.events;
        built.input.initialFlags = dedupeFlags([...(built.input.initialFlags || []), ...boundaryRefinement.flags]);
      }
      built.input.thresholds = [0.25];
      built.input.sharedActivityOptions = { ...(built.input.sharedActivityOptions || {}), minSoundingSeconds: 0.5 };
      built.input.interactionConfig = topologyInteractionConfig();
      let output = runMultilogueV2(built.input).thresholds.P250;
      output = applyV23cFillerPass(output, built.input.stage1Evidence, support, {
        mode: 'exact_word', expansionCapSeconds: 0.6, acousticSupportRatio: 0.5,
      });
      topology = output.textgrid_document;
      topologyEvidence = {
        mode: 'acoustic_topology',
        adapter,
        adapter_stats: built.stats,
        speaker_acoustic_support: enumerableSupport(support),
        boundary_refinement: boundaryRefinement,
        topology_digest: output.digest,
        runtime_gold_access: false,
      };
    }
    const composed = composeActivityTopologyWithSemantics(topology, semantic, {
      preserveSemanticActivityIntervals,
    });
    const textGridFile = path.join(candidateDir, `${RECORDING_ID}.P025.${candidateId}.6tier.TextGrid`);
    const evidenceFile = path.join(candidateDir, 'runtime-evidence.json');
    const manifestFile = path.join(candidateDir, 'generator-manifest.json');
    writeFileSync(textGridFile, serializeTextGrid(composed.document), 'utf8');
    writeJson(evidenceFile, {
      contract_version: 'r16-topology-runtime-evidence-v1',
      candidate_id: candidateId,
      topology_config: topologyConfig,
      semantic_activity_preservation: {
        interval_count: preserveSemanticActivityIntervals.length,
        evidence_sha256: hashText(stableJson(preserveSemanticActivityIntervals)),
      },
      topology_evidence: topologyEvidence,
      composition: composed,
    });
    writeJson(manifestFile, {
      contract_version: 'r16-topology-generator-manifest-v1',
      candidate_id: candidateId,
      runtime_gold_access: false,
      network_used: false,
      room_mix_boundary_crossing: false,
      speaker_specific_runtime_rules: false,
      floor_source: 'frozen_r13_semantic_lane_unchanged',
      transitions_source: 'frozen_r13_semantic_lane_unchanged',
      topology_config: topologyConfig,
      inputs: {
        stage1: fileRecord(stage1File), acoustic_manifest: fileRecord(acousticManifestFile),
        speaker_mapping: fileRecord(mappingFile), frozen_r10_config: fileRecord(frozenConfigFile),
        semantic_lane_textgrid: fileRecord(semanticTextGridFile),
      },
    });
    const hashes = hashFiles([textGridFile, evidenceFile, manifestFile]);
    const aggregate = hashText(stableJson(hashes));
    writeJson(path.join(candidateDir, 'artifact-hashes.json'), {
      contract_version: 'r16-topology-candidate-hashes-v1', candidate_id: candidateId,
      files: hashes, aggregate_sha256: aggregate,
    });
    candidates.push({
      candidate_id: candidateId, candidate_dir: `candidates/${candidateId}`,
      topology_config: topologyConfig, aggregate_sha256: aggregate,
    });
  }
  const indexFile = path.join(outputDir, 'candidate-index.json');
  writeJson(indexFile, {
    contract_version: 'r16-topology-candidate-index-v1', candidate_count: candidates.length,
    expected_candidate_count: configs.length, runtime_gold_access: false, network_used: false,
    semantic_lane_sha256: fileRecord(semanticTextGridFile).sha256,
    semantic_activity_preservation: {
      interval_count: preserveSemanticActivityIntervals.length,
      evidence_sha256: hashText(stableJson(preserveSemanticActivityIntervals)),
    },
    candidates,
  });
  return { outputDir, candidateIndexFile: indexFile, candidateIndexSha256: fileRecord(indexFile).sha256, candidates };
}

function topologyInteractionConfig() {
  return {
    floorReleaseSeconds: 1, minOverlapSeconds: 0.1, overlapMode: 'path_b_exclusive',
    rebuildTransitionsFromFloor: true, strictEvidenceRoles: true, floorRulesVersion: 'R1-R5-v2.1-locked',
    preFloorBackchannelClassification: true, acousticBackchannelEnabled: false,
    acousticBackchannelMinSeconds: 0.12, acousticBackchannelMaxSeconds: 0.6,
    explicitBackchannelMaxSeconds: 0.6, holderContinuationWindowSeconds: 0.5, backchannelMaxWords: 3,
    questionResponseAcknowledgementEnabled: true, questionResponseMaxGapSeconds: 1,
    questionResponseContinuationSeconds: 2, questionResponseOverlapToleranceSeconds: 0.1,
    acousticResponseConfirmationSeconds: 3,
  };
}
function enumerableSupport(support) {
  return {
    contract_version: support.contract_version, runtime_gold_access: support.runtime_gold_access,
    network_used: support.network_used, usage_boundary: support.usage_boundary,
    vad_options: support.vad_options, by_speaker: support.by_speaker,
    provider_turns_by_speaker: support.provider_turns_by_speaker, speaker_records: support.speaker_records,
  };
}
function dedupeFlags(flags) {
  return [...new Map(flags.map((flag) => [stableJson(flag), flag])).values()];
}
function findTextGrid(dir) {
  const name = readdirSync(dir).find((item) => item.endsWith('.TextGrid'));
  if (!name) throw new Error(`TextGrid missing in ${dir}`);
  return path.join(dir, name);
}
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
  if (argv.includes('--gold')) throw new Error('R16 generator rejects Gold inputs');
  const options = {};
  for (let index = 2; index < argv.length; index += 2) {
    const key = argv[index]; const value = argv[index + 1];
    if (key === '--output-dir') options.outputDir = path.resolve(value);
    else if (key === '--semantic-textgrid') options.semanticTextGridFile = path.resolve(value);
    else throw new Error(`unknown R16 generator argument: ${key}`);
  }
  return options;
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const result = generateR16TopologyCandidates(parseArgs(process.argv));
  process.stdout.write(`${JSON.stringify({ candidate_count: result.candidates.length, candidate_index_sha256: result.candidateIndexSha256 })}\n`);
}
