# L1a QA Gate Matrix

**Final QA date:** 2026-08-21 (America/Los_Angeles)  
**Scope:** D1 / M1 - L1a speaker evidence and researcher candidate review  
**Final result:** FAIL - USER DECISION REQUIRED  
**Evidence rule:** Engineering suites use synthetic WAV and candidate fixtures. They do not measure diarization accuracy on real research audio.

## 1. Status legend

| Status | Meaning |
|---|---|
| PASS | Independently reproduced with current code and evidence. |
| FAIL | A P0/P1 issue blocks the engineering gate. |
| OPEN | Non-blocking release or evidence work remains. |

## 2. Final acceptance matrix

| Gate | Requirement | Final evidence | Status |
|---|---|---|---|
| L1A-QA-001 | Accept one room-mix WAV, preflight it, and seal duration/format as the canonical clock. | Valid/invalid/oversize/aborted uploads pass; source WAV checksum and canonical duration are sealed. | PASS |
| L1A-QA-002 | Expose all acoustic candidates without AI identity inference or participant-count input. | Provider count is unconstrained by L1a; UI exposes every returned cluster and only stores researcher-entered roles. | PASS |
| L1A-QA-003 | Expose activity statistics and representative evidence for every candidate. | N=2/3/4 and overlap fixtures pass. Clean non-overlap turns are preferred; overlap-only evidence is flagged. | PASS |
| L1A-QA-004 | Stream representative audio safely with seek support. | Ordinary and suffix Range return correct bytes; malformed range returns 416; browser playback passes. | PASS |
| L1A-QA-005 | Persist Include, Exclude, Uncertain and Merge in a versioned reviewer record. | Blank reviewer and unresolved candidates block confirmation; reviewer ID and revisions persist. | PASS |
| L1A-QA-006 | Map included candidates uniquely and contiguously to S1-SN. | N=2/3/4, merge and invalid-state fixtures pass. | PASS |
| L1A-QA-007 | Rebuild canonical artifacts and produce a sealed L1a handoff. | JSON/CSV/RTTM/TextGrid, N muted mirrors, invalid TSV, flags, review and artifact checksums pass `verifySealedManifest`. | PASS |
| L1A-QA-008 | Supersede old evidence and preserve a correct, replayable L1a-to-L1b chain. | Old handoff is blocked and old L1b report becomes stale; new confirmation becomes selectable. However, L1b reports/workbooks/packages still identify the recording as `source`, and reconfirmation overwrites the prior accepted artifact directory instead of retaining a replayable superseded release. | FAIL |
| L1A-QA-009 | Contain API paths, uploads and failure states. | Traversal, malformed JSON, unknown API, upload limit/abort, suffix Range and 416 cases pass. | PASS |
| L1A-QA-010 | Enforce one active processing task across the workspace. | L1a blocks Validation and ordinary L1b. `/api/multilogue-v2/run` still starts during an active L1a run, and `/api/l1b/finalize` does not use the shared gate. | FAIL |
| L1A-QA-011 | WebUI shows truthful input, process, evidence, output and human-gate states. | Desktop 1440 px and mobile 390 px pass; audio, reviewer persistence, save, confirm and actual artifact download work; console has zero warnings/errors. | PASS |
| L1A-QA-012 | Keep release artifacts and validation evidence internally consistent. | Referenced hashed assets exist and build verification passes. New hash assets remain untracked while old tracked hashes are deleted; package test snapshots predate the final rerun. | OPEN |
| L1A-QA-013 | Keep draft, accepted, superseded and QA claims truthful. | Package remains QA Pending/Not Ready and explicitly identifies synthetic evidence. This final report records the failed engineering gate. | PASS |
| L1A-QA-014 | Exclude client audio, credentials and provider payloads from the source handover candidate. | Inventory reports 0 policy violations; generic delivery package contains no audio or populated credentials. | PASS |

## 3. Blocking findings

| ID | Severity | Finding | Evidence |
|---|---|---|---|
| L1A-QA2-001 | P1 | L1b ignores `manifest.recording_id` and derives `source` from `source_audio`. Output directory is correct, but report rows, workbook and ZIP are named `source`. | Independent API run: selected ID `Final_Group_04`; resulting L1b report ID `source`. Code: `scripts/l1b/run-l1b.mjs:331`. |
| L1A-QA2-002 | P1 | The shared task gate is incomplete. | With L1a held active: Validation and ordinary L1b returned 409, while `/api/multilogue-v2/run` returned 200 and started; L1b finalization has no `acquireTask`. Code: `scripts/validation-sprint/server.mjs:647` and `:773`. |
| L1A-QA2-003 | P1 | A superseded accepted L1a artifact set is not retained as an immutable replayable release. | `confirmReview` removes the existing accepted directory before rebuilding it at the same path. After revision 2, only revision 2 canonical artifacts remain. Code: `scripts/l1a/review-core.mjs:420-422`. |

## 4. Non-blocking findings

| ID | Severity | Finding |
|---|---|---|
| L1A-QA2-004 | P2 | New validation JS/CSS hashes exist and pass integrity verification but remain untracked while old tracked hashes are deleted. They must be included atomically in the eventual release commit. |
| L1A-QA2-005 | P2 | Package copies of the unit/API/browser reports are truthful but are snapshots from before this final rerun; the final QA report is the authoritative second-round record. |
| L1A-QA2-006 | P2 | `l1a:api-test` stops after proving stale-state rejection. It does not cover reconfirmation, restored handoff availability, immutable superseded replay, or the multilogue/finalize shared-gate branches. |

## 5. Final command record

| Command | Result |
|---|---|
| `npm run l1a:test` | 10 passed / 0 failed |
| `npm run l1a:api-test` | 7 passed / 0 failed |
| `npm run l1a:browser-qa` | PASS; desktop/mobile, audio, reviewer, artifacts and console checks passed |
| `npm run phase1:pyannote:test` | 12 passed / 0 failed |
| `npm run l1b:test` | 2 passed / 0 failed |
| `npm run build` | PASS |
| `npm run sprint:build-ui` | PASS; two referenced hash assets present |
| `npm run release:inventory-check` | 0 violations |
| `git diff --check` | PASS |

## 6. Evidence boundary

This result evaluates the L1a engineering workflow using synthetic fixtures and deterministic API/browser checks. It does not establish diarization accuracy, speaker attribution accuracy or usability on unseen research recordings. Research-corpus output remains a draft until researcher review.

Because P1 findings remain after the second and final QA round, QA performed no business-code repair. Resolution is returned to the user for scope and release judgment.
