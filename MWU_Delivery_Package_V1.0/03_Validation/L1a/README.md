# L1a validation evidence

`l1a-test-report.json` records the D1/Milestone 1 unit and integration checks.
`l1a-api-test-report.json` records HTTP, stale-handoff and shared-task-gate regressions.
`l1a-browser-qa.json` and the desktop/mobile screenshots record the browser run.
`build-integrity.json` proves that `validation.html` references existing hash assets.
`release-inventory-report.json` records the source handover allowlist and exclusions.
`l1a-final-qa-report.md` and `l1a-final-qa-report.json` record the authoritative second-round decision.
All suites use synthetic WAV data and synthetic acoustic-candidate turns only.

Coverage includes:

- complete two-, three- and four-candidate review paths;
- Include, Exclude, Uncertain and Merge decisions;
- unique contiguous S1-SN confirmation;
- full-duration muted-mirror outputs and Phase II handoff artifacts;
- mapping-change supersession of old manifests/handoffs and stale L1b report rejection;
- secure HTTP Range audio streaming and artifact path containment;
- desktop and mobile browser evidence for the accepted L1a state.

These checks establish implementation behavior. Final QA found three P1 blockers, so the L1a
engineering gate is **FAIL - USER DECISION REQUIRED**. They do not measure diarization accuracy on
the research corpus and do not replace researcher review.
