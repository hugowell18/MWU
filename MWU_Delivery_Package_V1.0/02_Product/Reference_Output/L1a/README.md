# L1a reference-output contract

An accepted L1a run presents one customer ZIP containing:

- speaker turns in CSV and RTTM;
- one speaker-activity TextGrid on the original WAV timeline;
- one full-duration muted-mirror WAV per retained canonical speaker;

The researcher-accepted candidate review, provider-to-canonical mapping, speaker-turn JSON,
per-speaker invalid-interval TSVs, provider evidence summary, review flags and Phase II handoff
manifest remain internal session evidence.

Activity from a researcher-excluded candidate is preserved as invalid evidence for L1b; excluding
an identity never deletes the underlying acoustic event from the canonical timeline.

Muted-mirror WAVs are masked copies of the room mix. They are not clean source separation. This
generic package contains no participant audio; client-authorized reference files are added only to
an accepted release.
