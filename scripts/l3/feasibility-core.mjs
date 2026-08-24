import { round } from "../textgrid-utils.mjs";
import { VOCAL_LABELS } from "../l2/feasibility-core.mjs";

export function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = "";
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (quoted) {
      if (character === '"' && text[index + 1] === '"') {
        cell += '"';
        index += 1;
      } else if (character === '"') {
        quoted = false;
      } else {
        cell += character;
      }
    } else if (character === '"') {
      quoted = true;
    } else if (character === ",") {
      row.push(cell);
      cell = "";
    } else if (character === "\n") {
      row.push(cell.replace(/\r$/, ""));
      if (row.some((value) => value !== "")) rows.push(row);
      row = [];
      cell = "";
    } else {
      cell += character;
    }
  }
  if (cell || row.length) {
    row.push(cell.replace(/\r$/, ""));
    if (row.some((value) => value !== "")) rows.push(row);
  }
  if (!rows.length) return [];
  const headers = rows[0];
  return rows.slice(1).map((values) => Object.fromEntries(headers.map((header, index) => [header, values[index] ?? ""])));
}

export function rowsToCsv(rows, headers = null) {
  const keys = headers ?? [...new Set(rows.flatMap((row) => Object.keys(row)))];
  const cell = (value) => {
    if (value === null || value === undefined) return "";
    const text = String(value);
    return /[",\n\r]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
  };
  return `${[keys.join(","), ...rows.map((row) => keys.map((key) => cell(row[key])).join(","))].join("\n")}\n`;
}

const n = (value) => (value === "" || value === null || value === undefined ? null : Number(value));

export function buildMatrixRows({ handoffRows, pauseRows }) {
  return handoffRows.map((handoff) => {
    const speaker = handoff.speaker;
    const speakerPauses = pauseRows.filter((row) => row.speaker === speaker);
    const qualifyingOwnPauseDuration = speakerPauses.reduce((sum, row) => sum + (n(row.duration_sec) ?? 0), 0);
    const mfaWords = n(handoff.mfa_timed_word_count) ?? 0;
    const fallbackWords = n(handoff.assemblyai_fallback_word_count) ?? 0;
    const timingWords = mfaWords + fallbackWords;
    return {
      recording_id: handoff.recording_id,
      threshold_sec: n(handoff.threshold_sec) ?? 0.25,
      participant_id: handoff.participant_id,
      speaker,
      word_count: null,
      active_vocal_duration_sec: n(handoff.active_vocal_duration_sec),
      own_pause_labeled_duration_sec: n(handoff.own_pause_duration_sec),
      qualifying_own_pause_duration_sec: round(qualifyingOwnPauseDuration, 6),
      own_pause_count: n(handoff.own_pause_count),
      mean_own_pause_sec: n(handoff.mean_own_pause_sec),
      articulation_rate_words_per_sec: null,
      speech_rate_words_per_sec: null,
      pause_density_per_100_words: null,
      token_count: null,
      type_count: null,
      type_token_ratio: null,
      mean_token_length: null,
      mwu_occurrence_count: null,
      filler_count: null,
      adjacent_repetition_count: null,
      false_start_count: null,
      repair_count: null,
      pause_within_utterance_candidate_count: null,
      pause_utterance_boundary_candidate_count: null,
      pause_location_unresolved_count: null,
      pause_inside_mwu_candidate_count: null,
      pause_before_mwu_candidate_count: null,
      pause_after_mwu_candidate_count: null,
      mfa_timed_word_count: mfaWords,
      assemblyai_fallback_word_count: fallbackWords,
      word_timing_mfa_support_ratio: timingWords ? round(mfaWords / timingWords, 6) : null,
      external_lexical_tools_status: "pending_client_input",
      unresolved_item_count: n(handoff.unresolved_item_count),
      record_status: "provisional_not_research_release",
      l3_release_ready: false,
    };
  });
}

export function provisionalCodebook(options = {}) {
  const verifiedTranscript = options.transcriptStatus === "researcher_verified_gold";
  const transcriptSource = verifiedTranscript
    ? "researcher-verified transcript; tokenization definition pending"
    : "generated transcript; tokenization definition pending";
  const transcriptProvenance = "pending_client_input";
  const fields = [
    ["recording_id", "string", "identifier", false, "L2 handoff", "real_source", true],
    ["threshold_sec", "number", "seconds", false, "reviewed TextGrid threshold", "gold", true],
    ["participant_id", "string", "identifier", false, "canonical recording-speaker key", "system", true],
    ["speaker", "string", "canonical S label", false, "researcher TextGrid", "gold", true],
    ["word_count", "integer", "words", true, transcriptSource, transcriptProvenance, false],
    ["active_vocal_duration_sec", "number", "seconds", false, "researcher TextGrid labels s/f/bc/ol", "gold_derived", true],
    ["own_pause_labeled_duration_sec", "number", "seconds", false, "all researcher TextGrid intervals labeled op", "gold_derived", true],
    ["qualifying_own_pause_duration_sec", "number", "seconds", false, "researcher TextGrid op intervals >= P025", "gold_derived", true],
    ["own_pause_count", "integer", "pauses", false, "researcher TextGrid op >= P025", "gold_derived", true],
    ["mean_own_pause_sec", "number", "seconds", false, "qualifying_own_pause_duration_sec / own_pause_count", "gold_derived", true],
    ["articulation_rate_words_per_sec", "number", "words/second", true, "approved word/syllable rule pending", "pending_client_input", false],
    ["speech_rate_words_per_sec", "number", "words/second", true, "approved word/syllable rule pending", "pending_client_input", false],
    ["pause_density_per_100_words", "number", "pauses/100 words", true, "approved tokenization and denominator pending", "pending_client_input", false],
    ["token_count", "integer", "tokens", true, transcriptSource, transcriptProvenance, false],
    ["type_count", "integer", "types", true, transcriptSource, transcriptProvenance, false],
    ["type_token_ratio", "number", "ratio", true, "approved lexical normalization pending", "pending_client_input", false],
    ["mean_token_length", "number", "characters", true, "approved lexical normalization pending", "pending_client_input", false],
    ["mwu_occurrence_count", "integer", "occurrences", true, "approved MWU definition pending", "pending_client_input", false],
    ["filler_count", "integer", "tokens", true, "approved filler coding rule pending", "pending_client_input", false],
    ["adjacent_repetition_count", "integer", "repetitions", true, "approved repair coding rule pending", "pending_client_input", false],
    ["false_start_count", "integer", "events", true, "approved false-start coding rule pending", "pending_client_input", false],
    ["repair_count", "integer", "events", true, "client repair coding", "pending_client_input", false],
    ["pause_within_utterance_candidate_count", "integer", "pauses", true, "approved clause boundary rule pending", "pending_client_input", false],
    ["pause_utterance_boundary_candidate_count", "integer", "pauses", true, "approved clause boundary rule pending", "pending_client_input", false],
    ["pause_location_unresolved_count", "integer", "pauses", true, "approved pause-location rule pending", "pending_client_input", false],
    ["pause_inside_mwu_candidate_count", "integer", "pauses", true, "approved MWU definition pending", "pending_client_input", false],
    ["pause_before_mwu_candidate_count", "integer", "pauses", true, "approved MWU definition pending", "pending_client_input", false],
    ["pause_after_mwu_candidate_count", "integer", "pauses", true, "approved MWU definition pending", "pending_client_input", false],
    ["mfa_timed_word_count", "integer", "words", false, "generated MFA word alignment", "generated_unreviewed", false],
    ["assemblyai_fallback_word_count", "integer", "words", false, "AssemblyAI timing fallback", "generated_unreviewed", false],
    ["word_timing_mfa_support_ratio", "number", "ratio", false, "MFA support / transcript words", "generated_unreviewed", false],
    ["external_lexical_tools_status", "string", "status", false, "TAALES/TAALED/AntConc", "pending_client_input", false],
    ["unresolved_item_count", "integer", "items", false, "L2 unresolved register", "pending", false],
    ["record_status", "string", "status", false, "L3 feasibility gate", "system", true],
    ["l3_release_ready", "boolean", "flag", false, "L3 feasibility gate", "system", true],
  ];
  return fields.map(([field_name, data_type, unit, nullable, source, provenance_status, structurally_validated]) => ({
    field_name,
    data_type,
    unit,
    nullable,
    source,
    provenance_status,
    structurally_validated,
    schema_status: "provisional_not_client_signed",
  }));
}

function durationByLabel(tier) {
  const summary = new Map();
  for (const interval of tier.intervals) {
    const label = String(interval.text ?? "").trim();
    if (!label) continue;
    const current = summary.get(label) ?? { count: 0, duration: 0 };
    current.count += 1;
    current.duration += interval.end - interval.start;
    summary.set(label, current);
  }
  return summary;
}

export function goldDerivedRows(contract, pauseThresholdSeconds = 0.25) {
  return contract.speakers.map((speaker) => {
    const tier = contract.tiers.find((candidate) => candidate.name === speaker);
    const labels = durationByLabel(tier);
    const active = [...VOCAL_LABELS].reduce((sum, label) => sum + (labels.get(label)?.duration ?? 0), 0);
    const allOwnPauses = tier.intervals.filter((interval) => interval.text === "op");
    const ownPauseLabeledDuration = allOwnPauses.reduce((sum, interval) => sum + interval.end - interval.start, 0);
    const ownPauses = allOwnPauses.filter(
      (interval) => interval.text === "op" && interval.end - interval.start + 0.000001 >= pauseThresholdSeconds,
    );
    const qualifyingOwnPauseDuration = ownPauses.reduce((sum, interval) => sum + interval.end - interval.start, 0);
    return {
      speaker,
      active_vocal_duration_sec: round(active, 6),
      own_pause_labeled_duration_sec: round(ownPauseLabeledDuration, 6),
      qualifying_own_pause_duration_sec: round(qualifyingOwnPauseDuration, 6),
      own_pause_count: ownPauses.length,
      mean_own_pause_sec: ownPauses.length ? round(qualifyingOwnPauseDuration / ownPauses.length, 6) : null,
    };
  });
}

export function compareGoldDerived(matrixRows, goldRows) {
  const matrixBySpeaker = new Map(matrixRows.map((row) => [row.speaker, row]));
  const fields = [
    "active_vocal_duration_sec",
    "own_pause_labeled_duration_sec",
    "qualifying_own_pause_duration_sec",
    "own_pause_count",
    "mean_own_pause_sec",
  ];
  const comparisons = [];
  for (const gold of goldRows) {
    const observed = matrixBySpeaker.get(gold.speaker) ?? {};
    for (const field of fields) {
      const tolerance = field === "own_pause_count" ? 0 : field.endsWith("duration_sec") ? 0.0001 : 0.000001;
      const expectedValue = gold[field];
      const observedValue = observed[field];
      const delta = expectedValue === null || observedValue === null ? null : round(observedValue - expectedValue, 9);
      comparisons.push({
        speaker: gold.speaker,
        field,
        expected_gold_value: expectedValue,
        observed_matrix_value: observedValue,
        delta,
        tolerance,
        status: delta !== null && Math.abs(delta) <= tolerance ? "passed" : "failed",
        evidence_status: "gold_derived_independent_recalculation",
      });
    }
  }
  return comparisons;
}

export function validateMatrix(matrixRows, codebook) {
  const errors = [];
  const fields = codebook.map((field) => field.field_name);
  const uniqueFields = new Set(fields);
  if (uniqueFields.size !== fields.length) errors.push("Codebook contains duplicate field names");
  matrixRows.forEach((row, rowIndex) => {
    for (const field of codebook) {
      const value = row[field.field_name];
      if ((value === null || value === undefined || value === "") && !field.nullable) {
        errors.push(`row ${rowIndex + 1} ${field.field_name}: required value missing`);
        continue;
      }
      if (value === null || value === undefined || value === "") continue;
      if (["number", "integer"].includes(field.data_type) && !Number.isFinite(Number(value))) {
        errors.push(`row ${rowIndex + 1} ${field.field_name}: expected numeric value`);
      }
      if (field.data_type === "integer" && !Number.isInteger(Number(value))) {
        errors.push(`row ${rowIndex + 1} ${field.field_name}: expected integer value`);
      }
      if (field.data_type === "boolean" && typeof value !== "boolean") {
        errors.push(`row ${rowIndex + 1} ${field.field_name}: expected boolean value`);
      }
    }
  });
  return {
    status: errors.length ? "failed" : "passed",
    row_count: matrixRows.length,
    field_count: fields.length,
    errors,
  };
}

export function fieldProvenanceRows(codebook) {
  return codebook.map((field) => ({
    field_name: field.field_name,
    provenance_status: field.provenance_status,
    source: field.source,
    research_claim_ready: ["gold", "gold_derived", "system"].includes(field.provenance_status),
    client_definition_required: ["simulated", "mixed_provisional", "pending_client_input"].includes(
      field.provenance_status,
    ),
  }));
}
