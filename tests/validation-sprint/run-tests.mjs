// Validation Sprint — unit + integration tests (no external runner).
// Writes unit-test-results.json + integration-test-results.json into the output test-results dir.
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { INPUTS, CONFIG, OUT_DIR, thresholdDirName } from '../../scripts/validation-sprint/config.mjs';
import { readText } from '../../scripts/validation-sprint/lib/fsutil.mjs';
import { parseTextGrid } from '../../scripts/validation-sprint/lib/textgrid.mjs';
import { findTier, aggregate, segmentsFromTier, summarize } from '../../scripts/validation-sprint/lib/durations.mjs';
import { readBaseline } from '../../scripts/validation-sprint/lib/excel-baseline.mjs';
import { compare } from '../../scripts/validation-sprint/lib/comparator.mjs';
import { praatAvailable } from '../../scripts/validation-sprint/lib/praat.mjs';
import { segmentDurations } from '../../scripts/validation-sprint/lib/script2.mjs';
import { splitTranscript, validateAgainstMaster } from '../../scripts/validation-sprint/lib/transcript-split.mjs';
import { wer } from '../../scripts/validation-sprint/lib/wer.mjs';
import { buildMatrix, matrixColumns } from '../../scripts/validation-sprint/lib/matrix.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RUN_SPRINT = path.join(__dirname, '..', '..', 'scripts', 'validation-sprint', 'run-sprint.mjs');
const TOL = CONFIG.tolerances.duration;

function makeSuite(name) {
  const cases = [];
  const t = (label, fn) => {
    try {
      fn();
      cases.push({ name: label, status: 'passed' });
      console.log(`  ✅ ${label}`);
    } catch (e) {
      cases.push({ name: label, status: 'failed', detail: e.message });
      console.log(`  ❌ ${label} — ${e.message}`);
    }
  };
  const summary = () => ({
    suite: name,
    passed: cases.filter((c) => c.status === 'passed').length,
    failed: cases.filter((c) => c.status === 'failed').length,
    cases,
  });
  return { t, summary };
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}
function near(a, b, tol = TOL, msg = '') {
  if (Math.abs(a - b) > tol) throw new Error(`${msg} |${a} - ${b}| = ${Math.abs(a - b)} > ${tol}`);
}

// ----------------------------- UNIT -----------------------------
async function unit() {
  console.log('UNIT TESTS');
  const { t, summary } = makeSuite('unit');
  const grid = parseTextGrid(readText(INPUTS.textgrid));
  const tier = findTier(grid, 'silences');
  const agg = aggregate(tier);
  const baseline = await readBaseline(INPUTS.workbook);

  t('TextGrid parser: tier count = 1', () => assert(grid.tiers.length === 1, `got ${grid.tiers.length}`));
  t('TextGrid parser: tier name = silences', () => assert(tier.name === 'silences', `got ${tier.name}`));
  t('TextGrid parser: interval count = 121', () => assert(agg.interval_count === 121, `got ${agg.interval_count}`));
  t('TextGrid parser: sounding count = 61', () => assert(agg.sounding_count === 61, `got ${agg.sounding_count}`));
  t('TextGrid parser: silent count = 60', () => assert(agg.silent_count === 60, `got ${agg.silent_count}`));
  t('TextGrid parser: total sounding = 133.19652983384853', () => near(agg.total_sounding, 133.19652983384853, TOL, 'sounding'));
  t('TextGrid parser: total silent = 49.98269919109479', () => near(agg.total_silent, 49.98269919109479, TOL, 'silent'));
  t('TextGrid parser: total duration = 183.1792290249433', () => near(agg.total_duration, 183.1792290249433, TOL, 'duration'));

  t('No export-time refilter: silent < 0.25s still counted (min ~0.2468, count stays 60)', () => {
    const sub = agg.segments.filter((s) => s.label === 'silent' && s.duration < 0.25);
    assert(sub.length >= 1, 'expected at least one sub-0.25 silent interval');
    assert(agg.silent_count === 60, `silent count changed to ${agg.silent_count}`);
    near(agg.min_silent, 0.246807, 0.0005, 'min silent');
  });

  t('Excel reader: sheets are Durations + Fluency measures', () => {
    assert(baseline.sheets.includes('Durations') && baseline.sheets.includes('Fluency measures'), JSON.stringify(baseline.sheets));
  });
  t('Excel reader: SpeakerX col B values read (60 pauses, 535 syllables)', () => {
    assert(baseline.silent_pauses === 60 && baseline.syllables === 535, `pauses=${baseline.silent_pauses} syll=${baseline.syllables}`);
  });
  t('Excel reader: no 0.35 gold threshold columns', () => assert(baseline.has_035_gold === false, 'has_035_gold should be false'));

  t('Comparator: exact silent count match = 60', () => {
    const c = compare(agg, baseline, CONFIG.tolerances);
    const row = c.rows.find((r) => r.metric === 'No. of silent pauses');
    assert(row.pass && row.ours === 60, JSON.stringify(row));
  });
  t('Comparator: all duration deltas <= 0.001 and status passed', () => {
    const c = compare(agg, baseline, CONFIG.tolerances);
    assert(c.status === 'passed', 'status not passed');
    for (const r of c.rows.filter((r) => r.tolerance.startsWith('<='))) assert(r.delta <= 0.001, `${r.metric} delta ${r.delta}`);
  });
  t('Comparator: corrupted count must FAIL (not silently pass)', () => {
    const bad = { ...agg, silent_count: 59 };
    const c = compare(bad, baseline, CONFIG.tolerances);
    assert(c.status === 'failed', 'comparator should fail on mismatch');
  });
  t('Comparator: corrupted duration (+0.01s) must FAIL', () => {
    const bad = { ...agg, total_sounding: agg.total_sounding + 0.01 };
    const c = compare(bad, baseline, CONFIG.tolerances);
    assert(c.status === 'failed', 'comparator should fail on duration drift');
  });

  t('Threshold config: thresholds_sec is an array', () => assert(Array.isArray(CONFIG.thresholds_sec)));
  t('Threshold config: [0.25,0.35] dir names', () => {
    assert(thresholdDirName(0.25) === 'threshold_0.25' && thresholdDirName(0.35) === 'threshold_0.35');
  });
  t('Threshold config: [0.2,0.25,0.35] handled without assuming exactly two', () => {
    const arr = [0.2, 0.25, 0.35];
    const dirs = arr.map(thresholdDirName);
    assert(dirs.length === 3 && new Set(dirs).size === 3, JSON.stringify(dirs));
  });

  t('Transcript splitter: RAW + TIDY non-empty + log', () => {
    const s = splitTranscript(readText(INPUTS.transcript), CONFIG.fillers);
    assert(s.raw.trim().length > 0, 'RAW empty');
    assert(s.tidy.trim().length > 0, 'TIDY empty');
    assert(Array.isArray(s.report.log) && s.report.log.length > 0, 'no transform log');
  });
  t('Transcript: RAW reproduces the standard transcript (100% word agreement)', () => {
    const master = readText(INPUTS.transcript);
    const s = splitTranscript(master, CONFIG.fillers);
    const v = validateAgainstMaster(s.raw, master);
    assert(v.agreement >= 0.999 && v.status.startsWith('passed'), `agreement ${v.agreement}`);
  });
  t('Transcript: removes fillers but KEEPS exact repetitions (TIDY)', () => {
    const s = splitTranscript('So uh these, these results and a method, a method here.', CONFIG.fillers);
    assert(!/\buh\b/i.test(s.tidy), 'uh not removed from TIDY');
    assert((s.tidy.match(/these/gi) || []).length === 2, 'repetition "these these" not kept');
    assert((s.tidy.match(/method/gi) || []).length === 2, 'restatement "a method a method" not kept');
    assert(s.report.fillers_removed >= 1, 'filler not indexed');
  });
  t('Transcript: preserves X placeholders', () => {
    const s = splitTranscript('the X part and uh the next X here', CONFIG.fillers);
    assert((s.tidy.match(/\bX\b/g) || []).length === 2, 'X placeholders not preserved');
  });
  t('WER alignment: exposes substitution, deletion, and insertion operations', () => {
    const sub = wer('alpha vector', 'alpha texture');
    const del = wer('alpha gamma', 'alpha beta gamma');
    const ins = wer('alpha beta extra', 'alpha beta');
    assert(sub.substitutions === 1 && sub.alignment.some((x) => x.op === 'substitute' && x.ref === 'texture' && x.hyp === 'vector'), 'missing substitution alignment');
    assert(del.deletions === 1 && del.alignment.some((x) => x.op === 'delete' && x.ref === 'beta'), 'missing deletion alignment');
    assert(ins.insertions === 1 && ins.alignment.some((x) => x.op === 'insert' && x.hyp === 'extra'), 'missing insertion alignment');
  });

  t('Matrix compiler: 0.25 + 0.35 + Phase IV columns in order; 0.35 not "matched"', () => {
    const m = buildMatrix({ recordingId: 'X', speaker: 'SpeakerX', replay025: agg, generated035: agg, syllables: 535 });
    const cols = matrixColumns();
    assert(cols[2] === 'Total_Pauses_Between_AS_Units_025', `col1=${cols[2]}`);
    assert(cols[8] === 'Mean_Of_Silent_Pauses_025', `col7=${cols[8]}`);
    assert(cols[9] === 'Total_Pauses_Between_AS_Units_035', `col8=${cols[9]}`);
    assert(cols.includes('TAALES_Word_Frequency_Mean') && cols.includes('AntConc_LB4_Count'), 'phase IV cols missing');
    assert(m.row.TAALES_Word_Frequency_Mean === 'pending_not_implemented', 'phase IV not placeholder');
    assert(m.row.group_status_035 !== 'matched', '0.35 must not be matched');
  });
  t('Matrix compiler: no fabricated AS-unit values (pending)', () => {
    const m = buildMatrix({ recordingId: 'X', speaker: 'SpeakerX', replay025: agg, generated035: agg, syllables: 535 });
    for (const k of ['Total_Pauses_Between_AS_Units_025', 'Total_Pauses_Within_AS_Units_025'])
      assert(m.row[k] === 'pending_not_implemented', `${k} fabricated: ${m.row[k]}`);
  });

  // ---- Phase II fidelity (email) ----
  t('Config: praat window_size default = 200', () => assert(CONFIG.praat.window_size === 200, `got ${CONFIG.praat.window_size}`));
  t('Summary: sounding/silent/INVALID label contract (invalid counted)', () => {
    const segs = segmentsFromTier(tier);
    const s = summarize(segs);
    assert(s.invalid_count === 0, 'expert invalid should be 0');
    assert('pause_values' in s && 'sounding_ranges' in s, 'summary missing pause_values/sounding_ranges');
    const withInv = summarize([{ label: 'invalid', start: 0, end: 1, duration: 1 }, ...segs]);
    assert(withInv.invalid_count === 1 && withInv.total_invalid === 1, 'invalid not counted');
  });
  t('Script 2 parity: real calculate_segment_durations.praat == CLI equivalent (silent=60)', () => {
    if (!praatAvailable()) { return; } // skipped where Praat absent
    const a = segmentDurations(INPUTS.textgrid, '/tmp/sprint_parity_praat.txt', { praatOk: true }).summary;
    const b = segmentDurations(INPUTS.textgrid, '/tmp/sprint_parity_cli.txt', { praatOk: false }).summary;
    assert(a.silent_count === 60 && b.silent_count === 60, `counts ${a.silent_count}/${b.silent_count}`);
    assert(Math.abs(a.total_silent - b.total_silent) < 1e-9, `total_silent parity ${Math.abs(a.total_silent - b.total_silent)}`);
    assert(Math.abs(a.total_sounding - 133.19652983384853) < 1e-3, 'praat sounding != gold');
  });

  return summary();
}

// -------------------------- INTEGRATION --------------------------
function runSprint(env, args = []) {
  // integration tests stay offline/deterministic — never hit the ASR network
  return spawnSync('node', [RUN_SPRINT, '--no-asr', ...args], {
    encoding: 'utf8',
    timeout: 180000,
    env: { ...process.env, ...env },
  });
}

function integration() {
  console.log('\nINTEGRATION TESTS');
  const { t, summary } = makeSuite('integration');

  // 1. Full Sprint Run (real outputs already produced by run-sprint; assert the real tree)
  t('Full Sprint Run: output tree + report + 0.25 pass + 0.35 no-gold + Phase I skipped + no Y/Z', () => {
    const reportPath = path.join(OUT_DIR, 'validation', 'validation_report.json');
    assert(fs.existsSync(reportPath), 'validation_report.json missing — run run-sprint.mjs first');
    const rep = JSON.parse(readText(reportPath));
    assert(fs.existsSync(path.join(OUT_DIR, 'validation', 'validation_report.md')), 'report.md missing');
    assert(rep.phase_i.status === 'skipped', 'Phase I not skipped');
    assert(rep.phase_ii.gold_replay.status === 'passed', 'gold replay not passed');
    const t035 = rep.phase_ii.thresholds.find((x) => x.threshold === 0.35);
    assert(t035 && (t035.kind === 'generated_no_gold' || t035.status === 'generated_no_gold'), '0.35 not no-gold');
    // Phase II fidelity artifacts
    assert(rep.phase_ii.script1 && rep.phase_ii.script2, 'missing script1/script2 in report');
    assert(rep.phase_ii.praat_window_sec === 200, `window not 200: ${rep.phase_ii.praat_window_sec}`);
    assert(rep.phase_ii.scale_times, 'no scale_times status');
    assert(fs.existsSync(path.join(OUT_DIR, 'phase-ii', 'threshold_0.25', 'script2_summary.json')), 'no Script 2 summary');
    assert(fs.existsSync(path.join(OUT_DIR, 'validation', 'generated_vs_expert_025.json')), 'no generated_vs_expert diagnostic');
    assert(fs.existsSync(path.join(OUT_DIR, 'logs', 'praat_script1_run.log')) && fs.existsSync(path.join(OUT_DIR, 'logs', 'praat_script2_run.log')), 'missing script1/script2 logs');
    // no SpeakerY/Z artifacts anywhere
    const all = listFiles(OUT_DIR);
    assert(!all.some((f) => /SpeakerY|SpeakerZ/i.test(f)), 'SpeakerY/Z artifact found');
  });

  t('No ASR -> client RAW/TIDY generated, AssemblyAI RAW/TIDY skipped', () => {
    const out = fs.mkdtempSync(path.join(os.tmpdir(), 'sprint-noasr-'));
    const r = runSprint({ SPRINT_OUT_DIR: out });
    assert(r.status === 0, `exit ${r.status}: ${r.stderr}`);
    const rep = JSON.parse(readText(path.join(out, 'validation', 'validation_report.json')));
    assert(rep.phase_iii.status === 'split_only', `status=${rep.phase_iii.status}`);
    const raw = path.join(out, 'phase-iii', `${CONFIG.recording_id}_RAW-TIMING.txt`);
    const tidy = path.join(out, 'phase-iii', `${CONFIG.recording_id}_TIDY-PHRASE.txt`);
    const asrRaw = path.join(out, 'phase-iii', 'assemblyai_RAW-TIMING.txt');
    const asrTidy = path.join(out, 'phase-iii', 'assemblyai_TIDY-PHRASE.txt');
    assert(fs.existsSync(raw), 'client RAW-TIMING should exist without ASR');
    assert(fs.existsSync(tidy), 'client TIDY-PHRASE should exist without ASR');
    assert(!fs.existsSync(asrRaw), 'AssemblyAI RAW-TIMING should not exist without ASR');
    assert(!fs.existsSync(asrTidy), 'AssemblyAI TIDY-PHRASE should not exist without ASR');
    assert((rep.artifacts || []).some((a) => a.name === `${CONFIG.recording_id}_RAW-TIMING.txt`), 'client RAW should be listed as artifact');
    assert(!(rep.artifacts || []).some((a) => /^assemblyai_.*(RAW|TIDY)/.test(a.name)), 'AssemblyAI RAW/TIDY should not be listed without ASR');
  });

  // 2. Missing file failure -> blocked
  t('Missing input -> blocked, names the missing file', () => {
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'sprint-empty-'));
    const out = fs.mkdtempSync(path.join(os.tmpdir(), 'sprint-out-'));
    const r = runSprint({ SPRINT_SAMPLE_DIR: empty, SPRINT_OUT_DIR: out });
    const rep = JSON.parse(readText(path.join(out, 'validation', 'validation_report.json')));
    assert(rep.readiness === 'blocked', `readiness=${rep.readiness}`);
    assert(/Missing required input/.test(rep.error || ''), `error=${rep.error}`);
  });

  // 3. Corrupted mismatch -> comparator fails (covered in unit; assert here at integration level via tampered TextGrid)
  t('Corrupted TextGrid (dropped interval) -> gold replay FAILS, not pass', () => {
    const sample = fs.mkdtempSync(path.join(os.tmpdir(), 'sprint-bad-'));
    const out = fs.mkdtempSync(path.join(os.tmpdir(), 'sprint-badout-'));
    // copy all sample files, then tamper the TextGrid: remove one silent interval's label
    for (const p of Object.values(INPUTS)) fs.copyFileSync(p, path.join(sample, path.basename(p)));
    const tgPath = path.join(sample, path.basename(INPUTS.textgrid));
    let tg = readText(tgPath).replace('text = "silent"', 'text = "sounding"'); // flips one silent->sounding => count 59
    fs.writeFileSync(tgPath, tg);
    const r = runSprint({ SPRINT_SAMPLE_DIR: sample, SPRINT_OUT_DIR: out, PRAAT_BIN: '/nonexistent' });
    const rep = JSON.parse(readText(path.join(out, 'validation', 'validation_report.json')));
    assert(rep.phase_ii.gold_replay.status === 'failed', `expected failed, got ${rep.phase_ii.gold_replay.status}`);
  });

  // 4. Praat unavailable -> thresholds blocked, gold replay still passes
  t('Praat unavailable -> drafts blocked, gold replay still passes, readiness ready_with_caveats', () => {
    const out = fs.mkdtempSync(path.join(os.tmpdir(), 'sprint-nopraat-'));
    const r = runSprint({ SPRINT_OUT_DIR: out }, ['--no-praat']);
    const rep = JSON.parse(readText(path.join(out, 'validation', 'validation_report.json')));
    assert(rep.phase_ii.gold_replay.status === 'passed', 'gold replay should still pass');
    assert(rep.phase_ii.thresholds.every((x) => x.status === 'blocked'), 'thresholds should be blocked');
    assert(rep.readiness === 'ready_with_caveats', `readiness=${rep.readiness}`);
  });

  // 5. Configurable threshold array (3 thresholds) does not crash
  t('Threshold array [0.2,0.25,0.35] runs without crash', () => {
    const out = fs.mkdtempSync(path.join(os.tmpdir(), 'sprint-3t-'));
    const r = runSprint({ SPRINT_OUT_DIR: out }, ['--thresholds', '0.2,0.25,0.35']);
    assert(r.status === 0, `exit ${r.status}: ${r.stderr}`);
    const rep = JSON.parse(readText(path.join(out, 'validation', 'validation_report.json')));
    assert(rep.phase_ii.thresholds.length === 3, `got ${rep.phase_ii.thresholds.length} thresholds`);
  });

  return summary();
}

function listFiles(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...listFiles(p));
    else out.push(p);
  }
  return out;
}

async function main() {
  const u = await unit();
  const i = integration();
  const dir = path.join(OUT_DIR, 'test-results');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'unit-test-results.json'), JSON.stringify({ ...u, generated_at: new Date().toISOString() }, null, 2));
  fs.writeFileSync(path.join(dir, 'integration-test-results.json'), JSON.stringify({ ...i, generated_at: new Date().toISOString() }, null, 2));
  console.log(`\nUNIT: ${u.passed} passed / ${u.failed} failed`);
  console.log(`INTEGRATION: ${i.passed} passed / ${i.failed} failed`);
  process.exit(u.failed + i.failed === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
