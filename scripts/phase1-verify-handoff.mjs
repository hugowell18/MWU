#!/usr/bin/env node

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { resolve } from 'node:path';
import { readJson, readWavForMuting, round, writeJson } from './phase1/lib/diarization-artifacts.mjs';

function parseArgs(argv) {
  const args = {
    manifest: '',
    output: '',
    toleranceSeconds: 0.001,
  };

  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === '--manifest' && next) {
      args.manifest = next;
      i += 1;
    } else if (arg === '--output' && next) {
      args.output = next;
      i += 1;
    } else if (arg === '--tolerance-seconds' && next) {
      args.toleranceSeconds = Number(next);
      i += 1;
    } else if (arg === '--help' || arg === '-h') {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`Unknown or incomplete argument: ${arg}`);
    }
  }

  if (!args.manifest) throw new Error('--manifest is required');
  if (!Number.isFinite(args.toleranceSeconds) || args.toleranceSeconds < 0) {
    throw new Error('--tolerance-seconds must be a non-negative number');
  }
  return args;
}

function printHelp() {
  console.log(`Usage:
  node scripts/phase1-verify-handoff.mjs --manifest <phase1_manifest.json> [--output <report.json>]

Checks that Phase I outputs satisfy the Phase II input contract:
  - each speaker has a muted-mirror WAV,
  - each speaker has invalid_intervals.tsv,
  - WAV durations match the manifest duration,
  - invalid intervals are ordered and inside the audio timeline,
  - label contract is sounding/silent/invalid.
`);
}

function parseInvalidIntervals(file, duration) {
  const intervals = [];
  const text = readFileSync(file, 'utf8');
  let previousEnd = 0;
  for (const [lineIndex, rawLine] of text.split(/\r?\n/).entries()) {
    const line = rawLine.trim();
    if (!line) continue;
    const fields = line.split(/\t/);
    if (fields.length !== 2) {
      throw new Error(`${file}: invalid interval line ${lineIndex + 1}; expected start<TAB>end`);
    }
    const start = Number(fields[0]);
    const end = Number(fields[1]);
    if (!Number.isFinite(start) || !Number.isFinite(end)) {
      throw new Error(`${file}: non-numeric interval at line ${lineIndex + 1}`);
    }
    if (start < -1e-9 || end > duration + 1e-9 || end <= start) {
      throw new Error(`${file}: interval out of range at line ${lineIndex + 1}: ${line}`);
    }
    if (start + 1e-9 < previousEnd) {
      throw new Error(`${file}: intervals are not sorted/non-overlapping at line ${lineIndex + 1}`);
    }
    intervals.push({ start, end, duration: end - start });
    previousEnd = end;
  }
  return intervals;
}

function main() {
  const args = parseArgs(process.argv);
  const manifestPath = resolve(args.manifest);
  if (!existsSync(manifestPath)) throw new Error(`Manifest does not exist: ${manifestPath}`);
  const manifest = readJson(manifestPath);
  const handoff = manifest.phase_ii_handoff;
  if (!handoff) throw new Error('Manifest missing phase_ii_handoff');
  const expectedLabels = handoff.expected_labels || [];
  const labelContractOk = expectedLabels.join(',') === 'sounding,silent,invalid';
  const inputs = Array.isArray(handoff.inputs) ? handoff.inputs : [];
  const checks = [];
  const errors = [];
  const expectedDuration = Number(manifest.duration_seconds);

  if (!labelContractOk) {
    errors.push(`expected_labels must be sounding,silent,invalid; got ${expectedLabels.join(',')}`);
  }
  if (!inputs.length) {
    errors.push('phase_ii_handoff.inputs is empty');
  }

  for (const input of inputs) {
    const row = {
      speaker: input.speaker,
      wav: input.wav,
      invalid_intervals_tsv: input.invalid_intervals_tsv,
      status: 'passed',
      wav_duration_seconds: null,
      invalid_interval_count: 0,
      invalid_seconds: 0,
      issues: [],
    };

    try {
      if (!input.speaker) row.issues.push('missing speaker');
      if (!input.wav || !existsSync(input.wav)) row.issues.push(`missing WAV: ${input.wav}`);
      if (!input.invalid_intervals_tsv || !existsSync(input.invalid_intervals_tsv)) {
        row.issues.push(`missing invalid TSV: ${input.invalid_intervals_tsv}`);
      }
      if (!row.issues.length) {
        const wav = readWavForMuting(input.wav);
        row.wav_duration_seconds = round(wav.durationSeconds, 6);
        if (Math.abs(wav.durationSeconds - expectedDuration) > args.toleranceSeconds) {
          row.issues.push(`WAV duration ${wav.durationSeconds} does not match manifest ${expectedDuration}`);
        }
        const invalidIntervals = parseInvalidIntervals(input.invalid_intervals_tsv, wav.durationSeconds);
        row.invalid_interval_count = invalidIntervals.length;
        row.invalid_seconds = round(invalidIntervals.reduce((total, interval) => total + interval.duration, 0), 6);
      }
    } catch (error) {
      row.issues.push(error.message);
    }

    if (row.issues.length) {
      row.status = 'failed';
      errors.push(`${row.speaker || 'unknown'}: ${row.issues.join('; ')}`);
    }
    checks.push(row);
  }

  const report = {
    generated_at: new Date().toISOString(),
    manifest: manifestPath,
    status: errors.length ? 'failed' : 'passed',
    expected_duration_seconds: expectedDuration,
    expected_labels: expectedLabels,
    label_contract_ok: labelContractOk,
    speaker_count: inputs.length,
    checks,
    errors,
    phase_ii_contract:
      'Each row can be passed to scripts/validation-sprint/praat/silences.praat as <wav> and <invalid_path>; the Phase II output should use sounding/silent/invalid labels.',
  };

  const outputPath = args.output ? resolve(args.output) : manifestPath.replace(/\.json$/i, '.handoff_check.json');
  writeJson(outputPath, report);
  console.log(`Wrote handoff check: ${outputPath}`);
  console.log(JSON.stringify({
    status: report.status,
    speaker_count: report.speaker_count,
    label_contract_ok: report.label_contract_ok,
    errors: report.errors,
  }, null, 2));
  if (report.status !== 'passed') process.exitCode = 1;
}

try {
  main();
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
