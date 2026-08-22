# MWU WebUI design specification

**Version:** 1.0  
**Status:** Approved implementation baseline  
**Visual baseline:** Current ValidationApp slate/blue workspace  
**Prototype:** `ui/MWU_Layer_UI_Prototypes.html`

## 1. Purpose

This document defines the frozen L1a-L3 researcher-facing screen contract. The prototype is a
target interaction contract, not evidence that every control is already implemented. It uses
illustrative data only and does not contain client audio, transcripts or Gold annotations.

## 2. Reference lock

The current MWU ValidationApp is the primary design reference.

- Preserve the 64 px white navigation, slate canvas, blue action color and compact operational density.
- Preserve the left Layer navigation and flat, bordered work sections.
- Use green only for passed/accepted state, amber for review/attention and red for blocking failures.
- Keep cards at 8 px radius or less and avoid nested decorative cards.
- Prefer tables, status strips, segmented controls and compact artifact rows over marketing composition.
- Do not add a new hero, illustration system or unrelated dashboard visual language.

## 3. Shared workspace shell

| UI region | Purpose | Requirements |
|---|---|---|
| Top navigation | Product identity, Workspace/Methodology navigation and user context | UI-001 |
| Recording bar | Canonical WAV, run ID, duration and current release state | SYS-001, UI-001, UI-004 |
| Layer rail | L1a, L1b, L2 and L3 navigation with state badges | SYS-009, UI-001 |
| Main workspace | Layer-specific input, operation, evidence and output controls | UI-002 |
| Gate strip | Exact condition required before the next Layer or release | SYS-005, UI-003, UI-007 |

The product runs one active processing task at a time. Navigation may inspect completed artifacts,
but a second processing job cannot start while the active job is running.

## 4. L1a prototype - speaker evidence and participant review

**Primary decision:** Which acoustic candidates are retained and how they map to S1-SN.

### Screen regions

1. Input: upload one room-mix WAV and run format/canonical-clock preflight.
2. Pipeline state: preflight, provider processing, candidate review and artifact rebuild.
3. Candidate evidence table: activity duration, interval count and representative early/middle/late clips.
4. Researcher decision controls: Include, Exclude, Uncertain or Merge, followed by canonical mapping.
5. Confirmation gate: all candidates resolved, included identities uniquely mapped and downstream invalidation acknowledged.
6. Accepted deliverables: one speaker TextGrid, RTTM, CSV and N muted-mirror WAVs, grouped exactly as in the L1a PoC.

Fresh candidate rows use editable Participant, Include and sequential S1-SN working defaults. The
Review and Mapping stages remain unconfirmed until the researcher saves and accepts the mapping.
Selecting a different WAV clears all prior-run progress and output state immediately.
The screen unlocks progressively: Browse is initially available; Generate becomes available after
WAV selection; reviewer and finalization controls become available after candidates exist.
`Accept mapping & build outputs` records the accepted review, seals the mapping, builds the N+3
L1a delivery set and publishes the L1b handoff in one action. Reset clears the current view without
deleting sealed session evidence.

The upload screen sends one room-mix WAV into candidate generation. The accepted participant count
is established only after the researcher reviews all candidates; the system does not infer identity.

### Requirement traceability

| Prototype element | Requirements |
|---|---|
| Single-WAV upload and preflight | L1A-001, L1A-003, UI-006 |
| Progressive action unlocking and reset | UI-003, UI-013, L1A-013, L1A-016 |
| Representative clip controls | L1A-004 |
| Research role selector | L1A researcher decisions and candidate-review schema |
| Include/Exclude/Uncertain/Merge controls | L1A-005 |
| S1-SN mapping column | L1A-006 |
| Downstream invalidation notice | L1A-007 |
| Muted-mirror wording | L1A-008 |
| Confirm participant mapping action | L1A human gate, UI-003 |
| PoC-aligned accepted download groups | L1A-003 outputs, UI-002 |

## 5. L1b prototype - acoustic timing and interaction TextGrid

**Primary decision:** Whether threshold-specific drafts are ready for Praat review and finalization.

### Screen regions

1. Sealed L1a handoff summary with canonical speakers and source timeline.
2. Configurable threshold controls, initially P025 and P035, plus method parameters.
3. Path B and nine-label method summary.
4. Execution status by threshold and speaker.
5. Results grouped into TextGrids, duration evidence, method records and review upload.
6. Finalization gate based on reviewed TextGrid input.

### Requirement traceability

| Prototype element | Requirements |
|---|---|
| Independent threshold controls | L1B-001, L1B-002 |
| Path B status and missing-overlap wording | L1B-003, L1B-004, UI-007 |
| N+3 and nine-label summary | L1B-005, L1B-006 |
| Grouped artifacts | L1B outputs, UI-005 |
| Praat-reviewed upload and finalization | L1B human gate, UI-003, UI-004 |

## 6. L2 prototype - transcript and linguistic analysis

**Primary decision:** Whether all research definitions and reviewed inputs required by the selected
analysis are present.

### Screen regions

1. **Inputs and activation conditions:** one list containing accepted L1 evidence, reviewed transcript,
   AS-unit/clause and pause-location rules, MWU definition, repair/rate rules, lexical-tool settings,
   representative expected outputs and conditional reviewed word alignment.
2. **Approved analysis modules:** transcript split, AS-unit/clause mapping, pause/rate and lexical/MWU.
3. **Outputs and L3 handoff:** RAW/TIDY, mapping/unresolved report, feature tables, validation notes and
   the early Phase V merge table.

Missing required definitions are shown beside the affected input. The UI does not duplicate the same
blocker in a separate unresolved table. The bottom gate summarizes only the action needed to activate
Layer 2. The five-day target begins after the complete input pack is approved.

### Requirement traceability

| Prototype element | Requirements |
|---|---|
| Unified input/activation list | L2-001, L2-002, UI-003, UI-011 |
| Optional word-alignment state | L2-008, UI-007 |
| Transcript and mapping modules | L2-003, L2-004 |
| Pause/rate and lexical/MWU modules | L2-005, L2-006, L2-007 |
| Output and L3 handoff groups | L2-009, L2-010, UI-005 |

## 7. L3 prototype - matrix, validation and release

**Primary decision:** Whether accepted upstream evidence reconciles to the signed matrix schema.

### Screen regions

1. Accepted L1/L2 input ledger and signed codebook state.
2. Matrix summary with rows, columns, pending fields, validation failures and provenance coverage.
3. Exception table with field, record, source and disposition.
4. Field-level provenance sample.
5. Release candidate package and blocking gate.

### Requirement traceability

| Prototype element | Requirements |
|---|---|
| Signed schema and codebook state | Layer 3 inputs, UI-003 |
| Pending/unsupported counters | Layer 3 boundaries, UI-007 |
| Exception table | Layer 3 validation output |
| Provenance sample | Layer 3 field-level provenance design |
| Release candidate action | Layer 3 outputs, UI-004, UI-005 |

## 8. WebUI scope boundary

The direct research WebUI contains L1a, L1b, L2, L3 and the read-only Workflow Atlas. Technical
handover remains a deployment, documentation and acceptance milestone outside this WebUI.

## 9. States and language

| State | Meaning | UI treatment |
|---|---|---|
| Draft | Automatic or editable output not yet reviewed | Neutral/blue |
| Review required | A researcher decision is needed | Amber |
| Accepted | Required review or acceptance is recorded | Green |
| Blocked | Required input, definition or evidence is absent | Red with blocker text |
| Superseded | Upstream mapping changed and the artifact is no longer current | Muted with replacement reference |

The interface must use `candidate`, `cluster` or `canonical speaker` until the researcher confirms
identity. It must not imply that AI has identified a teacher, student or named participant.

## 10. Approved screen-contract checklist

- Does each Layer show the exact input required by `requirements.md`?
- Is the researcher decision visible at the correct point instead of hidden in a download step?
- Are target-only controls clearly distinguishable from current implementation status?
- Can missing definitions, unresolved values and overlap limitations remain visible?
- Are outputs grouped in the way researchers will review and download them?
- Does the handoff to the next Layer match `design.md` and the Workflow Atlas?
