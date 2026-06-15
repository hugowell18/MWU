#!/usr/bin/env node

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { basename, extname, join, relative, resolve } from "node:path";

const DEFAULT_UNITS = "outputs/stage-c/AMI_ES2002a_Mix-Headset_10min.assemblyai.6tier.utterance_units.json";
const DEFAULT_AUDIO = "sample-inputs/AMI_ES2002a_Mix-Headset_10min.wav";
const DEFAULT_OUTPUT_DIR = "outputs/stage-c/mfa-corpus";

function parseArgs(argv) {
  const args = {
    units: DEFAULT_UNITS,
    audio: DEFAULT_AUDIO,
    outputDir: DEFAULT_OUTPUT_DIR,
    ffmpegBin: process.env.FFMPEG_BIN || "ffmpeg",
    includeBlocked: false,
    maxUnits: 0,
    sampleRate: 16000,
    channels: 1,
    dryRun: false,
  };

  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === "--units" && next) {
      args.units = next;
      i += 1;
    } else if (arg === "--audio" && next) {
      args.audio = next;
      i += 1;
    } else if (arg === "--output-dir" && next) {
      args.outputDir = next;
      i += 1;
    } else if (arg === "--ffmpeg-bin" && next) {
      args.ffmpegBin = next;
      i += 1;
    } else if (arg === "--include-blocked") {
      args.includeBlocked = true;
    } else if (arg === "--max-units" && next) {
      args.maxUnits = Number(next);
      i += 1;
    } else if (arg === "--sample-rate" && next) {
      args.sampleRate = Number(next);
      i += 1;
    } else if (arg === "--channels" && next) {
      args.channels = Number(next);
      i += 1;
    } else if (arg === "--dry-run") {
      args.dryRun = true;
    } else if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`Unknown or incomplete argument: ${arg}`);
    }
  }

  for (const [key, value] of Object.entries({
    maxUnits: args.maxUnits,
    sampleRate: args.sampleRate,
    channels: args.channels,
  })) {
    if (!Number.isFinite(value) || value < 0) throw new Error(`${key} must be a non-negative number`);
  }

  return args;
}

function printHelp() {
  console.log(`Usage:
  node scripts/prepare-mfa-corpus.mjs [options]

Options:
  --units <path>        utterance_units.json from extract-reviewed-units.
                        Default: ${DEFAULT_UNITS}
  --audio <path>        Source audio file. Default: ${DEFAULT_AUDIO}
  --output-dir <path>   Output MFA corpus directory. Default: ${DEFAULT_OUTPUT_DIR}
  --ffmpeg-bin <path>   ffmpeg executable. Default: FFMPEG_BIN or ffmpeg
  --include-blocked     Also export units with alignment_allowed=false.
  --max-units <number>  Export only the first N selected units. Default: 0 means no limit.
  --sample-rate <n>     Clip sample rate. Default: 16000
  --channels <n>        Clip channels. Default: 1
  --dry-run             Write .lab files and manifest, but do not cut wav clips.
`);
}

function sanitizePathPart(value, fallback) {
  const cleaned = String(value ?? "")
    .trim()
    .replace(/[^\w.-]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return cleaned || fallback;
}

function formatSeconds(value) {
  return Number(value).toFixed(6);
}

function numberToWords(value) {
  const ones = [
    "zero",
    "one",
    "two",
    "three",
    "four",
    "five",
    "six",
    "seven",
    "eight",
    "nine",
    "ten",
    "eleven",
    "twelve",
    "thirteen",
    "fourteen",
    "fifteen",
    "sixteen",
    "seventeen",
    "eighteen",
    "nineteen",
  ];
  const tens = ["", "", "twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety"];
  const number = Number(value);
  if (!Number.isInteger(number) || number < 0 || number > 99) return String(value);
  if (number < 20) return ones[number];
  const ten = Math.floor(number / 10);
  const one = number % 10;
  return one === 0 ? tens[ten] : `${tens[ten]} ${ones[one]}`;
}

function normalizeLabText(value) {
  return String(value ?? "")
    .normalize("NFKC")
    .replace(/[’‘]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/\b\d{1,2}\b/g, (match) => numberToWords(match))
    .replace(/[()[\]{}<>]/g, " ")
    .replace(/[^\p{L}\p{N}' -]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function runFfmpeg(args) {
  const result = spawnSync(args[0], args.slice(1), {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });

  if (result.status !== 0) {
    throw new Error(`ffmpeg failed (${result.status}): ${result.stderr || result.stdout}`);
  }
}

function main() {
  const args = parseArgs(process.argv);
  const unitsPath = resolve(args.units);
  const audioPath = resolve(args.audio);
  const outputDir = resolve(args.outputDir);

  if (!existsSync(unitsPath)) throw new Error(`Units JSON does not exist: ${unitsPath}`);
  if (!existsSync(audioPath)) throw new Error(`Audio does not exist: ${audioPath}`);

  const payload = JSON.parse(readFileSync(unitsPath, "utf8"));
  const allUnits = Array.isArray(payload.units) ? payload.units : [];
  let selectedUnits = allUnits.filter((unit) => args.includeBlocked || unit.alignment_allowed);
  if (args.maxUnits > 0) selectedUnits = selectedUnits.slice(0, args.maxUnits);

  mkdirSync(outputDir, { recursive: true });
  const manifest = {
    source_audio: audioPath,
    source_units: unitsPath,
    output_dir: outputDir,
    dry_run: args.dryRun,
    options: {
      include_blocked: args.includeBlocked,
      max_units: args.maxUnits,
      sample_rate: args.sampleRate,
      channels: args.channels,
    },
    clips: [],
  };

  for (const unit of selectedUnits) {
    const speakerDirName = sanitizePathPart(unit.speaker, "unknown_speaker");
    const speakerDir = join(outputDir, speakerDirName);
    mkdirSync(speakerDir, { recursive: true });

    const clipBase = sanitizePathPart(unit.utt_id, `utt_${String(manifest.clips.length + 1).padStart(4, "0")}`);
    const wavPath = join(speakerDir, `${clipBase}.wav`);
    const labPath = join(speakerDir, `${clipBase}.lab`);
    const labText = normalizeLabText(unit.text);

    writeFileSync(labPath, `${labText}\n`);

    if (!args.dryRun) {
      runFfmpeg([
        args.ffmpegBin,
        "-hide_banner",
        "-loglevel",
        "error",
        "-y",
        "-ss",
        formatSeconds(unit.start_sec),
        "-to",
        formatSeconds(unit.end_sec),
        "-i",
        audioPath,
        "-ac",
        String(args.channels),
        "-ar",
        String(args.sampleRate),
        wavPath,
      ]);
    }

    manifest.clips.push({
      utt_id: unit.utt_id,
      speaker: unit.speaker,
      start_sec: unit.start_sec,
      end_sec: unit.end_sec,
      duration_sec: unit.duration_sec,
      clip_offset_sec: unit.start_sec,
      wav: relative(outputDir, wavPath),
      lab: relative(outputDir, labPath),
      original_text: unit.text,
      lab_text: labText,
      flags: unit.flags ?? [],
      alignment_allowed: Boolean(unit.alignment_allowed),
    });
  }

  const summary = {
    unit_count: allUnits.length,
    selected_count: selectedUnits.length,
    blocked_count: allUnits.filter((unit) => !unit.alignment_allowed).length,
    clip_count: manifest.clips.length,
    speakers: [...new Set(manifest.clips.map((clip) => clip.speaker).filter(Boolean))].sort(),
  };

  manifest.summary = summary;
  const manifestPath = join(outputDir, "mfa-corpus-manifest.json");
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(JSON.stringify({ output_dir: outputDir, manifest: manifestPath, ...summary }, null, 2));
}

main();
