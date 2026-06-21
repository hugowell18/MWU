// Phase V — build the validation matrix per the client column families.
// Cols 1-7 = 0.25 (gold replay), 8-14 = 0.35 (generated, no gold),
// 15+ = reserved Phase IV text variables (pending_not_implemented, never fabricated).
import { articulationRate } from './durations.mjs';

const PENDING = 'pending_not_implemented';

const COLS_025 = [
  'Total_Pauses_Between_AS_Units_025',
  'Mean_Duration_Pauses_Between_AS_Units_025',
  'Total_Pauses_Within_AS_Units_025',
  'Mean_Duration_Pauses_Within_AS_Units_025',
  'Pause_Density_Per_Minute_025',
  'Articulation_Rate_025',
  'Mean_Of_Silent_Pauses_025',
];
const COLS_035 = COLS_025.map((c) => c.replace(/_025$/, '_035'));

// Reserved Phase IV computational text variables (placeholders only).
const PHASE_IV_COLS = [
  'TAALES_Word_Frequency_Mean',
  'TAALES_Lexical_Decision_Mean',
  'TAALES_MWU_Proportion_Top30k',
  'TAALED_MTLD',
  'TAALED_MATTR',
  'AntConc_LB4_Count',
  'AntConc_LB_Range',
  'AntConc_LB_MI_Mean',
];

const round = (x) => Math.round(x * 1e6) / 1e6;
const density = (agg) => agg.silent_count / (agg.total_sounding / 60); // pauses / speaking-minute

export function matrixColumns() {
  return ['recording_id', 'speaker_id', ...COLS_025, ...COLS_035, ...PHASE_IV_COLS, 'group_status_025', 'group_status_035'];
}

export function buildMatrix({ recordingId, speaker, replay025, generated035, syllables }) {
  const row = { recording_id: recordingId, speaker_id: speaker };

  // 0.25 — from the expert TextGrid (gold replay). AS-unit splits need Layer 2 → pending.
  row.Total_Pauses_Between_AS_Units_025 = PENDING;
  row.Mean_Duration_Pauses_Between_AS_Units_025 = PENDING;
  row.Total_Pauses_Within_AS_Units_025 = PENDING;
  row.Mean_Duration_Pauses_Within_AS_Units_025 = PENDING;
  row.Pause_Density_Per_Minute_025 = round(density(replay025));
  row.Articulation_Rate_025 = syllables ? round(articulationRate(syllables, replay025.total_sounding)) : PENDING;
  row.Mean_Of_Silent_Pauses_025 = round(replay025.mean_silent);

  // 0.35 — from generated draft (no gold). AS-unit splits pending.
  const has035 = !!generated035;
  row.Total_Pauses_Between_AS_Units_035 = PENDING;
  row.Mean_Duration_Pauses_Between_AS_Units_035 = PENDING;
  row.Total_Pauses_Within_AS_Units_035 = PENDING;
  row.Mean_Duration_Pauses_Within_AS_Units_035 = PENDING;
  row.Pause_Density_Per_Minute_035 = has035 ? round(density(generated035)) : PENDING;
  row.Articulation_Rate_035 = has035 && syllables ? round(articulationRate(syllables, generated035.total_sounding)) : PENDING;
  row.Mean_Of_Silent_Pauses_035 = has035 ? round(generated035.mean_silent) : PENDING;

  for (const c of PHASE_IV_COLS) row[c] = PENDING;

  row.group_status_025 = 'gold_replay';
  row.group_status_035 = has035 ? 'generated_no_gold' : 'blocked_no_praat';

  return { columns: matrixColumns(), row };
}
