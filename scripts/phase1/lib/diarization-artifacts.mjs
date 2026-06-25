import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { basename, extname, resolve } from 'node:path';

export const EPSILON_SECONDS = 0.000001;

export function round(value, digits = 6) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

export function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

export function sanitizeName(value) {
  return String(value ?? 'unknown').replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^_+|_+$/g, '') || 'unknown';
}

export function ensureDir(dir) {
  mkdirSync(dir, { recursive: true });
}

export function readJson(file) {
  return JSON.parse(readFileSync(file, 'utf8'));
}

export function writeJson(file, value) {
  ensureDir(path.dirname(file));
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

export function csvCell(value) {
  const text = String(value ?? '');
  if (!/[",\n\r]/.test(text)) return text;
  return `"${text.replaceAll('"', '""')}"`;
}

export function secondsFromMs(ms) {
  return Number(ms) / 1000;
}

export function readWavForMuting(audioPath) {
  const resolved = resolve(audioPath);
  if (!existsSync(resolved)) throw new Error(`Audio file does not exist: ${resolved}`);

  const buffer = readFileSync(resolved);
  if (buffer.toString('ascii', 0, 4) !== 'RIFF' || buffer.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error(`Only RIFF/WAVE files are supported: ${resolved}`);
  }

  let offset = 12;
  let fmt = null;
  let data = null;
  while (offset + 8 <= buffer.length) {
    const chunkId = buffer.toString('ascii', offset, offset + 4);
    const chunkSize = buffer.readUInt32LE(offset + 4);
    const chunkStart = offset + 8;
    const chunkEnd = chunkStart + chunkSize;

    if (chunkId === 'fmt ') {
      fmt = {
        audioFormat: buffer.readUInt16LE(chunkStart),
        channels: buffer.readUInt16LE(chunkStart + 2),
        sampleRate: buffer.readUInt32LE(chunkStart + 4),
        bitsPerSample: buffer.readUInt16LE(chunkStart + 14),
      };
    } else if (chunkId === 'data') {
      data = { start: chunkStart, end: chunkEnd, size: chunkSize };
    }

    offset = chunkEnd + (chunkSize % 2);
  }

  if (!fmt) throw new Error(`WAV fmt chunk not found: ${resolved}`);
  if (!data) throw new Error(`WAV data chunk not found: ${resolved}`);
  if (![1, 3].includes(fmt.audioFormat)) {
    throw new Error(`Only PCM or IEEE float WAV is supported. audioFormat=${fmt.audioFormat}`);
  }
  if (![8, 16, 24, 32].includes(fmt.bitsPerSample)) {
    throw new Error(`Unsupported bitsPerSample=${fmt.bitsPerSample}`);
  }
  if (fmt.channels < 1) throw new Error('WAV must have at least one channel');

  const bytesPerSample = fmt.bitsPerSample / 8;
  const frameBytes = bytesPerSample * fmt.channels;
  const frameCount = Math.floor(data.size / frameBytes);
  return {
    path: resolved,
    buffer,
    fmt,
    data,
    bytesPerSample,
    frameBytes,
    frameCount,
    durationSeconds: frameCount / fmt.sampleRate,
  };
}

export function normalizeTurns(turns, duration) {
  return turns
    .map((turn, index) => {
      const rawStart = Number(turn.start ?? turn.start_sec ?? turn.start_seconds);
      const rawEnd = Number(turn.end ?? turn.end_sec ?? turn.end_seconds);
      const start = clamp(rawStart, 0, duration);
      const end = clamp(rawEnd, 0, duration);
      return {
        index: Number.isFinite(Number(turn.index)) ? Number(turn.index) : index,
        speaker: turn.speaker == null ? '' : String(turn.speaker).replace(/^speaker_/, ''),
        start,
        end,
        confidence: Number(turn.confidence),
        text: turn.text ?? '',
        source: turn.source ?? null,
      };
    })
    .filter((turn) => turn.speaker && turn.end - turn.start > EPSILON_SECONDS)
    .sort((a, b) => a.start - b.start || a.end - b.end || a.index - b.index);
}

export function turnsFromAssemblyAi(result, duration) {
  const utterances = Array.isArray(result.utterances) ? result.utterances : [];
  return normalizeTurns(
    utterances.map((utterance, index) => ({
      index,
      speaker: utterance.speaker,
      start: secondsFromMs(utterance.start),
      end: secondsFromMs(utterance.end),
      confidence: utterance.confidence,
      text: utterance.text ?? '',
      source: 'assemblyai',
    })),
    duration,
  );
}

export function turnsFromPyannoteJson(value, duration) {
  const turns = Array.isArray(value) ? value : Array.isArray(value.turns) ? value.turns : [];
  return normalizeTurns(
    turns.map((turn, index) => ({
      index,
      speaker: turn.speaker ?? turn.label,
      start: turn.start,
      end: turn.end,
      confidence: turn.confidence,
      text: turn.text ?? '',
      source: turn.source ?? 'pyannote',
    })),
    duration,
  );
}

export function parseRttm(text, duration = Number.POSITIVE_INFINITY) {
  const turns = [];
  for (const [lineIndex, rawLine] of text.split(/\r?\n/).entries()) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const fields = line.split(/\s+/);
    if (fields[0] !== 'SPEAKER' || fields.length < 8) {
      throw new Error(`Invalid RTTM line ${lineIndex + 1}: ${rawLine}`);
    }
    const start = Number(fields[3]);
    const dur = Number(fields[4]);
    if (!Number.isFinite(start) || !Number.isFinite(dur) || dur < 0) {
      throw new Error(`Invalid RTTM timing at line ${lineIndex + 1}: ${rawLine}`);
    }
    turns.push({
      index: turns.length,
      speaker: fields[7],
      start,
      end: start + dur,
      confidence: Number.NaN,
      text: '',
      source: 'rttm',
    });
  }
  return normalizeTurns(turns, duration);
}

export function renderRttm(turns, fileId = 'audio') {
  return turns
    .map((turn) => {
      const speaker = sanitizeName(turn.speaker);
      const dur = Math.max(0, turn.end - turn.start);
      return `SPEAKER ${sanitizeName(fileId)} 1 ${round(turn.start, 6).toFixed(6)} ${round(dur, 6).toFixed(6)} <NA> <NA> ${speaker} <NA> <NA>`;
    })
    .join('\n') + '\n';
}

export function mergeIntervals(intervals) {
  const sorted = intervals
    .filter((interval) => interval.end - interval.start > EPSILON_SECONDS)
    .sort((a, b) => a.start - b.start || a.end - b.end);
  const merged = [];

  for (const interval of sorted) {
    const previous = merged[merged.length - 1];
    if (previous && interval.start <= previous.end + EPSILON_SECONDS) {
      previous.end = Math.max(previous.end, interval.end);
    } else {
      merged.push({ ...interval });
    }
  }

  return merged.map((interval) => ({ start: round(interval.start), end: round(interval.end) }));
}

export function groupIntervalsBySpeaker(turns) {
  const groups = new Map();
  for (const turn of turns) {
    if (!groups.has(turn.speaker)) groups.set(turn.speaker, []);
    groups.get(turn.speaker).push({ start: turn.start, end: turn.end });
  }

  return new Map([...groups.entries()].map(([speaker, intervals]) => [speaker, mergeIntervals(intervals)]));
}

export function countOverlaps(turns) {
  let count = 0;
  let seconds = 0;
  for (let i = 0; i < turns.length; i += 1) {
    for (let j = i + 1; j < turns.length; j += 1) {
      if (turns[j].start >= turns[i].end) break;
      if (turns[i].speaker === turns[j].speaker) continue;
      const start = Math.max(turns[i].start, turns[j].start);
      const end = Math.min(turns[i].end, turns[j].end);
      if (end > start + EPSILON_SECONDS) {
        count += 1;
        seconds += end - start;
      }
    }
  }
  return { count, seconds: round(seconds, 3) };
}

export function invalidIntervalsForSpeaker(turns, targetSpeaker) {
  return mergeIntervals(
    turns
      .filter((turn) => turn.speaker !== targetSpeaker)
      .map((turn) => ({ start: turn.start, end: turn.end })),
  );
}

function intervalMask(frameCount, sampleRate, intervals) {
  const mask = new Uint8Array(frameCount);
  for (const interval of intervals) {
    const startFrame = clamp(Math.floor(interval.start * sampleRate), 0, frameCount);
    const endFrame = clamp(Math.ceil(interval.end * sampleRate), 0, frameCount);
    for (let frame = startFrame; frame < endFrame; frame += 1) {
      mask[frame] = 1;
    }
  }
  return mask;
}

function writeSilenceFrame(buffer, offset, fmt, bytesPerSample) {
  for (let channel = 0; channel < fmt.channels; channel += 1) {
    const sampleOffset = offset + channel * bytesPerSample;
    if (fmt.audioFormat === 1 && fmt.bitsPerSample === 8) {
      buffer.writeUInt8(128, sampleOffset);
    } else {
      buffer.fill(0, sampleOffset, sampleOffset + bytesPerSample);
    }
  }
}

export function writeMutedMirrorWav(wav, intervals, outputPath) {
  const mask = intervalMask(wav.frameCount, wav.fmt.sampleRate, intervals);
  const outputBuffer = Buffer.from(wav.buffer);

  for (let frame = 0; frame < wav.frameCount; frame += 1) {
    if (mask[frame]) continue;
    const frameOffset = wav.data.start + frame * wav.frameBytes;
    writeSilenceFrame(outputBuffer, frameOffset, wav.fmt, wav.bytesPerSample);
  }

  writeFileSync(outputPath, outputBuffer);
}

export function writeSpeakerTurnsCsv(outputPath, turns) {
  const rows = [
    ['index', 'speaker', 'start_sec', 'end_sec', 'duration_sec', 'confidence', 'text'],
    ...turns.map((turn, index) => [
      index + 1,
      `speaker_${turn.speaker}`,
      round(turn.start, 3).toFixed(3),
      round(turn.end, 3).toFixed(3),
      round(turn.end - turn.start, 3).toFixed(3),
      Number.isFinite(turn.confidence) ? round(turn.confidence, 4).toFixed(4) : '',
      turn.text,
    ]),
  ];
  writeFileSync(outputPath, `${rows.map((row) => row.map(csvCell).join(',')).join('\n')}\n`, 'utf8');
}

export function writeInvalidIntervalsTsv(outputPath, intervals) {
  const lines = intervals.map((interval) => `${round(interval.start, 6).toFixed(6)}\t${round(interval.end, 6).toFixed(6)}`);
  writeFileSync(outputPath, `${lines.join('\n')}${lines.length ? '\n' : ''}`, 'utf8');
}

function escapeTextGridText(value) {
  return String(value ?? '').replace(/\r?\n/g, ' ').replaceAll('"', '""').trim();
}

function formatTime(seconds) {
  const normalized = Math.abs(seconds) < EPSILON_SECONDS ? 0 : seconds;
  return normalized.toFixed(6);
}

export function buildSpeakerTimelineIntervals(duration, turns) {
  const boundaries = new Set(['0.000000', duration.toFixed(6)]);
  for (const turn of turns) {
    boundaries.add(clamp(turn.start, 0, duration).toFixed(6));
    boundaries.add(clamp(turn.end, 0, duration).toFixed(6));
  }
  const sorted = [...boundaries].map(Number).sort((a, b) => a - b);
  const intervals = [];

  for (let i = 0; i < sorted.length - 1; i += 1) {
    const start = sorted[i];
    const end = sorted[i + 1];
    if (end <= start + EPSILON_SECONDS) continue;
    const mid = (start + end) / 2;
    const active = turns
      .filter((turn) => turn.start <= mid && mid < turn.end)
      .map((turn) => `speaker_${turn.speaker}`)
      .sort();
    intervals.push({
      start: round(start),
      end: round(end),
      text: active.length > 1 ? `overlap:${active.join('+')}` : active[0] ?? '',
    });
  }

  return intervals;
}

export function renderSpeakerTextGrid(duration, turns, tierName = 'speaker') {
  const intervals = buildSpeakerTimelineIntervals(duration, turns);
  const lines = [
    'File type = "ooTextFile"',
    'Object class = "TextGrid"',
    '',
    'xmin = 0',
    `xmax = ${formatTime(duration)}`,
    'tiers? <exists>',
    'size = 1',
    'item []:',
    '    item [1]:',
    '        class = "IntervalTier"',
    `        name = "${escapeTextGridText(tierName)}"`,
    '        xmin = 0',
    `        xmax = ${formatTime(duration)}`,
    `        intervals: size = ${intervals.length}`,
  ];
  intervals.forEach((interval, index) => {
    lines.push(
      `        intervals [${index + 1}]:`,
      `            xmin = ${formatTime(interval.start)}`,
      `            xmax = ${formatTime(interval.end)}`,
      `            text = "${escapeTextGridText(interval.text)}"`,
    );
  });
  lines.push('');
  return lines.join('\n');
}

export function writePhase1Artifacts({ turns, audioPath, outDir, prefix, source, method, durationSeconds = null }) {
  const resolvedAudio = resolve(audioPath);
  const wav = readWavForMuting(resolvedAudio);
  const duration = durationSeconds ?? wav.durationSeconds;
  const normalizedTurns = normalizeTurns(turns, duration);
  const speakerIntervals = groupIntervalsBySpeaker(normalizedTurns);
  const speakers = [...speakerIntervals.keys()].sort();
  const safePrefix = sanitizeName(prefix || basename(resolvedAudio, extname(resolvedAudio)));
  ensureDir(outDir);

  const turnsJsonPath = path.join(outDir, `${safePrefix}.speaker_turns.json`);
  const turnsCsvPath = path.join(outDir, `${safePrefix}.speaker_turns.csv`);
  const rttmPath = path.join(outDir, `${safePrefix}.speaker_turns.rttm`);
  const speakerTextGridPath = path.join(outDir, `${safePrefix}.speaker_tier.TextGrid`);
  writeJson(turnsJsonPath, {
    source,
    duration_seconds: round(duration, 6),
    speakers,
    turns: normalizedTurns.map((turn, index) => ({
      index: index + 1,
      speaker: turn.speaker,
      start: round(turn.start, 6),
      end: round(turn.end, 6),
      confidence: Number.isFinite(turn.confidence) ? round(turn.confidence, 6) : null,
      text: turn.text,
    })),
  });
  writeSpeakerTurnsCsv(turnsCsvPath, normalizedTurns);
  writeFileSync(rttmPath, renderRttm(normalizedTurns, safePrefix), 'utf8');
  writeFileSync(speakerTextGridPath, renderSpeakerTextGrid(duration, normalizedTurns), 'utf8');

  const mutedOutputs = [];
  for (const speaker of speakers) {
    const safeSpeaker = sanitizeName(`speaker_${speaker}`);
    const intervals = speakerIntervals.get(speaker);
    const mutedMirrorPath = path.join(outDir, `${safePrefix}.${safeSpeaker}.muted_mirror.wav`);
    const invalidIntervalsPath = path.join(outDir, `${safePrefix}.${safeSpeaker}.invalid_intervals.tsv`);
    const invalidIntervals = invalidIntervalsForSpeaker(normalizedTurns, speaker);
    writeMutedMirrorWav(wav, intervals, mutedMirrorPath);
    writeInvalidIntervalsTsv(invalidIntervalsPath, invalidIntervals);
    mutedOutputs.push({
      speaker: `speaker_${speaker}`,
      muted_mirror_wav: mutedMirrorPath,
      invalid_intervals_tsv: invalidIntervalsPath,
      interval_count: intervals.length,
      active_seconds: round(intervals.reduce((total, interval) => total + interval.end - interval.start, 0), 3),
      invalid_seconds: round(invalidIntervals.reduce((total, interval) => total + interval.end - interval.start, 0), 3),
    });
  }

  const manifest = {
    generated_at: new Date().toISOString(),
    source,
    source_audio: resolvedAudio,
    duration_seconds: round(duration, 6),
    wav: {
      sample_rate: wav.fmt.sampleRate,
      channels: wav.fmt.channels,
      bits_per_sample: wav.fmt.bitsPerSample,
      audio_format: wav.fmt.audioFormat,
    },
    method,
    utterance_count: normalizedTurns.length,
    speakers,
    overlap: countOverlaps(normalizedTurns),
    phase_ii_handoff: {
      ready: mutedOutputs.length > 0,
      contract:
        'For each speaker, Phase II uses muted_mirror_wav as the WAV input and invalid_intervals_tsv as the optional invalid-path input to scripts/validation-sprint/praat/silences.praat.',
      expected_labels: ['sounding', 'silent', 'invalid'],
      inputs: mutedOutputs.map((output) => ({
        speaker: output.speaker,
        wav: output.muted_mirror_wav,
        invalid_intervals_tsv: output.invalid_intervals_tsv,
      })),
    },
    outputs: {
      speaker_turns_json: turnsJsonPath,
      speaker_turns_csv: turnsCsvPath,
      rttm: rttmPath,
      speaker_textgrid: speakerTextGridPath,
      muted_mirror_wavs: mutedOutputs,
    },
  };
  const manifestPath = path.join(outDir, `${safePrefix}.phase1_manifest.json`);
  writeJson(manifestPath, manifest);

  return { manifestPath, manifest, turns: normalizedTurns };
}

function activeSetAt(turns, time, mapping = null) {
  const active = turns
    .filter((turn) => turn.start <= time && time < turn.end)
    .map((turn) => {
      const raw = String(turn.speaker);
      return mapping?.[raw] ?? raw;
    })
    .sort();
  return active;
}

function setKey(values) {
  return values.length ? values.join('+') : '';
}

function uniqueSpeakers(turns) {
  return [...new Set(turns.map((turn) => turn.speaker).filter(Boolean))].sort();
}

function permutations(values) {
  if (values.length <= 1) return [values];
  const out = [];
  for (let i = 0; i < values.length; i += 1) {
    const rest = values.slice(0, i).concat(values.slice(i + 1));
    for (const perm of permutations(rest)) out.push([values[i], ...perm]);
  }
  return out;
}

function bestSpeakerMapping(referenceTurns, candidateTurns, duration, frameSeconds) {
  const refSpeakers = uniqueSpeakers(referenceTurns);
  const candSpeakers = uniqueSpeakers(candidateTurns);
  if (candSpeakers.length === 0 || refSpeakers.length === 0) return {};

  const allTargets = refSpeakers.length >= candSpeakers.length
    ? permutations(refSpeakers).map((perm) => perm.slice(0, candSpeakers.length))
    : permutations(candSpeakers).map(() => refSpeakers);
  let best = { score: -1, mapping: {} };

  for (const targets of allTargets) {
    const mapping = {};
    candSpeakers.forEach((speaker, index) => {
      mapping[speaker] = targets[index] ?? speaker;
    });
    let score = 0;
    for (let t = frameSeconds / 2; t < duration; t += frameSeconds) {
      const ref = activeSetAt(referenceTurns, t);
      const cand = activeSetAt(candidateTurns, t, mapping);
      if (ref.length === 1 && cand.length === 1 && ref[0] === cand[0]) score += frameSeconds;
    }
    if (score > best.score) best = { score, mapping };
  }

  return best.mapping;
}

function nearestDistances(source, target) {
  const targetBoundaries = target.flatMap((turn) => [turn.start, turn.end]).sort((a, b) => a - b);
  if (!targetBoundaries.length) return [];
  return source
    .flatMap((turn) => [turn.start, turn.end])
    .map((boundary) => Math.min(...targetBoundaries.map((other) => Math.abs(boundary - other))));
}

function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

export function compareDiarizations(referenceTurns, candidateTurns, { duration, frameMs = 100 } = {}) {
  const frameSeconds = frameMs / 1000;
  const mapping = bestSpeakerMapping(referenceTurns, candidateTurns, duration, frameSeconds);
  let frames = 0;
  let exact = 0;
  let activityAgree = 0;
  let bothSpeech = 0;
  let bothSpeechSpeakerAgree = 0;
  let referenceOnly = 0;
  let candidateOnly = 0;
  let speakerMismatch = 0;

  for (let t = frameSeconds / 2; t < duration; t += frameSeconds) {
    frames += 1;
    const ref = activeSetAt(referenceTurns, t);
    const cand = activeSetAt(candidateTurns, t, mapping);
    const refSpeech = ref.length > 0;
    const candSpeech = cand.length > 0;
    if (refSpeech === candSpeech) activityAgree += 1;
    if (setKey(ref) === setKey(cand)) exact += 1;
    if (refSpeech && candSpeech) {
      bothSpeech += 1;
      if (setKey(ref) === setKey(cand)) bothSpeechSpeakerAgree += 1;
      else speakerMismatch += 1;
    } else if (refSpeech && !candSpeech) referenceOnly += 1;
    else if (!refSpeech && candSpeech) candidateOnly += 1;
  }

  const refBoundaryDistances = nearestDistances(referenceTurns, candidateTurns);
  const candBoundaryDistances = nearestDistances(candidateTurns, referenceTurns);
  const sumDur = (turns) => mergeIntervals(turns.map((turn) => ({ start: turn.start, end: turn.end })))
    .reduce((total, interval) => total + interval.end - interval.start, 0);

  return {
    note: 'This is system-vs-system agreement, not accuracy against human gold. Use the client gold speaker-isolation output for final validation.',
    duration_seconds: round(duration, 6),
    frame_ms: frameMs,
    mapping_candidate_to_reference: mapping,
    reference: {
      speaker_count: uniqueSpeakers(referenceTurns).length,
      speakers: uniqueSpeakers(referenceTurns),
      turn_count: referenceTurns.length,
      active_seconds: round(sumDur(referenceTurns), 3),
      overlap: countOverlaps(referenceTurns),
    },
    candidate: {
      speaker_count: uniqueSpeakers(candidateTurns).length,
      speakers: uniqueSpeakers(candidateTurns),
      turn_count: candidateTurns.length,
      active_seconds: round(sumDur(candidateTurns), 3),
      overlap: countOverlaps(candidateTurns),
    },
    agreement: {
      frames,
      exact_label_frame_agreement: round(frames ? exact / frames : 0, 6),
      speech_activity_agreement: round(frames ? activityAgree / frames : 0, 6),
      speaker_agreement_when_both_speech: round(bothSpeech ? bothSpeechSpeakerAgree / bothSpeech : 0, 6),
      reference_only_seconds: round(referenceOnly * frameSeconds, 3),
      candidate_only_seconds: round(candidateOnly * frameSeconds, 3),
      speaker_mismatch_seconds: round(speakerMismatch * frameSeconds, 3),
    },
    boundary_distance_seconds: {
      reference_to_candidate_median: median(refBoundaryDistances) == null ? null : round(median(refBoundaryDistances), 3),
      candidate_to_reference_median: median(candBoundaryDistances) == null ? null : round(median(candBoundaryDistances), 3),
      reference_to_candidate_mean: refBoundaryDistances.length
        ? round(refBoundaryDistances.reduce((a, b) => a + b, 0) / refBoundaryDistances.length, 3)
        : null,
      candidate_to_reference_mean: candBoundaryDistances.length
        ? round(candBoundaryDistances.reduce((a, b) => a + b, 0) / candBoundaryDistances.length, 3)
        : null,
    },
  };
}

export function renderDiarizationComparisonMarkdown(report) {
  const lines = [
    '# Phase I Diarization Comparison',
    '',
    '> This is system-vs-system agreement, not a human-gold accuracy claim.',
    '',
    '## Summary',
    '',
    `- Duration: ${report.duration_seconds}s`,
    `- Frame size: ${report.frame_ms} ms`,
    `- Reference speakers: ${report.reference.speakers.join(', ')}`,
    `- Candidate speakers: ${report.candidate.speakers.join(', ')}`,
    `- Mapping candidate -> reference: ${
      Object.entries(report.mapping_candidate_to_reference).map(([key, value]) => `${key}->${value}`).join(', ') || 'n/a'
    }`,
    '',
    '## Agreement',
    '',
    `- Exact label frame agreement: ${(report.agreement.exact_label_frame_agreement * 100).toFixed(2)}%`,
    `- Speech activity agreement: ${(report.agreement.speech_activity_agreement * 100).toFixed(2)}%`,
    `- Speaker agreement when both have speech: ${(report.agreement.speaker_agreement_when_both_speech * 100).toFixed(2)}%`,
    `- Reference-only seconds: ${report.agreement.reference_only_seconds}`,
    `- Candidate-only seconds: ${report.agreement.candidate_only_seconds}`,
    `- Speaker mismatch seconds: ${report.agreement.speaker_mismatch_seconds}`,
    '',
    '## Boundary Distance',
    '',
    `- Reference -> candidate median: ${report.boundary_distance_seconds.reference_to_candidate_median}`,
    `- Candidate -> reference median: ${report.boundary_distance_seconds.candidate_to_reference_median}`,
    `- Reference -> candidate mean: ${report.boundary_distance_seconds.reference_to_candidate_mean}`,
    `- Candidate -> reference mean: ${report.boundary_distance_seconds.candidate_to_reference_mean}`,
    '',
    '## Method Boundary',
    '',
    report.note,
    '',
  ];
  return lines.join('\n');
}
