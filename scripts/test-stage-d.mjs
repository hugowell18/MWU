#!/usr/bin/env node

import { existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

const TEST_DIR = "outputs/stage-c-test";
const CORPUS_DIR = `${TEST_DIR}/mfa-corpus`;
const OUTPUT_DIR = "outputs/stage-d-test/mfa-output";
const MFA_BIN = ".mfa-env/bin/mfa";

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

if (!existsSync(MFA_BIN)) {
  throw new Error(`Missing MFA binary: ${MFA_BIN}`);
}

if (!existsSync(`${CORPUS_DIR}/mfa-corpus-manifest.json`)) {
  run("node", ["scripts/test-stage-c.mjs"]);
}

const stdout = run("node", [
  "scripts/run-forced-alignment.mjs",
  "--corpus-dir",
  CORPUS_DIR,
  "--output-dir",
  OUTPUT_DIR,
  "--num-jobs",
  "1",
  "--quiet",
]);

const payload = JSON.parse(stdout);
assert(payload.ok === true, "Stage D script did not report ok=true");
assert(payload.textgrid_count > 0, "Expected at least one TextGrid from MFA");

const methodLogPath = `${OUTPUT_DIR}/alignment-method-log.json`;
const methodLog = JSON.parse(readFileSync(methodLogPath, "utf8"));
assert(methodLog.status === 0, `Expected status 0, got ${methodLog.status}`);
assert(methodLog.mfa_version, "Expected MFA version in method log");

const mergeStdout = run("node", [
  "scripts/merge-mfa-word-alignments.mjs",
  "--manifest",
  `${CORPUS_DIR}/mfa-corpus-manifest.json`,
  "--mfa-output-dir",
  OUTPUT_DIR,
  "--output-json",
  "outputs/stage-d-test/word_alignment.json",
  "--output-textgrid",
  "outputs/stage-d-test/word_alignment.TextGrid",
]);

const mergePayload = JSON.parse(mergeStdout);
assert(mergePayload.ok === true, "Merge script did not report ok=true");
assert(mergePayload.word_count > 0, "Expected merged word intervals");
assert(existsSync("outputs/stage-d-test/word_alignment.TextGrid"), "Missing merged word_alignment.TextGrid");

console.log(
  JSON.stringify(
    {
      ok: true,
      mfa_version: methodLog.mfa_version,
      textgrid_count: payload.textgrid_count,
      word_count: mergePayload.word_count,
      output_dir: resolve(OUTPUT_DIR),
    },
    null,
    2,
  ),
);
