#!/usr/bin/env node

import { existsSync, readFileSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

const TEST_DIR = "outputs/stage-c-test";
const UNITS_PATH = `${TEST_DIR}/utterance_units.json`;
const CORPUS_DIR = `${TEST_DIR}/mfa-corpus`;

function run(command, args) {
  const result = spawnSync(command, args, {
    cwd: resolve("."),
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });

  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed\n${result.stdout}\n${result.stderr}`);
  }

  return result.stdout.trim();
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

rmSync(TEST_DIR, { recursive: true, force: true });

run("node", [
  "scripts/extract-reviewed-units.mjs",
  "--textgrid",
  "sample-inputs/AMI_ES2002a_Mix-Headset_10min.assemblyai.6tier.TextGrid",
  "--assemblyai-json",
  "sample-inputs/assemblyai/AMI_ES2002a_Mix-Headset_10min.assemblyai.raw.json",
  "--output",
  UNITS_PATH,
]);

const unitsPayload = JSON.parse(readFileSync(UNITS_PATH, "utf8"));
assert(unitsPayload.summary.unit_count === 64, `Expected 64 units, got ${unitsPayload.summary.unit_count}`);
assert(
  unitsPayload.summary.alignment_allowed_count === 63,
  `Expected 63 alignment-allowed units, got ${unitsPayload.summary.alignment_allowed_count}`,
);
assert(
  unitsPayload.units.some((unit) => unit.flags.includes("short_unit") && !unit.alignment_allowed),
  "Expected at least one blocked short_unit",
);

run("node", [
  "scripts/prepare-mfa-corpus.mjs",
  "--units",
  UNITS_PATH,
  "--audio",
  "sample-inputs/AMI_ES2002a_Mix-Headset_10min.wav",
  "--output-dir",
  CORPUS_DIR,
  "--max-units",
  "3",
]);

const manifestPath = `${CORPUS_DIR}/mfa-corpus-manifest.json`;
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
assert(manifest.summary.clip_count === 3, `Expected 3 clips, got ${manifest.summary.clip_count}`);

for (const clip of manifest.clips) {
  assert(existsSync(`${CORPUS_DIR}/${clip.wav}`), `Missing wav: ${clip.wav}`);
  assert(existsSync(`${CORPUS_DIR}/${clip.lab}`), `Missing lab: ${clip.lab}`);
  assert(clip.lab_text.length > 0, `Empty lab text for ${clip.utt_id}`);
}

console.log(
  JSON.stringify(
    {
      ok: true,
      units: unitsPayload.summary.unit_count,
      alignment_allowed: unitsPayload.summary.alignment_allowed_count,
      test_clips: manifest.summary.clip_count,
      output_dir: resolve(TEST_DIR),
    },
    null,
    2,
  ),
);
