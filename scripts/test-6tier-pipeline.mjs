#!/usr/bin/env node

import { existsSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";

const MAC_PRAAT_BIN = "/Applications/Praat.app/Contents/MacOS/Praat";
const ARTIFACT_NODE =
  "/Users/nedved/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node";

const nodeBin = process.execPath;
const excelNodeBin = existsSync(ARTIFACT_NODE) ? ARTIFACT_NODE : process.execPath;
const praatBin = process.env.PRAAT_BIN || (existsSync(MAC_PRAAT_BIN) ? MAC_PRAAT_BIN : "praat");
const textGridPath = resolve("sample-inputs/AMI_ES2002a_Mix-Headset_10min.assemblyai.6tier.TextGrid");
const excelPath = resolve("outputs/textgrid-export/AMI_ES2002a_Mix-Headset_10min.assemblyai.6tier.review.xlsx");

function run(label, command, args) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    maxBuffer: 20 * 1024 * 1024,
  });
  if (result.status !== 0 || result.error) {
    throw new Error(
      [
        `${label} failed`,
        result.error ? String(result.error.stack || result.error.message || result.error) : "",
        result.stdout?.trim() ? `stdout:\n${result.stdout.trim()}` : "",
        result.stderr?.trim() ? `stderr:\n${result.stderr.trim()}` : "",
      ]
        .filter(Boolean)
        .join("\n"),
    );
  }
  if (result.stdout?.trim()) console.log(result.stdout.trim());
  if (result.stderr?.trim()) console.error(result.stderr.trim());
}

function parseTierNames(textGridText) {
  return [...textGridText.matchAll(/^\s*name = "(.*)"\s*$/gm)].map((match) =>
    String(match[1]).replaceAll('""', '"'),
  );
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

run("syntax check assemblyai-json-to-textgrid", nodeBin, ["--check", "scripts/assemblyai-json-to-textgrid.mjs"]);
run("syntax check textgrid-to-review-excel", nodeBin, ["--check", "scripts/textgrid-to-review-excel.mjs"]);
run("syntax check local-acoustic-vad", nodeBin, ["--check", "scripts/local-acoustic-vad.mjs"]);

run("generate 6-tier TextGrid", nodeBin, ["scripts/assemblyai-json-to-textgrid.mjs"]);
assert(existsSync(textGridPath), `Missing generated TextGrid: ${textGridPath}`);

const textGridText = readFileSync(textGridPath, "utf8");
const tierNames = parseTierNames(textGridText);
const expectedTierNames = [
  "praat_sounding_silence",
  "local_vad_sounding_silence",
  "sounding_silence_review_status",
  "speaker",
  "transcript",
  "review_status",
];
assert(tierNames.length === 6, `Expected 6 tiers, got ${tierNames.length}: ${tierNames.join(", ")}`);
assert(
  expectedTierNames.every((name, index) => tierNames[index] === name),
  `Unexpected tier order: ${tierNames.join(", ")}`,
);
assert(/pending: praat=/.test(textGridText), "Expected at least one sounding/silence conflict flag");

run("Praat can read generated 6-tier TextGrid", praatBin, [
  "--run",
  "scripts/check_review_6tier_textgrid_in_praat.praat",
  textGridPath,
]);

run("export 6-tier TextGrid to Excel", excelNodeBin, ["scripts/textgrid-to-review-excel.mjs"]);
assert(existsSync(excelPath), `Missing generated Excel: ${excelPath}`);
assert(statSync(excelPath).size > 0, `Generated Excel is empty: ${excelPath}`);

console.log(
  JSON.stringify(
    {
      ok: true,
      textgrid: textGridPath,
      tiers: tierNames,
      excel: excelPath,
    },
    null,
    2,
  ),
);
