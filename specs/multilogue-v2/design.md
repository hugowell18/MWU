# Multilogue v2 Calibration Core - Design

## Ownership boundary

Phase I owns Stage 1 evidence, Stage 2 persistent floor, and Stage 3 nine-label/FTO generation. Phase II owns the threshold list and invokes the Phase I engine independently for each threshold. Nine-label output feeds Phase IV. Signed FTO output feeds Phase V only.

For the real-data PoC, Path B is the proposed baseline. Path A is not produced in parallel and is enabled only after overlap evidence is validated against a researcher-reviewed reference. A provider execution log or model capability statement is provenance, not accuracy evidence.

## Core flow

1. Validate the two provider mapping contracts and map attribution turns.
2. Assign timed words to S1/S2/S3 by deterministic maximum overlap.
3. Reuse only those two threshold-neutral structures.
4. For each P, derive a new room-activity timeline from the 10 ms base frames.
5. Normalize Stage-1 evidence to `vocalisation`, `laughter`, or `artifact`; uncertainty remains metadata and flags.
6. Run the floor machine: R1-R4 maintain floor state, and R5 retrospectively resolves silence.
7. Assign the nine labels with artifact and overlap precedence.
8. Emit provisional FTO only under the declared overlap-capability mode.
9. Build six tiers, validate invariants, and construct frozen-schema package rows.

## Mapping contract

Mappings are explicit, provider-scoped, and bijective onto `S1`, `S2`, and `S3` for this PoC. Provider labels never appear in research tiers.

Word assignment aggregates overlap duration per canonical speaker. Ties are resolved in this order:

1. mapped AssemblyAI source speaker, if it is one of the tied maximum-overlap speakers;
2. earliest onset among the tied overlapping attribution turns;
3. canonical order `S1`, `S2`, `S3`.

Zero-overlap words remain unresolved and create `unresolved_word_assignment`. Word text is never copied into flags, manifests, or package rows.

## Stage-1 evidence contract

`provisional_kind` is exactly one of `vocalisation`, `laughter`, or `artifact`. `lexical_class` may be `lexical`, `filled_pause`, `nonlexical`, or `unknown`. Evidence uncertainty does not create a speaker-tier label; it produces review flags. Missing confidence remains JSON `null`.

The soft-chuckle exception may convert a non-floor-holder laughter event to `bc` only when all backchannel conditions pass. Other laughter and artifacts become `x` and never move the floor.

The First Slice starts after classification: it validates and consumes Stage-1 evidence but does not pretend that a real vocalisation/laughter/artifact classifier already exists. That adapter is a later calibration slice and must emit confidence/uncertainty rather than silently guess.

The G1 adapter therefore uses timed words as the only lexical evidence. Deterministic filled-pause tokens receive `filled_pause`; other timed words receive `lexical`. Residual attributed activity is preserved in a separate unknown-evidence channel and emitted as review flags; it does not enter the floor event stream until classified or reviewed. This preserves diarizer evidence without guessing vocalisation, laughter, or artifact.

### Canonical clock

The source WAV duration reported by local `ffprobe` is the canonical timeline. Pyannote and AssemblyAI timestamps are interpreted against that clock. Any provider interval outside `[0, duration]` is clipped when it intersects the recording, rejected when it falls wholly outside, and recorded in the Phase-I gate report. Provider duration metadata is never used to pad the recording.

## Rule matrix

| Rule | Deterministic behavior |
|---|---|
| R1 | Floor starts `FREE`; first turn-taking vocalisation claims it. |
| R2/R3 | Holder persists through own silence and other-speaker backchannels. |
| R4 | A non-backchannel bid transfers only if it outlasts the holder; otherwise it is a failed bid with no FTO. |
| R5 | Holder-resumed silence is `op`; other-speaker uptake at or below L is `tr`; uptake above L or silence to task end is `shs`. |
| BC condition 1 | Three words or fewer, or purely nonlexical/soft chuckle. |
| BC condition 2 | Strict majority of lexical tokens is in the versioned lexicon. |
| BC condition 3 | No wh-word, `but`, `so`, `well`, `actually`, `I think`, or `no` projecting start. |
| BC condition 4 | Current holder carries on without ceding. |
| Qualified overlap | At least two non-BC vocalisers for at least 100 ms; `ol` is reciprocal on every active vocaliser, including a concurrent BC. |
| Subthreshold overlap | Observed simultaneity below 100 ms is not `ol`. Active events retain normal non-overlap `s`/`f`/`bc` coding and receive `subthreshold_overlap` for review. |
| Artifact precedence | `x` overrides every label except the qualifying soft-chuckle `bc` carve-out. |
| Phonation default | Include `s`, `f`, `ol`; exclude `bc`, `op`, `pf`, `tr`, `shs`, `x`. |

### Threshold provenance

Every 10 ms shared-activity frame retains three separate facts: original `base_sounding`, whether P filled an internal gap, and final sounding state. A P-filled gap is projected to `s` only when the nearest turn-taking vocalisations on both sides belong to the same current floor holder. This is the operational meaning of Appendix section 5.2's instruction to absorb articulatory gaps. Original room activity with no attribution is not eligible for that inference; it remains the Appendix 10.6 `unattributed_sounding` case and does not become speaker speech.

### Competing transfers

The Appendix defines failed bids and one incoming speaker, but gives no winner rule for simultaneous competing bids that both outlast the holder. The core therefore does not choose by speaker ID or raw event order. Candidates sharing the same outgoing holder/boundary are first consolidated per target speaker: earliest incoming onset, maximum continuation end, the common outgoing boundary, and sorted unique candidate IDs are retained. Only those consolidated targets are compared. One target collapses to one transfer; different targets create `ambiguous_competing_transfer`, produce no FTO, and conservatively retain the prior persistent floor until a single target remains active. That continuing speaker may then hold the floor, but no retroactive signed FTO is invented. This prevents two segments from one speaker being misread as two independent competitors.

### Backchannel and overlap precedence

Appendix 8.3 governs the two-party holder-plus-BC case: the listener is `bc` and the holder is not made `ol`. Appendix 3 and 8.4 govern a window that also contains a genuine non-BC bid: qualifying overlap exists, so every active involved vocaliser is `ol`, including the concurrent BC. Thus `bc` is preserved only when no genuine overlap exists in that frame.

## Floor and FTO

The floor begins `FREE`. It persists through the holder's own silence and qualifying backchannels. A non-holder bid transfers the floor only if it survives the holder's continuation; otherwise it is a failed bid. Silence is resolved retrospectively as own pause, transition, or shared silence.

FTO format is fixed:

`S1>S2 FTO=-0.180 status=provisional`

The point is placed at the effective transfer time: outgoing offset for overlap, incoming onset for a positive gap. Automatic negative values are allowed only for `path_a_candidate`; they are always flagged as provisional. `path_b_exclusive` cannot claim automatic negative FTO.

### Path B v2.1 overlap association and missing FTO

Phase I retains every deduplicated provider turn intersection, including intervals below the 100ms `ol` minimum. IDs are content-derived from canonical start/end, sorted speaker pair, and sorted source-turn IDs, so threshold selection and replay do not renumber evidence.

For each resolved transfer, define two inclusive boundary bands using `T=0.100s`:

- outgoing band: `[turn_end_sec - T, turn_end_sec + T]`;
- incoming band: `[turn_start_sec - T, turn_start_sec + T]`.

An overlap item is associated only when its canonical speaker pair equals `{from_speaker,to_speaker}` and its interval intersects at least one band. All matching IDs are retained, sorted, and serialized; there is no nearest-only selection. Evidence elsewhere in the recording is not associated. A negative `raw_gap_sec = turn_start_sec - turn_end_sec` also creates deterministic derived evidence traced to the transfer candidate IDs. Qualified evidence wins over subthreshold evidence if both are present.

Path B assignment matrix:

| Evidence at transition | `fto_sec` | `sign` | `status` | TextGrid marker |
|---|---:|---|---|---|
| qualified (`>=0.100s`) | empty/null | `missing` | `overlap_present_offset_not_measured` | `FTO=NA overlap=qualified` |
| subthreshold only (`<0.100s`) | empty/null | `missing` | `subthreshold_overlap_present_offset_not_measured` | `FTO=NA overlap=subthreshold` |
| none, positive raw gap | signed value | `positive` | `provisional` | existing signed provisional format |
| none, exact zero | `0` | `zero` | `provisional` | existing signed provisional format |

Missing values are JSON `null` in memory and empty quoted cells in CSV. The strings `NaN`, `null`, and `undefined` are forbidden in numeric CSV cells.

## Fixed TextGrid contract

| Tier | Praat type | Name | Vocabulary |
|---|---|---|---|
| 1 | IntervalTier | S1 | `s f bc ol op pf tr shs x` |
| 2 | IntervalTier | S2 | same |
| 3 | IntervalTier | S3 | same |
| 4 | IntervalTier | floor | `S1 S2 S3 FREE` |
| 5 | TextTier | transitions | fixed FTO format |
| 6 | IntervalTier | flags | sorted unique flag codes joined with `|` |

Adjacent equal intervals are merged. Flag codes are sorted lexicographically before joining. TextGrid quotes are doubled. All interval tiers start at zero, end at task duration, and contain no gap or overlap.

## Frozen CSV schemas

`nine_label_intervals.csv`

`recording_id,task_id,threshold_sec,speaker,start_sec,end_sec,duration_sec,label,floor,phonation_included_default,review_required`

`interaction_summary.csv`

`recording_id,task_id,threshold_sec,speaker,total_duration_sec,phonation_time_sec,s_sec,f_sec,bc_sec,ol_sec,op_sec,pf_sec,tr_sec,shs_sec,x_sec,op_count,bc_count,ol_count,floor_turns_held,incoming_fto_values`

`fto_transitions.csv`

`recording_id,task_id,threshold_sec,sequence,from_speaker,to_speaker,outgoing_offset_sec,incoming_onset_sec,fto_sec,sign,status,review_required`

`transition_evidence.csv`

`recording_id,task_id,threshold_sec,sequence,from_speaker,to_speaker,turn_end_sec,turn_start_sec,raw_gap_sec,overlap_start_sec,overlap_end_sec,overlap_duration_sec,overlap_class,evidence_source,evidence_ids,fto_status,review_required`

`flags.csv`

`recording_id,task_id,threshold_sec,start_sec,end_sec,duration_sec,code,severity,source,related_id`

No column contains transcript text, signed URLs, API keys, or absolute paths.

`overlap-capability-evidence.json` is a threshold-specific deterministic sidecar with:

- `provider_mode`, `minimum_overlap_sec`, and `association_tolerance_sec`;
- raw, qualified, and subthreshold counts and summed durations;
- canonical mapped attribution turns with opaque IDs, speaker, start, end, and confidence;
- all overlap evidence with stable ID, bounds, duration, class, speaker pair, source-turn IDs, and evidence source;
- no transcript text and no provider credential or URL.

The sidecar and transition evidence are sufficient inputs for a later Path A candidate recomputation. They are not proof that provider overlap is accurate.

## Legacy seed

The manifest records `legacy_boundary_seed.enabled`, opaque file identifier, and checksum supplied by a future adapter. Default is `false`; `candidate_only` is always true. This slice accepts provenance only and never parses or imports `sounding`, `silent`, or `invalid` semantics. The appendix does not define a deterministic reconciliation rule, so the manifest truthfully records `used_by_core=false` until that later adapter is specified.

## Security

Tests use invented speakers, tokens, and timings. The core imports only Node standard-library modules. It contains no network path. Generated evidence stays below `tests/multilogue-v2/artifacts/` and contains no client identifiers.
