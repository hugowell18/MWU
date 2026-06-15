#!/usr/bin/env node

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const DEFAULT_CORPUS_DIR = "outputs/stage-c/AMI_ES2002a_Mix-Headset_10min/mfa-corpus";
const DEFAULT_OUTPUT_DIR = "outputs/stage-d/AMI_ES2002a_Mix-Headset_10min/mfa-output";
const DEFAULT_MFA_BIN = ".mfa-env/bin/mfa";
const DEFAULT_MFA_ROOT_DIR = ".mfa-data";
const DEFAULT_CACHE_DIR = ".cache";

function parseArgs(argv) {
  const args = {
    corpusDir: DEFAULT_CORPUS_DIR,
    outputDir: DEFAULT_OUTPUT_DIR,
    mfaBin: process.env.MFA_BIN || DEFAULT_MFA_BIN,
    mfaRootDir: process.env.MFA_ROOT_DIR || DEFAULT_MFA_ROOT_DIR,
    cacheDir: process.env.XDG_CACHE_HOME || DEFAULT_CACHE_DIR,
    dictionary: "english_us_mfa",
    acousticModel: "english_mfa",
    outputFormat: "long_textgrid",
    numJobs: 3,
    includeOriginalText: false,
    overwrite: true,
    singleSpeaker: false,
    quiet: false,
    dryRun: false,
  };

  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === "--corpus-dir" && next) {
      args.corpusDir = next;
      i += 1;
    } else if (arg === "--output-dir" && next) {
      args.outputDir = next;
      i += 1;
    } else if (arg === "--mfa-bin" && next) {
      args.mfaBin = next;
      i += 1;
    } else if (arg === "--mfa-root-dir" && next) {
      args.mfaRootDir = next;
      i += 1;
    } else if (arg === "--cache-dir" && next) {
      args.cacheDir = next;
      i += 1;
    } else if (arg === "--dictionary" && next) {
      args.dictionary = next;
      i += 1;
    } else if (arg === "--acoustic-model" && next) {
      args.acousticModel = next;
      i += 1;
    } else if (arg === "--output-format" && next) {
      args.outputFormat = next;
      i += 1;
    } else if (arg === "--num-jobs" && next) {
      args.numJobs = Number(next);
      i += 1;
    } else if (arg === "--include-original-text") {
      args.includeOriginalText = true;
    } else if (arg === "--no-overwrite") {
      args.overwrite = false;
    } else if (arg === "--single-speaker") {
      args.singleSpeaker = true;
    } else if (arg === "--quiet") {
      args.quiet = true;
    } else if (arg === "--dry-run") {
      args.dryRun = true;
    } else if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`Unknown or incomplete argument: ${arg}`);
    }
  }

  if (!Number.isInteger(args.numJobs) || args.numJobs < 1) {
    throw new Error("--num-jobs must be a positive integer");
  }

  return args;
}

function printHelp() {
  console.log(`Usage:
  node scripts/run-forced-alignment.mjs [options]

Options:
  --corpus-dir <path>       MFA corpus containing wav/lab pairs.
                            Default: ${DEFAULT_CORPUS_DIR}
  --output-dir <path>       MFA output directory. Default: ${DEFAULT_OUTPUT_DIR}
  --mfa-bin <path>          MFA executable. Default: MFA_BIN or ${DEFAULT_MFA_BIN}
  --mfa-root-dir <path>     MFA model/temp root. Default: MFA_ROOT_DIR or ${DEFAULT_MFA_ROOT_DIR}
  --cache-dir <path>        XDG cache dir for micromamba/runtime cache. Default: ${DEFAULT_CACHE_DIR}
  --dictionary <name/path>  MFA dictionary name or path. Default: english_us_mfa
  --acoustic-model <name/path>
                            MFA acoustic model name or path. Default: english_mfa
  --output-format <format>  long_textgrid, short_textgrid, json, or csv. Default: long_textgrid
  --num-jobs <n>            MFA jobs. Default: 3
  --include-original-text   Include original utterance text in MFA output. Off by default because
                            MFA 3.3.9 can fail exporting this layer for multi-speaker corpora.
  --no-overwrite            Do not overwrite existing output files.
  --single-speaker          Run MFA in single-speaker mode.
  --quiet                   Suppress MFA progress output.
  --dry-run                 Print command and write method log without running MFA.
`);
}

function listFilesRecursive(rootDir, predicate) {
  const results = [];
  function walk(currentDir) {
    for (const entry of readdirSync(currentDir, { withFileTypes: true })) {
      const path = join(currentDir, entry.name);
      if (entry.isDirectory()) {
        walk(path);
      } else if (!predicate || predicate(path)) {
        results.push(path);
      }
    }
  }
  if (existsSync(rootDir)) walk(rootDir);
  return results.sort();
}

function countCorpusPairs(corpusDir) {
  const wavs = listFilesRecursive(corpusDir, (path) => /\.wav$/i.test(path));
  const labs = listFilesRecursive(corpusDir, (path) => /\.lab$/i.test(path));
  const labSet = new Set(labs.map((path) => path.replace(/\.lab$/i, "")));
  const paired = wavs.filter((path) => labSet.has(path.replace(/\.wav$/i, "")));
  return {
    wav_count: wavs.length,
    lab_count: labs.length,
    paired_count: paired.length,
  };
}

function getVersion(mfaBin, env) {
  const result = spawnSync(mfaBin, ["version"], {
    encoding: "utf8",
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.status !== 0) return "";
  return result.stdout.trim();
}

function buildMfaCommand(args) {
  const command = [
    "align",
    args.corpusDir,
    args.dictionary,
    args.acousticModel,
    args.outputDir,
    "--output_format",
    args.outputFormat,
    "--num_jobs",
    String(args.numJobs),
    "--clean",
    "--no_final_clean",
    "--no_use_postgres",
  ];

  if (args.includeOriginalText) command.push("--include_original_text");
  if (args.overwrite) command.push("--overwrite");
  if (args.singleSpeaker) command.push("--single_speaker");
  if (args.quiet) command.push("--quiet");
  return command;
}

function loadManifest(corpusDir) {
  const manifestPath = join(corpusDir, "mfa-corpus-manifest.json");
  if (!existsSync(manifestPath)) return null;
  return JSON.parse(readFileSync(manifestPath, "utf8"));
}

function main() {
  const parsed = parseArgs(process.argv);
  const args = {
    ...parsed,
    corpusDir: resolve(parsed.corpusDir),
    outputDir: resolve(parsed.outputDir),
    mfaBin: resolve(parsed.mfaBin),
    mfaRootDir: resolve(parsed.mfaRootDir),
    cacheDir: resolve(parsed.cacheDir),
  };

  if (!existsSync(args.mfaBin)) throw new Error(`MFA executable does not exist: ${args.mfaBin}`);
  if (!existsSync(args.corpusDir)) throw new Error(`MFA corpus directory does not exist: ${args.corpusDir}`);

  mkdirSync(args.outputDir, { recursive: true });
  mkdirSync(args.mfaRootDir, { recursive: true });
  mkdirSync(args.cacheDir, { recursive: true });

  const env = {
    ...process.env,
    MFA_ROOT_DIR: args.mfaRootDir,
    XDG_CACHE_HOME: args.cacheDir,
    PATH: `${dirname(args.mfaBin)}:${process.env.PATH ?? ""}`,
  };
  const mfaVersion = getVersion(args.mfaBin, env);
  const corpusCounts = countCorpusPairs(args.corpusDir);
  const command = buildMfaCommand(args);
  const startedAt = new Date().toISOString();
  let status = 0;

  if (corpusCounts.paired_count === 0) {
    throw new Error(`No paired .wav/.lab files found in ${args.corpusDir}`);
  }

  if (args.dryRun) {
    console.log(`${args.mfaBin} ${command.map((part) => JSON.stringify(part)).join(" ")}`);
  } else {
    const result = spawnSync(args.mfaBin, command, {
      env,
      encoding: "utf8",
      stdio: args.quiet ? ["ignore", "pipe", "pipe"] : "inherit",
    });
    status = result.status ?? 1;
    if (status !== 0 && args.quiet) {
      if (result.stdout) process.stdout.write(result.stdout);
      if (result.stderr) process.stderr.write(result.stderr);
    }
  }

  const outputTextGrids = listFilesRecursive(args.outputDir, (path) => /\.TextGrid$/i.test(path));
  const methodLog = {
    stage: "stage-d-forced-alignment",
    created_at: new Date().toISOString(),
    started_at: startedAt,
    status,
    mfa_version: mfaVersion,
    mfa_root_dir: args.mfaRootDir,
    cache_dir: args.cacheDir,
    corpus_dir: args.corpusDir,
    output_dir: args.outputDir,
    dictionary: args.dictionary,
    acoustic_model: args.acousticModel,
    options: {
      output_format: args.outputFormat,
      num_jobs: args.numJobs,
      include_original_text: args.includeOriginalText,
      overwrite: args.overwrite,
      single_speaker: args.singleSpeaker,
      quiet: args.quiet,
      dry_run: args.dryRun,
    },
    corpus_counts: corpusCounts,
    manifest_summary: loadManifest(args.corpusDir)?.summary ?? null,
    output_counts: {
      textgrid_count: outputTextGrids.length,
    },
    command: [args.mfaBin, ...command],
  };

  const methodLogPath = join(args.outputDir, "alignment-method-log.json");
  writeFileSync(methodLogPath, `${JSON.stringify(methodLog, null, 2)}\n`);

  if (status !== 0) {
    throw new Error(`MFA align failed with status ${status}. Method log: ${methodLogPath}`);
  }

  console.log(
    JSON.stringify(
      {
        ok: true,
        output_dir: args.outputDir,
        method_log: methodLogPath,
        mfa_version: mfaVersion,
        ...corpusCounts,
        textgrid_count: outputTextGrids.length,
        sample_textgrids: outputTextGrids.slice(0, 5).map((path) => relative(args.outputDir, path)),
      },
      null,
      2,
    ),
  );
}

main();
