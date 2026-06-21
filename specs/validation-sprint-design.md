# Validation Sprint — Design

> **Superseded planning note, 2026-06-21:** The controlling PRD is now `docs/PRD-Validation-Sprint-Monologue-Benchmark.md` v0.3. Implement a standalone **Validation** entry with one `Run Validation` workflow. During the run, show pipeline progress through Phase II -> Phase III -> Phase IV -> Phase V, then show ours-vs-expected comparison and downloads. Phase I-V cards are preview/context only.

Implements `validation-sprint-requirements.md` and the controlling PRD v0.2. Stack: Node ESM (`.mjs`) pipeline + Praat headless for silence generation + React/Vite console reading real artifacts via a tiny Node server.

Design correction: Phase II is not just "gold replay". The client workflow is Script 1 Praat intensity extraction followed immediately by Script 2 segment-duration calculation. Gold replay is a validation check, not the primary workflow.

## 1. Module map

```
scripts/validation-sprint/
  config.mjs            # thresholds_sec [0.25,0.35], praat_window_sec 200, tolerances, praat params, paths
  lib/
    textgrid.mjs        # parseTextGrid(text) -> {xmin,xmax,tiers:[{name,intervals:[{xmin,xmax,text}]}]}; serialize
    durations.mjs       # Script 2 implementation/parity core: segment durations + aggregate by label
    excel-baseline.mjs  # readBaseline(xlsx) -> SpeakerX col B KPIs from "Fluency measures"; has035Gold=false
    comparator.mjs      # compare(computed, baseline, tol) -> rows[{metric,ours,gold,delta,tol,status}]
    transcript-split.mjs# splitTranscript(text) -> {raw, tidy, log[]}
    matrix.mjs          # buildMatrix(replay025, generated035, syllables) -> {columns[], row{}}
    praat.mjs           # run Script 1 and Script 2 wrappers via Praat --run; praatAvailable()
    xlsxio.mjs          # writeXlsx/writeCsv helpers (exceljs)
    fsutil.mjs          # ensureDir, writeJson, sha256, fileInfo
  praat/
    silences.praat      # headless: Read wav -> To TextGrid (silences) -> Save as text file
  run-sprint.mjs        # orchestrator (CLI): full run from sample
  server.mjs            # Node http: serves console build + /api/{report,artifacts,run,file}
tests/validation-sprint/
  run-tests.mjs         # unit + integration; writes *-test-results.json
src/components/validation/   # React console (LDT style), independent Vite entry
validation.html              # Vite entry mounting ValidationConsole only (no auth/Supabase)
src/validation-main.tsx
```

## 2. Data contracts

### TextGrid parse result
`{ xmin:number, xmax:number, tiers:[{ name:string, xmin, xmax, intervals:[{xmin,xmax,text}] }] }`

### durations aggregate (per tier)
```
{ total_duration, sounding_count, silent_count, total_sounding, total_silent,
  mean_silent, max_silent, min_silent, segments:[{label,start,end,duration}] }
```
`silent_count` / `total_silent` count **all** intervals labelled `silent` (no threshold re-filter).

### baseline (from workbook, SpeakerX col B)
```
{ total_audio, phonation_time, speaking_time, speaking_min, syllables,
  silent_pauses, mean_silent_pause, total_silent_pausing, mid_clause, end_clause,
  repairs, articulation_rate, has_035_gold:false, sheets:["Durations","Fluency measures"] }
```

### validation_report.json (the contract the WebUI reads)
```
{
  sprint, recording_id:"8_STEM_SpeakerX", speaker:"SpeakerX", generated_at,
  phase_i:{ status:"skipped", reason:"monologue" },
  inputs:[{ name, path, present, bytes, sha256 }],
  config:{ thresholds_sec:[0.25,0.35], tolerances:{...}, praat:{...} },
  praat:{ available:bool, status:"ok"|"blocked", binary },
  phase_ii:{
    script1:{ thresholds:[{ threshold, textgrid, method, scale_times, label_contract }] },
    script2:{ thresholds:[{ threshold, durations_csv, durations_json, summary_json, totals }] },
    gold_replay:{ status:"passed"|"failed", rows:[{metric,ours,gold,delta,tolerance,pass}] },
    generated_vs_expert_025:{ status, rows:[...] },
    thresholds:[{ threshold, kind:"gold"|"generated_no_gold", status,
                  textgrid, durations:{...}, full_timeline_ok:bool }]
  },
  phase_iii:{ status, raw_file, tidy_file, report_file, transforms:int },
  phase_v:{ status, xlsx, csv, columns:[...], row:{...} },
  artifacts:[{ name, path, kind, bytes }],
  tests:{ unit:{passed,failed}, integration:{passed,failed}, ui:{passed,failed} },
  readiness:"ready"|"blocked"|"ready_with_caveats",
  limitations:[...]
}
```

## 3. Phase II flow

1. **Script 1 (generate):** for each `t` in `thresholds_sec`, run the Praat intensity/silence extraction wrapper and write `threshold_t/generated.TextGrid`. Log `threshold`, `praat_window_sec`, `silence_threshold_db`, `min_sounding_interval`, Praat version, and Scale Times/full-timeline status.
2. **Scale Times / full timeline:** for the monologue, record `mode=not_required_full_wav` and assert generated `xmin/xmax` matches the WAV duration. For later Phase I isolated tracks, this step must map output intervals back to the master timeline.
3. **Script 2 (segment durations):** immediately run automated `calculate_segment_durations.praat`, or a parity-tested CLI equivalent explicitly labeled as equivalent, for each generated TextGrid. Write `script2_segment_durations.{csv,json}` and `script2_summary.json`.
4. **Gold replay:** run the same Script 2 path on the expert TextGrid and compare 0.25 values with the workbook. This validates arithmetic only.
5. **Generated 0.25 diagnostic:** compare generated 0.25 against expert TextGrid and report differences separately. Do not collapse this with gold replay PASS.
6. **0.35:** run Script 1 + Script 2, populate generated outputs, mark `generated_no_gold`.

**Articulation rate** = `syllables / (speaking_time/60)`. Gold replay uses supplied syllables (535) and our `total_sounding` (=speaking_time) → compared to baseline `articulation_rate`.

## 4. Praat silences.praat (headless)

`form` args (filled positionally by `praat --run`): `wav_path$`, `out_path$`, `min_silent_interval`, `silence_threshold_db`, `min_sounding_interval`, `min_pitch`.
Body: `Read from file: wav_path$` → Praat intensity/silence extraction → optional Scale Times/full-timeline mapping → `Save as text file: out_path$`. The monologue run can record Scale Times as `not_required_full_wav`, but it must still log the full-timeline assertion. Defaults must include `praat_window_sec=200`, `silence_threshold_db`, `min_sounding_interval`, and `min_pitch`.

> Generated segmentation may differ from the expert's manually corrected TextGrid. Generated 0.25 must be reported diagnostically; gold replay only proves the duration calculation reproduces the workbook from the expert TextGrid.

## 5. Phase III split

- RAW = original text, trimmed, with internal structure preserved (sentences kept, fillers/repetitions/false starts/`X` retained).
- TIDY = RAW with: whitespace normalized; non-lexical fillers removed from a configurable list (`uh, um, uhm, er, erm, mm, hmm, mhm, [laughter], (laughs)`); meaningful repetitions/reformulations preserved. Each removal/normalization recorded in `log[]`. (The pruned sample has no such fillers → log records "0 fillers removed; whitespace normalized".)
- `transcript_split_report.json`: word counts (raw/tidy), removed tokens, transforms, char deltas.

## 6. Phase V matrix

One row (`SpeakerX`). Columns in exact order 1–14 then 15+ placeholders. Population:

| col | source | value type |
|---|---|---|
| `Mean_Of_Silent_Pauses_025` | gold replay mean_silent | real (=0.833) |
| `Pause_Density_Per_Minute_025` | silent_count / (speaking_time/60) | real |
| `Articulation_Rate_025` | 535 / speaking_min | real (=240.997) |
| `*_Between/Within_AS_Units_025` | workbook/manual baseline unless automatic AS-unit rules are supplied | real with source metadata / pending |
| `*_035` group | generated 0.35 draft; AS-unit ones need definitions | generated_no_gold / pending_definition |
| cols 15+ (TAALES/TAALED/AntConc) | not implemented | `pending_not_implemented` |

The XLSX `Summary` sheet records provenance, threshold source per column, and a `group_status` per threshold (`025=gold_replay`, `035=generated_no_gold`).

## 7. WebUI

`src/components/validation/`: `ValidationConsole.tsx` (fetches `/api/report`), `FileChecklist.tsx`, `ThresholdConfig.tsx`, `RunStepper.tsx`, `MetricComparisonTable.tsx`, `TranscriptSplitPanel.tsx`, `MatrixPanel.tsx`, `ArtifactDownloads.tsx`, `StatusBadge.tsx` (the 8 states). Tailwind, LDT slate/blue. Independent Vite entry `validation.html` mounts only the console (no auth/Supabase) so it builds without env. `server.mjs` serves the built assets + `/api/report` (reads `validation_report.json`), `/api/run` (spawns `run-sprint.mjs`), `/api/file?path=` (artifact download, sandboxed to the output dir). When no run exists, report endpoint returns `{readiness:"idle"}` and the UI shows `ready`/`idle`, never PASS.

## 8. Tests

`tests/validation-sprint/run-tests.mjs` (node, no external test runner): asserts the unit + integration cases from requirements §9 and the goal doc, writing `unit-test-results.json` and `integration-test-results.json` with `{passed,failed,cases:[{name,status,detail}]}`. UI tests are a separate headless-Chrome screenshot harness writing `ui-test-results.json`.

## 9. Failure handling

- Missing input → `blocked`, report names file, exit non-zero in strict mode.
- Comparator mismatch → `failed` row(s), `gold_replay.status="failed"`, never silently passed.
- Praat missing → thresholds `blocked`; gold replay still runs and can still pass; readiness `ready_with_caveats`.
