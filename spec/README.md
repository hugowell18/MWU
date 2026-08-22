# MWU implementation specification

This directory is the approved implementation baseline for the MWU research-processing system.
It uses one lightweight specification set rather than separate documents for every Layer:

- `requirements.md` defines required behavior and acceptance boundaries.
- `design.md` defines the target architecture and maps it to the current codebase.
- `ui-design.md` defines the researcher-facing workspace, states and requirement traceability.
- `ui/MWU_Layer_UI_Prototypes.html` is the reviewable L1a-L3 WebUI prototype.
- `tasks.md` defines the implementation order and QA exit gates.

## Implementation sequence

1. Read the matching requirements in `requirements.md`.
2. Confirm the architecture and current-code boundary in `design.md`.
3. Confirm the matching screen and state in `ui-design.md`.
4. Execute the corresponding milestone in `tasks.md`.
5. Record test evidence before changing an item to complete.

## Source precedence

When two sources disagree, use this order:

1. Signed Statement of Work and approved written changes.
2. Research-team-confirmed Workflow Atlas, nine labels and floor rules R1-R5.
3. This specification set.
4. Existing implementation and tests.
5. Historical PoC and Validation Sprint documents.

`specs/validation-sprint-*.md` remains historical evidence for the SpeakerX monologue
benchmark. It does not define the production L1a-L3 product.

## Status vocabulary

| Status | Meaning |
|---|---|
| implemented | A current code path and automated evidence exist. |
| partial | Useful code exists, but the complete product contract is not met. |
| planned | Target behavior is defined but not yet implemented. |
| external input | Delivery depends on a research definition or reference supplied by the Client. |

## Snapshot date

Version 1.0 reflects the repository and approved L1a-L3 target UI as reviewed on 2026-08-21.
It is a development baseline, not a declaration that every Layer is complete.
