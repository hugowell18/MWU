# Goal Prompt — Validation Sprint Implementation

> **Superseded planning note, 2026-06-21:** The controlling PRD is now `docs/PRD-Validation-Sprint-Monologue-Benchmark.md` v0.3. Implement the standalone **Validation** entry with one `Run Validation` workflow. Do not implement the MVP as separate per-phase run tabs. During the run, show pipeline progress through Phase II -> Phase III -> Phase IV -> Phase V, then show ours-vs-expected comparison and downloads.

You are responsible for implementing the MWU Validation Sprint in this repository:

`/Users/nedved/Tool/Workspace/MWU/MWU`

The controlling PRD is:

`/Users/nedved/Tool/Workspace/MWU/MWU/docs/PRD-Validation-Sprint-Monologue-Benchmark.md`

Important: the PRD is now the source of truth. If this goal prompt or any older spec says "gold replay" or "equivalent" in a way that conflicts with PRD v0.2, follow PRD v0.2.

Your job is to build a local Validation Sprint WebUI + backend/scripts that verifies the client's SpeakerX monologue benchmark against the provided Praat/TextGrid/Excel baseline.

This Sprint is a system verification step only. It is not active research data and it is not Layer 1.

## Critical Context

This sample is a monologue with exactly one speaker. It is not a 3-speaker multilogue.

Therefore:

- Completely skip Phase I speaker isolation for this test file.
- Do not run diarization.
- Do not call AssemblyAI.
- Do not create muted-mirror WAV files.
- Do not generate SpeakerY or SpeakerZ outputs.
- Plug the `.wav` file directly into Phase II.

The client explicitly requires testing:

- Phase II dual-threshold extraction.
- Phase III transcript splitting.
- Phase V matrix verification.

## Required Input Files

Use only the files in:

`sample`

Required files:

1. `sample/8_STEM_SpeakerX_checked_and_pruned.wav`
2. `sample/8 STEM SpeakerX.TextGrid`
3. `sample/8 STEM SpeakerX checked and pruned.txt`
4. `sample/Example fluency measures calculations SpeakerX.xlsx`

## Spec-First Requirement

Before coding, create these three spec documents:

1. `specs/validation-sprint-requirements.md`
2. `specs/validation-sprint-design.md`
3. `specs/validation-sprint-task-plan.md`

The spec documents must cover:

- Phase I skipped because this is a monologue.
- Phase II dual-threshold extraction.
- Script 1: Praat intensity script loop.
- Script 2: automated `calculate_segment_durations.praat` flow, or a clearly labeled parity-tested CLI equivalent.
- Praat `Scale times` / full unsegmented timeline handling.
- 200 second Praat window parameter exposed in config/method log.
- Standard label contract: `sounding`, `silent`, `invalid`.
- Phase III transcript splitting.
- Phase V matrix verification.
- 0.25 vs 0.35 parallel threshold columns.
- Phase IV text-variable placeholders: TAALES, TAALED, AntConc.
- WebUI validation console.
- Test cases and test result artifacts.
- Pass/fail gates.

Do not start implementation until these specs exist.

## Phase II Testing — Dual-Threshold Extraction

Implement two linked modules.

### Script 1 — Intensity Script Loop

Goal:

Load the monologue `.wav` and automatically batch-run Praat-style intensity / silence detection.

Hard requirements:

- One run must test both `0.25s` and `0.35s`.
- Thresholds must be configurable as an array, default `[0.25, 0.35]`.
- Do not hardcode exactly two thresholds internally.
- A future threshold list such as `[0.2, 0.25, 0.35]` must not crash.
- Each threshold must have its own output directory.
- Apply Praat `Scale times` or an equivalent full-timeline unrolling step.
- Generated TextGrids must cover the full, unsegmented audio timeline.
- 0.25 generated TextGrid must be diagnostically compared to the expert TextGrid; do not present gold replay as generated segmentation success.
- 0.35 has no gold workbook and must be marked `generated_no_gold` or `pending_gold`, never `PASS`.

Script 1 outputs:

```text
outputs/validation-sprint/8_STEM_SpeakerX/phase-ii/threshold_0.25/generated.TextGrid
outputs/validation-sprint/8_STEM_SpeakerX/phase-ii/threshold_0.35/generated.TextGrid
outputs/validation-sprint/8_STEM_SpeakerX/logs/praat_threshold_run.log
```

### Script 2 — Segment Duration Calculation

Goal:

Run `calculate_segment_durations.praat` on the generated and gold TextGrid files, or provide a parity-tested CLI equivalent that is explicitly labeled as equivalent rather than the original Praat macro.

Hard requirements:

- Calculate segment durations for each threshold TextGrid immediately after Script 1.
- Perform gold replay on the client-provided expert TextGrid.
- Cross-check 0.25 values against `Example fluency measures calculations SpeakerX.xlsx`.
- 0.25 expert TextGrid replay must match mathematically.
- Generated 0.25 vs expert TextGrid differences must be reported separately.
- 0.35 is generated only and must not be treated as a gold pass.

Script 2 outputs:

```text
outputs/validation-sprint/8_STEM_SpeakerX/phase-ii/threshold_0.25/script2_segment_durations.csv
outputs/validation-sprint/8_STEM_SpeakerX/phase-ii/threshold_0.25/script2_segment_durations.json
outputs/validation-sprint/8_STEM_SpeakerX/phase-ii/threshold_0.25/script2_summary.json
outputs/validation-sprint/8_STEM_SpeakerX/phase-ii/threshold_0.35/script2_segment_durations.csv
outputs/validation-sprint/8_STEM_SpeakerX/phase-ii/threshold_0.35/script2_segment_durations.json
outputs/validation-sprint/8_STEM_SpeakerX/phase-ii/threshold_0.35/script2_summary.json
```

## Precise KPI / Gold Baseline

The expert TextGrid and SpeakerX workbook must reproduce these values.

From `8 STEM SpeakerX.TextGrid`:

| Metric | Required value |
|---|---:|
| Audio/TextGrid duration | `183.1792290249433 s` |
| Tier count | `1` |
| Tier name | `silences` |
| Interval count | `121` |
| sounding interval count | `61` |
| silent interval count | `60` |
| Total sounding duration | `133.19652983384853 s` |
| Total silent duration | `49.98269919109479 s` |

From `Example fluency measures calculations SpeakerX.xlsx`:

| Metric | Required value |
|---|---:|
| Total Duration of Audio | `183.1792290249433 s` |
| Phonation time | `183.1792290249433 s` |
| Speaking time | `133.19652983384853 s` |
| Speaking time minutes | `2.2199421638974754 min` |
| No. of syllables | `535` |
| No. of silent pauses | `60` |
| Mean of silent pauses | `0.8330449865182464 s` |
| Total silent pausing time | `49.98269919109479 s` |
| Mid-clause pauses within ASU | `37` |
| End-clause pauses between ASU | `23` |
| Total repairs | `1` |
| Articulation rate | `240.9972695237785` |

Hard tolerances:

- Counts: exact.
- Durations: `<= 0.001 s`.
- Boundary preservation: `<= 0.001 s`.
- Articulation rate: `<= 0.001`.

Important rule:

Do not re-filter the expert TextGrid during export. The provided 0.25 baseline includes one silent interval of about `0.246807 s`. It must still be counted. Treat the expert TextGrid as the threshold-specific gold source.

Workbook inspection has already confirmed:

- The workbook contains `Durations` and `Fluency measures`.
- It has SpeakerX/SpeakerY/SpeakerZ or Example columns.
- It does not contain separate 0.35 gold threshold columns.
- Numeric values near `0.35` inside the workbook are individual pause durations, not 0.35-threshold gold variables.

## Phase III Testing — Transcript Splitting

Input:

`sample/8 STEM SpeakerX checked and pruned.txt`

Required outputs:

```text
outputs/validation-sprint/8_STEM_SpeakerX/phase-iii/8_STEM_SpeakerX_RAW-TIMING.txt
outputs/validation-sprint/8_STEM_SpeakerX/phase-iii/8_STEM_SpeakerX_TIDY-PHRASE.txt
outputs/validation-sprint/8_STEM_SpeakerX/phase-iii/transcript_split_report.json
```

RAW-TIMING requirements:

- Keep fillers.
- Keep repetitions.
- Keep false starts.
- Keep repair-relevant wording.
- Keep `X` placeholders.
- Stay close to the original transcript.

TIDY-PHRASE requirements:

- Remove non-lexical fillers if applicable.
- Remove laughter / non-lexical markers if applicable.
- Normalize whitespace.
- Preserve meaningful repetitions and reformulations.
- Log every transformation.

## Phase V Matrix Verification

Required outputs:

```text
outputs/validation-sprint/8_STEM_SpeakerX/phase-v/validation_matrix_speakerx.xlsx
outputs/validation-sprint/8_STEM_SpeakerX/phase-v/validation_matrix_speakerx.csv
```

The matrix must follow the client's requested column families.

Columns 1-7 must be 0.25 threshold variables:

1. `Total_Pauses_Between_AS_Units_025`
2. `Mean_Duration_Pauses_Between_AS_Units_025`
3. `Total_Pauses_Within_AS_Units_025`
4. `Mean_Duration_Pauses_Within_AS_Units_025`
5. `Pause_Density_Per_Minute_025`
6. `Articulation_Rate_025`
7. `Mean_Of_Silent_Pauses_025`

Columns 8-14 must be parallel 0.35 threshold variables:

8. `Total_Pauses_Between_AS_Units_035`
9. `Mean_Duration_Pauses_Between_AS_Units_035`
10. `Total_Pauses_Within_AS_Units_035`
11. `Mean_Duration_Pauses_Within_AS_Units_035`
12. `Pause_Density_Per_Minute_035`
13. `Articulation_Rate_035`
14. `Mean_Of_Silent_Pauses_035`

Columns 15+ must reserve shared Phase IV computational text variables:

- TAALES variables.
- TAALED variables.
- AntConc variables.

If Phase IV tools are not implemented in this Sprint, columns 15+ must be present as placeholders using values such as `pending_not_implemented`. Do not fabricate values.

## WebUI Validation Console

Implement a local WebUI console.

Visual direction:

- Use the current LDT Web UI style as the base.
- React/Vite.
- Slate/blue white-background dashboard style.
- Top navigation.
- Cards.
- Phase runner.
- Artifact list.
- Metric comparison table.

Important:

The current `src/` frontend is an LDT demo, not a ready MWU/Praat validation console. You may reuse styling patterns and components, but this is net-new work.

The WebUI must include:

- File checklist.
- Threshold config.
- Praat Script 1 run status.
- Segment Duration Script 2 run status.
- 0.25 gold comparison table.
- 0.35 generated/no-gold table.
- Transcript split panel.
- Matrix verification panel.
- Artifact download list.
- Validation report panel.

Required status states:

- `idle`
- `ready`
- `running`
- `passed`
- `failed`
- `generated_no_gold`
- `pending_gold`
- `blocked`

UI rules:

- Do not display fake SpeakerX pass numbers.
- If a run has not completed, show `ready` or `pending`, not `PASS`.
- 0.25 may show `PASS` only after real comparison succeeds.
- 0.35 must never show gold pass.
- Phase I must show skipped for monologue.

## Output Directory

All generated artifacts must live under:

```text
outputs/validation-sprint/8_STEM_SpeakerX/
```

Expected structure:

```text
outputs/validation-sprint/8_STEM_SpeakerX/
  input-manifest.json
  config.snapshot.json
  phase-ii/
    threshold_0.25/
      generated.TextGrid
      script1_method.json
      script2_segment_durations.csv
      script2_segment_durations.json
      script2_summary.json
    threshold_0.35/
      generated.TextGrid
      script1_method.json
      script2_segment_durations.csv
      script2_segment_durations.json
      script2_summary.json
  phase-iii/
    8_STEM_SpeakerX_RAW-TIMING.txt
    8_STEM_SpeakerX_TIDY-PHRASE.txt
    transcript_split_report.json
  phase-v/
    validation_matrix_speakerx.xlsx
    validation_matrix_speakerx.csv
  validation/
    generated_vs_expert_025.json
    speakerx_025_baseline_comparison.json
    speakerx_025_baseline_comparison.csv
    validation_report.md
    validation_report.json
  logs/
    method_log.json
    praat_script1_run.log
    praat_script2_run.log
  test-results/
    unit-test-results.json
    integration-test-results.json
    ui-test-results.json
    screenshots/
      validation-console-desktop.png
      validation-console-mobile.png
```

## Required Tests

Implement and run tests. At minimum cover the following.

### Unit Tests

1. TextGrid parser:
   - tier count = 1
   - tier name = `silences`
   - interval count = 121
   - sounding count = 61
   - silent count = 60
   - total sounding = `133.19652983384853 ± 0.001`
   - total silent = `49.98269919109479 ± 0.001`
   - total duration = `183.1792290249433 ± 0.001`

2. No export-time refilter:
   - expert TextGrid silent interval below 0.25 s is still counted
   - silent count remains 60

3. Excel reader:
   - sheets are `Durations` and `Fluency measures`
   - SpeakerX / Example 1 values are read
   - SpeakerY / SpeakerZ are ignored
   - workbook is recognized as having no 0.35 gold threshold columns

4. Baseline comparator:
   - silent pause count exact match = 60
   - total duration delta <= 0.001
   - speaking time delta <= 0.001
   - total silent pausing delta <= 0.001
   - mean silent pause delta <= 0.001
   - articulation rate delta <= 0.001 if syllable count is supplied

5. Threshold config:
   - `thresholds_sec` is an array
   - `[0.25, 0.35]` works
   - `[0.2, 0.25, 0.35]` does not crash
   - no code path assumes exactly two thresholds

6. Transcript splitter:
   - RAW output exists and is not empty
   - TIDY output exists and is not empty
   - transformation log exists

7. Matrix compiler:
   - XLSX exists
   - CSV exists
   - 0.25 required columns exist in order
   - 0.35 required columns exist in order
   - Phase IV placeholder fields exist
   - no fabricated Phase IV values
   - 0.35 status is `generated_no_gold` or `pending_gold`, not `matched`

### Integration Tests

1. Full Sprint Run:
   - starts from `sample`
   - generates full output structure
   - creates `validation_report.json`
   - creates `validation_report.md`
   - 0.25 baseline passes
   - 0.35 is no-gold
   - Phase I is skipped
   - no SpeakerY or SpeakerZ output is generated

2. Missing file failure:
   - missing wav/TextGrid/txt/xlsx produces `blocked` or `failed`
   - error message identifies the missing file

3. Corrupted mismatch failure:
   - if expected count or duration is intentionally changed, comparator must fail
   - do not still show pass

4. Praat unavailable handling:
   - if Praat binary is missing, dual-threshold generation is blocked or failed
   - gold replay can still run independently
   - validation report records Praat generation as blocked

### UI Tests

1. Console renders:
   - file checklist visible
   - config visible
   - run steps visible
   - validation table visible
   - artifact list visible

2. Status correctness:
   - initial state does not show fake PASS
   - PASS appears only after real script success
   - 0.35 shows `generated_no_gold` / `no gold`
   - Phase I shows skipped for monologue

3. Screenshot artifacts:
   - desktop screenshot saved
   - mobile screenshot saved
   - paths written to `test-results/ui-test-results.json`

## Required Test Artifacts

Generate:

```text
outputs/validation-sprint/8_STEM_SpeakerX/test-results/
  unit-test-results.json
  integration-test-results.json
  ui-test-results.json
  screenshots/
    validation-console-desktop.png
    validation-console-mobile.png
```

Also include in `validation_report.md`:

- test run timestamp
- passed test count
- failed test count
- known limitations
- Sprint readiness: `ready`, `blocked`, or `ready_with_caveats`

## Definition of Done

This goal is complete only when all of the following are true:

1. The three spec files exist:
   - `validation-sprint-requirements.md`
   - `validation-sprint-design.md`
   - `validation-sprint-task-plan.md`

2. WebUI console can run locally and displays real run status.

3. Full Sprint Run can complete from `sample`.

4. Phase I is explicitly skipped.

5. Script 1 dual-threshold extraction is implemented.

6. Script 2 duration calculation is implemented as automated `calculate_segment_durations.praat`, or a parity-tested equivalent explicitly labeled as such.

7. `praat_window_sec=200`, Scale Times / full-timeline handling, and `sounding/silent/invalid` label support are logged.

8. 0.25 expert TextGrid replay matches the client Excel:
   - silent count = 60 exact
   - total duration within 0.001 s
   - speaking time within 0.001 s
   - total silent duration within 0.001 s
   - mean silent pause within 0.001 s

9. Generated 0.25 vs expert TextGrid diagnostic differences are reported separately.

10. 0.35 is marked `generated_no_gold` or `pending_gold`.

11. RAW-TIMING and TIDY-PHRASE outputs exist.

12. Matrix columns 1-7 / 8-14 / 15+ match the client email requirements.

12. `validation_report.md` and `validation_report.json` exist.

13. Required test result artifacts exist.

14. Final report lists:
   - changed files
   - commands run
   - KPI pass/fail table
   - generated artifacts
   - test result files
   - remaining limitations

## Prohibited Work

Do not:

- only make a UI mockup
- use fake SpeakerX numbers
- mark 0.35 as gold pass
- run Phase I
- call AssemblyAI
- generate SpeakerY or SpeakerZ
- create muted-mirror WAVs for this monologue test
- fabricate MWU / AS-unit / TAALES / TAALED / AntConc results
- silently ignore failed KPI comparisons
