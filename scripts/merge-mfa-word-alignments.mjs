#!/usr/bin/env node

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { getTier, parseTextGrid, round } from "./textgrid-utils.mjs";

const DEFAULT_MANIFEST =
  "outputs/stage-c/AMI_ES2002a_Mix-Headset_10min/mfa-corpus/mfa-corpus-manifest.json";
const DEFAULT_MFA_OUTPUT_DIR = "outputs/stage-d/AMI_ES2002a_Mix-Headset_10min/mfa-output";
const DEFAULT_OUTPUT_JSON = "outputs/stage-d/AMI_ES2002a_Mix-Headset_10min/word_alignment.json";
const DEFAULT_OUTPUT_TEXTGRID = "outputs/stage-d/AMI_ES2002a_Mix-Headset_10min/word_alignment.TextGrid";

function parseArgs(argv) {
  const args = {
    manifest: DEFAULT_MANIFEST,
    mfaOutputDir: DEFAULT_MFA_OUTPUT_DIR,
    outputJson: DEFAULT_OUTPUT_JSON,
    outputTextGrid: DEFAULT_OUTPUT_TEXTGRID,
    timelineEndSeconds: 0,
    minSilenceSeconds: 0,
    alignmentAnalysisCsv: "",
    minOverallLogLikelihood: null,
    maxPhoneDurationDeviation: null,
  };

  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === "--manifest" && next) {
      args.manifest = next;
      i += 1;
    } else if (arg === "--mfa-output-dir" && next) {
      args.mfaOutputDir = next;
      i += 1;
    } else if (arg === "--output-json" && next) {
      args.outputJson = next;
      i += 1;
    } else if (arg === "--output-textgrid" && next) {
      args.outputTextGrid = next;
      i += 1;
    } else if (arg === "--timeline-end-seconds" && next) {
      args.timelineEndSeconds = Number(next);
      i += 1;
    } else if (arg === "--min-silence-seconds" && next) {
      args.minSilenceSeconds = Number(next);
      i += 1;
    } else if (arg === "--alignment-analysis-csv" && next) {
      args.alignmentAnalysisCsv = next;
      i += 1;
    } else if (arg === "--min-overall-log-likelihood" && next) {
      args.minOverallLogLikelihood = Number(next);
      i += 1;
    } else if (arg === "--max-phone-duration-deviation" && next) {
      args.maxPhoneDurationDeviation = Number(next);
      i += 1;
    } else if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`Unknown or incomplete argument: ${arg}`);
    }
  }

  for (const [key, value] of Object.entries({
    timelineEndSeconds: args.timelineEndSeconds,
    minSilenceSeconds: args.minSilenceSeconds,
  })) {
    if (!Number.isFinite(value) || value < 0) throw new Error(`${key} must be a non-negative number`);
  }

  // Log-likelihood thresholds are negative by nature, so only require a finite value when set.
  if (args.minOverallLogLikelihood !== null && !Number.isFinite(args.minOverallLogLikelihood)) {
    throw new Error("min-overall-log-likelihood must be a finite number");
  }
  if (args.maxPhoneDurationDeviation !== null && !Number.isFinite(args.maxPhoneDurationDeviation)) {
    throw new Error("max-phone-duration-deviation must be a finite number");
  }

  return args;
}

function printHelp() {
  console.log(`Usage:
  node scripts/merge-mfa-word-alignments.mjs [options]

Options:
  --manifest <path>              Stage C mfa-corpus-manifest.json.
                                  Default: ${DEFAULT_MANIFEST}
  --mfa-output-dir <path>         MFA output directory containing clip TextGrids.
                                  Default: ${DEFAULT_MFA_OUTPUT_DIR}
  --output-json <path>            Global word alignment JSON output.
                                  Default: ${DEFAULT_OUTPUT_JSON}
  --output-textgrid <path>        Global per-speaker word TextGrid output.
                                  Default: ${DEFAULT_OUTPUT_TEXTGRID}
  --timeline-end-seconds <n>      Optional explicit TextGrid xmax. Default: max clip end.
  --min-silence-seconds <n>       Minimum MFA blank interval to include in silence_intervals. Default: 0
  --alignment-analysis-csv <path> MFA alignment_analysis.csv with per-utterance QC metrics.
                                  Default: <mfa-output-dir>/alignment_analysis.csv
  --min-overall-log-likelihood <n> Flag utterances whose overall_log_likelihood is below this
                                  value as low_confidence (negative number; off by default).
  --max-phone-duration-deviation <n> Flag utterances whose phone_duration_deviation exceeds this
                                  value as low_confidence (off by default).
`);
}

// MFA emits one row per utterance in alignment_analysis.csv. An empty metric cell means MFA
// could not score that utterance (a strong "needs review" signal).
function parseAlignmentAnalysisCsv(path) {
  const map = new Map();
  if (!path || !existsSync(path)) return map;
  const text = readFileSync(path, "utf8").trim();
  if (!text) return map;
  const lines = text.split(/\r?\n/);
  const header = lines[0].split(",").map((h) => h.trim());
  const fileIdx = header.indexOf("file");
  if (fileIdx === -1) return map;
  const num = (cols, name) => {
    const raw = (cols[header.indexOf(name)] ?? "").trim();
    if (raw === "") return null;
    const value = Number(raw);
    return Number.isFinite(value) ? value : null;
  };
  for (let i = 1; i < lines.length; i += 1) {
    if (!lines[i].trim()) continue;
    const cols = lines[i].split(",");
    const uttId = (cols[fileIdx] ?? "").trim();
    if (!uttId) continue;
    map.set(uttId, {
      overall_log_likelihood: num(cols, "overall_log_likelihood"),
      speech_log_likelihood: num(cols, "speech_log_likelihood"),
      phone_duration_deviation: num(cols, "phone_duration_deviation"),
      snr: num(cols, "snr"),
    });
  }
  return map;
}

function tokenize(text) {
  return String(text ?? "")
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean);
}

function escapeTextGridString(value) {
  return String(value ?? "").replaceAll('"', '""');
}

function textGridPathForClip(mfaOutputDir, clip) {
  const wavRelative = clip.wav.replace(/\.wav$/i, ".TextGrid");
  const directPath = join(mfaOutputDir, wavRelative);
  if (existsSync(directPath)) return directPath;

  const fallback = join(mfaOutputDir, clip.speaker, `${basename(clip.wav, ".wav")}.TextGrid`);
  if (existsSync(fallback)) return fallback;
  return directPath;
}

function buildContiguousIntervals(rawIntervals, xmax) {
  const sorted = rawIntervals
    .filter((interval) => interval.end > interval.start)
    .sort((a, b) => a.start - b.start || a.end - b.end);
  const intervals = [];
  let cursor = 0;
  let trimmedCount = 0;

  for (const interval of sorted) {
    const start = Math.max(0, interval.start);
    const end = Math.min(xmax, interval.end);
    if (end <= cursor) {
      trimmedCount += 1;
      continue;
    }
    if (start > cursor) {
      intervals.push({ start: cursor, end: start, text: "" });
      cursor = start;
    }

    const adjustedStart = Math.max(start, cursor);
    if (adjustedStart > start) trimmedCount += 1;
    intervals.push({ start: adjustedStart, end, text: interval.text });
    cursor = end;
  }

  if (cursor < xmax) intervals.push({ start: cursor, end: xmax, text: "" });

  const merged = [];
  for (const interval of intervals) {
    const previous = merged.at(-1);
    if (previous && previous.text === interval.text && Math.abs(previous.end - interval.start) < 0.000001) {
      previous.end = interval.end;
    } else {
      merged.push({ ...interval });
    }
  }

  return { intervals: merged, trimmedCount };
}

function writeTextGrid(path, tiers, xmin, xmax) {
  const lines = [
    'File type = "ooTextFile"',
    'Object class = "TextGrid"',
    "",
    `xmin = ${xmin}`,
    `xmax = ${xmax}`,
    "tiers? <exists>",
    `size = ${tiers.length}`,
    "item []:",
  ];

  tiers.forEach((tier, tierIndex) => {
    lines.push(`    item [${tierIndex + 1}]:`);
    lines.push('        class = "IntervalTier"');
    lines.push(`        name = "${escapeTextGridString(tier.name)}"`);
    lines.push(`        xmin = ${xmin}`);
    lines.push(`        xmax = ${xmax}`);
    lines.push(`        intervals: size = ${tier.intervals.length}`);
    tier.intervals.forEach((interval, intervalIndex) => {
      lines.push(`        intervals [${intervalIndex + 1}]:`);
      lines.push(`            xmin = ${interval.start}`);
      lines.push(`            xmax = ${interval.end}`);
      lines.push(`            text = "${escapeTextGridString(interval.text)}"`);
    });
  });

  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${lines.join("\n")}\n`);
}

function main() {
  const parsed = parseArgs(process.argv);
  const manifestPath = resolve(parsed.manifest);
  const mfaOutputDir = resolve(parsed.mfaOutputDir);
  const outputJson = resolve(parsed.outputJson);
  const outputTextGrid = resolve(parsed.outputTextGrid);

  if (!existsSync(manifestPath)) throw new Error(`Manifest does not exist: ${manifestPath}`);
  if (!existsSync(mfaOutputDir)) throw new Error(`MFA output dir does not exist: ${mfaOutputDir}`);

  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  const clips = Array.isArray(manifest.clips) ? manifest.clips : [];
  const timelineEnd = parsed.timelineEndSeconds || Math.max(...clips.map((clip) => Number(clip.end_sec) || 0));

  const analysisCsvPath = resolve(parsed.alignmentAnalysisCsv || join(mfaOutputDir, "alignment_analysis.csv"));
  const analysisByUtt = parseAlignmentAnalysisCsv(analysisCsvPath);

  const wordIntervals = [];
  const silenceIntervals = [];
  const tierIntervalsBySpeaker = new Map();
  const reviewIntervalsBySpeaker = new Map();
  const reviewRecords = [];
  const missingTextGrids = [];

  const ensureSpeaker = (speaker) => {
    if (!tierIntervalsBySpeaker.has(speaker)) tierIntervalsBySpeaker.set(speaker, []);
    if (!reviewIntervalsBySpeaker.has(speaker)) reviewIntervalsBySpeaker.set(speaker, []);
  };

  for (const clip of clips) {
    const speaker = clip.speaker || "unknown_speaker";
    ensureSpeaker(speaker);
    const metrics = analysisByUtt.get(clip.utt_id) || null;
    const uttStart = Number(clip.start_sec) || 0;
    const uttEnd = Number(clip.end_sec) || 0;
    const textGridPath = textGridPathForClip(mfaOutputDir, clip);

    if (!existsSync(textGridPath)) {
      missingTextGrids.push(relative(mfaOutputDir, textGridPath));
      reviewRecords.push({
        utt_id: clip.utt_id,
        speaker,
        start_sec: uttStart,
        end_sec: uttEnd,
        status: "missing_alignment",
        flags: ["missing_textgrid"],
        metrics,
        oov_words: [],
      });
      reviewIntervalsBySpeaker.get(speaker).push({ start: uttStart, end: uttEnd, text: "missing_alignment" });
      continue;
    }

    const tiers = parseTextGrid(readFileSync(textGridPath, "utf8"));
    const wordsTier = getTier(tiers, "words");
    const speakerIntervals = tierIntervalsBySpeaker.get(speaker);
    const clipTextGridRel = relative(mfaOutputDir, textGridPath);
    const clipWords = [];
    let wordIndex = 0;
    let silenceIndex = 0;

    for (const interval of wordsTier.intervals) {
      const globalStart = round(Number(clip.clip_offset_sec) + interval.start, 6);
      const globalEnd = round(Number(clip.clip_offset_sec) + interval.end, 6);
      const text = String(interval.text ?? "").trim();
      speakerIntervals.push({ start: globalStart, end: globalEnd, text });

      if (text) {
        wordIndex += 1;
        clipWords.push({
          word_id: `${clip.utt_id}_w${String(wordIndex).padStart(3, "0")}`,
          utt_id: clip.utt_id,
          speaker,
          text,
          start_sec: globalStart,
          end_sec: globalEnd,
          duration_sec: round(globalEnd - globalStart, 6),
          local_start_sec: round(interval.start, 6),
          local_end_sec: round(interval.end, 6),
          clip_textgrid: clipTextGridRel,
          source_lab: clip.lab,
        });
      } else if (globalEnd - globalStart >= parsed.minSilenceSeconds) {
        silenceIndex += 1;
        silenceIntervals.push({
          silence_id: `${clip.utt_id}_sil${String(silenceIndex).padStart(3, "0")}`,
          utt_id: clip.utt_id,
          speaker,
          start_sec: globalStart,
          end_sec: globalEnd,
          duration_sec: round(globalEnd - globalStart, 6),
          local_start_sec: round(interval.start, 6),
          local_end_sec: round(interval.end, 6),
          clip_textgrid: clipTextGridRel,
        });
      }
    }

    // Per-utterance QC: OOV (lab tokens MFA did not align) + MFA confidence signals.
    const alignedSet = new Set(clipWords.map((word) => word.text.toLowerCase()));
    const labTokens = [...new Set(tokenize(clip.lab_text))];
    const oovWords = labTokens.filter((token) => !alignedSet.has(token));

    const scored = Boolean(metrics) && metrics.overall_log_likelihood !== null;
    const flags = [];
    if (!metrics) flags.push("missing_analysis_row");
    else if (!scored) flags.push("unscored");
    if (oovWords.length) flags.push("oov_or_unaligned");
    if (
      scored &&
      parsed.minOverallLogLikelihood !== null &&
      metrics.overall_log_likelihood < parsed.minOverallLogLikelihood
    ) {
      flags.push("low_overall_log_likelihood");
    }
    if (
      scored &&
      parsed.maxPhoneDurationDeviation !== null &&
      metrics.phone_duration_deviation !== null &&
      metrics.phone_duration_deviation > parsed.maxPhoneDurationDeviation
    ) {
      flags.push("high_phone_duration_deviation");
    }

    let status = "ok";
    if (flags.includes("low_overall_log_likelihood") || flags.includes("high_phone_duration_deviation")) {
      status = "low_confidence";
    } else if (flags.length) {
      status = "needs_review";
    }

    const confidence = {
      overall_log_likelihood: metrics ? metrics.overall_log_likelihood : null,
      speech_log_likelihood: metrics ? metrics.speech_log_likelihood : null,
      phone_duration_deviation: metrics ? metrics.phone_duration_deviation : null,
      snr: metrics ? metrics.snr : null,
      scored,
      status,
    };

    for (const word of clipWords) {
      word.alignment_confidence = confidence;
      word.alignment_flags = flags.slice();
      word.oov = oovWords.includes(word.text.toLowerCase());
      wordIntervals.push(word);
    }

    reviewRecords.push({
      utt_id: clip.utt_id,
      speaker,
      start_sec: uttStart,
      end_sec: uttEnd,
      status,
      flags,
      metrics,
      oov_words: oovWords,
    });

    if (status !== "ok") {
      reviewIntervalsBySpeaker.get(speaker).push({ start: uttStart, end: uttEnd, text: status });
    }
  }

  wordIntervals.sort((a, b) => a.start_sec - b.start_sec || a.end_sec - b.end_sec || a.speaker.localeCompare(b.speaker));
  silenceIntervals.sort((a, b) => a.start_sec - b.start_sec || a.end_sec - b.end_sec || a.speaker.localeCompare(b.speaker));

  let trimmedIntervalCount = 0;
  const textGridTiers = [...tierIntervalsBySpeaker.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([speaker, intervals]) => {
      const built = buildContiguousIntervals(intervals, timelineEnd);
      trimmedIntervalCount += built.trimmedCount;
      return {
        name: `${speaker}_mfa_words`,
        intervals: built.intervals.map((interval) => ({
          start: round(interval.start, 6),
          end: round(interval.end, 6),
          text: interval.text,
        })),
      };
    });

  const reviewTiers = [...reviewIntervalsBySpeaker.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([speaker, intervals]) => {
      const built = buildContiguousIntervals(intervals, timelineEnd);
      return {
        name: `${speaker}_alignment_review_status`,
        intervals: built.intervals.map((interval) => ({
          start: round(interval.start, 6),
          end: round(interval.end, 6),
          text: interval.text,
        })),
      };
    });

  const alignmentQc = {
    analysis_csv: analysisCsvPath,
    analysis_csv_present: analysisByUtt.size > 0,
    utterance_count: reviewRecords.length,
    ok_utterance_count: reviewRecords.filter((r) => r.status === "ok").length,
    needs_review_utterance_count: reviewRecords.filter((r) => r.status === "needs_review").length,
    low_confidence_utterance_count: reviewRecords.filter((r) => r.status === "low_confidence").length,
    missing_alignment_utterance_count: reviewRecords.filter((r) => r.status === "missing_alignment").length,
    unscored_utterance_count: reviewRecords.filter(
      (r) => r.flags.includes("unscored") || r.flags.includes("missing_analysis_row"),
    ).length,
    oov_utterance_count: reviewRecords.filter((r) => r.oov_words.length > 0).length,
    total_oov_word_count: reviewRecords.reduce((sum, r) => sum + r.oov_words.length, 0),
    flagged_word_count: wordIntervals.filter((w) => Array.isArray(w.alignment_flags) && w.alignment_flags.length > 0)
      .length,
    min_overall_log_likelihood: parsed.minOverallLogLikelihood,
    max_phone_duration_deviation: parsed.maxPhoneDurationDeviation,
  };

  const payload = {
    stage: "stage-d-word-alignment-merge",
    created_at: new Date().toISOString(),
    source_manifest: manifestPath,
    mfa_output_dir: mfaOutputDir,
    output_textgrid: outputTextGrid,
    timeline_start_sec: 0,
    timeline_end_sec: round(timelineEnd, 6),
    summary: {
      clip_count: clips.length,
      missing_textgrid_count: missingTextGrids.length,
      speaker_count: tierIntervalsBySpeaker.size,
      word_count: wordIntervals.length,
      mfa_blank_interval_count: silenceIntervals.length,
      trimmed_same_speaker_interval_count: trimmedIntervalCount,
      min_silence_seconds: parsed.minSilenceSeconds,
      alignment_qc: alignmentQc,
    },
    missing_textgrids: missingTextGrids,
    alignment_review: reviewRecords,
    word_intervals: wordIntervals,
    mfa_blank_intervals: silenceIntervals,
  };

  mkdirSync(dirname(outputJson), { recursive: true });
  writeFileSync(outputJson, `${JSON.stringify(payload, null, 2)}\n`);
  writeTextGrid(outputTextGrid, [...textGridTiers, ...reviewTiers], 0, round(timelineEnd, 6));

  console.log(
    JSON.stringify(
      {
        ok: true,
        output_json: outputJson,
        output_textgrid: outputTextGrid,
        ...payload.summary,
      },
      null,
      2,
    ),
  );
}

main();
