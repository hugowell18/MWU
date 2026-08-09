#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import JSZip from 'jszip';
import { runPathBPoc } from './run-path-b-poc.mjs';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(SCRIPT_DIR, '../..');
export const RECORDING_ID = 'Multilogue04_C_Level30_D1G4';
export const DEFAULT_POC_ROOT = path.join(ROOT, 'outputs', 'multilogue-v2-poc', RECORDING_ID);
export const POC_ROOT = path.resolve(process.env.MWU_V2_POC_ROOT || DEFAULT_POC_ROOT);
export const DELIVERY_DIR = path.join(POC_ROOT, 'delivery');
export const PROGRESS_PATH = path.join(DELIVERY_DIR, 'progress.json');
export const REPORT_PATH = path.join(DELIVERY_DIR, 'ui-report.json');
export const ZIP_PATH = path.join(DELIVERY_DIR, 'Multilogue04_PathB_PoC_Draft.zip');

const GATE_FILES = Object.freeze([
  'gates/G0-method-contract.json',
  'gates/G1-stage1-gate-exit.json',
  'gates/G2-path-b-gate-exit.json',
]);
const THRESHOLD_FILES = Object.freeze([
  'Multilogue04_C_Level30_D1G4.P025.draft.6tier.TextGrid',
  'flags.csv',
  'fto_transitions.csv',
  'transition_evidence.csv',
  'overlap-capability-evidence.json',
  'interaction_summary.csv',
  'nine_label_intervals.csv',
  'method-manifest.json',
  'timeline-validation.json',
  'run-summary.json',
]);
const FORBIDDEN_NAME = /(?:^|[._-])(final|reviewed|gold|attestation)(?:[._-]|$)/i;
const FORBIDDEN_CONTENT = [
  /\b(?:sk|pk|api)[_-](?:key|token)\b\s*[:=]/i,
  /https?:\/\/[^\s"']+/i,
  /\/Users\/|\/[A-Za-z0-9._-]+\/(?:home|root)\//i,
  /"(?:transcript|utterances)"\s*:/i,
  /"words"\s*:\s*\[/i,
];
export const PROGRESS_ORDER = Object.freeze(['phase_i_evidence', 'P025', 'P035', 'gate_qa', 'delivery_package']);

function now() {
  return new Date().toISOString();
}

function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

export function sha256File(file) {
  return sha256(readFileSync(file));
}

function writeJsonAtomic(file, value) {
  mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`);
  renameSync(temporary, file);
}

function sanitizeError(value) {
  if (!value) return null;
  return String(value).replaceAll(POC_ROOT, '[poc]').replaceAll(ROOT, '[repo]');
}

function progressSteps(events) {
  return PROGRESS_ORDER.map((key) => {
    const event = events.find((item) => item.key === key && item.status === 'passed');
    return event
      ? { key, status: 'passed', detail: event.detail, updated_at: event.occurred_at }
      : { key, status: 'pending', detail: 'Waiting', updated_at: null };
  });
}

function initializeProgress(startedAt) {
  const runId = `g3-${startedAt.replace(/[:.]/g, '-')}`;
  writeJsonAtomic(PROGRESS_PATH, {
    contract_version: 'multilogue-v2-progress-events-v1',
    run_id: runId,
    status: 'running',
    done: false,
    active_step: PROGRESS_ORDER[0],
    error: null,
    started_at: startedAt,
    updated_at: startedAt,
    events: [],
    steps: progressSteps([]),
  });
  return runId;
}

function readProgress() {
  return JSON.parse(readFileSync(PROGRESS_PATH, 'utf8'));
}

function proofForFile(file) {
  const absolute = path.resolve(file);
  if (!absolute.startsWith(`${path.resolve(POC_ROOT)}${path.sep}`) || !existsSync(absolute)) {
    throw new Error(`progress proof is outside the PoC root or missing: ${file}`);
  }
  return {
    path: path.relative(POC_ROOT, absolute).replaceAll(path.sep, '/'),
    bytes: readFileSync(absolute).length,
    sha256: sha256File(absolute),
  };
}

function appendProgressEvent(key, detail, artifactFiles) {
  const progress = readProgress();
  const expectedKey = PROGRESS_ORDER[progress.events.length];
  if (key !== expectedKey) throw new Error(`progress event ${key} is out of order; expected ${expectedKey}`);
  const previous = progress.events.at(-1) || null;
  const wallClock = Date.now();
  const previousMillis = previous ? Date.parse(previous.occurred_at) : Date.parse(progress.started_at) - 1;
  const occurredAt = new Date(Math.max(wallClock, previousMillis + 1)).toISOString();
  const payload = {
    sequence: progress.events.length + 1,
    key,
    status: 'passed',
    detail,
    occurred_at: occurredAt,
    artifacts: artifactFiles.map(proofForFile),
    previous_event_sha256: previous?.event_sha256 || null,
  };
  const event = { ...payload, event_sha256: sha256(Buffer.from(JSON.stringify(payload))) };
  const events = [...progress.events, event];
  const complete = events.length === PROGRESS_ORDER.length;
  writeJsonAtomic(PROGRESS_PATH, {
    ...progress,
    status: complete ? 'ready_draft' : 'running',
    done: complete,
    active_step: complete ? null : PROGRESS_ORDER[events.length],
    updated_at: occurredAt,
    events,
    steps: progressSteps(events),
  });
  return event;
}

function failProgress(error) {
  const progress = readProgress();
  writeJsonAtomic(PROGRESS_PATH, {
    ...progress,
    status: 'failed',
    done: true,
    error: sanitizeError(error),
    updated_at: now(),
  });
}

function runNode(script, args = []) {
  const result = spawnSync(process.execPath, [script, ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...process.env },
    timeout: 180000,
  });
  if (result.status !== 0) {
    const detail = `${result.stdout || ''}\n${result.stderr || ''}`.trim();
    throw new Error(`${path.basename(script)} failed${detail ? `: ${detail}` : ''}`);
  }
}

function readJson(relativePath) {
  return JSON.parse(readFileSync(path.join(POC_ROOT, relativePath), 'utf8'));
}

function assertSafeRelative(relativePath) {
  if (!relativePath || path.isAbsolute(relativePath) || relativePath.includes('..')) {
    throw new Error(`unsafe relative path: ${relativePath}`);
  }
  const absolute = path.resolve(POC_ROOT, relativePath);
  if (!absolute.startsWith(`${path.resolve(POC_ROOT)}${path.sep}`)) throw new Error(`path escaped PoC root: ${relativePath}`);
  return absolute;
}

export function deliverySourcePaths() {
  const paths = [...GATE_FILES];
  for (const key of ['P025', 'P035']) {
    for (const file of THRESHOLD_FILES) {
      const name = file.replace('.P025.', `.${key}.`);
      paths.push(`phase-ii/${key}/${name}`);
    }
  }
  return paths;
}

function scanSafeArtifact(relativePath, content) {
  if (FORBIDDEN_NAME.test(path.basename(relativePath))) throw new Error(`forbidden artifact name: ${relativePath}`);
  const ext = path.extname(relativePath).toLowerCase();
  if (!['.json', '.csv', '.textgrid', '.txt'].includes(ext)) throw new Error(`forbidden package type: ${relativePath}`);
  const text = content.toString('utf8');
  for (const rule of FORBIDDEN_CONTENT) {
    if (rule.test(text)) throw new Error(`safety scan failed for ${relativePath}: ${rule}`);
  }
}

function zipEntryName(relativePath) {
  return relativePath.replace(/^phase-ii\//, '').replace(/^gates\//, 'gates/');
}

function artifactRecord(id, relativePath, category, threshold = null) {
  const file = assertSafeRelative(relativePath);
  if (!existsSync(file)) throw new Error(`missing report artifact: ${relativePath}`);
  return {
    id,
    path: relativePath.replaceAll(path.sep, '/'),
    name: path.basename(file),
    category,
    threshold,
    bytes: readFileSync(file).length,
    sha256: sha256File(file),
  };
}

function deliveryReadme() {
  return [
    'Multilogue04 Path B PoC - Draft Integration Evidence',
    '',
    'Purpose',
    'This package demonstrates the local Phase I to Phase II processing handoff at P=0.25 s and P=0.35 s.',
    '',
    'Evidence boundary',
    '- Accuracy is unavailable because no researcher-reviewed Multilogue04 reference has been supplied.',
    '- The TextGrids and tables are drafts. They are not reviewed, final, gold, or research-ready data.',
    '- ol and x are unavailable as research observations in this draft.',
    '- Provider overlap candidates are review evidence only; overlap transitions use FTO=NA.',
    '- Simultaneity below 100 ms is retained as subthreshold evidence and never labelled ol.',
    '- The threshold review strategy is awaiting the research team.',
    '',
    'Contents',
    '- P025 and P035: one six-tier draft TextGrid, five CSV tables, overlap-capability evidence, method manifest, timeline validation, and run summary.',
    '- gates: G0, G1, and G2 gate reports.',
    '- delivery-manifest.json: checksums and package contract.',
    '',
  ].join('\n');
}

export async function buildDeliveryPackage({ outputPath = ZIP_PATH } = {}) {
  const sourcePaths = deliverySourcePaths();
  const sources = sourcePaths.map((relativePath) => {
    const file = assertSafeRelative(relativePath);
    if (!existsSync(file)) throw new Error(`required delivery source is missing: ${relativePath}`);
    const content = readFileSync(file);
    scanSafeArtifact(relativePath, content);
    return { relativePath, content, sha256: sha256(content), bytes: content.length };
  });
  const manifest = {
    contract_version: 'multilogue-v2.1-g3-delivery-v1',
    status: 'ready_draft',
    accuracy: 'unavailable',
    review_strategy: 'awaiting_research_team',
    recording: 'Multilogue04_C_Level30 D1G4.wav',
    path: 'B',
    contents: sources.map((item) => ({
      path: zipEntryName(item.relativePath),
      bytes: item.bytes,
      sha256: item.sha256,
    })),
    exclusions: ['audio', 'provider payloads', 'token evidence', 'transcript text', 'finalization artifacts'],
  };
  const manifestText = `${JSON.stringify(manifest, null, 2)}\n`;
  const readme = deliveryReadme();
  for (const [name, content] of [['delivery-manifest.json', Buffer.from(manifestText)], ['README.txt', Buffer.from(readme)]]) {
    scanSafeArtifact(name, content);
  }

  const zip = new JSZip();
  const zipDate = new Date('2000-01-01T00:00:00.000Z');
  for (const item of sources) zip.file(zipEntryName(item.relativePath), item.content, { date: zipDate, createFolders: false });
  zip.file('delivery-manifest.json', manifestText, { date: zipDate });
  zip.file('README.txt', readme, { date: zipDate });
  const buffer = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', compressionOptions: { level: 9 } });
  mkdirSync(path.dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, buffer);
  writeJsonAtomic(path.join(DELIVERY_DIR, 'delivery-manifest.json'), manifest);
  writeFileSync(path.join(DELIVERY_DIR, 'README.txt'), readme);
  return { path: outputPath, sha256: sha256(buffer), bytes: buffer.length, entries: sources.length + 2, manifest };
}

function thresholdReport(key, gate) {
  const summary = readJson(`phase-ii/${key}/run-summary.json`);
  const validation = readJson(`phase-ii/${key}/timeline-validation.json`);
  const prefix = `phase-ii/${key}`;
  const textgrid = THRESHOLD_FILES[0].replace('.P025.', `.${key}.`);
  const artifactSpecs = [
    ['textgrid', textgrid, 'textgrid'],
    ['labels', 'nine_label_intervals.csv', 'table'],
    ['flags', 'flags.csv', 'table'],
    ['transitions', 'fto_transitions.csv', 'table'],
    ['transition_evidence', 'transition_evidence.csv', 'evidence'],
    ['overlap_capability', 'overlap-capability-evidence.json', 'evidence'],
    ['summary', 'interaction_summary.csv', 'table'],
    ['method', 'method-manifest.json', 'evidence'],
    ['validation', 'timeline-validation.json', 'evidence'],
    ['run_summary', 'run-summary.json', 'evidence'],
  ];
  return {
    key,
    threshold_sec: summary.threshold_sec,
    status: 'draft_integration_evidence',
    accuracy: 'unavailable',
    flags_count: summary.flags_count,
    provisional_transfer_reviews: summary.path_b_counts.path_b_transfer_review_flags,
    transition_evidence: summary.transition_evidence,
    label_summary: summary.label_summary,
    praat: summary.praat_headless,
    timeline_validation: {
      status: validation.status || (gate.timeline_valid ? 'pass' : 'fail'),
      full_coverage: gate.timeline_valid === true,
      duration_sec: gate.timeline_duration_sec,
    },
    capabilities: summary.draft_observation_availability,
    artifacts: artifactSpecs.map(([suffix, file, category]) =>
      artifactRecord(`${key.toLowerCase()}_${suffix}`, `${prefix}/${file}`, category, key)),
  };
}

export function buildUiReport(zipResult, progress = readProgress()) {
  const g1 = readJson('gates/G1-stage1-gate-exit.json');
  const g2 = readJson('gates/G2-path-b-gate-exit.json');
  if (g1.status !== 'pass') throw new Error(`G1 gate is ${g1.status}; report blocked`);
  if (g2.status !== 'pass') throw new Error(`G2 gate is ${g2.status}; report blocked`);
  const thresholds = ['P025', 'P035'].map((key) => thresholdReport(key, g2.thresholds[key]));
  const artifacts = [
    ...thresholds.flatMap((threshold) => threshold.artifacts),
    ...GATE_FILES.map((file, index) => artifactRecord(`gate_g${index}`, file, 'gate')),
    artifactRecord('delivery_manifest', 'delivery/delivery-manifest.json', 'delivery'),
    artifactRecord('delivery_readme', 'delivery/README.txt', 'delivery'),
    artifactRecord('delivery_zip', 'delivery/Multilogue04_PathB_PoC_Draft.zip', 'package'),
  ];
  return {
    contract_version: 'multilogue-v2.1-g3-ui-report-v1',
    status: 'ready_draft',
    accuracy: 'unavailable',
    review_strategy: 'awaiting_research_team',
    package_status: 'draft_integration_evidence',
    input: {
      recording_name: 'Multilogue04_C_Level30 D1G4.wav',
      canonical_duration_sec: g1.canonical_timeline.duration_seconds,
      canonical_speakers: ['S1', 'S2', 'S3'],
      speaker_identity: 'temporary_processing_identifiers',
      provider_artifacts: 'cached_only',
      network_calls_performed: false,
    },
    pipeline: progress.steps,
    progress_run_id: progress.run_id,
    g1: {
      source_turns: g1.counts.retained_turns,
      words: g1.counts.words,
      assigned_words: g1.counts.stage1_known_events,
      unknown_residuals: g1.counts.unknown_events,
      overlap_candidates: g1.counts.provider_overlap_candidates,
      overlap_candidate_duration_sec: g1.counts.provider_overlap_candidate_duration_seconds,
      overlap_subthreshold: g1.counts.provider_overlap_subthreshold_count,
      overlap_subthreshold_duration_sec: g1.counts.provider_overlap_subthreshold_duration_seconds,
      review_flags: g1.counts.review_flags_entering_downstream,
    },
    overlap_candidates: {
      count: g2.input.provider_overlap_candidate_count,
      duration_sec: g2.input.provider_overlap_candidate_duration_sec,
      subthreshold_count: g2.input.provider_overlap_subthreshold_count,
      subthreshold_duration_sec: g2.input.provider_overlap_subthreshold_duration_sec,
      status: 'provider_candidates_requiring_researcher_review',
    },
    capabilities: {
      ol: 'unavailable_in_draft',
      x: 'unavailable_in_draft',
    },
    thresholds,
    delivery: {
      artifact_id: 'delivery_zip',
      name: path.basename(zipResult.path),
      bytes: zipResult.bytes,
      sha256: zipResult.sha256,
      entries: zipResult.entries,
    },
    artifacts,
    limitations: g2.open_risks,
  };
}

export async function runValidationPoc() {
  const startedAt = now();
  mkdirSync(DELIVERY_DIR, { recursive: true });
  rmSync(ZIP_PATH, { force: true });
  rmSync(REPORT_PATH, { force: true });
  initializeProgress(startedAt);
  try {
    runNode(path.join(SCRIPT_DIR, 'adapters', 'build-stage1-evidence.mjs'), [
      '--output-dir', path.join(POC_ROOT, 'phase-i'),
    ]);
    const g1 = readJson('gates/G1-stage1-gate-exit.json');
    if (g1.status !== 'pass') throw new Error(`G1 gate is ${g1.status}`);
    appendProgressEvent('phase_i_evidence', 'Local cached evidence normalized', [
      path.join(POC_ROOT, 'phase-i', 'stage1-evidence.json'),
      path.join(POC_ROOT, 'gates', 'G1-stage1-gate-exit.json'),
    ]);

    const thresholdEvents = [];
    runPathBPoc({
      inputPath: path.join(POC_ROOT, 'phase-i', 'stage1-evidence.json'),
      outputDir: path.join(POC_ROOT, 'phase-ii'),
      onThresholdComplete: ({ threshold_key: thresholdKey, artifacts }) => {
        thresholdEvents.push(thresholdKey);
        appendProgressEvent(thresholdKey, `Six-tier ${thresholdKey} draft validated`, artifacts);
      },
    });
    if (thresholdEvents.join(',') !== 'P025,P035') throw new Error('threshold completion callbacks were incomplete or out of order');
    const g2 = readJson('gates/G2-path-b-gate-exit.json');
    if (g2.status !== 'pass') throw new Error(`G2 gate is ${g2.status}`);

    const g0 = readJson('gates/G0-method-contract.json');
    if (g0.pass !== true) throw new Error('G0 gate did not pass');
    appendProgressEvent('gate_qa', 'G0, G1 and G2 passed', [
      path.join(POC_ROOT, 'gates', 'G0-method-contract.json'),
      path.join(POC_ROOT, 'gates', 'G1-stage1-gate-exit.json'),
      path.join(POC_ROOT, 'gates', 'G2-path-b-gate-exit.json'),
    ]);

    const zipResult = await buildDeliveryPackage();
    appendProgressEvent('delivery_package', `${zipResult.entries} safe ZIP entries`, [
      ZIP_PATH,
      path.join(DELIVERY_DIR, 'delivery-manifest.json'),
      path.join(DELIVERY_DIR, 'README.txt'),
    ]);
    const report = buildUiReport(zipResult, readProgress());
    writeJsonAtomic(REPORT_PATH, report);
    return report;
  } catch (error) {
    failProgress(error.message);
    throw error;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  runValidationPoc()
    .then((report) => process.stdout.write(`${JSON.stringify({ status: report.status, delivery: report.delivery })}\n`))
    .catch((error) => {
      process.stderr.write(`${error.stack || error.message}\n`);
      process.exitCode = 1;
    });
}
