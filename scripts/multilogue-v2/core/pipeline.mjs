import {
  CSV_SCHEMAS,
  SPEAKERS,
  canonicalJson,
  fixedThresholdKey,
  phonationIncluded,
  round,
  sha256,
} from './contracts.mjs';
import { runInteractionEngine } from './interaction-engine.mjs';
import { assignWordsByMaximumOverlap, mapAttributionTurns, validateMappingContract } from './mapping.mjs';
import { buildBaseActivityFrames, deriveSharedActivity, normalizeStage1Evidence } from './timeline.mjs';
import { buildSixTierTextGrid, serializeTextGrid } from './textgrid.mjs';
import { validateSixTierTextGrid } from './validator.mjs';

export function runMultilogueV2(input) {
  const duration = Number(input.duration);
  if (!(duration > 0)) throw new Error('duration must be positive');
  const thresholds = [...(input.thresholds || [0.25, 0.35])].map(Number);
  if (new Set(thresholds.map(fixedThresholdKey)).size !== thresholds.length) throw new Error('thresholds must be unique');
  const mapping = validateMappingContract(input.speakerMapping);
  const attribution = mapAttributionTurns(input.attributionTurns || [], mapping, { duration });
  const wordAssignment = assignWordsByMaximumOverlap(input.words || [], attribution.turns, mapping, { duration });
  const legacyBoundarySeed = normalizeLegacySeed(input.legacyBoundarySeed);
  const initialFlagContract = validateInitialFlags(input.initialFlags || [], {
    duration,
    stage1Evidence: input.stage1Evidence || [],
    stage1UnknownEvidence: input.stage1UnknownEvidence || [],
    providerOverlapEvidence: input.providerOverlapEvidence || [],
    providerOverlapCandidates: input.providerOverlapCandidates || [],
  });
  const outputs = {};

  for (const threshold of thresholds) {
    const key = fixedThresholdKey(threshold);
    const baseFrames = buildBaseActivityFrames(duration, input.roomSoundingIntervals || []);
    const sharedActivity = deriveSharedActivity(baseFrames, threshold, input.sharedActivityOptions);
    const stage1 = normalizeStage1Evidence(input.stage1Evidence || [], { duration });
    const interaction = runInteractionEngine({
      duration,
      sharedActivity,
      events: stage1.events,
      overlapEvidence: initialFlagContract.providerOverlapEvidence,
      initialFlags: [...attribution.flags, ...wordAssignment.flags, ...stage1.flags, ...initialFlagContract.flags],
      config: input.interactionConfig,
    });
    const textGridDocument = buildSixTierTextGrid(duration, interaction);
    const validation = validateSixTierTextGrid(textGridDocument);
    if (!validation.valid) throw new Error(`${key} validation failed: ${validation.errors.join('; ')}`);
    const manifest = buildManifest(input, threshold, legacyBoundarySeed, interaction);
    const rows = buildRows(input, threshold, interaction);
    const overlapCapabilityEvidence = buildOverlapCapabilityEvidence(
      input,
      threshold,
      attribution.turns,
      initialFlagContract.providerOverlapEvidence,
      interaction,
    );
    const textGrid = serializeTextGrid(textGridDocument);
    const packageWithoutDigest = {
      threshold_key: key,
      manifest,
      schemas: CSV_SCHEMAS,
      rows,
      overlap_capability_evidence: overlapCapabilityEvidence,
      path_b_counts: buildPathBCounts(interaction),
      interaction_diagnostics: interaction.diagnostics,
      textgrid_document: textGridDocument,
      textgrid: textGrid,
      validation,
    };
    outputs[key] = { ...packageWithoutDigest, digest: sha256(packageWithoutDigest) };
  }

  return {
    methodology_version: 'multilogue-v2-first-slice',
    reusable_inputs: {
      attribution_turn_count: attribution.turns.length,
      assigned_word_count: wordAssignment.words.filter((word) => word.speaker).length,
      unresolved_word_count: wordAssignment.words.filter((word) => !word.speaker).length,
      stage1_unknown_evidence_count: initialFlagContract.unknownEvidenceCount,
      initial_flag_input_count: initialFlagContract.inputCount,
      initial_flag_accepted_count: initialFlagContract.flags.length,
      initial_flag_duplicate_count: 0,
      provider_overlap_candidate_count: initialFlagContract.providerOverlapCount,
      provider_overlap_candidate_duration_sec: initialFlagContract.providerOverlapDuration,
      provider_overlap_raw_count: initialFlagContract.providerOverlapEvidence.length,
      provider_overlap_qualified_count: initialFlagContract.providerOverlapQualifiedCount,
      provider_overlap_qualified_duration_sec: initialFlagContract.providerOverlapQualifiedDuration,
      provider_overlap_subthreshold_count: initialFlagContract.providerOverlapSubthresholdCount,
      provider_overlap_subthreshold_duration_sec: initialFlagContract.providerOverlapSubthresholdDuration,
    },
    thresholds: outputs,
  };
}

function buildPathBCounts(interaction) {
  const candidates = interaction.diagnostics.floor_transfers || [];
  const sign = (value) => value == null || !Number.isFinite(Number(value))
    ? 'missing'
    : value < -1e-9 ? 'negative' : value > 1e-9 ? 'positive' : 'zero';
  const countSign = (items, expected) => items.filter((item) => sign(item.fto) === expected).length;
  return {
    candidate_positive: countSign(candidates, 'positive'),
    candidate_zero: countSign(candidates, 'zero'),
    candidate_negative: countSign(candidates, 'negative'),
    emitted_positive: countSign(interaction.transitions, 'positive'),
    emitted_zero: countSign(interaction.transitions, 'zero'),
    emitted_negative: countSign(interaction.transitions, 'negative'),
    emitted_missing: countSign(interaction.transitions, 'missing'),
    overlap_suppressed_qualified: interaction.transitions.filter((item) => item.status === 'overlap_present_offset_not_measured').length,
    overlap_suppressed_subthreshold: interaction.transitions.filter((item) => item.status === 'subthreshold_overlap_present_offset_not_measured').length,
    negative_withheld: countSign(candidates, 'negative') - countSign(interaction.transitions, 'negative'),
    manual_negative_fto_flags: interaction.flags.filter((flag) => flag.code === 'manual_negative_fto_required').length,
    path_b_transfer_review_flags: interaction.flags.filter((flag) => flag.code === 'path_b_transfer_review_required').length,
  };
}

export function validateInitialFlags(flags, {
  duration,
  stage1Evidence = [],
  stage1UnknownEvidence = [],
  providerOverlapEvidence = [],
  providerOverlapCandidates = [],
} = {}) {
  if (!Array.isArray(flags)) throw new Error('initialFlags must be an array');
  if (!Array.isArray(stage1Evidence) || !Array.isArray(stage1UnknownEvidence)
    || !Array.isArray(providerOverlapEvidence)
    || !Array.isArray(providerOverlapCandidates)) {
    throw new Error('stage1 evidence collections must be arrays');
  }
  const canonicalDuration = Number(duration);
  if (!(canonicalDuration > 0)) throw new Error('duration must be positive for initialFlags');

  const knownIds = new Set();
  for (const [index, event] of stage1Evidence.entries()) {
    const id = String(event?.id ?? '');
    if (!id) throw new Error(`stage1Evidence[${index}] requires id`);
    if (knownIds.has(id)) throw new Error(`stage1 evidence id is not unique: ${id}`);
    if (event.evidence_state === 'unknown' || event.provisional_kind === 'unknown') {
      throw new Error(`${id} is unknown residual evidence and cannot enter the floor event stream`);
    }
    knownIds.add(id);
  }
  const unknownIds = new Set();
  for (const [index, event] of stage1UnknownEvidence.entries()) {
    const id = String(event?.id ?? '');
    if (!id) throw new Error(`stage1UnknownEvidence[${index}] requires id`);
    if (unknownIds.has(id) || knownIds.has(id)) throw new Error(`stage1 evidence id is not unique: ${id}`);
    if (event.evidence_state !== 'unknown' || event.provisional_kind !== 'unknown') {
      throw new Error(`${id} must remain unknown residual evidence outside the floor event stream`);
    }
    const start = Number(event.start);
    const end = Number(event.end);
    if (!SPEAKERS.includes(event.speaker) || !Number.isFinite(start) || !Number.isFinite(end)
      || !(end > start) || start < 0 || end > canonicalDuration + 1e-9) {
      throw new Error(`${id} has invalid canonical unknown-residual bounds`);
    }
    unknownIds.add(id);
  }

  const structuredOverlap = providerOverlapEvidence.length > 0;
  const overlapInput = structuredOverlap
    ? providerOverlapEvidence
    : providerOverlapCandidates.map((candidate) => ({
      ...candidate,
      overlap_class: 'qualified',
      evidence_source: candidate.evidence_source || candidate.provider || 'legacy_provider_overlap_candidate',
      source_turn_ids: candidate.source_turn_ids || [],
    }));
  const overlapIds = new Set();
  const normalizedOverlapEvidence = [];
  let providerOverlapQualifiedDuration = 0;
  let providerOverlapSubthresholdDuration = 0;
  for (const [index, candidate] of overlapInput.entries()) {
    const id = String(candidate?.id ?? '');
    const start = Number(candidate?.start);
    const end = Number(candidate?.end);
    const overlapClass = String(candidate?.overlap_class ?? '');
    const sourceTurnIds = Array.isArray(candidate?.source_turn_ids)
      ? [...new Set(candidate.source_turn_ids.map(String))].sort()
      : [];
    if (!id || overlapIds.has(id) || knownIds.has(id) || unknownIds.has(id)) {
      throw new Error(`providerOverlapEvidence[${index}] has a missing or duplicate id`);
    }
    if (!Array.isArray(candidate.speakers) || candidate.speakers.length !== 2
      || candidate.speakers[0] === candidate.speakers[1]
      || candidate.speakers.some((speaker) => !SPEAKERS.includes(speaker))) {
      throw new Error(`${id} must identify two distinct canonical speakers`);
    }
    const durationSeconds = end - start;
    if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0
      || end > canonicalDuration + 1e-9 || !(durationSeconds > 0)
      || !['qualified', 'subthreshold'].includes(overlapClass)
      || (overlapClass === 'qualified' && durationSeconds < 0.1 - 1e-9)
      || (overlapClass === 'subthreshold' && durationSeconds >= 0.1 - 1e-9)
      || (structuredOverlap && sourceTurnIds.length < 2)) {
      throw new Error(`${id} has an invalid structured provider overlap contract`);
    }
    overlapIds.add(id);
    const normalized = {
      id,
      start: round(start),
      end: round(end),
      duration_seconds: round(durationSeconds),
      speakers: [...candidate.speakers].sort(),
      source_turn_ids: sourceTurnIds,
      overlap_class: overlapClass,
      provider: String(candidate.provider || 'unknown'),
      evidence_source: String(candidate.evidence_source || candidate.provider || 'provider_overlap'),
      evidence_status: String(candidate.evidence_status || 'candidate_requires_review'),
    };
    normalizedOverlapEvidence.push(normalized);
    if (overlapClass === 'qualified') providerOverlapQualifiedDuration += durationSeconds;
    else providerOverlapSubthresholdDuration += durationSeconds;
  }
  const qualifiedIds = new Set(normalizedOverlapEvidence.filter((item) => item.overlap_class === 'qualified').map((item) => item.id));
  for (const candidate of providerOverlapCandidates) {
    if (!qualifiedIds.has(String(candidate.id))) throw new Error(`qualified provider overlap candidate is absent from structured evidence: ${candidate.id}`);
  }

  const normalized = [];
  const keys = new Set();
  const relatedUnknownIds = new Set();
  const relatedOverlapIds = new Set();
  for (const [index, flag] of flags.entries()) {
    if (!flag || typeof flag !== 'object' || Array.isArray(flag)) {
      throw new Error(`initialFlags[${index}] must be an object`);
    }
    const start = Number(flag.start);
    const end = Number(flag.end);
    if (!Number.isFinite(start) || !Number.isFinite(end) || !(end > start)) {
      throw new Error(`initialFlags[${index}] must have a positive finite interval`);
    }
    if (start < 0 || end > canonicalDuration + 1e-9) {
      throw new Error(`initialFlags[${index}] is outside canonical duration`);
    }
    const code = safeToken(flag.code, `initialFlags[${index}].code`);
    const severity = safeToken(flag.severity, `initialFlags[${index}].severity`);
    const source = safeToken(flag.source, `initialFlags[${index}].source`);
    const relatedId = flag.related_id == null ? '' : safeToken(flag.related_id, `initialFlags[${index}].related_id`);
    const item = {
      start: round(start),
      end: round(end),
      code,
      severity,
      source,
      related_id: relatedId,
    };
    const key = canonicalJson(item);
    if (keys.has(key)) throw new Error(`initialFlags contains duplicate evidence at index ${index}`);
    keys.add(key);
    normalized.push(item);
    if (unknownIds.has(relatedId)) relatedUnknownIds.add(relatedId);
    if (overlapIds.has(relatedId)) {
      const overlapClass = normalizedOverlapEvidence.find((item) => item.id === relatedId)?.overlap_class;
      const expectedCode = overlapClass === 'qualified' ? 'provider_overlap_candidate' : 'provider_subthreshold_overlap';
      if (code === expectedCode) relatedOverlapIds.add(relatedId);
    }
  }

  for (const id of unknownIds) {
    if (!relatedUnknownIds.has(id)) throw new Error(`unknown residual ${id} has no initial review flag`);
  }
  for (const id of overlapIds) {
    if (!relatedOverlapIds.has(id)) throw new Error(`provider overlap candidate ${id} has no review flag`);
  }
  normalized.sort((left, right) => left.start - right.start || left.end - right.end
    || left.code.localeCompare(right.code) || left.related_id.localeCompare(right.related_id));
  return {
    flags: normalized,
    inputCount: flags.length,
    unknownEvidenceCount: unknownIds.size,
    // Preserve the pre-v2.1 candidate fields as qualified-only compatibility aliases.
    providerOverlapCount: normalizedOverlapEvidence.filter((item) => item.overlap_class === 'qualified').length,
    providerOverlapDuration: round(providerOverlapQualifiedDuration),
    providerOverlapQualifiedCount: normalizedOverlapEvidence.filter((item) => item.overlap_class === 'qualified').length,
    providerOverlapQualifiedDuration: round(providerOverlapQualifiedDuration),
    providerOverlapSubthresholdCount: normalizedOverlapEvidence.filter((item) => item.overlap_class === 'subthreshold').length,
    providerOverlapSubthresholdDuration: round(providerOverlapSubthresholdDuration),
    providerOverlapEvidence: normalizedOverlapEvidence,
  };
}

function buildManifest(input, threshold, legacyBoundarySeed, interaction) {
  return {
    methodology_version: 'multilogue-v2-first-slice',
    recording_id: safeIdentifier(input.recordingId ?? 'synthetic-recording', 'recordingId'),
    task_id: safeIdentifier(input.taskId ?? 'synthetic-task', 'taskId'),
    threshold_sec: round(threshold),
    frame_step_sec: 0.01,
    floor_release_sec: interaction.settings.floorReleaseSeconds,
    minimum_overlap_sec: interaction.settings.minOverlapSeconds,
    overlap_mode: interaction.settings.overlapMode,
    overlap_association_tolerance_sec: interaction.settings.overlapAssociationToleranceSeconds,
    stage_ownership: {
      phase_i: ['stage1_evidence', 'stage2_floor', 'stage3_nine_labels', 'provisional_fto'],
      phase_ii: ['threshold_parameters', 'independent_threshold_runs', 'multi_threshold_outputs'],
    },
    downstream_handoff: {
      nine_label_intervals: 'phase_iv',
      signed_fto: 'phase_v_only',
    },
    execution_chain: ['shared_activity', 'floor', 'labels', 'provisional_fto', 'validate', 'package'],
    shared_activity_summary: interaction.diagnostics.shared_activity_summary,
    legacy_boundary_seed: legacyBoundarySeed,
  };
}

function buildRows(input, threshold, interaction) {
  const recordingId = safeIdentifier(input.recordingId ?? 'synthetic-recording', 'recordingId');
  const taskId = safeIdentifier(input.taskId ?? 'synthetic-task', 'taskId');
  const overlapFlag = (start, end) => interaction.flags.some((flag) => flag.start < end && flag.end > start);
  const nineLabelRows = [];
  for (const speaker of SPEAKERS) {
    for (const interval of interaction.speakerTiers[speaker]) {
      nineLabelRows.push({
        recording_id: recordingId,
        task_id: taskId,
        threshold_sec: round(threshold),
        speaker,
        start_sec: interval.start,
        end_sec: interval.end,
        duration_sec: round(interval.end - interval.start),
        label: interval.text,
        floor: interval.floor,
        phonation_included_default: phonationIncluded(interval.text),
        review_required: overlapFlag(interval.start, interval.end),
      });
    }
  }
  const summaryRows = SPEAKERS.map((speaker) => {
    const metric = interaction.metrics[speaker];
    return {
      recording_id: recordingId,
      task_id: taskId,
      threshold_sec: round(threshold),
      speaker,
      total_duration_sec: metric.total_duration,
      phonation_time_sec: metric.phonation_time,
      ...Object.fromEntries(Object.entries(metric.label_seconds).map(([label, seconds]) => [`${label}_sec`, seconds])),
      op_count: metric.label_counts.op,
      bc_count: metric.label_counts.bc,
      ol_count: metric.label_counts.ol,
      floor_turns_held: metric.floor_turns_held,
      incoming_fto_values: metric.incoming_fto_values,
    };
  });
  const ftoRows = interaction.transitions.map((transition) => ({
    recording_id: recordingId,
    task_id: taskId,
    threshold_sec: round(threshold),
    sequence: transition.sequence,
    from_speaker: transition.from,
    to_speaker: transition.to,
    outgoing_offset_sec: transition.outgoing_offset,
    incoming_onset_sec: transition.incoming_onset,
    fto_sec: transition.fto,
    sign: transition.sign || (transition.fto < 0 ? 'negative' : transition.fto > 0 ? 'positive' : 'zero'),
    status: transition.status,
    review_required: transition.review_required,
  }));
  const flagRows = interaction.flags.map((flag) => ({
    recording_id: recordingId,
    task_id: taskId,
    threshold_sec: round(threshold),
    start_sec: flag.start,
    end_sec: flag.end,
    duration_sec: round(flag.end - flag.start),
    code: flag.code,
    severity: flag.severity,
    source: flag.source,
    related_id: flag.related_id,
  }));
  return {
    nine_label_intervals: nineLabelRows,
    interaction_summary: summaryRows,
    fto_transitions: ftoRows,
    transition_evidence: interaction.transitionEvidence.map((evidence) => ({
      recording_id: recordingId,
      task_id: taskId,
      threshold_sec: round(threshold),
      sequence: evidence.sequence,
      from_speaker: evidence.from,
      to_speaker: evidence.to,
      turn_end_sec: evidence.turn_end,
      turn_start_sec: evidence.turn_start,
      raw_gap_sec: evidence.raw_gap,
      overlap_start_sec: evidence.overlap_start,
      overlap_end_sec: evidence.overlap_end,
      overlap_duration_sec: evidence.overlap_duration,
      overlap_class: evidence.overlap_class,
      evidence_source: evidence.evidence_source,
      evidence_ids: evidence.evidence_ids,
      fto_status: evidence.fto_status,
      review_required: evidence.review_required,
    })),
    flags: flagRows,
  };
}

function buildOverlapCapabilityEvidence(input, threshold, mappedTurns, overlapEvidence, interaction) {
  const durationByClass = (overlapClass) => round(overlapEvidence
    .filter((item) => item.overlap_class === overlapClass)
    .reduce((sum, item) => sum + Number(item.duration_seconds), 0));
  return {
    contract_version: 'path-b-v2.1-overlap-capability-evidence-v1',
    recording_id: safeIdentifier(input.recordingId ?? 'synthetic-recording', 'recordingId'),
    task_id: safeIdentifier(input.taskId ?? 'synthetic-task', 'taskId'),
    threshold_sec: round(threshold),
    status: 'uncalibrated_draft',
    accuracy: 'unavailable',
    provider_mode: interaction.settings.overlapMode,
    minimum_overlap_sec: interaction.settings.minOverlapSeconds,
    association_tolerance_sec: interaction.settings.overlapAssociationToleranceSeconds,
    metrics: {
      raw_count: overlapEvidence.length,
      raw_duration_sec: round(overlapEvidence.reduce((sum, item) => sum + Number(item.duration_seconds), 0)),
      qualified_count: overlapEvidence.filter((item) => item.overlap_class === 'qualified').length,
      qualified_duration_sec: durationByClass('qualified'),
      subthreshold_count: overlapEvidence.filter((item) => item.overlap_class === 'subthreshold').length,
      subthreshold_duration_sec: durationByClass('subthreshold'),
    },
    mapped_attribution_turns: mappedTurns.map((turn) => ({
      id: turn.id,
      speaker: turn.speaker,
      start_sec: turn.start,
      end_sec: turn.end,
      confidence: turn.confidence,
    })),
    overlap_evidence: overlapEvidence,
    recomputation_contract: {
      provider_rerun_required: false,
      path_a_candidate_formula: 'turn_start_sec_minus_turn_end_sec',
      research_validation_required: true,
    },
  };
}

function normalizeLegacySeed(seed = {}) {
  const enabled = seed.enabled === true;
  return {
    enabled,
    identifier: enabled ? safeIdentifier(seed.identifier, 'legacyBoundarySeed.identifier') : null,
    checksum: enabled ? safeChecksum(seed.checksum) : null,
    candidate_only: true,
    semantic_import: false,
    used_by_core: false,
  };
}

function safeIdentifier(value, field) {
  const text = String(value ?? '');
  if (!/^[A-Za-z0-9._-]+$/.test(text)) throw new Error(`${field} must be an opaque identifier without a path`);
  return text;
}

function safeChecksum(value) {
  const text = String(value ?? '');
  if (!/^[a-f0-9]{64}$/i.test(text)) throw new Error('legacyBoundarySeed.checksum must be SHA-256 hex');
  return text.toLowerCase();
}

function safeToken(value, field) {
  const text = String(value ?? '');
  if (!/^[A-Za-z0-9._:>-]+$/.test(text)) throw new Error(`${field} must be a safe non-empty token`);
  return text;
}

export function deterministicDigest(value) {
  return sha256(canonicalJson(value));
}
