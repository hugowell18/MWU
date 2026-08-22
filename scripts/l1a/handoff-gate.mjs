#!/usr/bin/env node

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { readWavForMuting } from '../phase1/lib/diarization-artifacts.mjs';

export const L1A_HANDOFF_CONTRACT_VERSION = 'l1a-to-l1b-handoff-contract-v2';
export const L1A_HANDOFF_GATE_VERSION = 'l1a-to-l1b-handoff-gate-v1';

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function sha256File(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function sha256Value(value) {
  return crypto.createHash('sha256').update(stableJson(value)).digest('hex');
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map((item) => stableJson(item)).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function samePath(left, right) {
  if (!left || !right) return false;
  const canonical = (value) => {
    const resolved = path.resolve(value);
    try {
      return fs.realpathSync.native(resolved);
    } catch {
      return resolved;
    }
  };
  return canonical(left) === canonical(right);
}

function findLayerRoot(manifestPath) {
  let cursor = path.dirname(path.resolve(manifestPath));
  while (cursor !== path.dirname(cursor)) {
    if (path.basename(cursor) === 'L1a') return cursor;
    cursor = path.dirname(cursor);
  }
  return null;
}

function canonicalSpeakers(count) {
  return Array.from({ length: count }, (_, index) => `S${index + 1}`);
}

function finish(assertions, identity = null, paths = {}) {
  const blockers = assertions
    .filter((item) => !item.passed)
    .map((item) => ({ code: item.id, message: item.message, details: item.details || null }));
  return {
    contract_version: L1A_HANDOFF_CONTRACT_VERSION,
    gate_version: L1A_HANDOFF_GATE_VERSION,
    passed: blockers.length === 0,
    blockers,
    assertions,
    sealed_handoff_identity: identity ? { ...identity, validated: blockers.length === 0 } : null,
    paths,
  };
}

export function assessL1aHandoff({
  manifestPath,
  expectedRecordingId = null,
  expectedRunId = null,
  expectedSessionId = null,
  requireLatest = true,
  requireStoredIdentity = true,
} = {}) {
  const assertions = [];
  const add = (id, passed, message, details = null) => {
    assertions.push({ id, passed: Boolean(passed), message, ...(details ? { details } : {}) });
  };
  const resolvedManifest = manifestPath ? path.resolve(manifestPath) : null;
  add('manifest_path_provided', Boolean(resolvedManifest), 'An accepted L1a phase1 manifest path is required.');
  if (!resolvedManifest || !fs.existsSync(resolvedManifest)) {
    add('manifest_exists', false, 'The accepted L1a phase1 manifest does not exist.', { path: resolvedManifest });
    return finish(assertions, null, { manifest: resolvedManifest });
  }

  let manifest;
  try {
    manifest = readJson(resolvedManifest);
    add('manifest_json_valid', true, 'The accepted L1a phase1 manifest is valid JSON.');
  } catch (error) {
    add('manifest_json_valid', false, 'The accepted L1a phase1 manifest is not valid JSON.', { error: error.message });
    return finish(assertions, null, { manifest: resolvedManifest });
  }

  const handoffPath = manifest.outputs?.phase_ii_handoff_manifest
    ? path.resolve(manifest.outputs.phase_ii_handoff_manifest)
    : null;
  add('handoff_manifest_declared', Boolean(handoffPath), 'The accepted manifest must declare the L1a-to-L1b handoff manifest.');
  let handoff = null;
  if (handoffPath && fs.existsSync(handoffPath)) {
    try {
      handoff = readJson(handoffPath);
      add('handoff_manifest_json_valid', true, 'The L1a-to-L1b handoff manifest is valid JSON.');
    } catch (error) {
      add('handoff_manifest_json_valid', false, 'The L1a-to-L1b handoff manifest is not valid JSON.', { error: error.message });
    }
  } else {
    add('handoff_manifest_exists', false, 'The declared L1a-to-L1b handoff manifest does not exist.', { path: handoffPath });
  }

  add(
    'accepted_lifecycle',
    manifest.lifecycle?.status === 'accepted' && !manifest.lifecycle?.superseded_at,
    'Only a currently accepted, non-superseded L1a revision can enter L1b.',
    { lifecycle: manifest.lifecycle || null },
  );
  add(
    'accepted_review',
    manifest.review?.status === 'accepted' && Number(manifest.review?.revision) > 0,
    'The L1a researcher review must be accepted and revisioned.',
    { review: manifest.review || null },
  );
  add(
    'handoff_lifecycle',
    handoff?.status === 'accepted' && handoff?.ready === true && handoff?.superseded_at == null,
    'The handoff must be accepted, ready and non-superseded.',
    { status: handoff?.status ?? null, ready: handoff?.ready ?? null },
  );
  add(
    'handoff_contract_version',
    handoff?.contract_version === L1A_HANDOFF_CONTRACT_VERSION,
    'The handoff contract version must match the L1a-to-L1b gate.',
    { expected: L1A_HANDOFF_CONTRACT_VERSION, actual: handoff?.contract_version ?? null },
  );

  const recordingId = String(manifest.recording_id || '');
  add('recording_id_present', Boolean(recordingId), 'recording_id must be explicit in the accepted manifest.');
  add(
    'recording_id_source_explicit',
    manifest.recording_id_source === 'run_state.recording_id' && handoff?.recording_id_source === 'accepted_phase1_manifest',
    'recording_id must be carried from run state through the accepted manifest, never inferred from source_audio.',
    { manifest_source: manifest.recording_id_source ?? null, handoff_source: handoff?.recording_id_source ?? null },
  );
  add(
    'recording_id_consistent',
    Boolean(recordingId) && handoff?.recording_id === recordingId,
    'recording_id must remain stable between the accepted manifest and handoff.',
    { manifest: recordingId || null, handoff: handoff?.recording_id ?? null },
  );
  if (expectedRecordingId != null) {
    add('recording_id_expected', recordingId === String(expectedRecordingId), 'recording_id does not match the caller-selected L1a run.', {
      expected: String(expectedRecordingId), actual: recordingId,
    });
  }
  if (expectedRunId != null) {
    add('run_id_expected', handoff?.run_id === String(expectedRunId), 'run_id does not match the caller-selected L1a run.', {
      expected: String(expectedRunId), actual: handoff?.run_id ?? null,
    });
  }
  if (expectedSessionId != null) {
    add('session_id_expected', handoff?.session_id === String(expectedSessionId), 'session_id does not match the caller-selected processing session.', {
      expected: String(expectedSessionId), actual: handoff?.session_id ?? null,
    });
  }
  add(
    'identity_fields_consistent',
    Boolean(handoff)
      && handoff.session_id === manifest.session_id
      && handoff.review_revision === manifest.review?.revision
      && handoff.layer_revision === manifest.layer_revision,
    'Session and accepted review identities must match across the manifest and handoff.',
    {
      manifest_session_id: manifest.session_id ?? null,
      handoff_session_id: handoff?.session_id ?? null,
      manifest_review_revision: manifest.review?.revision ?? null,
      handoff_review_revision: handoff?.review_revision ?? null,
      manifest_layer_revision: manifest.layer_revision ?? null,
      handoff_layer_revision: handoff?.layer_revision ?? null,
    },
  );

  const sourceRecord = manifest.sealed_evidence?.source_wav || null;
  add('canonical_clock_declared', manifest.canonical_clock?.source === 'original_wav', 'The original WAV must be the canonical clock.');
  add(
    'canonical_clock_path',
    samePath(manifest.canonical_clock?.path, sourceRecord?.path),
    'The canonical clock must point to the sealed source WAV.',
  );
  let sourceActualSha = null;
  if (sourceRecord?.path && fs.existsSync(sourceRecord.path)) {
    sourceActualSha = sha256File(sourceRecord.path);
    add('source_wav_exists', true, 'The sealed source WAV exists.');
    add('source_wav_sha256', sourceActualSha === sourceRecord.sha256, 'The sealed source WAV hash must match.', {
      expected: sourceRecord.sha256, actual: sourceActualSha,
    });
    add('source_wav_bytes', fs.statSync(sourceRecord.path).size === sourceRecord.bytes, 'The sealed source WAV byte count must match.');
    try {
      const wav = readWavForMuting(sourceRecord.path);
      add(
        'canonical_duration_matches_wav',
        Math.abs(Number(manifest.duration_seconds) - wav.durationSeconds) <= 0.000001
          && Math.abs(Number(manifest.canonical_clock?.duration_seconds) - wav.durationSeconds) <= 0.000001,
        'Manifest duration and canonical clock must match the source WAV.',
        { wav: wav.durationSeconds, manifest: manifest.duration_seconds, canonical_clock: manifest.canonical_clock?.duration_seconds ?? null },
      );
    } catch (error) {
      add('canonical_duration_matches_wav', false, 'The canonical source WAV could not be parsed.', { error: error.message });
    }
  } else {
    add('source_wav_exists', false, 'The sealed source WAV does not exist.', { path: sourceRecord?.path ?? null });
  }
  add(
    'canonical_clock_sha256',
    Boolean(sourceActualSha)
      && manifest.canonical_clock?.sha256 === sourceActualSha
      && handoff?.canonical_clock?.sha256 === sourceActualSha,
    'Canonical clock hashes must match the sealed source WAV.',
  );

  const speakers = Array.isArray(manifest.speakers) ? manifest.speakers.map(String) : [];
  const expectedSpeakers = canonicalSpeakers(speakers.length);
  add('canonical_speaker_minimum', speakers.length >= 2, 'At least two accepted canonical speakers are required.');
  add(
    'canonical_speakers_contiguous_unique',
    speakers.length >= 2 && new Set(speakers).size === speakers.length && speakers.every((speaker, index) => speaker === expectedSpeakers[index]),
    'Canonical speakers must be the contiguous, unique sequence S1-SN.',
    { expected: expectedSpeakers, actual: speakers },
  );
  add(
    'handoff_speakers_consistent',
    JSON.stringify(handoff?.canonical_speakers || []) === JSON.stringify(speakers)
      && handoff?.dynamic_speaker_count === speakers.length
      && manifest.phase_ii_handoff?.dynamic_speaker_count === speakers.length,
    'Handoff speaker count and canonical S1-SN list must match the accepted manifest.',
  );

  let excludedCandidates = [];
  const reviewFlagsPath = manifest.outputs?.review_flags;
  if (reviewFlagsPath && fs.existsSync(reviewFlagsPath)) {
    try {
      excludedCandidates = readJson(reviewFlagsPath).excluded_candidates || [];
    } catch {
      excludedCandidates = [];
    }
  }
  const exclusionEvidence = manifest.excluded_candidate_evidence || null;
  const exclusionIntervals = Array.isArray(exclusionEvidence?.intervals) ? exclusionEvidence.intervals : [];
  const validExclusionIntervals = exclusionIntervals.every((item) => {
    const start = Number(item.start);
    const end = Number(item.end);
    return Number.isFinite(start) && Number.isFinite(end) && start >= 0
      && end > start && end <= Number(manifest.duration_seconds) + 0.000001;
  });
  add(
    'excluded_candidate_evidence',
    excludedCandidates.length === 0 || (
      exclusionEvidence?.schema_version === 'l1a-excluded-candidate-evidence-v1'
      && exclusionEvidence.policy === 'excluded_candidate_activity_is_x_in_l1b'
      && stableJson(exclusionEvidence.candidate_ids || []) === stableJson(excludedCandidates)
      && exclusionIntervals.length > 0
      && validExclusionIntervals
      && stableJson(handoff?.excluded_candidate_evidence || null) === stableJson(exclusionEvidence)
    ),
    'Excluded candidate activity must be retained as sealed x-label evidence for L1b.',
    { excluded_candidates: excludedCandidates, interval_count: exclusionIntervals.length },
  );

  const sealedRecords = [
    manifest.sealed_evidence?.accepted_review,
    ...(manifest.sealed_evidence?.artifacts || []),
  ].filter(Boolean);
  const sealedByRole = new Map();
  for (const record of manifest.sealed_evidence?.artifacts || []) {
    if (!sealedByRole.has(record.role)) sealedByRole.set(record.role, []);
    sealedByRole.get(record.role).push(record);
  }
  add(
    'sealed_roles_unique',
    [...sealedByRole.values()].every((records) => records.length === 1),
    'Every sealed artifact role must be unique.',
  );
  for (const record of sealedRecords) {
    const id = `sealed_${String(record.role || 'accepted_review').replace(/[^A-Za-z0-9_]+/g, '_')}`;
    if (!record.path || !fs.existsSync(record.path)) {
      add(id, false, 'A sealed L1a evidence file is missing.', { role: record.role || 'accepted_review', path: record.path || null });
      continue;
    }
    const actualSha = sha256File(record.path);
    add(
      id,
      actualSha === record.sha256 && fs.statSync(record.path).size === record.bytes,
      'A sealed L1a evidence file must match its recorded hash and byte count.',
      { role: record.role || 'accepted_review', path: record.path, expected_sha256: record.sha256, actual_sha256: actualSha },
    );
  }

  const requireRolePath = (role, file, message) => {
    const record = sealedByRole.get(role)?.[0];
    add(
      `required_${role}`,
      Boolean(file && record && samePath(file, record.path)),
      message,
      { role, output_path: file || null, sealed_path: record?.path || null },
    );
    return record || null;
  };
  requireRolePath('speaker_turns_csv', manifest.outputs?.speaker_turns_csv, 'The required speaker CSV must be present and sealed.');
  requireRolePath('rttm', manifest.outputs?.rttm, 'The required RTTM must be present and sealed.');
  requireRolePath('speaker_textgrid', manifest.outputs?.speaker_textgrid, 'The required speaker TextGrid must be present and sealed.');

  const mutedOutputs = Array.isArray(manifest.outputs?.muted_mirror_wavs) ? manifest.outputs.muted_mirror_wavs : [];
  const handoffInputs = Array.isArray(handoff?.inputs) ? handoff.inputs : [];
  add('muted_mirror_count', mutedOutputs.length === speakers.length, 'Exactly N muted-mirror WAV outputs are required.');
  add('handoff_input_count', handoffInputs.length === speakers.length, 'Exactly N speaker handoff inputs are required.');
  const l1bIdentityInputs = [];
  for (const speaker of speakers) {
    const outputSpeaker = `speaker_${speaker}`;
    const output = mutedOutputs.find((item) => item.speaker === outputSpeaker);
    const input = handoffInputs.find((item) => item.speaker === outputSpeaker);
    const wavRecord = requireRolePath(
      `${outputSpeaker}_muted_mirror_wav`,
      output?.muted_mirror_wav,
      `${outputSpeaker} muted-mirror WAV must be present and sealed.`,
    );
    const invalidRecord = requireRolePath(
      `${outputSpeaker}_invalid_intervals_tsv`,
      output?.invalid_intervals_tsv,
      `${outputSpeaker} invalid intervals TSV must be present and sealed.`,
    );
    add(
      `handoff_input_${speaker}`,
      Boolean(output && input
        && samePath(input.wav, output.muted_mirror_wav)
        && samePath(input.invalid_intervals_tsv, output.invalid_intervals_tsv)),
      `${outputSpeaker} handoff input must reference its sealed WAV and invalid TSV.`,
    );
    l1bIdentityInputs.push({
      speaker: outputSpeaker,
      wav_sha256: wavRecord?.sha256 ?? null,
      invalid_intervals_sha256: invalidRecord?.sha256 ?? null,
    });
  }

  const manifestActualSha = sha256File(resolvedManifest);
  add(
    'handoff_source_manifest',
    Boolean(handoff)
      && samePath(handoff.source_manifest, resolvedManifest)
      && handoff.source_manifest_sha256 === manifestActualSha,
    'The handoff must be sealed to the exact accepted phase1 manifest.',
    { expected_sha256: manifestActualSha, actual_sha256: handoff?.source_manifest_sha256 ?? null },
  );

  const layerRoot = findLayerRoot(resolvedManifest);
  const layerManifestPath = layerRoot ? path.join(layerRoot, 'layer_manifest.json') : null;
  const latestPath = layerRoot ? path.join(layerRoot, 'latest.json') : null;
  let layerManifest = null;
  let latest = null;
  if (layerManifestPath && fs.existsSync(layerManifestPath)) {
    try {
      layerManifest = readJson(layerManifestPath);
      add('layer_manifest_json_valid', true, 'The accepted L1a layer manifest is valid JSON.');
    } catch (error) {
      add('layer_manifest_json_valid', false, 'The accepted L1a layer manifest is not valid JSON.', { error: error.message });
    }
  }
  if (latestPath && fs.existsSync(latestPath)) {
    try {
      latest = readJson(latestPath);
      add('latest_pointer_json_valid', true, 'The L1a latest revision pointer is valid JSON.');
    } catch (error) {
      add('latest_pointer_json_valid', false, 'The L1a latest revision pointer is not valid JSON.', { error: error.message });
    }
  }
  add('layer_manifest_exists', Boolean(layerManifest), 'The accepted L1a layer manifest is required.');
  const expectedClientFiles = new Map([
    ['speaker_textgrid', manifest.outputs?.speaker_textgrid],
    ['speaker_turns_rttm', manifest.outputs?.rttm],
    ['speaker_turns_csv', manifest.outputs?.speaker_turns_csv],
    ...mutedOutputs.map((item) => [`${item.speaker}_muted_mirror_wav`, item.muted_mirror_wav]),
  ]);
  const clientDeliverables = Array.isArray(layerManifest?.client_deliverables) ? layerManifest.client_deliverables : [];
  add(
    'client_delivery_n_plus_3',
    clientDeliverables.length === speakers.length + 3
      && expectedClientFiles.size === speakers.length + 3
      && clientDeliverables.every((item) => expectedClientFiles.has(item.role)),
    'The customer download contract must contain only one TextGrid, one RTTM, one CSV and N muted-mirror WAVs.',
    { expected_count: speakers.length + 3, actual_count: clientDeliverables.length, roles: clientDeliverables.map((item) => item.role) },
  );
  for (const item of clientDeliverables) {
    const expectedFile = expectedClientFiles.get(item.role);
    const actualFile = layerRoot ? path.resolve(layerRoot, '..', item.relative_path) : null;
    add(
      `client_${String(item.role).replace(/[^A-Za-z0-9_]+/g, '_')}`,
      Boolean(expectedFile && actualFile && samePath(actualFile, expectedFile) && fs.existsSync(actualFile)
        && sha256File(actualFile) === item.sha256),
      'Each customer deliverable must point to the expected sealed L1a output and hash.',
      { role: item.role, expected_path: expectedFile || null, actual_path: actualFile },
    );
  }
  if (requireLatest) {
    add(
      'latest_revision_pointer',
      Boolean(latest)
        && latest.revision === manifest.layer_revision
        && samePath(latest.manifest, layerManifestPath)
        && layerManifest?.latest_revision === manifest.layer_revision
        && samePath(handoff?.source_manifest, resolvedManifest),
      'Only the revision referenced by L1a/latest.json can enter L1b.',
      { latest: latest || null, manifest_revision: manifest.layer_revision ?? null },
    );
  }

  const artifactIdentity = (manifest.sealed_evidence?.artifacts || [])
    .map((record) => ({ role: record.role, bytes: record.bytes, sha256: record.sha256 }))
    .sort((left, right) => left.role.localeCompare(right.role));
  const identityMaterial = {
    contract_version: L1A_HANDOFF_CONTRACT_VERSION,
    recording_id: recordingId,
    recording_id_source: 'accepted_phase1_manifest',
    run_id: handoff?.run_id ?? null,
    session_id: handoff?.session_id ?? null,
    layer_revision: manifest.layer_revision ?? null,
    review_revision: manifest.review?.revision ?? null,
    canonical_speakers: speakers,
    dynamic_speaker_count: speakers.length,
    canonical_duration_seconds: Number(manifest.duration_seconds),
    source_manifest_sha256: manifestActualSha,
    source_wav_sha256: sourceActualSha || sourceRecord?.sha256 || null,
    sealed_artifact_set_sha256: sha256Value(artifactIdentity),
    l1b_inputs: l1bIdentityInputs,
  };
  const identity = { ...identityMaterial, identity_sha256: sha256Value(identityMaterial) };
  if (requireStoredIdentity) {
    add(
      'stored_handoff_identity',
      Boolean(handoff?.sealed_handoff_identity)
        && handoff.sealed_handoff_identity.identity_sha256 === identity.identity_sha256
        && handoff.sealed_handoff_identity.contract_version === L1A_HANDOFF_CONTRACT_VERSION,
      'The stored handoff identity must match the gate-computed identity.',
      {
        expected: identity.identity_sha256,
        actual: handoff?.sealed_handoff_identity?.identity_sha256 ?? null,
      },
    );
  }

  return finish(assertions, identity, {
    manifest: resolvedManifest,
    handoff: handoffPath,
    layer_manifest: layerManifestPath,
    latest_pointer: latestPath,
  });
}

function parseArgs(argv) {
  const options = {};
  const fields = new Map([
    ['--manifest', 'manifestPath'],
    ['--recording-id', 'expectedRecordingId'],
    ['--run-id', 'expectedRunId'],
    ['--session-id', 'expectedSessionId'],
  ]);
  for (let index = 2; index < argv.length; index += 1) {
    if (argv[index] === '--allow-non-latest') {
      options.requireLatest = false;
      continue;
    }
    if (argv[index] === '--allow-missing-stored-identity') {
      options.requireStoredIdentity = false;
      continue;
    }
    const field = fields.get(argv[index]);
    if (!field || !argv[index + 1]) throw new Error(`Unknown or incomplete argument: ${argv[index]}`);
    options[field] = argv[index + 1];
    index += 1;
  }
  if (!options.manifestPath) throw new Error('--manifest is required');
  return options;
}

function main() {
  const result = assessL1aHandoff(parseArgs(process.argv));
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
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
