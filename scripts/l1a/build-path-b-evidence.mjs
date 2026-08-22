#!/usr/bin/env node

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  compareDiarizations,
  normalizeTurns,
  turnsFromAssemblyAi,
  turnsFromPyannoteJson,
} from '../phase1/lib/diarization-artifacts.mjs';
import { runAdapter } from '../multilogue-v2/adapters/build-stage1-evidence.mjs';
import { assessL1aHandoff } from './handoff-gate.mjs';

export const L1A_PATH_B_EVIDENCE_CONTRACT_VERSION = 'l1a-path-b-evidence-v1';

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function writeJsonAtomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  fs.renameSync(temporary, file);
}

function sha256File(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function sha256Value(value) {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function ensureInside(root, file) {
  const safeRoot = path.resolve(root);
  const resolved = path.resolve(file);
  if (resolved !== safeRoot && !resolved.startsWith(`${safeRoot}${path.sep}`)) {
    throw new Error('Path B evidence output must stay inside the accepted L1a revision');
  }
  return resolved;
}

function assemblyTurnsFromRaw(raw, duration) {
  const utteranceTurns = turnsFromAssemblyAi(raw, duration);
  if (utteranceTurns.length) return utteranceTurns;
  const wordTurns = (Array.isArray(raw?.words) ? raw.words : []).map((word, index) => ({
    index,
    speaker: word.speaker,
    start: Number(word.start) / 1000,
    end: Number(word.end) / 1000,
    confidence: word.confidence,
    text: word.text || '',
    source: 'assemblyai_timed_words',
  }));
  return normalizeTurns(wordTurns, duration);
}

function artifactRecord(role, file) {
  return {
    role,
    path: path.resolve(file),
    bytes: fs.statSync(file).size,
    sha256: sha256File(file),
  };
}

function annotateAdapterOutputs({ outputDir, manifest, manifestPath, comparisonPath }) {
  const mappingPath = path.join(outputDir, 'provider-mapping.json');
  const inputManifestPath = path.join(outputDir, 'input-manifest.json');
  const stage1Path = path.join(outputDir, 'stage1-evidence.json');
  const gateReportPath = path.join(outputDir, 'phase1-gate-report.json');

  const mapping = readJson(mappingPath);
  mapping.provenance = {
    ...(mapping.provenance || {}),
    basis: 'researcher_accepted_canonical_turns_vs_assemblyai_maximum_overlap',
    accepted_l1a_manifest: manifestPath,
    accepted_l1a_review_revision: manifest.review?.revision ?? null,
    comparison_artifact: comparisonPath,
    canonical_id_assignment: {
      method: 'accepted_l1a_manifest_speaker_order',
      assignment: Object.fromEntries(manifest.speakers.map((speaker) => [speaker, speaker])),
      temporary: false,
      researcher_confirmed_identity: true,
    },
    human_identity_claim: false,
    accuracy_claim: false,
  };
  writeJsonAtomic(mappingPath, mapping);

  const inputManifest = readJson(inputManifestPath);
  inputManifest.l1a_wrapper = {
    contract_version: L1A_PATH_B_EVIDENCE_CONTRACT_VERSION,
    attribution_source: 'researcher_accepted_canonical_l1a_turns',
    accepted_l1a_manifest: manifestPath,
    accepted_l1a_review_revision: manifest.review?.revision ?? null,
    assemblyai_role: 'timed_word_and_provider_speaker_evidence',
    network_calls_performed: false,
  };
  writeJsonAtomic(inputManifestPath, inputManifest);

  const stage1 = readJson(stage1Path);
  stage1.adapterMetadata = {
    ...(stage1.adapterMetadata || {}),
    l1a_wrapper_contract: L1A_PATH_B_EVIDENCE_CONTRACT_VERSION,
    attribution_source: 'researcher_accepted_canonical_l1a_turns',
  };
  writeJsonAtomic(stage1Path, stage1);

  const gateReport = readJson(gateReportPath);
  gateReport.l1a_wrapper = {
    contract_version: L1A_PATH_B_EVIDENCE_CONTRACT_VERSION,
    base_handoff_required: true,
    attribution_source: 'researcher_accepted_canonical_l1a_turns',
    assemblyai_source: 'cached_raw_timed_word_json',
    accuracy_claim: false,
  };
  writeJsonAtomic(gateReportPath, gateReport);
  return gateReport;
}

function updatePathBHandoff(handoffPath, patch) {
  if (!handoffPath || !fs.existsSync(handoffPath)) return null;
  const handoff = readJson(handoffPath);
  const next = { ...handoff, ...patch };
  writeJsonAtomic(handoffPath, next);
  return next;
}

export function assessL1aPathBReadiness({ manifestPath } = {}) {
  const baseGate = assessL1aHandoff({ manifestPath });
  const assertions = [];
  const add = (id, passed, message, details = null) => {
    assertions.push({ id, passed: Boolean(passed), message, ...(details ? { details } : {}) });
  };
  if (!baseGate.passed) {
    add('base_handoff_gate', false, 'The accepted L1a handoff gate must pass before Path B evidence is usable.', {
      blockers: baseGate.blockers,
    });
    return {
      contract_version: L1A_PATH_B_EVIDENCE_CONTRACT_VERSION,
      passed: false,
      ready_for_path_b: false,
      assertions,
      blockers: assertions.map((item) => ({ code: item.id, message: item.message, details: item.details || null })),
      base_handoff_gate: baseGate,
    };
  }
  const manifest = readJson(path.resolve(manifestPath));
  const handoffPath = path.resolve(manifest.outputs.phase_ii_handoff_manifest);
  const handoff = readJson(handoffPath);
  const pathBGate = handoff.path_b_gate || null;
  add(
    'enhanced_handoff_ready',
    handoff.ready_for_path_b === true && pathBGate?.status === 'pass',
    'The enhanced handoff must explicitly record a passed G1 and ready_for_path_b=true.',
  );
  add(
    'enhanced_handoff_contract',
    pathBGate?.contract_version === L1A_PATH_B_EVIDENCE_CONTRACT_VERSION,
    'The enhanced handoff must use the current Path B evidence contract.',
  );
  const artifacts = Array.isArray(pathBGate?.artifacts) ? pathBGate.artifacts : [];
  const assemblyaiSource = pathBGate?.assemblyai_source || null;
  const requiredRoles = [
    'provider_comparison',
    'input_manifest',
    'provider_mapping',
    'room_activity_base',
    'stage1_evidence',
    'phase1_gate_report',
  ];
  add(
    'path_b_artifact_set',
    artifacts.length === requiredRoles.length
      && requiredRoles.every((role) => artifacts.filter((item) => item.role === role).length === 1),
    'The enhanced handoff must contain the complete, unique six-file Path B evidence set.',
    { expected: requiredRoles, actual: artifacts.map((item) => item.role) },
  );
  for (const record of artifacts) {
    if (!record.path || !fs.existsSync(record.path)) {
      add(`path_b_${record.role}`, false, 'A sealed Path B evidence file is missing.', { path: record.path || null });
      continue;
    }
    const actualSha = sha256File(record.path);
    add(
      `path_b_${record.role}`,
      actualSha === record.sha256 && fs.statSync(record.path).size === record.bytes,
      'A Path B evidence file must match its sealed hash and byte count.',
      { path: record.path, expected_sha256: record.sha256, actual_sha256: actualSha },
    );
  }
  if (!assemblyaiSource?.path || !fs.existsSync(assemblyaiSource.path)) {
    add('assemblyai_source', false, 'The cached AssemblyAI timed-word source is missing.', {
      path: assemblyaiSource?.path || null,
    });
  } else {
    const actualSha = sha256File(assemblyaiSource.path);
    add(
      'assemblyai_source',
      actualSha === assemblyaiSource.sha256 && fs.statSync(assemblyaiSource.path).size === assemblyaiSource.bytes,
      'The cached AssemblyAI timed-word source must match its sealed hash and byte count.',
      { path: assemblyaiSource.path, expected_sha256: assemblyaiSource.sha256, actual_sha256: actualSha },
    );
  }
  const gateReportRecord = artifacts.find((item) => item.role === 'phase1_gate_report');
  let gateReportStatus = null;
  if (gateReportRecord?.path && fs.existsSync(gateReportRecord.path)) {
    try {
      gateReportStatus = readJson(gateReportRecord.path).status;
    } catch {
      gateReportStatus = null;
    }
  }
  add('g1_status', gateReportStatus === 'pass', 'The sealed Phase-1 gate report must record G1 pass.');
  const storedIdentity = pathBGate?.sealed_evidence_identity || null;
  const identityMaterial = storedIdentity ? {
    contract_version: L1A_PATH_B_EVIDENCE_CONTRACT_VERSION,
    base_handoff_identity_sha256: baseGate.sealed_handoff_identity.identity_sha256,
    assemblyai_raw_sha256: storedIdentity.assemblyai_raw_sha256,
    artifacts: artifacts.map(({ role, bytes, sha256 }) => ({ role, bytes, sha256 })),
    g1_status: gateReportStatus || 'fail',
  } : null;
  const expectedIdentity = identityMaterial ? sha256Value(identityMaterial) : null;
  add(
    'path_b_evidence_identity',
    Boolean(storedIdentity) && storedIdentity.identity_sha256 === expectedIdentity,
    'The Path B evidence identity must match the accepted L1a handoff and sealed G1 artifacts.',
    { expected: expectedIdentity, actual: storedIdentity?.identity_sha256 ?? null },
  );
  const blockers = assertions
    .filter((item) => !item.passed)
    .map((item) => ({ code: item.id, message: item.message, details: item.details || null }));
  return {
    contract_version: L1A_PATH_B_EVIDENCE_CONTRACT_VERSION,
    passed: blockers.length === 0,
    ready_for_path_b: blockers.length === 0,
    assertions,
    blockers,
    base_handoff_gate: baseGate,
    handoff_path: handoffPath,
    sealed_evidence_identity: storedIdentity,
  };
}

function failureResult({ baseGate, manifestPath, handoffPath, outputDir, blockers }) {
  updatePathBHandoff(handoffPath, {
    ready_for_path_b: false,
    path_b_gate: {
      contract_version: L1A_PATH_B_EVIDENCE_CONTRACT_VERSION,
      status: 'fail',
      blockers,
      evidence_dir: outputDir || null,
    },
  });
  return {
    contract_version: L1A_PATH_B_EVIDENCE_CONTRACT_VERSION,
    passed: false,
    ready_for_path_b: false,
    blockers,
    base_handoff_gate: baseGate,
    manifest_path: manifestPath,
    handoff_path: handoffPath,
    output_dir: outputDir || null,
    artifacts: [],
  };
}

export function buildL1aPathBEvidence({
  manifestPath,
  assemblyaiPath,
  outputDir = null,
  frameMs = 10,
} = {}) {
  if (!manifestPath) throw new Error('manifestPath is required');
  if (!assemblyaiPath) throw new Error('assemblyaiPath is required');
  const resolvedManifest = path.resolve(manifestPath);
  const resolvedAssembly = path.resolve(assemblyaiPath);
  const baseGate = assessL1aHandoff({ manifestPath: resolvedManifest });
  const manifest = fs.existsSync(resolvedManifest) ? readJson(resolvedManifest) : null;
  const handoffPath = manifest?.outputs?.phase_ii_handoff_manifest
    ? path.resolve(manifest.outputs.phase_ii_handoff_manifest)
    : null;
  const acceptedRevisionDir = path.dirname(resolvedManifest);
  const resolvedOutput = ensureInside(
    acceptedRevisionDir,
    outputDir || path.join(acceptedRevisionDir, 'internal_evidence', 'path-b'),
  );
  if (!baseGate.passed) {
    return failureResult({
      baseGate,
      manifestPath: resolvedManifest,
      handoffPath,
      outputDir: resolvedOutput,
      blockers: baseGate.blockers.map((item) => ({ code: `l1a_${item.code}`, message: item.message })),
    });
  }
  if (!fs.existsSync(resolvedAssembly)) {
    return failureResult({
      baseGate,
      manifestPath: resolvedManifest,
      handoffPath,
      outputDir: resolvedOutput,
      blockers: [{ code: 'assemblyai_input_missing', message: 'AssemblyAI raw timed-word JSON does not exist.' }],
    });
  }

  fs.mkdirSync(resolvedOutput, { recursive: true });
  const duration = Number(manifest.duration_seconds);
  const acceptedTurnsRaw = readJson(manifest.outputs.speaker_turns_json);
  const acceptedTurns = turnsFromPyannoteJson(acceptedTurnsRaw, duration);
  const assemblyRaw = readJson(resolvedAssembly);
  const assemblyTurns = assemblyTurnsFromRaw(assemblyRaw, duration);
  const comparisonPath = path.join(resolvedOutput, 'accepted-canonical-vs-assemblyai.provider-comparison.json');
  const comparison = {
    contract_version: 'accepted-canonical-vs-assemblyai-provider-comparison-v1',
    generated_at: new Date().toISOString(),
    accuracy_claim: false,
    reference_system: 'AssemblyAI timed speaker evidence',
    candidate_system: 'researcher-accepted canonical L1a turns',
    ...compareDiarizations(assemblyTurns, acceptedTurns, { duration, frameMs }),
  };
  writeJsonAtomic(comparisonPath, comparison);

  const speakerCount = Array.isArray(manifest.speakers) ? manifest.speakers.length : 0;
  if (speakerCount < 2) {
    return failureResult({
      baseGate,
      manifestPath: resolvedManifest,
      handoffPath,
      outputDir: resolvedOutput,
      blockers: [{
        code: 'path_b_requires_multiple_speakers',
        message: 'Path B requires at least two accepted canonical speakers.',
      }],
    });
  }
  if (Object.keys(comparison.mapping_candidate_to_reference || {}).length !== speakerCount) {
    return failureResult({
      baseGate,
      manifestPath: resolvedManifest,
      handoffPath,
      outputDir: resolvedOutput,
      blockers: [{
        code: 'provider_mapping_not_bijective',
        message: 'AssemblyAI timed evidence could not be mapped bijectively to every accepted canonical speaker.',
      }],
    });
  }

  try {
    runAdapter({
      audio: manifest.sealed_evidence.source_wav.path,
      pyannoteTurns: manifest.outputs.speaker_turns_json,
      pyannoteManifest: resolvedManifest,
      assemblyai: resolvedAssembly,
      comparison: comparisonPath,
      outputDir: resolvedOutput,
      recordingId: manifest.recording_id,
    });
  } catch (error) {
    return failureResult({
      baseGate,
      manifestPath: resolvedManifest,
      handoffPath,
      outputDir: resolvedOutput,
      blockers: [{ code: 'stage1_adapter_failed', message: error.message }],
    });
  }
  const annotatedGateReport = annotateAdapterOutputs({
    outputDir: resolvedOutput,
    manifest,
    manifestPath: resolvedManifest,
    comparisonPath,
  });

  const artifactPaths = [
    ['provider_comparison', comparisonPath],
    ['input_manifest', path.join(resolvedOutput, 'input-manifest.json')],
    ['provider_mapping', path.join(resolvedOutput, 'provider-mapping.json')],
    ['room_activity_base', path.join(resolvedOutput, 'room-activity-base.json')],
    ['stage1_evidence', path.join(resolvedOutput, 'stage1-evidence.json')],
    ['phase1_gate_report', path.join(resolvedOutput, 'phase1-gate-report.json')],
  ];
  const artifacts = artifactPaths.map(([role, file]) => artifactRecord(role, file));
  const g1Passed = annotatedGateReport.status === 'pass';
  const evidenceIdentityMaterial = {
    contract_version: L1A_PATH_B_EVIDENCE_CONTRACT_VERSION,
    base_handoff_identity_sha256: baseGate.sealed_handoff_identity.identity_sha256,
    assemblyai_raw_sha256: sha256File(resolvedAssembly),
    artifacts: artifacts.map(({ role, bytes, sha256 }) => ({ role, bytes, sha256 })),
    g1_status: annotatedGateReport.status || 'fail',
  };
  const evidenceIdentity = {
    ...evidenceIdentityMaterial,
    identity_sha256: sha256Value(evidenceIdentityMaterial),
  };
  const blockers = g1Passed ? [] : [{ code: 'g1_failed', message: 'The reused Stage-1 adapter did not pass G1.' }];
  updatePathBHandoff(handoffPath, {
    ready_for_path_b: g1Passed,
    path_b_gate: {
      contract_version: L1A_PATH_B_EVIDENCE_CONTRACT_VERSION,
      status: g1Passed ? 'pass' : 'fail',
      blockers,
      evidence_dir: resolvedOutput,
      phase1_gate_report: path.join(resolvedOutput, 'phase1-gate-report.json'),
      assemblyai_source: artifactRecord('assemblyai_raw', resolvedAssembly),
      artifacts,
      sealed_evidence_identity: evidenceIdentity,
    },
  });
  const readiness = assessL1aPathBReadiness({ manifestPath: resolvedManifest });
  return {
    contract_version: L1A_PATH_B_EVIDENCE_CONTRACT_VERSION,
    passed: readiness.passed,
    ready_for_path_b: readiness.ready_for_path_b,
    blockers: readiness.blockers,
    base_handoff_gate: baseGate,
    manifest_path: resolvedManifest,
    handoff_path: handoffPath,
    output_dir: resolvedOutput,
    artifacts,
    provider_comparison: comparison,
    phase1_gate_report: annotatedGateReport,
    sealed_evidence_identity: evidenceIdentity,
    readiness,
  };
}

function parseArgs(argv) {
  const options = {};
  const fields = new Map([
    ['--manifest', 'manifestPath'],
    ['--assemblyai', 'assemblyaiPath'],
    ['--output-dir', 'outputDir'],
    ['--frame-ms', 'frameMs'],
  ]);
  for (let index = 2; index < argv.length; index += 1) {
    const field = fields.get(argv[index]);
    if (!field || !argv[index + 1]) throw new Error(`Unknown or incomplete argument: ${argv[index]}`);
    options[field] = field === 'frameMs' ? Number(argv[index + 1]) : argv[index + 1];
    index += 1;
  }
  if (!options.manifestPath) throw new Error('--manifest is required');
  if (!options.assemblyaiPath) throw new Error('--assemblyai is required');
  if (options.frameMs != null && (!Number.isFinite(options.frameMs) || options.frameMs <= 0)) {
    throw new Error('--frame-ms must be positive');
  }
  return options;
}

function main() {
  const result = buildL1aPathBEvidence(parseArgs(process.argv));
  process.stdout.write(`${JSON.stringify({
    contract_version: result.contract_version,
    passed: result.passed,
    ready_for_path_b: result.ready_for_path_b,
    blockers: result.blockers,
    output_dir: result.output_dir,
    artifacts: result.artifacts,
  }, null, 2)}\n`);
  if (!result.passed) process.exitCode = 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
