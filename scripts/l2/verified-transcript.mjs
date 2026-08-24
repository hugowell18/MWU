import { round } from "../textgrid-utils.mjs";
import { normalizeToken } from "./feasibility-core.mjs";

const SPEAKER_LINE = /^([A-Za-z][A-Za-z0-9_ .'-]{0,30}):\s*(.*)$/;
const ANNOTATION_TAG = /\[([A-Za-z0-9_-]+)\]/g;
const KNOWN_TAGS = new Set(["bc", "x"]);

function naturalSpeakerSort(left, right) {
  return Number(left.slice(1)) - Number(right.slice(1));
}

function lexicalTokens(text) {
  return String(text ?? "")
    .replace(ANNOTATION_TAG, " ")
    .match(/\S+/g)
    ?.map((token) => ({ text: token, normalized_token: normalizeToken(token) }))
    .filter((token) => token.normalized_token) ?? [];
}

function annotationTags(text) {
  return [...String(text ?? "").matchAll(ANNOTATION_TAG)].map((match) => match[1].toLowerCase());
}

function lcsPairs(referenceTokens, timedTokens) {
  const rows = referenceTokens.length + 1;
  const columns = timedTokens.length + 1;
  const matrix = Array.from({ length: rows }, () => new Uint16Array(columns));
  for (let row = 1; row < rows; row += 1) {
    for (let column = 1; column < columns; column += 1) {
      if (referenceTokens[row - 1].normalized_token === timedTokens[column - 1].normalized_token) {
        matrix[row][column] = matrix[row - 1][column - 1] + 1;
      } else {
        matrix[row][column] = Math.max(matrix[row - 1][column], matrix[row][column - 1]);
      }
    }
  }

  const pairs = [];
  let row = referenceTokens.length;
  let column = timedTokens.length;
  while (row > 0 && column > 0) {
    if (referenceTokens[row - 1].normalized_token === timedTokens[column - 1].normalized_token) {
      pairs.push([row - 1, column - 1]);
      row -= 1;
      column -= 1;
    } else if (matrix[row - 1][column] >= matrix[row][column - 1]) {
      row -= 1;
    } else {
      column -= 1;
    }
  }
  return pairs.reverse();
}

function distributeWords(words, startSec, endSec, timingSource) {
  if (!words.length) return;
  const start = Math.max(0, startSec);
  const end = Math.max(start + 0.001, endSec);
  const slot = Math.max(0.001, (end - start) / words.length);
  words.forEach((word, index) => {
    word.start_sec = round(start + slot * index, 6);
    word.end_sec = round(index === words.length - 1 ? end : start + slot * (index + 0.82), 6);
    word.timing_source = timingSource;
  });
}

function interpolateWithinUtterance(words, durationSeconds) {
  const matched = words.map((word, index) => (word.start_sec !== null ? index : null)).filter((value) => value !== null);
  if (!matched.length) return false;

  let cursor = 0;
  while (cursor < words.length) {
    if (words[cursor].start_sec !== null) {
      cursor += 1;
      continue;
    }
    const runStart = cursor;
    while (cursor < words.length && words[cursor].start_sec === null) cursor += 1;
    const runEnd = cursor;
    const count = runEnd - runStart;
    const previous = runStart > 0 ? words[runStart - 1] : null;
    const next = runEnd < words.length ? words[runEnd] : null;
    let left = previous ? previous.end_sec : Math.max(0, (next?.start_sec ?? 0) - count * 0.22 - 0.04);
    let right = next ? next.start_sec : Math.min(durationSeconds, left + count * 0.22 + 0.04);
    if (right <= left + count * 0.02) right = Math.min(durationSeconds, left + count * 0.08);
    const slot = Math.max(0.02, (right - left) / Math.max(1, count));
    for (let offset = 0; offset < count; offset += 1) {
      const word = words[runStart + offset];
      const start = Math.max(0, Math.min(durationSeconds - 0.001, left + offset * slot));
      const end = Math.max(start + 0.001, Math.min(durationSeconds, start + Math.max(0.02, slot * 0.82)));
      word.start_sec = round(start, 6);
      word.end_sec = round(end, 6);
      word.timing_source = "assemblyai_sequence_interpolation";
    }
  }
  return true;
}

function utteranceBounds(utterance) {
  const timed = utterance.words.filter((word) => word.start_sec !== null && word.end_sec !== null);
  if (!timed.length) return null;
  return {
    start: Math.min(...timed.map((word) => word.start_sec)),
    end: Math.max(...timed.map((word) => word.end_sec)),
  };
}

function inferredTurnTarget(utterances, index, durationSeconds) {
  let previousIndex = -1;
  let previous = null;
  for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
    const bounds = utteranceBounds(utterances[cursor]);
    if (bounds) {
      previousIndex = cursor;
      previous = bounds;
      break;
    }
  }
  let nextIndex = utterances.length;
  let next = null;
  for (let cursor = index + 1; cursor < utterances.length; cursor += 1) {
    const bounds = utteranceBounds(utterances[cursor]);
    if (bounds) {
      nextIndex = cursor;
      next = bounds;
      break;
    }
  }
  if (previous && next) {
    const fraction = (index - previousIndex) / Math.max(1, nextIndex - previousIndex);
    return Math.max(0, Math.min(durationSeconds, previous.end + (next.start - previous.end) * fraction));
  }
  if (previous) return Math.min(durationSeconds, previous.end + 0.25);
  if (next) return Math.max(0, next.start - 0.25);
  return durationSeconds * ((index + 1) / (utterances.length + 1));
}

function seedUnmatchedTurnsFromAcousticTiers(utterances, acousticTiers, durationSeconds) {
  if (!Array.isArray(acousticTiers)) return;
  const activeLabels = new Set(["s", "f", "bc", "ol"]);
  const available = new Map(
    acousticTiers
      .filter((tier) => /^S\d+$/.test(tier.name))
      .map((tier) => [
        tier.name,
        tier.intervals
          .filter((interval) => activeLabels.has(String(interval.text).trim()))
          .map((interval, index) => ({ ...interval, label: String(interval.text).trim(), index, used: false })),
      ]),
  );

  utterances.forEach((utterance, index) => {
    if (utteranceBounds(utterance)) return;
    const intervals = available.get(utterance.speaker) ?? [];
    const preferred = utterance.is_backchannel ? intervals.filter((interval) => interval.label === "bc" && !interval.used) : [];
    const candidates = preferred.length ? preferred : intervals.filter((interval) => !interval.used);
    const target = inferredTurnTarget(utterances, index, durationSeconds);
    const selected = candidates
      .map((interval) => ({ interval, distance: Math.abs((interval.start + interval.end) / 2 - target) }))
      .sort((left, right) => left.distance - right.distance)[0]?.interval;
    if (!selected) return;
    selected.used = true;
    distributeWords(
      utterance.words,
      selected.start,
      selected.end,
      utterance.is_backchannel && selected.label === "bc"
        ? "researcher_textgrid_bc_span_seed"
        : "researcher_textgrid_activity_span_seed",
    );
  });

  utterances.forEach((utterance, index) => {
    if (utteranceBounds(utterance)) return;
    const target = inferredTurnTarget(utterances, index, durationSeconds);
    const estimatedDuration = Math.min(3, Math.max(0.12, utterance.words.length * 0.24));
    distributeWords(
      utterance.words,
      Math.max(0, target - estimatedDuration / 2),
      Math.min(durationSeconds, target + estimatedDuration / 2),
      "generated_turn_local_fallback",
    );
  });
}

export function parseVerifiedTranscript(text, participantSpeakers) {
  const expected = new Set(participantSpeakers);
  const turns = [];
  let current = null;
  for (const sourceLine of String(text ?? "").replaceAll("\r\n", "\n").split("\n")) {
    const line = sourceLine.trim();
    if (!line) continue;
    const match = line.match(SPEAKER_LINE);
    if (match) {
      current = { speaker: match[1].trim(), text: match[2].trim() };
      turns.push(current);
    } else if (current) {
      current.text = `${current.text} ${line}`.trim();
    } else {
      throw new Error(`Transcript content appears before the first speaker label: ${line.slice(0, 80)}`);
    }
  }

  const issues = [];
  const normalizedTurns = turns.map((turn, index) => {
    const tags = annotationTags(turn.text);
    const unknownTags = tags.filter((tag) => !KNOWN_TAGS.has(tag));
    const canonicalParticipant = /^S\d+$/.test(turn.speaker) && expected.has(turn.speaker);
    const unexpectedCanonical = /^S\d+$/.test(turn.speaker) && !expected.has(turn.speaker);
    const excluded = tags.includes("x") || !canonicalParticipant;
    if (unknownTags.length) issues.push({ turn_id: `T${String(index + 1).padStart(4, "0")}`, issue: "unknown_annotation_tag", values: unknownTags });
    if (unexpectedCanonical) issues.push({ turn_id: `T${String(index + 1).padStart(4, "0")}`, issue: "speaker_not_in_textgrid", values: [turn.speaker] });
    if (!canonicalParticipant && !tags.includes("x")) issues.push({ turn_id: `T${String(index + 1).padStart(4, "0")}`, issue: "nonparticipant_missing_x_tag", values: [turn.speaker] });
    return {
      turn_id: `T${String(index + 1).padStart(4, "0")}`,
      speaker: turn.speaker,
      text: turn.text,
      annotation_tags: tags,
      is_backchannel: tags.includes("bc"),
      is_excluded: excluded,
      canonical_participant: canonicalParticipant,
      lexical_tokens: lexicalTokens(turn.text),
    };
  });

  const observedParticipants = [...new Set(normalizedTurns.filter((turn) => turn.canonical_participant).map((turn) => turn.speaker))].sort(naturalSpeakerSort);
  for (const speaker of participantSpeakers) {
    if (!observedParticipants.includes(speaker)) issues.push({ turn_id: "", issue: "textgrid_speaker_missing_from_transcript", values: [speaker] });
  }

  return {
    schema_version: "mwu-verified-transcript-parse-v1",
    status: issues.some((issue) => ["speaker_not_in_textgrid", "textgrid_speaker_missing_from_transcript"].includes(issue.issue)) ? "failed" : issues.length ? "passed_with_warnings" : "passed",
    turns: normalizedTurns,
    participant_turns: normalizedTurns.filter((turn) => turn.canonical_participant && !turn.is_excluded),
    excluded_turns: normalizedTurns.filter((turn) => turn.is_excluded),
    observed_participants: observedParticipants,
    expected_participants: [...participantSpeakers],
    issues,
  };
}

export function buildVerifiedTranscriptReference({ transcriptText, asrReference, participantSpeakers, durationSeconds, acousticTiers = [] }) {
  const parsed = parseVerifiedTranscript(transcriptText, participantSpeakers);
  if (parsed.status === "failed") {
    throw new Error(`Verified transcript contract failed: ${parsed.issues.map((issue) => `${issue.issue}:${issue.values.join("|")}`).join("; ")}`);
  }

  const utterances = parsed.participant_turns.map((turn, index) => ({
    utt_id: `U${String(index + 1).padStart(4, "0")}`,
    source_turn_id: turn.turn_id,
    speaker: turn.speaker,
    text: turn.text,
    annotation_tags: turn.annotation_tags,
    is_backchannel: turn.is_backchannel,
    words: turn.lexical_tokens.map((token) => ({ ...token })),
  }));

  let globalWordIndex = 0;
  const speakerWordIndexes = new Map();
  for (const utterance of utterances) {
    utterance.words.forEach((word) => {
      globalWordIndex += 1;
      const speakerIndex = (speakerWordIndexes.get(utterance.speaker) ?? 0) + 1;
      speakerWordIndexes.set(utterance.speaker, speakerIndex);
      Object.assign(word, {
        word_id: `W${String(globalWordIndex).padStart(5, "0")}`,
        utt_id: utterance.utt_id,
        speaker: utterance.speaker,
        speaker_word_index: speakerIndex,
        start_sec: null,
        end_sec: null,
        confidence: null,
        timing_source: "pending_generated_alignment",
        review_state: "researcher_verified_text_generated_timing",
      });
    });
  }

  const allWords = utterances.flatMap((utterance) => utterance.words);
  let tokenMatches = 0;
  for (const speaker of participantSpeakers) {
    const verifiedWords = allWords.filter((word) => word.speaker === speaker);
    const asrWords = asrReference.words.filter((word) => word.speaker === speaker).sort((left, right) => left.start_sec - right.start_sec);
    for (const [verifiedIndex, asrIndex] of lcsPairs(verifiedWords, asrWords)) {
      const word = verifiedWords[verifiedIndex];
      const timed = asrWords[asrIndex];
      word.start_sec = timed.start_sec;
      word.end_sec = timed.end_sec;
      word.confidence = timed.confidence;
      word.timing_source = "assemblyai_token_match";
      word.provider_word_id = timed.word_id;
      tokenMatches += 1;
    }
  }

  for (const utterance of utterances) interpolateWithinUtterance(utterance.words, durationSeconds);
  seedUnmatchedTurnsFromAcousticTiers(utterances, acousticTiers, durationSeconds);

  for (const utterance of utterances) {
    utterance.words.sort((left, right) => left.speaker_word_index - right.speaker_word_index);
    utterance.start_sec = Math.min(...utterance.words.map((word) => word.start_sec));
    utterance.end_sec = Math.max(...utterance.words.map((word) => word.end_sec));
    utterance.duration_sec = round(Math.max(0, utterance.end_sec - utterance.start_sec), 6);
    utterance.word_count = utterance.words.length;
    utterance.source_status = "researcher_verified_transcript";
  }

  const participantTranscriptText = `${parsed.participant_turns.map((turn) => `${turn.speaker}: ${turn.text}`).join("\n\n")}\n`;
  const excludedTranscriptText = parsed.excluded_turns.length
    ? `${parsed.excluded_turns.map((turn) => `${turn.speaker}: ${turn.text}`).join("\n\n")}\n`
    : "";
  const totalWords = allWords.length;
  return {
    status: "researcher_verified_transcript_with_generated_timing_seed",
    transcript_status: "researcher_verified_gold",
    accuracy_claim: true,
    timing_accuracy_claim: false,
    provider_confidence: asrReference.provider_confidence,
    speakers: [...participantSpeakers],
    utterances,
    words: allWords,
    transcript_text: participantTranscriptText,
    participant_transcript_text: participantTranscriptText,
    excluded_transcript_text: excludedTranscriptText,
    transcript_parse: parsed,
    timing_seed_summary: {
      verified_word_count: totalWords,
      assemblyai_token_match_count: tokenMatches,
      interpolated_word_count: totalWords - tokenMatches,
      token_match_ratio: totalWords ? round(tokenMatches / totalWords, 6) : 0,
      reviewed_word_timing: false,
    },
  };
}

function clock(seconds) {
  const totalMilliseconds = Math.max(0, Math.round(Number(seconds) * 1000));
  const hours = Math.floor(totalMilliseconds / 3_600_000);
  const minutes = Math.floor((totalMilliseconds % 3_600_000) / 60_000);
  const secs = Math.floor((totalMilliseconds % 60_000) / 1000);
  const millis = totalMilliseconds % 1000;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")}.${String(millis).padStart(3, "0")}`;
}

export function buildTimedRawTranscript(reference, speaker) {
  const lines = reference.utterances
    .filter((utterance) => utterance.speaker === speaker)
    .sort((left, right) => left.start_sec - right.start_sec || left.end_sec - right.end_sec)
    .map((utterance) => `[${clock(utterance.start_sec)} --> ${clock(utterance.end_sec)}] ${utterance.text}`);
  return lines.length ? `${lines.join("\n")}\n` : "";
}
