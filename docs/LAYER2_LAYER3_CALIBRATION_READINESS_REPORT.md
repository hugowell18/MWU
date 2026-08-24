# Layer 2 / Layer 3 Calibration Readiness Report

**Reference recording:** `Multilogue04_C_Level30_D1G4`  
**Run date:** 24 August 2026  
**Status:** Engineering calibration draft completed; research release is not yet approved

## 1. Purpose

The research team requested an expedited Layer 2 and Layer 3 trial on the first ten multilogue recordings. This report explains what was actually demonstrated with the first calibration recording, which inputs were supplied, which rules were temporarily assumed, what outputs are already usable, and what must still be confirmed before the results can be treated as final research data.

The current run proves that the pipeline can ingest a researcher-corrected Layer 1b TextGrid and a verified transcript, retain Path B transition evidence, generate Layer 2 artifacts, and compile them into a Layer 3 workbook. It does not claim that every linguistic variable has already been validated.

**Current trial coverage: 1 of 10 recordings.** The remaining nine recordings cannot enter the same calibrated run until their researcher-corrected TextGrids and verified transcripts are returned.

### Status key

| Status | Meaning |
|---|---|
| **OK** | Supplied or independently validated for the stated scope |
| **ASSUMPTION** | Executed with a documented provisional rule; replaceable after research-team confirmation |
| **OPEN** | Required for final release but not yet supplied or approved |
| **NG** | Output exists technically but must not yet be used as a final research variable |

## 2. Layer 2

### Input status

| No. | Input | Status | Basis used in this run | Remaining action |
|---:|---|---|---|---|
| 1 | Original WAV and accepted L1a speaker handoff | **OK** | Existing Multilogue04 source audio, canonical S1-S3 mapping and muted-mirror tracks | Apply the same accepted-session contract to the remaining recordings |
| 2 | Researcher-corrected Layer 1b TextGrid | **OK** | Full 501.013333-second P025 six-tier Gold TextGrid | Supply the corresponding corrected TextGrid for each remaining recording |
| 3 | Verified speaker-attributed verbatim transcript | **OK** | Customer TXT with `S1:`-`S3:`, fillers, repetitions, false starts and repairs preserved | Supply one verified TXT per remaining recording |
| 4 | Transcript annotation conventions | **OK for transcript ingestion** | Customer guide defines canonical speaker labels, `Teacher:`, `[bc]`, `[x]`, fillers, repetitions, cut-offs and restarts | No per-recording repetition is required; version and approve one shared guide |
| 5 | Participant/excluded-speech rule | **OK** | `Teacher:` turns tagged `[x]` are retained in the audit input but excluded from participant metrics | Confirm the same rule applies to all recordings |
| 6 | Word-level timing reference | **ASSUMPTION** | Customer TXT contains no timestamps. MFA generated word timing; AssemblyAI was used only as a timing seed/fallback | Agree how word timing will be reviewed or sampled before word-level claims are released |
| 7 | AS-unit and clause boundary rules | **ASSUMPTION** | Each eligible verified transcript turn was treated as a provisional AS-unit candidate; `[bc]` turns were separated | Supply or approve the final AS-unit/clause coding rules and examples |
| 8 | Pause-location rule | **ASSUMPTION** | P025 `op` intervals were combined with generated word timing and provisional turn-boundary candidates | Confirm the clause-boundary rule used for mid-clause/end-clause classification |
| 9 | MWU operational definition | **ASSUMPTION** | Exact contiguous matching used a ten-item engineering list only | Supply or approve the target list, matching rule and inclusion criteria |
| 10 | Repair, syllable and rate rules | **ASSUMPTION / OPEN** | Fillers, adjacent repetitions and visible cut-off markers were counted; aggregate repair coding and syllable rules were not available | Supply or approve repair categories, syllable counting and rate denominators |
| 11 | TAALES, TAALED and AntConc configuration | **OPEN** | No approved versions, settings or requested variables were available | Supply or approve versions and selected output variables |
| 12 | P035 reviewed timing evidence | **OPEN** | The supplied calibration Gold is P025 only | Confirm whether P035 is independently reviewed or deterministically regenerated from the approved method |
| 13 | Transition/FTO evidence | **ASSUMPTION / OPEN** | The Gold TextGrid contains 22 transition points, but their marks still state `status=provisional`; overlap cases retain `FTO=NA` under Path B | Confirm which transition values are accepted and which FTO fields must enter Layer 3 |

### Output status

| No. | Output | Status | Result | Problem / limitation |
|---:|---|---|---|---|
| 1 | Transcript contract validation | **OK** | S1-S3 matched the Gold TextGrid; 60 participant turns accepted; two Teacher `[x]` turns excluded | Validates format and attribution contract, not linguistic coding accuracy |
| 2 | Per-speaker RAW transcript | **OK as generated timing draft** | Generated for S1, S2 and S3 with canonical turn timestamps and verbatim phenomena retained | The timestamps are generated alignment evidence, not researcher-reviewed word boundaries |
| 3 | Per-speaker TIDY transcript | **OK** | Generated for S1, S2 and S3; bracketed control tags removed from lexical text | Final lexical normalization still depends on approved tool conventions |
| 4 | Generated word alignment | **OK technically / REVIEW OPEN scientifically** | 856 of 881 transcript words received MFA timing; 25 retained explicit AssemblyAI fallback; coverage 97.16% | This is coverage, not word-boundary accuracy. MFA QC records 67 passed segments, 29 review segments, 6 missing alignments, 395 flagged words and 390 MFA-timed words inside review segments |
| 5 | AS-unit/clause candidate table | **NG for final research use** | 60 turn-derived candidates produced | Final boundaries cannot be accepted until the research coding rule is approved |
| 6 | P025 pause table | **OK for acoustic values** | The Gold TextGrid contains 636 researcher-labeled `op` intervals; 244 meet P025 and enter the qualifying-pause table | Mid/end-clause location remains provisional because clause boundaries are not approved |
| 7 | Pause-location candidate table | **NG for final research use** | Candidate relations were generated against provisional boundaries | Must be regenerated after AS-unit/clause confirmation and alignment review |
| 8 | MWU occurrence table | **NG for final research use** | 19 provisional occurrences produced | The ten-item engineering list is not the research team's MWU definition |
| 9 | Repair and rate feature tables | **ASSUMPTION** | Transcript-visible fillers, repetitions and cut-offs were counted; word-based rates were calculated | Aggregate repair, syllable-based rates and final denominators remain open |
| 10 | External lexical-tool tables | **NG / not generated** | Status recorded as pending | TAALES/TAALED/AntConc configuration is required |
| 11 | Transition/FTO evidence handoff | **OK structurally / acceptance open** | All 22 TextTier points are retained: 18 measured FTO values and 4 Path B overlap offsets explicitly unmeasured | Final accepted Phase V transition fields remain a research-team decision |
| 12 | Early Phase V handoff | **OK structurally** | One handoff row per canonical speaker with field-level provenance | Contains a mixture of Gold-derived, generated, assumed and pending values |

### Layer 2 conclusion

The verified transcript parser, timestamped RAW/TIDY preparation, P025 acoustic handoff and transition evidence handoff are operational. Phase IV candidate generation is technically executable, but the AS-unit/clause, pause-location, MWU, repair/rate and external lexical-tool fields remain pending until the shared research definitions are approved.

## 3. Layer 3

### Input status

| No. | Input | Status | Basis used in this run | Remaining action |
|---:|---|---|---|---|
| 1 | Layer 2 handoff and feature tables | **OK structurally / ASSUMPTION semantically** | Three canonical speaker rows were received from Layer 2 | Recompute definition-dependent fields after Layer 2 rules are approved |
| 2 | P025 Gold TextGrid | **OK** | Used for independent recalculation of Layer 1 timing metrics | Add the remaining recordings and the agreed P035 treatment |
| 3 | Verified transcript | **OK** | Word/token/type counts came from the customer TXT | Word-level timing remains generated and separately flagged |
| 4 | Transition/FTO handoff | **OK structurally / acceptance open** | All 22 transition points enter Layer 3 as a separate transition-grain evidence table | Confirm which fields are accepted for the final research matrix |
| 5 | Final matrix schema and field codebook | **OPEN** | A 35-field provisional schema was used | Research team confirms final fields, names, units, null rules and observation grain |
| 6 | Study metadata | **OPEN** | Recording and canonical speaker IDs were available; participant/task/group variables were not | Supply the metadata fields required for analysis and joining |
| 7 | Representative expected Layer 2/3 rows | **OPEN** | No multilogue expected row covering lexical/MWU variables was supplied | Supply at least one researcher-calculated expected row or field-level acceptance examples |
| 8 | Validation and acceptance rules | **OPEN** | Structural checks and direct Gold recalculation were used | Confirm tolerances and which fields require exact match, sampled review or descriptive comparison |
| 9 | Reporting/archive format | **OPEN** | A provisional workbook and CSV were generated | Confirm final workbook sheets, filenames and archive package |

### Output status

| No. | Output | Status | Result | Problem / limitation |
|---:|---|---|---|---|
| 1 | Calibration matrix CSV | **OK technically** | Three participant rows and 35 fields generated; unapproved linguistic values remain blank | Field set and observation grain are not yet research-team approved |
| 2 | Calibration workbook | **OK technically** | Eight sheets generated, including Transition FTO and Transition Codebook | Workbook layout is provisional |
| 3 | Gold-derived Layer 1 validation | **OK for stated scope** | 15/15 checks passed: five timing/pause measures for each of S1-S3 | Does not validate AS-unit, MWU, repair, rate or lexical-tool fields |
| 4 | Field-level provenance | **OK** | Every matrix field records its evidence status | No simulated linguistic value is presented in the main matrix |
| 5 | Transition/FTO evidence table | **OK structurally / acceptance open** | 22 transition-grain rows enter the workbook with original marks preserved | Final accepted transition variables remain to be confirmed |
| 6 | Final linguistic feature matrix | **NG for research release** | A complete-shaped matrix exists | Definition-dependent values remain blank until the project-wide rules are approved |
| 7 | Final validation report | **NG for final acceptance** | Technical validation report generated | Requires approved definitions, expected rows and acceptance rules |

### Layer 3 conclusion

The matrix compiler, workbook generation, provenance tracking and independent recalculation mechanism are operational. Layer 3 is not yet a final research release because the final schema, metadata, expected multilogue rows and definition-dependent Layer 2 values remain open.

## 4. Why fewer per-recording inputs are now needed

The earlier input list mixed two different categories:

1. **Recording-specific evidence**, supplied for every recording.
2. **Project-wide research definitions**, supplied and approved once, then reused across all recordings.

After testing the customer's guide, the minimum recurring Layer 2 input can be simplified to:

```text
Existing WAV and accepted L1 session
+ researcher-corrected L1b TextGrid
+ verified speaker-attributed transcript TXT
```

The following are still required, but only once as a shared Definition and Matrix Pack:

- AS-unit and clause rules with examples;
- pause-location classification rule;
- MWU target definition and matching criteria;
- repair, syllable and rate rules;
- TAALES/TAALED/AntConc versions and selected variables;
- final Layer 3 field schema, observation grain and metadata fields;
- accepted Path B transition/FTO fields and handling of `FTO=NA` overlap cases;
- representative expected rows and acceptance rules;
- P035 review/regeneration decision.

This is a reduction in repeated file preparation, not a removal of the methodological requirements.

## 5. Proposed resolution path

1. **Freeze the shared definitions.** The research team confirms one versioned Definition and Matrix Pack. It applies to all ten recordings.
2. **Re-run Multilogue04.** Replace every provisional rule with the approved rule and compare the result with a researcher-calculated expected row.
3. **Agree the validation boundary.** Separate exact acoustic checks, transcript checks, sampled word-alignment review and definition-dependent feature checks.
4. **Process the remaining nine recordings.** Each recording requires its corrected TextGrid and verified TXT; the shared rules are reused.
5. **Compile the trial workbook.** Layer 3 produces the ten-recording matrix, codebook, provenance and unresolved register for the presentation trial.

## 6. Current evidence locations

- Gold input manifest: `sample-inputs/Golden/INPUT_MANIFEST.md`
- Layer 2 run: `outputs/layer2-validation/Multilogue04_C_Level30_D1G4-L2-calibration-draft-v5/`
- Layer 2 HTML report: `reports/Layer2_Provisional_Report.html`
- Layer 3 run: `outputs/layer3-validation/Multilogue04_C_Level30_D1G4-L3-calibration-draft-v6/`
- Layer 3 workbook: `outputs/research_export.provisional.xlsx`
- Layer 3 HTML report: `reports/Layer3_Provisional_Report.html`

## 7. Summary statement for the research team

The first Layer 2-to-Layer 3 engineering calibration run is complete. The customer-provided transcript and P025 TextGrid drive the pipeline, and the transition evidence reaches Layer 3 without being flattened into participant-level data. Transcript preparation, acoustic carry-through, matrix compilation and provenance checks are operational. Generated word timing remains open for review, and definition-dependent linguistic measures remain pending until the shared research definitions and final matrix requirements are confirmed.
