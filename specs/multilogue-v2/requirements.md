# Multilogue v2 Calibration Core - Requirements

Status: Quality Round 1 approved with conditions. This specification covers only the deterministic First Slice.

## Scope

The slice implements the provider-neutral interaction core used by the updated multilogue methodology. It does not process client audio, call remote services, expose a Web UI, or replace the existing monologue and legacy binary L1b pipelines.

The real-data PoC extension uses `path_b_exclusive` as its baseline operating mode. Path A is an alternative route, not a parallel deliverable, and may be selected only after overlap-capable diarization has been validated against a researcher-reviewed reference. Provider logs establish provenance and configuration only; they are not accuracy evidence.

## Inputs

- A fixed PoC speaker set: `S1`, `S2`, `S3`.
- Explicit provider mappings for Pyannote and AssemblyAI speaker identifiers.
- Synthetic room-activity intervals, attribution turns, timed words, and Stage-1 evidence events.
- A 10 ms frame step.
- Independent pause thresholds `P=0.25` and `P=0.35` seconds.
- Floor release threshold `L=1.0` second and minimum overlap `0.10` second.
- Optional legacy binary TextGrid boundary-seed provenance. It is disabled by default and its labels are never imported.

## Functional requirements

| ID | Requirement |
|---|---|
| Q1-DES-001 | Validate explicit Pyannote-to-S1/S2/S3 and AssemblyAI-to-S1/S2/S3 mappings. Assign words by maximum overlap with mapped attribution, then mapped AssemblyAI speaker, earliest overlapping turn onset, and finally S1/S2/S3 order. Flag words with zero overlap. |
| Q1-DES-002 | Run `shared_activity(P) -> floor(P) -> labels(P) -> provisional_FTO(P) -> validate -> package` independently for every threshold. Only mapped attribution and timed words may be reused. |
| Q1-DES-003 | Keep `unknown` as evidence uncertainty. `provisional_kind` is restricted to `vocalisation`, `laughter`, or `artifact`. Preserve missing confidence as `null` and flag it. |
| Q1-DES-004 | Emit exactly six tiers: S1/S2/S3 IntervalTiers using only the nine labels, a floor IntervalTier, a transitions TextTier, and a flags IntervalTier. Every interval tier must cover the complete task without gaps or overlaps. |
| Q1-DES-005 | Implement and test R1-R5, all four backchannel conditions, turn-projecting starts, the soft-chuckle exception, sub-100 ms overlap suppression, two- and three-speaker overlap, long-own-pause flags, task-end shared silence, unattributed sounding flags, failed bids without FTO, and default phonation inclusion/exclusion. |
| Q1-DES-006 | Treat a legacy binary TextGrid only as an optional boundary seed. Default is disabled; provenance is recorded; semantics are not imported. |
| Q1-DES-007 | Use synthetic fixtures only. Core code must have no HTTP client, provider SDK, signed URL, client path, or transcript logging. |
| Q1-DES-008 | Freeze the CSV schemas in `design.md`, even though filesystem CSV/ZIP packaging is deferred. |

## Output requirements

For each threshold the in-memory package contains:

- one fixed six-tier TextGrid;
- frozen-schema rows for nine-label intervals, interaction summary, provisional FTO, and flags;
- a method/provenance manifest;
- a timeline-invariant validation report.

## Acceptance criteria

1. All Appendix examples 10.1 to 10.6 pass as synthetic tests.
2. All additional Q1-DES-005 edge cases pass.
3. Canonical results from two identical runs have the same SHA-256 digest.
4. Both thresholds complete independently and a 300 ms gap remains silent at 0.25 but is absorbed at 0.35.
5. The generated TextGrid has exactly six correctly typed and named tiers.
6. Validator result has zero errors and complete duration coverage for every interval tier.
7. The machine-readable test report, synthetic TextGrid, invariant report, and deterministic replay report are generated under `tests/multilogue-v2/artifacts/`.

## Explicit exclusions

- No accuracy claim against Multilogue04 or any human gold.
- No seven-sheet workbook, automatic kappa/alpha, required MFA, Phase IV lexical analysis, or full Phase V matrix.
- No new Pyannote or AssemblyAI calls.
- No UI/server changes in this slice.

## Appendix requirements versus unresolved inputs

| Topic | Appendix/Quality requirement | First Slice position |
|---|---|---|
| Speaker count | This calibration PoC is exactly S1/S2/S3. | Implemented as fixed three-speaker contracts and six tiers; no generic N+3 claim. |
| Overlap path | Path A may expose overlap; Path B is exclusive. | Runtime mode is mandatory evidence. Actual provider capability remains unresolved; Path B/unknown never publishes automatic negative FTO. |
| Stage-1 classification | Classify attributed sounding as vocalisation, laughter, or artifact before floor logic. | The pure core validates and consumes those classifications. The real acoustic/heuristic classifier adapter is not yet defined or implemented. |
| Confidence | Preserve provider uncertainty and route it to Tier 6. | Missing confidence stays `null` and is flagged. A real-data low-confidence percentile/cut is not selected in this slice. |
| Task boundaries | R1 and task-end R5 operate per task. | One supplied task duration is supported. Session-to-task boundary discovery is outside this slice. |
| Legacy boundary seed | Old binary boundaries may be candidates, never labels. | Disabled by default. Provenance can be registered, but parsing and boundary reconciliation are deliberately deferred because the appendix does not define that merge rule. |
| Review accuracy | Automatic output is pre-annotation. | No accuracy or publishability claim is made without a new nine-label human gold set. |

## G0-G1 real-data contract

- The original WAV duration measured locally is the canonical timeline. Provider duration metadata never extends it.
- Cached provider turns and words that exceed the canonical timeline are clipped or rejected and explicitly flagged.
- Stage-1 uses cached evidence only. It performs no upload, HTTP request, provider SDK call, or free-form LLM classification.
- Controlled filled-pause tokens may be marked deterministically. Attributed activity without reliable word/class evidence remains `unknown` evidence and is flagged; laughter and artifact are not guessed.
- `P=0.25` and `P=0.35` gap filling is owned by Phase II and is not applied while building the threshold-neutral Stage-1 base.
- A sounding run shorter than 100 ms is discarded as noise. Simultaneity shorter than 100 ms is not labelled `ol`; speaker tiers retain their normal non-overlap speech/backchannel labels and `subthreshold_overlap` is emitted for review. Only qualified overlap lasting at least 100 ms is labelled reciprocal `ol`.

## Quality Round 2 corrections

| Issue | Corrected requirement |
|---|---|
| Q2-IMP-001 | Preserve `base_sounding`, `threshold_filled`, and final activity separately. A P-filled gap changes `op`/phonation only when turn-taking vocalisations on both sides belong to the same current floor holder. Original base sounding without attribution remains reviewable uncertainty and is never invented as speaker speech. |
| Q2-IMP-002 | Before comparing competing targets, consolidate all candidates for each target speaker using earliest incoming onset, the shared/appropriate outgoing boundary, maximum continuation end, and sorted stable candidate IDs. Then collapse a single target normally; for multiple target speakers, emit `ambiguous_competing_transfer`, suppress all unsupported FTO, conservatively retain the prior holder while competition remains unresolved, and allow a uniquely continuing target to claim only once the other target stops. |
| Q2-IMP-003 | A real active vocalisation may never be encoded as `pf`, `op`, `tr`, or `shs`. Simultaneity shorter than 100 ms is not `ol`: retain normal non-overlap `s`/`f`/`bc` coding and emit `subthreshold_overlap`. At 100 ms or longer, qualified overlap is reciprocal `ol`. |
| Q2-IMP-004 | Holder plus qualifying BC alone remains holder `s/f/op` plus listener `bc`. If a genuine non-BC overlap exists in the same window, every active vocaliser, including a concurrent BC, is `ol` for that window. |

## Path B v2.1 overlap/FTO correction

| ID | Requirement |
|---|---|
| PB21-REQ-001 | Every deduplicated provider turn intersection receives a stable content-derived evidence ID and an explicit `qualified` (`>=0.100s`) or `subthreshold` (`<0.100s`) class. Both classes remain in the threshold-neutral Phase-I handoff. |
| PB21-REQ-002 | Associate overlap evidence to a transfer only when the canonical speaker pair matches exactly and the evidence interval intersects either the outgoing turn-end or incoming turn-start boundary band. The fixed inclusive tolerance is `0.100s`. Retain all matching evidence IDs in sorted order; do not select a nearest item. |
| PB21-REQ-003 | A Path B transfer associated with qualified overlap has `fto_sec=null`, `sign=missing`, `status=overlap_present_offset_not_measured`, and `review_required=true`. A Path B transfer associated only with subthreshold overlap uses `status=subthreshold_overlap_present_offset_not_measured`. Qualified evidence takes precedence when both classes match. |
| PB21-REQ-004 | Negative raw turn timing itself is overlap evidence even without a provider intersection. Classify the derived overlap by the same 100ms minimum, trace the transfer candidate IDs, and apply PB21-REQ-003. Never serialize a missing FTO as zero, a small positive number, `NaN`, or the strings `null`/`undefined`. |
| PB21-REQ-005 | Subthreshold simultaneity never creates an `ol` speaker label. It remains visible through stable evidence, a missing-FTO transition when associated with a transfer, and a `subthreshold_overlap_present_offset_not_measured` review flag. |
| PB21-REQ-006 | For each threshold emit `transition_evidence.csv` with the frozen schema in `design.md`, plus `overlap-capability-evidence.json` containing mapped source turns, all qualified/subthreshold overlap evidence, counts/durations, minimum overlap, provider mode, and association tolerance. These artifacts must permit future Path A candidate recomputation without rerunning a provider. |
| PB21-REQ-007 | Transition TextTier points use `FTO=NA overlap=qualified status=overlap_present_offset_not_measured` or `FTO=NA overlap=subthreshold status=subthreshold_overlap_present_offset_not_measured`. Positive non-overlap transitions retain the signed provisional format. |
| PB21-REQ-008 | Outputs remain `uncalibrated_draft`; accuracy remains `unavailable`. This correction makes no overlap accuracy, research-ready, reviewed, gold, or final claim. |

### Path B v2.1 acceptance criteria

1. Synthetic tests cover qualified overlap at a transition, subthreshold overlap at a transition, overlap away from a transition, and no overlap.
2. Missing rows retain exact turn-end/start, overlap bounds/class/source/IDs, and serialize `fto_sec` as an empty CSV cell with `sign=missing`.
3. A stored `transition_evidence.csv` row plus `overlap-capability-evidence.json` is sufficient to reconstruct the Path A signed candidate without provider input.
4. Every missing transition has the corresponding review flag and `FTO=NA` TextGrid point; no missing transition is encoded as zero or `NaN`.
5. Both P025 and P035 outputs contain the new frozen CSV and capability sidecar, pass Praat headless validation, and are included in the security-scanned delivery ZIP.
6. The complete offline regression runs with SpeakerX forced to `--no-asr` and no provider upload or network execution.
