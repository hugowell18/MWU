#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import JSZip from 'jszip';

import { CONFIG } from '../validation-sprint/config.mjs';
import { runScript2, praatAvailable } from '../validation-sprint/lib/praat.mjs';
import { parseTextGrid } from '../validation-sprint/lib/textgrid.mjs';
import { findTier, parseScript2, segmentsFromTier, summarize } from '../validation-sprint/lib/durations.mjs';
import { ensureDir, readText, sha256, writeJson } from '../validation-sprint/lib/fsutil.mjs';
import { writeWorkbook } from '../validation-sprint/lib/xlsxio.mjs';

const ALLOWED_LABELS = ['sounding', 'silent', 'invalid'];
const TIME_TOLERANCE = 0.001;

function cliValue(name, fallback = null) {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

function required(name) {
  const value = cliValue(name);
  if (!value) throw new Error(`Missing required argument: ${name}`);
  return value;
}

function sanitize(value) {
  return String(value ?? 'unknown').replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^_+|_+$/g, '') || 'unknown';
}

function thresholdLabel(value) {
  return Number(value).toFixed(2).replace(/0+$/, '').replace(/\.$/, '');
}

function round(value, digits = 6) {
  const factor = 10 ** digits;
  return Math.round(Number(value) * factor) / factor;
}

function closeEnough(left, right, tolerance = TIME_TOLERANCE) {
  return Math.abs(Number(left) - Number(right)) <= tolerance;
}

function mergedRanges(segments, label) {
  const ranges = [];
  for (const segment of segments.filter((item) => item.label === label)) {
    const previous = ranges[ranges.length - 1];
    if (previous && closeEnough(previous.end, segment.start)) previous.end = segment.end;
    else ranges.push({ start: segment.start, end: segment.end });
  }
  return ranges;
}

function sameRanges(left, right) {
  return left.length === right.length && left.every((range, index) => closeEnough(range.start, right[index].start) && closeEnough(range.end, right[index].end));
}

function reviewedName(recordingId, job) {
  return `${sanitize(recordingId)}_${sanitize(job.speaker)}_${thresholdLabel(job.threshold)}s.TextGrid`;
}

function validateReviewedGrid(file, job, totalDuration) {
  const grid = parseTextGrid(readText(file));
  const tier = findTier(grid, 'silences');
  if (!tier) throw new Error(`${path.basename(file)} has no silences IntervalTier`);
  const segments = segmentsFromTier(tier);
  const labels = [...new Set(segments.map((segment) => segment.label))];
  const unexpected = labels.filter((label) => !ALLOWED_LABELS.includes(label));
  const blank = segments.filter((segment) => !segment.label).length;
  const shortSilent = segments.filter((segment) => segment.label === 'silent' && segment.duration < Number(job.threshold) - TIME_TOLERANCE);
  const contiguous = segments.every((segment, index) => index === 0 || closeEnough(segments[index - 1].end, segment.start));
  const summary = summarize(segments);
  const qa = {
    labels_ok: unexpected.length === 0,
    no_blank_intervals: blank === 0,
    full_timeline: closeEnough(summary.total_duration, totalDuration),
    contiguous_timeline: contiguous,
    threshold_respected: shortSilent.length === 0,
    unexpected_labels: unexpected,
    blank_intervals: blank,
    short_silent_intervals: shortSilent.length,
  };
  qa.passed = Object.entries(qa).filter(([, value]) => typeof value === 'boolean').every(([, value]) => value);
  return { segments, summary, invalid_ranges: mergedRanges(segments, 'invalid'), qa };
}

function summaryRow(recordingId, job) {
  const summary = job.summary;
  return {
    Recording: recordingId,
    Speaker: job.speaker,
    'Threshold (s)': job.threshold,
    'Total audio (s)': round(summary.total_duration),
    'Total sounding (s)': round(summary.total_sounding),
    'Total silent (s)': round(summary.total_silent),
    'Total invalid (s)': round(summary.total_invalid),
    'Sounding intervals': summary.sounding_count,
    'Silent pause count': summary.silent_count,
    'Invalid intervals': summary.invalid_count,
    'Mean silent pause (s)': round(summary.mean_silent),
    'Minimum silent pause (s)': round(summary.min_silent),
    'Maximum silent pause (s)': round(summary.max_silent),
    'Review status': 'reviewed',
  };
}

async function buildDurationSummary(file, recordingId, jobs) {
  const headers = [
    'Recording', 'Speaker', 'Threshold (s)', 'Total audio (s)', 'Total sounding (s)', 'Total silent (s)',
    'Total invalid (s)', 'Sounding intervals', 'Silent pause count', 'Invalid intervals',
    'Mean silent pause (s)', 'Minimum silent pause (s)', 'Maximum silent pause (s)', 'Review status',
  ];
  const numberFormats = Object.fromEntries(headers.filter((header) => /\(s\)$/.test(header)).map((header) => [header, header === 'Threshold (s)' ? '0.00' : '0.000']));
  return writeWorkbook(file, [{
    name: 'Duration Summary',
    headers,
    rows: jobs.map((job) => summaryRow(recordingId, job)),
    columnWidths: {
      Recording: 32, Speaker: 16, 'Threshold (s)': 14, 'Total audio (s)': 16, 'Total sounding (s)': 18,
      'Total silent (s)': 16, 'Total invalid (s)': 16, 'Sounding intervals': 17, 'Silent pause count': 17,
      'Invalid intervals': 15, 'Mean silent pause (s)': 20, 'Minimum silent pause (s)': 22,
      'Maximum silent pause (s)': 22, 'Review status': 15,
    },
    numberFormats,
  }]);
}

async function buildPerPauseMethod(file, recordingId, jobs, method) {
  const pauseHeaders = ['Recording', 'Speaker', 'Threshold (s)', 'Pause', 'Start (s)', 'End (s)', 'Duration (s)'];
  const pauses = [];
  for (const job of jobs) {
    let pause = 0;
    for (const segment of job.segments) {
      if (segment.label !== 'silent') continue;
      pause += 1;
      pauses.push({
        Recording: recordingId,
        Speaker: job.speaker,
        'Threshold (s)': job.threshold,
        Pause: pause,
        'Start (s)': round(segment.start),
        'End (s)': round(segment.end),
        'Duration (s)': round(segment.duration),
      });
    }
  }
  const methodRows = Object.entries(method).flatMap(([Parameter, Value]) => {
    if (Parameter === 'reviewed_textgrid_sha256' && Value && typeof Value === 'object') {
      return Object.entries(Value).map(([Artifact, hash]) => ({ Parameter, Artifact, Value: hash }));
    }
    return [{
      Parameter,
      Artifact: 'global',
      Value: Array.isArray(Value) ? Value.join(', ') : typeof Value === 'boolean' ? String(Value) : Value,
    }];
  });
  const numberFormats = { 'Threshold (s)': '0.00', 'Start (s)': '0.000', 'End (s)': '0.000', 'Duration (s)': '0.000' };
  return writeWorkbook(file, [
    {
      name: 'Per-pause', headers: pauseHeaders, rows: pauses,
      columnWidths: { Recording: 32, Speaker: 16, 'Threshold (s)': 14, Pause: 10, 'Start (s)': 13, 'End (s)': 13, 'Duration (s)': 14 },
      numberFormats,
    },
    {
      name: 'Method', headers: ['Parameter', 'Artifact', 'Value'], rows: methodRows,
      columnWidths: { Parameter: 31, Artifact: 58, Value: 70 }, wrapColumns: ['Artifact', 'Value'], rowHeight: 24,
    },
  ]);
}

async function buildZip(file, grids, durationSummary, perPauseMethod) {
  const zip = new JSZip();
  const textgrids = zip.folder('TextGrids');
  grids.forEach((grid) => textgrids.file(path.basename(grid), fs.readFileSync(grid)));
  zip.file('duration_summary.xlsx', fs.readFileSync(durationSummary));
  zip.file('per_pause_method_log.xlsx', fs.readFileSync(perPauseMethod));
  fs.writeFileSync(file, await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', compressionOptions: { level: 6 } }));
}

async function main() {
  const draftReportPath = path.resolve(required('--draft-report'));
  const reviewsDir = path.resolve(required('--reviews-dir'));
  const outDir = path.resolve(required('--out'));
  const reviewer = required('--reviewer').trim();
  const progressPath = cliValue('--progress') ? path.resolve(cliValue('--progress')) : null;
  const reviewConfirmed = cliValue('--review-confirmed') === 'true';
  ensureDir(outDir);
  const writeProgress = (state) => progressPath && writeJson(progressPath, { ...state, updated_at: new Date().toISOString() });

  try {
    if (!reviewConfirmed) throw new Error('Human Praat review confirmation is required');
    if (!reviewer) throw new Error('Reviewer or rater ID is required');
    if (!praatAvailable()) throw new Error(`Praat is unavailable at ${CONFIG.praat.binary}`);
    const draft = JSON.parse(readText(draftReportPath));
    if (draft.status !== 'ready_for_praat_review') throw new Error('Draft report is not ready for Praat review');
    if (!Array.isArray(draft.jobs) || !draft.jobs.length) throw new Error('Draft report contains no speaker-threshold jobs');

    writeProgress({ done: false, status: 'validating_reviewed_textgrids', completed: 0, total: draft.jobs.length });
    const textgridDir = ensureDir(path.join(outDir, 'TextGrids'));
    const supportDir = ensureDir(path.join(outDir, '_supporting'));
    const reviewedJobs = [];

    for (const [index, draftJob] of draft.jobs.entries()) {
      const name = reviewedName(draft.recording_id, draftJob);
      const reviewedInput = path.join(reviewsDir, name);
      if (!fs.existsSync(reviewedInput)) throw new Error(`Missing reviewed TextGrid: ${name}`);
      const validated = validateReviewedGrid(reviewedInput, draftJob, draft.duration_seconds);
      if (!validated.qa.passed) throw new Error(`${name} failed reviewed TextGrid QA: ${JSON.stringify(validated.qa)}`);

      const finalGrid = path.join(textgridDir, name);
      fs.copyFileSync(reviewedInput, finalGrid);
      const durationTsv = path.join(supportDir, `${path.basename(name, '.TextGrid')}.segment_durations.tsv`);
      const script2 = runScript2(finalGrid, durationTsv, 'silences', CONFIG.praat.binary);
      if (!script2.ok) throw new Error(`${name} Script 2 failed: ${script2.stderr}`);
      const segments = parseScript2(script2.text);
      const summary = summarize(segments);
      if (!closeEnough(summary.total_duration, validated.summary.total_duration) || summary.silent_count !== validated.summary.silent_count) {
        throw new Error(`${name} Script 2 does not match the reviewed TextGrid`);
      }
      reviewedJobs.push({
        speaker: draftJob.speaker,
        threshold: draftJob.threshold,
        reviewed_textgrid: finalGrid,
        reviewed_sha256: sha256(finalGrid),
        segments,
        summary,
        invalid_ranges: validated.invalid_ranges,
        qa: { ...validated.qa, script2_parity: true },
      });
      writeProgress({ done: false, status: 'calculating_post_review_durations', completed: index + 1, total: draft.jobs.length });
    }

    for (const speaker of [...new Set(reviewedJobs.map((job) => job.speaker))]) {
      const jobs = reviewedJobs.filter((job) => job.speaker === speaker);
      if (!jobs.every((job) => sameRanges(job.invalid_ranges, jobs[0].invalid_ranges))) {
        throw new Error(`${speaker} reviewed TextGrids do not share the same invalid timeline across thresholds`);
      }
      jobs.forEach((job) => { job.qa.invalid_timeline_consistent_across_thresholds = true; });
    }

    const finalizedAt = new Date().toISOString();
    const method = {
      module: 'Layer 1 L1b - reviewed multi-threshold pause and duration analysis',
      review_status: 'human_review_confirmed',
      reviewer_or_rater_id: reviewer,
      finalized_at: finalizedAt,
      source_draft_report: path.basename(draftReportPath),
      source_draft_report_sha256: sha256(draftReportPath),
      praat_version: draft.method?.praat_version || 'unknown',
      thresholds_seconds: draft.thresholds,
      window_size_seconds: draft.method?.window_size_seconds ?? 200,
      silence_threshold_db: draft.method?.silence_threshold_db,
      minimum_sounding_seconds: draft.method?.minimum_sounding_seconds,
      scale_times: true,
      label_contract: ALLOWED_LABELS,
      duration_script: 'calculate_segment_durations.praat',
      reviewed_textgrid_sha256: Object.fromEntries(reviewedJobs.map((job) => [path.basename(job.reviewed_textgrid), job.reviewed_sha256])),
    };

    const durationSummary = path.join(outDir, 'duration_summary.xlsx');
    const perPauseMethod = path.join(outDir, 'per_pause_method_log.xlsx');
    await buildDurationSummary(durationSummary, draft.recording_id, reviewedJobs);
    await buildPerPauseMethod(perPauseMethod, draft.recording_id, reviewedJobs, method);
    const packagePath = path.join(outDir, `${draft.recording_id}_L1b_reviewed_deliverables.zip`);
    await buildZip(packagePath, reviewedJobs.map((job) => job.reviewed_textgrid), durationSummary, perPauseMethod);

    const artifacts = [
      ...reviewedJobs.map((job) => ({
        name: path.basename(job.reviewed_textgrid), path: job.reviewed_textgrid, kind: 'reviewed segmentation',
        group: 'reviewed_textgrids', speaker: job.speaker, threshold: job.threshold,
      })),
      { name: 'duration_summary.xlsx', path: durationSummary, kind: 'computed post-review', group: 'duration_summary' },
      { name: 'per_pause_method_log.xlsx', path: perPauseMethod, kind: 'per-pause table and method log', group: 'per_pause_method' },
      { name: path.basename(packagePath), path: packagePath, kind: 'reviewed L1b deliverables', group: 'final_package' },
    ];
    const report = {
      schema_version: 1,
      module: 'l1b_reviewed_final',
      status: 'reviewed_ready',
      generated_at: finalizedAt,
      recording_id: draft.recording_id,
      source_draft_report: draftReportPath,
      reviewer_or_rater_id: reviewer,
      review_confirmed: true,
      thresholds: draft.thresholds,
      duration_seconds: draft.duration_seconds,
      method,
      jobs: reviewedJobs,
      qa: {
        passed: reviewedJobs.every((job) => job.qa.passed && job.qa.script2_parity),
        reviewed_textgrids: reviewedJobs.length,
        expected_textgrids: draft.jobs.length,
        post_review_script2_parity: reviewedJobs.every((job) => job.qa.script2_parity),
        invalid_timeline_consistent_across_thresholds: reviewedJobs.every((job) => job.qa.invalid_timeline_consistent_across_thresholds),
      },
      artifacts,
      artifact_contract: {
        textgrids: '{audio}_0.25s.TextGrid and {audio}_0.35s.TextGrid',
        duration_summary: 'duration_summary.xlsx',
        per_pause_method_log: 'per_pause_method_log.xlsx',
      },
    };
    const reportPath = path.join(outDir, 'l1b_final_report.json');
    writeJson(reportPath, report);
    writeJson(path.join(outDir, 'method_log.json'), method);
    writeProgress({ done: true, status: 'reviewed_ready', report: reportPath, package: packagePath, completed: reviewedJobs.length, total: reviewedJobs.length });
    console.log(JSON.stringify({ ok: true, report: reportPath, package: packagePath, reviewed_textgrids: reviewedJobs.length }, null, 2));
  } catch (error) {
    const failure = { schema_version: 1, module: 'l1b_reviewed_final', status: 'failed', generated_at: new Date().toISOString(), error: error.message };
    writeJson(path.join(outDir, 'l1b_final_report.json'), failure);
    writeProgress({ done: true, status: 'failed', error: error.message });
    console.error(error.stack || error.message);
    process.exitCode = 1;
  }
}

main();
