# MWU implementation tasks

**Version:** 1.0  
**Execution model:** one ordered backlog with QA exit gates

## Delivery stages

| Stage | Scope | Entry condition | Exit evidence |
|---|---|---|---|
| D0 | Scope and UI contract freeze | Written product decisions available | Requirements, design, UI and tasks agree. |
| D1 | L1a candidate evidence and researcher review | Signed SOW, WAV fixture and provider access | Accepted S1-SN handoff and L1a QA report. |
| D2 | Dynamic N+3 shared core | Accepted L1a schema | N=2/3/4/6 schema and deterministic tests pass. |
| D3 | L1b timing, nine labels and Praat draft packaging | Sealed L1a handoff and review strategy | Praat-open draft package and retained method evidence. |
| D4 | L2 transcript and linguistic analysis | Complete approved Layer 2 input pack | Accepted Layer 2 feature handoff and validation notes. |
| D5 | L3 matrix and reporting | Accepted L1/L2 artifacts and signed codebook | Accepted matrix, report and WebUI release. |
| D6 | Technical handover | Accepted L1a-L3 release | Client-server verification and handover record. |

## M0 - specification and release controls

- [x] Create the first requirements, design and tasks baseline.
- [x] Create the lightweight delivery-package structure.
- [x] Create the first reviewable UI specification and Layer prototypes.
- [x] Record prototype review decisions and freeze the approved L1a-L3 screen contract.
- [x] Implement the provider usage ledger, Workspace summary API, allowance warning states and regression report.
- [ ] Reconcile the final signed SOW, Atlas and this specification after customer confirmation.
- [ ] Add requirement IDs to automated test reports and acceptance checklist.

**Exit gate:** no conflict remains between signed scope, nine labels, R1-R5, dynamic N+3 and the
accepted review strategy.

## M1 - L1a productization

**Milestone status:** implementation and first-round remediation complete; second-round QA acceptance pending. This milestone is not yet accepted.

- [x] Define `l1a-candidate-review-v1` and migration/version rules.
- [x] Add L1a WAV upload and run creation that exposes every provider candidate for review.
- [x] Add candidate list API with duration, interval count and representative clips.
- [x] Add secure audio streaming/range handling.
- [x] Implement Include/Exclude/Uncertain/Merge decisions.
- [x] Implement canonical S1-SN mapping and validation.
- [x] Sort raw provider clusters naturally, prefill S1-SN in that order and preserve persisted mappings on reopen.
- [x] Rebuild RTTM/CSV/TextGrid/muted-mirror artifacts after confirmation.
- [x] Invalidate dependent L1b outputs when the mapping changes.
- [x] Implement the L1a candidate-review WebUI and persistence.
- [x] Verify that convenience defaults are editable, are not described as AI-inferred identity and cannot bypass researcher confirmation.
- [x] Reset all prior-run Phase I state when a new WAV is selected.
- [x] Reject truncated WAV payloads during preflight before provider execution.
- [x] Add progressive L1a control unlocking, explicit researcher acceptance and non-destructive reset.
- [x] Store every uploaded WAV and input manifest under the server-managed Session ID before provider processing.
- [x] Keep Review active by itself until acceptance, then mark Mapping and Artifacts complete with the rebuilt outputs.
- [x] Generate one accepted L1a ZIP containing exactly the PoC-aligned TextGrid, RTTM, CSV and N muted-mirror WAVs.

**QA exit gate:** two-, three- and four-candidate fixtures complete upload -> candidate review ->
S1-SN confirmation -> Phase I artifacts. Every provider candidate remains available to the
researcher; the UI does not claim automatic teacher/student identification.

## M2 - dynamic N+3 shared core

- [x] Replace fixed production-path `SPEAKERS` assumptions with a run-scoped speaker schema.
- [x] Generalize provider mapping validation to N accepted speakers.
- [x] Generalize word assignment, floor labels, frame classification and TextGrid generation.
- [x] Preserve backward compatibility for the three-speaker Gold fixture.
- [x] Add full draft-chain N+3 tests for N=2, 3, 4 and 6.

**QA exit gate:** every generated speaker/floor tier covers the canonical duration exactly, uses the
approved vocabulary and passes deterministic replay for all fixture sizes.

## M3 - L1b integration and acceptance workflow

- [x] Consume only confirmed L1a handoff manifests; generate or reuse sealed Path B evidence inside L1b.
- [x] Reject unsealed, superseded or unsupported L1a inputs before background processing starts.
- [x] Run configurable thresholds, initially P025 and P035.
- [ ] Record 200 s intensity window, Scale Times/full-timeline state and method parameters.
- [x] Generate dynamic N+3 TextGrid, nine-label table, floor, transitions, flags and summaries.
- [x] Preserve Path B missing-overlap semantics and underlying evidence for the three-speaker Gold baseline.
- [x] Generate the six-tier Gold instance, nine-label table, floor, transitions, flags and summaries.
- [x] Replace the artifact list with one customer-facing Praat draft ZIP and a collapsed contents list.
- [x] Add an explicit selector for each session's latest accepted L1a input, mark L1b readiness and bind execution to the selection.
- [x] Initialize L1b as an empty workspace, progressively enable Generate after session selection and provide a non-destructive Reset.
- [x] Publish versioned L1b Layer/session indexes and keep L2 blocked pending researcher-reviewed TextGrid import.
- [x] Keep L1b at the local Praat review boundary; move reviewed TextGrid import and metric recomputation to L2.
- [ ] Add Praat-open and customer-package regression tests.

**QA exit gate:** Multilogue04 retains six-tier Gold compatibility; a four-speaker synthetic fixture
produces seven tiers; no overlap FTO is serialized as zero; the customer ZIP contains only the
draft TextGrids, pre-review diagnostic workbook and review note.

## M4 - Layer 2 research analysis

**Feasibility evidence:** a CLI-first thin slice is implemented and documented in
`spec/l2-feasibility.md`. It validates that the proposed modules can be connected using the
Multilogue04 researcher-corrected TextGrid, an AssemblyAI pseudo-gold transcript, local MFA and
explicitly simulated research definitions. This does not complete any production M4 task below.

- [ ] Implement the approved three-step L2 workspace: activation inputs, analysis modules, outputs/L3 handoff.
- [ ] Add reviewed L1b TextGrid upload and validate session identity, duration, dynamic N+3 tiers and nine-label vocabulary.
- [ ] Import and version the complete Layer 2 input pack and representative expected outputs.
- [ ] Block Layer 2 activation until every required item is approved; keep reviewed word alignment conditional.
- [ ] Implement reviewed transcript import and transformation log.
- [ ] Implement AS-unit/clause map import and validation.
- [ ] Integrate optional reviewed word alignment where required.
- [ ] Implement pause-location and rate metrics under signed definitions.
- [ ] Add TAALES/TAALED/AntConc adapters and versioned configurations.
- [ ] Implement MWU feature import/calculation under the approved operational definition.
- [ ] Produce Layer 2 feature table and unresolved-items report.

**QA exit gate:** customer-supplied or approved synthetic examples reproduce expected values. The
delivery clock starts only from a complete approved input pack; any missing definition blocks
activation or remains pending and cannot silently become a numeric result.

## M5 - Layer 3 matrix and reporting

**Feasibility evidence:** a provenance-aware CLI thin slice is documented in
`spec/l3-feasibility.md`. It compiles the Layer 2 v4 fixture into a participant-level matrix and
independently reconciles Gold-derived L1 fields. The schema and non-L1 values remain provisional,
so the production M5 tasks below remain open.

- [ ] Freeze matrix schema, field codebook and representative expected rows.
- [ ] Merge accepted Layer 1 and Layer 2 outputs with field-level provenance.
- [ ] Produce R/Python-ready matrix and research workbook.
- [ ] Implement validation summary and Gold/reference comparison index.
- [ ] Complete WebUI artifact browser and release downloads.
- [ ] Generate the lightweight customer delivery package from the accepted release.

**QA exit gate:** matrix columns, types, units and expected rows reconcile to the signed codebook;
no pending field is presented as validated.

## M6 - technical handover

- [ ] Produce source archive from the accepted Git tag/commit.
- [ ] Supply deployment scripts and safe configuration templates.
- [ ] Deploy to the client internal Linux server.
- [ ] Verify build, service health, representative processing and artifact download.
- [ ] Complete user guide, handover checklist, open-items register and acceptance record.
- [ ] Execute the agreed data-destruction protocol and record completion.

**QA exit gate:** the client environment runs the accepted release without provider credentials or
participant data embedded in the source package.

## Quality rules for every milestone

1. Unit and integration tests must write machine-readable reports.
2. Browser-facing changes require desktop and mobile screenshot review.
3. TextGrid changes require schema/timeline validation and a Praat-open check.
4. Gold comparisons must distinguish calibration from holdout validation.
5. A failed gate remains failed; reports shall not substitute a qualitative PASS.
6. Every delivered file must be indexed in the release note or acceptance checklist.
