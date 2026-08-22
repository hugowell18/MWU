# MWU system requirements

**Version:** 1.0  
**Status:** Approved implementation baseline  
**Applies to:** L1a, L1b, L2, L3 and final technical handover

## 1. Product objective

The system shall convert confidential L2 multilogue room-mix recordings into traceable,
reviewable research artifacts. Automated diarization, ASR, acoustic detection and rule-based
labels are drafts. Researcher-corrected TextGrid, transcript and matrix files are the final
research data.

## 2. Shared requirements

| ID | Requirement |
|---|---|
| SYS-001 | The original WAV shall remain the canonical acoustic clock. |
| SYS-002 | All generated intervals shall remain within the canonical timeline and shall not introduce gaps or overlaps inside an IntervalTier. |
| SYS-003 | The production design shall support two or more participant speakers. The TextGrid target is dynamic N+3: N speaker tiers plus floor, transitions and flags. |
| SYS-004 | The three-speaker Multilogue04 Gold is the current quantitative reference, not a restriction on future speaker count. |
| SYS-005 | AI output shall be identified as an automatic draft until a researcher records review completion. |
| SYS-006 | Provider, model, parameters and output state shall be recorded in the method and validation records delivered for the run. |
| SYS-007 | Uncertain or unsupported values shall remain missing or flagged. The system shall not serialize unsupported values as zero. |
| SYS-008 | Client research audio shall not be committed to the source repository or included in a generic delivery template. |
| SYS-009 | The WebUI shall run one processing task at a time and expose the active Layer, current state, artifacts and review handoff. |
| SYS-010 | Routine method parameters shall be configurable without changing the output schema. |
| SYS-011 | Every processing run shall have one stable Session ID, one server-managed canonical input folder and a versioned `L1a/L1b/L2/L3` folder/index structure so that each accepted Layer output can be selected as the next Layer input. |
| SYS-012 | Every successfully completed AssemblyAI or pyannoteAI remote job shall append one auditable usage event. The event shall count the full source-audio duration; a new rerun counts again, while polling or retrying the same provider job ID shall not duplicate usage. Mock, cache and offline replay paths shall not count. |

### 2.1 WebUI requirements

| ID | Requirement |
|---|---|
| UI-001 | The WebUI shall retain one consistent workspace shell with visible Layer navigation and the active recording/run context. |
| UI-002 | Every Layer workspace shall show input readiness, the processing path, current state, output artifacts and its human or acceptance gate. |
| UI-003 | A blocked action shall remain disabled and display the missing input, definition or review decision that blocks it. |
| UI-004 | Draft, reviewed, accepted, failed and superseded artifacts shall be visually distinguishable. |
| UI-005 | Artifact downloads shall be grouped by threshold, speaker, output family or release stage rather than presented as one undifferentiated list. |
| UI-006 | L1a shall accept the room-mix WAV, expose every generated acoustic candidate and leave study inclusion to researcher review. |
| UI-007 | Missing, unsupported and unresolved values shall remain visible and shall not be presented as zero or complete. |
| UI-008 | The production workspace shall support desktop and narrow-screen review without clipped controls, tables or status text. |
| UI-009 | Primary controls shall use clear labels, keyboard-visible focus and familiar icons where the action is unambiguous. |
| UI-010 | Prototype and demonstration screens shall identify illustrative data and shall not imply that target-only capability is already implemented. |
| UI-011 | L2 shall present one activation list containing reviewed evidence, required research definitions and conditional inputs. Layer 2 execution shall remain disabled until every required item is approved. |
| UI-012 | Every Layer result shall display the Session ID, Layer revision and next-layer input readiness without mixing internal handoff evidence into customer deliverables. |
| UI-013 | L1a controls shall unlock progressively: Browse first, Generate after WAV selection, and researcher acceptance only after candidate generation and reviewer identification. Editable review state and final artifact generation shall remain visually and semantically distinct. |
| UI-014 | After candidate generation, Review alone shall display as active while Mapping and Artifacts remain pending. Review, Mapping and Artifacts shall display as passed only after the researcher accepts the mapping and the server rebuilds the outputs. |
| UI-015 | The Workspace shall display the configured combined provider allowance, cumulative processing hours, per-provider hours/calls and deduplicated source-audio hours. Warning states shall remain visibly distinct, and unavailable ledger data shall not be shown as zero. |

## 3. Layer 1a - speaker evidence and candidate review

### 3.1 Inputs

- Original room-mix WAV. The full file becomes the canonical timeline after preflight.
- Approved diarization/ASR provider configuration, maintained server-side rather than entered in the researcher upload screen.
- Researcher decisions identifying the participant candidates to retain.

### 3.2 Functional requirements

| ID | Requirement |
|---|---|
| L1A-001 | The system shall preflight the WAV and record duration, format and canonical-clock status. |
| L1A-002 | Diarization shall produce timed speaker candidates without claiming real-world identity. |
| L1A-003 | Provider processing may estimate acoustic clusters internally, but every resulting candidate shall be exposed for review. The system shall not infer participant, teacher or incidental identity. |
| L1A-004 | The WebUI shall present representative playable clips and activity summaries for each candidate. |
| L1A-005 | A researcher shall be able to Include, Exclude, mark Uncertain and Merge candidate identities. |
| L1A-006 | Included candidates shall be mapped explicitly to canonical identifiers S1-SN before Phase I finalization. |
| L1A-007 | Changing an accepted candidate decision shall invalidate downstream L1b artifacts derived from the earlier mapping. |
| L1A-008 | Muted-mirror WAVs shall preserve the original full timeline and mute non-target intervals. They shall not be described as clean source separation. |
| L1A-009 | Provider overlap evidence and unresolved attribution shall remain available for review. |
| L1A-010 | L1a WAV uploads shall enforce a configurable body limit (default 512 MiB), reject oversized requests and release processing state after aborted or failed uploads. |
| L1A-011 | An accepted manifest shall seal the source WAV, accepted review and major artifacts with SHA-256 checksums; the handoff shall reference the final manifest hash without a circular self-hash. |
| L1A-012 | L1a, L1b and Validation execution shall share one active-task gate in the WebUI service. |
| L1A-013 | Selecting a new WAV shall immediately clear the previous run snapshot, candidate decisions, accepted outputs and Phase I progress states before the new run starts. |
| L1A-014 | Fresh diarization candidates shall be prefilled as Participant, Include and sequential S1-SN for review efficiency. These editable defaults shall not count as researcher confirmation or identity inference. |
| L1A-015 | WAV preflight shall reject a truncated or internally inconsistent data chunk before any third-party diarization request is submitted. |
| L1A-016 | The L1a workspace shall support a non-destructive one-click reset that clears the selected input and local run view without deleting sealed session evidence. |
| L1A-017 | A browser-selected WAV shall be uploaded to `sessions/{session_id}/input/source.wav` on the server with a session input manifest containing its original filename, byte count and SHA-256. Subsequent Layers shall reference this managed session input rather than a client filesystem path. |
| L1A-018 | Raw provider candidates shall be presented in natural ascending provider-label order. Fresh runs shall prefill contiguous S1-SN values in that order, while any persisted researcher mapping shall take precedence and shall not be silently renumbered when an accepted run is reopened. |
| L1A-013 | Superseded handoffs shall be unselectable, explicit L1b reuse shall be rejected, and derived latest reports shall be exposed as stale. |

### 3.3 Outputs

The researcher-facing download set shall remain identical to the accepted L1a PoC:

- One speaker activity TextGrid.
- Speaker turns as RTTM and CSV.
- One full-duration muted-mirror WAV per included canonical speaker.

The reviewed decision record, speaker-turn JSON, invalid-interval TSVs, review flags, provider
evidence summary and Phase II handoff manifests are internal audit/handoff evidence. They remain
stored and checksummed but shall not be presented as additional customer L1a deliverables.

### 3.4 Human gate

L1a is accepted only after the researcher confirms the participant set and canonical S1-SN
mapping. AI clusters alone are not the final participant definition.

## 4. Layer 1b - acoustic timing and interaction TextGrid

### 4.1 Inputs

- Original room-mix WAV.
- Accepted L1a mapping, speaker evidence and muted-mirror tracks.
- Threshold list, initially 0.25 s and 0.35 s.
- Versioned method parameters and research-team review strategy.

### 4.2 Functional requirements

| ID | Requirement |
|---|---|
| L1B-001 | Each pause threshold shall run independently on the same canonical timeline. |
| L1B-002 | The threshold list shall be configurable and shall not be hard-coded to exactly two values. |
| L1B-003 | The baseline operating route shall be Path B. Detected overlap at a transition shall be reported as present with offset not measured. |
| L1B-004 | Underlying turn-end, turn-start, raw-gap and overlap-capability evidence shall be retained for later recomputation. |
| L1B-005 | Each threshold shall produce a dynamic N+3 TextGrid and corresponding tabular evidence. |
| L1B-006 | The speaker tiers shall use only the approved nine-label vocabulary. |
| L1B-007 | The floor tier shall follow R1-R5. |
| L1B-008 | The output shall preserve full-timeline Scale Times behavior and record the 200 s Praat intensity window where applicable. |
| L1B-009 | The WebUI shall expose one Praat draft package for download. Researcher correction occurs in local Praat; L1b shall not require a reviewed-TextGrid upload or finalization action. |
| L1B-010 | The researcher-reviewed TextGrid shall be imported and validated when Layer 2 begins. Any downstream duration or pause metric shall be recomputed from those reviewed boundaries rather than silently using the L1b draft. |
| L1B-011 | Customer-facing L1b filenames shall use the recording stem and explicit threshold only: `{recording}_0.25s.TextGrid`, `{recording}_0.35s.TextGrid`, `{recording}_L1b_Draft_Diagnostics.xlsx` and `{recording}_L1b_Praat_Draft.zip`. Internal method versions, draft modes and calculated tier counts shall remain in manifests and method logs, not filenames. |
| L1B-011 | The WebUI shall list the latest accepted L1a revision for every processing session, visibly distinguish runnable and blocked entries, require explicit selection, and bind execution and newly displayed results to that manifest. Superseded revisions shall not clutter the selector. |
| L1B-012 | L1b shall open with no selected session and no restored prior-run result. Generate shall remain disabled until a runnable L1a session is selected, and a non-destructive Reset shall restore this initial state without deleting sealed session evidence. |

### 4.3 Nine-label vocabulary

| Code | Name | Assignment boundary |
|---|---|---|
| s | Speech | Lexical speech by the current floor holder. |
| f | Filled hesitation | Nonlexical hesitation by the holder; retains the floor. |
| bc | Backchannel | Short non-projecting listener response while the holder continues. |
| ol | Overlap | Simultaneous qualifying speech for at least the configured minimum overlap. |
| op | Own pause | Holder is silent and subsequently retains the floor. |
| pf | Pause while floor held | Non-holder is silent while another speaker holds the floor. |
| tr | Transition gap | Floor is free no longer than L before a different speaker enters. |
| shs | Shared silence | Floor is free longer than L, or remains free to task end. |
| x | Unusable/non-speech event | Wordless laughter, cough, handling noise or unusable audio. |

### 4.4 Floor rules

| Rule | Definition |
|---|---|
| R1 | Start with floor FREE. |
| R2 | The first turn-taking vocalisation claims the floor. |
| R3 | Holder silence and qualifying backchannels do not release the floor. |
| R4 | A competing turn transfers the floor only when it survives the holder's turn. Ambiguity is flagged. |
| R5 | Resolve silence retrospectively as op, tr or shs according to who resumes and when. |

### 4.5 Outputs and retained evidence

The researcher-facing L1b download is one Praat draft ZIP containing:

- One dynamic N+3 TextGrid per configured threshold.
- One pre-review diagnostic workbook.
- One short review note describing the research boundary and next step.

Nine-label tables, floor and transition evidence, flags, overlap-capability evidence, method
parameters, validation summaries and hashes remain stored in the session archive. They are not
presented as separate customer downloads.

### 4.6 Human gate

The research team downloads the draft package and corrects the selected threshold draft or drafts
in local Praat according to its confirmed review strategy. The reviewed TextGrid is saved locally
and becomes an explicit Layer 2 upload; there is no second upload or finalization action in L1b.

## 5. Layer 2 - transcript and linguistic analysis

### 5.1 Required research inputs

Layer 2 proceeds when the following inputs are available and mutually understood:

- Researcher-reviewed L1b TextGrid uploaded at Layer 2 activation.
- Researcher-reviewed verbatim transcript.
- AS-unit and clause segmentation rules with representative examples.
- Pause-location classification rules.
- MWU operational definition, examples and any approved reference list.
- Filler, repetition, false-start and repair coding rules.
- Word/syllable rate definitions.
- Reviewed word alignment when the selected analysis requires word-level timing.
- TAALES, TAALED and AntConc versions, settings and requested variables.
- Representative target tables or Gold outputs.

### 5.2 Outputs

- RAW-TIMING and TIDY-PHRASE transcript files.
- AS-unit/clause mapping table and unresolved-boundary report.
- Lexical and MWU feature tables.
- Pause-location and rate metrics under the approved definitions.
- Early Phase V merge table and Layer 2 validation notes.

### 5.3 Functional requirements

| ID | Requirement |
|---|---|
| L2-001 | The system shall import a versioned Layer 2 input pack containing accepted L1 evidence, the reviewed transcript, research definitions and representative expected outputs. |
| L2-001A | Layer 2 import shall validate the reviewed TextGrid against the selected session, canonical duration, contiguous S1-SN mapping, dynamic N+3 tier schema and approved nine-label vocabulary before it becomes accepted timing evidence. |
| L2-002 | Layer 2 execution shall remain blocked until every required activation input is approved. Conditional word alignment may remain not required when no selected metric makes a word-level timing claim. |
| L2-003 | Transcript splitting shall produce RAW-TIMING and TIDY-PHRASE files with a transformation log that preserves fillers, repetitions, false starts and repairs. |
| L2-004 | AS-unit, clause and pause-location mapping shall use only the approved rules and shall produce an unresolved-boundary report. |
| L2-005 | Pause and rate metrics shall use the accepted L1 timing evidence and the approved location, count and time-denominator definitions. |
| L2-006 | Lexical and MWU values shall be generated only under approved tool settings and an approved MWU operational definition. |
| L2-007 | TAALES, TAALED and AntConc outputs shall record tool version, requested variables and configuration. |
| L2-008 | Reviewed word alignment shall be required only for selected word-level pause/MWU timing claims; no such claim shall be emitted without alignment evidence. |
| L2-009 | Missing or unsupported inputs shall remain visible as blocking or pending states and shall not become inferred numeric values. |
| L2-010 | The Layer 2 handoff shall include the approved feature table, unresolved-items record, validation notes and field provenance required by Layer 3. |

### 5.4 Boundaries

- Transcript transformations shall be logged and shall not silently remove repair evidence.
- No word-level pause/MWU timing claim shall be made without reviewed alignment evidence.
- Missing definitions shall be shown as pending; values shall not be fabricated.

## 6. Layer 3 - matrix, reporting and operational completion

### 6.1 Inputs

- Accepted Layer 1 and Layer 2 artifacts.
- Signed matrix schema and field-level codebook.
- Representative expected rows and validation rules.
- Approved reporting and archive format.

### 6.2 Outputs

- R/Python-ready final matrix.
- Research workbook and data codebook.
- Validation summary and Gold/reference comparison index.
- Downloadable artifact package and finalized operational WebUI.
- Archive-ready method and delivery records.

### 6.3 Boundaries

The system does not guarantee statistical findings, research conclusions, publication writing or
publication acceptance.

## 7. Operation, acceptance and handover

| ID | Requirement |
|---|---|
| HND-001 | Development and acceptance shall run on an agreed VPS before local-server handover. |
| HND-002 | Final handover shall include versioned source, deployment scripts, safe configuration templates and operation documentation. |
| HND-003 | Credentials and participant data shall not appear in source archives, screenshots or public logs. |
| HND-004 | Deployment verification shall cover build, service startup, health check, representative job execution and artifact download. |
| HND-005 | Acceptance shall record passed items, open items and the accepted release identifier. |

## 8. Current implementation status

| Area | Status | Evidence / gap |
|---|---|---|
| L1a provider execution and artifacts | implemented | WAV preflight, provider candidates, representative audio evidence, versioned review, confirmation and rebuilt Phase I artifacts are implemented. |
| L1a dynamic canonical mapping | implemented | L1a accepts two or more retained candidates and validates a unique contiguous S1-SN mapping used directly by L1b. |
| L1b P025/P035 automatic draft | implemented for dynamic N+3 | Accepted L1a S1-SN is the sole speaker-count source. The runner prepares missing internal evidence, performs deterministic threshold replay and publishes one Praat draft package. Researcher-reviewed TextGrid import belongs to L2. |
| Nine labels and Path B engine | implemented for draft generation | N=2/3/4/6 full draft-chain tests pass; three-speaker PoC/Gold compatibility remains the quantitative regression reference. Accuracy for other speaker counts is validation-dependent. |
| L2 analysis | partial | Experimental scripts exist and the three-step UI contract is approved; production integration and signed research definitions remain outstanding. |
| L3 matrix/reporting | partial | Validation Sprint and research-export prototypes exist; final schema and product workflow remain outstanding. |
