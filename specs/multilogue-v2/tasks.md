# Multilogue v2 Calibration Core - Tasks

## G0-G1 real-data extension

- [x] Correct the Workflow Atlas method wording and emit the G0 contract report.
- [x] Build a provider-neutral Stage-1 adapter using the local WAV and cached Pyannote/AssemblyAI artifacts only.
- [x] Use WAV/ffprobe duration as the canonical timeline and report provider clock mismatches.
- [x] Emit a threshold-neutral 10 ms room-activity base, canonical speaker mapping provenance, minimal timed lexical evidence, unknown non-word evidence, and review flags.
- [x] Add adapter unit/integration tests and run the existing Phase-I and multilogue-v2 regressions.
- [x] Run the adapter on Multilogue04 and emit the Phase-I gate artifacts without an accuracy claim.

| Adapter gate | Status | Evidence |
|---|---|---|
| G1 cached-provider adapter | Complete | Bijective mapping, canonical WAV duration, required output structure, unknown/floor-stream separation, bounded intervals, deterministic replay and regression suites pass. |

## First Slice

| Task | Requirement links | Quality evidence |
|---|---|---|
| T1 Mapping and word assignment | Q1-DES-001, Q1-DES-003 | mapping, null-confidence, overlap/tie/unresolved tests |
| T2 10 ms shared activity per threshold | Q1-DES-002 | 0.25/0.35 independence test |
| T3 Stage-1 evidence normalization | Q1-DES-003, Q1-DES-005 | uncertainty, artifact, laughter and soft-chuckle tests |
| T4 Persistent floor and label engine | Q1-DES-002, Q1-DES-005 | Appendix 10.1-10.6 plus edge-rule tests |
| T5 Conditional provisional FTO | Q1-DES-002, Q1-DES-005 | negative, positive, failed bid and Path B tests |
| T6 Fixed six-tier TextGrid and validator | Q1-DES-004 | generated TextGrid and invariant report |
| T7 Frozen in-memory package schemas | Q1-DES-008 | schema assertions and package manifest |
| T8 Security and deterministic replay | Q1-DES-006, Q1-DES-007 | source scan, replay digest and no-client-data checks |

## G2 Path B dual-threshold package

- [x] Validate and preserve G1 initial review flags without admitting unknown residual evidence to the floor event stream.
- [x] Run P=0.25 and P=0.35 independently under `path_b_exclusive`.
- [x] Write six-tier draft TextGrid, frozen-schema CSV, method manifest, timeline validation and run summary for each threshold.
- [x] Withhold automatic negative FTO and expose potential overlap transfer evidence for review.
- [x] Record the review strategy as `awaiting_research_team`; do not propagate review state between thresholds.
- [x] Provide a separate reviewed-TextGrid finalizer that recomputes signed FTO only after researcher correction.
- [x] Validate the real draft TextGrids with Praat headless and retain deterministic, security-scanned gate evidence.
- [x] Require a hash-bound researcher review attestation before finalization; reject unchanged drafts, open Tier6 flags and contradictory boundaries.
- [x] Preserve qualified Pyannote overlap intersections as review-only provider candidates without asserting `ol` or driving floor state.
- [x] Add a `path_b_transfer_review_required` flag for every floor transfer and mark draft `ol`/`x` observations unavailable.
- [x] Bind Phase-II manifests to Phase-I manifests, provider revisions, canonical clock, VAD parameters, gap filling and lexicon versions.

## Implementation traceability

| Task | Code anchors | Test evidence | Status |
|---|---|---|---|
| T1 | `core/mapping.mjs`: `validateMappingContract`, `mapAttributionTurns`, `assignWordsByMaximumOverlap` | provider mapping, null confidence, all tie breaks, unresolved word | Complete |
| T2 | `core/timeline.mjs`: `buildBaseActivityFrames`, `deriveSharedActivity`; `core/pipeline.mjs`: `runMultilogueV2` | independent 0.25/0.35 derivation and package identity | Complete |
| T3 | `core/timeline.mjs`: `normalizeStage1Evidence` | restricted kinds, internal unknown, confidence flags | Complete for pure core; real classifier deferred |
| T4 | `core/interaction-engine.mjs`: `runInteractionEngine`, `evaluateBackchannel` | Appendix 10.1-10.6 and specified edge rules | Complete for synthetic contract |
| T5 | `core/interaction-engine.mjs`: transfer/FTO packaging | negative/positive, failed bid and Path B tests | Complete as provisional output |
| T6 | `core/textgrid.mjs`, `core/validator.mjs` | exact tier shape, vocabulary, coverage, reciprocity, escaping | Complete |
| T7 | `core/contracts.mjs`: `CSV_SCHEMAS`; `core/pipeline.mjs`: package rows; `run-path-b-poc.mjs`: file writer | exact row-key/schema assertions and G2 CSV files | Complete for G2 Path B package |
| T8 | canonical digest, source scan, synthetic fixtures | identical SHA-256 replay and forbidden-marker scan | Complete |

## Quality Round 2 traceability

| Issue | Code anchors | Regression evidence |
|---|---|---|
| Q2-IMP-001 | `timeline.mjs`: activity provenance; `interaction-engine.mjs`: `bridgeSpeakerForThresholdFill` | 300 ms gap is `op` at P=.25 and phonation-bearing at P=.35; Appendix 10.6 still stays `op` |
| Q2-IMP-002 | `interaction-engine.mjs`: `resolveCompetingTransfers`, `consolidateTransferTargets`, ambiguity floor action | same-target candidates retain earliest onset/max end/stable IDs before ranking; combined duplicate S2 versus S3 resolves at S3 end with S2 taking floor and no FTO |
| Q2-IMP-003 | `interaction-engine.mjs`: observed-versus-qualified overlap label precedence | 80 ms non-BC vocal overlap is phonation-bearing and flagged |
| Q2-IMP-004 | `interaction-engine.mjs`: genuine-overlap precedence over `bc` | holder+BC-only example remains unchanged; holder+bid+BC marks all three `ol` |

## Quality loop

1. Implement only T1-T8.
2. Run the full synthetic suite twice.
3. Return code diff, commands, machine-readable results, TextGrid, invariant report, and replay digest to Quality Round 2.
4. Do not start G2, UI work, or new provider calls until the G0/G1 quality gate is approved.

## Later slices, not authorized here

- Original-mix Praat intensity adapter with a global file reference and explicit 10 ms sampling.
- Reliable vocalisation/laughter/artifact classification and reintegration of reviewed unknown evidence.
- Validation Console entry, server endpoints, downloads, and ZIP packaging.

## Path B v2.1 correction

- [x] PB21-T1: retain qualified and subthreshold provider intersections with stable content-derived IDs.
- [x] PB21-T2: validate and pass structured overlap evidence and mapped turns through the threshold-neutral core input.
- [x] PB21-T3: deterministically associate overlap to transfer boundaries and emit explicit missing-FTO transitions/flags.
- [x] PB21-T4: freeze and emit `transition_evidence.csv` and `overlap-capability-evidence.json` per threshold.
- [x] PB21-T5: support explicit `FTO=NA` qualified/subthreshold TextGrid points and Praat validation.
- [x] PB21-T6: add synthetic qualified/subthreshold/away/none cases, exact serialization, evidence trace, and stored-evidence replay tests.
- [x] PB21-T7: regenerate cached/local Multilogue04 P025/P035 outputs, ZIP, reports, screenshots, and gates without provider calls.
