# L1a Final QA Report

**Round:** 2 of 2  
**Decision:** FAIL - USER DECISION REQUIRED  
**P0 / P1 / P2:** 0 / 3 / 3

## Executive result

The L1a upload, candidate review, reviewer audit, dynamic S1-SN mapping, sealed artifact generation,
superseded-handoff blocking and WebUI flow are operational on synthetic fixtures. The engineering
gate cannot pass because three P1 findings remain in the downstream identity, task-state and
replayability contracts.

## Blocking findings

1. **L1b loses the recording identifier.** L1a confirms `Final_Group_04`, and `/api/l1b/input`
   selects that ID, but `scripts/l1b/run-l1b.mjs:331` derives the result ID from `source_audio`.
   The resulting report, workbook and ZIP use `source`.
2. **The shared task gate is incomplete.** During an active L1a hold, Validation and ordinary L1b
   correctly returned 409. `/api/multilogue-v2/run` returned 200 and started, while L1b finalization
   has no shared-gate acquisition (`scripts/validation-sprint/server.mjs:647` and `:773`).
3. **Superseded accepted outputs are not retained.** Reconfirmation removes and recreates the same
   accepted directory (`scripts/l1a/review-core.mjs:420-422`). Review JSON revisions remain, but the
   older sealed canonical artifact set and handoff cannot be replayed.

## Verified behavior

- Superseded handoff disappears from `/api/l1b/input`.
- Explicit execution of the superseded manifest is rejected.
- The existing L1b report becomes `stale`.
- Reconfirming the new mapping restores a selectable handoff and L1b execution.
- Source, accepted-review and artifact checksums pass `verifySealedManifest`.
- Non-overlap clips are preferred; overlap-only evidence is marked for review.
- Suffix Range bytes match the source tail; invalid Range returns 416; unknown API returns JSON 404.
- Desktop and mobile browser checks pass with audio playback, reviewer persistence, real download and
  zero console warnings/errors.
- Generic package contains no audio or populated credentials; release inventory reports 0 violations.

## Command results

| Command | Result |
|---|---|
| `npm run l1a:test` | 10 passed / 0 failed |
| `npm run l1a:api-test` | 7 passed / 0 failed |
| `npm run l1a:browser-qa` | PASS |
| `npm run phase1:pyannote:test` | 12 passed / 0 failed |
| `npm run l1b:test` | 2 passed / 0 failed |
| `npm run build` | PASS |
| `npm run sprint:build-ui` | PASS |
| `npm run release:inventory-check` | 0 violations |
| `git diff --check` | PASS |

## Evidence boundary

All L1a engineering tests in this QA round used synthetic audio and synthetic candidate turns. They
do not measure diarization accuracy on real or unseen research recordings. Automatic speaker output
remains a draft until researcher review.

This was the final allowed QA round. QA made no business-code repair and returns the remaining P1
findings to the user for decision.
