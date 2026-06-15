#!/usr/bin/env node

import { createRequire } from "node:module";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { basename, dirname, extname, resolve } from "node:path";

const DEFAULT_INPUT = "sample-inputs/AMI_ES2002a_Mix-Headset_10min.assemblyai.6tier.TextGrid";
const DEFAULT_ASSEMBLYAI_JSON =
  "sample-inputs/assemblyai/AMI_ES2002a_Mix-Headset_10min.assemblyai.raw.json";
const DEFAULT_OUTPUT_DIR = "outputs/textgrid-export";
const SOUNDING_SILENCE_TIER = "sounding_silence";
const PRAAT_SOUNDING_SILENCE_TIER = "praat_sounding_silence";
const LOCAL_VAD_SOUNDING_SILENCE_TIER = "local_vad_sounding_silence";
const SOUNDING_SILENCE_REVIEW_TIER = "sounding_silence_review_status";
const TRANSCRIPT_TIER = "transcript";
const SPEAKER_TIER = "speaker";
const REVIEW_TIER = "review_status";
const UNKNOWN_SPEAKER = "unknown";
const ACOUSTIC_ONLY_UTTERANCE_ID = "acoustic_only";
const UNTRANSCRIBED_ACOUSTIC_TEXT = "[untranscribed acoustic activity]";
const ASR_DURING_SILENCE_TEXT = "[ASR utterance overlaps acoustic silence]";
const REVIEWED_ACOUSTIC_ONLY_TEXT = "[reviewed acoustic activity without transcript]";
const CONTINUED_UTTERANCE_TEXT = "[continued utterance]";

function parseArgs(argv) {
  const args = {
    input: DEFAULT_INPUT,
    assemblyaiJson: DEFAULT_ASSEMBLYAI_JSON,
    output: "",
    outputDir: DEFAULT_OUTPUT_DIR,
    reviewed: false,
    pauseSegmentsJson: "",
  };

  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === "--input" && next) {
      args.input = next;
      i += 1;
    } else if (arg === "--assemblyai-json" && next) {
      args.assemblyaiJson = next;
      i += 1;
    } else if (arg === "--no-assemblyai-json") {
      args.assemblyaiJson = "";
    } else if (arg === "--reviewed") {
      args.reviewed = true;
    } else if (arg === "--pause-segments-json" && next) {
      args.pauseSegmentsJson = next;
      i += 1;
    } else if (arg === "--output" && next) {
      args.output = next;
      i += 1;
    } else if (arg === "--output-dir" && next) {
      args.outputDir = next;
      i += 1;
    } else if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`Unknown or incomplete argument: ${arg}`);
    }
  }

  return args;
}

function printHelp() {
  console.log(`Usage:
  node scripts/textgrid-to-review-excel.mjs [options]

Options:
  --input <path>       Reviewed or draft 6-tier TextGrid. Default: ${DEFAULT_INPUT}
  --assemblyai-json <path>
                       AssemblyAI raw JSON for word-level segment transcript.
                       Default: ${DEFAULT_ASSEMBLYAI_JSON}
  --no-assemblyai-json
                       Disable AssemblyAI word JSON. Use this for reviewed TextGrids whose transcript
                       has been corrected after ASR.
  --reviewed           Treat the input as a reviewed TextGrid. Build the final timeline from
                       researcher-reviewed tiers 1, 4, and 5 instead of draft audit tiers.
  --pause-segments-json <path>
                       Optional Stage E pause_segments.json. Adds a Pauses sheet with
                       pause-location / word-alignment dependency fields.
  --output <path>      Output .xlsx file path.
  --output-dir <path>  Output directory if --output is omitted. Default: ${DEFAULT_OUTPUT_DIR}
`);
}

async function loadArtifactTool() {
  const moduleDirs = [
    process.env.ARTIFACT_TOOL_NODE_MODULES,
    "/Users/nedved/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules",
  ].filter(Boolean);

  for (const moduleDir of moduleDirs) {
    try {
      const requireFromModuleDir = createRequire(path.join(moduleDir, "artifact-tool-loader.cjs"));
      const resolved = requireFromModuleDir.resolve("@oai/artifact-tool");
      return import(resolved);
    } catch {
      // Try the next configured module directory.
    }
  }

  try {
    return import("@oai/artifact-tool");
  } catch {
    throw new Error(
      "Cannot load @oai/artifact-tool. Set ARTIFACT_TOOL_NODE_MODULES or install @oai/artifact-tool.",
    );
  }
}

function unquoteTextGridString(value) {
  return String(value ?? "").replaceAll('""', '"');
}

function parseTextGrid(text) {
  const tiers = [];
  let currentTier = null;
  let currentInterval = null;

  for (const line of text.split(/\r?\n/)) {
    if (/^\s*item \[\d+\]:\s*$/.test(line)) {
      currentTier = { name: "", intervals: [] };
      currentInterval = null;
      tiers.push(currentTier);
      continue;
    }

    if (!currentTier) continue;

    const nameMatch = line.match(/^\s*name = "(.*)"\s*$/);
    if (nameMatch && !currentInterval) {
      currentTier.name = unquoteTextGridString(nameMatch[1]);
      continue;
    }

    if (/^\s*intervals \[\d+\]:\s*$/.test(line)) {
      currentInterval = { start: Number.NaN, end: Number.NaN, text: "" };
      currentTier.intervals.push(currentInterval);
      continue;
    }

    if (!currentInterval) continue;

    const xminMatch = line.match(/^\s*xmin = ([^\s]+)\s*$/);
    if (xminMatch) {
      currentInterval.start = Number(xminMatch[1]);
      continue;
    }

    const xmaxMatch = line.match(/^\s*xmax = ([^\s]+)\s*$/);
    if (xmaxMatch) {
      currentInterval.end = Number(xmaxMatch[1]);
      continue;
    }

    const textMatch = line.match(/^\s*text = "(.*)"\s*$/);
    if (textMatch) {
      currentInterval.text = unquoteTextGridString(textMatch[1]);
    }
  }

  for (const tier of tiers) {
    tier.intervals = tier.intervals.filter((interval) => {
      return Number.isFinite(interval.start) && Number.isFinite(interval.end) && interval.end > interval.start;
    });
  }

  return tiers.filter((tier) => tier.name);
}

function getTier(tiers, name) {
  const tier = tiers.find((candidate) => candidate.name === name);
  if (!tier) throw new Error(`Missing required TextGrid tier: ${name}`);
  return tier;
}

function getOptionalTier(tiers, name) {
  return tiers.find((candidate) => candidate.name === name) ?? null;
}

function getPrimarySoundingSilenceTier(tiers) {
  return (
    getOptionalTier(tiers, SOUNDING_SILENCE_TIER) ??
    getOptionalTier(tiers, PRAAT_SOUNDING_SILENCE_TIER) ??
    getOptionalTier(tiers, LOCAL_VAD_SOUNDING_SILENCE_TIER) ??
    null
  );
}

function overlapSeconds(a, b) {
  return Math.max(0, Math.min(a.end, b.end) - Math.max(a.start, b.start));
}

function matchingInterval(intervals, target) {
  let best = null;
  let bestOverlap = 0;

  for (const interval of intervals) {
    const overlap = overlapSeconds(interval, target);
    if (overlap > bestOverlap) {
      best = interval;
      bestOverlap = overlap;
    }
  }

  if (best) return best;

  const midpoint = (target.start + target.end) / 2;
  return intervals.find((interval) => interval.start <= midpoint && midpoint <= interval.end) ?? null;
}

function intervalAtMidpoint(intervals, start, end) {
  const midpoint = (start + end) / 2;
  return intervals.find((interval) => interval.start <= midpoint && midpoint <= interval.end) ?? null;
}

function classifyReviewStatus(status) {
  const normalized = status.trim();
  if (!normalized) {
    return {
      review_state: "auto_ok",
      review_detail: "",
      review_required: false,
      human_reviewed: false,
      include_in_research: true,
    };
  }

  const prefix = normalized.split(":", 1)[0].toLowerCase();
  const detail = normalized.includes(":") ? normalized.slice(normalized.indexOf(":") + 1).trim() : "";
  return {
    review_state: prefix,
    review_detail: detail,
    review_required: prefix === "pending",
    human_reviewed: ["confirmed", "fixed", "exclude"].includes(prefix),
    include_in_research: prefix !== "exclude",
  };
}

function classifyPendingAcoustic(reason) {
  return {
    review_state: "pending",
    review_detail: reason,
    review_required: true,
    human_reviewed: false,
    include_in_research: true,
  };
}

function wordCount(text) {
  const words = text.trim().match(/\S+/g);
  return words ? words.length : 0;
}

function readAssemblyAiWords(jsonPath) {
  if (!jsonPath) return [];
  const resolvedPath = resolve(jsonPath);
  if (!existsSync(resolvedPath)) {
    throw new Error(`AssemblyAI raw JSON does not exist: ${resolvedPath}`);
  }

  const raw = JSON.parse(readFileSync(resolvedPath, "utf8"));
  const utterances = Array.isArray(raw.utterances) ? raw.utterances : [];
  const words = [];

  utterances.forEach((utterance, utteranceIndex) => {
    const utteranceWords = Array.isArray(utterance.words) ? utterance.words : [];
    utteranceWords.forEach((word, wordIndex) => {
      if (!Number.isFinite(Number(word.start)) || !Number.isFinite(Number(word.end))) return;

      const start = Number(word.start) / 1000;
      let end = Number(word.end) / 1000;
      if (end <= start) end = start + 0.05;

      words.push({
        utterance_id: utteranceIndex + 1,
        word_index: wordIndex + 1,
        start,
        end,
        text: String(word.text ?? "").trim(),
        speaker: word.speaker == null ? "" : `speaker_${word.speaker}`,
      });
    });
  });

  return words.filter((word) => word.text);
}

function readPauseSegments(jsonPath) {
  if (!jsonPath) return null;
  const resolvedPath = resolve(jsonPath);
  if (!existsSync(resolvedPath)) throw new Error(`Pause segments JSON does not exist: ${resolvedPath}`);
  const payload = JSON.parse(readFileSync(resolvedPath, "utf8"));
  const pauses = Array.isArray(payload.pauses) ? payload.pauses : [];
  return {
    path: resolvedPath,
    summary: payload.summary ?? {},
    pauses,
  };
}

function wordsForSegment(words, utteranceId, start, end, toleranceSeconds = 0) {
  return words.filter((word) => {
    if (word.utterance_id !== utteranceId) return false;
    const midpoint = (word.start + word.end) / 2;
    return midpoint >= start - toleranceSeconds && midpoint < end + toleranceSeconds;
  });
}

function segmentTranscriptFromWords(words, utteranceId, start, end) {
  const segmentWords = wordsForSegment(words, utteranceId, start, end);
  return segmentWords.map((word) => word.text).join(" ").trim();
}

function formatTimestamp(seconds) {
  const totalCentiseconds = Math.max(0, Math.round(Number(seconds) * 100));
  const centiseconds = totalCentiseconds % 100;
  const totalWholeSeconds = Math.floor(totalCentiseconds / 100);
  const wholeSeconds = totalWholeSeconds % 60;
  const totalMinutes = Math.floor(totalWholeSeconds / 60);
  const minutes = totalMinutes % 60;
  const hours = Math.floor(totalMinutes / 60);

  const secondText = `${String(wholeSeconds).padStart(2, "0")}.${String(centiseconds).padStart(2, "0")}`;
  const minuteText = String(minutes).padStart(2, "0");
  if (hours > 0) return `${String(hours).padStart(2, "0")}:${minuteText}:${secondText}`;
  return `${minuteText}:${secondText}`;
}

function rowsFromTextGrid(tiers, sourceTextGrid) {
  const transcriptTier = getTier(tiers, TRANSCRIPT_TIER);
  const speakerTier = getTier(tiers, SPEAKER_TIER);
  const reviewTier = getTier(tiers, REVIEW_TIER);

  return transcriptTier.intervals
    .filter((interval) => interval.text.trim())
    .map((transcript, index) => {
      const speaker = matchingInterval(speakerTier.intervals, transcript);
      const review = matchingInterval(reviewTier.intervals, transcript);
      const reviewStatus = review?.text.trim() ?? "";
      const classification = classifyReviewStatus(reviewStatus);

      return {
        utterance_id: index + 1,
        start_time: formatTimestamp(transcript.start),
        end_time: formatTimestamp(transcript.end),
        duration_seconds: roundSeconds(transcript.end - transcript.start),
        speaker: speaker?.text.trim() ?? "",
        transcript: transcript.text.trim(),
        review_status: reviewStatus,
        ...classification,
        word_count: wordCount(transcript.text),
        source_textgrid: basename(sourceTextGrid),
      };
    });
}

function timelineRowsFromTextGrid(tiers, sourceTextGrid, assemblyAiWords, options = {}) {
  const soundingSilenceTier = getPrimarySoundingSilenceTier(tiers);
  if (!soundingSilenceTier) {
    throw new Error(
      `Missing required TextGrid tier: ${SOUNDING_SILENCE_TIER} or ${PRAAT_SOUNDING_SILENCE_TIER}`,
    );
  }
  const praatRefTier = getOptionalTier(tiers, PRAAT_SOUNDING_SILENCE_TIER);
  const localVadRefTier = getOptionalTier(tiers, LOCAL_VAD_SOUNDING_SILENCE_TIER);
  const soundingSilenceReviewTier = getOptionalTier(tiers, SOUNDING_SILENCE_REVIEW_TIER);
  const transcriptTier = getTier(tiers, TRANSCRIPT_TIER);
  const speakerTier = getTier(tiers, SPEAKER_TIER);
  const reviewTier = getTier(tiers, REVIEW_TIER);
  const transcriptEntries = transcriptTier.intervals
    .filter((interval) => interval.text.trim())
    .map((interval, index) => ({ ...interval, utterance_id: index + 1 }));
  const boundaryIntervals = options.reviewed
    ? [...soundingSilenceTier.intervals, ...transcriptEntries]
    : [
        ...soundingSilenceTier.intervals,
        ...(praatRefTier?.intervals ?? []),
        ...(localVadRefTier?.intervals ?? []),
        ...(soundingSilenceReviewTier?.intervals ?? []),
        ...transcriptEntries,
      ];
  const boundaries = uniqueSortedBoundaries(boundaryIntervals);
  const splitRows = [];

  for (let index = 0; index < boundaries.length - 1; index += 1) {
    const start = boundaries[index];
    const end = boundaries[index + 1];
    if (end <= start) continue;

    const soundInterval = intervalAtMidpoint(soundingSilenceTier.intervals, start, end);
    const segmentType = soundInterval?.text.trim() || "unlabeled";
    const isSounding = segmentType === "sounding";
    const transcript = matchingUtteranceForTimelineSegment(transcriptEntries, { start, end }, {
      allowNearest: !options.reviewed,
    });
    const speaker = transcript ? matchingInterval(speakerTier.intervals, transcript) : null;
    const review = transcript ? matchingInterval(reviewTier.intervals, transcript) : null;
    const praatRef = options.reviewed
      ? soundInterval
      : praatRefTier
        ? intervalAtMidpoint(praatRefTier.intervals, start, end)
        : null;
    const localVadRef =
      !options.reviewed && localVadRefTier
        ? intervalAtMidpoint(localVadRefTier.intervals, start, end)
        : null;
    const soundingSilenceReview =
      !options.reviewed && soundingSilenceReviewTier
        ? intervalAtMidpoint(soundingSilenceReviewTier.intervals, start, end)
        : null;

    splitRows.push({
      segment_id: splitRows.length + 1,
      segment_type: segmentType,
      start,
      end,
      praat_ref_label: praatRef?.text.trim() ?? "",
      local_vad_ref_label: localVadRef?.text.trim() ?? "",
      sounding_silence_review_status: soundingSilenceReview?.text.trim() ?? "",
      speaker: transcript ? speaker?.text.trim() ?? "" : "",
      utterance_id: transcript?.utterance_id ?? "",
      transcript: "",
      review_status: "",
      review_state: isSounding && transcript ? "continued" : "n/a",
      review_detail: "",
      review_required: false,
      human_reviewed: false,
      include_in_research: true,
      word_count: 0,
      source_textgrid: basename(sourceTextGrid),
      _transcriptText: transcript?.text.trim() ?? "",
      _reviewStatus: review?.text.trim() ?? "",
      _soundingSilenceReviewStatus: soundingSilenceReview?.text.trim() ?? "",
      _words: assemblyAiWords,
    });
  }

  const mergedRows = mergeAdjacentTimelineRows(splitRows);
  return finalizeTimelineRows(mergedRows, assemblyAiWords, options);
}

function uniqueSortedBoundaries(intervals) {
  const boundaries = new Set();
  for (const interval of intervals) {
    if (Number.isFinite(interval.start)) boundaries.add(interval.start.toFixed(6));
    if (Number.isFinite(interval.end)) boundaries.add(interval.end.toFixed(6));
  }
  return [...boundaries].map(Number).sort((a, b) => a - b);
}

function mergeAdjacentTimelineRows(rows) {
  const merged = [];
  for (const row of rows) {
    const previous = merged[merged.length - 1];
    if (previous && canMergeTimelineRows(previous, row)) {
      previous.end = row.end;
    } else {
      merged.push({ ...row });
    }
  }
  return merged;
}

function canMergeTimelineRows(left, right) {
  if (Math.abs(left.end - right.start) > 0.000001) return false;
  if (left.segment_type !== right.segment_type) return false;
  const sameAuditLabels =
    left.praat_ref_label === right.praat_ref_label &&
    left.local_vad_ref_label === right.local_vad_ref_label &&
    left.sounding_silence_review_status === right.sounding_silence_review_status;
  if (left.segment_type === "silence" && !left.utterance_id && !right.utterance_id) {
    return sameAuditLabels;
  }
  return (
    left.speaker === right.speaker &&
    left.utterance_id === right.utterance_id &&
    left._transcriptText === right._transcriptText &&
    sameAuditLabels
  );
}

function finalizeTimelineRows(rows, assemblyAiWords, options = {}) {
  const hasWordData = assemblyAiWords.length > 0;
  const emittedReviewedUtterances = new Set();

  return rows.map((row, index) => {
    const isSounding = row.segment_type === "sounding";
    const hasAsrUtterance = Boolean(row.utterance_id);
    let reviewStatus = hasAsrUtterance ? row._reviewStatus : "";
    const soundingSilenceStatus = row._soundingSilenceReviewStatus || "";
    const segmentTranscript =
      hasAsrUtterance
        ? segmentTranscriptFromWords(assemblyAiWords, row.utterance_id, row.start, row.end)
        : "";
    let transcript = "";
    let classification = {
      review_state: "n/a",
      review_detail: "",
      review_required: false,
      human_reviewed: false,
      include_in_research: true,
    };

    if (options.reviewed && isSounding && !hasAsrUtterance) {
      transcript = REVIEWED_ACOUSTIC_ONLY_TEXT;
      classification = {
        review_state: "confirmed",
        review_detail: "reviewed acoustic activity without aligned transcript",
        review_required: false,
        human_reviewed: true,
        include_in_research: true,
      };
    } else if (isSounding && !hasAsrUtterance) {
      transcript = UNTRANSCRIBED_ACOUSTIC_TEXT;
      reviewStatus = "pending: acoustic sounding has no overlapping ASR utterance; verify in Praat";
      classification = classifyPendingAcoustic(
        "acoustic sounding has no overlapping ASR utterance; verify in Praat",
      );
    } else if (!isSounding && hasAsrUtterance && segmentTranscript) {
      transcript = segmentTranscript || ASR_DURING_SILENCE_TEXT;
      reviewStatus = reviewStatus
        ? `${reviewStatus}; ASR words overlap acoustic silence`
        : "pending: ASR words overlap acoustic silence; verify VAD in Praat";
      classification = classifyPendingAcoustic("ASR words overlap acoustic silence; verify VAD in Praat");
    } else if (hasAsrUtterance && segmentTranscript) {
      transcript = segmentTranscript;
      classification = classifyReviewStatus(reviewStatus);
    } else if (options.reviewed && isSounding && hasAsrUtterance && !hasWordData) {
      if (!emittedReviewedUtterances.has(row.utterance_id)) {
        transcript = row._transcriptText;
        emittedReviewedUtterances.add(row.utterance_id);
      } else {
        transcript = CONTINUED_UTTERANCE_TEXT;
      }
      classification = classifyReviewStatus(reviewStatus);
    } else if (isSounding && hasAsrUtterance && hasWordData) {
      transcript = UNTRANSCRIBED_ACOUSTIC_TEXT;
      reviewStatus = reviewStatus
        ? `${reviewStatus}; acoustic sounding has no word-level transcript in this time window`
        : "pending: acoustic sounding has no word-level transcript in this time window; verify in Praat";
      classification = classifyPendingAcoustic(
        "acoustic sounding has no word-level transcript in this time window; verify in Praat",
      );
    } else if (isSounding && hasAsrUtterance) {
      transcript = row._transcriptText;
      classification = classifyReviewStatus(reviewStatus);
    }

    if (reviewStatus && classification.review_state === "n/a") {
      classification = classifyReviewStatus(reviewStatus);
    }

    if (/^pending\b/i.test(soundingSilenceStatus) && classification.review_state !== "pending") {
      classification = classifyPendingAcoustic(soundingSilenceStatus.replace(/^pending:\s*/i, ""));
    }

    return {
      segment_id: index + 1,
      segment_type: row.segment_type,
      praat_ref_label: row.praat_ref_label,
      local_vad_ref_label: row.local_vad_ref_label,
      sounding_silence_review_status: soundingSilenceStatus,
      start_time: formatTimestamp(row.start),
      end_time: formatTimestamp(row.end),
      duration_seconds: roundSeconds(row.end - row.start),
      speaker: isSounding || hasAsrUtterance ? row.speaker || UNKNOWN_SPEAKER : "",
      utterance_id: isSounding
        ? row.utterance_id || ACOUSTIC_ONLY_UTTERANCE_ID
        : row.utterance_id || "",
      transcript,
      review_status: reviewStatus,
      ...classification,
      word_count:
        transcript === UNTRANSCRIBED_ACOUSTIC_TEXT ||
        transcript === ASR_DURING_SILENCE_TEXT ||
        transcript === REVIEWED_ACOUSTIC_ONLY_TEXT ||
        transcript === CONTINUED_UTTERANCE_TEXT
          ? 0
          : wordCount(transcript),
      source_textgrid: row.source_textgrid,
    };
  });
}

function matchingUtteranceForTimelineSegment(
  utterances,
  segment,
  { toleranceSeconds = 0.08, allowNearest = true } = {},
) {
  let best = null;
  let bestOverlap = 0;

  for (const utterance of utterances) {
    const overlap = overlapSeconds(utterance, segment);
    if (overlap > bestOverlap) {
      best = utterance;
      bestOverlap = overlap;
    }
  }

  if (best) return best;
  if (!allowNearest) return null;

  let nearest = null;
  let nearestGap = Number.POSITIVE_INFINITY;
  for (const utterance of utterances) {
    const gap = Math.min(
      Math.abs(segment.end - utterance.start),
      Math.abs(segment.start - utterance.end),
    );
    if (gap < nearestGap) {
      nearest = utterance;
      nearestGap = gap;
    }
  }

  return nearestGap <= toleranceSeconds ? nearest : null;
}

function roundSeconds(value) {
  return Math.round(value * 100) / 100;
}

function summarizeRows(rows, timelineRows) {
  const byState = new Map();
  const bySpeaker = new Map();

  for (const row of rows) {
    byState.set(row.review_state, (byState.get(row.review_state) ?? 0) + 1);
    bySpeaker.set(row.speaker, (bySpeaker.get(row.speaker) ?? 0) + 1);
  }

  const silenceRows = timelineRows.filter((row) => row.segment_type === "silence");
  const soundingRows = timelineRows.filter((row) => row.segment_type === "sounding");
  const acousticOnlyRows = soundingRows.filter((row) => row.transcript === UNTRANSCRIBED_ACOUSTIC_TEXT);
  const asrDuringSilenceRows = silenceRows.filter((row) => row.review_state === "pending" && row.transcript);
  const soundingSilenceConflictRows = timelineRows.filter((row) => row.sounding_silence_review_status);
  const timelinePendingRows = timelineRows.filter((row) => row.review_state === "pending");

  return {
    utterances: rows.length,
    timelineSegments: timelineRows.length,
    silenceSegments: silenceRows.length,
    soundingSegments: soundingRows.length,
    silenceDurationSeconds: roundSeconds(
      silenceRows.reduce((total, row) => total + Number(row.duration_seconds ?? 0), 0),
    ),
    acousticOnlySoundingSegments: acousticOnlyRows.length,
    asrDuringSilenceSegments: asrDuringSilenceRows.length,
    soundingSilenceConflictSegments: soundingSilenceConflictRows.length,
    soundingSilenceConflictSeconds: roundSeconds(
      soundingSilenceConflictRows.reduce((total, row) => total + Number(row.duration_seconds ?? 0), 0),
    ),
    timelinePendingReviewSegments: timelinePendingRows.length,
    soundingDurationSeconds: roundSeconds(
      soundingRows.reduce((total, row) => total + Number(row.duration_seconds ?? 0), 0),
    ),
    pending: rows.filter((row) => row.review_state === "pending").length,
    confirmed: rows.filter((row) => row.review_state === "confirmed").length,
    fixed: rows.filter((row) => row.review_state === "fixed").length,
    excluded: rows.filter((row) => row.review_state === "exclude").length,
    autoOk: rows.filter((row) => row.review_state === "auto_ok").length,
    included: rows.filter((row) => row.include_in_research).length,
    byState,
    bySpeaker,
  };
}

function validateExportRows(utteranceRows, timelineRows) {
  const unmatchedSoundingRows = timelineRows.filter((row) => {
    return row.segment_type === "sounding" && (!row.speaker || !row.utterance_id || !row.transcript);
  });
  if (unmatchedSoundingRows.length > 0) {
    throw new Error(
      [
        `Invalid export: ${unmatchedSoundingRows.length} sounding rows are missing speaker, utterance_id, or transcript.`,
        JSON.stringify(unmatchedSoundingRows.slice(0, 8), null, 2),
      ].join("\n"),
    );
  }

  const transcriptIds = new Set(
    timelineRows
      .filter((row) => row.transcript && row.transcript !== UNTRANSCRIBED_ACOUSTIC_TEXT)
      .map((row) => Number(row.utterance_id))
      .filter((utteranceId) => Number.isInteger(utteranceId) && utteranceId > 0),
  );

  for (let id = 1; id <= utteranceRows.length; id += 1) {
    if (!transcriptIds.has(id)) {
      throw new Error(`Invalid export: missing timeline row for utterance_id ${id}.`);
    }
  }
}

function outputPathFor(inputPath, args) {
  if (args.output) return resolve(args.output);
  const base = basename(inputPath, extname(inputPath));
  return resolve(args.outputDir, `${base}.review.xlsx`);
}

function columnName(index) {
  let current = index;
  let name = "";
  while (current > 0) {
    const remainder = (current - 1) % 26;
    name = String.fromCharCode(65 + remainder) + name;
    current = Math.floor((current - 1) / 26);
  }
  return name;
}

async function buildWorkbook(rows, summary, metadata, outputPath, pauseSegments) {
  const { SpreadsheetFile, Workbook } = await loadArtifactTool();
  const workbook = Workbook.create();

  const timeline = workbook.worksheets.add("Timeline");
  const pausesSheet = pauseSegments ? workbook.worksheets.add("Pauses") : null;
  const summarySheet = workbook.worksheets.add("Summary");

  const timelineHeaders = [
    "segment_id",
    "segment_type",
    "praat_ref_label",
    "local_vad_ref_label",
    "sounding_silence_review_status",
    "start_time",
    "end_time",
    "duration_seconds",
    "speaker",
    "utterance_id",
    "transcript",
    "review_status",
    "review_state",
    "review_detail",
    "review_required",
    "human_reviewed",
    "include_in_research",
    "word_count",
    "source_textgrid",
  ];
  const timelineMatrix = [
    timelineHeaders,
    ...summary.timelineRows.map((row) => timelineHeaders.map((header) => row[header])),
  ];
  timeline.getRange(`A1:${columnName(timelineHeaders.length)}${timelineMatrix.length}`).values =
    timelineMatrix;
  if (timelineMatrix.length > 1) {
    timeline.getRange(`H2:H${timelineMatrix.length}`).format.numberFormat = "0.00";
  }

  if (pausesSheet) {
    const pauseHeaders = [
      "pause_id",
      "start_sec",
      "end_sec",
      "duration_sec",
      "threshold_sec",
      "speaker_context",
      "pause_location_candidate",
      "location_confidence",
      "needs_word_alignment",
      "needs_clause_boundary",
      "previous_utterance_id",
      "previous_speaker",
      "previous_text",
      "next_utterance_id",
      "next_speaker",
      "next_text",
      "containing_utterance_id",
      "containing_speaker",
      "containing_text",
      "overlapping_utterance_id",
      "overlapping_speaker",
      "overlapping_text",
      "previous_word",
      "next_word",
      "word_timing_source",
      "notes",
    ];
    const pauseRows = pauseSegments.pauses.map((row) =>
      pauseHeaders.map((header) => {
        const value = row[header];
        return typeof value === "boolean" ? String(value) : value ?? "";
      }),
    );
    const pauseMatrix = [pauseHeaders, ...pauseRows];
    pausesSheet.getRange(`A1:${columnName(pauseHeaders.length)}${pauseMatrix.length}`).values = pauseMatrix;
    if (pauseMatrix.length > 1) {
      pausesSheet.getRange(`B2:E${pauseMatrix.length}`).format.numberFormat = "0.000";
    }
  }

  const stateRows = [...summary.byState.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  const speakerRows = [...summary.bySpeaker.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  const summaryMatrix = [
    ["Metric", "Value"],
    ["Source TextGrid", metadata.sourceTextGrid],
    ["Generated At", metadata.generatedAt],
    ["Timeline Segments", summary.timelineSegments],
    ["Sounding Segments", summary.soundingSegments],
    ["Silence Segments", summary.silenceSegments],
    ["Sounding Duration", formatTimestamp(summary.soundingDurationSeconds)],
    ["Silence Duration", formatTimestamp(summary.silenceDurationSeconds)],
    ["Acoustic-only Sounding Segments", summary.acousticOnlySoundingSegments],
    ["ASR During Acoustic Silence Segments", summary.asrDuringSilenceSegments],
    ["Sounding/Silence Conflict Segments", summary.soundingSilenceConflictSegments],
    ["Sounding/Silence Conflict Duration", formatTimestamp(summary.soundingSilenceConflictSeconds)],
    ["Timeline Pending Review Segments", summary.timelinePendingReviewSegments],
    ...(pauseSegments
      ? [
          ["Pause Segments JSON", pauseSegments.path],
          ["Silent Pause Threshold", pauseSegments.summary.silent_pause_threshold_seconds ?? ""],
          ["Pause Count", pauseSegments.summary.pause_count ?? pauseSegments.pauses.length],
          ["Total Pause Duration", formatTimestamp(pauseSegments.summary.total_pause_duration_seconds ?? 0)],
          ["Word Alignment Present", String(Boolean(pauseSegments.summary.word_alignment_present))],
          ["Needs Word Alignment", pauseSegments.summary.needs_word_alignment_count ?? ""],
          ["Needs Clause Boundary", pauseSegments.summary.needs_clause_boundary_count ?? ""],
        ]
      : []),
    ["Utterances", summary.utterances],
    ["Pending Review", summary.pending],
    ["Confirmed", summary.confirmed],
    ["Fixed", summary.fixed],
    ["Excluded", summary.excluded],
    ["Auto OK", summary.autoOk],
    ["Included In Research", summary.included],
    [],
    ["Review State", "Count"],
    ...stateRows,
    [],
    ["Speaker", "Utterance Count"],
    ...speakerRows,
  ];
  summarySheet.getRange(`A1:B${summaryMatrix.length}`).values = summaryMatrix;

  mkdirSync(dirname(outputPath), { recursive: true });
  const output = await SpreadsheetFile.exportXlsx(workbook);
  await output.save(outputPath);

  return workbook;
}

async function main() {
  const args = parseArgs(process.argv);
  const inputPath = resolve(args.input);
  if (!existsSync(inputPath)) throw new Error(`Input TextGrid does not exist: ${inputPath}`);

  const text = readFileSync(inputPath, "utf8");
  const tiers = parseTextGrid(text);
  const assemblyAiWords = readAssemblyAiWords(args.assemblyaiJson);
  const pauseSegments = readPauseSegments(args.pauseSegmentsJson);
  const rows = rowsFromTextGrid(tiers, inputPath);
  const timelineRows = timelineRowsFromTextGrid(tiers, inputPath, assemblyAiWords, {
    reviewed: args.reviewed,
  });
  validateExportRows(rows, timelineRows);
  const summary = summarizeRows(rows, timelineRows);
  summary.timelineRows = timelineRows;
  const outputPath = outputPathFor(inputPath, args);

  const workbook = await buildWorkbook(
    rows,
    summary,
    {
      sourceTextGrid: inputPath,
      generatedAt: new Date().toISOString(),
    },
    outputPath,
    pauseSegments,
  );

  const timelinePreview = await workbook.inspect({
    kind: "table",
    range: "Timeline!A1:S14",
    include: "values",
    tableMaxRows: 14,
    tableMaxCols: 19,
  });
  console.log(timelinePreview.ndjson);

  const preview = await workbook.inspect({
    kind: "table",
    range: "Summary!A1:B20",
    include: "values",
    tableMaxRows: 24,
    tableMaxCols: 4,
  });
  console.log(preview.ndjson);

  const errorScan = await workbook.inspect({
    kind: "match",
    searchTerm: "#REF!|#DIV/0!|#VALUE!|#NAME\\?|#N/A",
    options: { useRegex: true, maxResults: 100 },
    summary: "formula error scan",
  });
  console.log(errorScan.ndjson);

  await workbook.render({ sheetName: "Summary", range: "A1:B24", scale: 2 });
  await workbook.render({ sheetName: "Timeline", range: "A1:S20", scale: 1 });

  console.log(`Wrote Excel: ${outputPath}`);
  console.log(
    JSON.stringify(
      {
        timeline_segments: summary.timelineSegments,
        sounding_segments: summary.soundingSegments,
        silence_segments: summary.silenceSegments,
        acoustic_only_sounding_segments: summary.acousticOnlySoundingSegments,
        asr_during_acoustic_silence_segments: summary.asrDuringSilenceSegments,
        sounding_silence_conflict_segments: summary.soundingSilenceConflictSegments,
        sounding_silence_conflict_seconds: summary.soundingSilenceConflictSeconds,
        timeline_pending_review_segments: summary.timelinePendingReviewSegments,
        utterances: summary.utterances,
        pending: summary.pending,
        confirmed: summary.confirmed,
        fixed: summary.fixed,
        excluded: summary.excluded,
        auto_ok: summary.autoOk,
        included_in_research: summary.included,
      },
      null,
      2,
    ),
  );
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
