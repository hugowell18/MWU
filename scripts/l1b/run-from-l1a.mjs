#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { buildL1aPathBEvidence, assessL1aPathBReadiness } from '../l1a/build-path-b-evidence.mjs';
import { assessL1aHandoff } from '../l1a/handoff-gate.mjs';
import { getApiKey, transcribe } from '../validation-sprint/lib/asr.mjs';
import { runPathBL1b } from './run-path-b.mjs';

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function writeJson(file, value) {
  if (!file) return;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function writeJsonAtomic(file, value) {
  if (!file) return;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  fs.renameSync(temporary, file);
}

function findSessionRoot(manifestPath) {
  let cursor = path.dirname(path.resolve(manifestPath));
  while (cursor !== path.dirname(cursor)) {
    if (path.basename(cursor) === 'L1a') return path.dirname(cursor);
    cursor = path.dirname(cursor);
  }
  return null;
}

function relativeToSession(sessionRoot, file) {
  return path.relative(sessionRoot, file).split(path.sep).join('/');
}

function publishLayerState({ manifest, manifestPath, result, out }) {
  const sessionRoot = findSessionRoot(manifestPath);
  if (!sessionRoot) return null;
  const layerRoot = path.join(sessionRoot, 'L1b');
  const revisionRoot = path.dirname(path.resolve(out));
  if (path.dirname(revisionRoot) !== path.join(layerRoot, 'revisions')) return null;
  const revision = path.basename(revisionRoot);
  const layerManifestPath = path.join(layerRoot, 'layer_manifest.json');
  const sessionManifestPath = path.join(sessionRoot, 'session_manifest.json');
  const researchRoles = new Set([
    'textgrids',
    'metrics',
    'package',
  ]);
  const namedEvidence = new Set([
    'nine_label_intervals.csv',
    'transition_evidence.csv',
    'overlap-capability-evidence.json',
  ]);
  const clientDeliverables = result.report.artifacts
    .filter((artifact) => researchRoles.has(artifact.group) || namedEvidence.has(path.basename(artifact.path)))
    .map((artifact) => ({
      role: artifact.group === 'evidence' ? path.basename(artifact.path, path.extname(artifact.path)) : artifact.group,
      threshold_sec: artifact.threshold ?? null,
      name: path.basename(artifact.path),
      relative_path: relativeToSession(sessionRoot, artifact.path),
      bytes: artifact.bytes,
      sha256: artifact.sha256,
    }));
  const layerManifest = {
    schema_version: 'mwu-layer-output-index-v1',
    generated_at: new Date().toISOString(),
    session_id: manifest.session_id,
    recording_id: manifest.recording_id,
    layer: 'L1b',
    status: 'draft_ready_for_praat_review',
    latest_revision: revision,
    revision_output_dir: relativeToSession(sessionRoot, out),
    source_l1a_manifest: relativeToSession(sessionRoot, manifestPath),
    source_l1a_identity_sha256: result.report.handoff_gate.l1a_identity_sha256,
    source_path_b_identity_sha256: result.report.handoff_gate.path_b_identity_sha256,
    client_delivery_contract: 'l1b-path-b-dual-threshold-draft-v1',
    client_deliverables: clientDeliverables,
    internal_evidence: result.report.artifacts
      .filter((artifact) => !clientDeliverables.some((item) => item.sha256 === artifact.sha256 && item.name === path.basename(artifact.path)))
      .map((artifact) => ({
        threshold_sec: artifact.threshold ?? null,
        name: path.basename(artifact.path),
        relative_path: relativeToSession(sessionRoot, artifact.path),
        sha256: artifact.sha256,
      })),
    next_layer_input: {
      layer: 'L2',
      kind: 'researcher-reviewed-l1b-nine-label-timeline-v1',
      ready: false,
      blocker: 'Praat/researcher correction and L1b finalization are required.',
    },
  };
  writeJsonAtomic(layerManifestPath, layerManifest);

  const previousSession = fs.existsSync(sessionManifestPath) ? readJson(sessionManifestPath) : {};
  writeJsonAtomic(sessionManifestPath, {
    ...previousSession,
    schema_version: previousSession.schema_version || 'mwu-processing-session-v1',
    session_id: manifest.session_id,
    recording_id: manifest.recording_id,
    updated_at: new Date().toISOString(),
    layer_order: previousSession.layer_order || ['L1a', 'L1b', 'L2', 'L3'],
    layers: {
      ...(previousSession.layers || {}),
      L1b: {
        status: 'draft_ready_for_praat_review',
        latest_revision: revision,
        manifest: 'L1b/layer_manifest.json',
        input_from: 'L1a.next_layer_input',
      },
      L2: {
        ...(previousSession.layers?.L2 || {}),
        status: 'blocked_pending_l1b_review',
        input_from: 'L1b.next_layer_input',
      },
    },
  });
  return layerManifestPath;
}

function parseThresholds(value) {
  const thresholds = [...new Set(String(value || '0.25,0.35').split(',')
    .map(Number).filter((item) => item > 0 && item < 5))].sort((a, b) => a - b);
  if (!thresholds.length) throw new Error('at least one pause threshold is required');
  return thresholds;
}

function parseArgs(argv) {
  const options = {};
  const fields = new Map([
    ['--manifest', 'manifest'],
    ['--assemblyai', 'assemblyai'],
    ['--out', 'out'],
    ['--thresholds', 'thresholds'],
    ['--progress', 'progress'],
    ['--latest-pointer', 'latestPointer'],
  ]);
  for (let index = 2; index < argv.length; index += 1) {
    const field = fields.get(argv[index]);
    if (!field || !argv[index + 1]) throw new Error(`unknown or incomplete argument: ${argv[index]}`);
    options[field] = field === 'thresholds' ? argv[index + 1] : path.resolve(argv[index + 1]);
    index += 1;
  }
  if (!options.manifest || !options.out) throw new Error('--manifest and --out are required');
  return options;
}

function progressWriter(file, manifest) {
  const state = {
    schema_version: 'mwu-l1b-path-b-progress-v1',
    recording_id: manifest.recording_id,
    status: 'running',
    done: false,
    stages: [],
    updated_at: new Date().toISOString(),
  };
  const update = (id, status, detail = null) => {
    const existing = state.stages.find((item) => item.id === id);
    if (existing) Object.assign(existing, { status, detail });
    else state.stages.push({ id, status, detail });
    state.updated_at = new Date().toISOString();
    writeJson(file, state);
  };
  return { state, update };
}

function reusableAssemblySource(manifest) {
  const handoffPath = manifest.outputs?.phase_ii_handoff_manifest;
  if (!handoffPath || !fs.existsSync(handoffPath)) return null;
  const source = readJson(handoffPath).path_b_gate?.assemblyai_source;
  if (!source?.path || !fs.existsSync(source.path)) return null;
  return source.path;
}

async function ensureAssemblySource({ manifest, manifestPath, explicitPath, progress }) {
  if (explicitPath) {
    if (!fs.existsSync(explicitPath)) throw new Error(`AssemblyAI timed-word JSON is missing: ${explicitPath}`);
    progress.update('assemblyai_timed_words', 'passed', 'Explicit cached evidence');
    return explicitPath;
  }
  const reusable = reusableAssemblySource(manifest);
  if (reusable) {
    progress.update('assemblyai_timed_words', 'passed', 'Reused sealed evidence');
    return reusable;
  }
  progress.update('assemblyai_timed_words', 'running', 'Generating timed-word evidence');
  const acceptedDir = path.dirname(manifestPath);
  const cacheDir = path.join(acceptedDir, 'internal_evidence', 'assemblyai');
  const result = await transcribe(manifest.sealed_evidence.source_wav.path, {
    apiKey: getApiKey(),
    speakersExpected: manifest.speakers.length,
    cacheDir,
  });
  if (!result.source_path) throw new Error('AssemblyAI did not return a reusable timed-word artifact');
  progress.update('assemblyai_timed_words', 'passed', result.source);
  return result.source_path;
}

export async function runFromAcceptedL1a({ manifestPath, assemblyaiPath = null, out, thresholds, progressFile, latestPointer } = {}) {
  const gate = assessL1aHandoff({ manifestPath });
  if (!gate.passed) throw new Error(`L1a handoff gate failed: ${gate.blockers.map((item) => item.code).join(', ')}`);
  const manifest = readJson(manifestPath);
  const progress = progressWriter(progressFile, manifest);
  progress.update('l1a_handoff_gate', 'passed', gate.sealed_handoff_identity.identity_sha256);

  const assemblyai = await ensureAssemblySource({ manifest, manifestPath, explicitPath: assemblyaiPath, progress });
  let readiness = assessL1aPathBReadiness({ manifestPath });
  let evidenceArtifacts;
  if (readiness.passed) {
    const handoff = readJson(manifest.outputs.phase_ii_handoff_manifest);
    evidenceArtifacts = handoff.path_b_gate.artifacts;
    progress.update('stage1_evidence', 'passed', `Reused ${readiness.sealed_evidence_identity.identity_sha256}`);
  } else {
    progress.update('stage1_evidence', 'running', 'Building Path B evidence');
    const evidence = buildL1aPathBEvidence({ manifestPath, assemblyaiPath: assemblyai });
    if (!evidence.passed) throw new Error(`Path B evidence gate failed: ${evidence.blockers.map((item) => item.code).join(', ')}`);
    evidenceArtifacts = evidence.artifacts;
    readiness = assessL1aPathBReadiness({ manifestPath });
  }
  if (!readiness.passed) throw new Error(`Path B readiness failed: ${readiness.blockers.map((item) => item.code).join(', ')}`);
  progress.update('stage1_evidence', 'passed', readiness.sealed_evidence_identity.identity_sha256);

  const artifacts = new Map(evidenceArtifacts.map((item) => [item.role, item.path]));
  progress.update('path_b_thresholds', 'running', parseThresholds(thresholds).join(', '));
  const result = await runPathBL1b({
    manifest: manifestPath,
    stage1: artifacts.get('stage1_evidence'),
    mapping: artifacts.get('provider_mapping'),
    out,
    thresholds: parseThresholds(thresholds),
    latestPointer,
  });
  progress.update('path_b_thresholds', 'passed', `${result.report.threshold_reports.length} threshold runs`);
  progress.state.status = result.report.status;
  progress.state.done = true;
  progress.state.report = result.reportFile;
  progress.state.updated_at = new Date().toISOString();
  writeJson(progressFile, progress.state);
  const layerManifest = publishLayerState({ manifest, manifestPath, result, out });
  if (layerManifest) {
    result.report.layer_manifest = layerManifest;
    writeJson(result.reportFile, result.report);
  }
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const options = parseArgs(process.argv);
  try {
    const result = await runFromAcceptedL1a({
      manifestPath: options.manifest,
      assemblyaiPath: options.assemblyai,
      out: options.out,
      thresholds: options.thresholds,
      progressFile: options.progress,
      latestPointer: options.latestPointer,
    });
    process.stdout.write(`${JSON.stringify({ ok: true, report: result.reportFile, package: result.packageFile }, null, 2)}\n`);
  } catch (error) {
    writeJson(options.progress, {
      schema_version: 'mwu-l1b-path-b-progress-v1',
      status: 'failed',
      done: true,
      error: error.message || String(error),
      updated_at: new Date().toISOString(),
    });
    process.stderr.write(`${error.stack || error.message}\n`);
    process.exitCode = 1;
  }
}
