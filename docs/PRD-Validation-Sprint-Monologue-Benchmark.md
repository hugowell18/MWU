# PRD - Validation Sprint: SpeakerX Monologue Benchmark

**Version:** 0.3, validation-run oriented  
**Date:** 2026-06-21  
**Repository:** `/Users/nedved/Tool/Workspace/MWU/MWU`  
**Source of truth:** Client email, "TEST DATA FOR BENCHMARKING: Sample Monologue Files for Phase II-V Validation"

---

## 1. Product Positioning

This deliverable is **not** the full Phase I-V research product UI.

It is a dedicated **Validation Sprint Console**:

```text
Validation entry -> select the four benchmark files -> Run Validation -> produce validation result package
```

The purpose is to prove, using the supplied SpeakerX monologue benchmark, that our modules can reproduce the client's known Praat/TextGrid/Excel outputs before the official multilogue corpus is released.

The Phase I-V workflow should still be visible in the UI as a **run progress pipeline** and module context, but the validation task itself is a separate entry, not a normal Phase I-V production run.

Interaction model:

```text
Open Validation Console
  -> choose bundled sample or upload four files
  -> click Run Validation
  -> pipeline progress shows Phase II -> Phase III -> Phase IV -> Phase V
  -> final screen shows comparison vs expected baseline + downloadable artifacts
```

---

## 2. Client-Provided Benchmark Package

Folder:

`/Users/nedved/Tool/Workspace/MWU/MWU/sample`

Required files:

| File | Client description | Required use |
|---|---|---|
| `8_STEM_SpeakerX_checked_and_pruned.wav` | Audio recording | Input to Phase II Script 1 |
| `8 STEM SpeakerX.TextGrid` | Completed Praat map; human-verified correct pause boundaries | Gold TextGrid for 0.25 validation |
| `8 STEM SpeakerX checked and pruned.txt` | Verbatim transcript | Input to Phase III transcript splitting |
| `Example fluency measures calculations SpeakerX.xlsx` | Exact target baseline values final matrix must match for SpeakerX | Matrix and duration validation baseline |

Important workbook rule:

- The workbook also contains similar values for SpeakerY and SpeakerZ.
- SpeakerY and SpeakerZ are not included in this sample.
- This sprint must not create or infer SpeakerY/SpeakerZ outputs.

---

## 3. Architectural Context: Monologue

This benchmark is a **single-speaker monologue**, not a multi-speaker multilogue.

Therefore:

- Skip Phase I speaker isolation completely.
- Do not run diarization.
- Do not create muted-mirror WAV files.
- Do not handle turn-taking, overlap, or conversational gaps.
- Plug the `.wav` directly into Phase II.

The UI must show this clearly:

```text
Phase I: skipped for this validation sample
Reason: monologue, one speaker only
```

This test is for **system verification only**. It is not active research data.

---

## 4. Validation Run: User Journey

The UI must add a top-level entry:

```text
Validation
```

This entry is separate from the Phase I-V workflow preview.

### 4.1 Validation Screen Layout

The Validation screen should contain:

1. **Benchmark Inputs**
   - WAV file
   - expert TextGrid
   - transcript TXT
   - baseline XLSX
   - bundled sample selector

2. **Run Configuration**
   - threshold list, default `[0.25, 0.35]`
   - flexible decimal threshold editor
   - Praat binary/version
   - Praat intensity/window setting, default `200 s`
   - Scale Times mode
   - label contract: `sounding`, `silent`, `invalid`

3. **Run Button**
   - one primary button: `Run Validation`
   - not separate per-phase run buttons for the MVP validation workflow

4. **Pipeline Progress**
   - a horizontal or vertical pipeline below the run controls
   - Phase I shown as `skipped`
   - Phase II, III, IV, V shown as run stages
   - while running, highlight the active phase
   - after completion, show each phase status: `passed`, `diagnostic`, `generated_no_gold`, `skipped`, or `blocked`

5. **Validation Results**
   - pass/fail summary
   - Phase II result cards
   - Phase III result cards
   - Phase V matrix result cards
   - comparison against the client's expected baseline
   - artifacts/downloads
   - limitations and next-step notes

6. **Workflow Preview / Explanation**
   - Phase I-V cards are visible for client understanding
   - Phase I card is marked `skipped for monologue`
   - Phase IV card is marked `text-variable placeholders / not computed unless tools are supplied`
   - cards explain which modules this validation touches

---

## 5. Validation Run: Step Breakdown

The single `Run Validation` action executes these steps in order. The UI pipeline should show this order:

```text
Phase I skipped -> Phase II -> Phase III -> Phase IV -> Phase V -> Report Package
```

For the simplified progress bar requested by the client-facing demo, it is acceptable to show:

```text
Phase II -> Phase III -> Phase IV -> Phase V
```

with Phase I displayed separately as `skipped`.

### Step 0 - Input Manifest

Read and record:

- file names,
- file sizes,
- hashes,
- audio duration,
- TextGrid tier names and interval count,
- transcript word/character count,
- workbook sheet names,
- SpeakerX target column,
- proof that SpeakerY/SpeakerZ are ignored.

Outputs:

```text
input-manifest.json
config.snapshot.json
```

### Step 1 - Monologue Gate

Confirm this is a validation monologue run:

```json
{
  "phase_i": {
    "status": "skipped",
    "reason": "monologue_one_speaker"
  }
}
```

Acceptance:

- no diarization call,
- no AssemblyAI call,
- no SpeakerY/SpeakerZ output,
- no muted-mirror WAV output.

### Step 2 - Phase II Validation: Dual-Threshold Extraction

This step validates the client's Phase II requirement.

#### 2A. Script 1 - Intensity Script Loop

Input:

```text
8_STEM_SpeakerX_checked_and_pruned.wav
```

Requirements:

- Load the monologue WAV into the system.
- Run Praat-based intensity/silence extraction.
- Batch-run thresholds simultaneously:
  - `0.25 s`
  - `0.35 s`
- Thresholds must be configurable for future arbitrary decimal values.
- Record Praat parameters and version.
- Expose/log the `200 s` window setting.

Outputs:

```text
phase-ii/script1/
  threshold_0.25/generated.TextGrid
  threshold_0.25/script1_method.json
  threshold_0.35/generated.TextGrid
  threshold_0.35/script1_method.json
```

#### 2B. Scale Times Automation

Requirement:

- Apply Praat **Scale times** handling so generated data is on the full unsegmented timeline.

For this monologue:

- the input WAV is already the full timeline,
- Scale Times may be logged as `not_required_full_wav`,
- but the system must still assert that output `xmin/xmax` matches the original audio duration.

Output:

```text
phase-ii/scale-times-report.json
```

#### 2C. Script 2 - Segment Duration Calculation

Client requirement:

Run `calculate_segment_durations.praat` on the output.

Implementation requirement:

- Preferred: use an automated non-interactive Praat wrapper of `calculate_segment_durations.praat`.
- Acceptable only if stated clearly: a deterministic CLI implementation may be used as a parity-tested equivalent.

This step must run for:

1. generated 0.25 TextGrid,
2. generated 0.35 TextGrid,
3. expert gold TextGrid supplied by the client.

Outputs:

```text
phase-ii/script2/
  threshold_0.25/script2_segment_durations.csv
  threshold_0.25/script2_segment_durations.json
  threshold_0.25/script2_summary.json
  threshold_0.35/script2_segment_durations.csv
  threshold_0.35/script2_segment_durations.json
  threshold_0.35/script2_summary.json
  expert_0.25/script2_segment_durations.csv
  expert_0.25/script2_segment_durations.json
  expert_0.25/script2_summary.json
```

Each Script 2 summary must include:

| Metric | Required |
|---|---|
| total audio duration | yes |
| total sounding duration | yes |
| total silent duration | yes |
| total invalid duration | yes, `0` for monologue |
| sounding segment count | yes |
| silent segment count | yes |
| invalid segment count | yes, `0` for monologue |
| individual pause values | yes |
| sounding time ranges | yes |

#### 2D. Phase II Validation Checks

The validation report must separate two claims:

| Check | Meaning | Pass gate |
|---|---|---|
| Expert TextGrid -> Script 2 -> Excel | proves duration/math pipeline matches client's known baseline | hard pass/fail |
| WAV -> Script 1 -> generated TextGrid -> Script 2 | proves automatic extraction runs and produces auditable drafts | diagnostic, compared against expert 0.25 |

Important:

- If expert TextGrid replay matches Excel, we can say the **calculation chain** matches.
- If generated 0.25 differs from expert TextGrid, we must report that honestly as an automatic extraction difference.
- Do not present expert replay success as generated segmentation success.

Output:

```text
validation/phase2_expert_025_vs_workbook.json
validation/phase2_generated_025_vs_expert.json
validation/phase2_generated_035_no_gold.json
```

### Step 3 - Phase III Validation: Transcript Splitting

Input:

```text
8 STEM SpeakerX checked and pruned.txt
```

Requirement:

Use the text module to output both:

```text
phase-iii/8_STEM_SpeakerX_RAW-TIMING.txt
phase-iii/8_STEM_SpeakerX_TIDY-PHRASE.txt
phase-iii/transcript_split_report.json
```

Acceptance:

- files exist,
- RAW keeps the transcript close to the original,
- TIDY applies the agreed cleanup rules,
- all transformations are logged,
- no lexical/MWU/TAALES/TAALED/AntConc values are fabricated.

### Step 4 - Phase IV Validation: Text Variable Placeholders

The client email says columns 15+ will contain shared computational text variables from:

- TAALES,
- TAALED,
- AntConc.

For this validation sprint:

- Phase IV must appear in the pipeline.
- If these tools are not integrated, Phase IV status is `placeholder_ready`.
- The matrix must reserve columns 15+.
- Uncomputed values must be marked `pending_not_implemented`.
- No TAALES/TAALED/AntConc values may be fabricated.

Outputs:

```text
phase-iv/text_variable_placeholders.json
```

Acceptance:

- Phase IV appears in the UI pipeline.
- Status clearly states that text variables are placeholders for this validation run.
- Columns 15+ are present in the Phase V matrix.

### Step 5 - Phase V Validation: Matrix Compiler

Requirement:

Compile the final validation matrix for SpeakerX only.

Outputs:

```text
phase-v/validation_matrix_speakerx.xlsx
phase-v/validation_matrix_speakerx.csv
phase-v/matrix_validation_report.json
```

Column structure:

| Column group | Requirement |
|---|---|
| Columns 1-7 | 0.25 threshold variables |
| Columns 8-14 | 0.35 threshold variables |
| Columns 15+ | Phase IV shared text variables: TAALES, TAALED, AntConc |

Columns 1-7 must include:

- total pauses between AS-units,
- mean duration pauses between AS-units,
- total pauses within AS-units,
- mean duration pauses within AS-units,
- pause density,
- articulation rate,
- mean pauses.

Columns 8-14 must mirror the same variables for 0.35.

Columns 15+:

- reserve TAALES/TAALED/AntConc fields,
- mark unimplemented values as `pending_not_implemented`,
- never fabricate values.

Validation:

- SpeakerX 0.25 values must match the provided Excel baseline where the baseline exists.
- 0.35 values are generated in parallel but marked `generated_no_gold` because Dan's output only includes 0.25.
- SpeakerY/SpeakerZ must not be emitted.

### Step 6 - Validation Report Package

The run must produce a client-facing evidence package:

```text
validation/
  validation_report.html
  validation_report.md
  validation_report.json
  validation_summary.csv
```

The report must state:

- input files used,
- Phase I skipped reason,
- thresholds tested,
- Praat version and parameters,
- Scale Times status,
- Script 1 outputs,
- Script 2 outputs,
- 0.25 workbook match result,
- generated 0.25 vs expert diagnostic result,
- 0.35 no-gold status,
- Phase III transcript output status,
- Phase IV placeholder status,
- Phase V matrix status,
- comparison table against the client's expected result,
- artifact download links,
- limitations,
- next required client inputs for official multilogue validation.

---

## 6. Output Tree

Required output structure:

```text
outputs/validation-sprint/8_STEM_SpeakerX/
  input-manifest.json
  config.snapshot.json

  phase-ii/
    script1/
      threshold_0.25/
        generated.TextGrid
        script1_method.json
      threshold_0.35/
        generated.TextGrid
        script1_method.json
    script2/
      threshold_0.25/
        script2_segment_durations.csv
        script2_segment_durations.json
        script2_summary.json
      threshold_0.35/
        script2_segment_durations.csv
        script2_segment_durations.json
        script2_summary.json
      expert_0.25/
        script2_segment_durations.csv
        script2_segment_durations.json
        script2_summary.json
    scale-times-report.json

  phase-iii/
    8_STEM_SpeakerX_RAW-TIMING.txt
    8_STEM_SpeakerX_TIDY-PHRASE.txt
    transcript_split_report.json

  phase-iv/
    text_variable_placeholders.json

  phase-v/
    validation_matrix_speakerx.xlsx
    validation_matrix_speakerx.csv
    matrix_validation_report.json

  validation/
    phase2_expert_025_vs_workbook.json
    phase2_generated_025_vs_expert.json
    phase2_generated_035_no_gold.json
    validation_report.html
    validation_report.md
    validation_report.json
    validation_summary.csv

  logs/
    praat_script1_run.log
    praat_script2_run.log
    method_log.json

  test-results/
```

---

## 7. UI Requirements

### 7.1 Navigation

Add a primary navigation item:

```text
Validation
```

This is the MVP working area.

The Validation entry must show both:

1. a one-click validation runner,
2. a pipeline progress display.

Do not make the user manually enter separate Phase II / Phase III / Phase V pages just to complete this validation.

Also show a compact workflow preview/context area:

```text
Full Research Workflow Preview
Phase I -> Phase II -> Phase III -> Phase IV -> Phase V
```

### 7.2 Validation Screen Required Cards

1. **Benchmark Package**
   - four files,
   - file status,
   - hashes after upload/load.

2. **Validation Configuration**
   - thresholds `[0.25, 0.35]`,
   - editable future thresholds,
   - `praat_window_sec = 200`,
   - Praat path/version,
   - Scale Times mode,
   - label contract.

3. **Run Validation**
   - one run button,
   - progress timeline for the validation run.

4. **Pipeline Progress**
   - Phase I: skipped,
   - Phase II: dual-threshold extraction + Script 2 duration calculation,
   - Phase III: RAW/TIDY transcript split,
   - Phase IV: TAALES/TAALED/AntConc placeholders,
   - Phase V: matrix compilation and verification.

5. **Phase II Results**
   - Script 1 generated TextGrids,
   - Scale Times status,
   - Script 2 duration summaries,
   - 0.25 expert-vs-workbook pass/fail,
   - generated 0.25-vs-expert diagnostic,
   - generated 0.35 no-gold result.

6. **Phase III Results**
   - RAW output,
   - TIDY output,
   - transformation log.

7. **Phase IV Results**
   - placeholder status,
   - reserved TAALES/TAALED/AntConc variables,
   - no-fabrication status.

8. **Phase V Results**
   - matrix download,
   - column group status,
   - SpeakerX match status,
   - SpeakerY/SpeakerZ ignored status.

9. **Comparison Against Expected Result**
   - show the original expected values from the provided Excel/TextGrid,
   - show our generated/calculated values,
   - show delta,
   - show pass/fail per metric,
   - separate hard pass/fail checks from diagnostic/no-gold checks.

10. **Evidence Package**
   - report downloads,
   - logs,
   - test results.

### 7.3 Phase I-V Preview Cards

The UI should expose future stages for client understanding, but not make them the validation operating flow.

| Phase card | Validation status |
|---|---|
| Phase I Speaker Isolation | skipped for monologue |
| Phase II Pause Extraction | validated in this run |
| Phase III Transcript Split | validated in this run |
| Phase IV Text Variables | placeholders only |
| Phase V Matrix Compiler | validated in this run |

### 7.4 Final Result Display

After the run completes, the top of the results area should answer:

```text
Did our validation output match the client's expected SpeakerX baseline?
```

Required display:

| Result area | Required display |
|---|---|
| Overall status | `passed`, `passed_with_diagnostics`, or `failed` |
| 0.25 baseline comparison | ours vs expected, delta, tolerance, pass/fail |
| generated 0.25 diagnostic | generated draft vs expert TextGrid differences |
| 0.35 output | generated, no gold baseline |
| transcript split | RAW/TIDY produced |
| matrix | columns present, SpeakerX row present, SpeakerY/Z absent |
| downloads | TextGrid, CSV, XLSX, reports, logs |

---

## 8. Numeric Acceptance Targets

The expert 0.25 TextGrid and workbook must reproduce these SpeakerX values:

| Metric | Expected |
|---|---:|
| Total audio duration | `183.1792290249433 s` |
| Expert TextGrid interval count | `121` |
| Expert TextGrid sounding intervals | `61` |
| Expert TextGrid silent intervals | `60` |
| Expert total sounding duration | `133.19652983384853 s` |
| Expert total silent duration | `49.98269919109479 s` |
| Workbook syllables | `535` |
| Workbook silent pauses | `60` |
| Workbook mean silent pause | `0.8330449865182464 s` |
| Workbook articulation rate | `240.9972695237785` |

Tolerance:

- counts: exact,
- durations: `<= 0.001 s`,
- articulation rate: `<= 0.001`.

---

## 9. Tests Required

Automated tests must prove:

1. all four benchmark inputs are recognized,
2. Phase I is skipped,
3. no SpeakerY/SpeakerZ outputs are produced,
4. thresholds are configurable and `[0.25, 0.35]` run together,
5. a third threshold such as `[0.2, 0.25, 0.35]` does not crash,
6. `praat_window_sec=200` is in config and logs,
7. Scale Times/full timeline status is recorded,
8. Script 1 TextGrids are produced,
9. Script 2 duration cache is produced for generated 0.25, generated 0.35, and expert 0.25,
10. expert 0.25 Script 2 results match workbook within tolerance,
11. generated 0.25 vs expert diagnostic file exists,
12. generated 0.35 is marked `generated_no_gold`,
13. RAW/TIDY transcript files are produced,
14. Phase IV placeholder artifact exists,
15. matrix columns 1-7, 8-14, and 15+ exist,
16. report package exists,
17. UI has a standalone Validation entry and one `Run Validation` action,
18. UI pipeline displays progress through Phase II -> Phase III -> Phase IV -> Phase V,
19. final UI shows comparison against the expected baseline and artifact downloads.

---

## 10. Current Implementation Gaps

The current implementation must be adjusted before delivery:

1. UI currently treats Phase II/III/V as separate runnable phase tabs. It must add a standalone Validation entry with one `Run Validation` workflow.
2. During the validation run, the UI should show pipeline progress through Phase II -> Phase III -> Phase IV -> Phase V.
3. Phase I-V should remain visible as workflow preview/context for the validation sample, not as separate manual run pages.
4. Script 2 is currently a JS calculation core; it must either run the Praat script wrapper or be labeled as a parity-tested equivalent.
5. `praat_window_sec=200` is not yet in runtime config/logs.
6. Scale Times is not yet logged as a formal validation result.
7. Output names must be changed from generic `generated_durations.csv` to explicit Script 2 artifacts.
8. Generated 0.25 vs expert comparison must be reported separately from expert TextGrid replay.
9. The UI wording must not imply automatic 0.25 segmentation has matched the workbook unless that specific diagnostic passes.
10. Final results must show ours-vs-expected comparison plus artifact downloads.

---

## 11. Definition of Done

Validation Sprint is ready to show the client when:

1. The standalone Validation UI is available.
2. The bundled sample can run end-to-end with one `Run Validation` action.
3. The UI pipeline clearly shows active/completed status for Phase II -> Phase III -> Phase IV -> Phase V.
4. The output package follows the required tree.
5. Expert 0.25 values match workbook targets within tolerance.
6. Generated 0.25 and 0.35 outputs are produced and honestly labeled.
7. Phase III RAW/TIDY outputs exist.
8. Phase IV placeholder status exists.
9. Phase V matrix exists and matches SpeakerX 0.25 where baseline exists.
10. SpeakerY/SpeakerZ are not emitted.
11. HTML/MD/JSON validation reports are generated.
12. Final UI shows comparison to expected results and provides downloads.
13. Test artifacts prove the above.
