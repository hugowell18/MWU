# MWU Research Pipeline

Web-based validation console and local processing tools for the fluency and
multi-word-unit research workflow.

The current implementation includes:

- SpeakerX monologue Validation Sprint for Phase II-V benchmarking.
- Layer 1a speaker diarization and muted-mirror handoff tooling.
- Layer 1b deterministic Praat pause extraction at configurable thresholds.
- Per-speaker TextGrid, duration diagnostic, method-record, and package outputs.
- Validation, UI, Phase I, and L1b regression suites.

## Local run

Requirements: Node.js 20+, Praat, and npm.

```bash
npm ci
npm run sprint:build-ui
npm run sprint:serve -- --port 4173
```

Open `http://localhost:4173`.

The default single-admin login is `admin` / `mwu2026`. Deployment may override
the credentials and preserve signed sessions across restarts with:

```bash
MWU_ADMIN_USER=admin
MWU_ADMIN_PASSWORD=replace-with-a-deployment-secret
MWU_SESSION_SECRET=replace-with-a-long-random-secret
```

Set `MWU_COOKIE_SECURE=1` when HTTPS terminates without forwarding
`X-Forwarded-Proto: https`.

If Praat is not on `PATH`, configure its executable in the untracked `.env`
file:

```bash
PRAAT_BIN=/absolute/path/to/praat
```

## Verification

```bash
npm run sprint:test
npm run sprint:ui-test
npm run phase1:pyannote:test
npm run l1b:test
```

## Data security

This repository is public. Never commit API keys, `.env` files, active
human-subject audio, isolated speaker WAVs, transcripts, or derived research
outputs. Transfer confidential inputs and deliverables directly to the secured
deployment host.

See [VPS_DEPLOYMENT_GUIDE_EN.md](VPS_DEPLOYMENT_GUIDE_EN.md) for deployment.
