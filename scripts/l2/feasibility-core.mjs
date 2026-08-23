import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { parseTextGrid, round } from "../textgrid-utils.mjs";

export const NINE_LABELS = new Set(["s", "f", "bc", "ol", "op", "pf", "tr", "shs", "x"]);
export const VOCAL_LABELS = new Set(["s", "f", "bc", "ol"]);
export const DEFAULT_MWU_TARGETS = [
  "a lot of",
  "as well",
  "going to",
  "have to",
  "i mean",
  "i think",
  "in the",
  "kind of",
  "of course",
  "you know",
];
export const DEFAULT_FILLERS = new Set(["uh", "uhh", "um", "umm", "uhm", "er", "err", "erm", "hmm", "mhm"]);

export function normalizeToken(value) {
  return String(value ?? "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/^[^a-z0-9']+|[^a-z0-9']+$/g, "");
}

export function hashFile(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

export function csvCell(value) {
  if (value === null || value === undefined) return "";
  const text = Array.isArray(value) ? value.join("|") : String(value);
  return /[",\n\r]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

export function rowsToCsv(rows, headers = null) {
  const keys = headers ?? [...new Set(rows.flatMap((row) => Object.keys(row)))];
  return `${[keys.join(","), ...rows.map((row) => keys.map((key) => csvCell(row[key])).join(","))].join("\n")}\n`;
}

function textGridXmax(text) {
  const match = text.match(/^xmax\s*=\s*([^\s]+)\s*$/m);
  return match ? Number(match[1]) : Number.NaN;
}

function naturalSpeakerSort(a, b) {
  return Number(a.slice(1)) - Number(b.slice(1));
}

function tierCoverage(tier, duration, tolerance = 0.00001) {
  const issues = [];
  if (!tier.intervals.length) return { ok: false, issues: [`${tier.name}: no intervals`] };
  if (Math.abs(tier.intervals[0].start) > tolerance) issues.push(`${tier.name}: timeline does not start at zero`);
  if (Math.abs(tier.intervals.at(-1).end - duration) > tolerance) {
    issues.push(`${tier.name}: timeline does not end at ${duration}`);
  }
  for (let i = 1; i < tier.intervals.length; i += 1) {
    if (Math.abs(tier.intervals[i - 1].end - tier.intervals[i].start) > tolerance) {
      issues.push(`${tier.name}: gap or overlap before interval ${i + 1}`);
    }
  }
  return { ok: issues.length === 0, issues };
}

export function validateReviewedTextGrid(text, expectedDuration = null) {
  const tiers = parseTextGrid(text);
  const xmax = textGridXmax(text);
  const duration = Number.isFinite(expectedDuration) ? Number(expectedDuration) : xmax;
  const speakers = tiers.map((tier) => tier.name).filter((name) => /^S\d+$/.test(name)).sort(naturalSpeakerSort);
  const errors = [];
  const warnings = [];

  if (!Number.isFinite(duration) || duration <= 0) errors.push("TextGrid duration is missing or invalid");
  if (Number.isFinite(expectedDuration) && Number.isFinite(xmax) && Math.abs(xmax - expectedDuration) > 0.001) {
    errors.push(`TextGrid duration ${xmax} does not match expected duration ${expectedDuration}`);
  }
  if (speakers.length < 2) errors.push("Expected at least two canonical speaker tiers");
  speakers.forEach((speaker, index) => {
    if (speaker !== `S${index + 1}`) errors.push(`Canonical speakers are not contiguous at ${speaker}`);
  });
  const expectedTierCount = speakers.length + 3;
  if (tiers.length !== expectedTierCount) errors.push(`Expected dynamic N+3 (${expectedTierCount}) tiers, found ${tiers.length}`);
  for (const required of ["floor", "transitions", "flags"]) {
    if (!tiers.some((tier) => tier.name === required)) errors.push(`Missing required tier: ${required}`);
  }

  for (const speaker of speakers) {
    const tier = tiers.find((candidate) => candidate.name === speaker);
    errors.push(...tierCoverage(tier, duration).issues);
    for (const label of new Set(tier.intervals.map((interval) => String(interval.text).trim()).filter(Boolean))) {
      if (!NINE_LABELS.has(label)) errors.push(`${speaker}: unsupported label ${label}`);
    }
  }
  for (const tierName of ["floor", "flags"]) {
    const tier = tiers.find((candidate) => candidate.name === tierName);
    if (tier?.intervals.length) errors.push(...tierCoverage(tier, duration).issues);
  }
  const transitionTier = tiers.find((candidate) => candidate.name === "transitions");
  if (transitionTier && transitionTier.intervals.length === 0) warnings.push("transitions tier is empty in the researcher reference");

  return {
    status: errors.length ? "failed" : warnings.length ? "passed_with_warnings" : "passed",
    duration_seconds: duration,
    tier_count: tiers.length,
    speaker_count: speakers.length,
    speakers,
    expected_dynamic_tier_count: expectedTierCount,
    errors,
    warnings,
    tiers,
  };
}

export function buildPseudoGoldReference(assemblyPayload, providerToCanonical) {
  const utterances = [];
  const words = [];
  let globalWordIndex = 0;
  const speakerWordIndexes = new Map();

  for (const [index, source] of [...(assemblyPayload.utterances ?? [])].sort((a, b) => a.start - b.start).entries()) {
    const providerSpeaker = String(source.speaker ?? "");
    const speaker = providerToCanonical[providerSpeaker];
    if (!speaker) throw new Error(`No canonical mapping for AssemblyAI speaker ${providerSpeaker || "<blank>"}`);
    const uttId = `U${String(index + 1).padStart(4, "0")}`;
    const utteranceWords = [];
    for (const sourceWord of source.words ?? []) {
      globalWordIndex += 1;
      const speakerIndex = (speakerWordIndexes.get(speaker) ?? 0) + 1;
      speakerWordIndexes.set(speaker, speakerIndex);
      const word = {
        word_id: `W${String(globalWordIndex).padStart(5, "0")}`,
        utt_id: uttId,
        speaker,
        provider_speaker: providerSpeaker,
        speaker_word_index: speakerIndex,
        text: String(sourceWord.text ?? "").trim(),
        normalized_token: normalizeToken(sourceWord.text),
        start_sec: round(Number(sourceWord.start) / 1000, 6),
        end_sec: round(Number(sourceWord.end) / 1000, 6),
        confidence: Number.isFinite(Number(sourceWord.confidence)) ? Number(sourceWord.confidence) : null,
        timing_source: "assemblyai",
        review_state: "pseudo_gold_unreviewed",
      };
      utteranceWords.push(word);
      words.push(word);
    }
    utterances.push({
      utt_id: uttId,
      speaker,
      provider_speaker: providerSpeaker,
      start_sec: round(Number(source.start) / 1000, 6),
      end_sec: round(Number(source.end) / 1000, 6),
      duration_sec: round((Number(source.end) - Number(source.start)) / 1000, 6),
      text: String(source.text ?? "").trim(),
      confidence: Number.isFinite(Number(source.confidence)) ? Number(source.confidence) : null,
      word_count: utteranceWords.length,
      words: utteranceWords,
      source_status: "assemblyai_pseudo_gold",
    });
  }

  const speakers = [...new Set(utterances.map((utterance) => utterance.speaker))].sort(naturalSpeakerSort);
  const transcriptText = `${utterances.map((utterance) => `${utterance.speaker}: ${utterance.text}`).join("\n")}\n`;
  return {
    status: "assemblyai_pseudo_gold",
    accuracy_claim: false,
    provider_confidence: assemblyPayload.confidence ?? null,
    speakers,
    utterances,
    words,
    transcript_text: transcriptText,
  };
}

export function buildAsrTimingFallback(reference, durationSeconds) {
  return {
    stage: "l2-feasibility-word-alignment",
    created_at: new Date().toISOString(),
    timeline_start_sec: 0,
    timeline_end_sec: durationSeconds,
    source_status: "assemblyai_timestamp_fallback",
    research_claim_ready: false,
    summary: {
      speaker_count: reference.speakers.length,
      word_count: reference.words.length,
      alignment_method: "assemblyai_word_timestamps",
      reviewed: false,
    },
    word_intervals: reference.words.map((word) => ({
      ...word,
      alignment_status: "pseudo_gold_unreviewed",
      alignment_flags: ["not_for_word_level_research_claim"],
    })),
    alignment_review: reference.utterances.map((utterance) => ({
      utt_id: utterance.utt_id,
      speaker: utterance.speaker,
      start_sec: utterance.start_sec,
      end_sec: utterance.end_sec,
      status: "pseudo_gold_unreviewed",
      flags: ["mfa_not_used"],
    })),
  };
}

export function normalizeAlignmentPayload(payload, source) {
  return {
    ...payload,
    source_status: source,
    research_claim_ready: false,
    summary: {
      ...(payload.summary ?? {}),
      alignment_method: source === "mfa_generated_fixture" ? "mfa_3_x" : "assemblyai_word_timestamps",
      reviewed: false,
    },
    word_intervals: (payload.word_intervals ?? []).map((word) => ({
      ...word,
      normalized_token: normalizeToken(word.text),
      timing_source: source === "mfa_generated_fixture" ? "mfa" : "assemblyai",
      review_state: "generated_unreviewed",
    })),
  };
}

function lcsTokenPairs(referenceWords, alignedWords) {
  const rows = referenceWords.length + 1;
  const columns = alignedWords.length + 1;
  const matrix = Array.from({ length: rows }, () => new Uint16Array(columns));
  for (let row = 1; row < rows; row += 1) {
    const referenceToken = normalizeToken(referenceWords[row - 1].text);
    for (let column = 1; column < columns; column += 1) {
      if (referenceToken && referenceToken === normalizeToken(alignedWords[column - 1].text)) {
        matrix[row][column] = matrix[row - 1][column - 1] + 1;
      } else {
        matrix[row][column] = Math.max(matrix[row - 1][column], matrix[row][column - 1]);
      }
    }
  }

  const pairs = [];
  let row = referenceWords.length;
  let column = alignedWords.length;
  while (row > 0 && column > 0) {
    const referenceToken = normalizeToken(referenceWords[row - 1].text);
    const alignedToken = normalizeToken(alignedWords[column - 1].text);
    if (referenceToken && referenceToken === alignedToken) {
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

export function buildReferenceCentricTiming(referenceWords, alignedWords) {
  const referenceByUtt = Map.groupBy(referenceWords, (word) => word.utt_id);
  const alignedByUtt = Map.groupBy(alignedWords, (word) => word.parent_utt_id ?? word.utt_id);
  const output = [];
  let mfaSupportedWordCount = 0;

  for (const [uttId, utteranceReference] of referenceByUtt) {
    const utteranceAligned = [...(alignedByUtt.get(uttId) ?? [])].sort(
      (left, right) => left.start_sec - right.start_sec || left.end_sec - right.end_sec,
    );
    const matchedByReferenceIndex = new Map(
      lcsTokenPairs(utteranceReference, utteranceAligned).map(([referenceIndex, alignedIndex]) => [
        referenceIndex,
        utteranceAligned[alignedIndex],
      ]),
    );

    utteranceReference.forEach((referenceWord, referenceIndex) => {
      const alignedWord = matchedByReferenceIndex.get(referenceIndex);
      if (alignedWord) {
        mfaSupportedWordCount += 1;
        output.push({
          ...referenceWord,
          start_sec: alignedWord.start_sec,
          end_sec: alignedWord.end_sec,
          timing_source: "mfa",
          timing_review_state: "generated_unreviewed",
          mfa_word_id: alignedWord.word_id,
          alignment_flags: alignedWord.alignment_flags ?? [],
          alignment_confidence: alignedWord.alignment_confidence ?? null,
        });
      } else {
        output.push({
          ...referenceWord,
          timing_source: "assemblyai_fallback",
          timing_review_state: "pseudo_gold_unreviewed",
          mfa_word_id: "",
          alignment_flags: ["mfa_token_not_matched", "not_for_word_level_research_claim"],
          alignment_confidence: null,
        });
      }
    });
  }

  output.sort((left, right) => left.start_sec - right.start_sec || left.end_sec - right.end_sec);
  const fallbackWordCount = output.length - mfaSupportedWordCount;
  return {
    schema_version: "l2-reference-centric-word-timing-v1",
    source_status: fallbackWordCount ? "mfa_with_assemblyai_fallback" : "mfa_generated_fixture",
    research_claim_ready: false,
    summary: {
      reference_word_count: output.length,
      mfa_supported_word_count: mfaSupportedWordCount,
      assemblyai_fallback_word_count: fallbackWordCount,
      mfa_support_ratio: output.length ? round(mfaSupportedWordCount / output.length, 6) : 0,
      reviewed: false,
    },
    word_intervals: output,
  };
}

export function compareWordTimings(referenceWords, alignedWords) {
  const referenceByUtt = Map.groupBy(referenceWords, (word) => word.utt_id);
  const alignedByUtt = Map.groupBy(alignedWords, (word) => word.parent_utt_id ?? word.utt_id);
  const deviations = [];
  let tokenMatches = 0;
  let compared = 0;
  for (const [uttId, reference] of referenceByUtt) {
    const aligned = alignedByUtt.get(uttId) ?? [];
    const length = Math.min(reference.length, aligned.length);
    for (let index = 0; index < length; index += 1) {
      compared += 1;
      if (normalizeToken(reference[index].text) !== normalizeToken(aligned[index].text)) continue;
      tokenMatches += 1;
      deviations.push(Math.abs(reference[index].start_sec - aligned[index].start_sec));
      deviations.push(Math.abs(reference[index].end_sec - aligned[index].end_sec));
    }
  }
  deviations.sort((a, b) => a - b);
  const mean = deviations.length ? deviations.reduce((sum, value) => sum + value, 0) / deviations.length : null;
  const median = deviations.length ? deviations[Math.floor(deviations.length / 2)] : null;
  return {
    reference_word_count: referenceWords.length,
    aligned_word_count: alignedWords.length,
    aligned_to_reference_count_ratio: referenceWords.length ? round(alignedWords.length / referenceWords.length, 6) : null,
    index_pairs_compared: compared,
    token_matches: tokenMatches,
    token_match_ratio: compared ? round(tokenMatches / compared, 6) : null,
    boundary_deviation_mean_sec: mean === null ? null : round(mean, 6),
    boundary_deviation_median_sec: median === null ? null : round(median, 6),
    interpretation: "system-vs-system timing comparison; not accuracy against reviewed word boundaries",
  };
}

function labelSummary(tier) {
  const byLabel = {};
  for (const interval of tier.intervals) {
    const label = String(interval.text ?? "").trim();
    if (!label) continue;
    const record = byLabel[label] ?? { interval_count: 0, duration_sec: 0 };
    record.interval_count += 1;
    record.duration_sec += interval.end - interval.start;
    byLabel[label] = record;
  }
  for (const value of Object.values(byLabel)) value.duration_sec = round(value.duration_sec, 6);
  return byLabel;
}

export function findMwuOccurrences(words, targets = DEFAULT_MWU_TARGETS) {
  const normalizedTargets = targets.map((text) => ({ text, tokens: text.split(/\s+/).map(normalizeToken).filter(Boolean) }));
  const occurrences = [];
  let id = 0;
  const bySpeaker = Map.groupBy(words, (word) => word.speaker);
  for (const [speaker, speakerWordsUnsorted] of bySpeaker) {
    const speakerWords = [...speakerWordsUnsorted].sort((a, b) => a.start_sec - b.start_sec);
    const tokens = speakerWords.map((word) => normalizeToken(word.text));
    for (const target of normalizedTargets) {
      for (let start = 0; start <= tokens.length - target.tokens.length; start += 1) {
        const candidate = tokens.slice(start, start + target.tokens.length);
        if (candidate.join(" ") !== target.tokens.join(" ")) continue;
        const matched = speakerWords.slice(start, start + target.tokens.length);
        if (new Set(matched.map((word) => word.parent_utt_id ?? word.utt_id)).size !== 1) continue;
        id += 1;
        occurrences.push({
          mwu_id: `MWU${String(id).padStart(4, "0")}`,
          speaker,
          target: target.text,
          start_sec: matched[0].start_sec,
          end_sec: matched.at(-1).end_sec,
          start_word_id: matched[0].word_id,
          end_word_id: matched.at(-1).word_id,
          word_ids: matched.map((word) => word.word_id),
          utt_id: matched[0].parent_utt_id ?? matched[0].utt_id,
          rule_status: "simulated_reference_list",
        });
      }
    }
  }
  return occurrences.sort((a, b) => a.start_sec - b.start_sec);
}

function mwuRelation(previousWord, nextWord, occurrences) {
  if (!previousWord && !nextWord) return { relation: "unresolved", mwu_id: "" };
  for (const occurrence of occurrences) {
    const prevIndex = previousWord ? occurrence.word_ids.indexOf(previousWord.word_id) : -1;
    const nextIndex = nextWord ? occurrence.word_ids.indexOf(nextWord.word_id) : -1;
    if (prevIndex >= 0 && nextIndex === prevIndex + 1) return { relation: "inside_mwu", mwu_id: occurrence.mwu_id };
    if (nextWord?.word_id === occurrence.start_word_id && prevIndex === -1) return { relation: "before_mwu", mwu_id: occurrence.mwu_id };
    if (previousWord?.word_id === occurrence.end_word_id && nextIndex === -1) return { relation: "after_mwu", mwu_id: occurrence.mwu_id };
  }
  return { relation: "outside_mwu", mwu_id: "" };
}

export function buildPauseRows(contract, alignedWords, occurrences, thresholdSeconds = 0.25) {
  const rows = [];
  let id = 0;
  for (const speaker of contract.speakers) {
    const tier = contract.tiers.find((candidate) => candidate.name === speaker);
    const words = alignedWords.filter((word) => word.speaker === speaker).sort((a, b) => a.start_sec - b.start_sec);
    for (const interval of tier.intervals.filter((item) => item.text === "op")) {
      const duration = interval.end - interval.start;
      if (duration + 0.000001 < thresholdSeconds) continue;
      id += 1;
      const previousWord = [...words].reverse().find((word) => word.end_sec <= interval.start + 0.000001) ?? null;
      const nextWord = words.find((word) => word.start_sec >= interval.end - 0.000001) ?? null;
      const relation = mwuRelation(previousWord, nextWord, occurrences);
      let clauseLocation = "unresolved";
      if (previousWord && nextWord) {
        clauseLocation =
          (previousWord.parent_utt_id ?? previousWord.utt_id) === (nextWord.parent_utt_id ?? nextWord.utt_id)
            ? "within_utterance_candidate"
            : "utterance_boundary_candidate";
      } else if (previousWord) clauseLocation = "trailing_candidate";
      else if (nextWord) clauseLocation = "leading_candidate";
      rows.push({
        pause_id: `P${String(id).padStart(4, "0")}`,
        speaker,
        start_sec: round(interval.start, 6),
        end_sec: round(interval.end, 6),
        duration_sec: round(duration, 6),
        source_label: "op",
        threshold_sec: thresholdSeconds,
        previous_word_id: previousWord?.word_id ?? "",
        previous_word: previousWord?.text ?? "",
        next_word_id: nextWord?.word_id ?? "",
        next_word: nextWord?.text ?? "",
        clause_location_candidate: clauseLocation,
        mwu_relation_candidate: relation.relation,
        mwu_id: relation.mwu_id,
        alignment_status: "generated_unreviewed",
        rule_status: "simulated_clause_and_mwu_rules",
      });
    }
  }
  return rows;
}

function safeRate(numerator, denominator) {
  return denominator > 0 ? round(numerator / denominator, 6) : null;
}

export function buildFeatureTables(contract, words, occurrences, pauses) {
  const speakerRows = [];
  const lexicalRows = [];
  const repairRows = [];
  for (const speaker of contract.speakers) {
    const tier = contract.tiers.find((candidate) => candidate.name === speaker);
    const labels = labelSummary(tier);
    const speakerWords = words.filter((word) => word.speaker === speaker);
    const mfaTimedWordCount = speakerWords.filter((word) => word.timing_source === "mfa").length;
    const fallbackTimedWordCount = speakerWords.filter((word) => word.timing_source === "assemblyai_fallback").length;
    const normalized = speakerWords.map((word) => normalizeToken(word.text)).filter(Boolean);
    const wordCount = normalized.length;
    const uniqueWordCount = new Set(normalized).size;
    const activeDuration = [...VOCAL_LABELS].reduce((sum, label) => sum + (labels[label]?.duration_sec ?? 0), 0);
    const floorRunDuration = activeDuration + (labels.op?.duration_sec ?? 0);
    const speakerPauses = pauses.filter((pause) => pause.speaker === speaker);
    const speakerMwu = occurrences.filter((occurrence) => occurrence.speaker === speaker);
    const fillerCount = normalized.filter((token) => DEFAULT_FILLERS.has(token)).length;
    let adjacentRepetitionCount = 0;
    for (let index = 1; index < normalized.length; index += 1) {
      if (normalized[index] === normalized[index - 1]) adjacentRepetitionCount += 1;
    }
    speakerRows.push({
      speaker,
      word_count: wordCount,
      active_vocal_duration_sec: round(activeDuration, 6),
      own_pause_duration_sec: labels.op?.duration_sec ?? 0,
      own_pause_count: speakerPauses.length,
      mean_own_pause_sec: safeRate(speakerPauses.reduce((sum, pause) => sum + pause.duration_sec, 0), speakerPauses.length),
      articulation_rate_words_per_sec: safeRate(wordCount, activeDuration),
      speech_rate_words_per_sec: safeRate(wordCount, floorRunDuration),
      pause_density_per_100_words: wordCount ? round((speakerPauses.length / wordCount) * 100, 6) : null,
      mwu_occurrence_count: speakerMwu.length,
      pause_timing_source: "researcher_corrected_p025_textgrid",
      word_timing_source: fallbackTimedWordCount ? "mfa_with_assemblyai_fallback" : "mfa",
      mfa_timed_word_count: mfaTimedWordCount,
      assemblyai_fallback_word_count: fallbackTimedWordCount,
      transcript_source: "assemblyai_pseudo_gold",
      definition_status: "simulated_for_feasibility",
    });
    lexicalRows.push({
      speaker,
      token_count: wordCount,
      type_count: uniqueWordCount,
      type_token_ratio: wordCount ? round(uniqueWordCount / wordCount, 6) : null,
      mean_token_length: wordCount ? round(normalized.reduce((sum, token) => sum + token.length, 0) / wordCount, 6) : null,
      mwu_occurrence_count: speakerMwu.length,
      external_tool_status: "TAALES_TAALED_AntConc_not_configured",
    });
    repairRows.push({
      speaker,
      filler_count: fillerCount,
      adjacent_repetition_count: adjacentRepetitionCount,
      false_start_count: null,
      repair_count: null,
      status: "partial_pseudo_gold_only",
    });
  }
  return { speakerRows, lexicalRows, repairRows };
}

export function buildAsUnitCandidates(reference) {
  return reference.utterances.map((utterance, index) => ({
    as_unit_candidate_id: `ASU${String(index + 1).padStart(4, "0")}`,
    utt_id: utterance.utt_id,
    speaker: utterance.speaker,
    start_sec: utterance.start_sec,
    end_sec: utterance.end_sec,
    text: utterance.text,
    boundary_source: "assemblyai_utterance_fixture",
    review_status: "unresolved_research_definition",
  }));
}

export function buildDefinitionPack() {
  return {
    schema_version: "l2-feasibility-definition-pack-v1",
    status: "simulated_for_engineering_validation",
    research_approved: false,
    as_unit_rule: "Each AssemblyAI utterance is one provisional AS-unit candidate; no research claim.",
    clause_rule: "A word gap crossing an AssemblyAI utterance is an utterance-boundary candidate; manual clause rules remain required.",
    pause_location_rule: "Use researcher-corrected op intervals >= 0.25 s and nearest generated word boundaries.",
    mwu_rule: "Exact case-insensitive contiguous match within one utterance against the fixture target list.",
    mwu_targets: DEFAULT_MWU_TARGETS,
    repair_rule: "Count listed fillers and adjacent exact repetitions; false starts and repairs remain pending.",
    rate_rule: {
      articulation_rate_words_per_sec: "word_count / duration(s+f+bc+ol)",
      speech_rate_words_per_sec: "word_count / duration(s+f+bc+ol+op)",
      status: "fixture_only",
    },
    lexical_tools: {
      TAALES: "pending_client_version_and_variables",
      TAALED: "pending_client_version_and_variables",
      AntConc: "pending_client_version_and_variables",
    },
  };
}

export function buildMetadata({ recordingId, durationSeconds, speakers, audioHash, textGridHash, transcriptHash }) {
  return {
    schema_version: "mwu-l2-metadata-v1",
    recording: {
      recording_id: recordingId,
      corpus_id: "SIM_POC_CORPUS",
      media_type: "audio",
      language: "eng",
      interaction_type: "multilogue",
      duration_seconds: durationSeconds,
      speaker_count: speakers.length,
      source_audio_sha256: audioHash,
      reviewed_textgrid_sha256: textGridHash,
      reference_transcript_sha256: transcriptHash,
      pause_threshold_seconds: 0.25,
      factual_status: "mixed_real_and_simulated",
    },
    participants: speakers.map((speaker, index) => ({
      participant_id: `SIM_P${String(index + 1).padStart(2, "0")}`,
      canonical_speaker: speaker,
      role: "Participant",
      first_language: "und",
      proficiency: "unknown",
      included: true,
      is_simulated: true,
    })),
    task: {
      task_id: "SIM_TASK_01",
      task_type: "discussion",
      condition: "unknown",
      is_simulated: true,
    },
  };
}

export function buildUnresolvedItems({ alignmentSource, alignmentSummary = null, pauseRows, asUnitRows }) {
  return [
    {
      item_id: "U001",
      module: "transcript",
      field: "verbatim_accuracy",
      status: "pseudo_gold",
      reason: "AssemblyAI is the PoC reference transcript and has not been researcher verified.",
    },
    {
      item_id: "U002",
      module: "word_alignment",
      field: "word_boundaries",
      status: "generated_unreviewed",
      reason: alignmentSummary
        ? `${alignmentSummary.mfa_supported_word_count}/${alignmentSummary.reference_word_count} transcript words use generated MFA timing; ${alignmentSummary.assemblyai_fallback_word_count} use explicit AssemblyAI fallback. No word boundary is reviewed Gold.`
        : `${alignmentSource} output is an engineering fixture, not reviewed word-boundary Gold.`,
    },
    {
      item_id: "U003",
      module: "AS_unit_clause",
      field: "boundary_classification",
      status: "simulated",
      reason: `${asUnitRows.length} utterance-derived candidates require client coding rules and review.`,
    },
    {
      item_id: "U004",
      module: "pause_location",
      field: "mid_vs_end_clause",
      status: "simulated",
      reason: `${pauseRows.length} pause rows use utterance-boundary candidates, not approved clause rules.`,
    },
    {
      item_id: "U005",
      module: "MWU",
      field: "operational_definition",
      status: "simulated",
      reason: "Exact-match fixture list is not the research team's approved MWU definition.",
    },
    {
      item_id: "U006",
      module: "lexical_tools",
      field: "TAALES_TAALED_AntConc",
      status: "pending_client_input",
      reason: "Versions, settings and requested variables have not been supplied.",
    },
    {
      item_id: "U007",
      module: "repair_rate",
      field: "false_starts_repairs_syllables",
      status: "pending_client_input",
      reason: "Coding and syllable/rate definitions have not been approved.",
    },
  ];
}
