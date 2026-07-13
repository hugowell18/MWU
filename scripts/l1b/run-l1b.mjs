#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import JSZip from 'jszip';

import { CONFIG, ROOT } from '../validation-sprint/config.mjs';
import { runScript1, runScript2, praatAvailable } from '../validation-sprint/lib/praat.mjs';
import { parseTextGrid } from '../validation-sprint/lib/textgrid.mjs';
import { findTier, parseScript2, segmentsFromTier, summarize } from '../validation-sprint/lib/durations.mjs';
import { ensureDir, readText, sha256, writeJson, writeText } from '../validation-sprint/lib/fsutil.mjs';
import { writeWorkbook } from '../validation-sprint/lib/xlsxio.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_OUT = path.join(ROOT, 'outputs', 'l1b', 'manual-run');
const ALLOWED_LABELS = ['sounding', 'silent', 'invalid'];
const DURATION_TOLERANCE = 0.00001;

function cliValue(name, fallback = null) {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

function requiredCliValue(name) {
  const value = cliValue(name);
  if (!value) throw new Error(`Missing required argument: ${name}`);
  return value;
}

function round(value, digits = 6) {
  const factor = 10 ** digits;
  return Math.round(Number(value) * factor) / factor;
}

function sanitize(value) {
  return String(value ?? 'unknown').replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^_+|_+$/g, '') || 'unknown';
}

function thresholdLabel(value) {
  return String(Number(value));
}

function parseThresholds(raw) {
  const values = String(raw || '0.25,0.35')
    .split(',')
    .map(Number)
    .filter((value) => Number.isFinite(value) && value > 0 && value < 5);
  const unique = [...new Set(values)].sort((a, b) => a - b);
  if (!unique.length) throw new Error('At least one valid pause threshold is required');
  return unique;
}

function parseInvalidRanges(file, duration) {
  const ranges = [];
  for (const [index, raw] of readText(file).split(/\r?\n/).entries()) {
    const line = raw.trim();
    if (!line) continue;
    const fields = line.split(/\s+/);
    const start = Number(fields[0]);
    const end = Number(fields[1]);
    if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start || end > duration + DURATION_TOLERANCE) {
      throw new Error(`${path.basename(file)} line ${index + 1} is not a valid start/end range`);
    }
    ranges.push({ start, end, duration: end - start });
  }
  return ranges;
}

function durationSum(ranges) {
  return ranges.reduce((total, range) => total + range.duration, 0);
}

function closeEnough(left, right, tolerance = DURATION_TOLERANCE) {
  return Math.abs(Number(left) - Number(right)) <= tolerance;
}

function versionInfo() {
  const praat = spawnSync(CONFIG.praat.binary, ['--version'], { encoding: 'utf8', timeout: 10000 });
  const git = spawnSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: ROOT, encoding: 'utf8', timeout: 10000 });
  return {
    praat: `${praat.stdout || praat.stderr || 'unknown'}`.trim().split(/\r?\n/)[0],
    code_revision: git.status === 0 ? git.stdout.trim() : 'unknown',
  };
}

function progressWriter(file, state) {
  return () => {
    if (!file) return;
    writeJson(file, { ...state, updated_at: new Date().toISOString() });
  };
}

function inputContract(manifestPath) {
  const manifest = JSON.parse(readText(manifestPath));
  const handoff = manifest.phase_ii_handoff;
  if (!handoff?.ready) throw new Error('L1a manifest is not marked ready for Phase II handoff');
  if (JSON.stringify(handoff.expected_labels) !== JSON.stringify(ALLOWED_LABELS)) {
    throw new Error(`L1a label contract must be ${ALLOWED_LABELS.join('/')}`);
  }
  if (!Array.isArray(handoff.inputs) || !handoff.inputs.length) throw new Error('L1a manifest has no speaker inputs');

  const duration = Number(manifest.duration_seconds);
  if (!Number.isFinite(duration) || duration <= 0) throw new Error('L1a manifest has no valid duration_seconds');

  const inputs = handoff.inputs.map((input) => {
    const wav = path.resolve(input.wav);
    const invalid = path.resolve(input.invalid_intervals_tsv);
    if (!fs.existsSync(wav)) throw new Error(`Missing muted-mirror WAV: ${wav}`);
    if (!fs.existsSync(invalid)) throw new Error(`Missing invalid intervals TSV: ${invalid}`);
    const ranges = parseInvalidRanges(invalid, duration);
    return {
      speaker: sanitize(input.speaker).replace(/^speaker_/, ''),
      wav,
      invalid,
      invalid_ranges: ranges.length,
      expected_invalid_seconds: round(durationSum(ranges)),
      wav_bytes: fs.statSync(wav).size,
      wav_sha256: sha256(wav),
      invalid_sha256: sha256(invalid),
    };
  });

  return { manifest, handoff, duration, inputs };
}

function validateGeneratedGrid(textgridPath, expectedDuration, expectedInvalidSeconds) {
  const grid = parseTextGrid(readText(textgridPath));
  const tier = findTier(grid, 'silences');
  if (!tier) throw new Error('Generated TextGrid has no IntervalTier');
  const rawLabels = tier.intervals.map((interval) => interval.text);
  const labels = [...new Set(rawLabels)];
  const blankIntervals = rawLabels.filter((label) => label === '').length;
  const unexpectedLabels = labels.filter((label) => !ALLOWED_LABELS.includes(label));
  const summary = summarize(segmentsFromTier(tier));
  const qa = {
    no_blank_intervals: blankIntervals === 0,
    labels_ok: unexpectedLabels.length === 0,
    full_timeline_ok: closeEnough(summary.total_duration, expectedDuration),
    invalid_duration_ok: closeEnough(summary.total_invalid, expectedInvalidSeconds),
    blank_intervals: blankIntervals,
    unexpected_labels: unexpectedLabels,
  };
  qa.passed = Object.entries(qa).filter(([, value]) => typeof value === 'boolean').every(([, value]) => value);
  return { grid, tier, summary, qa };
}

function compareScript2(gridSummary, script2Summary) {
  return ['total_duration', 'total_sounding', 'total_silent', 'total_invalid'].every((key) =>
    closeEnough(gridSummary[key], script2Summary[key]),
  ) && ['interval_count', 'sounding_count', 'silent_count', 'invalid_count'].every((key) =>
    Number(gridSummary[key]) === Number(script2Summary[key]),
  );
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
    'QA status': job.qa.passed ? 'ready_for_praat_review' : 'failed',
  };
}

async function buildWorkbook(file, recordingId, jobs, method) {
  const summaryHeaders = [
    'Recording', 'Speaker', 'Threshold (s)', 'Total audio (s)', 'Total sounding (s)', 'Total silent (s)',
    'Total invalid (s)', 'Sounding intervals', 'Silent pause count', 'Invalid intervals',
    'Mean silent pause (s)', 'Minimum silent pause (s)', 'Maximum silent pause (s)', 'QA status',
  ];
  const segmentHeaders = ['Recording', 'Speaker', 'Threshold (s)', 'Segment', 'Label', 'Start (s)', 'End (s)', 'Duration (s)'];
  const pauseHeaders = ['Recording', 'Speaker', 'Threshold (s)', 'Pause', 'Start (s)', 'End (s)', 'Duration (s)'];
  const segments = [];
  const pauses = [];

  for (const job of jobs) {
    let pauseIndex = 0;
    job.segments.forEach((segment, index) => {
      segments.push({
        Recording: recordingId, Speaker: job.speaker, 'Threshold (s)': job.threshold, Segment: index + 1,
        Label: segment.label, 'Start (s)': round(segment.start), 'End (s)': round(segment.end), 'Duration (s)': round(segment.duration),
      });
      if (segment.label === 'silent') {
        pauseIndex += 1;
        pauses.push({
          Recording: recordingId, Speaker: job.speaker, 'Threshold (s)': job.threshold, Pause: pauseIndex,
          'Start (s)': round(segment.start), 'End (s)': round(segment.end), 'Duration (s)': round(segment.duration),
        });
      }
    });
  }

  const methodRows = Object.entries(method).map(([Parameter, Value]) => ({
    Parameter,
    Value: Array.isArray(Value) ? Value.join(', ') : typeof Value === 'object' ? JSON.stringify(Value) : Value,
  }));

  const identifiers = { Recording: 32, Speaker: 16, 'Threshold (s)': 14 };
  const secondsFormat = {
    'Threshold (s)': '0.00',
    'Total audio (s)': '0.000',
    'Total sounding (s)': '0.000',
    'Total silent (s)': '0.000',
    'Total invalid (s)': '0.000',
    'Mean silent pause (s)': '0.000',
    'Minimum silent pause (s)': '0.000',
    'Maximum silent pause (s)': '0.000',
    'Start (s)': '0.000',
    'End (s)': '0.000',
    'Duration (s)': '0.000',
  };

  return writeWorkbook(file, [
    {
      name: 'Summary',
      headers: summaryHeaders,
      rows: jobs.map((job) => summaryRow(recordingId, job)),
      columnWidths: {
        ...identifiers,
        'Total audio (s)': 16,
        'Total sounding (s)': 18,
        'Total silent (s)': 16,
        'Total invalid (s)': 16,
        'Sounding intervals': 17,
        'Silent pause count': 17,
        'Invalid intervals': 15,
        'Mean silent pause (s)': 20,
        'Minimum silent pause (s)': 22,
        'Maximum silent pause (s)': 22,
        'QA status': 27,
      },
      numberFormats: secondsFormat,
      alignments: { Speaker: 'center', 'Threshold (s)': 'center', 'QA status': 'center' },
    },
    {
      name: 'Segments',
      headers: segmentHeaders,
      rows: segments,
      columnWidths: { ...identifiers, Segment: 10, Label: 12, 'Start (s)': 13, 'End (s)': 13, 'Duration (s)': 14 },
      numberFormats: secondsFormat,
      alignments: { Speaker: 'center', 'Threshold (s)': 'center', Segment: 'center', Label: 'center' },
    },
    {
      name: 'Pause Values',
      headers: pauseHeaders,
      rows: pauses,
      columnWidths: { ...identifiers, Pause: 10, 'Start (s)': 13, 'End (s)': 13, 'Duration (s)': 14 },
      numberFormats: secondsFormat,
      alignments: { Speaker: 'center', 'Threshold (s)': 'center', Pause: 'center' },
    },
    {
      name: 'Method',
      headers: ['Parameter', 'Value'],
      rows: methodRows,
      columnWidths: { Parameter: 30, Value: 76 },
      wrapColumns: ['Value'],
      rowHeight: 24,
    },
  ]);
}

function readmeText({ recordingId, manifest, thresholds, method, speakerCount, textgridCount }) {
  return `L1b DRAFT REVIEW BUNDLE - NOT FINAL DELIVERABLES\n\n` +
    `Recording: ${recordingId}\n` +
    `Source Phase I manifest: ${path.basename(manifest)}\n` +
    `Speakers: ${speakerCount}\n` +
    `Pause thresholds: ${thresholds.join(', ')} seconds\n` +
    `TextGrid drafts: ${textgridCount}\n\n` +
    `LABEL CONTRACT\n` +
    `sounding = target speaker acoustic activity\n` +
    `silent = target speaker pause candidate at the configured threshold\n` +
    `invalid = another speaker is active or the interval is unsuitable for target-speaker pause metrics\n\n` +
    `METHOD\n` +
    `Praat: ${method.praat_version}\n` +
    `Window size: ${method.window_size_seconds} seconds\n` +
    `Silence threshold: ${method.silence_threshold_db} dB relative to maximum intensity\n` +
    `Minimum sounding interval: ${method.minimum_sounding_seconds} seconds\n` +
    `Scale times: applied to the complete original timeline\n` +
    `Duration extraction: calculate_segment_durations.praat\n\n` +
    `REVIEW BOUNDARY\n` +
    `These files are automatically generated drafts. They are ready for expert review in Praat, but they are not final research data. ` +
    `Final analysis must use TextGrid files checked and corrected by a human rater.\n`;
}

async function buildZip(file, textgrids, workbook, readme) {
  const zip = new JSZip();
  const grids = zip.folder('TextGrids');
  for (const grid of textgrids) grids.file(path.basename(grid), fs.readFileSync(grid));
  zip.file(path.basename(workbook), fs.readFileSync(workbook));
  zip.file(path.basename(readme), fs.readFileSync(readme));
  const buffer = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', compressionOptions: { level: 6 } });
  fs.writeFileSync(file, buffer);
  return file;
}

async function main() {
  const manifestPath = path.resolve(requiredCliValue('--manifest'));
  const outDir = path.resolve(cliValue('--out', DEFAULT_OUT));
  const progressPath = cliValue('--progress') ? path.resolve(cliValue('--progress')) : null;
  const latestPointer = cliValue('--latest-pointer') ? path.resolve(cliValue('--latest-pointer')) : null;
  const thresholds = parseThresholds(cliValue('--thresholds', '0.25,0.35'));
  ensureDir(outDir);

  const state = {
    done: false,
    status: 'checking_input',
    started_at: new Date().toISOString(),
    completed_jobs: 0,
    total_jobs: 0,
    jobs: [],
  };
  const writeProgress = progressWriter(progressPath, state);
  writeProgress();

  let report;
  try {
    if (!praatAvailable()) throw new Error(`Praat is unavailable at ${CONFIG.praat.binary}`);
    const contract = inputContract(manifestPath);
    const recordingId = sanitize(path.basename(contract.manifest.source_audio || manifestPath, path.extname(contract.manifest.source_audio || manifestPath)));
    const versions = versionInfo();
    const method = {
      module: 'Layer 1 L1b - deterministic Praat pause and duration automation',
      source_phase: 'L1a Phase I handoff',
      praat_version: versions.praat,
      code_revision: versions.code_revision,
      thresholds_seconds: thresholds,
      window_size_seconds: CONFIG.praat.window_size,
      silence_threshold_db: CONFIG.praat.silence_threshold_db,
      minimum_sounding_seconds: CONFIG.praat.min_sounding_interval,
      minimum_pitch_hz: CONFIG.praat.min_pitch,
      scale_times: true,
      label_contract: ALLOWED_LABELS,
      duration_script: 'calculate_segment_durations.praat',
      status_boundary: 'ready_for_praat_review; not final research data',
    };

    state.status = 'running';
    state.recording_id = recordingId;
    state.speakers = contract.inputs.map((input) => input.speaker);
    state.thresholds = thresholds;
    state.total_jobs = contract.inputs.length * thresholds.length;
    state.jobs = contract.inputs.flatMap((input) => thresholds.map((threshold) => ({
      key: `${input.speaker}-${thresholdLabel(threshold)}`,
      speaker: input.speaker,
      threshold,
      state: 'pending',
      stages: { praat_extraction: 'pending', textgrid_qa: 'pending', duration_calculation: 'pending' },
    })));
    writeProgress();

    const textgridDir = ensureDir(path.join(outDir, 'TextGrids'));
    const durationDir = ensureDir(path.join(outDir, 'supporting-data'));
    const jobs = [];

    for (const input of contract.inputs) {
      for (const threshold of thresholds) {
        const key = `${input.speaker}-${thresholdLabel(threshold)}`;
        const progressJob = state.jobs.find((job) => job.key === key);
        progressJob.state = 'running';
        state.current = { speaker: input.speaker, threshold };
        writeProgress();

        const stem = `${input.speaker}_${thresholdLabel(threshold)}s`;
        const textgridPath = path.join(textgridDir, `${stem}.draft.TextGrid`);
        const durationPath = path.join(durationDir, `${stem}.segment_durations.tsv`);

        progressJob.stages.praat_extraction = 'running';
        writeProgress();
        const script1 = runScript1(input.wav, textgridPath, threshold, CONFIG.praat, input.invalid);
        if (!script1.ok) throw new Error(`${key} Praat Script 1 failed: ${script1.stderr || script1.stdout}`);
        progressJob.stages.praat_extraction = 'passed';

        progressJob.stages.textgrid_qa = 'running';
        writeProgress();
        const checked = validateGeneratedGrid(textgridPath, contract.duration, input.expected_invalid_seconds);
        if (!checked.qa.passed) throw new Error(`${key} TextGrid QA failed: ${JSON.stringify(checked.qa)}`);
        progressJob.stages.textgrid_qa = 'passed';

        progressJob.stages.duration_calculation = 'running';
        writeProgress();
        const script2 = runScript2(textgridPath, durationPath, 'silences', CONFIG.praat.binary);
        if (!script2.ok) throw new Error(`${key} Praat Script 2 failed: ${script2.stderr}`);
        const script2Segments = parseScript2(script2.text);
        const script2Summary = summarize(script2Segments);
        const parityOk = compareScript2(checked.summary, script2Summary);
        if (!parityOk) throw new Error(`${key} Script 1/TextGrid and Script 2 summaries differ`);
        progressJob.stages.duration_calculation = 'passed';
        progressJob.state = 'passed';
        state.completed_jobs += 1;

        jobs.push({
          key,
          speaker: input.speaker,
          threshold,
          status: 'ready_for_praat_review',
          textgrid: textgridPath,
          duration_tsv: durationPath,
          summary: script2Summary,
          segments: script2Segments,
          qa: { ...checked.qa, script2_parity_ok: parityOk, passed: checked.qa.passed && parityOk },
          source: {
            wav: input.wav,
            invalid_intervals_tsv: input.invalid,
            invalid_ranges: input.invalid_ranges,
            expected_invalid_seconds: input.expected_invalid_seconds,
          },
          script1: { threshold, window_size: script1.window_size, command: script1.command, stdout: script1.stdout },
          script2: { script: 'calculate_segment_durations.praat', command: script2.command },
        });
        writeProgress();
      }
    }

    state.status = 'packaging';
    state.current = null;
    writeProgress();

    const workbook = path.join(outDir, `${recordingId}_pre_review_diagnostics.xlsx`);
    await buildWorkbook(workbook, recordingId, jobs, method);
    const readme = path.join(outDir, 'DRAFT_REVIEW_NOTES.txt');
    writeText(readme, readmeText({
      recordingId,
      manifest: manifestPath,
      thresholds,
      method,
      speakerCount: contract.inputs.length,
      textgridCount: jobs.length,
    }));
    const packagePath = path.join(outDir, `${recordingId}_L1b_draft_review_bundle.zip`);
    await buildZip(packagePath, jobs.map((job) => job.textgrid), workbook, readme);

    const artifacts = [
      ...jobs.map((job) => ({
        name: path.basename(job.textgrid), path: job.textgrid, kind: 'TextGrid draft', group: 'textgrids',
        speaker: job.speaker, threshold: job.threshold,
      })),
      { name: path.basename(workbook), path: workbook, kind: 'pre-review diagnostic workbook', group: 'metrics' },
      { name: path.basename(readme), path: readme, kind: 'draft review notes', group: 'method' },
      { name: path.basename(packagePath), path: packagePath, kind: 'draft review bundle', group: 'package' },
    ];

    report = {
      schema_version: 1,
      module: 'l1b',
      layer: 'Layer 1',
      phase: 'Phase II',
      status: 'ready_for_praat_review',
      generated_at: new Date().toISOString(),
      recording_id: recordingId,
      source_manifest: manifestPath,
      source_manifest_sha256: sha256(manifestPath),
      duration_seconds: contract.duration,
      speakers: contract.inputs,
      thresholds,
      method,
      jobs,
      summary: jobs.map((job) => summaryRow(recordingId, job)),
      qa: {
        passed: jobs.every((job) => job.qa.passed),
        jobs_passed: jobs.filter((job) => job.qa.passed).length,
        jobs_total: jobs.length,
        textgrids_generated: jobs.length,
        no_blank_intervals: jobs.every((job) => job.qa.no_blank_intervals),
        full_timeline: jobs.every((job) => job.qa.full_timeline_ok),
        invalid_duration_match: jobs.every((job) => job.qa.invalid_duration_ok),
        script2_parity: jobs.every((job) => job.qa.script2_parity_ok),
      },
      artifacts,
      review_boundary: 'Automatically generated draft. Expert correction in Praat is required before research use.',
    };

    const reportPath = path.join(outDir, 'l1b_report.json');
    writeJson(reportPath, report);
    writeJson(path.join(outDir, 'method_log.json'), method);
    if (latestPointer) writeJson(latestPointer, { report: reportPath, out_dir: outDir, updated_at: report.generated_at });

    state.done = true;
    state.status = 'ready_for_praat_review';
    state.report = reportPath;
    state.package = packagePath;
    state.finished_at = new Date().toISOString();
    writeProgress();
    console.log(JSON.stringify({ ok: true, report: reportPath, package: packagePath, jobs: jobs.length }, null, 2));
  } catch (error) {
    state.done = true;
    state.status = 'failed';
    state.error = error.message;
    state.finished_at = new Date().toISOString();
    const active = state.jobs.find((job) => job.state === 'running');
    if (active) active.state = 'failed';
    writeProgress();
    const failureReport = {
      schema_version: 1,
      module: 'l1b',
      status: 'failed',
      generated_at: state.finished_at,
      source_manifest: manifestPath,
      thresholds,
      error: error.message,
      progress: state,
      artifacts: [],
    };
    writeJson(path.join(outDir, 'l1b_report.json'), failureReport);
    console.error(error.stack || error.message);
    process.exitCode = 1;
  }
}

main();
