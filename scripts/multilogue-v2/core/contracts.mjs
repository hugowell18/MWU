import { createHash } from 'node:crypto';

export const SPEAKERS = Object.freeze(['S1', 'S2', 'S3']);
export const SPEAKER_LABELS = Object.freeze(['s', 'f', 'bc', 'ol', 'op', 'pf', 'tr', 'shs', 'x']);
export const FLOOR_LABELS = Object.freeze([...SPEAKERS, 'FREE']);
export const PROVISIONAL_KINDS = Object.freeze(['vocalisation', 'laughter', 'artifact']);
export const LEXICAL_CLASSES = Object.freeze(['lexical', 'filled_pause', 'nonlexical', 'unknown']);
export const FRAME_STEP_SECONDS = 0.01;
export const EPSILON = 1e-9;
export const OVERLAP_CLASSES = Object.freeze(['qualified', 'subthreshold', 'none']);
export const FTO_STATUSES = Object.freeze([
  'provisional',
  'overlap_present_offset_not_measured',
  'subthreshold_overlap_present_offset_not_measured',
]);

export const CSV_SCHEMAS = Object.freeze({
  nine_label_intervals: Object.freeze([
    'recording_id', 'task_id', 'threshold_sec', 'speaker', 'start_sec', 'end_sec', 'duration_sec',
    'label', 'floor', 'phonation_included_default', 'review_required',
  ]),
  interaction_summary: Object.freeze([
    'recording_id', 'task_id', 'threshold_sec', 'speaker', 'total_duration_sec', 'phonation_time_sec',
    's_sec', 'f_sec', 'bc_sec', 'ol_sec', 'op_sec', 'pf_sec', 'tr_sec', 'shs_sec', 'x_sec',
    'op_count', 'bc_count', 'ol_count', 'floor_turns_held', 'incoming_fto_values',
  ]),
  fto_transitions: Object.freeze([
    'recording_id', 'task_id', 'threshold_sec', 'sequence', 'from_speaker', 'to_speaker',
    'outgoing_offset_sec', 'incoming_onset_sec', 'fto_sec', 'sign', 'status', 'review_required',
  ]),
  transition_evidence: Object.freeze([
    'recording_id', 'task_id', 'threshold_sec', 'sequence', 'from_speaker', 'to_speaker',
    'turn_end_sec', 'turn_start_sec', 'raw_gap_sec', 'overlap_start_sec', 'overlap_end_sec',
    'overlap_duration_sec', 'overlap_class', 'evidence_source', 'evidence_ids', 'fto_status',
    'review_required',
  ]),
  flags: Object.freeze([
    'recording_id', 'task_id', 'threshold_sec', 'start_sec', 'end_sec', 'duration_sec',
    'code', 'severity', 'source', 'related_id',
  ]),
});

export function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

export function round(value, digits = 6) {
  const factor = 10 ** digits;
  return Math.round((Number(value) + Number.EPSILON) * factor) / factor;
}

export function normalizeConfidence(value) {
  if (value === null || value === undefined || value === '') return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

export function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
  }
  return value;
}

export function canonicalJson(value) {
  return `${JSON.stringify(canonicalize(value), null, 2)}\n`;
}

export function sha256(value) {
  return createHash('sha256').update(typeof value === 'string' ? value : canonicalJson(value)).digest('hex');
}

export function sortedUnique(values) {
  return [...new Set(values.filter(Boolean).map(String))].sort((a, b) => a.localeCompare(b));
}

export function phonationIncluded(label, includeBackchannels = false) {
  return label === 's' || label === 'f' || label === 'ol' || (includeBackchannels && label === 'bc');
}

export function fixedThresholdKey(threshold) {
  return `P${Math.round(Number(threshold) * 1000).toString().padStart(3, '0')}`;
}
