# Validation Sprint — Task Plan

> **Superseded planning note, 2026-06-21:** The controlling PRD is now `docs/PRD-Validation-Sprint-Monologue-Benchmark.md` v0.3. Do not treat this task plan as sufficient if it conflicts with the standalone Validation UI, one-click validation run, Phase II -> Phase III -> Phase IV -> Phase V pipeline progress, final comparison view, and downloads described in the PRD.

Ordered, with acceptance per task. Tracks the implementation of `validation-sprint-design.md`.

## T1 — Specs (this gate) ✅
Three docs in `specs/`. **Accept:** files exist and align with PRD v0.2: Phase I skip, Phase II Script 1 + Script 2, configurable thresholds, `praat_window_sec=200`, Scale Times/full-timeline logging, `sounding/silent/invalid` label contract, Phase III, Phase V (0.25/0.35 + Phase IV placeholders), WebUI, tests, gates.

## T2 — Pipeline libs
`config.mjs`, `lib/textgrid.mjs`, `lib/durations.mjs`, `lib/excel-baseline.mjs`, `lib/comparator.mjs`, `lib/fsutil.mjs`, `lib/xlsxio.mjs`.
**Accept (unit):** parse expert TextGrid → tier=1 name=`silences`, intervals=121, sounding=61, silent=60, total_sounding=133.19652983384853±1e-3, total_silent=49.98269919109479±1e-3, total_duration=183.1792290249433±1e-3. No-refilter: silent stays 60 with a 0.2468 s interval. Excel reader: sheets detected; col B KPIs read; Y/Z ignored; has_035_gold=false.

## T3 — Praat Script 1 + Script 2 + Phase III + Phase V
`praat/silences.praat`, `lib/praat.mjs`, `lib/transcript-split.mjs`, `lib/matrix.mjs`.
**Accept:** Script 1 generates `threshold_0.25/generated.TextGrid` and `threshold_0.35/generated.TextGrid` covering full timeline (xmax≈183.179); thresholds from a configurable array; `[0.2,0.25,0.35]` does not crash; `praat_window_sec=200` is present in config and method logs; Scale Times/full-timeline status is logged. Generated output supports the `sounding/silent/invalid` label contract, with `invalid_count=0` for the monologue. Script 2 runs automated `calculate_segment_durations.praat` or a parity-tested labeled equivalent and writes `script2_segment_durations.{csv,json}` plus `script2_summary.json` per threshold. Transcript split: RAW + TIDY non-empty + log. Matrix: 0.25/0.35/Phase IV column groups written; 0.35 status not `matched`.

## T4 — Orchestrator + reports
`run-sprint.mjs`, `server.mjs`.
**Accept:** `node scripts/validation-sprint/run-sprint.mjs` produces the full `outputs/validation-sprint/8_STEM_SpeakerX/` tree: input-manifest.json, config.snapshot.json, phase-ii/{threshold_0.25,threshold_0.35}, phase-iii/*, phase-v/*, validation/{speakerx_025_baseline_comparison.*, generated_vs_expert_025.json, validation_report.md, validation_report.json}, logs/{method_log.json, praat_script1_run.log, praat_script2_run.log}. Expert TextGrid replay 0.25 = passed; generated 0.25 diagnostic is reported separately; 0.35 = generated_no_gold; Phase I = skipped; no Y/Z artifacts.

## T5 — Tests
`tests/validation-sprint/run-tests.mjs`.
**Accept:** unit cases (TextGrid parser, no-refilter, excel reader, comparator, threshold config array, `praat_window_sec=200`, label contract summary, transcript splitter, matrix compiler) and integration cases (full run, Script 2 artifacts exist, generated 0.25 diagnostic exists, missing file -> blocked/failed, corrupted mismatch -> fails not passes, Praat-unavailable -> thresholds blocked + gold replay still runs) all run; `unit-test-results.json` + `integration-test-results.json` written; failures surfaced, not hidden.

## T6 — WebUI console + server
`src/components/validation/*`, `validation.html`, `src/validation-main.tsx`.
**Accept:** `npx vite build` (validation entry) succeeds without auth/Supabase env; console renders file checklist, threshold config including `praat_window_sec=200`, distinct Script 1 and Script 2 status panels, Scale Times/full-timeline status, label contract summary, 0.25 expert replay table, generated 0.25 diagnostic table, 0.35 no-gold table, transcript panel, matrix panel, artifact list, report panel; reads real `validation_report.json`; status badges use the 8 states; no fake PASS; Phase I shows skipped.

## T7 — UI tests + screenshots + final report
**Accept:** headless desktop + mobile screenshots saved under `test-results/screenshots/`; `ui-test-results.json` written (render + status correctness: no fake PASS initially, 0.35 no-gold, Phase I skipped); `validation_report.md` includes timestamp, passed/failed counts, limitations, readiness. Final chat summary lists changed files, commands run, KPI pass/fail table, artifacts, test files, limitations.

## Risk register
- **R-Praat-params:** generated segmentation won't equal expert segmentation — by design; gold match is via gold replay, generated is draft/no-gold. Mitigation: keep the two paths separate; never gate on generated 0.25 matching gold.
- **R-vite-env:** full LDT app may need Supabase env to build. Mitigation: dedicated `validation.html` entry mounting only the console.
- **R-articulation-def:** workbook articulation rate is syll/min and "phonation time" = total audio (≠ PRD §5). Mitigation: replicate the workbook's own formula for the gold comparison; record the terminology mismatch in limitations for sign-off.
- **R-AS-unit:** between/within AS-unit columns need Layer 2 clause segmentation. Mitigation: `pending_not_implemented`, never fabricated.
