# Multilogue v2 First Slice - Quality Round 3 Handoff

## G0-G1 gate clarification

- `path_b_exclusive` is the real-data PoC baseline, but is not yet an end-to-end accuracy claim.
- Path A is an alternative route only after researcher-reference validation; provider logs alone cannot satisfy that gate.
- The canonical duration is the local WAV/ffprobe duration. Provider clock differences and clipped/rejected intervals must be reported.
- G1 is strictly local and cache-only. Network-capable code is forbidden in the adapter.
- Simultaneity below 100 ms is never labelled `ol`; normal non-overlap labels remain and `subthreshold_overlap` is emitted for review.

## Result

- Scope: synthetic, provider-neutral deterministic core only.
- Tests: 30 passed, 0 failed in each of two consecutive full runs, including the combined same-target-duplicate plus cross-target competition regression.
- Timeline validator: valid, zero errors, zero gaps, zero overlaps on every IntervalTier.
- Replay: identical run digest `9c2f58d2dc29932469b7f2be730a2dd3e25a8ecb7cce9b3d193c25880b9a4498`.
- Threshold package digests are distinct: P250 and P350 were packaged independently.

## Commands

```sh
for f in scripts/multilogue-v2/core/*.mjs tests/multilogue-v2/*.mjs; do node --check "$f" || exit 1; done
node tests/multilogue-v2/run-tests.mjs
```

## Review artifacts

- `tests/multilogue-v2/artifacts/test-report.json`
- `tests/multilogue-v2/artifacts/synthetic-six-tier.TextGrid`
- `tests/multilogue-v2/artifacts/timeline-invariant-report.json`
- `tests/multilogue-v2/artifacts/deterministic-replay.json`

The machine-readable test report contains the full changed-file inventory and known-limitations list. Round 2 corrections cover threshold provenance, competing-transfer ambiguity, subthreshold vocalisation, and the source-adjudicated BC/OL precedence.


## Known limitations

This is not a real-audio calibration result. It has no acoustic Stage-1 classifier, no Praat execution, no UI/server route, and no human-gold comparison. Actual Path A/B capability remains unresolved, so negative FTO is emitted only in declared `path_a_candidate` mode and always remains provisional. Threshold-filled same-holder gaps and ambiguity resolution remain explicit reviewable heuristics rather than human-gold-validated facts. Sub-100 ms simultaneity is excluded from `ol` and remains reviewable through a flag. The fixed PoC contract is three speakers and one supplied task duration. Legacy binary boundaries are provenance-only until a reconciliation rule is approved.
