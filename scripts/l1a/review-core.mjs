import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  countOverlaps,
  groupIntervalsBySpeaker,
  invalidIntervalsForSpeaker,
  mergeIntervals,
  normalizeTurns,
  readWavForMuting,
  round,
  sanitizeName,
  writeJson,
  writeInvalidIntervalsTsv,
  writePhase1Artifacts,
} from '../phase1/lib/diarization-artifacts.mjs';
import {
  assessL1aHandoff,
  L1A_HANDOFF_CONTRACT_VERSION,
} from './handoff-gate.mjs';

export const L1A_REVIEW_SCHEMA = 'l1a-candidate-review-v1';
export const L1A_RUN_SCHEMA = 'l1a-run-v1';
export const L1A_CANDIDATE_SCHEMA = 'l1a-candidate-evidence-v1';
export const REVIEW_DECISIONS = ['include', 'exclude', 'uncertain', 'merge'];
export const REVIEW_ROLES = ['participant', 'other_or_incidental', 'uncertain', 'unspecified'];

function now() {
  return new Date().toISOString();
}

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

function safeRunId(value) {
  const id = sanitizeName(value);
  if (!id || id === 'unknown' || id !== value) throw new Error('Invalid L1a run id');
  return id;
}

function ensureInside(root, file) {
  const safeRoot = path.resolve(root);
  const resolved = path.resolve(file);
  if (resolved !== safeRoot && !resolved.startsWith(`${safeRoot}${path.sep}`)) {
    throw new Error('Resolved path is outside the authorized L1a root');
  }
  return resolved;
}

export function runDir(root, runId) {
  return ensureInside(root, path.join(root, safeRunId(runId)));
}

export function pathsForRun(root, runId) {
  const dir = runDir(root, runId);
  return {
    dir,
    inputDir: path.join(dir, 'input'),
    sourceAudio: path.join(dir, 'input', 'source.wav'),
    inputManifest: path.join(dir, 'input', 'input_manifest.json'),
    providerDir: path.join(dir, 'provider'),
    evidenceDir: path.join(dir, 'evidence'),
    reviewsDir: path.join(dir, 'reviews'),
    state: path.join(dir, 'run.json'),
    candidates: path.join(dir, 'evidence', 'candidates.json'),
    providerTurns: path.join(dir, 'evidence', 'provider_turns.json'),
    latestReview: path.join(dir, 'reviews', 'latest.json'),
    confirmedReview: path.join(dir, 'reviews', 'confirmed.json'),
    invalidation: path.join(dir, 'downstream-invalidation.json'),
  };
}

export function preflightWav(audioPath) {
  const wav = readWavForMuting(audioPath);
  let ffprobe = null;
  const probe = spawnSync('ffprobe', [
    '-v', 'error',
    '-select_streams', 'a:0',
    '-show_entries', 'stream=codec_name,codec_type,sample_rate,channels,bits_per_sample,duration',
    '-show_entries', 'format=duration',
    '-of', 'json',
    audioPath,
  ], { encoding: 'utf8' });
  if (probe.status === 0) {
    try { ffprobe = JSON.parse(probe.stdout); } catch { ffprobe = null; }
  }
  const stream = ffprobe?.streams?.[0] || null;
  return {
    status: 'passed',
    canonical_clock: 'original_wav',
    duration_seconds: round(wav.durationSeconds, 6),
    format: 'RIFF/WAVE',
    codec: stream?.codec_name || (wav.fmt.audioFormat === 1 ? 'pcm' : 'pcm_float'),
    sample_rate: Number(stream?.sample_rate) || wav.fmt.sampleRate,
    channels: Number(stream?.channels) || wav.fmt.channels,
    bits_per_sample: Number(stream?.bits_per_sample) || wav.fmt.bitsPerSample,
    probe_method: ffprobe ? 'ffprobe+wav_parser' : 'wav_parser_fallback',
  };
}

function writeState(file, patch) {
  const previous = fs.existsSync(file) ? readJson(file) : {};
  const next = { ...previous, ...patch, updated_at: now() };
  writeJson(file, next);
  return next;
}

export function createL1aRun({ root, filename, wavBuffer, runId = null, contentType = 'audio/wav' }) {
  const recordingId = sanitizeName(path.basename(filename || 'recording.wav', path.extname(filename || '')));
  const id = runId || `${recordingId}-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
  const paths = pathsForRun(root, id);
  fs.mkdirSync(paths.inputDir, { recursive: true });
  fs.mkdirSync(paths.providerDir, { recursive: true });
  fs.mkdirSync(paths.evidenceDir, { recursive: true });
  fs.mkdirSync(paths.reviewsDir, { recursive: true });
  fs.writeFileSync(paths.sourceAudio, wavBuffer);
  let preflight;
  try {
    preflight = preflightWav(paths.sourceAudio);
  } catch (error) {
    fs.rmSync(paths.dir, { recursive: true, force: true });
    throw error;
  }
  const managedInput = {
    schema_version: 'mwu-session-input-v1',
    run_id: id,
    session_id: id,
    original_filename: path.basename(filename || 'recording.wav'),
    stored_filename: 'source.wav',
    relative_path: `${id}/input/source.wav`,
    server_path: paths.sourceAudio,
    content_type: String(contentType || 'audio/wav'),
    bytes: fs.statSync(paths.sourceAudio).size,
    sha256: sha256File(paths.sourceAudio),
    uploaded_at: now(),
    canonical_clock: true,
  };
  writeJson(paths.inputManifest, managedInput);
  const state = writeState(paths.state, {
    schema_version: L1A_RUN_SCHEMA,
    run_id: id,
    session_id: id,
    recording_id: recordingId,
    original_filename: path.basename(filename || 'recording.wav'),
    managed_input: managedInput,
    created_at: now(),
    status: 'provider_pending',
    preflight,
    review_revision: 0,
    confirmed_revision: null,
    accepted_manifest: null,
    downstream_invalidated: false,
    error: null,
  });
  return { paths, state };
}

const CLIP_POLICY = Object.freeze({
  version: 'speaker-identification-clips-v2',
  maximum_clips: 3,
  target_window_seconds: 4,
  maximum_window_seconds: 5,
  minimum_preferred_seconds: 1,
  minimum_fallback_seconds: 0.25,
  overlap_margin_seconds: 0.12,
});

function representativeTurns(turns, allTurns, envelope, recordingDuration) {
  if (!turns.length) return [];
  const cleanSegments = turns.flatMap((turn) => cleanTurnSegments(turn, allTurns))
    .filter((segment) => segment.end - segment.start >= CLIP_POLICY.minimum_fallback_seconds);
  const source = cleanSegments.length
    ? cleanSegments.map((segment) => ({ ...segment, clean: true, overlap_seconds: 0 }))
    : turns.map((turn) => ({
      ...turn,
      clean: false,
      overlap_seconds: round(overlapUnionSeconds(turn, allTurns), 3),
    }));
  const scored = source.map((segment) => bestWindow(segment, envelope))
    .sort((left, right) => right.quality_score - left.quality_score
      || right.duration_seconds - left.duration_seconds
      || left.start - right.start);
  const selected = selectTemporallyDistinct(scored, recordingDuration, CLIP_POLICY.maximum_clips);
  return selected.map((clip, index) => ({
    ...clip,
    id: `best-${index + 1}-${Math.round(clip.start * 1000)}`,
    label: `Best ${index + 1}`,
    evidence_quality: clip.clean
      ? clip.quality_score >= 65 ? 'high_identification' : 'clean_best_available'
      : 'low_overlap_only',
    review_required: !clip.clean || clip.quality_score < 55,
    selection_policy: CLIP_POLICY.version,
  }));
}

function cleanTurnSegments(turn, allTurns) {
  const blocked = mergeIntervals(allTurns
    .filter((other) => other.speaker !== turn.speaker && other.end > turn.start && other.start < turn.end)
    .map((other) => ({
      start: Math.max(turn.start, other.start - CLIP_POLICY.overlap_margin_seconds),
      end: Math.min(turn.end, other.end + CLIP_POLICY.overlap_margin_seconds),
    })));
  let segments = [{ start: turn.start, end: turn.end, confidence: turn.confidence }];
  for (const block of blocked) {
    segments = segments.flatMap((segment) => {
      if (block.end <= segment.start || block.start >= segment.end) return [segment];
      return [
        { ...segment, end: Math.min(segment.end, block.start) },
        { ...segment, start: Math.max(segment.start, block.end) },
      ].filter((item) => item.end - item.start > 0.000001);
    });
  }
  return segments;
}

function overlapUnionSeconds(turn, allTurns) {
  return mergeIntervals(allTurns
    .filter((other) => other.speaker !== turn.speaker && other.end > turn.start && other.start < turn.end)
    .map((other) => ({ start: Math.max(turn.start, other.start), end: Math.min(turn.end, other.end) })))
    .reduce((sum, interval) => sum + interval.end - interval.start, 0);
}

function bestWindow(segment, envelope) {
  const duration = segment.end - segment.start;
  const windows = [];
  if (duration <= CLIP_POLICY.maximum_window_seconds) {
    windows.push({ start: segment.start, end: segment.end });
  } else {
    const width = CLIP_POLICY.target_window_seconds;
    for (let start = segment.start; start + width <= segment.end + 0.000001; start += 0.5) {
      windows.push({ start, end: Math.min(segment.end, start + width) });
    }
    const finalStart = segment.end - width;
    if (!windows.some((item) => Math.abs(item.start - finalStart) < 0.001)) {
      windows.push({ start: finalStart, end: segment.end });
    }
  }
  return windows.map((window) => scoreWindow({
    ...window,
    clean: segment.clean,
    confidence: segment.confidence,
    overlap_seconds: segment.overlap_seconds || 0,
  }, envelope))
    .sort((left, right) => right.quality_score - left.quality_score || left.start - right.start)[0];
}

function scoreWindow(window, envelope) {
  const duration = window.end - window.start;
  const frames = envelope?.frames?.filter((frame) => frame.end > window.start && frame.start < window.end) || [];
  const dbValues = frames.map((frame) => frame.dbfs).sort((left, right) => left - right);
  const medianDbfs = dbValues.length ? dbValues[Math.floor(dbValues.length / 2)] : null;
  const activeRatio = frames.length
    ? frames.filter((frame) => frame.dbfs >= envelope.activity_threshold_dbfs).length / frames.length
    : null;
  const clippingRatio = frames.length
    ? frames.reduce((sum, frame) => sum + frame.clipping_ratio, 0) / frames.length
    : 0;
  const meanDb = dbValues.length ? dbValues.reduce((sum, value) => sum + value, 0) / dbValues.length : null;
  const deviationDb = dbValues.length
    ? Math.sqrt(dbValues.reduce((sum, value) => sum + (value - meanDb) ** 2, 0) / dbValues.length)
    : null;
  const durationScore = clamp01((duration - CLIP_POLICY.minimum_fallback_seconds)
    / (2 - CLIP_POLICY.minimum_fallback_seconds));
  const energyScore = medianDbfs == null ? 0.5 : clamp01((medianDbfs - envelope.activity_threshold_dbfs + 4) / 16);
  const stabilityScore = deviationDb == null ? 0.5 : clamp01(1 - deviationDb / 18);
  const confidenceScore = Number.isFinite(Number(window.confidence)) ? clamp01(Number(window.confidence)) : 0.5;
  const score = 30 * (window.clean ? 1 : 0)
    + 25 * durationScore
    + 20 * (activeRatio ?? 0.5)
    + 15 * energyScore
    + 5 * stabilityScore
    + 5 * confidenceScore
    - 50 * Math.min(1, clippingRatio);
  return {
    start: round(window.start, 3),
    end: round(window.end, 3),
    duration_seconds: round(duration, 3),
    overlap_seconds: window.clean ? 0 : round(window.overlap_seconds || duration, 3),
    contains_overlap: !window.clean,
    clean: window.clean,
    quality_score: round(Math.max(0, Math.min(100, score)), 1),
    median_dbfs: medianDbfs == null ? null : round(medianDbfs, 1),
    active_frame_ratio: activeRatio == null ? null : round(activeRatio, 3),
    clipping_ratio: round(clippingRatio, 5),
    provider_confidence: Number.isFinite(Number(window.confidence)) ? round(Number(window.confidence), 4) : null,
  };
}

function selectTemporallyDistinct(ranked, duration, limit) {
  const selected = [];
  const minimumSeparation = Math.min(20, Math.max(2, duration * 0.05));
  for (const item of ranked) {
    const midpoint = (item.start + item.end) / 2;
    if (selected.every((prior) => Math.abs(midpoint - (prior.start + prior.end) / 2) >= minimumSeparation)) {
      selected.push(item);
      if (selected.length === limit) return selected;
    }
  }
  for (const item of ranked) {
    if (!selected.includes(item)) selected.push(item);
    if (selected.length === limit) break;
  }
  return selected;
}

function buildAudioEnvelope(audioPath) {
  if (!audioPath) return null;
  const wav = readWavForMuting(audioPath);
  const windowFrames = Math.max(1, Math.round(wav.fmt.sampleRate * 0.02));
  const sampleStride = Math.max(1, Math.floor(wav.fmt.sampleRate / 8000));
  const frames = [];
  for (let startFrame = 0; startFrame < wav.frameCount; startFrame += windowFrames) {
    const endFrame = Math.min(wav.frameCount, startFrame + windowFrames);
    let squared = 0;
    let count = 0;
    let clipped = 0;
    for (let frame = startFrame; frame < endFrame; frame += sampleStride) {
      for (let channel = 0; channel < wav.fmt.channels; channel += 1) {
        const sample = normalizedWavSample(wav, frame, channel);
        squared += sample * sample;
        if (Math.abs(sample) >= 0.995) clipped += 1;
        count += 1;
      }
    }
    const rms = count ? Math.sqrt(squared / count) : 0;
    frames.push({
      start: startFrame / wav.fmt.sampleRate,
      end: endFrame / wav.fmt.sampleRate,
      dbfs: 20 * Math.log10(Math.max(rms, 1e-8)),
      clipping_ratio: count ? clipped / count : 0,
    });
  }
  const levels = frames.map((frame) => frame.dbfs).sort((left, right) => left - right);
  const noiseFloor = levels.length ? levels[Math.floor(levels.length * 0.2)] : -80;
  const highLevel = levels.length ? levels[Math.floor(levels.length * 0.95)] : -30;
  const dynamicRange = highLevel - noiseFloor;
  const activityThreshold = dynamicRange < 8
    ? highLevel - 6
    : Math.max(-55, noiseFloor + 10, highLevel - 25);
  return {
    frames,
    noise_floor_dbfs: round(noiseFloor, 1),
    activity_threshold_dbfs: round(activityThreshold, 1),
  };
}

function normalizedWavSample(wav, frame, channel) {
  const offset = wav.data.start + frame * wav.frameBytes + channel * wav.bytesPerSample;
  if (wav.fmt.audioFormat === 3 && wav.fmt.bitsPerSample === 32) return wav.buffer.readFloatLE(offset);
  if (wav.fmt.bitsPerSample === 8) return (wav.buffer.readUInt8(offset) - 128) / 128;
  if (wav.fmt.bitsPerSample === 16) return wav.buffer.readInt16LE(offset) / 32768;
  if (wav.fmt.bitsPerSample === 24) {
    let value = wav.buffer.readUIntLE(offset, 3);
    if (value & 0x800000) value -= 0x1000000;
    return value / 8388608;
  }
  return wav.buffer.readInt32LE(offset) / 2147483648;
}

function clamp01(value) {
  return Math.max(0, Math.min(1, Number(value)));
}

export function buildCandidateEvidence({ runId, recordingId, turns, durationSeconds, audioPath = null }) {
  const normalized = normalizeTurns(turns, durationSeconds);
  const grouped = groupIntervalsBySpeaker(normalized);
  const envelope = buildAudioEnvelope(audioPath);
  const candidates = [...grouped.keys()].sort((left, right) => {
    const leftStart = grouped.get(left)?.[0]?.start ?? Number.POSITIVE_INFINITY;
    const rightStart = grouped.get(right)?.[0]?.start ?? Number.POSITIVE_INFINITY;
    return leftStart - rightStart || left.localeCompare(right);
  }).map((candidateId) => {
    const candidateTurns = normalized.filter((turn) => turn.speaker === candidateId);
    const intervals = grouped.get(candidateId) || [];
    const clips = representativeTurns(candidateTurns, normalized, envelope, durationSeconds).map((clip) => ({
      ...clip,
      audio_url: `/api/l1a/runs/${encodeURIComponent(runId)}/audio`,
    }));
    return {
      candidate_id: candidateId,
      provider_label: candidateId,
      active_seconds: round(intervals.reduce((sum, interval) => sum + interval.end - interval.start, 0), 3),
      interval_count: intervals.length,
      provider_turn_count: candidateTurns.length,
      evidence_quality: clips.some((clip) => clip.evidence_quality === 'clean_non_overlap')
        ? 'clean_non_overlap'
        : clips.some((clip) => !clip.contains_overlap) ? 'clean_non_overlap' : 'low_overlap_only',
      identification_quality: clips.some((clip) => clip.evidence_quality === 'high_identification')
        ? 'high' : clips.some((clip) => !clip.review_required) ? 'medium' : 'low',
      clips,
    };
  });
  return {
    schema_version: L1A_CANDIDATE_SCHEMA,
    generated_at: now(),
    run_id: runId,
    recording_id: recordingId,
    duration_seconds: round(durationSeconds, 6),
    candidate_count: candidates.length,
    overlap: countOverlaps(normalized),
    identity_boundary: 'Provider labels are acoustic clusters, not named people or research roles.',
    clip_selection_policy: CLIP_POLICY,
    audio_quality_reference: envelope ? {
      noise_floor_dbfs: envelope.noise_floor_dbfs,
      activity_threshold_dbfs: envelope.activity_threshold_dbfs,
    } : null,
    candidates,
  };
}

export function completeProviderRun({ root, runId, turns, provider = {} }) {
  const paths = pathsForRun(root, runId);
  const state = readJson(paths.state);
  const duration = Number(state.preflight?.duration_seconds);
  const normalized = normalizeTurns(turns, duration);
  if (!normalized.length) throw new Error('Provider returned no usable speaker turns');
  const evidence = buildCandidateEvidence({
    runId,
    recordingId: state.recording_id,
    turns: normalized,
    durationSeconds: duration,
    audioPath: paths.sourceAudio,
  });
  writeJson(paths.providerTurns, {
    source: provider.source || 'provider_diarization',
    model: provider.model || null,
    generated_at: now(),
    duration_seconds: duration,
    turns: normalized,
  });
  writeJson(paths.candidates, evidence);
  return writeState(paths.state, {
    status: 'candidate_review',
    candidate_count: evidence.candidate_count,
    provider: { source: provider.source || 'provider_diarization', model: provider.model || null },
    error: null,
  });
}

export function refreshCandidateEvidence({ root, runId }) {
  const paths = pathsForRun(root, runId);
  if (!fs.existsSync(paths.state) || !fs.existsSync(paths.providerTurns) || !fs.existsSync(paths.sourceAudio)) {
    throw new Error('Existing L1a source audio and provider turns are required to refresh candidate evidence');
  }
  const state = readJson(paths.state);
  const providerTurns = readJson(paths.providerTurns);
  const evidence = buildCandidateEvidence({
    runId,
    recordingId: state.recording_id,
    turns: providerTurns.turns || [],
    durationSeconds: Number(state.preflight?.duration_seconds),
    audioPath: paths.sourceAudio,
  });
  writeJson(paths.candidates, evidence);
  writeState(paths.state, {
    candidate_count: evidence.candidate_count,
    candidate_evidence_policy: CLIP_POLICY.version,
    candidate_evidence_refreshed_at: now(),
  });
  return evidence;
}

function canonicalNumber(value) {
  const match = /^S([1-9][0-9]*)$/.exec(String(value || ''));
  return match ? Number(match[1]) : null;
}

function normalizeDecision(candidate, input = {}) {
  const decision = REVIEW_DECISIONS.includes(input.decision) ? input.decision : 'uncertain';
  const role = REVIEW_ROLES.includes(input.role) ? input.role : 'unspecified';
  return {
    candidate_id: candidate.candidate_id,
    decision,
    role,
    canonical_speaker: decision === 'include' && canonicalNumber(input.canonical_speaker) ? String(input.canonical_speaker) : null,
    merge_into: decision === 'merge' ? String(input.merge_into || '') || null : null,
    note: String(input.note || '').slice(0, 1000),
  };
}

function reviewFingerprint(review) {
  const stable = review.decisions.map(({ candidate_id, decision, role, canonical_speaker, merge_into, note }) => ({
    candidate_id, decision, role, canonical_speaker, merge_into, note,
  }));
  return crypto.createHash('sha256').update(JSON.stringify(stable)).digest('hex');
}

function mappingFingerprint(review) {
  const stable = review.decisions.map(({ candidate_id, decision, canonical_speaker, merge_into }) => ({
    candidate_id, decision, canonical_speaker, merge_into,
  }));
  return crypto.createHash('sha256').update(JSON.stringify(stable)).digest('hex');
}

export function validateReviewDraft(candidatesEvidence, payload = {}) {
  const byId = new Map((payload.decisions || []).map((item) => [String(item.candidate_id), item]));
  const decisions = candidatesEvidence.candidates.map((candidate) => normalizeDecision(candidate, byId.get(candidate.candidate_id)));
  const candidateIds = new Set(candidatesEvidence.candidates.map((candidate) => candidate.candidate_id));
  const reviewer = String(payload.reviewer || '').trim().slice(0, 200);
  const errors = [];
  if (!reviewer) errors.push('Reviewer or rater ID is required');
  for (const decision of decisions) {
    if (decision.decision === 'merge') {
      if (!decision.merge_into || !candidateIds.has(decision.merge_into)) errors.push(`${decision.candidate_id}: merge target is missing`);
      if (decision.merge_into === decision.candidate_id) errors.push(`${decision.candidate_id}: cannot merge into itself`);
    }
  }
  return {
    schema_version: L1A_REVIEW_SCHEMA,
    run_id: candidatesEvidence.run_id,
    recording_id: candidatesEvidence.recording_id,
    reviewer,
    decisions,
    errors,
  };
}

function supersedeAcceptedOutputs(state, review) {
  const manifestPath = state.accepted_manifest;
  if (!manifestPath || !fs.existsSync(manifestPath)) return;
  const supersededAt = now();
  const manifest = readJson(manifestPath);
  manifest.lifecycle = {
    ...(manifest.lifecycle || {}),
    status: 'superseded',
    superseded_at: supersededAt,
    superseded_reason: 'accepted_candidate_mapping_changed',
    replacement_review_revision: review.revision,
  };
  manifest.phase_ii_handoff = {
    ...(manifest.phase_ii_handoff || {}),
    ready: false,
    review_status: 'superseded',
    superseded_at: supersededAt,
  };
  writeJsonAtomic(manifestPath, manifest);

  const handoffPath = manifest.outputs?.phase_ii_handoff_manifest;
  if (handoffPath && fs.existsSync(handoffPath)) {
    const handoff = readJson(handoffPath);
    writeJsonAtomic(handoffPath, {
      ...handoff,
      ready: false,
      status: 'superseded',
      superseded_at: supersededAt,
      superseded_reason: 'accepted_candidate_mapping_changed',
      replacement_review_revision: review.revision,
    });
  }
}

function confirmationErrors(review) {
  const errors = [...(review.errors || [])];
  const byId = new Map(review.decisions.map((item) => [item.candidate_id, item]));
  const includes = review.decisions.filter((item) => item.decision === 'include');
  if (includes.length < 2) errors.push('At least two included participant candidates are required');
  if (review.decisions.some((item) => item.decision === 'uncertain')) errors.push('Uncertain candidates must be resolved before confirmation');
  for (const item of review.decisions.filter((entry) => entry.decision === 'merge')) {
    const target = byId.get(item.merge_into);
    if (!target || target.decision !== 'include') errors.push(`${item.candidate_id}: merge target must be an included candidate`);
  }
  const canonical = includes.map((item) => item.canonical_speaker);
  if (canonical.some((value) => !canonicalNumber(value))) errors.push('Every included candidate requires a canonical S1-SN mapping');
  if (new Set(canonical).size !== canonical.length) errors.push('Canonical S1-SN mappings must be unique');
  const expected = includes.map((_, index) => `S${index + 1}`);
  const actual = [...canonical].sort((a, b) => canonicalNumber(a) - canonicalNumber(b));
  if (actual.join(',') !== expected.join(',')) errors.push(`Canonical mapping must be contiguous: ${expected.join(', ')}`);
  return [...new Set(errors)];
}

export function saveReviewDraft({ root, runId, payload }) {
  const paths = pathsForRun(root, runId);
  if (!fs.existsSync(paths.candidates)) throw new Error('Candidate evidence is not ready');
  const state = readJson(paths.state);
  const candidateEvidence = readJson(paths.candidates);
  const normalized = validateReviewDraft(candidateEvidence, payload);
  const revision = Number(state.review_revision || 0) + 1;
  const review = {
    ...normalized,
    revision,
    status: 'draft',
    created_at: now(),
    fingerprint: reviewFingerprint(normalized),
    mapping_fingerprint: mappingFingerprint(normalized),
  };
  fs.mkdirSync(paths.reviewsDir, { recursive: true });
  writeJson(path.join(paths.reviewsDir, `review-v${String(revision).padStart(4, '0')}.json`), review);
  writeJson(paths.latestReview, review);

  let invalidated = Boolean(state.downstream_invalidated);
  if (fs.existsSync(paths.confirmedReview)) {
    const confirmed = readJson(paths.confirmedReview);
    if ((confirmed.mapping_fingerprint || confirmed.fingerprint) !== review.mapping_fingerprint) {
      invalidated = true;
      supersedeAcceptedOutputs(state, review);
      writeJson(paths.invalidation, {
        schema_version: 'l1a-downstream-invalidation-v1',
        invalidated_at: now(),
        run_id: runId,
        previous_confirmed_revision: confirmed.revision,
        new_review_revision: revision,
        reason: 'accepted_candidate_mapping_changed',
      });
    }
  }
  writeState(paths.state, {
    status: 'candidate_review',
    review_revision: revision,
    downstream_invalidated: invalidated,
  });
  return review;
}

function reviewedTurns(providerTurns, review) {
  const byId = new Map(review.decisions.map((item) => [item.candidate_id, item]));
  const canonicalByCandidate = new Map();
  for (const item of review.decisions) {
    if (item.decision === 'include') canonicalByCandidate.set(item.candidate_id, item.canonical_speaker);
  }
  for (const item of review.decisions) {
    if (item.decision === 'merge') canonicalByCandidate.set(item.candidate_id, canonicalByCandidate.get(item.merge_into));
  }
  return providerTurns.turns
    .filter((turn) => ['include', 'merge'].includes(byId.get(turn.speaker)?.decision))
    .map((turn) => ({ ...turn, speaker: canonicalByCandidate.get(turn.speaker), source: providerTurns.source }));
}

function excludedTurns(providerTurns, review) {
  const excluded = new Set(review.decisions.filter((item) => item.decision === 'exclude').map((item) => item.candidate_id));
  return providerTurns.turns.filter((turn) => excluded.has(turn.speaker));
}

export function confirmReview({ root, acceptedRoot, runId }) {
  const paths = pathsForRun(root, runId);
  if (!fs.existsSync(paths.latestReview)) throw new Error('Accepted review data is not available for confirmation');
  const state = readJson(paths.state);
  const review = readJson(paths.latestReview);
  const errors = confirmationErrors(review);
  if (errors.length) {
    const error = new Error(errors.join('; '));
    error.validationErrors = errors;
    throw error;
  }
  const providerTurns = readJson(paths.providerTurns);
  const turns = reviewedTurns(providerTurns, review);
  const excludedEvidence = excludedTurns(providerTurns, review);
  const sessionId = state.session_id || runId;
  const revisionId = `review-v${String(review.revision).padStart(4, '0')}`;
  const sessionRoot = ensureInside(acceptedRoot, path.join(acceptedRoot, 'sessions', sessionId));
  const sessionInputDir = path.join(sessionRoot, 'input');
  const sessionSourceAudio = path.join(sessionInputDir, 'source.wav');
  const sessionInputManifest = path.join(sessionInputDir, 'input_manifest.json');
  const layerRoot = path.join(sessionRoot, 'L1a');
  const acceptedDir = path.join(layerRoot, 'revisions', revisionId, 'outputs');
  if (fs.existsSync(acceptedDir)) throw new Error(`L1a ${revisionId} is already sealed; save a new review revision before rebuilding`);
  fs.mkdirSync(sessionInputDir, { recursive: true });
  if (path.resolve(paths.sourceAudio) !== path.resolve(sessionSourceAudio)) {
    fs.copyFileSync(paths.sourceAudio, sessionSourceAudio);
  }
  writeJsonAtomic(sessionInputManifest, {
    schema_version: 'mwu-session-input-v1',
    run_id: runId,
    session_id: sessionId,
    original_filename: state.original_filename,
    stored_filename: 'source.wav',
    relative_path: 'input/source.wav',
    server_path: sessionSourceAudio,
    content_type: state.managed_input?.content_type || 'audio/wav',
    bytes: fs.statSync(sessionSourceAudio).size,
    sha256: sha256File(sessionSourceAudio),
    uploaded_at: state.managed_input?.uploaded_at || state.created_at,
    canonical_clock: true,
  });
  fs.mkdirSync(acceptedDir, { recursive: true });
  const { manifestPath, manifest } = writePhase1Artifacts({
    turns,
    audioPath: sessionSourceAudio,
    outDir: acceptedDir,
    prefix: `${state.recording_id}.reviewed`,
    source: 'researcher_reviewed_provider_diarization',
    method: {
      name: 'l1a_candidate_review_and_canonical_mapping',
      provider: state.provider?.source || 'provider_diarization',
      provider_model: state.provider?.model || null,
      review_schema: L1A_REVIEW_SCHEMA,
      review_revision: review.revision,
      identity_boundary: 'Acoustic clusters were retained, excluded or merged by the researcher before canonical S1-SN mapping.',
      muted_mirror_boundary: 'Muted-mirror WAVs preserve the room mix only inside retained intervals; they are not clean source separation.',
    },
    durationSeconds: state.preflight.duration_seconds,
  });
  const invalidEvidenceTurns = [
    ...turns,
    ...excludedEvidence.map((turn) => ({ ...turn, speaker: `EXCLUDED_${turn.speaker}` })),
  ];
  const excludedCandidateIntervals = mergeIntervals(
    excludedEvidence.map((turn) => ({ start: turn.start, end: turn.end })),
  );
  for (const output of manifest.outputs.muted_mirror_wavs || []) {
    const canonical = String(output.speaker).replace(/^speaker_/, '');
    const invalid = invalidIntervalsForSpeaker(invalidEvidenceTurns, canonical);
    writeInvalidIntervalsTsv(output.invalid_intervals_tsv, invalid);
    output.invalid_seconds = round(invalid.reduce((sum, interval) => sum + interval.end - interval.start, 0), 3);
  }
  const acceptedReview = { ...review, status: 'accepted', confirmed_at: now() };
  const acceptedReviewPath = path.join(acceptedDir, 'candidate_review.accepted.json');
  const evidenceSummaryPath = path.join(acceptedDir, 'provider_evidence_summary.json');
  const flagsPath = path.join(acceptedDir, 'review_flags.json');
  const handoffPath = path.join(acceptedDir, 'phase2_handoff_manifest.json');
  const layerManifestPath = path.join(layerRoot, 'layer_manifest.json');
  const latestPointerPath = path.join(layerRoot, 'latest.json');
  writeJson(acceptedReviewPath, acceptedReview);
  writeJson(evidenceSummaryPath, {
    schema_version: 'l1a-provider-evidence-summary-v1',
    run_id: runId,
    source_provider: state.provider,
    candidate_count: review.decisions.length,
    included_count: review.decisions.filter((item) => item.decision === 'include').length,
    merged_count: review.decisions.filter((item) => item.decision === 'merge').length,
    excluded_count: review.decisions.filter((item) => item.decision === 'exclude').length,
    overlap: manifest.overlap,
    candidate_evidence: paths.candidates,
    provider_turns: paths.providerTurns,
  });
  writeJson(flagsPath, {
    schema_version: 'l1a-review-flags-v1',
    run_id: runId,
    unresolved_candidates: [],
    overlap_review_required: manifest.overlap.count > 0,
    overlap: manifest.overlap,
    excluded_candidates: review.decisions.filter((item) => item.decision === 'exclude').map((item) => item.candidate_id),
    merged_candidates: review.decisions.filter((item) => item.decision === 'merge').map((item) => ({ candidate_id: item.candidate_id, merge_into: item.merge_into })),
  });
  manifest.review = {
    status: 'accepted',
    schema_version: L1A_REVIEW_SCHEMA,
    revision: review.revision,
    fingerprint: review.fingerprint,
    mapping_fingerprint: review.mapping_fingerprint,
    accepted_record: acceptedReviewPath,
  };
  manifest.outputs.provider_evidence_summary = evidenceSummaryPath;
  manifest.outputs.review_flags = flagsPath;
  manifest.outputs.phase_ii_handoff_manifest = handoffPath;
  manifest.session_id = sessionId;
  manifest.layer = 'L1a';
  manifest.layer_revision = revisionId;
  manifest.recording_id = state.recording_id;
  manifest.recording_id_source = 'run_state.recording_id';
  manifest.lifecycle = {
    status: 'accepted',
    accepted_at: acceptedReview.confirmed_at,
    superseded_at: null,
  };
  manifest.phase_ii_handoff.review_status = 'accepted';
  manifest.phase_ii_handoff.review_revision = review.revision;
  manifest.phase_ii_handoff.dynamic_speaker_count = manifest.speakers.length;
  manifest.excluded_candidate_evidence = {
    schema_version: 'l1a-excluded-candidate-evidence-v1',
    policy: 'excluded_candidate_activity_is_x_in_l1b',
    candidate_ids: review.decisions
      .filter((item) => item.decision === 'exclude')
      .map((item) => item.candidate_id),
    source_turn_count: excludedEvidence.length,
    intervals: excludedCandidateIntervals,
  };
  manifest.phase_ii_handoff.excluded_candidate_evidence = manifest.excluded_candidate_evidence;
  const sealedArtifacts = [
    ['speaker_turns_json', manifest.outputs.speaker_turns_json],
    ['speaker_turns_csv', manifest.outputs.speaker_turns_csv],
    ['rttm', manifest.outputs.rttm],
    ['speaker_textgrid', manifest.outputs.speaker_textgrid],
    ['provider_evidence_summary', evidenceSummaryPath],
    ['review_flags', flagsPath],
    ...(manifest.outputs.muted_mirror_wavs || []).flatMap((output) => [
      [`${output.speaker}_muted_mirror_wav`, output.muted_mirror_wav],
      [`${output.speaker}_invalid_intervals_tsv`, output.invalid_intervals_tsv],
    ]),
  ].map(([role, file]) => ({
    role,
    path: file,
    bytes: fs.statSync(file).size,
    sha256: sha256File(file),
  }));
  manifest.sealed_evidence = {
    schema_version: 'l1a-sealed-evidence-v1',
    source_wav: {
      path: sessionSourceAudio,
      bytes: fs.statSync(sessionSourceAudio).size,
      sha256: sha256File(sessionSourceAudio),
    },
    accepted_review: {
      path: acceptedReviewPath,
      bytes: fs.statSync(acceptedReviewPath).size,
      sha256: sha256File(acceptedReviewPath),
    },
    artifacts: sealedArtifacts,
  };
  manifest.canonical_clock = {
    source: 'original_wav',
    path: sessionSourceAudio,
    duration_seconds: state.preflight.duration_seconds,
    sha256: manifest.sealed_evidence.source_wav.sha256,
  };
  writeJsonAtomic(manifestPath, manifest);
  const manifestSha256 = sha256File(manifestPath);
  writeJsonAtomic(handoffPath, {
    schema_version: 'l1a-to-l1b-handoff-v1',
    contract_version: L1A_HANDOFF_CONTRACT_VERSION,
    generated_at: now(),
    run_id: runId,
    session_id: sessionId,
    source_layer: 'L1a',
    target_layer: 'L1b',
    status: 'accepted',
    recording_id: state.recording_id,
    recording_id_source: 'accepted_phase1_manifest',
    source_manifest: manifestPath,
    review_revision: review.revision,
    layer_revision: revisionId,
    canonical_speakers: manifest.speakers,
    dynamic_speaker_count: manifest.speakers.length,
    duration_seconds: manifest.duration_seconds,
    canonical_clock: manifest.canonical_clock,
    ready: true,
    inputs: manifest.phase_ii_handoff.inputs,
    excluded_candidate_evidence: manifest.excluded_candidate_evidence,
    source_manifest_sha256: manifestSha256,
    sealed_evidence: manifest.sealed_evidence,
    layer_manifest: layerManifestPath,
    current_revision_pointer: latestPointerPath,
  });
  const clientDeliverables = [
    ['speaker_textgrid', manifest.outputs.speaker_textgrid],
    ['speaker_turns_rttm', manifest.outputs.rttm],
    ['speaker_turns_csv', manifest.outputs.speaker_turns_csv],
    ...(manifest.outputs.muted_mirror_wavs || []).map((output) => [`${output.speaker}_muted_mirror_wav`, output.muted_mirror_wav]),
  ].map(([role, file]) => ({
    role,
    name: path.basename(file),
    relative_path: path.relative(sessionRoot, file),
    bytes: fs.statSync(file).size,
    sha256: sha256File(file),
  }));
  writeJsonAtomic(layerManifestPath, {
    schema_version: 'mwu-layer-output-index-v1',
    generated_at: now(),
    session_id: sessionId,
    recording_id: state.recording_id,
    layer: 'L1a',
    status: 'accepted',
    latest_revision: revisionId,
    revision_output_dir: path.relative(sessionRoot, acceptedDir),
    client_delivery_contract: 'l1a-poc-n-plus-3-v1',
    client_deliverables: clientDeliverables,
    internal_evidence: {
      phase1_manifest: path.relative(sessionRoot, manifestPath),
      candidate_review: path.relative(sessionRoot, acceptedReviewPath),
      provider_evidence_summary: path.relative(sessionRoot, evidenceSummaryPath),
      review_flags: path.relative(sessionRoot, flagsPath),
    },
    next_layer_input: {
      layer: 'L1b',
      kind: 'l1a-to-l1b-handoff-v1',
      path: path.relative(sessionRoot, handoffPath),
      ready: true,
    },
  });
  const sessionManifestPath = path.join(sessionRoot, 'session_manifest.json');
  const previousSession = fs.existsSync(sessionManifestPath) ? readJson(sessionManifestPath) : {};
  writeJsonAtomic(sessionManifestPath, {
    schema_version: 'mwu-processing-session-v1',
    session_id: sessionId,
    recording_id: state.recording_id,
    source_filename: state.original_filename,
    canonical_duration_seconds: state.preflight.duration_seconds,
    input: {
      source_wav: 'input/source.wav',
      manifest: 'input/input_manifest.json',
      sha256: state.managed_input?.sha256 || manifest.sealed_evidence.source_wav.sha256,
      bytes: state.managed_input?.bytes || manifest.sealed_evidence.source_wav.bytes,
    },
    created_at: previousSession.created_at || state.created_at || now(),
    updated_at: now(),
    layer_order: ['L1a', 'L1b', 'L2', 'L3'],
    layers: {
      L1a: { status: 'accepted', latest_revision: revisionId, manifest: path.relative(sessionRoot, layerManifestPath) },
      L1b: previousSession.layers?.L1b || { status: 'not_started', input_from: 'L1a.next_layer_input' },
      L2: previousSession.layers?.L2 || { status: 'not_started', input_from: 'L1b.next_layer_input' },
      L3: previousSession.layers?.L3 || { status: 'not_started', input_from: 'L2.next_layer_input' },
    },
  });
  writeJsonAtomic(latestPointerPath, {
    schema_version: 'mwu-layer-latest-pointer-v1',
    session_id: sessionId,
    layer: 'L1a',
    revision: revisionId,
    manifest: layerManifestPath,
    output_dir: acceptedDir,
  });
  const preliminaryGate = assessL1aHandoff({ manifestPath, requireStoredIdentity: false });
  if (!preliminaryGate.passed || !preliminaryGate.sealed_handoff_identity) {
    const handoff = readJson(handoffPath);
    writeJsonAtomic(handoffPath, {
      ...handoff,
      status: 'blocked',
      ready: false,
      gate_blockers: preliminaryGate.blockers,
    });
    throw new Error(`L1a handoff gate failed: ${preliminaryGate.blockers.map((item) => item.code).join(', ')}`);
  }
  const handoff = readJson(handoffPath);
  writeJsonAtomic(handoffPath, {
    ...handoff,
    sealed_handoff_identity: preliminaryGate.sealed_handoff_identity,
  });
  const finalGate = assessL1aHandoff({ manifestPath });
  if (!finalGate.passed) {
    writeJsonAtomic(handoffPath, {
      ...readJson(handoffPath),
      status: 'blocked',
      ready: false,
      gate_blockers: finalGate.blockers,
    });
    throw new Error(`L1a handoff gate failed: ${finalGate.blockers.map((item) => item.code).join(', ')}`);
  }
  writeJson(paths.confirmedReview, acceptedReview);
  fs.rmSync(paths.invalidation, { force: true });
  const nextState = writeState(paths.state, {
    status: 'accepted',
    confirmed_revision: review.revision,
    session_id: sessionId,
    session_manifest: sessionManifestPath,
    layer_manifest: layerManifestPath,
    accepted_manifest: manifestPath,
    accepted_dir: acceptedDir,
    downstream_invalidated: false,
  });
  return { state: nextState, review: acceptedReview, manifest, manifestPath, acceptedDir, handoff_gate: finalGate };
}

export function verifySealedManifest(manifestPath) {
  const gate = assessL1aHandoff({ manifestPath });
  const manifest = fs.existsSync(manifestPath) ? readJson(manifestPath) : null;
  return {
    ok: gate.passed,
    contract_version: gate.contract_version,
    gate_version: gate.gate_version,
    manifest_path: path.resolve(manifestPath),
    checked_records: manifest
      ? 2 + (manifest.sealed_evidence?.artifacts || []).length
      : 0,
    failures: gate.blockers.map((item) => ({
      reason: item.code,
      message: item.message,
      details: item.details,
    })),
    assertions: gate.assertions,
    sealed_handoff_identity: gate.sealed_handoff_identity,
  };
}

export function getRunSnapshot({ root, runId }) {
  const paths = pathsForRun(root, runId);
  if (!fs.existsSync(paths.state)) return null;
  const state = readJson(paths.state);
  return {
    state,
    candidates: fs.existsSync(paths.candidates) ? readJson(paths.candidates) : null,
    review: fs.existsSync(paths.latestReview) ? readJson(paths.latestReview) : null,
    confirmed_review: fs.existsSync(paths.confirmedReview) ? readJson(paths.confirmedReview) : null,
    invalidation: fs.existsSync(paths.invalidation) ? readJson(paths.invalidation) : null,
    layer_manifest: state.layer_manifest && fs.existsSync(state.layer_manifest) ? readJson(state.layer_manifest) : null,
  };
}

export function listL1aReviewRuns(root) {
  if (!fs.existsSync(root)) return [];
  return fs.readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => getRunSnapshot({ root, runId: entry.name }))
    .filter(Boolean)
    .map((snapshot) => snapshot.state)
    .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
}

export function setRunFailure({ root, runId, error }) {
  const paths = pathsForRun(root, runId);
  return writeState(paths.state, { status: 'failed', error: String(error?.message || error) });
}

export function setRunStatus({ root, runId, status, patch = {} }) {
  const paths = pathsForRun(root, runId);
  return writeState(paths.state, { status, ...patch });
}

export function resolveRunAudio({ root, runId }) {
  const paths = pathsForRun(root, runId);
  if (!fs.existsSync(paths.sourceAudio)) throw new Error('L1a source audio is not available');
  return paths.sourceAudio;
}

export function resolveAcceptedArtifact({ root, runId, relativePath }) {
  const snapshot = getRunSnapshot({ root, runId });
  const acceptedDir = snapshot?.state?.accepted_dir;
  if (!acceptedDir) throw new Error('L1a accepted artifacts are not ready');
  const file = ensureInside(acceptedDir, path.join(acceptedDir, String(relativePath || '')));
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) throw new Error('Artifact not found');
  return file;
}

export function artifactIndex(snapshot) {
  const manifestPath = snapshot?.state?.accepted_manifest;
  if (!manifestPath || !fs.existsSync(manifestPath)) return [];
  const manifest = readJson(manifestPath);
  const files = [
    manifest.outputs?.speaker_turns_json,
    manifest.outputs?.speaker_turns_csv,
    manifest.outputs?.rttm,
    manifest.outputs?.speaker_textgrid,
    manifest.outputs?.provider_evidence_summary,
    manifest.outputs?.review_flags,
    manifest.outputs?.phase_ii_handoff_manifest,
    manifest.review?.accepted_record,
    ...(manifest.outputs?.muted_mirror_wavs || []).flatMap((item) => [item.muted_mirror_wav, item.invalid_intervals_tsv]),
    manifestPath,
  ].filter(Boolean);
  const clientFiles = new Set([
    manifest.outputs?.speaker_turns_csv,
    manifest.outputs?.rttm,
    manifest.outputs?.speaker_textgrid,
    ...(manifest.outputs?.muted_mirror_wavs || []).map((item) => item.muted_mirror_wav),
  ].filter(Boolean));
  return files.map((file) => ({
    name: path.basename(file),
    relative_path: path.relative(snapshot.state.accepted_dir, file),
    bytes: fs.statSync(file).size,
    kind: path.extname(file).replace('.', '').toLowerCase() || 'file',
    client_delivery: clientFiles.has(file),
  }));
}
