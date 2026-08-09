export const SYNTHETIC_MAPPING = Object.freeze({
  pyannote: Object.freeze({ voice_alpha: 'S1', voice_beta: 'S2', voice_gamma: 'S3' }),
  assemblyai: Object.freeze({ channel_red: 'S1', channel_green: 'S2', channel_blue: 'S3' }),
});

export function vocal(id, speaker, start, end, tokens = ['sample'], extra = {}) {
  return {
    id,
    speaker,
    start,
    end,
    confidence: 0.91,
    provisional_kind: 'vocalisation',
    lexical_class: 'lexical',
    tokens,
    ...extra,
  };
}

export function artifact(id, speaker, start, end, extra = {}) {
  return {
    id,
    speaker,
    start,
    end,
    confidence: 0.82,
    provisional_kind: 'artifact',
    lexical_class: 'nonlexical',
    tokens: [],
    ...extra,
  };
}

export function laughter(id, speaker, start, end, extra = {}) {
  return {
    id,
    speaker,
    start,
    end,
    confidence: 0.78,
    provisional_kind: 'laughter',
    lexical_class: 'nonlexical',
    tokens: [],
    ...extra,
  };
}

export function syntheticPipelineInput() {
  return {
    recordingId: 'synthetic-group-01',
    taskId: 'synthetic-task-01',
    duration: 5,
    thresholds: [0.25, 0.35],
    speakerMapping: SYNTHETIC_MAPPING,
    attributionTurns: [
      { id: 'turn-a1', speaker: 'voice_alpha', start: 0.2, end: 1.5, confidence: 0.92 },
      { id: 'turn-b1', speaker: 'voice_beta', start: 0.4, end: 0.55, confidence: 0.85 },
      { id: 'turn-c1', speaker: 'voice_gamma', start: 1.2, end: 1.35, confidence: null },
      { id: 'turn-b2', speaker: 'voice_beta', start: 1.35, end: 2.2, confidence: 0.89 },
      { id: 'turn-c2', speaker: 'voice_gamma', start: 2.7, end: 3.3, confidence: 0.88 },
    ],
    words: [
      { id: 'word-a', speaker: 'channel_red', start: 0.25, end: 0.5, confidence: 0.93 },
      { id: 'word-b', speaker: 'channel_green', start: 1.4, end: 1.7, confidence: 0.9 },
      { id: 'word-c', speaker: 'channel_blue', start: 2.75, end: 3.0, confidence: 0.87 },
      { id: 'word-unresolved', speaker: 'channel_red', start: 4.1, end: 4.2, confidence: null },
    ],
    roomSoundingIntervals: [
      { start: 0.2, end: 1.0 },
      { start: 1.1, end: 2.2 },
      { start: 2.3, end: 2.4 },
      { start: 2.7, end: 3.3 },
    ],
    stage1Evidence: [
      vocal('evt-a1', 'S1', 0.2, 1.0, ['opening']),
      vocal('evt-bc', 'S2', 0.4, 0.55, ['yeah']),
      vocal('evt-a2', 'S1', 1.1, 1.25, ['um'], { lexical_class: 'filled_pause' }),
      vocal('evt-c-bid', 'S3', 1.2, 1.35, ['well', 'i']),
      vocal('evt-a3', 'S1', 1.25, 1.5, ['continue']),
      vocal('evt-b2', 'S2', 1.35, 2.2, ['but', 'respond']),
      artifact('evt-c-noise', 'S3', 2.3, 2.4),
      vocal('evt-c2', 'S3', 2.7, 3.3, ['next']),
    ],
    interactionConfig: {
      overlapMode: 'path_a_candidate',
      floorReleaseSeconds: 1,
      minOverlapSeconds: 0.1,
    },
    legacyBoundarySeed: { enabled: false },
  };
}
