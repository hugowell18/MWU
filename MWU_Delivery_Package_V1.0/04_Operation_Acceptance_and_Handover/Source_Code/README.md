# Source-code handover

The final handover package will contain a source archive generated from the accepted Git tag or
commit. Its allowlist covers application source, pipeline scripts, synthetic tests, specifications,
package manifests and deployment configuration.

The archive excludes `.env` files, API credentials, participant audio, `sample/`, runtime `output/`
or `outputs/`, provider raw payloads/caches and local dependency folders. Muted-mirror WAVs and other
research artifacts remain dataset deliverables, not source-code contents.

Run `npm run release:inventory-check` before packaging. It writes a machine-readable allowlist and
exclusion report and fails if a sensitive path escapes policy. The check does not delete or rewrite
repository history. The accepted release identifier is recorded in the Acceptance Checklist.
