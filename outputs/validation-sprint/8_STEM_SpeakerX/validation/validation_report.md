# Validation Sprint — 8_STEM_SpeakerX

- Run: 2026-06-22T03:14:10.055Z
- Phase I: **skipped** (monologue)
- Praat: available
- Readiness: **ready**

## Phase II — Gold replay (0.25): **PASSED**

| Metric | Ours | Gold | Δ | Tol | Pass |
|---|---:|---:|---:|---|:--:|
| No. of silent pauses | 60 | 60 | 0.00e+0 | exact | ✅ |
| Total audio duration (s) | 183.179229 | 183.179229 | 8.53e-14 | <= 0.001 | ✅ |
| Speaking time (s) | 133.196530 | 133.196530 | 3.98e-13 | <= 0.001 | ✅ |
| Total silent pausing (s) | 49.982699 | 49.982699 | 3.34e-13 | <= 0.001 | ✅ |
| Mean silent pause (s) | 0.833045 | 0.833045 | 5.66e-15 | <= 0.001 | ✅ |
| Articulation rate (syll/min) | 240.997270 | 240.997270 | 7.39e-13 | <= 0.001 | ✅ |

| Threshold | Kind | Status | silent |
|---|---|---|---:|
| 0.25 | gold | generated | 98 |
| 0.35 | generated_no_gold | generated_no_gold | 71 |

## Phase III — passed
- Client RAW 321w / Client TIDY 321w
- AssemblyAI comparison: WER 8.7%, agreement 91.3%

## Phase V — passed
- columns: 26

## Limitations
- Workbook articulation rate is syllables/min and "phonation time" = total audio; differs from PRD §5 — reconcile before sign-off.

## Tests
- unit 28/0 · integration 5/0 · ui 10/0
