import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import JSZip from 'jszip';
import ExcelJS from 'exceljs/lib/exceljs.nodejs.js';

import { CONFIG, INPUTS, ROOT } from '../../scripts/validation-sprint/config.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RUNNER = path.join(__dirname, '..', '..', 'scripts', 'l1b', 'run-l1b.mjs');
const FINALIZER = path.join(__dirname, '..', '..', 'scripts', 'l1b', 'finalize-reviewed.mjs');
const cases = [];

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function test(name, fn) {
  try {
    await fn();
    cases.push({ name, status: 'passed' });
    console.log(`  PASS ${name}`);
  } catch (error) {
    cases.push({ name, status: 'failed', detail: error.message });
    console.log(`  FAIL ${name}: ${error.message}`);
  }
}

function fixture(root, invalidText = '1.000000\t2.000000\n3.250000\t4.500000\n') {
  const invalidFiles = ['SPEAKER_00', 'SPEAKER_01', 'SPEAKER_02'].map((speaker) => {
    const file = path.join(root, `${speaker}.invalid_intervals.tsv`);
    fs.writeFileSync(file, invalidText);
    return { speaker, file };
  });
  const manifest = {
    generated_at: '2026-07-13T00:00:00.000Z',
    source: 'test_fixture',
    source_audio: path.join(root, 'Synthetic_Multilogue.wav'),
    duration_seconds: 183.1792290249433,
    phase_ii_handoff: {
      ready: true,
      expected_labels: ['sounding', 'silent', 'invalid'],
      inputs: invalidFiles.map(({ speaker, file }) => ({
        speaker: `speaker_${speaker}`,
        wav: INPUTS.wav,
        invalid_intervals_tsv: file,
      })),
    },
  };
  const manifestPath = path.join(root, 'fixture.phase1_manifest.json');
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  return manifestPath;
}

function run(manifest, out, progress) {
  return spawnSync(process.execPath, [RUNNER, '--manifest', manifest, '--out', out, '--thresholds', '0.25,0.35', '--progress', progress], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 120000,
  });
}

function finalize(draftReport, reviewsDir, out, progress) {
  return spawnSync(process.execPath, [
    FINALIZER,
    '--draft-report', draftReport,
    '--reviews-dir', reviewsDir,
    '--out', out,
    '--reviewer', 'TEST_RATER',
    '--review-confirmed', 'true',
    '--progress', progress,
  ], { cwd: ROOT, encoding: 'utf8', timeout: 120000 });
}

function thresholdLabel(value) {
  return Number(value).toFixed(2).replace(/0+$/, '').replace(/\.$/, '');
}

async function main() {
  console.log('L1B TESTS');
  if (!fs.existsSync(CONFIG.praat.binary)) {
    console.log(`  SKIP Praat unavailable at ${CONFIG.praat.binary}`);
    process.exit(0);
  }

  await test('draft generation plus reviewed finalization satisfy the six-TextGrid and post-review workbook contract', async () => {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'mwu-l1b-'));
    try {
      const manifest = fixture(temp);
      const out = path.join(temp, 'output');
      const progress = path.join(temp, 'progress.json');
      const result = run(manifest, out, progress);
      assert(result.status === 0, `runner exited ${result.status}: ${result.stderr}`);

      const report = JSON.parse(fs.readFileSync(path.join(out, 'l1b_report.json'), 'utf8'));
      assert(report.status === 'ready_for_praat_review', `status=${report.status}`);
      assert(report.qa.passed && report.qa.jobs_passed === 6 && report.qa.jobs_total === 6, JSON.stringify(report.qa));
      assert(report.artifacts.filter((artifact) => artifact.group === 'textgrids').length === 6, 'expected 6 TextGrid artifacts');
      assert(report.summary.every((row) => row['Minimum silent pause (s)'] >= row['Threshold (s)'] - 0.00001), 'sub-threshold pause remained');

      const workbook = report.artifacts.find((artifact) => artifact.group === 'metrics');
      const delivery = report.artifacts.find((artifact) => artifact.group === 'package');
      assert(fs.existsSync(workbook.path) && fs.statSync(workbook.path).size > 10000, 'duration workbook missing/small');
      assert(fs.existsSync(delivery.path) && fs.statSync(delivery.path).size > 10000, 'delivery zip missing/small');

      const zip = await JSZip.loadAsync(fs.readFileSync(delivery.path));
      const names = Object.keys(zip.files).filter((name) => !zip.files[name].dir);
      assert(names.filter((name) => name.endsWith('.TextGrid')).length === 6, `zip TextGrid count=${names.length}`);
      assert(names.some((name) => name.endsWith('_pre_review_diagnostics.xlsx')), 'zip diagnostic workbook missing');
      assert(names.includes('DRAFT_REVIEW_NOTES.txt'), 'zip draft review notes missing');

      const state = JSON.parse(fs.readFileSync(progress, 'utf8'));
      assert(state.done && state.status === 'ready_for_praat_review' && state.completed_jobs === 6, 'progress did not finish cleanly');

      const reviewsDir = path.join(out, 'reviewed-inputs');
      fs.mkdirSync(reviewsDir, { recursive: true });
      for (const job of report.jobs) {
        const target = `${report.recording_id}_${job.speaker}_${thresholdLabel(job.threshold)}s.TextGrid`;
        fs.copyFileSync(job.textgrid, path.join(reviewsDir, target));
      }
      const finalOut = path.join(out, 'reviewed-final');
      const finalProgress = path.join(finalOut, 'progress.json');
      const finalized = finalize(path.join(out, 'l1b_report.json'), reviewsDir, finalOut, finalProgress);
      assert(finalized.status === 0, `finalizer exited ${finalized.status}: ${finalized.stderr}`);

      const finalReport = JSON.parse(fs.readFileSync(path.join(finalOut, 'l1b_final_report.json'), 'utf8'));
      assert(finalReport.status === 'reviewed_ready', `final status=${finalReport.status}`);
      assert(finalReport.qa.passed && finalReport.qa.reviewed_textgrids === 6, JSON.stringify(finalReport.qa));
      const reviewedGrids = finalReport.artifacts.filter((artifact) => artifact.group === 'reviewed_textgrids');
      assert(reviewedGrids.length === 6, `reviewed TextGrid count=${reviewedGrids.length}`);
      assert(reviewedGrids.every((artifact) => !artifact.name.includes('.draft.') && artifact.name.startsWith(report.recording_id)), 'reviewed naming contract failed');
      assert(finalReport.artifacts.some((artifact) => artifact.name === 'duration_summary.xlsx' && artifact.group === 'duration_summary'), 'duration_summary.xlsx missing');
      assert(finalReport.artifacts.some((artifact) => artifact.name === 'per_pause_method_log.xlsx' && artifact.group === 'per_pause_method'), 'per_pause_method_log.xlsx missing');

      const durationArtifact = finalReport.artifacts.find((artifact) => artifact.group === 'duration_summary');
      const durationBook = new ExcelJS.Workbook();
      await durationBook.xlsx.readFile(durationArtifact.path);
      assert(JSON.stringify(durationBook.worksheets.map((sheet) => sheet.name)) === JSON.stringify(['Duration Summary']), 'duration summary workbook contract changed');
      assert(durationBook.getWorksheet('Duration Summary').rowCount === 7, 'duration summary must have one header plus six speaker-threshold rows');

      const perPauseArtifact = finalReport.artifacts.find((artifact) => artifact.group === 'per_pause_method');
      const perPauseBook = new ExcelJS.Workbook();
      await perPauseBook.xlsx.readFile(perPauseArtifact.path);
      assert(JSON.stringify(perPauseBook.worksheets.map((sheet) => sheet.name)) === JSON.stringify(['Per-pause', 'Method']), 'per-pause/method workbook contract changed');
      const methodSheet = perPauseBook.getWorksheet('Method');
      assert(methodSheet.getRow(1).values.slice(1).join('|') === 'Parameter|Artifact|Value', 'method log columns changed');
      const methodRows = methodSheet.getRows(2, methodSheet.rowCount - 1);
      const windowRow = methodRows.find((row) => row.getCell(1).value === 'window_size_seconds');
      assert(String(windowRow?.getCell(3).value) === '200', 'method log does not record the 200 s window');
      assert(methodRows.some((row) => String(row.getCell(3).value).includes('Praat')), 'method log does not record the Praat version');
      assert(methodRows.filter((row) => row.getCell(1).value === 'reviewed_textgrid_sha256').length === 6, 'method log must record one checksum per reviewed TextGrid');

      const finalPackage = finalReport.artifacts.find((artifact) => artifact.group === 'final_package');
      const finalZip = await JSZip.loadAsync(fs.readFileSync(finalPackage.path));
      const finalNames = Object.keys(finalZip.files).filter((name) => !finalZip.files[name].dir);
      assert(finalNames.filter((name) => name.endsWith('.TextGrid')).length === 6, `final ZIP TextGrid count=${finalNames.length}`);
      assert(finalNames.includes('duration_summary.xlsx'), 'final ZIP duration summary missing');
      assert(finalNames.includes('per_pause_method_log.xlsx'), 'final ZIP per-pause/method missing');
      assert(!finalNames.some((name) => name.includes('.draft.')), 'final ZIP contains draft filenames');
    } finally {
      fs.rmSync(temp, { recursive: true, force: true });
    }
  });

  await test('invalid Phase-I range blocks the run and creates no client package', async () => {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'mwu-l1b-bad-'));
    try {
      const manifest = fixture(temp, '4.000000\t2.000000\n');
      const out = path.join(temp, 'output');
      const progress = path.join(temp, 'progress.json');
      const result = run(manifest, out, progress);
      assert(result.status !== 0, 'bad invalid range should fail');
      const report = JSON.parse(fs.readFileSync(path.join(out, 'l1b_report.json'), 'utf8'));
      assert(report.status === 'failed' && /valid start\/end range/.test(report.error), `unexpected report: ${JSON.stringify(report)}`);
      assert(!fs.readdirSync(out).some((name) => name.endsWith('.zip')), 'failed run created a delivery zip');
    } finally {
      fs.rmSync(temp, { recursive: true, force: true });
    }
  });

  const summary = {
    suite: 'l1b',
    passed: cases.filter((item) => item.status === 'passed').length,
    failed: cases.filter((item) => item.status === 'failed').length,
    cases,
    generated_at: new Date().toISOString(),
  };
  console.log(`\nL1B: ${summary.passed} passed / ${summary.failed} failed`);
  process.exit(summary.failed ? 1 : 0);
}

main();
