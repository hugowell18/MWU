#!/usr/bin/env node

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, extname, resolve } from "node:path";
import {
  bestOverlappingInterval,
  getOptionalTier,
  getTier,
  overlapSeconds,
  parseTextGrid,
  round,
} from "./textgrid-utils.mjs";

const DEFAULT_TEXTGRID = "sample-inputs/AMI_ES2002a_Mix-Headset_10min.assemblyai.6tier.TextGrid";
const DEFAULT_ASSEMBLYAI_JSON =
  "sample-inputs/assemblyai/AMI_ES2002a_Mix-Headset_10min.assemblyai.raw.json";
const DEFAULT_OUTPUT_DIR = "outputs/stage-c";
const TRANSCRIPT_TIER = "transcript";
const SPEAKER_TIER = "speaker";
const REVIEW_TIER = "review_status";
const SOUNDING_REVIEW_TIER = "sounding_silence_review_status";
const EPSILON_SECONDS = 0.000001;

function parseArgs(argv) {
  const args = {
    textgrid: DEFAULT_TEXTGRID,
    assemblyaiJson: DEFAULT_ASSEMBLYAI_JSON,
    output: "",
    outputDir: DEFAULT_OUTPUT_DIR,
    minDurationSeconds: 0.25,
    overlapMinSeconds: 0.05,
    allowOverlap: false,
  };

  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === "--textgrid" && next) {
      args.textgrid = next;
      i += 1;
    } else if (arg === "--assemblyai-json" && next) {
      args.assemblyaiJson = next;
      i += 1;
    } else if (arg === "--no-assemblyai-json") {
      args.assemblyaiJson = "";
    } else if (arg === "--output" && next) {
      args.output = next;
      i += 1;
    } else if (arg === "--output-dir" && next) {
      args.outputDir = next;
      i += 1;
    } else if (arg === "--min-duration-seconds" && next) {
      args.minDurationSeconds = Number(next);
      i += 1;
    } else if (arg === "--overlap-min-seconds" && next) {
      args.overlapMinSeconds = Number(next);
      i += 1;
    } else if (arg === "--allow-overlap") {
      args.allowOverlap = true;
    } else if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`Unknown or incomplete argument: ${arg}`);
    }
  }

  for (const [key, value] of Object.entries({
    minDurationSeconds: args.minDurationSeconds,
    overlapMinSeconds: args.overlapMinSeconds,
  })) {
    if (!Number.isFinite(value) || value < 0) throw new Error(`${key} must be a non-negative number`);
  }

  return args;
}

function printHelp() {
  console.log(`Usage:
  node scripts/extract-reviewed-units.mjs [options]

Options:
  --textgrid <path>              Reviewed or draft 6-tier TextGrid.
                                  Default: ${DEFAULT_TEXTGRID}
  --assemblyai-json <path>        Optional raw AssemblyAI JSON used only to flag original ASR overlap candidates.
                                  Default: ${DEFAULT_ASSEMBLYAI_JSON}
  --no-assemblyai-json            Disable AssemblyAI JSON overlap checks.
  --output <path>                 Output utterance_units.json path.
  --output-dir <path>             Output directory if --output is omitted. Default: ${DEFAULT_OUTPUT_DIR}
  --min-duration-seconds <number> Minimum unit duration allowed for alignment. Default: 0.25
  --overlap-min-seconds <number>  Minimum overlap to flag as overlap_candidate. Default: 0.05
  --allow-overlap                 Do not mark overlap candidates as alignment_allowed=false.
`);
}

function normalizeSpeaker(value) {
  const text = String(value ?? "").trim();
  if (!text) return "";
  return text.replace(/\s+/g, "_");
}

function cleanTranscriptForUnit(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function isPendingStatus(value) {
  return /^pending\b/i.test(String(value ?? "").trim());
}

function isNonEmptyInterval(interval) {
  return cleanTranscriptForUnit(interval.text).length > 0;
}

function readAssemblyAiOverlapIntervals(jsonPath, minOverlapSeconds) {
  if (!jsonPath) return [];
  const resolvedPath = resolve(jsonPath);
  if (!existsSync(resolvedPath)) return [];

  const raw = JSON.parse(readFileSync(resolvedPath, "utf8"));
  const utterances = Array.isArray(raw.utterances) ? raw.utterances : [];
  const normalized = utterances
    .map((utterance, index) => ({
      id: `asr_utt_${String(index + 1).padStart(4, "0")}`,
      start: Number(utterance.start) / 1000,
      end: Number(utterance.end) / 1000,
      speaker: normalizeSpeaker(utterance.speaker ? `speaker_${utterance.speaker}` : ""),
      text: cleanTranscriptForUnit(utterance.text),
    }))
    .filter((utterance) => Number.isFinite(utterance.start) && Number.isFinite(utterance.end) && utterance.end > utterance.start);

  const overlapIntervals = [];
  for (let i = 0; i < normalized.length; i += 1) {
    for (let j = i + 1; j < normalized.length; j += 1) {
      const a = normalized[i];
      const b = normalized[j];
      if (b.start >= a.end) break;
      const overlap = overlapSeconds(a, b);
      if (overlap >= minOverlapSeconds - EPSILON_SECONDS) {
        overlapIntervals.push({
          start: Math.max(a.start, b.start),
          end: Math.min(a.end, b.end),
          overlap_sec: round(overlap, 3),
          utterances: [a.id, b.id],
          speakers: [...new Set([a.speaker, b.speaker].filter(Boolean))],
        });
      }
    }
  }

  return overlapIntervals;
}

function collectTierOverlaps(intervals, minOverlapSeconds) {
  const nonEmpty = intervals.filter((interval) => String(interval.text ?? "").trim());
  const overlaps = [];
  for (let i = 0; i < nonEmpty.length; i += 1) {
    for (let j = i + 1; j < nonEmpty.length; j += 1) {
      const a = nonEmpty[i];
      const b = nonEmpty[j];
      if (b.start >= a.end) break;
      const overlap = overlapSeconds(a, b);
      if (overlap >= minOverlapSeconds - EPSILON_SECONDS) {
        overlaps.push({
          start: Math.max(a.start, b.start),
          end: Math.min(a.end, b.end),
          overlap_sec: round(overlap, 3),
          labels: [String(a.text).trim(), String(b.text).trim()],
        });
      }
    }
  }
  return overlaps;
}

function main() {
  const args = parseArgs(process.argv);
  const textgridPath = resolve(args.textgrid);
  if (!existsSync(textgridPath)) throw new Error(`TextGrid does not exist: ${textgridPath}`);

  const textgridText = readFileSync(textgridPath, "utf8");
  const tiers = parseTextGrid(textgridText);
  const transcriptTier = getTier(tiers, TRANSCRIPT_TIER);
  const speakerTier = getTier(tiers, SPEAKER_TIER);
  const reviewTier = getOptionalTier(tiers, REVIEW_TIER);
  const soundingReviewTier = getOptionalTier(tiers, SOUNDING_REVIEW_TIER);

  const asrOverlapIntervals = readAssemblyAiOverlapIntervals(args.assemblyaiJson, args.overlapMinSeconds);
  const speakerOverlapIntervals = collectTierOverlaps(speakerTier.intervals, args.overlapMinSeconds);
  const units = [];

  transcriptTier.intervals.filter(isNonEmptyInterval).forEach((interval) => {
    const text = cleanTranscriptForUnit(interval.text);
    const target = { start: interval.start, end: interval.end };
    const { interval: speakerInterval } = bestOverlappingInterval(speakerTier.intervals, target);
    const { interval: reviewInterval } = reviewTier
      ? bestOverlappingInterval(reviewTier.intervals, target)
      : { interval: null };
    const { interval: soundingReviewInterval } = soundingReviewTier
      ? bestOverlappingInterval(soundingReviewTier.intervals, target)
      : { interval: null };

    const duration = interval.end - interval.start;
    const speaker = normalizeSpeaker(speakerInterval?.text);
    const flags = [];
    if (!speaker) flags.push("missing_speaker");
    if (duration < args.minDurationSeconds) flags.push("short_unit");
    if (reviewInterval && isPendingStatus(reviewInterval.text)) flags.push("pending_review_status");
    if (soundingReviewInterval && isPendingStatus(soundingReviewInterval.text)) {
      flags.push("pending_sounding_silence_review");
    }

    const asrOverlaps = asrOverlapIntervals.filter((overlap) => overlapSeconds(overlap, target) > 0);
    if (asrOverlaps.length > 0) flags.push("asr_overlap_candidate");

    const speakerOverlaps = speakerOverlapIntervals.filter((overlap) => overlapSeconds(overlap, target) > 0);
    if (speakerOverlaps.length > 0) flags.push("speaker_tier_overlap_candidate");

    const hasOverlap = flags.includes("asr_overlap_candidate") || flags.includes("speaker_tier_overlap_candidate");
    const alignmentAllowed =
      text.length > 0 &&
      speaker.length > 0 &&
      duration >= args.minDurationSeconds &&
      (args.allowOverlap || !hasOverlap);

    units.push({
      utt_id: `utt_${String(units.length + 1).padStart(4, "0")}`,
      start_sec: round(interval.start, 6),
      end_sec: round(interval.end, 6),
      duration_sec: round(duration, 6),
      speaker,
      text,
      alignment_allowed: alignmentAllowed,
      flags,
      source: {
        textgrid: textgridPath,
        transcript_tier: TRANSCRIPT_TIER,
        speaker_tier: SPEAKER_TIER,
      },
      review_status: reviewInterval?.text?.trim() ?? "",
      sounding_silence_review_status: soundingReviewInterval?.text?.trim() ?? "",
      overlap_candidates: {
        asr: asrOverlaps,
        speaker_tier: speakerOverlaps,
      },
    });
  });

  const outputPath = args.output
    ? resolve(args.output)
    : resolve(args.outputDir, `${basename(textgridPath, extname(textgridPath))}.utterance_units.json`);
  mkdirSync(resolve(outputPath, ".."), { recursive: true });

  const summary = {
    textgrid: textgridPath,
    assemblyai_json: args.assemblyaiJson ? resolve(args.assemblyaiJson) : "",
    unit_count: units.length,
    alignment_allowed_count: units.filter((unit) => unit.alignment_allowed).length,
    blocked_count: units.filter((unit) => !unit.alignment_allowed).length,
    missing_speaker_count: units.filter((unit) => unit.flags.includes("missing_speaker")).length,
    short_unit_count: units.filter((unit) => unit.flags.includes("short_unit")).length,
    asr_overlap_candidate_count: units.filter((unit) => unit.flags.includes("asr_overlap_candidate")).length,
    speaker_tier_overlap_candidate_count: units.filter((unit) =>
      unit.flags.includes("speaker_tier_overlap_candidate"),
    ).length,
    speakers: [...new Set(units.map((unit) => unit.speaker).filter(Boolean))].sort(),
    options: {
      min_duration_seconds: args.minDurationSeconds,
      overlap_min_seconds: args.overlapMinSeconds,
      allow_overlap: args.allowOverlap,
    },
  };

  writeFileSync(outputPath, `${JSON.stringify({ summary, units }, null, 2)}\n`);
  console.log(JSON.stringify({ output: outputPath, ...summary }, null, 2));
}

main();
