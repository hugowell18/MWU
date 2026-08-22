#!/usr/bin/env node

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import ExcelJS from 'exceljs';
import JSZip from 'jszip';

import { verifySealedManifest } from '../l1a/review-core.mjs';
import { assessL1aPathBReadiness } from '../l1a/build-path-b-evidence.mjs';
import { generateFrozenBlindDraft } from '../multilogue-v2/blind/generate-frozen-v23-blind-draft.mjs';
import { phonationIncluded, round } from '../multilogue-v2/core/contracts.mjs';
import { parseSixTierTextGridFile } from '../multilogue-v2/io/parse-six-tier-textgrid.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const LABELS = Object.freeze(['s', 'f', 'bc', 'ol', 'op', 'pf', 'tr', 'shs', 'x']);
const PAUSE_LABELS = new Set(['op', 'tr', 'shs']);

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function parseThresholds(value) {
  const thresholds = [...new Set(String(value || '0.25,0.35').split(',')
    .map(Number).filter((item) => item > 0 && item < 5))].sort((a, b) => a - b);
  if (!thresholds.length) throw new Error('at least one pause threshold is required');
  return thresholds;
}

function deliveryThresholdKey(value) {
  return `P${Math.round(Number(value) * 100).toString().padStart(3, '0')}`;
}

function parseArgs(argv) {
  const options = {};
  const fields = new Map([
    ['--manifest', 'manifest'],
    ['--stage1', 'stage1'],
    ['--mapping', 'mapping'],
    ['--out', 'out'],
    ['--thresholds', 'thresholds'],
    ['--progress', 'progress'],
    ['--latest-pointer', 'latestPointer'],
  ]);
  for (let index = 2; index < argv.length; index += 1) {
    const field = fields.get(argv[index]);
    if (!field || !argv[index + 1]) throw new Error(`unknown or incomplete argument: ${argv[index]}`);
    options[field] = field === 'thresholds' ? argv[index + 1] : path.resolve(argv[index + 1]);
    index += 1;
  }
  return options;
}

function acceptedContract(manifestFile, stage1File, mappingFile) {
  for (const file of [manifestFile, stage1File, mappingFile]) {
    if (!file || !fs.existsSync(file)) throw new Error(`required L1b input is missing: ${file || 'unspecified'}`);
  }
  const sealed = verifySealedManifest(manifestFile);
  if (!sealed.ok) throw new Error(`L1a sealed evidence failed: ${sealed.failures.map((item) => item.reason).join(', ')}`);
  const pathBReadiness = assessL1aPathBReadiness({ manifestPath: manifestFile });
  if (!pathBReadiness.passed) {
    throw new Error(`L1a Path B evidence failed: ${pathBReadiness.blockers.map((item) => item.code).join(', ')}`);
  }
  const pathBArtifacts = new Map(
    (pathBReadiness.base_handoff_gate?.paths?.handoff
      ? readJson(pathBReadiness.base_handoff_gate.paths.handoff).path_b_gate?.artifacts
      : [])?.map((item) => [item.role, item]) || [],
  );
  const sameFile = (left, right) => {
    try { return fs.realpathSync.native(left) === fs.realpathSync.native(right); }
    catch { return path.resolve(left) === path.resolve(right); }
  };
  if (!sameFile(pathBArtifacts.get('stage1_evidence')?.path || '', stage1File)) {
    throw new Error('Stage-1 evidence is not the sealed L1a Path B artifact');
  }
  if (!sameFile(pathBArtifacts.get('provider_mapping')?.path || '', mappingFile)) {
    throw new Error('Provider mapping is not the sealed L1a Path B artifact');
  }
  const manifest = readJson(manifestFile);
  if (manifest.lifecycle?.status !== 'accepted' || manifest.phase_ii_handoff?.ready !== true) {
    throw new Error('L1a handoff is not accepted and ready');
  }
  const stage1 = readJson(stage1File);
  const mapping = readJson(mappingFile);
  const speakers = [...(manifest.speakers || [])];
  const expected = speakers.map((_, index) => `S${index + 1}`);
  if (speakers.join(',') !== expected.join(',')) throw new Error(`L1a canonical speakers must be contiguous: ${expected.join(', ')}`);
  if (stage1.recordingId !== manifest.recording_id) throw new Error('L1a recording_id does not match Stage-1 evidence');
  if (Math.abs(Number(stage1.duration) - Number(manifest.duration_seconds)) > 0.001) {
    throw new Error('L1a canonical duration does not match Stage-1 evidence');
  }
  for (const provider of ['pyannote', 'assemblyai']) {
    const targets = Object.values(mapping.mapping?.[provider] || {}).sort();
    if (targets.join(',') !== [...speakers].sort().join(',')) throw new Error(`${provider} mapping is not bijective onto accepted S1-SN`);
  }
  return { manifest, stage1, mapping, speakers, sealed, pathBReadiness };
}

function tierByName(document, name) {
  const tier = document.tiers.find((item) => item.name === name);
  if (!tier) throw new Error(`TextGrid tier is missing: ${name}`);
  return tier;
}

function valueAt(tier, time) {
  return tier.intervals.find((item) => time >= item.start - 1e-9 && time < item.end - 1e-9)?.text
    ?? tier.intervals.at(-1)?.text
    ?? '';
}

function csvCell(value) {
  const text = value == null ? '' : String(value);
  return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function writeCsv(file, headers, rows) {
  const lines = [headers.map(csvCell).join(',')];
  for (const row of rows) lines.push(headers.map((key) => csvCell(row[key])).join(','));
  fs.writeFileSync(file, `${lines.join('\n')}\n`, 'utf8');
}

function tabularArtifacts({ document, recordingId, threshold, runtimeEvidence, directory, speakers }) {
  const floorTier = tierByName(document, 'floor');
  const flagsTier = tierByName(document, 'flags');
  const nineRows = [];
  const pauseRows = [];
  const summaryRows = [];
  for (const speaker of speakers) {
    const tier = tierByName(document, speaker);
    const totals = Object.fromEntries(LABELS.map((label) => [label, 0]));
    const counts = Object.fromEntries(LABELS.map((label) => [label, 0]));
    for (const interval of tier.intervals) {
      const duration = interval.end - interval.start;
      totals[interval.text] = (totals[interval.text] || 0) + duration;
      counts[interval.text] = (counts[interval.text] || 0) + 1;
      const midpoint = (interval.start + interval.end) / 2;
      nineRows.push({
        recording_id: recordingId,
        threshold_sec: threshold,
        speaker,
        start_sec: round(interval.start),
        end_sec: round(interval.end),
        duration_sec: round(duration),
        label: interval.text,
        floor: valueAt(floorTier, midpoint),
        phonation_included_default: phonationIncluded(interval.text) ? 'true' : 'false',
        review_required: interval.text === 'ol' || interval.text === 'x' ? 'true' : 'false',
      });
      if (PAUSE_LABELS.has(interval.text)) {
        pauseRows.push({
          recording_id: recordingId,
          threshold_sec: threshold,
          speaker,
          pause_type: interval.text,
          start_sec: round(interval.start),
          end_sec: round(interval.end),
          duration_sec: round(duration),
          floor: valueAt(floorTier, midpoint),
        });
      }
    }
    summaryRows.push({
      recording_id: recordingId,
      threshold_sec: threshold,
      speaker,
      total_duration_sec: round(document.xmax),
      phonation_time_sec: round(totals.s + totals.f + totals.ol),
      ...Object.fromEntries(LABELS.map((label) => [`${label}_sec`, round(totals[label])])),
      op_count: counts.op,
      bc_count: counts.bc,
      ol_count: counts.ol,
    });
  }
  const transitionRows = (runtimeEvidence.semantic_lane?.interaction_diagnostics?.transition_evidence || []).map((item) => ({
    recording_id: recordingId,
    threshold_sec: threshold,
    sequence: item.sequence,
    from_speaker: item.from,
    to_speaker: item.to,
    turn_end_sec: item.turn_end,
    turn_start_sec: item.turn_start,
    raw_gap_sec: item.raw_gap,
    overlap_start_sec: item.overlap_start,
    overlap_end_sec: item.overlap_end,
    overlap_duration_sec: item.overlap_duration,
    overlap_class: item.overlap_class,
    evidence_source: item.evidence_source,
    evidence_ids: (item.evidence_ids || []).join('|'),
    fto_status: item.fto_status,
    review_required: item.review_required ? 'true' : 'false',
  }));
  const flagRows = flagsTier.intervals.filter((item) => item.text).map((item) => ({
    recording_id: recordingId,
    threshold_sec: threshold,
    start_sec: round(item.start),
    end_sec: round(item.end),
    duration_sec: round(item.end - item.start),
    flags: item.text,
  }));
  const files = {
    nine: path.join(directory, 'nine_label_intervals.csv'),
    summary: path.join(directory, 'interaction_summary.csv'),
    pauses: path.join(directory, 'per_pause.csv'),
    transitions: path.join(directory, 'transition_evidence.csv'),
    overlap: path.join(directory, 'overlap-capability-evidence.json'),
    flags: path.join(directory, 'flags.csv'),
  };
  writeCsv(files.nine, Object.keys(nineRows[0] || {}), nineRows);
  writeCsv(files.summary, Object.keys(summaryRows[0] || {}), summaryRows);
  writeCsv(files.pauses, Object.keys(pauseRows[0] || {}), pauseRows);
  writeCsv(files.transitions, Object.keys(transitionRows[0] || {}), transitionRows);
  writeCsv(files.flags, Object.keys(flagRows[0] || { recording_id: '' }), flagRows);
  writeJson(files.overlap, {
    contract_version: 'mwu-path-b-overlap-capability-v1',
    path: 'B',
    threshold_sec: threshold,
    policy: 'overlap_present_with_offset_not_measured',
    provider_overlap_count: runtimeEvidence.semantic_lane?.interaction_diagnostics?.overlap_evidence_count ?? 0,
    transition_evidence: transitionRows.filter((item) => item.overlap_class !== 'none'),
  });
  return { files, nineRows, summaryRows, pauseRows, transitionRows, flagRows };
}

async function buildWorkbook(file, rows, methodRows) {
  const workbook = new ExcelJS.Workbook();
  for (const [name, values] of Object.entries(rows)) {
    const sheet = workbook.addWorksheet(name);
    const headers = Object.keys(values[0] || {});
    sheet.columns = headers.map((header) => ({ header, key: header, width: Math.min(32, Math.max(12, header.length + 2)) }));
    values.forEach((value) => sheet.addRow(value));
    sheet.views = [{ state: 'frozen', ySplit: 1 }];
    sheet.getRow(1).font = { bold: true };
    sheet.autoFilter = headers.length ? { from: 'A1', to: `${columnName(headers.length)}1` } : undefined;
  }
  const method = workbook.addWorksheet('Method');
  method.columns = [{ header: 'Parameter', key: 'parameter', width: 34 }, { header: 'Value', key: 'value', width: 90 }];
  methodRows.forEach((row) => method.addRow(row));
  method.getRow(1).font = { bold: true };
  await workbook.xlsx.writeFile(file);
}

function columnName(value) {
  let result = '';
  for (let index = value; index > 0; index = Math.floor((index - 1) / 26)) result = String.fromCharCode(65 + ((index - 1) % 26)) + result;
  return result;
}

async function buildZip(file, artifacts) {
  const zip = new JSZip();
  for (const artifact of artifacts) zip.file(path.basename(artifact), fs.readFileSync(artifact));
  fs.writeFileSync(file, await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', compressionOptions: { level: 6 } }));
}

function thresholdTextGridName(recordingId, threshold) {
  return `${recordingId}_${Number(threshold).toFixed(2)}s.TextGrid`;
}

export async function runPathBL1b({ manifest, stage1, mapping, out, thresholds = [0.25, 0.35], progress, latestPointer } = {}) {
  const thresholdList = Array.isArray(thresholds) ? thresholds : parseThresholds(thresholds);
  const contract = acceptedContract(manifest, stage1, mapping);
  if (fs.existsSync(out)) throw new Error(`L1b output revision already exists: ${out}`);
  fs.mkdirSync(out, { recursive: true });
  const progressState = { status: 'running', done: false, recording_id: contract.manifest.recording_id, thresholds: thresholdList, completed: 0, total: thresholdList.length };
  if (progress) writeJson(progress, progressState);
  const all = { summary: [], pauses: [], transitions: [] };
  const thresholdReports = [];
  for (const threshold of thresholdList) {
    const key = deliveryThresholdKey(threshold);
    const directory = path.join(out, key);
    const generated = generateFrozenBlindDraft({
      recordingId: contract.manifest.recording_id,
      stage1File: stage1,
      acousticManifestFile: manifest,
      mappingFile: mapping,
      outputDir: directory,
      pauseThresholdSeconds: threshold,
      textGridFilename: thresholdTextGridName(contract.manifest.recording_id, threshold),
    });
    const document = parseSixTierTextGridFile(generated.textGridFile);
    const runtimeEvidenceFile = path.join(directory, 'runtime-evidence.json');
    const runtimeEvidence = readJson(runtimeEvidenceFile);
    const tables = tabularArtifacts({ document, recordingId: contract.manifest.recording_id, threshold, runtimeEvidence, directory, speakers: contract.speakers });
    all.summary.push(...tables.summaryRows);
    all.pauses.push(...tables.pauseRows);
    all.transitions.push(...tables.transitionRows);
    const artifacts = [generated.textGridFile, runtimeEvidenceFile, path.join(directory, 'method-manifest.json'), path.join(directory, 'validation-summary.json'), path.join(directory, 'artifact-hashes.json'), ...Object.values(tables.files)];
    thresholdReports.push({
      threshold_sec: threshold,
      threshold_key: key,
      status: generated.status,
      textgrid: generated.textGridFile,
      speaker_count: contract.speakers.length,
      tier_count: contract.speakers.length + 3,
      schema_valid: generated.validation.valid,
      tier5_consistent: generated.tier5Consistency.pass,
      transition_count: generated.summary.transition_point_count,
      files: artifacts.map((file) => ({ path: file, sha256: sha256(file), bytes: fs.statSync(file).size })),
    });
    progressState.completed += 1;
    if (progress) writeJson(progress, progressState);
  }
  const workbook = path.join(out, `${contract.manifest.recording_id}_L1b_Draft_Diagnostics.xlsx`);
  await buildWorkbook(workbook, { Summary: all.summary, 'Per pause': all.pauses, Transitions: all.transitions }, [
    { parameter: 'Layer', value: 'L1b' },
    { parameter: 'Method', value: 'Frozen v2.3 Path B; R1-R5' },
    { parameter: 'Thresholds seconds', value: thresholdList.join(', ') },
    { parameter: 'Canonical source WAV SHA-256', value: contract.manifest.sealed_evidence.source_wav.sha256 },
    { parameter: 'L1a manifest SHA-256', value: sha256(manifest) },
    { parameter: 'Stage-1 evidence SHA-256', value: sha256(stage1) },
    { parameter: 'Research status', value: 'Automatic draft awaiting Praat/researcher correction' },
  ]);
  const reviewNotes = path.join(out, 'README_L1b_Praat_Review.txt');
  fs.writeFileSync(reviewNotes, [
    'MWU Layer 1b Praat draft package',
    '',
    `Recording: ${contract.manifest.recording_id}`,
    `Canonical speakers: ${contract.speakers.join(', ')}`,
    `Pause thresholds: ${thresholdList.map((value) => `${value.toFixed(2)} s`).join(', ')}`,
    `TextGrid contract: dynamic N+3 (${contract.speakers.length + 3} tiers for this run)`,
    '',
    'Research boundary:',
    '- The TextGrids are automatic drafts for correction in local Praat.',
    '- The workbook is pre-review diagnostic evidence, not final research data.',
    '- Save the researcher-corrected TextGrid locally, then upload it as the Layer 2 input.',
    '- Technical method evidence and hashes remain retained in the server session archive.',
    '',
  ].join('\n'), 'utf8');
  const deliveryArtifacts = [
    ...thresholdReports.map((item) => item.textgrid),
    workbook,
    reviewNotes,
  ];
  const packageFile = path.join(out, `${contract.manifest.recording_id}_L1b_Praat_Draft.zip`);
  await buildZip(packageFile, deliveryArtifacts);
  const report = {
    schema_version: 'mwu-l1b-path-b-report-v1',
    status: 'ready_for_praat_review',
    generated_at: new Date().toISOString(),
    recording_id: contract.manifest.recording_id,
    session_id: contract.manifest.session_id,
    source_manifest: manifest,
    source_manifest_sha256: sha256(manifest),
    source_stage1: stage1,
    source_stage1_sha256: sha256(stage1),
    speakers: contract.speakers,
    speaker_count: contract.speakers.length,
    tier_count: contract.speakers.length + 3,
    thresholds: thresholdList,
    duration_seconds: Number(contract.manifest.duration_seconds),
    handoff_gate: {
      passed: true,
      l1a_identity_sha256: contract.sealed.sealed_handoff_identity?.identity_sha256 || null,
      path_b_identity_sha256: contract.pathBReadiness.sealed_evidence_identity?.identity_sha256 || null,
    },
    threshold_reports: thresholdReports,
    delivery_package_contents: deliveryArtifacts.map((file) => ({
      name: path.basename(file),
      path: file,
      sha256: sha256(file),
      bytes: fs.statSync(file).size,
    })),
    artifacts: [
      ...thresholdReports.flatMap((item) => item.files.map((file) => ({ ...file, threshold: item.threshold_sec, group: path.basename(file.path).includes('TextGrid') ? 'textgrids' : 'evidence' }))),
      { path: workbook, group: 'metrics', sha256: sha256(workbook), bytes: fs.statSync(workbook).size },
      { path: reviewNotes, group: 'package_note', sha256: sha256(reviewNotes), bytes: fs.statSync(reviewNotes).size },
      { path: packageFile, group: 'package', sha256: sha256(packageFile), bytes: fs.statSync(packageFile).size },
    ],
    review_boundary: 'Automatic draft. Researcher correction in Praat is required before final research use.',
  };
  const reportFile = path.join(out, 'l1b_report.json');
  writeJson(reportFile, report);
  if (latestPointer) writeJson(latestPointer, { report: reportFile, out_dir: out, updated_at: report.generated_at });
  if (progress) writeJson(progress, { ...progressState, status: report.status, done: true, report: reportFile });
  return { report, reportFile, packageFile };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const options = parseArgs(process.argv);
    const result = await runPathBL1b({
      manifest: options.manifest,
      stage1: options.stage1,
      mapping: options.mapping,
      out: options.out,
      thresholds: parseThresholds(options.thresholds),
      progress: options.progress,
      latestPointer: options.latestPointer,
    });
    process.stdout.write(`${JSON.stringify({ ok: true, report: result.reportFile, package: result.packageFile }, null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`${error.stack || error.message}\n`);
    process.exitCode = 1;
  }
}
