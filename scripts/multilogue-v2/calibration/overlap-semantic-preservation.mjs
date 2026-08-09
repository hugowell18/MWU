export const OVERLAP_SEMANTIC_PRESERVATION_POLICIES = Object.freeze([
  'all',
  'concurrent_or_question',
  'concurrent_question_or_prior',
]);

export function selectOverlapCorroboratedBackchannels(runtimeEvidence, policy) {
  if (!OVERLAP_SEMANTIC_PRESERVATION_POLICIES.includes(policy)) {
    throw new Error(`unsupported preservation policy: ${policy}`);
  }
  const retained = new Set((runtimeEvidence.adapter_provenance?.residual_identity || [])
    .filter((item) => item.retention_reason === 'qualified_provider_overlap_corroborates_identity_tied_residual')
    .map((item) => item.event_id));
  const questions = (runtimeEvidence.speaker_attribution_disagreements || [])
    .filter((item) => item.short_explicit_question === true);
  return (runtimeEvidence.pre_floor_backchannels || [])
    .filter((item) => retained.has(item.event_id))
    .filter((item) => {
      if (policy === 'all') return true;
      if (item.support_kind === 'concurrent_holder_vocalisation') return true;
      if (policy === 'concurrent_question_or_prior' && item.support_kind === 'prior_floor_holder_continues') {
        return true;
      }
      return item.support_kind === 'recent_holder_within_L'
        && questions.some((question) => question.selected_speaker === item.speaker
          && Number(question.start) >= Number(item.end)
          && Number(question.start) - Number(item.end) <= 0.5 + 1e-9);
    })
    .map((item) => ({
      evidence_id: item.event_id,
      speaker: item.speaker,
      start: Number(item.start),
      end: Number(item.end),
      label: 'bc',
    }));
}
