import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import {
  defaultVadOptions,
  estimateThreshold,
  prepareLocalAcousticVad,
} from '../../local-acoustic-vad.mjs';
import { EPSILON, canonicalSpeakers, round } from '../core/contracts.mjs';

export const SPEAKER_ACOUSTIC_SUPPORT_VERSION = 'speaker-conditioned-acoustic-support-v1';

export function buildSpeakerAcousticSupport({
  manifestFile,
  mappingFile,
  vadOptions = {},
}) {
  const manifest = readJson(manifestFile);
  const mappingDocument = readJson(mappingFile);
  const pyannoteMapping = mappingDocument.mapping?.pyannote || mappingDocument.pyannote;
  if (!pyannoteMapping || typeof pyannoteMapping !== 'object') {
    throw new Error('pyannote canonical speaker mapping is required');
  }
  const speakers = canonicalSpeakers(mappingDocument.speakers || Object.values(pyannoteMapping));
  const turnsFile = resolveManifestPath(manifestFile, manifest.outputs?.speaker_turns_json);
  const turnsDocument = readJson(turnsFile);
  const providerTurns = Array.isArray(turnsDocument.turns) ? turnsDocument.turns : [];
  const mirrors = manifest.outputs?.muted_mirror_wavs;
  if (!Array.isArray(mirrors) || mirrors.length === 0) throw new Error('muted-mirror WAV entries are required');

  const options = {
    ...defaultVadOptions(),
    minSoundingSeconds: 0.08,
    minSilenceSeconds: 0,
    padSoundingSeconds: 0,
    ...vadOptions,
  };
  const bySpeaker = Object.fromEntries(speakers.map((speaker) => [speaker, []]));
  const providerByCanonical = Object.fromEntries(speakers.map((speaker) => [speaker, []]));
  const boundaryFramesBySpeaker = Object.fromEntries(speakers.map((speaker) => [speaker, []]));
  for (const turn of providerTurns) {
    const canonical = pyannoteMapping[String(turn.speaker)];
    if (!speakers.includes(canonical)) continue;
    const start = Number(turn.start);
    const end = Number(turn.end);
    if (end > start + EPSILON) providerByCanonical[canonical].push({
      id: `pyannote_turn_${String(turn.index ?? turn.id ?? providerByCanonical[canonical].length + 1)}`,
      provider_speaker: String(turn.speaker),
      start: round(start, 6),
      end: round(end, 6),
    });
  }
  for (const speaker of speakers) providerByCanonical[speaker] = mergeIntervals(providerByCanonical[speaker]);

  const speakerRecords = [];
  for (const mirror of mirrors) {
    const providerSpeaker = normalizeMirrorSpeaker(mirror.speaker);
    const canonical = pyannoteMapping[providerSpeaker];
    if (!speakers.includes(canonical)) throw new Error(`muted mirror has no canonical mapping: ${providerSpeaker}`);
    const wavFile = resolveManifestPath(manifestFile, mirror.muted_mirror_wav);
    const prepared = prepareLocalAcousticVad(wavFile, options);
    boundaryFramesBySpeaker[canonical] = prepared.frames.map((frame) => ({
      start: Number(frame.start),
      end: Number(frame.end),
      db: Number(frame.db),
    }));
    const vad = computeTurnConditionedVad(prepared, providerByCanonical[canonical], options);
    const rawSounding = vad.sounding;
    const clipped = intersectIntervals(rawSounding, providerByCanonical[canonical]).map((interval) => ({
      start: round(interval.start, 6),
      end: round(interval.end, 6),
      provider_turn_id: interval.provider_turn_id,
      acoustic_source: 'muted_mirror_local_vad',
    }));
    bySpeaker[canonical] = mergeIntervals([...bySpeaker[canonical], ...clipped]);
    speakerRecords.push({
      canonical_speaker: canonical,
      provider_speaker: providerSpeaker,
      muted_mirror: fileRecord(wavFile),
      provider_turn_count: providerByCanonical[canonical].length,
      raw_vad_sounding_count: rawSounding.length,
      clipped_sounding_count: clipped.length,
      clipped_sounding_seconds: round(clipped.reduce((sum, item) => sum + item.end - item.start, 0), 6),
      threshold_dbfs: vad.threshold.thresholdDb,
      threshold_controller: vad.threshold.controller,
    });
  }
  assertClippedToOwnTurns(bySpeaker, providerByCanonical, speakers);
  const result = {
    contract_version: SPEAKER_ACOUSTIC_SUPPORT_VERSION,
    runtime_gold_access: false,
    network_used: false,
    source_separation_claim: false,
    speakers,
    usage_boundary: 'activity support and semantic expansion only; never move or cross provider turn boundaries',
    vad_options: options,
    by_speaker: bySpeaker,
    provider_turns_by_speaker: providerByCanonical,
    speaker_records: speakerRecords.sort((left, right) => left.canonical_speaker.localeCompare(right.canonical_speaker)),
    inputs: {
      manifest: fileRecord(manifestFile),
      mapping: fileRecord(mappingFile),
      turns: fileRecord(turnsFile),
    },
  };
  Object.defineProperty(result, 'boundary_frames_by_speaker', {
    value: boundaryFramesBySpeaker,
    enumerable: false,
    writable: false,
  });
  return result;
}

function computeTurnConditionedVad(prepared, turns, options) {
  const eligibleFrames = prepared.frames.filter((frame) => turns.some((turn) => {
    const mid = (frame.start + frame.end) / 2;
    return mid >= turn.start - EPSILON && mid < turn.end + EPSILON;
  }));
  if (eligibleFrames.length === 0) throw new Error('speaker track has no frames inside provider turns');
  const threshold = estimateThreshold(eligibleFrames.map((frame) => frame.db), options);
  const thresholdOn = threshold.thresholdDb;
  const thresholdOff = threshold.thresholdDb - Number(options.hysteresisDb);
  const sounding = [];
  for (const turn of turns) {
    const frames = prepared.frames.filter((frame) => frame.end > turn.start + EPSILON && frame.start < turn.end - EPSILON);
    let active = false;
    let start = null;
    for (const frame of frames) {
      if (!active && frame.db >= thresholdOn) {
        active = true;
        start = Math.max(turn.start, frame.start);
      } else if (active && frame.db < thresholdOff) {
        const end = Math.min(turn.end, frame.end);
        if (end - start >= Number(options.minSoundingSeconds) - EPSILON) sounding.push({ start, end });
        active = false;
        start = null;
      }
    }
    if (active && start != null) {
      const end = Math.min(turn.end, frames.at(-1)?.end ?? turn.end);
      if (end - start >= Number(options.minSoundingSeconds) - EPSILON) sounding.push({ start, end });
    }
  }
  return { sounding, threshold };
}

export function assertClippedToOwnTurns(bySpeaker, providerTurnsBySpeaker, requestedSpeakers = null) {
  const speakers = canonicalSpeakers(requestedSpeakers || Object.keys(bySpeaker || {}));
  for (const speaker of speakers) {
    for (const interval of bySpeaker[speaker] || []) {
      const contained = (providerTurnsBySpeaker[speaker] || []).some((turn) =>
        interval.start >= turn.start - EPSILON && interval.end <= turn.end + EPSILON);
      if (!contained) throw new Error(`${speaker} acoustic support crosses its provider turn boundary`);
    }
  }
  return true;
}

function intersectIntervals(leftIntervals, turns) {
  const output = [];
  for (const left of normalizeIntervals(leftIntervals)) {
    for (const turn of turns) {
      if (turn.end <= left.start + EPSILON) continue;
      if (turn.start >= left.end - EPSILON) break;
      const start = Math.max(left.start, turn.start);
      const end = Math.min(left.end, turn.end);
      if (end > start + EPSILON) output.push({ start, end, provider_turn_id: turn.id });
    }
  }
  return output;
}

function mergeIntervals(intervals) {
  const output = [];
  for (const interval of normalizeIntervals(intervals)) {
    const previous = output[output.length - 1];
    if (previous && interval.start <= previous.end + EPSILON) previous.end = Math.max(previous.end, interval.end);
    else output.push({ ...interval });
  }
  return output.map((interval) => ({ ...interval, start: round(interval.start, 6), end: round(interval.end, 6) }));
}

function normalizeIntervals(intervals) {
  return (intervals || []).map((item) => ({
    ...item,
    start: Number(item.start),
    end: Number(item.end),
  })).filter((item) => Number.isFinite(item.start) && Number.isFinite(item.end) && item.end > item.start + EPSILON)
    .sort((left, right) => left.start - right.start || left.end - right.end);
}

function normalizeMirrorSpeaker(value) {
  return String(value || '').replace(/^speaker_/, '');
}

function resolveManifestPath(manifestFile, value) {
  if (!value) throw new Error('manifest output path is missing');
  return path.isAbsolute(value) ? value : path.resolve(path.dirname(manifestFile), value);
}

function fileRecord(file) {
  const bytes = readFileSync(file);
  return {
    name: path.basename(file),
    sha256: createHash('sha256').update(bytes).digest('hex'),
    bytes: bytes.length,
  };
}

function readJson(file) {
  return JSON.parse(readFileSync(file, 'utf8'));
}
