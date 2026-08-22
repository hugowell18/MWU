# L1a reference-output contract

An accepted L1a run produces the following release-specific artifacts:

- researcher-accepted candidate review record and provider-to-canonical S1-SN mapping;
- speaker turns in JSON, CSV and RTTM;
- one speaker-activity TextGrid on the original WAV timeline;
- one full-duration muted-mirror WAV per retained canonical speaker;
- per-speaker invalid-interval TSV files for the L1b handoff;
- provider evidence summary, review flags and Phase II handoff manifest.

Activity from a researcher-excluded candidate is preserved as invalid evidence for L1b; excluding
an identity never deletes the underlying acoustic event from the canonical timeline.

Muted-mirror WAVs are masked copies of the room mix. They are not clean source separation. This
generic package contains no participant audio; client-authorized reference files are added only to
an accepted release.
