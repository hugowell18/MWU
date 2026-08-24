#!/usr/bin/env node

import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { splitTranscript } from "../validation-sprint/lib/transcript-split.mjs";
import {
  buildAsrTimingFallback,
  buildAsUnitCandidates,
  buildDefinitionPack,
  buildFeatureTables,
  buildMetadata,
  buildPauseRows,
  buildPseudoGoldReference,
  buildReferenceCentricTiming,
  buildTransitionEvidence,
  buildUnresolvedItems,
  compareWordTimings,
  findMwuOccurrences,
  hashFile,
  normalizeAlignmentPayload,
  rowsToCsv,
  validateReviewedTextGrid,
} from "./feasibility-core.mjs";
import { buildTimedRawTranscript, buildVerifiedTranscriptReference } from "./verified-transcript.mjs";

const RECORDING_ID = "Multilogue04_C_Level30_D1G4";
const DEFAULTS = {
  recordingId: RECORDING_ID,
  audio: "sample/Multilogue04_C_Level30 D1G4.wav",
  goldTextGrid: "outputs/multilogue-v2-poc/Multilogue04_C_Level30_D1G4_P025_corrected_6tier.TextGrid",
  assemblyJson:
    "outputs/multilogue-validation/Multilogue04_C_Level30_D1G4/assemblyai/Multilogue04_C_Level30_D1G4.16k_mono.assemblyai.raw.json",
  transcript: "sample-inputs/Golden/Multilogue04_C_Level30_D1G4_Transcript.txt",
  annotationGuide:
    "sample-inputs/Golden/Multi-Word Unit (MWU) Project- Verbatim Transcription & Acoustic Annotation Guide.docx",
  providerMapping:
    "outputs/multilogue-validation/sessions/Multilogue04_C_Level30_D1G4-1787382481013-2798df/L1a/revisions/review-v0006/outputs/internal_evidence/path-b/provider-mapping.json",
  l1aHandoff:
    "outputs/multilogue-validation/sessions/Multilogue04_C_Level30_D1G4-1787382481013-2798df/L1a/revisions/review-v0006/outputs/phase2_handoff_manifest.json",
  outputRoot: "outputs/layer2-feasibility",
  runId: `${RECORDING_ID}-l2-feasibility-v1`,
  mfaBin: "/Users/nedved/Tool/Workspace/LDTWeb/Ldtwebdemo/.mfa-env/bin/mfa",
  dictionary: "/Users/nedved/Tool/Workspace/LDTWeb/Ldtwebdemo/.mfa-data/pretrained_models/dictionary/english_us_mfa.dict",
  acousticModel: "/Users/nedved/Tool/Workspace/LDTWeb/Ldtwebdemo/.mfa-data/pretrained_models/acoustic/english_mfa.zip",
};

function parseArgs(argv) {
  const args = { ...DEFAULTS, skipMfa: false, requireMfa: false, mfaAudioMode: "room_mix", mfaMaxSegmentSec: 15 };
  const fields = new Map([
    ["--recording-id", "recordingId"],
    ["--audio", "audio"],
    ["--gold-textgrid", "goldTextGrid"],
    ["--assembly-json", "assemblyJson"],
    ["--transcript", "transcript"],
    ["--annotation-guide", "annotationGuide"],
    ["--provider-mapping", "providerMapping"],
    ["--l1a-handoff", "l1aHandoff"],
    ["--output-root", "outputRoot"],
    ["--run-id", "runId"],
    ["--mfa-bin", "mfaBin"],
    ["--dictionary", "dictionary"],
    ["--acoustic-model", "acousticModel"],
    ["--mfa-audio-mode", "mfaAudioMode"],
    ["--mfa-max-segment-sec", "mfaMaxSegmentSec"],
  ]);
  for (let index = 2; index < argv.length; index += 1) {
    const arg = argv[index];
    if (fields.has(arg) && argv[index + 1]) {
      args[fields.get(arg)] = argv[index + 1];
      index += 1;
    } else if (arg === "--skip-mfa") args.skipMfa = true;
    else if (arg === "--require-mfa") args.requireMfa = true;
    else if (arg === "--help" || arg === "-h") {
      console.log(`Usage: node scripts/l2/run-feasibility.mjs [options]

  --audio <path>              Original room-mix WAV
  --gold-textgrid <path>      Researcher-corrected dynamic N+3 TextGrid
  --assembly-json <path>      AssemblyAI JSON used only as generated timing support
  --transcript <path>         Researcher-verified S1-SN transcript TXT
  --annotation-guide <path>   Customer annotation conventions DOCX/PDF
  --provider-mapping <path>   AssemblyAI speaker to canonical S1-SN mapping
  --l1a-handoff <path>        Accepted L1a handoff manifest
  --output-root <path>        Output root
  --run-id <id>               Session-specific feasibility run ID
  --mfa-bin <path>            MFA executable
  --dictionary <path>         MFA dictionary
  --acoustic-model <path>     MFA acoustic model
  --mfa-audio-mode <mode>     room_mix (default) or muted_mirror
  --mfa-max-segment-sec <n>   Maximum MFA segment duration (default: 15)
  --skip-mfa                  Use AssemblyAI word timestamps as explicit fallback
  --require-mfa               Fail instead of falling back when MFA cannot run
`);
      process.exit(0);
    } else throw new Error(`Unknown or incomplete argument: ${arg}`);
  }
  args.mfaMaxSegmentSec = Number(args.mfaMaxSegmentSec);
  if (!["room_mix", "muted_mirror"].includes(args.mfaAudioMode)) {
    throw new Error("--mfa-audio-mode must be room_mix or muted_mirror");
  }
  if (!Number.isFinite(args.mfaMaxSegmentSec) || args.mfaMaxSegmentSec <= 0) {
    throw new Error("--mfa-max-segment-sec must be a positive number");
  }
  return args;
}

function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function writeText(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, value);
}

function runCommand(label, command, commandArgs, cwd, logPath) {
  const startedAt = new Date().toISOString();
  const result = spawnSync(command, commandArgs, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  const record = {
    label,
    command: [command, ...commandArgs],
    started_at: startedAt,
    completed_at: new Date().toISOString(),
    status: result.status ?? 1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
  writeJson(logPath, record);
  return record;
}

function sha256Text(value) {
  return createHash("sha256").update(value).digest("hex");
}

function chunkUtterance(utterance, maxSegmentSec) {
  const words = utterance.words ?? [];
  if (!words.length || utterance.duration_sec <= maxSegmentSec) return [words];
  const chunks = [];
  let current = [];
  for (const word of words) {
    if (current.length && word.end_sec - current[0].start_sec > maxSegmentSec) {
      chunks.push(current);
      current = [];
    }
    current.push(word);
  }
  if (current.length) chunks.push(current);
  return chunks;
}

function buildMfaUnits(reference, handoff, audioMode, maxSegmentSec) {
  const audioBySpeaker = new Map(
    (handoff.inputs ?? []).map((input) => [String(input.speaker ?? "").replace(/^speaker_/, ""), input.wav]),
  );
  const units = [];
  for (const utterance of reference.utterances) {
    const chunks = chunkUtterance(utterance, maxSegmentSec);
    chunks.forEach((words, index) => {
      const previous = index > 0 ? chunks[index - 1].at(-1) : null;
      const next = index + 1 < chunks.length ? chunks[index + 1][0] : null;
      const startSec = previous ? (previous.end_sec + words[0].start_sec) / 2 : utterance.start_sec;
      const endSec = next ? (words.at(-1).end_sec + next.start_sec) / 2 : utterance.end_sec;
      units.push({
        utt_id: chunks.length === 1 ? utterance.utt_id : `${utterance.utt_id}_C${String(index + 1).padStart(2, "0")}`,
        parent_utt_id: utterance.utt_id,
        speaker: utterance.speaker,
        start_sec: startSec,
        end_sec: endSec,
        duration_sec: endSec - startSec,
        text: words.map((word) => word.text).join(" "),
        audio_path: audioMode === "muted_mirror" ? audioBySpeaker.get(utterance.speaker) ?? "" : "",
        flags: chunks.length > 1 ? ["segmented_for_mfa"] : [],
        alignment_allowed: Boolean(words.length && endSec - startSec >= 0.2),
      });
    });
  }
  return {
    schema_version: "l2-feasibility-mfa-units-v1",
    source_status: reference.status,
    audio_mode: audioMode,
    max_segment_seconds: maxSegmentSec,
    units,
  };
}

function escapeTextGrid(value) {
  return String(value ?? "").replaceAll('"', '""');
}

function contiguousWordTier(words, duration) {
  const intervals = [];
  let cursor = 0;
  for (const word of [...words].sort((a, b) => a.start_sec - b.start_sec)) {
    const start = Math.max(cursor, Math.max(0, word.start_sec));
    const end = Math.min(duration, word.end_sec);
    if (start > cursor) intervals.push({ start: cursor, end: start, text: "" });
    if (end > start) intervals.push({ start, end, text: word.text });
    cursor = Math.max(cursor, end);
  }
  if (cursor < duration) intervals.push({ start: cursor, end: duration, text: "" });
  return intervals;
}

function writeFallbackTextGrid(path, speakers, words, duration) {
  const tiers = speakers.map((speaker) => ({
    name: `${speaker}_assemblyai_words`,
    intervals: contiguousWordTier(words.filter((word) => word.speaker === speaker), duration),
  }));
  const lines = [
    'File type = "ooTextFile"',
    'Object class = "TextGrid"',
    "",
    "xmin = 0",
    `xmax = ${duration}`,
    "tiers? <exists>",
    `size = ${tiers.length}`,
    "item []:",
  ];
  tiers.forEach((tier, tierIndex) => {
    lines.push(`    item [${tierIndex + 1}]:`);
    lines.push('        class = "IntervalTier"');
    lines.push(`        name = "${tier.name}"`);
    lines.push("        xmin = 0");
    lines.push(`        xmax = ${duration}`);
    lines.push(`        intervals: size = ${tier.intervals.length}`);
    tier.intervals.forEach((interval, intervalIndex) => {
      lines.push(`        intervals [${intervalIndex + 1}]:`);
      lines.push(`            xmin = ${interval.start}`);
      lines.push(`            xmax = ${interval.end}`);
      lines.push(`            text = "${escapeTextGrid(interval.text)}"`);
    });
  });
  writeText(path, `${lines.join("\n")}\n`);
}

function listFiles(root) {
  const files = [];
  function visit(dir) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) visit(path);
      else files.push(path);
    }
  }
  if (existsSync(root)) visit(root);
  return files.sort();
}

function htmlEscape(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function buildHtmlReport(report, speakerRows, unresolved) {
  const metrics = speakerRows
    .map(
      (row) => `<tr><td>${htmlEscape(row.speaker)}</td><td>${row.word_count}</td><td>${row.own_pause_count}</td><td>${row.active_vocal_duration_sec}</td><td>${row.articulation_rate_words_per_sec ?? "NA"}</td><td>${row.mwu_occurrence_count}</td></tr>`,
    )
    .join("");
  const issues = unresolved
    .map((item) => `<tr><td>${item.item_id}</td><td>${htmlEscape(item.module)}</td><td>${htmlEscape(item.status)}</td><td>${htmlEscape(item.reason)}</td></tr>`)
    .join("");
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Layer 2 Calibration Draft</title><style>
:root{font-family:Inter,Arial,sans-serif;color:#172033;background:#f5f7fb}body{margin:0;padding:32px}.wrap{max-width:1160px;margin:auto}.top{border-top:4px solid #275fd6;background:white;padding:28px;border-bottom:1px solid #d9e0ec}.eyebrow{color:#275fd6;font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:0}h1{font-size:30px;margin:8px 0}p{color:#5d6c86;line-height:1.55}.grid{display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin:18px 0}.metric,.section{background:white;border:1px solid #d9e0ec;border-radius:6px}.metric{padding:16px}.metric b{display:block;font-size:22px}.metric span{font-size:12px;color:#6d7a91}.section{margin-top:16px;padding:20px}table{width:100%;border-collapse:collapse;font-size:13px}th,td{text-align:left;border-bottom:1px solid #e6ebf3;padding:10px}th{color:#5d6c86}.pass{color:#137a45}.warn{color:#a45b06}.badge{display:inline-block;padding:4px 8px;border-radius:4px;background:#e9f0ff;color:#275fd6;font-size:12px;font-weight:700}@media(max-width:760px){body{padding:12px}.grid{grid-template-columns:1fr 1fr}.section{overflow:auto}}
</style></head><body><main class="wrap"><section class="top"><span class="badge">1 of 10 · Engineering calibration draft</span><div class="eyebrow">${htmlEscape(report.run_id)}</div><h1>Layer 2 calibration result</h1><p>This run combines the researcher-corrected P025 TextGrid with the researcher-verified transcript. Word alignment is generated; AS-unit, clause, MWU and external lexical-tool definitions remain provisional or pending.</p></section>
  <div class="grid"><div class="metric"><b class="${report.technical_status === "passed" ? "pass" : "warn"}">${htmlEscape(report.technical_status)}</b><span>technical execution</span></div><div class="metric"><b>${report.speaker_count}</b><span>canonical speakers</span></div><div class="metric"><b>${report.analysis_word_count}</b><span>reference transcript words</span></div><div class="metric"><b>${Math.round(report.analysis_timing.mfa_support_ratio * 10000) / 100}%</b><span>timing coverage, not accuracy</span></div></div>
  <section class="section"><h2>Timing evidence</h2><p><b>${report.analysis_timing.mfa_supported_word_count}</b> words use generated MFA timing; <b>${report.analysis_timing.assemblyai_fallback_word_count}</b> unmatched words retain explicit AssemblyAI fallback timing. MFA segment QC remains open: <b>${report.alignment_review_gate.mfa_ok_utterance_count}</b> passed, <b>${report.alignment_review_gate.mfa_needs_review_utterance_count}</b> need review and <b>${report.alignment_review_gate.mfa_missing_alignment_utterance_count}</b> are missing. <b>${report.alignment_review_gate.mfa_needs_review_word_count}</b> MFA-timed words sit inside review segments.</p></section>
  <section class="section"><h2>Acoustic evidence</h2><p>The Gold TextGrid contains <b>${report.all_own_pause_count}</b> researcher-labelled own pauses; <b>${report.pause_count}</b> meet P025. All <b>${report.transition_evidence.point_count}</b> transition/FTO points are retained, including overlap cases where the offset is explicitly not measured.</p></section>
<section class="section"><h2>Speaker feature preview</h2><table><thead><tr><th>Speaker</th><th>Words</th><th>Own pauses</th><th>Vocal seconds</th><th>Words/sec</th><th>MWUs</th></tr></thead><tbody>${metrics}</tbody></table></section>
<section class="section"><h2>Research limits</h2><table><thead><tr><th>ID</th><th>Module</th><th>Status</th><th>Reason</th></tr></thead><tbody>${issues}</tbody></table></section>
</main></body></html>`;
}

function main() {
  const args = parseArgs(process.argv);
  const repoRoot = resolve(".");
  const paths = Object.fromEntries(
    ["audio", "goldTextGrid", "assemblyJson", "transcript", "annotationGuide", "providerMapping", "l1aHandoff", "mfaBin", "dictionary", "acousticModel"].map((key) => [
      key,
      resolve(args[key]),
    ]),
  );
  for (const key of ["audio", "goldTextGrid", "assemblyJson", "transcript", "annotationGuide", "providerMapping", "l1aHandoff"]) {
    if (!existsSync(paths[key])) throw new Error(`Missing ${key}: ${paths[key]}`);
  }

  const runDir = resolve(args.outputRoot, args.runId);
  const inputsDir = join(runDir, "inputs");
  const workDir = join(runDir, "work");
  const outputsDir = join(runDir, "outputs");
  const reportsDir = join(runDir, "reports");
  for (const dir of [inputsDir, workDir, outputsDir, reportsDir]) mkdirSync(dir, { recursive: true });

  const handoff = JSON.parse(readFileSync(paths.l1aHandoff, "utf8"));
  const expectedDuration = Number(handoff.duration_seconds ?? handoff.canonical_clock?.duration_seconds);
  const goldText = readFileSync(paths.goldTextGrid, "utf8");
  const contract = validateReviewedTextGrid(goldText, expectedDuration);
  if (contract.errors.length) throw new Error(`Reviewed TextGrid contract failed: ${contract.errors.join("; ")}`);

  const assembly = JSON.parse(readFileSync(paths.assemblyJson, "utf8"));
  const mappingDocument = JSON.parse(readFileSync(paths.providerMapping, "utf8"));
  const providerMapping = mappingDocument.mapping?.assemblyai ?? mappingDocument.assemblyai ?? {};
  const asrReference = buildPseudoGoldReference(assembly, providerMapping);
  const verifiedTranscriptText = readFileSync(paths.transcript, "utf8");
  const reference = buildVerifiedTranscriptReference({
    transcriptText: verifiedTranscriptText,
    asrReference,
    participantSpeakers: contract.speakers,
    durationSeconds: contract.duration_seconds,
    acousticTiers: contract.tiers,
  });
  if (reference.speakers.join("|") !== contract.speakers.join("|")) {
    throw new Error(`Transcript speakers ${reference.speakers} do not match reviewed TextGrid ${contract.speakers}`);
  }

  const referenceTranscriptPath = join(inputsDir, `${args.recordingId}.researcher-verified.txt`);
  writeText(referenceTranscriptPath, verifiedTranscriptText.endsWith("\n") ? verifiedTranscriptText : `${verifiedTranscriptText}\n`);
  writeText(join(inputsDir, `${args.recordingId}.participant-transcript.txt`), reference.participant_transcript_text);
  writeText(join(inputsDir, `${args.recordingId}.excluded-transcript.txt`), reference.excluded_transcript_text);
  writeJson(join(inputsDir, "reference_timing.json"), {
    status: reference.status,
    transcript_status: reference.transcript_status,
    transcript_accuracy_claim: true,
    timing_accuracy_claim: false,
    provider_confidence: reference.provider_confidence,
    speakers: reference.speakers,
    utterances: reference.utterances,
    timing_seed_summary: reference.timing_seed_summary,
  });
  writeText(join(inputsDir, "transcript_turns.csv"), rowsToCsv(reference.transcript_parse.turns.map((turn) => ({
    turn_id: turn.turn_id,
    speaker: turn.speaker,
    text: turn.text,
    annotation_tags: turn.annotation_tags,
    is_backchannel: turn.is_backchannel,
    is_excluded: turn.is_excluded,
    canonical_participant: turn.canonical_participant,
    lexical_token_count: turn.lexical_tokens.length,
  }))));
  writeJson(join(inputsDir, "transcript_annotation_validation.json"), reference.transcript_parse);

  const definitions = buildDefinitionPack({ customerGuide: true });
  writeJson(join(inputsDir, "definition_pack.provisional.json"), definitions);
  const metadata = buildMetadata({
    recordingId: args.recordingId,
    durationSeconds: contract.duration_seconds,
    speakers: contract.speakers,
    audioHash: hashFile(paths.audio),
    textGridHash: hashFile(paths.goldTextGrid),
    transcriptHash: hashFile(referenceTranscriptPath),
  });
  writeJson(join(inputsDir, "recording_metadata.provisional.json"), metadata);
  writeText(join(inputsDir, "participants.provisional.csv"), rowsToCsv(metadata.participants));

  const inputManifest = {
    schema_version: "l2-provisional-input-manifest-v1",
    run_id: args.runId,
    recording_id: args.recordingId,
    source_audio: { path: paths.audio, sha256: hashFile(paths.audio), status: "real_source" },
    accepted_l1a_handoff: { path: paths.l1aHandoff, sha256: hashFile(paths.l1aHandoff), status: handoff.status },
    reviewed_l1b_textgrid: {
      path: paths.goldTextGrid,
      sha256: hashFile(paths.goldTextGrid),
      status: "researcher_corrected_gold",
      threshold_seconds: 0.25,
    },
    transcript: {
      path: referenceTranscriptPath,
      sha256: hashFile(referenceTranscriptPath),
      status: "researcher_verified_gold",
      accuracy_claim: true,
      timing_embedded: false,
    },
    annotation_guide: {
      path: paths.annotationGuide,
      sha256: hashFile(paths.annotationGuide),
      status: "customer_supplied",
    },
    timing_support: {
      path: paths.assemblyJson,
      sha256: hashFile(paths.assemblyJson),
      status: "provider_generated_support_only",
      transcript_truth: false,
    },
    word_alignment: { status: "pending_generation", reviewed: false },
    metadata: { status: "provisional_pending_study_metadata" },
    definition_pack: {
      status: "customer_annotation_rules_plus_provisional_analysis_rules",
      research_approved: false,
    },
  };
  writeJson(join(inputsDir, "input_manifest.json"), inputManifest);

  const transcriptSplit = splitTranscript(reference.participant_transcript_text);
  const transcriptOutputDir = join(outputsDir, "transcript");
  for (const speaker of transcriptSplit.speakers) {
    writeText(join(transcriptOutputDir, `${speaker.name}_RAW-TIMING.txt`), buildTimedRawTranscript(reference, speaker.name));
    writeText(join(transcriptOutputDir, `${speaker.name}_TIDY-PHRASE.txt`), `${speaker.tidy}\n`);
  }
  writeJson(join(transcriptOutputDir, "transformation_log.json"), {
    source_status: "researcher_verified_gold",
    annotation_guide: paths.annotationGuide,
    excluded_turn_count: reference.transcript_parse.excluded_turns.length,
    speakers: transcriptSplit.speakers,
    report: transcriptSplit.report,
  });

  const alignmentOutputDir = join(outputsDir, "word-alignment");
  const alignmentJsonPath = join(alignmentOutputDir, "word_alignment.json");
  const alignmentTextGridPath = join(alignmentOutputDir, "word_alignment.TextGrid");
  mkdirSync(alignmentOutputDir, { recursive: true });
  let alignment = null;
  let alignmentSource = "assemblyai_timestamp_fallback";
  const mfaReady = !args.skipMfa && [paths.mfaBin, paths.dictionary, paths.acousticModel].every(existsSync);

  if (mfaReady) {
    const mfaUnitsPath = join(workDir, "mfa-units.json");
    const mfaCorpusDir = join(workDir, "mfa-corpus");
    const mfaOutputDir = join(workDir, "mfa-output");
    writeJson(mfaUnitsPath, buildMfaUnits(reference, handoff, args.mfaAudioMode, args.mfaMaxSegmentSec));
    const prepare = runCommand(
      "prepare-mfa-corpus",
      process.execPath,
      ["scripts/prepare-mfa-corpus.mjs", "--units", mfaUnitsPath, "--audio", paths.audio, "--output-dir", mfaCorpusDir],
      repoRoot,
      join(reportsDir, "prepare_mfa_corpus.log.json"),
    );
    let align = { status: 1 };
    let merge = { status: 1 };
    if (prepare.status === 0) {
      align = runCommand(
        "mfa-align",
        process.execPath,
        [
          "scripts/run-forced-alignment.mjs",
          "--corpus-dir",
          mfaCorpusDir,
          "--output-dir",
          mfaOutputDir,
          "--mfa-bin",
          paths.mfaBin,
          "--mfa-root-dir",
          join(workDir, "mfa-runtime"),
          "--cache-dir",
          join(workDir, "mfa-cache"),
          "--dictionary",
          paths.dictionary,
          "--acoustic-model",
          paths.acousticModel,
          "--num-jobs",
          "3",
          "--quiet",
        ],
        repoRoot,
        join(reportsDir, "mfa_alignment.log.json"),
      );
    }
    if (align.status === 0) {
      merge = runCommand(
        "merge-mfa-alignments",
        process.execPath,
        [
          "scripts/merge-mfa-word-alignments.mjs",
          "--manifest",
          join(mfaCorpusDir, "mfa-corpus-manifest.json"),
          "--mfa-output-dir",
          mfaOutputDir,
          "--output-json",
          alignmentJsonPath,
          "--output-textgrid",
          alignmentTextGridPath,
          "--timeline-end-seconds",
          String(contract.duration_seconds),
          "--min-silence-seconds",
          "0.25",
        ],
        repoRoot,
        join(reportsDir, "merge_mfa_alignment.log.json"),
      );
    }
    if (merge.status === 0 && existsSync(alignmentJsonPath)) {
      alignment = normalizeAlignmentPayload(JSON.parse(readFileSync(alignmentJsonPath, "utf8")), "mfa_generated_alignment");
      alignmentSource = "mfa_generated_alignment";
    } else if (args.requireMfa) {
      throw new Error("MFA was required but the alignment pipeline failed; inspect reports/*.log.json");
    }
  }

  if (!alignment) {
    alignment = buildAsrTimingFallback(reference, contract.duration_seconds);
    writeFallbackTextGrid(alignmentTextGridPath, contract.speakers, alignment.word_intervals, contract.duration_seconds);
  }
  writeJson(alignmentJsonPath, alignment);
  const alignmentComparison = compareWordTimings(reference.words, alignment.word_intervals);
  const analysisTiming =
    alignmentSource === "mfa_generated_alignment"
      ? buildReferenceCentricTiming(reference.words, alignment.word_intervals)
      : {
          schema_version: "l2-reference-centric-word-timing-v1",
          source_status: "assemblyai_timestamp_fallback",
          research_claim_ready: false,
          summary: {
            reference_word_count: reference.words.length,
            mfa_supported_word_count: 0,
            assemblyai_fallback_word_count: reference.words.length,
            mfa_support_ratio: 0,
            reviewed: false,
          },
          word_intervals: alignment.word_intervals,
        };
  const alignmentQc = alignment.summary?.alignment_qc ?? null;
  const mfaNeedsReviewWordCount = analysisTiming.word_intervals.filter(
    (word) => word.timing_source === "mfa" && word.alignment_confidence?.status === "needs_review",
  ).length;
  analysisTiming.summary.alignment_qc = alignmentQc;
  analysisTiming.summary.mfa_needs_review_word_count = mfaNeedsReviewWordCount;
  writeJson(join(alignmentOutputDir, "analysis_word_timing.json"), analysisTiming);
  writeText(join(alignmentOutputDir, "analysis_word_timing.csv"), rowsToCsv(analysisTiming.word_intervals));
  writeJson(join(alignmentOutputDir, "alignment_provenance.json"), {
    source_status: alignmentSource,
    reviewed: false,
    research_claim_ready: false,
    analysis_timing: analysisTiming.summary,
    comparison_to_assemblyai_reference: alignmentComparison,
  });
  writeText(join(alignmentOutputDir, "word_alignment.csv"), rowsToCsv(alignment.word_intervals));

  const asUnitRows = buildAsUnitCandidates(reference);
  const transitionRows = buildTransitionEvidence(contract);
  const occurrences = findMwuOccurrences(analysisTiming.word_intervals, definitions.mwu_targets);
  const pauseRows = buildPauseRows(contract, analysisTiming.word_intervals, occurrences, 0.25);
  const allOwnPauseCount = contract.tiers
    .filter((tier) => contract.speakers.includes(tier.name))
    .flatMap((tier) => tier.intervals)
    .filter((interval) => String(interval.text ?? "").trim() === "op").length;
  const featureTables = buildFeatureTables(contract, analysisTiming.word_intervals, occurrences, pauseRows, {
    transcriptSource: "researcher_verified_txt",
    definitionStatus: "customer_annotation_rules_plus_provisional_analysis_rules",
  });
  const unresolved = buildUnresolvedItems({
    alignmentSource,
    alignmentSummary: analysisTiming.summary,
    pauseRows,
    asUnitRows,
    transcriptStatus: reference.transcript_status,
  });
  const featuresDir = join(outputsDir, "features");
  writeText(join(featuresDir, "as_unit_candidates.csv"), rowsToCsv(asUnitRows));
  writeText(join(featuresDir, "pause_location_candidates.csv"), rowsToCsv(pauseRows));
  writeText(join(featuresDir, "mwu_occurrences.csv"), rowsToCsv(occurrences));
  writeText(join(featuresDir, "speaker_fluency_features.csv"), rowsToCsv(featureTables.speakerRows));
  writeText(join(featuresDir, "lexical_features.csv"), rowsToCsv(featureTables.lexicalRows));
  writeText(join(featuresDir, "repair_features.csv"), rowsToCsv(featureTables.repairRows));
  writeText(join(featuresDir, "unresolved_items.csv"), rowsToCsv(unresolved));
  const acousticOutputDir = join(outputsDir, "acoustic");
  writeText(join(acousticOutputDir, "p025_qualifying_own_pauses.csv"), rowsToCsv(pauseRows));
  writeText(join(acousticOutputDir, "transition_fto_evidence.csv"), rowsToCsv(transitionRows));
  writeJson(join(acousticOutputDir, "transition_fto_evidence.json"), {
    schema_version: "mwu-l2-transition-evidence-v1",
    source: paths.goldTextGrid,
    path_b: true,
    research_claim_ready: false,
    transition_count: transitionRows.length,
    measured_fto_count: transitionRows.filter((row) => row.offset_measured).length,
    overlap_offset_not_measured_count: transitionRows.filter((row) => row.overlap_present && !row.offset_measured).length,
    rows: transitionRows,
  });

  const earlyHandoff = featureTables.speakerRows.map((speakerRow) => ({
    recording_id: args.recordingId,
    threshold_sec: 0.25,
    participant_id: metadata.participants.find((participant) => participant.canonical_speaker === speakerRow.speaker)?.participant_id,
    ...speakerRow,
    alignment_source: analysisTiming.source_status,
    mfa_audio_mode: args.mfaAudioMode,
    mfa_max_segment_seconds: args.mfaMaxSegmentSec,
    alignment_reviewed: false,
    textgrid_status: "researcher_corrected_gold",
    unresolved_item_count: unresolved.length,
    l3_release_ready: false,
  }));
  writeText(join(outputsDir, "handoff", "early_phase_v_merge.csv"), rowsToCsv(earlyHandoff));

  const timingOutOfBounds = analysisTiming.word_intervals.filter(
    (word) => word.start_sec < 0 || word.end_sec > contract.duration_seconds + 0.001 || word.end_sec <= word.start_sec,
  );
  const executionChecks = [
    { id: "L2F-001", name: "reviewed TextGrid dynamic N+3 contract", pass: contract.errors.length === 0 },
    { id: "L2F-002", name: "researcher-verified transcript speaker mapping", pass: reference.speakers.join("|") === contract.speakers.join("|") },
    { id: "L2F-003", name: "RAW/TIDY generated for every speaker", pass: transcriptSplit.speakers.length === contract.speaker_count },
    { id: "L2F-004", name: "generated word alignment produced", pass: alignment.word_intervals.length > 0 },
    { id: "L2F-005", name: "word timestamps inside canonical clock", pass: timingOutOfBounds.length === 0 },
    { id: "L2F-006", name: "speaker feature rows complete", pass: featureTables.speakerRows.length === contract.speaker_count },
    { id: "L2F-007", name: "research limitations remain explicit", pass: unresolved.length >= 5 },
    {
      id: "L2F-008",
      name: "TextTier transition evidence retained",
      pass: transitionRows.length === contract.transition_point_count && transitionRows.every((row) => row.parse_status === "parsed"),
      observed: transitionRows.length,
      expected: contract.transition_point_count,
    },
  ];
  const alignmentChecks = [
    {
      id: "L2F-009",
      name: "MFA supports at least 95% of reference transcript words",
      pass: analysisTiming.summary.mfa_support_ratio >= 0.95,
      observed: analysisTiming.summary.mfa_support_ratio,
      threshold: 0.95,
    },
  ];
  const alignmentReviewGate = {
    status:
      analysisTiming.summary.assemblyai_fallback_word_count > 0 ||
      mfaNeedsReviewWordCount > 0 ||
      Number(alignmentQc?.missing_alignment_utterance_count ?? 0) > 0
        ? "open"
        : "closed",
    mfa_ok_utterance_count: Number(alignmentQc?.ok_utterance_count ?? 0),
    mfa_needs_review_utterance_count: Number(alignmentQc?.needs_review_utterance_count ?? 0),
    mfa_missing_alignment_utterance_count: Number(alignmentQc?.missing_alignment_utterance_count ?? 0),
    mfa_flagged_word_count: Number(alignmentQc?.flagged_word_count ?? 0),
    mfa_needs_review_word_count: mfaNeedsReviewWordCount,
    assemblyai_fallback_word_count: analysisTiming.summary.assemblyai_fallback_word_count,
  };
  const executionPassed = executionChecks.every((check) => check.pass);
  const technicalStatus = !executionPassed
    ? "failed"
    : alignmentChecks.every((check) => check.pass) && alignmentReviewGate.status === "closed"
      ? "passed"
      : "passed_with_alignment_review_required";
  const report = {
    schema_version: "l2-provisional-report-v1",
    generated_at: new Date().toISOString(),
    run_id: args.runId,
    recording_id: args.recordingId,
    technical_status: technicalStatus,
    research_status: "not_ready_client_definitions_and_review_required",
    research_claim_ready: false,
    speaker_count: contract.speaker_count,
    analysis_word_count: analysisTiming.word_intervals.length,
    mfa_output_word_count: alignment.word_intervals.length,
    utterance_count: reference.utterances.length,
    pause_count: pauseRows.length,
    all_own_pause_count: allOwnPauseCount,
    mwu_occurrence_count: occurrences.length,
    transition_evidence: {
      point_count: transitionRows.length,
      measured_fto_count: transitionRows.filter((row) => row.offset_measured).length,
      overlap_offset_not_measured_count: transitionRows.filter((row) => row.overlap_present && !row.offset_measured).length,
      research_claim_ready: false,
    },
    alignment_source: alignmentSource,
    mfa_audio_mode: args.mfaAudioMode,
    mfa_max_segment_seconds: args.mfaMaxSegmentSec,
    analysis_timing_source: analysisTiming.source_status,
    analysis_timing: analysisTiming.summary,
    textgrid_contract: {
      status: contract.status,
      tier_count: contract.tier_count,
      expected_dynamic_tier_count: contract.expected_dynamic_tier_count,
      warnings: contract.warnings,
    },
    transcript: {
      status: reference.transcript_status,
      timing_seed_status: reference.status,
      timing_seed_summary: reference.timing_seed_summary,
      provider_confidence: reference.provider_confidence,
      accuracy_claim: true,
      timing_accuracy_claim: false,
    },
    alignment_comparison: alignmentComparison,
    alignment_review_gate: alignmentReviewGate,
    technical_checks: [...executionChecks, ...alignmentChecks],
    unresolved_items: unresolved,
    interpretation:
      "The customer transcript and P025 TextGrid are accepted Gold inputs. AS-unit, clause, MWU, aggregate repair, syllable and external lexical-tool values remain provisional or pending until the research definitions are supplied.",
  };
  writeJson(join(reportsDir, "validation_report.json"), report);
  writeText(join(reportsDir, "Layer2_Provisional_Report.html"), buildHtmlReport(report, featureTables.speakerRows, unresolved));
  writeText(
    join(reportsDir, "validation_report.md"),
    `# Layer 2 calibration draft\n\n- Technical status: **${technicalStatus}**\n- Research claim ready: **no**\n- Transcript source: **researcher-verified TXT**\n- Alignment source: **${alignmentSource}**\n- Speakers: **${contract.speaker_count}**\n- Reference transcript words: **${analysisTiming.word_intervals.length}**\n- MFA-supported words: **${analysisTiming.summary.mfa_supported_word_count} (${(analysisTiming.summary.mfa_support_ratio * 100).toFixed(2)}% coverage, not accuracy)**\n- MFA utterances: **${alignmentReviewGate.mfa_ok_utterance_count} OK / ${alignmentReviewGate.mfa_needs_review_utterance_count} review / ${alignmentReviewGate.mfa_missing_alignment_utterance_count} missing**\n- MFA-timed words in review segments: **${alignmentReviewGate.mfa_needs_review_word_count}**\n- Explicit AssemblyAI timing fallback words: **${analysisTiming.summary.assemblyai_fallback_word_count}**\n- Researcher-labelled own pauses: **${allOwnPauseCount} total; ${pauseRows.length} meet P025**\n- Transition/FTO points retained: **${transitionRows.length}**\n- Provisional MWU matches: **${occurrences.length}**\n\nThe Gold transcript and P025 TextGrid drive this engineering calibration run. Word timing remains generated. AS-unit, clause, MWU, repair-total, syllable and external lexical-tool definitions still require research approval.\n`,
  );

  inputManifest.word_alignment = {
    status: analysisTiming.source_status,
    reviewed: false,
    research_claim_ready: false,
    ...analysisTiming.summary,
  };
  writeJson(join(inputsDir, "input_manifest.json"), inputManifest);

  const manifestFiles = listFiles(runDir).filter((path) => !path.startsWith(`${workDir}/`) && basename(path) !== "artifact_manifest.json");
  const artifactManifest = {
    schema_version: "l2-feasibility-artifact-manifest-v1",
    run_id: args.runId,
    generated_at: new Date().toISOString(),
    confidential_research_data: true,
    files: manifestFiles.map((path) => ({
      path: relative(runDir, path),
      bytes: statSync(path).size,
      sha256: hashFile(path),
    })),
  };
  writeJson(join(runDir, "artifact_manifest.json"), artifactManifest);

  console.log(
    JSON.stringify(
      {
        ok: technicalStatus !== "failed",
        run_dir: runDir,
        report: join(reportsDir, "validation_report.json"),
        html_report: join(reportsDir, "Layer2_Provisional_Report.html"),
        technical_status: technicalStatus,
        research_claim_ready: false,
        alignment_source: alignmentSource,
        speakers: contract.speaker_count,
        words: analysisTiming.word_intervals.length,
        mfa_supported_words: analysisTiming.summary.mfa_supported_word_count,
        assemblyai_fallback_words: analysisTiming.summary.assemblyai_fallback_word_count,
        pauses: pauseRows.length,
        total_own_pauses: allOwnPauseCount,
        transition_points: transitionRows.length,
        mwu_occurrences: occurrences.length,
      },
      null,
      2,
    ),
  );
  if (technicalStatus === "failed") process.exitCode = 1;
}

main();
