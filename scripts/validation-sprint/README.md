# Validation Sprint — run guide

System verification of the SpeakerX **monologue** benchmark against the client's expert Praat/TextGrid/Excel baseline. Specs: `specs/validation-sprint-*.md`. Goal: `docs/GOAL-Validation-Sprint-Agent.md`.

Phase I is **skipped** (single speaker — no diarization, no AssemblyAI, no muted-mirror, no SpeakerY/Z).

## Single-entry Validation Console

The Validation Console is a **single entry with one `Run Validation` button** (per the controlling PRD). It runs the whole pipeline in one go and shows **phase-level progress**:

```
Phase I (skipped) → Phase II → Phase III → Phase IV (placeholders) → Phase V → report package
```

- **Phase II** — Script 1 (rolling intensity, 200 s window, Scale times) → Script 2 (`calculate_segment_durations.praat`) → gold replay vs workbook + generated 0.25/0.35 drafts + generated-vs-expert diagnostic.
- **Phase III** — RAW-TIMING + TIDY-PHRASE.
- **Phase IV** — TAALES / TAALED / AntConc **text-variable placeholders** (`placeholder_ready`, `pending_not_implemented`; nothing fabricated).
- **Phase V** — long-format matrix (cols 1–7 = 0.25, 8–14 = 0.35, 15+ = Phase IV placeholders).

Results show **ours vs expected baseline** (each metric: ours / expected / Δ / pass-fail), 0.35 marked `generated_no_gold`, and a download package (TextGrids · CSV · XLSX · reports · logs). The pipeline display is progress-only — the user does not click into separate phase pages.

CLI: `node scripts/validation-sprint/run-sprint.mjs` (runs the whole pipeline; `--phase ii|iii|iv|v` available for debugging).

## Commands

```bash
npm run sprint:run        # full pipeline (--phase all) → outputs/validation-sprint/8_STEM_SpeakerX/
npm run sprint:test       # unit + integration tests → test-results/
npm run sprint:build-ui   # build the React console → build-validation/
npm run sprint:serve      # serve console + API at http://localhost:4173
npm run sprint:ui-test    # UI assertions (server must be running) + screenshots present
npm run sprint:finalize   # merge test counts into validation_report.{json,md}
```

API: `POST /api/upload?role=wav|textgrid|transcript|workbook`, `POST /api/run {phase, useSample}`, `GET /api/status` (live step progress), `GET /api/report`, `GET /api/file?path=`.

End-to-end (what produced the committed artifacts):

```bash
npm run sprint:run
npm run sprint:test
npm run sprint:build-ui
npm run sprint:serve &                 # background
node tests/validation-sprint/ui-tests.mjs   # also drives screenshots via headless Chrome
npm run sprint:finalize
```

## Layout

- `config.mjs` — thresholds `[0.25,0.35]` (configurable array), tolerances, Praat params. Env overrides: `SPRINT_SAMPLE_DIR`, `SPRINT_OUT_DIR`, `PRAAT_BIN`.
- `lib/` — `textgrid`, `durations` (Script 2 core), `excel-baseline`, `comparator`, `transcript-split`, `matrix`, `praat`, `xlsxio`, `fsutil`.
- `praat/silences.praat` — Script 1: headless `To TextGrid (silences)` per threshold, full timeline.
- `run-sprint.mjs` — orchestrator. `server.mjs` — console + `/api/{report,run,file}`.
- React console: `src/components/validation/*`, entry `validation.html` + `src/validation-main.tsx`, config `vite.validation.config.mjs`.

## What is validated

- **Gold replay (0.25):** recompute aggregates from the expert TextGrid → compare to the workbook. Must match exactly (silent count = 60; durations ≤ 0.001 s). This is the pass gate.
- **Generated drafts (0.25/0.35):** our Praat segmentation from the wav. 0.35 has no gold → `generated_no_gold`, never a gold pass.
- **Phase III:** RAW-TIMING + TIDY-PHRASE + transform log.
- **Phase V matrix:** cols 1–7 (0.25), 8–14 (0.35), 15+ Phase IV `pending_not_implemented`. AS-unit columns are Layer 2 → `pending_not_implemented` (not fabricated).
