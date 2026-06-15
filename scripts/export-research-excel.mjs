#!/usr/bin/env node

// WP2.5 — Research Excel export.
//
// Aggregates all Phase 2 outputs into a single multi-sheet .xlsx workbook:
//   Words     — word-level alignment + confidence (from Stage D / WP2.0)
//   Clauses   — clause segments (WP2.2)
//   Pauses    — pause locations (WP2.3; includes rates columns from WP2.1 summary)
//   Rates     — session + per-speaker + per-utterance fluency metrics (WP2.1)
//   Summary   — key stats from all sources + provenance log
//
// Uses exceljs (open-source) — no proprietary runtime dependency.
// All inputs are optional: missing files emit empty sheets with a note row.

import { createRequire } from "node:module";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import ExcelJS from "exceljs";

const DEFAULT_WORD_ALIGNMENT = "outputs/wp2.0/elllo/word_alignment.json";
const DEFAULT_RATE_METRICS = "outputs/wp2.1/elllo.rate_metrics.json";
const DEFAULT_CLAUSE_SEGMENTS = "outputs/wp2.2/elllo.clause_segments.json";
const DEFAULT_PAUSE_LOCATION = "outputs/wp2.3/elllo.pause_location.json";
const DEFAULT_OUTPUT_DIR = "outputs/wp2.5";

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const args = {
    wordAlignment: DEFAULT_WORD_ALIGNMENT,
    rateMetrics: DEFAULT_RATE_METRICS,
    clauseSegments: DEFAULT_CLAUSE_SEGMENTS,
    pauseLocation: DEFAULT_PAUSE_LOCATION,
    output: "",
    outputDir: DEFAULT_OUTPUT_DIR,
  };

  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === "--word-alignment-json" && next) { args.wordAlignment = next; i += 1; }
    else if (arg === "--rate-metrics-json" && next) { args.rateMetrics = next; i += 1; }
    else if (arg === "--clause-segments-json" && next) { args.clauseSegments = next; i += 1; }
    else if (arg === "--pause-location-json" && next) { args.pauseLocation = next; i += 1; }
    else if (arg === "--output" && next) { args.output = next; i += 1; }
    else if (arg === "--output-dir" && next) { args.outputDir = next; i += 1; }
    else if (arg === "--help" || arg === "-h") { printHelp(); process.exit(0); }
    else { throw new Error(`Unknown or incomplete argument: ${arg}`); }
  }
  return args;
}

function printHelp() {
  console.log(`Usage:
  node scripts/export-research-excel.mjs [options]

Options:
  --word-alignment-json <path>   WP2.0 word_alignment.json. Default: ${DEFAULT_WORD_ALIGNMENT}
  --rate-metrics-json <path>     WP2.1 rate_metrics.json. Default: ${DEFAULT_RATE_METRICS}
  --clause-segments-json <path>  WP2.2 clause_segments.json. Default: ${DEFAULT_CLAUSE_SEGMENTS}
  --pause-location-json <path>   WP2.3 pause_location.json. Default: ${DEFAULT_PAUSE_LOCATION}
  --output <path>                Output .xlsx path.
  --output-dir <path>            Output dir if --output omitted. Default: ${DEFAULT_OUTPUT_DIR}
`);
}

// ---------------------------------------------------------------------------
// JSON loaders (all optional — missing file → null + warning)
// ---------------------------------------------------------------------------

function tryReadJson(path, label) {
  const resolved = resolve(path);
  if (!existsSync(resolved)) {
    console.warn(`[WP2.5] ${label} not found (${resolved}); sheet will be empty.`);
    return null;
  }
  return JSON.parse(readFileSync(resolved, "utf8"));
}

// ---------------------------------------------------------------------------
// ExcelJS helpers
// ---------------------------------------------------------------------------

const HEADER_FILL = { type: "pattern", pattern: "solid", fgColor: { argb: "FF4472C4" } };
const HEADER_FONT = { bold: true, color: { argb: "FFFFFFFF" }, size: 10 };
const NOTE_FILL   = { type: "pattern", pattern: "solid", fgColor: { argb: "FFFFF2CC" } };
const ALT_FILL    = { type: "pattern", pattern: "solid", fgColor: { argb: "FFE9EFF8" } };
const BORDER_THIN = { style: "thin", color: { argb: "FFBFBFBF" } };
const CELL_BORDER = { top: BORDER_THIN, left: BORDER_THIN, bottom: BORDER_THIN, right: BORDER_THIN };

function styleHeader(row) {
  row.eachCell((cell) => {
    cell.fill = HEADER_FILL;
    cell.font = HEADER_FONT;
    cell.border = CELL_BORDER;
    cell.alignment = { vertical: "middle", wrapText: false };
  });
  row.height = 18;
}

function styleDataRow(row, index) {
  if (index % 2 === 0) {
    row.eachCell((cell) => { cell.fill = ALT_FILL; });
  }
  row.eachCell((cell) => { cell.border = CELL_BORDER; });
}

function addSheet(wb, name, headers, dataRows, { colWidths, numberCols = [], freezeRow = 1 } = {}) {
  const ws = wb.addWorksheet(name, { views: [{ state: "frozen", ySplit: freezeRow }] });

  // Header row
  const headerRow = ws.addRow(headers);
  styleHeader(headerRow);
  ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: headers.length } };

  if (dataRows.length === 0) {
    const noteRow = ws.addRow(["(no data)"]);
    noteRow.getCell(1).fill = NOTE_FILL;
    noteRow.getCell(1).font = { italic: true, color: { argb: "FF7F7F7F" } };
  }

  dataRows.forEach((values, idx) => {
    const row = ws.addRow(values);
    styleDataRow(row, idx);
    for (const col of numberCols) {
      const cell = row.getCell(col);
      if (typeof cell.value === "number") cell.numFmt = "0.000";
    }
  });

  // Column widths
  headers.forEach((_, i) => {
    ws.getColumn(i + 1).width = colWidths?.[i] ?? 14;
  });

  return ws;
}

function noteSheet(wb, name, lines) {
  const ws = wb.addWorksheet(name);
  lines.forEach((text) => {
    const row = ws.addRow([text]);
    row.getCell(1).fill = NOTE_FILL;
  });
  ws.getColumn(1).width = 80;
  return ws;
}

// ---------------------------------------------------------------------------
// Sheet builders
// ---------------------------------------------------------------------------

function buildWordsSheet(wb, wordPayload) {
  const headers = [
    "word_id", "utt_id", "speaker", "text",
    "start_sec", "end_sec", "duration_sec",
    "local_start_sec", "local_end_sec",
    "oov", "alignment_status",
    "overall_log_likelihood", "phone_duration_deviation", "snr",
    "alignment_flags", "clip_textgrid",
  ];
  const numberCols = [5, 6, 7, 8, 9, 12, 13, 14]; // start, end, dur, local_start, local_end, ll, dev, snr

  if (!wordPayload) {
    noteSheet(wb, "Words", ["(word_alignment.json not provided; run WP2.0 first)"]);
    return;
  }

  const words = Array.isArray(wordPayload.word_intervals) ? wordPayload.word_intervals : [];
  const rows = words.map((w) => {
    const ac = w.alignment_confidence ?? {};
    return [
      w.word_id ?? "",
      w.utt_id ?? "",
      w.speaker ?? "",
      w.text ?? "",
      w.start_sec ?? "",
      w.end_sec ?? "",
      w.duration_sec ?? "",
      w.local_start_sec ?? "",
      w.local_end_sec ?? "",
      w.oov ? "TRUE" : "FALSE",
      ac.status ?? "",
      ac.overall_log_likelihood ?? "",
      ac.phone_duration_deviation ?? "",
      ac.snr ?? "",
      Array.isArray(w.alignment_flags) ? w.alignment_flags.join("; ") : "",
      w.clip_textgrid ?? "",
    ];
  });

  addSheet(wb, "Words", headers, rows, {
    colWidths: [22, 16, 10, 14, 10, 10, 10, 10, 10, 7, 14, 20, 20, 10, 30, 28],
    numberCols,
  });
}

function buildClausesSheet(wb, clausePayload) {
  const headers = [
    "clause_id", "speaker", "start_sec", "end_sec",
    "word_count", "text",
    "start_word_id", "end_word_id",
    "boundary_trigger", "source", "review_status",
    "utt_ids",
  ];
  const numberCols = [3, 4];

  if (!clausePayload) {
    noteSheet(wb, "Clauses", ["(clause_segments.json not provided; run WP2.2 first)"]);
    return;
  }

  const clauses = Array.isArray(clausePayload.clauses) ? clausePayload.clauses : [];
  const rows = clauses.map((c) => [
    c.clause_id ?? "",
    c.speaker ?? "",
    c.start_sec ?? "",
    c.end_sec ?? "",
    c.word_count ?? "",
    c.text ?? "",
    c.start_word_id ?? "",
    c.end_word_id ?? "",
    c.boundary_trigger ?? "",
    c.source ?? "",
    c.review_status ?? "",
    Array.isArray(c.utt_ids) ? c.utt_ids.join("; ") : (c.utt_ids ?? ""),
  ]);

  addSheet(wb, "Clauses", headers, rows, {
    colWidths: [14, 10, 10, 10, 10, 50, 22, 22, 24, 16, 16, 30],
    numberCols,
  });
}

function buildPausesSheet(wb, pausePayload) {
  const headers = [
    "pause_id", "start_sec", "end_sec", "duration_sec",
    "pause_location", "location_confidence", "location_method",
    "clause_source",
    "previous_word", "next_word",
    "previous_clause_id", "next_clause_id",
    "previous_speaker", "next_speaker",
    "review_status",
  ];
  const numberCols = [2, 3, 4];

  if (!pausePayload) {
    noteSheet(wb, "Pauses", ["(pause_location.json not provided; run WP2.3 first)"]);
    return;
  }

  const pauses = Array.isArray(pausePayload.pauses) ? pausePayload.pauses : [];
  const rows = pauses.map((p) => [
    p.pause_id ?? "",
    p.start_sec ?? "",
    p.end_sec ?? "",
    p.duration_sec ?? "",
    p.pause_location ?? "",
    p.location_confidence ?? "",
    p.location_method ?? "",
    p.clause_source ?? "",
    p.previous_word ?? "",
    p.next_word ?? "",
    p.previous_clause_id ?? "",
    p.next_clause_id ?? "",
    p.previous_speaker ?? "",
    p.next_speaker ?? "",
    p.review_status ?? "",
  ]);

  addSheet(wb, "Pauses", headers, rows, {
    colWidths: [14, 10, 10, 12, 16, 18, 18, 16, 30, 30, 16, 16, 16, 16, 16],
    numberCols,
  });
}

function buildRatesSheet(wb, ratePayload) {
  if (!ratePayload) {
    noteSheet(wb, "Rates", ["(rate_metrics.json not provided; run WP2.1 first)"]);
    return;
  }

  const wb_ws = wb.addWorksheet("Rates", { views: [{ state: "frozen", ySplit: 1 }] });
  wb_ws.getColumn(1).width = 36;
  wb_ws.getColumn(2).width = 18;
  wb_ws.getColumn(3).width = 18;
  wb_ws.getColumn(4).width = 18;

  const SECTION_FILL = { type: "pattern", pattern: "solid", fgColor: { argb: "FF243F60" } };
  const SECTION_FONT = { bold: true, color: { argb: "FFFFFFFF" }, size: 10 };

  function sectionHeader(label) {
    const row = wb_ws.addRow([label]);
    row.getCell(1).fill = SECTION_FILL;
    row.getCell(1).font = SECTION_FONT;
    row.height = 16;
  }

  function dataRow(label, ...values) {
    const row = wb_ws.addRow([label, ...values]);
    row.eachCell((cell, colNumber) => {
      cell.border = CELL_BORDER;
      if (colNumber > 1 && typeof cell.value === "number") cell.numFmt = "0.000";
    });
  }

  const s = ratePayload.summary ?? {};
  const session = s.session ?? {};
  const speakers = Array.isArray(ratePayload.speakers) ? ratePayload.speakers : [];

  // --- Session header row ---
  const colHeader = wb_ws.addRow(["Metric", "Session", ...speakers.map((sp) => sp.speaker)]);
  styleHeader(colHeader);

  sectionHeader("Timing");
  dataRow("total_duration_sec", session.total_duration_sec ?? "", ...speakers.map(() => ""));
  dataRow("phonation_time_sec", session.phonation_time_sec ?? "", ...speakers.map((sp) => sp.phonation_time_sec ?? ""));
  dataRow("speaking_time_sec", session.speaking_time_sec ?? "", ...speakers.map(() => ""));
  dataRow("silent_pause_time_sec", session.silent_pause_time_sec ?? "", ...speakers.map(() => ""));
  dataRow("phonation_time_ratio (PTR)", session.phonation_time_ratio ?? "", ...speakers.map(() => ""));

  sectionHeader("Counts");
  dataRow("word_count", session.word_count ?? "", ...speakers.map((sp) => sp.word_count ?? ""));
  dataRow("syllable_count", session.syllable_count ?? "", ...speakers.map((sp) => sp.syllable_count ?? ""));
  dataRow("silent_pause_count", session.silent_pause_count ?? "", ...speakers.map(() => ""));
  dataRow("silent_pauses_per_min", session.silent_pauses_per_min ?? "", ...speakers.map(() => ""));
  dataRow("mean_silent_pause_duration_sec", session.mean_silent_pause_duration_sec ?? "", ...speakers.map(() => ""));

  sectionHeader("Articulation Rate (÷ phonation time)");
  dataRow("articulation_rate_words_per_sec", session.articulation_rate_words_per_sec ?? "", ...speakers.map((sp) => sp.articulation_rate_words_per_sec ?? ""));
  dataRow("articulation_rate_syllables_per_sec", session.articulation_rate_syllables_per_sec ?? "", ...speakers.map((sp) => sp.articulation_rate_syllables_per_sec ?? ""));

  sectionHeader("Speech Rate (÷ speaking time)");
  dataRow("speech_rate_words_per_sec", session.speech_rate_words_per_sec ?? "", ...speakers.map((sp) => sp.speech_rate_words_per_sec ?? ""));
  dataRow("speech_rate_syllables_per_sec", session.speech_rate_syllables_per_sec ?? "", ...speakers.map((sp) => sp.speech_rate_syllables_per_sec ?? ""));

  sectionHeader("Speech Rate (÷ total time)");
  dataRow("speech_rate_words_per_sec_total", session.speech_rate_words_per_sec_total ?? "", ...speakers.map((sp) => sp.speech_rate_words_per_sec_total ?? ""));
  dataRow("speech_rate_syllables_per_sec_total", session.speech_rate_syllables_per_sec_total ?? "", ...speakers.map((sp) => sp.speech_rate_syllables_per_sec_total ?? ""));

  sectionHeader("Syllable Method");
  const noteRow = wb_ws.addRow([s.syllable_method_note ?? ""]);
  noteRow.getCell(1).fill = NOTE_FILL;
  noteRow.getCell(1).font = { italic: true, size: 9 };
  wb_ws.mergeCells(noteRow.number, 1, noteRow.number, 4);

  // Per-utterance sub-table
  const utterances = Array.isArray(ratePayload.utterances) ? ratePayload.utterances : [];
  if (utterances.length > 0) {
    wb_ws.addRow([]);
    sectionHeader("Per-Utterance Rates");
    const uttHeaders = [
      "utt_id", "speaker", "start_sec", "end_sec",
      "phonation_time_sec", "word_count", "syllable_count",
      "artic_rate_words", "artic_rate_syl", "speech_rate_words", "speech_rate_syl",
    ];
    const uttHeaderRow = wb_ws.addRow(uttHeaders);
    styleHeader(uttHeaderRow);
    utterances.forEach((u, idx) => {
      const row = wb_ws.addRow([
        u.utt_id ?? "", u.speaker ?? "",
        u.start_sec ?? "", u.end_sec ?? "",
        u.phonation_time_sec ?? "",
        u.word_count ?? "", u.syllable_count ?? "",
        u.articulation_rate_words_per_sec ?? "",
        u.articulation_rate_syllables_per_sec ?? "",
        u.speech_rate_words_per_sec ?? "",
        u.speech_rate_syllables_per_sec ?? "",
      ]);
      styleDataRow(row, idx);
      [3, 4, 5, 6, 8, 9, 10, 11].forEach((col) => {
        const cell = row.getCell(col);
        if (typeof cell.value === "number") cell.numFmt = "0.000";
      });
    });
    [16, 12, 10, 10, 12, 10, 10, 12, 12, 12, 12].forEach((w, i) => {
      const existing = wb_ws.getColumn(i + 1).width;
      if (!existing || existing < w) wb_ws.getColumn(i + 1).width = w;
    });
  }
}

function buildSummarySheet(wb, args, wordPayload, clausePayload, pausePayload, ratePayload) {
  const ws = wb.addWorksheet("Summary");
  ws.getColumn(1).width = 42;
  ws.getColumn(2).width = 55;

  const SECTION_FILL = { type: "pattern", pattern: "solid", fgColor: { argb: "FF243F60" } };
  const SECTION_FONT = { bold: true, color: { argb: "FFFFFFFF" }, size: 10 };

  function section(label) {
    const row = ws.addRow([label]);
    row.getCell(1).fill = SECTION_FILL;
    row.getCell(1).font = SECTION_FONT;
    ws.mergeCells(row.number, 1, row.number, 2);
    row.height = 16;
  }

  function kv(key, value) {
    const row = ws.addRow([key, value ?? ""]);
    row.eachCell((cell) => { cell.border = CELL_BORDER; });
  }

  function blank() { ws.addRow([]); }

  const now = new Date().toISOString();
  section("Provenance");
  kv("Generated At", now);
  kv("word_alignment", resolve(args.wordAlignment));
  kv("rate_metrics", resolve(args.rateMetrics));
  kv("clause_segments", resolve(args.clauseSegments));
  kv("pause_location", resolve(args.pauseLocation));

  blank();
  section("Alignment QC");
  const aqc = wordPayload?.summary?.alignment_qc ?? null;
  if (aqc) {
    kv("utterance_count", aqc.utterance_count ?? "");
    kv("status_ok", aqc.ok_count ?? "");
    kv("status_needs_review", aqc.needs_review_count ?? "");
    kv("status_low_confidence", aqc.low_confidence_count ?? "");
    kv("status_missing_alignment", aqc.missing_alignment_count ?? "");
    kv("oov_count", aqc.oov_count ?? "");
    kv("flagged_word_count", aqc.flagged_word_count ?? "");
  } else {
    kv("(no alignment QC data)", "");
  }

  blank();
  section("Rate Metrics — Session");
  const session = ratePayload?.summary?.session ?? null;
  if (session) {
    kv("phonation_time_sec", session.phonation_time_sec ?? "");
    kv("speaking_time_sec", session.speaking_time_sec ?? "");
    kv("phonation_time_ratio (PTR)", session.phonation_time_ratio ?? "");
    kv("word_count", session.word_count ?? "");
    kv("syllable_count", session.syllable_count ?? "");
    kv("silent_pause_count", session.silent_pause_count ?? "");
    kv("articulation_rate_syllables_per_sec", session.articulation_rate_syllables_per_sec ?? "");
    kv("speech_rate_syllables_per_sec", session.speech_rate_syllables_per_sec ?? "");
    kv("syllable_source", ratePayload?.summary?.syllable_source ?? "");
    kv("syllable_method_note", ratePayload?.summary?.syllable_method_note ?? "");
  } else {
    kv("(no rate metrics data)", "");
  }

  blank();
  section("Clause Segmentation");
  const cs = clausePayload?.summary ?? null;
  if (cs) {
    kv("method", cs.method ?? "");
    kv("clause_count", cs.clause_count ?? "");
    kv("word_count", cs.word_count ?? "");
    kv("mean_words_per_clause", cs.mean_words_per_clause ?? "");
    kv("clause_gap_seconds", cs.params?.clause_gap_seconds ?? "");
    kv("conjunctions", Array.isArray(cs.params?.conjunctions) ? cs.params.conjunctions.join(", ") : "");
    kv("review_note", cs.review_note ?? "");
    const triggers = cs.boundary_trigger_counts ?? {};
    for (const [k, v] of Object.entries(triggers)) {
      kv(`  trigger: ${k}`, v);
    }
  } else {
    kv("(no clause data)", "");
  }

  blank();
  section("Pause Location");
  const pl = pausePayload?.summary ?? null;
  if (pl) {
    kv("pause_count", pl.pause_count ?? "");
    kv("mid_clause_count", pl.mid_clause_count ?? "");
    kv("end_clause_count", pl.end_clause_count ?? "");
    kv("between_turn_count", pl.between_turn_count ?? "");
    kv("unknown_count", pl.unknown_count ?? "");
    kv("clause_source", pl.clause_source ?? "");
    kv("review_note", pl.review_note ?? "");
  } else {
    kv("(no pause location data)", "");
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const args = parseArgs(process.argv);

  const wordPayload   = tryReadJson(args.wordAlignment,   "word_alignment.json");
  const ratePayload   = tryReadJson(args.rateMetrics,     "rate_metrics.json");
  const clausePayload = tryReadJson(args.clauseSegments,  "clause_segments.json");
  const pausePayload  = tryReadJson(args.pauseLocation,   "pause_location.json");

  const wb = new ExcelJS.Workbook();
  wb.creator = "MWU Fluency Pipeline WP2.5";
  wb.created = new Date();

  buildWordsSheet(wb, wordPayload);
  buildClausesSheet(wb, clausePayload);
  buildPausesSheet(wb, pausePayload);
  buildRatesSheet(wb, ratePayload);
  buildSummarySheet(wb, args, wordPayload, clausePayload, pausePayload, ratePayload);

  const wordAlignmentResolved = resolve(args.wordAlignment);
  let base = basename(wordAlignmentResolved)
    .replace(/\.word_alignment\.json$/i, "")
    .replace(/\.json$/i, "");
  // Fall back to parent directory name when the file itself has no meaningful prefix.
  if (!base || base === "word_alignment") {
    base = basename(dirname(wordAlignmentResolved));
  }
  const outputPath = args.output
    ? resolve(args.output)
    : resolve(args.outputDir, `${base}.research.xlsx`);
  mkdirSync(dirname(outputPath), { recursive: true });

  await wb.xlsx.writeFile(outputPath);

  const words   = Array.isArray(wordPayload?.word_intervals) ? wordPayload.word_intervals.length : 0;
  const clauses = Array.isArray(clausePayload?.clauses) ? clausePayload.clauses.length : 0;
  const pauses  = Array.isArray(pausePayload?.pauses) ? pausePayload.pauses.length : 0;
  const utts    = Array.isArray(ratePayload?.utterances) ? ratePayload.utterances.length : 0;

  console.log(JSON.stringify({
    output_xlsx: outputPath,
    sheets: ["Words", "Clauses", "Pauses", "Rates", "Summary"],
    word_count: words,
    clause_count: clauses,
    pause_count: pauses,
    utterance_count: utts,
  }, null, 2));
}

main().catch((err) => {
  console.error(err.message);
  process.exitCode = 1;
});
