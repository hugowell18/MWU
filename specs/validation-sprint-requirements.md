# Validation Sprint — Requirements

> **Superseded planning note, 2026-06-21:** The controlling PRD is now `docs/PRD-Validation-Sprint-Monologue-Benchmark.md` v0.3. The MVP UI must be a standalone **Validation** entry with one `Run Validation` workflow. During the run, show pipeline progress through Phase II -> Phase III -> Phase IV -> Phase V, then show ours-vs-expected comparison and downloads. Phase I-V cards are preview/context, not separate per-phase run tabs.

**Scope:** System-verification of the SpeakerX *monologue* benchmark against the client's expert Praat / TextGrid / Excel baseline. This is **not** research data and **not** Layer 1. It proves the pipeline can reproduce the published numbers before the multilogue build is funded.

**Controlling PRD:** `docs/PRD-Validation-Sprint-Monologue-Benchmark.md` v0.2. If this document conflicts with the PRD, the PRD wins.

---

## 1. Critical context (monologue)

The benchmark file is a **single-speaker monologue**. Therefore the Sprint:

- **Skips Phase I** speaker isolation entirely. No diarization, no AssemblyAI, no muted-mirror WAVs, no SpeakerY / SpeakerZ outputs.
- Plugs the `.wav` directly into **Phase II**.
- Verifies **Phase II** (dual-threshold extraction), **Phase III** (transcript splitting), **Phase V** (matrix verification).
- Leaves **Phase IV** (TAALES / TAALED / AntConc) as reserved placeholders only — never fabricated.

> Note: the gold workbook contains 3 IELTS-8 monologues (SpeakerX/Y/Z = Xu/Lee/Sun). We hold only the SpeakerX `.wav`, so the run targets **SpeakerX = column B**. Y/Z are ignored.

## 2. Inputs (only these)

| # | File | Role |
|---|---|---|
| 1 | `sample/8_STEM_SpeakerX_checked_and_pruned.wav` | audio (Phase II Script 1 input) |
| 2 | `sample/8 STEM SpeakerX.TextGrid` | expert gold segmentation (gold replay + Script 2) |
| 3 | `sample/8 STEM SpeakerX checked and pruned.txt` | transcript (Phase III) |
| 4 | `sample/Example fluency measures calculations SpeakerX.xlsx` | gold baseline workbook |

If any required input is missing → run state `blocked` / `failed` and the report names the missing file.

## 3. Phase II — automated multi-threshold pause and duration analysis

Two linked modules.

### Script 1 — intensity / silence detection loop
- Load the monologue `.wav`; batch-run Praat silence detection.
- One run tests **both 0.25 s and 0.35 s**. `thresholds_sec` is a **configurable array**, default `[0.25, 0.35]`.
- No code path may assume exactly two thresholds; `[0.2, 0.25, 0.35]` must not crash.
- Expose and log `praat_window_sec`, default `200`.
- Each threshold gets its **own output directory**.
- Apply or explicitly log Praat `Scale times` / full-timeline handling: generated TextGrids cover the **full, unsegmented** audio timeline (xmin=0 .. xmax=audio duration).
- Generated TextGrid label contract is `sounding` / `silent` / `invalid`. In this monologue sprint, `invalid_count=0`, but the data model and summaries must include it.
- Generated 0.25 must be diagnostically compared with the expert TextGrid. Do **not** present expert TextGrid gold replay as generated segmentation success.
- `0.35` has **no gold workbook** → marked `generated_no_gold` / `pending_gold`, **never `PASS`**.

### Script 2 — segment duration calculation
- Run automated `calculate_segment_durations.praat`, or a parity-tested CLI equivalent explicitly labeled as equivalent.
- Script 2 runs immediately after each threshold TextGrid is created.
- Compute durations per labelled interval for each threshold TextGrid **and** for the expert gold TextGrid.
- Output `script2_segment_durations.csv`, `script2_segment_durations.json`, and `script2_summary.json` for each threshold.
- Summaries must include total sounding, total silent, total invalid, segment counts, individual pause values, and sounding time ranges.
- Cross-check 0.25 values against the workbook. 0.25 must match mathematically; 0.35 is generated-only.

### Gold replay vs Generated drafts (method)
- **Gold replay** = parse the *expert* TextGrid, recompute aggregates, compare to the workbook. Holds segmentation fixed → validates the arithmetic. **Must match exactly.**
- **Generated drafts** = our Praat silence detection from the `.wav` at each threshold → new segmentation. 0.25 draft must be reported against the expert TextGrid as diagnostic data; 0.35 draft has no gold.

## 4. Gold KPIs (must reproduce)

From `8 STEM SpeakerX.TextGrid`:

| Metric | Required |
|---|---:|
| Audio / TextGrid duration | `183.1792290249433` s |
| Tier count | `1` |
| Tier name | `silences` |
| Interval count | `121` |
| sounding interval count | `61` |
| silent interval count | `60` |
| Total sounding duration | `133.19652983384853` s |
| Total silent duration | `49.98269919109479` s |

From `Example fluency measures calculations SpeakerX.xlsx` (col B):

| Metric | Required |
|---|---:|
| Total Duration of Audio | `183.1792290249433` |
| Phonation time | `183.1792290249433` |
| Speaking time | `133.19652983384853` |
| Speaking time (min) | `2.2199421638974754` |
| No. of syllables | `535` |
| No. of silent pauses | `60` |
| Mean of silent pauses | `0.8330449865182464` |
| Total silent pausing time | `49.98269919109479` |
| Mid-clause pauses (within ASU) | `37` |
| End-clause pauses (between ASU) | `23` |
| Total repairs | `1` |
| Articulation rate | `240.9972695237785` |

**Tolerances:** counts exact; durations ≤ `0.001` s; boundary preservation ≤ `0.001` s; articulation rate ≤ `0.001`.

**No re-filter rule:** do not re-filter the expert TextGrid on export. It contains one silent interval ≈ `0.246807` s that **must still be counted** (silent count stays 60). The expert TextGrid is the threshold-specific gold source.

**Workbook facts (already confirmed):** sheets `Durations` + `Fluency measures`; SpeakerX/Y/Z (Example) columns; **no separate 0.35 gold columns**; numbers near `0.35` are individual pause durations, not 0.35 gold variables.

## 5. Phase III — transcript splitting

Input file #3 → outputs `*_RAW-TIMING.txt`, `*_TIDY-PHRASE.txt`, `transcript_split_report.json`.

- **RAW-TIMING:** keep fillers, repetitions, false starts, repair wording, `X` placeholders; stay close to the original.
- **TIDY-PHRASE:** remove non-lexical fillers / laughter where applicable; normalize whitespace; preserve meaningful repetitions and reformulations; **log every transformation**.

## 6. Phase V — matrix verification

Outputs `validation_matrix_speakerx.xlsx` + `.csv`. Column families (client email):

- **Cols 1–7 = 0.25 threshold:** `Total_Pauses_Between_AS_Units_025`, `Mean_Duration_Pauses_Between_AS_Units_025`, `Total_Pauses_Within_AS_Units_025`, `Mean_Duration_Pauses_Within_AS_Units_025`, `Pause_Density_Per_Minute_025`, `Articulation_Rate_025`, `Mean_Of_Silent_Pauses_025`.
- **Cols 8–14 = parallel 0.35 threshold:** same names with `_035`.
- **Cols 15+ = reserved Phase IV text variables** (TAALES / TAALED / AntConc) as `pending_not_implemented` placeholders. **No fabricated values.**

0.25 values derive from validated available sources. If a value is imported from the workbook rather than automatically computed, the matrix metadata must mark `source=manual_baseline_workbook`. 0.35 values derive from the generated 0.35 draft and carry `generated_no_gold`; values requiring unavailable AS-unit definitions may be `pending_definition`. The 0.35 group status is never `matched`.

## 7. WebUI validation console

Local React/Vite console in the LDT slate/blue style (top nav, cards, phase runner, artifact list, metric comparison table). Net-new work; may reuse LDT styling patterns. Must include: file checklist, threshold config, Script 1 status, Script 2 status, 0.25 gold comparison table, 0.35 generated/no-gold table, transcript split panel, matrix verification panel, artifact download list, validation report panel.

**Status states:** `idle`, `ready`, `running`, `passed`, `failed`, `generated_no_gold`, `pending_gold`, `blocked`.

**UI rules:** no fake SpeakerX pass numbers; before a run completes show `ready`/`pending`, not `PASS`; 0.25 may show `PASS` only after a real comparison succeeds; 0.35 never shows gold pass; Phase I shows `skipped (monologue)`.

## 8. Output directory

All artifacts under `outputs/validation-sprint/8_STEM_SpeakerX/` per the tree in the goal doc (input-manifest, config snapshot, phase-ii/iii/v, validation/, logs/, test-results/).

## 9. Pass / fail gates (Definition of Done extract)

1. Three spec docs exist. 2. WebUI runs locally, shows real status. 3. Full Sprint Run completes from `sample`. 4. Phase I explicitly skipped. 5. Script 1 dual-threshold implemented. 6. `praat_window_sec=200` exists in config/method logs. 7. Scale-times / full-timeline handling is logged. 8. Label contract supports `sounding/silent/invalid`. 9. Script 2 duration cache artifacts exist for both thresholds. 10. 0.25 expert TextGrid replay matches workbook (silent count = 60 exact; duration, speaking time, silent time, mean pause each <= 0.001 s). 11. Generated 0.25 vs expert differences are reported separately. 12. 0.35 marked `generated_no_gold` / `pending_gold`. 13. RAW + TIDY exist. 14. Matrix cols 1-7 / 8-14 / 15+ correct. 15. validation_report.md + .json exist. 16. Test-result artifacts cover the hard requirements.

## 10. Prohibited

UI-mockup-only; fake SpeakerX numbers; 0.35 as gold pass; running Phase I; AssemblyAI; SpeakerY/Z; muted-mirror WAVs; fabricated MWU/AS-unit/TAALES/TAALED/AntConc; silently ignoring failed KPI comparisons.
