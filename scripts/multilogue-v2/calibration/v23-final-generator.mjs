#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  computeLocalAcousticVadFromPrepared,
  defaultVadOptions,
  prepareLocalAcousticVad,
} from '../../local-acoustic-vad.mjs';
import { buildV23Stage1Candidate, V23_RULE_SET_VERSION } from '../adapters/build-v23-stage1-candidate.mjs';
import { runMultilogueV2 } from '../core/pipeline.mjs';
import { validateTier5Consistency } from './metrics.mjs';
import { applyFrozenFloorSemanticPass, structuralDigests } from './frozen-semantic-pass.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const RECORDING_ID = 'Multilogue04_C_Level30_D1G4';
const DEFAULT_AUDIO = path.join(ROOT, 'sample', 'Multilogue04_C_Level30 D1G4.wav');
const DEFAULT_STAGE1 = path.join(ROOT, 'outputs', 'multilogue-v2-poc', RECORDING_ID, 'phase-i', 'stage1-evidence.json');
const FIXED = Object.freeze({
  pause_threshold_seconds: 0.25,
  floor_release_seconds: 1,
  minimum_overlap_seconds: 0.1,
  overlap_mode: 'path_b_exclusive',
  rule_set_version: V23_RULE_SET_VERSION,
  six_tier_schema: ['S1', 'S2', 'S3', 'floor', 'transitions', 'flags'],
  nine_labels: ['s', 'f', 'bc', 'ol', 'op', 'pf', 'tr', 'shs', 'x'],
});
const METRIC_OWNERSHIP = Object.freeze({
  A: ['active_set_exact_accuracy', 'room_activity_f1', 'boundary_f1_100ms'],
  B: ['active_set_exact_accuracy', 'boundary_f1_100ms'],
  C: ['active_set_exact_accuracy', 'floor_accuracy', 'transition_matched', 'tier5_handoff_matched_100ms'],
  D: ['macro_f1_observed_labels', 'f_f1', 'bc_f1'],
});

export function generateV23FinalStage({
  stage,
  outputDir,
  frozenConfig = null,
  audio = DEFAULT_AUDIO,
  stage1File = DEFAULT_STAGE1,
}) {
  if (!Object.hasOwn(METRIC_OWNERSHIP, stage)) throw new Error(`stage must be one of ${Object.keys(METRIC_OWNERSHIP).join(', ')}`);
  if (!outputDir) throw new Error('outputDir is required');
  if (existsSync(outputDir)) throw new Error(`generator output already exists: ${outputDir}`);
  const stage1 = readJson(stage1File);
  assertFixed(stage1);
  const prepared = prepareLocalAcousticVad(audio, defaultVadOptions());
  const vadOptions = {
    ...defaultVadOptions(), minSilenceSeconds: 0, padSoundingSeconds: 0, minSoundingSeconds: 0.1,
  };
  const vad = computeLocalAcousticVadFromPrepared(prepared, vadOptions);
  const roomSounding = vad.intervals.filter((item) => item.text === 'sounding')
    .map(({ start, end }) => ({ start, end }));
  const configs = stageConfigs(stage, frozenConfig);
  const candidatesDir = path.join(outputDir, 'candidates');
  mkdirSync(candidatesDir, { recursive: true });
  const index = [];

  for (const config of configs) {
    const candidateId = `v23f-${stage.toLowerCase()}-${hashText(stableJson(config)).slice(0, 12)}`;
    const candidateDir = path.join(candidatesDir, candidateId);
    mkdirSync(candidateDir, { recursive: true });
    const adapterOptions = {
      ...config.adapter,
      acousticFrames: prepared.frames,
      acousticThresholdDb: vad.method.threshold_dbfs,
      acousticHopMs: prepared.hop_ms,
    };
    const built = buildV23Stage1Candidate(stage1, roomSounding, adapterOptions);
    built.input.thresholds = [FIXED.pause_threshold_seconds];
    built.input.sharedActivityOptions = {
      ...(built.input.sharedActivityOptions || {}),
      minSoundingSeconds: 0.5,
    };
    built.input.interactionConfig = {
      ...(built.input.interactionConfig || {}),
      floorReleaseSeconds: FIXED.floor_release_seconds,
      minOverlapSeconds: FIXED.minimum_overlap_seconds,
      overlapMode: FIXED.overlap_mode,
      rebuildTransitionsFromFloor: true,
      backchannelMaxWords: 3,
      holderContinuationWindowSeconds: 1,
    };
    let output = runMultilogueV2(built.input).thresholds.P250;
    const preSemanticDigests = structuralDigests(output.textgrid_document);
    if (stage === 'D') {
      output = applyFrozenFloorSemanticPass(output, built.input.stage1Evidence, config.semantic);
    }
    const postSemanticDigests = structuralDigests(output.textgrid_document);
    if (stage === 'D') assertSameFrozenArtifacts(preSemanticDigests, postSemanticDigests);
    const tier5 = validateTier5Consistency(output);
    if (!tier5.pass) throw new Error(`Tier5 consistency failed: ${tier5.errors.join('; ')}`);

    const textGridName = `${RECORDING_ID}.P025.${candidateId}.6tier.TextGrid`;
    const textGridFile = path.join(candidateDir, textGridName);
    const evidenceFile = path.join(candidateDir, 'runtime-evidence.json');
    const manifestFile = path.join(candidateDir, 'generator-manifest.json');
    writeFileSync(textGridFile, output.textgrid, 'utf8');
    writeJson(evidenceFile, {
      contract_version: 'v23-final-runtime-evidence-v1',
      candidate_id: candidateId,
      stage,
      config,
      adapter_stats: built.stats,
      provenance: built.provenance,
      stage1_evidence: built.input.stage1Evidence,
      semantic_pass: output.semantic_pass || null,
      semantic_evidence_coverage: summarizeEvidenceCoverage(built.input.stage1Evidence),
      structural_digests: postSemanticDigests,
      tier5_internal_consistency: tier5,
    });
    writeJson(manifestFile, {
      contract_version: 'v23-final-generator-manifest-v1',
      candidate_id: candidateId,
      stage,
      metric_ownership: METRIC_OWNERSHIP[stage],
      runtime_gold_access: false,
      network_used: false,
      production_defaults_changed: false,
      fixed_research_contract: FIXED,
      config,
      acoustic_crossing: {
        frame_source: 'prepareLocalAcousticVad(original WAV).frames.db',
        threshold_dbfs: vad.method.threshold_dbfs,
        missing_side_policy: 'retain only the missing side original boundary and record applied_sides',
        smoothing_precomputed_once_per_stage_config: true,
      },
      inputs: {
        audio: fileRecord(audio),
        stage1: fileRecord(stage1File),
      },
      output_digest: output.digest,
      structural_digests: postSemanticDigests,
      tier5_internal_consistency: tier5,
    });
    const hashes = hashFiles([textGridFile, evidenceFile, manifestFile]);
    writeJson(path.join(candidateDir, 'artifact-hashes.json'), {
      contract_version: 'v23-final-candidate-hashes-v1',
      candidate_id: candidateId,
      files: hashes,
      aggregate_sha256: hashText(stableJson(hashes)),
    });
    index.push({
      candidate_id: candidateId,
      candidate_dir: path.relative(outputDir, candidateDir).replaceAll(path.sep, '/'),
      config,
      aggregate_sha256: hashText(stableJson(hashes)),
    });
  }
  const candidateIndexFile = path.join(outputDir, 'candidate-index.json');
  writeJson(candidateIndexFile, {
    contract_version: 'v23-final-generator-index-v1',
    stage,
    candidate_count: index.length,
    expected_candidate_count: expectedCount(stage),
    metric_ownership: METRIC_OWNERSHIP[stage],
    runtime_gold_access: false,
    candidates: index,
  });
  const candidateIndexSha256 = fileRecord(candidateIndexFile).sha256;
  return {
    stage,
    outputDir,
    candidates: index,
    candidateIndexFile,
    candidateIndexSha256,
  };
}

export function stageConfigs(stage, frozenConfig = null) {
  const base = frozenConfig ? structuredClone(frozenConfig) : baseConfig();
  const configs = [];
  if (stage === 'A') {
    for (const radius of [120, 150, 180]) for (const smoothing of [20, 30]) {
      for (const hysteresis of [1, 3]) for (const stable of [30, 50]) {
        const config = baseConfig();
        Object.assign(config.adapter, {
          boundarySearchRadiusMs: radius,
          boundarySmoothingMs: smoothing,
          boundaryHysteresisDb: hysteresis,
          boundaryStableRunMs: stable,
        });
        configs.push(config);
      }
    }
  } else if (stage === 'B') {
    for (const minimum of [0.08, 0.1]) for (const support of [0.6, 0.8]) {
      for (const identity of ['agreement_only', 'bounded_margin']) {
        const config = structuredClone(base);
        Object.assign(config.adapter, {
          residualMinSeconds: minimum,
          residualAcousticSupportRatio: support,
          residualIdentityPolicy: identity,
        });
        configs.push(config);
      }
    }
  } else if (stage === 'C') {
    for (const gap of [0.25, 0.35]) for (const confidence of [0.7, 0.8]) {
      for (const margin of [0.1, 0.2]) {
        const config = structuredClone(base);
        Object.assign(config.adapter, {
          phraseGapSeconds: gap,
          shortTurnMinAssemblyConfidence: confidence,
          providerScoreMargin: margin,
        });
        configs.push(config);
      }
    }
  } else {
    for (const words of [2, 3]) for (const continuation of [0.5, 1]) {
      const config = structuredClone(base);
      config.semantic = {
        backchannelMaxWords: words,
        holderContinuationWindowSeconds: continuation,
      };
      configs.push(config);
    }
  }
  if (configs.length !== expectedCount(stage)) throw new Error(`stage ${stage} grid count drifted`);
  return configs;
}

function baseConfig() {
  return {
    adapter: {
      phraseGapSeconds: 0.25,
      phraseMaxSeconds: 1.5,
      parentResponseGapSeconds: 0.5,
      parentResponseMaxSeconds: 8,
      activityBridgeSeconds: 0,
      shortTurnAssemblyOverride: true,
      shortTurnMaxWords: 12,
      shortTurnMaxSeconds: 3.2,
      shortTurnMinAssemblyConfidence: 0.7,
      providerScoreMargin: 0.1,
      semanticProjectorScoreBonus: 0.15,
      residualMinSeconds: 0.08,
      residualNonlexicalMaxSeconds: 0.25,
      residualAcousticSupportRatio: 0.6,
      residualIdentityPolicy: 'bounded_margin',
      promoteLongResidual: true,
      rebuildTransitionsFromFloor: true,
      boundaryRefinementEnabled: true,
      boundarySearchRadiusMs: 150,
      boundarySmoothingMs: 20,
      boundaryHysteresisDb: 1,
      boundaryStableRunMs: 30,
    },
    semantic: { backchannelMaxWords: 3, holderContinuationWindowSeconds: 1 },
  };
}

function expectedCount(stage) {
  return { A: 24, B: 8, C: 8, D: 4 }[stage];
}

function assertFixed(stage1) {
  if (Number(stage1.interactionConfig?.floorReleaseSeconds) !== 1) throw new Error('L must remain 1.0');
  if (Number(stage1.interactionConfig?.minOverlapSeconds) !== 0.1) throw new Error('minimum overlap must remain 0.1');
  if (stage1.interactionConfig?.overlapMode !== 'path_b_exclusive') throw new Error('Path B must remain fixed');
}

function assertSameFrozenArtifacts(before, after) {
  for (const key of ['active', 'floor', 'transitions']) {
    if (before[key] !== after[key]) throw new Error(`Stage D changed frozen ${key} artifact`);
  }
}

function summarizeEvidenceCoverage(events) {
  const totals = { explicit_asr_seconds: 0, unknown_acoustic_seconds: 0, other_seconds: 0 };
  for (const event of events) {
    const seconds = (event.activity_segments || [{ start: event.start, end: event.end }])
      .reduce((sum, segment) => sum + Math.max(0, Number(segment.end) - Number(segment.start)), 0);
    if (event.semantic_evidence === 'explicit_asr') totals.explicit_asr_seconds += seconds;
    else if (event.semantic_evidence === 'unknown_acoustic') totals.unknown_acoustic_seconds += seconds;
    else totals.other_seconds += seconds;
  }
  const denominator = totals.explicit_asr_seconds + totals.unknown_acoustic_seconds;
  return {
    explicit_asr_seconds: Number(totals.explicit_asr_seconds.toFixed(6)),
    unknown_acoustic_seconds: Number(totals.unknown_acoustic_seconds.toFixed(6)),
    other_seconds: Number(totals.other_seconds.toFixed(6)),
    explicit_semantic_share_of_activity_evidence: denominator > 0
      ? Number((totals.explicit_asr_seconds / denominator).toFixed(6)) : 0,
  };
}

function hashFiles(files) {
  return Object.fromEntries(files.map((file) => [path.basename(file), fileRecord(file)]));
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
    else if (key === '--audio') options.audio = path.resolve(value);
    else if (key === '--stage1') options.stage1File = path.resolve(value);
    else throw new Error(`unknown generator argument: ${key}`);
    index += 1;
  }
  return options;
}

function main() {
  const result = generateV23FinalStage(parseArgs(process.argv));
  process.stdout.write(`${JSON.stringify({
    stage: result.stage,
    candidate_count: result.candidates.length,
    output_dir: result.outputDir,
    candidate_index_sha256: result.candidateIndexSha256,
  })}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) main();
