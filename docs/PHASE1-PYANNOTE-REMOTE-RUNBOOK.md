# Phase I Remote Pyannote Route

This runbook validates the remote pyannoteAI diarization route before deciding whether a local pyannote installation is worth the extra operational cost.

## Why Remote First

The local pyannote installation has been stopped and removed. The remote route uses pyannoteAI's hosted diarization API so we can evaluate diarization quality quickly without managing local Torch / pyannote dependencies.

Official pyannoteAI flow:

1. Upload local audio to a temporary `media://` object using the Media API, unless a public/signed URL is supplied.
2. Submit `/v1/diarize`.
3. Poll `/v1/jobs/{jobId}` until `succeeded`.
4. Save the returned diarization immediately; pyannoteAI job results are temporary.
5. Convert `output.diarization` into the local Phase I artifacts. This is intentional: `exclusiveDiarization` can simplify STT reconciliation, but it removes explicit overlapping-speaker timing, which Phase I needs for muted-mirror and review evidence.

## Required Secret

Put the API key in `.env`:

```bash
PYANNOTE_API_KEY=...
```

The current `.env` only has `ASSEMBLYAI_API_KEY`, so the real Multilogue04 pyannoteAI run currently stops safely before upload with `missing_api_key`.

For local integration tests only, the CLI also accepts:

```bash
--api-base-url http://127.0.0.1:<port>
```

Production runs should use the default `https://api.pyannote.ai`.

## Multilogue04 Command

```bash
node scripts/phase1-pyannote-remote.mjs \
  --audio 'sample/Multilogue04_C_Level30 D1G4.wav' \
  --upload-audio 'outputs/multilogue-validation/Multilogue04_C_Level30_D1G4/input/Multilogue04_C_Level30_D1G4.16k_mono.48k.mp3' \
  --upload-method curl \
  --object-key 'mwu/Multilogue04_C_Level30_D1G4.mp3' \
  --out-dir 'outputs/multilogue-validation/Multilogue04_C_Level30_D1G4/pyannote-remote' \
  --prefix 'Multilogue04_C_Level30_D1G4' \
  --speakers 3 \
  --model community-1 \
  --poll-ms 10000 \
  --compare-assemblyai-json 'outputs/multilogue-validation/Multilogue04_C_Level30_D1G4/assemblyai/Multilogue04_C_Level30_D1G4.16k_mono.assemblyai.raw.json'
```

`--audio` is always required because muted-mirror WAV generation needs the local source audio. `--upload-audio` is optional and should point to a smaller normalized file for the remote API. For Multilogue04 we upload a 16 kHz mono MP3 (`~2.9 MB`) while preserving the original 48 kHz WAV (`~46 MB`) for local muted-mirror output. The earlier 16 kHz mono WAV upload (`~15 MB`) repeatedly hit S3 connection resets on this machine. `--upload-method curl` is used because the pyannoteAI Media API returns an S3 presigned URL that works reliably with `curl PUT` once the upload artifact is small enough; the default Node upload path remains available for tests and other environments. If a public/signed URL is already available, add `--audio-url <url>` to skip the pyannoteAI Media API upload while still using the local audio for muted mirrors.

By default, the command keeps the Community-1 request conservative:

- no `turnLevelConfidence` field
- no `exclusive` field
- no `confidence` field
- no pyannote transcription request; ASR stays with AssemblyAI
- artifact source: `output.diarization`

If a Precision-2 run is needed later, add explicit flags such as `--turn-level-confidence`, `--exclusive`, `--confidence`, or `--artifact-diarization exclusiveDiarization`. For Phase I validation, keep the default artifact source unless there is a deliberate reason to drop overlap timing.

## Expected Outputs

After a successful remote run:

- `*.pyannote.remote.raw_job.json` - raw pyannoteAI job result.
- `*.pyannote.remote.raw_turns.json` - normalized pyannote speaker turns converted from `output.diarization` by default.
- `*.pyannote_remote.speaker_turns.rttm` - RTTM for audit / interoperability.
- `*.pyannote_remote.speaker_tier.TextGrid` - one-tier speaker TextGrid.
- `*.pyannote_remote.speaker_turns.csv/json` - speaker-turn table.
- `*.pyannote_remote.speaker_<ID>.muted_mirror.wav` - one muted-mirror WAV per detected speaker.
- `*.pyannote_remote.speaker_<ID>.invalid_intervals.tsv` - other-speaker regions for Phase II `invalid` marking.
- `*.pyannote_remote.phase1_manifest.json` - downstream contract and method log.
- `*.pyannote_remote.log.jsonl` - stable JSONL execution log.
- `*.assemblyai_vs_pyannote_remote.comparison.json/md` - optional system-vs-system comparison when `--compare-assemblyai-json` is supplied.

## Phase II Handoff Contract

For each speaker, Phase II should use:

- WAV input: `muted_mirror_wav`
- invalid interval input: `invalid_intervals_tsv`

The Phase II Praat script then generates the three required mutually exclusive labels:

- `sounding`
- `silent`
- `invalid`

Verify the handoff package:

```bash
node scripts/phase1-verify-handoff.mjs \
  --manifest 'outputs/multilogue-validation/Multilogue04_C_Level30_D1G4/pyannote-remote/Multilogue04_C_Level30_D1G4.pyannote_remote.phase1_manifest.json'
```

This checks that each speaker has:

- a muted-mirror WAV,
- an `invalid_intervals.tsv`,
- a WAV duration matching the manifest,
- valid invalid intervals inside the audio timeline,
- the Phase II label contract: `sounding`, `silent`, `invalid`.

## AssemblyAI Comparison

If the comparison was not generated during the remote run, compare it with the existing AssemblyAI run:

```bash
node scripts/phase1-compare-diarization.mjs \
  --reference-assemblyai-json 'outputs/multilogue-validation/Multilogue04_C_Level30_D1G4/assemblyai/Multilogue04_C_Level30_D1G4.16k_mono.assemblyai.raw.json' \
  --candidate-turns-json 'outputs/multilogue-validation/Multilogue04_C_Level30_D1G4/pyannote-remote/Multilogue04_C_Level30_D1G4.pyannote.remote.raw_turns.json' \
  --audio 'sample/Multilogue04_C_Level30 D1G4.wav' \
  --output 'outputs/multilogue-validation/Multilogue04_C_Level30_D1G4/pyannote-remote/assemblyai_vs_pyannote_remote.comparison.json'
```

The comparison is system-vs-system agreement, not human-gold accuracy. It reports:

- speaker count and labels,
- speech activity agreement,
- exact label frame agreement after best label mapping,
- speaker agreement when both systems detect speech,
- reference-only / candidate-only / mismatch seconds,
- boundary-distance mean and median.

Final accuracy still requires the client's human speaker-isolation gold output.

## Test Gate

```bash
npm run phase1:pyannote:test
```

The test suite covers:

- RTTM parsing and malformed RTTM rejection,
- overlap labels in speaker TextGrid,
- remote mock job to speaker turns / RTTM / muted mirrors / Phase II handoff,
- a fake pyannoteAI HTTP server that verifies Media API upload, curl-based presigned upload, `/v1/diarize` submission, job polling, JSONL log events, compressed `--upload-audio` usage, AssemblyAI comparison output, and Phase II handoff compatibility,
- default artifact generation preserves overlapping `diarization` even when `exclusiveDiarization` is also present,
- generic provider-neutral artifact generation,
- comparison metrics and markdown report,
- handoff verifier failures for invalid `invalid_intervals.tsv`,
- missing `PYANNOTE_API_KEY` failure with stable JSONL logs.
