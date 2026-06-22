// Validation Sprint orchestrator — PHASE-AWARE. Each phase runs independently.
// Usage: node run-sprint.mjs [--phase ii|iii|v|all] [--thresholds 0.25,0.35] [--no-praat] [--no-asr] [--force-asr] [--strict] [--progress <file>]
import path from 'node:path';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { INPUTS, OUT_DIR, RECORDING_ID, CONFIG, thresholdDirName } from './config.mjs';
import { ensureDir, writeJson, writeText, writeCsv, fileInfo, readText } from './lib/fsutil.mjs';
import { readBaseline } from './lib/excel-baseline.mjs';
import { compare } from './lib/comparator.mjs';
import { runScript1, praatAvailable } from './lib/praat.mjs';
import { segmentDurations } from './lib/script2.mjs';
import { splitTranscript } from './lib/transcript-split.mjs';
import { transcribe, getApiKey } from './lib/asr.mjs';
import { wer } from './lib/wer.mjs';
import { buildMatrix } from './lib/matrix.mjs';
import { writeWorkbook } from './lib/xlsxio.mjs';

const PHASE_STEPS = {
  ii: [
    { key: 'script1', label: 'Script 1 · intensity', desc: 'rolling 200 s window + Scale times' },
    { key: 'script2', label: 'Script 2 · durations', desc: 'calculate_segment_durations.praat' },
    { key: 'gold', label: 'Gold replay', desc: 'expert TextGrid vs workbook' },
    { key: 'compare', label: 'Diagnostics', desc: 'generated 0.25 vs expert' },
  ],
  iii: [
    { key: 'loadtx', label: 'Load transcript', desc: 'checked & pruned' },
    { key: 'raw', label: 'RAW-TIMING', desc: 'verbatim' },
    { key: 'tidy', label: 'TIDY-PHRASE', desc: 'cleaned + log' },
  ],
  v: [
    { key: 'prereq', label: 'Check prerequisites', desc: 'Phase II + III' },
    { key: 'columns', label: 'Map columns', desc: '0.25 / 0.35 / Phase IV' },
    { key: 'matrix', label: 'Write matrix', desc: 'xlsx + csv' },
  ],
};

function parseArgs(argv) {
  const a = { phase: 'all', thresholds: [...CONFIG.thresholds_sec], noPraat: false, noAsr: false, forceAsr: false, strict: false, progress: null };
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--phase') a.phase = argv[++i];
    else if (argv[i] === '--thresholds') a.thresholds = argv[++i].split(',').map(Number);
    else if (argv[i] === '--no-praat') a.noPraat = true;
    else if (argv[i] === '--no-asr') a.noAsr = true;
    else if (argv[i] === '--force-asr') a.forceAsr = true;
    else if (argv[i] === '--strict') a.strict = true;
    else if (argv[i] === '--progress') a.progress = argv[++i];
  }
  return a;
}
function praatVersion(binary) {
  try {
    const r = spawnSync(binary, ['--version'], { encoding: 'utf8', timeout: 10000 });
    return (r.stdout || r.stderr || '').trim().split('\n')[0] || null;
  } catch {
    return null;
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const round = (x) => Math.round(x * 1e6) / 1e6;
const reportPath = path.join(OUT_DIR, 'validation', 'validation_report.json');

function summaryPublic(s) {
  const { segments, ...rest } = s; // segments live in the *_segment_durations files
  return rest;
}
// Write Script-2 artifacts for one TextGrid into `dir` with `prefix`.
function writeScript2(dir, prefix, s2) {
  writeCsv(path.join(dir, `${prefix}_segment_durations.csv`), ['index', 'label', 'duration', 'start', 'end'],
    s2.segments.map((x, i) => ({ index: i + 1, label: x.label, duration: x.duration, start: x.start, end: x.end })));
  writeJson(path.join(dir, `${prefix}_segment_durations.json`), { method: s2.method, script: s2.script, command: s2.command, segments: s2.segments });
  writeJson(path.join(dir, `${prefix}_summary.json`), { method: s2.method, script: s2.script, ...summaryPublic(s2.summary) });
}
function durationsSubset(sum) {
  return {
    total_duration: sum.total_duration, interval_count: sum.interval_count,
    sounding_count: sum.sounding_count, silent_count: sum.silent_count, invalid_count: sum.invalid_count,
    total_sounding: sum.total_sounding, total_silent: sum.total_silent, total_invalid: sum.total_invalid,
    mean_silent: sum.mean_silent, min_silent: sum.min_silent, max_silent: sum.max_silent,
  };
}
function inputPresent(role) {
  return fs.existsSync(INPUTS[role]);
}
function loadReport() {
  if (fs.existsSync(reportPath)) {
    try {
      return JSON.parse(readText(reportPath));
    } catch {/* fall through */}
  }
  return null;
}

async function main() {
  const args = parseArgs(process.argv);
  const startedAt = new Date().toISOString();
  ensureDir(OUT_DIR);
  const phases = args.phase === 'all' ? ['ii', 'iii', 'iv', 'v'] : [args.phase];
  let finalReadiness = 'running';
  const PHASE_META = {
    i: { label: 'Phase I', desc: 'Diarization & isolation' },
    ii: { label: 'Phase II', desc: 'Pause & duration' },
    iii: { label: 'Phase III', desc: 'Transcript split' },
    iv: { label: 'Phase IV', desc: 'Lexical / MWU (placeholders)' },
    v: { label: 'Phase V', desc: 'Matrix' },
  };
  // Pipeline progress is PHASE-LEVEL (single Run Validation): Phase I skipped, then II -> III -> IV -> V.
  const phaseState = { i: 'skipped' };
  for (const p of phases) phaseState[p] = 'pending';
  function writeProgress(done = false, ok = true) {
    if (!args.progress) return;
    const order = ['i', ...phases];
    writeJson(args.progress, {
      started_at: startedAt, phase: args.phase, done, ok, readiness: finalReadiness,
      steps: order.map((p) => ({ key: p, phase: p, label: PHASE_META[p].label, desc: PHASE_META[p].desc, state: phaseState[p] || 'pending' })),
    });
  }
  async function markPhase(p, state) {
    phaseState[p] = state;
    writeProgress(false);
    if (args.progress && ['done', 'passed', 'placeholder', 'generated_no_gold', 'diagnostic'].includes(state)) await sleep(380);
  }
  // compat: granular sub-step marks keep the phase "running" / propagate "blocked"
  async function mark(phase, key, state) {
    if (state === 'blocked') phaseState[phase] = 'blocked';
    else if (state === 'running' && phaseState[phase] !== 'blocked') phaseState[phase] = 'running';
    writeProgress(false);
  }
  writeProgress(false);

  // ---- shared header: inputs / config / report skeleton (merge with existing) ----
  const inputs = Object.entries(INPUTS).map(([k, p]) => ({ role: k, ...fileInfo(path.basename(p), p) }));
  writeJson(path.join(OUT_DIR, 'input-manifest.json'), { recording_id: RECORDING_ID, generated_at: startedAt, inputs });
  const praatBin = CONFIG.praat.binary;
  const praatOk = !args.noPraat && praatAvailable(praatBin);
  writeJson(path.join(OUT_DIR, 'config.snapshot.json'), {
    recording_id: RECORDING_ID, thresholds_sec: args.thresholds, gold_threshold: CONFIG.gold_threshold,
    tolerances: CONFIG.tolerances, praat: { ...CONFIG.praat, available: praatOk, version: praatOk ? praatVersion(praatBin) : null },
    phase_i: { status: 'skipped', reason: 'monologue — single speaker' },
  });

  const prev = loadReport() || {};
  const report = {
    sprint: 'validation-sprint', recording_id: RECORDING_ID, speaker: 'SpeakerX', generated_at: startedAt,
    phase_i: { status: 'skipped', reason: 'monologue — single speaker' },
    inputs: inputs.map((i) => ({ name: i.name, role: i.role, present: i.present, bytes: i.bytes, sha256: i.sha256 })),
    config: { thresholds_sec: args.thresholds, tolerances: CONFIG.tolerances, praat_window_sec: CONFIG.praat.window_size },
    praat: { available: praatOk, status: praatOk ? 'ok' : 'blocked', binary: praatBin },
    phase_ii: prev.phase_ii || null, phase_iii: prev.phase_iii || null, phase_iv: prev.phase_iv || null, phase_v: prev.phase_v || null,
    artifacts: [], tests: prev.tests || { unit: null, integration: null, ui: null },
    readiness: 'running', limitations: [],
  };
  const limitations = report.limitations;
  const log = [];
  let phaseFailed = false;

  // ===================== PHASE II — Script 1 + Script 2 (+ gold replay + diagnostic) =====================
  async function runPhaseII() {
    if (!['wav', 'textgrid', 'workbook'].every(inputPresent)) {
      report.phase_ii = { status: 'blocked', reason: 'Missing required input(s) for Phase II (wav / expert TextGrid / workbook)', ran_at: startedAt };
      report.error = report.phase_ii.reason;
      await markPhase('ii', 'blocked');
      phaseFailed = true;
      return;
    }
    await markPhase('ii', 'running');
    const baseline = await readBaseline(INPUTS.workbook);
    const labelContract = ['sounding', 'silent', 'invalid'];

    // ---- Script 1: rolling intensity / silence detection, 200 s window, Scale times ----
    await mark('ii', 'script1', 'running');
    const s1log = [`# Script 1 (silences.praat) — ${startedAt}`, `binary: ${praatBin}`, `available: ${praatOk}`, `window_size: ${CONFIG.praat.window_size}`];
    const script1 = [];
    const generatedGrids = {};
    for (const t of args.thresholds) {
      const tDir = ensureDir(path.join(OUT_DIR, 'phase-ii', thresholdDirName(t)));
      const outGrid = path.join(tDir, 'generated.TextGrid');
      const isGold = t === CONFIG.gold_threshold;
      const e = { threshold: t, kind: isGold ? 'gold' : 'generated_no_gold', textgrid: outGrid, praat_window_sec: CONFIG.praat.window_size, label_contract: labelContract };
      if (!praatOk) {
        e.status = 'blocked';
        e.scale_times = 'blocked';
        s1log.push(`threshold ${t}: BLOCKED (praat unavailable)`);
      } else {
        const r = runScript1(INPUTS.wav, outGrid, t, CONFIG.praat, 'none');
        s1log.push(`threshold ${t}: ${r.ok ? 'OK' : 'FAIL'} :: ${r.command}`, '  ' + r.stdout);
        if (r.ok) {
          generatedGrids[t] = outGrid;
          e.status = 'generated';
          // Scale times mode + full-timeline assertion
          const single = baseline.total_audio <= CONFIG.praat.window_size;
          e.scale_times = single ? 'applied_single_window_full_wav' : 'applied_windowed_concatenated';
        } else {
          e.status = 'failed';
          e.scale_times = 'failed';
        }
      }
      script1.push(e);
    }
    writeText(path.join(OUT_DIR, 'logs', 'praat_script1_run.log'), s1log.join('\n') + '\n');
    if (!praatOk) limitations.push('Praat unavailable: Script 1 (generated drafts) blocked; gold replay still runs via the parity-tested CLI equivalent.');
    await mark('ii', 'script1', praatOk ? 'done' : 'blocked');

    // ---- Script 2: calculate_segment_durations.praat on generated grids + expert (gold) ----
    await mark('ii', 'script2', 'running');
    const s2log = [`# Script 2 (calculate_segment_durations.praat) — ${startedAt}`];
    const script2 = [];
    const thresholdEntries = [];
    const genSummaries = {};
    for (const t of args.thresholds) {
      const tDir = path.join(OUT_DIR, 'phase-ii', thresholdDirName(t));
      const grid = generatedGrids[t];
      const isGold = t === CONFIG.gold_threshold;
      if (!grid) {
        script2.push({ threshold: t, status: 'blocked' });
        thresholdEntries.push({ threshold: t, kind: isGold ? 'gold' : 'generated_no_gold', status: 'blocked', textgrid: path.join(tDir, 'generated.TextGrid') });
        continue;
      }
      const s2 = segmentDurations(grid, path.join(tDir, 'script2_raw.txt'), { praatOk });
      writeScript2(tDir, 'script2', s2);
      genSummaries[t] = s2.summary;
      s2log.push(`threshold ${t}: method=${s2.method} ${s2.command || ''}`);
      const fullTimelineOk = Math.abs(s2.summary.total_duration - baseline.total_audio) <= CONFIG.tolerances.boundary;
      script2.push({ threshold: t, method: s2.method, summary_json: path.join(tDir, 'script2_summary.json'), totals: durationsSubset(s2.summary) });
      thresholdEntries.push({ threshold: t, kind: isGold ? 'gold' : 'generated_no_gold', status: isGold ? 'generated' : 'generated_no_gold', textgrid: grid, full_timeline_ok: fullTimelineOk, durations: durationsSubset(s2.summary) });
    }
    // gold = Script 2 on the EXPERT TextGrid
    const goldS2 = segmentDurations(INPUTS.textgrid, path.join(OUT_DIR, 'validation', 'gold_script2_raw.txt'), { praatOk });
    writeScript2(path.join(OUT_DIR, 'validation'), 'gold_script2', goldS2);
    s2log.push(`gold(expert TextGrid): method=${goldS2.method} ${goldS2.command || ''}`);
    writeText(path.join(OUT_DIR, 'logs', 'praat_script2_run.log'), s2log.join('\n') + '\n');
    await mark('ii', 'script2', 'done');

    // ---- Gold replay: expert Script-2 summary vs workbook ----
    await mark('ii', 'gold', 'running');
    const goldSum = goldS2.summary;
    const cmp = compare(goldSum, baseline, CONFIG.tolerances);
    writeJson(path.join(OUT_DIR, 'validation', 'speakerx_025_baseline_comparison.json'), {
      threshold: CONFIG.gold_threshold, script2_method: goldS2.method, status: cmp.status, baseline,
      computed: durationsSubset(goldSum), rows: cmp.rows,
    });
    writeCsv(path.join(OUT_DIR, 'validation', 'speakerx_025_baseline_comparison.csv'), ['metric', 'ours', 'gold', 'delta', 'tolerance', 'pass'], cmp.rows);
    if (cmp.status !== 'passed') phaseFailed = true;
    await mark('ii', 'gold', cmp.status === 'passed' ? 'done' : 'blocked');

    // ---- Diagnostic: generated 0.25 vs expert (NOT a gold pass) ----
    await mark('ii', 'compare', 'running');
    let genVsExpert = null;
    const g025 = genSummaries[CONFIG.gold_threshold];
    if (g025) {
      const rows = [
        { metric: 'silent intervals', generated: g025.silent_count, expert: goldSum.silent_count, delta: g025.silent_count - goldSum.silent_count },
        { metric: 'sounding intervals', generated: g025.sounding_count, expert: goldSum.sounding_count, delta: g025.sounding_count - goldSum.sounding_count },
        { metric: 'total sounding (s)', generated: round(g025.total_sounding), expert: round(goldSum.total_sounding), delta: round(g025.total_sounding - goldSum.total_sounding) },
        { metric: 'total silent (s)', generated: round(g025.total_silent), expert: round(goldSum.total_silent), delta: round(g025.total_silent - goldSum.total_silent) },
      ];
      genVsExpert = { status: 'diagnostic', note: 'Generated segmentation differs from the expert manually-corrected TextGrid — expected. Not a gold pass.', rows };
      writeJson(path.join(OUT_DIR, 'validation', 'generated_vs_expert_025.json'), genVsExpert);
    }
    await mark('ii', 'compare', g025 ? 'done' : 'blocked');

    report.phase_ii = {
      status: cmp.status, ran_at: startedAt, praat_window_sec: CONFIG.praat.window_size, scale_times: script1[0] ? script1[0].scale_times : null,
      label_contract: labelContract, syllables: baseline.syllables,
      script1, script2, gold_replay: { status: cmp.status, method: goldS2.method, rows: cmp.rows, totals: durationsSubset(goldSum) },
      generated_vs_expert_025: genVsExpert, thresholds: thresholdEntries,
    };
    log.push(`phase II gold replay: ${cmp.status} (Script 2 method=${goldS2.method})`);
    await markPhase('ii', cmp.status === 'passed' ? 'passed' : 'blocked');
  }

  // ===================== PHASE III =====================
  async function runPhaseIII() {
    if (!inputPresent('transcript')) {
      report.phase_iii = { status: 'blocked', reason: 'Missing required input: transcript (.txt)', ran_at: startedAt };
      if (!report.error) report.error = report.phase_iii.reason;
      await markPhase('iii', 'blocked');
      phaseFailed = true;
      return;
    }
    await markPhase('iii', 'running');
    const masterText = readText(INPUTS.transcript); // client's standard / "checked" transcript
    const p3 = path.join(OUT_DIR, 'phase-iii');
    const rawFile = path.join(p3, `${RECORDING_ID}_RAW-TIMING.txt`);
    const tidyFile = path.join(p3, `${RECORDING_ID}_TIDY-PHRASE.txt`);
    const asrRawFile = path.join(p3, 'assemblyai_RAW-TIMING.txt');
    const asrTidyFile = path.join(p3, 'assemblyai_TIDY-PHRASE.txt');
    const asrTranscriptFile = path.join(p3, 'assemblyai_transcript.txt');
    const asrResultFile = path.join(p3, 'assemblyai_result.json');
    const shouldAttemptAsr = !args.noAsr && inputPresent('wav');
    const asrSourceMode = process.env.ASSEMBLYAI_SOURCE || 'api';
    const preserveAsrCache = shouldAttemptAsr && !args.forceAsr && (asrSourceMode === 'cache' || asrSourceMode === 'cache-first');
    for (const stale of [
      rawFile,
      tidyFile,
      asrRawFile,
      asrTidyFile,
      ...(preserveAsrCache ? [] : [asrTranscriptFile, asrResultFile]),
      path.join(p3, 'assemblyai_split_report.json'),
      path.join(p3, 'transcript_split_report.json'),
      path.join(p3, 'transcript_validation.json'),
      path.join(OUT_DIR, 'logs', 'asr_run.log'),
    ]) fs.rmSync(stale, { force: true });

    // Required Phase III output: split the human-checked client transcript into RAW/TIDY.
    const clientSplit = splitTranscript(masterText, CONFIG.fillers);
    writeText(rawFile, clientSplit.raw);
    writeText(tidyFile, clientSplit.tidy);
    writeJson(path.join(p3, 'transcript_split_report.json'), { source: 'client_standard_transcript', ...clientSplit.report });

    // Real ASR (AssemblyAI) on the .wav when a key is configured — else honest split-only.
    const apiKey = args.noAsr ? null : getApiKey();
    let asr = null;
    let asrError = null;
    if (shouldAttemptAsr) {
      const asrLog = [`# ASR run (AssemblyAI) — ${startedAt}`];
      try {
        asr = await transcribe(INPUTS.wav, {
          apiKey,
          pollMs: 3000,
          speakersExpected: 1,
          cacheJson: asrResultFile,
          cacheText: asrTranscriptFile,
          cacheDir: path.join(p3, 'assemblyai-cache'),
          forceApi: args.forceAsr,
          log: (m) => asrLog.push(m),
        });
        writeText(asrTranscriptFile, (asr.text || '') + '\n');
        writeJson(asrResultFile, {
          id: asr.id,
          model: asr.model,
          audio_duration: asr.audio_duration,
          confidence: asr.confidence,
          word_count: asr.words.length,
          text: asr.text,
          source: asr.source,
          source_path: asr.source_path,
        });
      } catch (e) {
        asrError = e.message;
        asrLog.push('ERROR: ' + e.message);
      }
      writeText(path.join(OUT_DIR, 'logs', 'asr_run.log'), asrLog.join('\n') + '\n');
    }

    if (asr) {
      const asrSplit = splitTranscript(asr.text, CONFIG.fillers);
      const split = clientSplit;
      writeText(rawFile, split.raw);
      writeText(tidyFile, split.tidy);
      writeJson(path.join(p3, 'transcript_split_report.json'), split.report);
      writeText(asrRawFile, asrSplit.raw);
      writeText(asrTidyFile, asrSplit.tidy);
      writeJson(path.join(p3, 'assemblyai_split_report.json'), { source: 'assemblyai_asr', ...asrSplit.report });
      // REAL validation: our CLEANED AI transcript (TIDY) vs the client's cleaned standard (WER).
      // RAW keeps disfluencies, so we compare like-for-like (both cleaned).
      const w = wer(asrSplit.tidy, clientSplit.tidy);
      const status = w.wer <= 0.15 ? 'passed' : w.wer <= 0.35 ? 'passed_with_diff' : 'failed';
      writeJson(path.join(p3, 'transcript_validation.json'), {
        method: 'assemblyai', compared: 'AssemblyAI TIDY vs client TIDY', model: asr.model, audio_duration: asr.audio_duration, asr_confidence: asr.confidence,
        asr_source: asr.source, asr_source_path: asr.source_path,
        wer: w, client_cleaning_index: clientSplit.report.cleaning_index, asr_cleaning_index: asrSplit.report.cleaning_index,
        client_repetitions_kept: clientSplit.report.repetitions, asr_repetitions_kept: asrSplit.report.repetitions,
      });
      report.phase_iii = {
        status: status === 'failed' ? 'failed' : 'passed', ran_at: startedAt, raw_file: rawFile, tidy_file: tidyFile,
        source: 'client_standard_transcript',
        transcription: 'client standard transcript split; assemblyai compared separately',
        asr: { model: asr.model, words: asr.words.length, confidence: asr.confidence, audio_duration: asr.audio_duration, source: asr.source, source_path: asr.source_path },
        asr_raw_file: asrRawFile, asr_tidy_file: asrTidyFile,
        validation: { method: 'assemblyai', compared: 'AssemblyAI TIDY vs client TIDY', status, asr_source: asr.source, asr_source_path: asr.source_path, ...w },
        raw_words: split.report.raw_words, tidy_words: split.report.tidy_words,
        fillers_removed: split.report.fillers_removed, repetitions_kept: split.report.repetitions_kept, x_placeholders: split.report.x_placeholders,
        cleaning_index: split.report.cleaning_index.slice(0, 80), diff: split.report.diff.slice(0, 1200), repetitions: split.report.repetitions.slice(0, 50),
        transforms: split.report.transforms, log: split.report.log,
        asr_raw_words: asrSplit.report.raw_words, asr_tidy_words: asrSplit.report.tidy_words,
        asr_fillers_removed: asrSplit.report.fillers_removed, asr_repetitions_kept: asrSplit.report.repetitions_kept,
      };
      log.push(`phase III: client TIDY ${clientSplit.report.tidy_words}w; AssemblyAI TIDY ${asrSplit.report.tidy_words}w; WER ${(w.wer * 100).toFixed(1)}%; edits ${w.edits} (S=${w.substitutions}, D=${w.deletions}, I=${w.insertions}); ${status}`);
      await markPhase('iii', status === 'failed' ? 'blocked' : 'passed');
    } else {
      writeJson(path.join(p3, 'transcript_validation.json'), {
        method: 'split_only', reason: asrError || 'no ASSEMBLYAI_API_KEY',
        client_split: { raw_words: clientSplit.report.raw_words, tidy_words: clientSplit.report.tidy_words, fillers_removed: clientSplit.report.fillers_removed },
        note: 'Client standard transcript was split into RAW-TIMING and TIDY-PHRASE. AssemblyAI comparison was skipped.',
      });
      report.phase_iii = {
        status: 'split_only', ran_at: startedAt, raw_file: rawFile, tidy_file: tidyFile,
        source: 'client_standard_transcript',
        transcription: asrError ? `assemblyai failed: ${asrError}` : 'none — no ASSEMBLYAI_API_KEY (set it in .env to run real ASR)',
        note: 'Client standard transcript was split into RAW-TIMING and TIDY-PHRASE. AssemblyAI comparison is optional and was skipped for this run.',
        asr_status: 'skipped',
        raw_words: clientSplit.report.raw_words, tidy_words: clientSplit.report.tidy_words,
        fillers_removed: clientSplit.report.fillers_removed, repetitions_kept: clientSplit.report.repetitions_kept, x_placeholders: clientSplit.report.x_placeholders,
        cleaning_index: clientSplit.report.cleaning_index.slice(0, 80), diff: clientSplit.report.diff.slice(0, 1200), repetitions: clientSplit.report.repetitions.slice(0, 50),
        transforms: clientSplit.report.transforms, log: clientSplit.report.log,
      };
      limitations.push('Phase III: AssemblyAI comparison skipped (no ASSEMBLYAI_API_KEY or ASR failure); client transcript split still completed.');
      log.push(`phase III: client split only - RAW ${clientSplit.report.raw_words}w / TIDY ${clientSplit.report.tidy_words}w; AssemblyAI comparison skipped`);
      await markPhase('iii', 'generated_no_gold');
    }
  }

  // ===================== PHASE IV — text-variable placeholders =====================
  async function runPhaseIV() {
    await markPhase('iv', 'running');
    const cols = ['TAALES_Word_Frequency_Mean', 'TAALES_Lexical_Decision_Mean', 'TAALES_MWU_Proportion_Top30k', 'TAALED_MTLD', 'TAALED_MATTR', 'AntConc_LB4_Count', 'AntConc_LB_Range', 'AntConc_LB_MI_Mean'];
    const values = Object.fromEntries(cols.map((c) => [c, 'pending_not_implemented']));
    writeJson(path.join(OUT_DIR, 'phase-iv', 'text_variable_placeholders.json'), {
      status: 'placeholder_ready', tools: ['TAALES', 'TAALED', 'AntConc'],
      note: 'Text variables are placeholders for this validation run; no TAALES/TAALED/AntConc values are fabricated.',
      columns: cols, values, ran_at: startedAt,
    });
    report.phase_iv = { status: 'placeholder_ready', tools: ['TAALES', 'TAALED', 'AntConc'], columns: cols, note: 'Columns 15+ reserved in the matrix; pending_not_implemented until tools are supplied.' };
    limitations.push('Phase IV (TAALES/TAALED/AntConc) text variables are placeholders — not computed for this validation sprint.');
    await markPhase('iv', 'placeholder');
  }

  // ===================== PHASE V =====================
  async function runPhaseV() {
    await mark('v', 'prereq', 'running');
    const goldGenPath = path.join(OUT_DIR, 'phase-ii', thresholdDirName(0.35), 'generated.TextGrid');
    const haveII = report.phase_ii && report.phase_ii.gold_replay;
    if (!haveII || !['wav', 'textgrid', 'workbook'].every(inputPresent)) {
      report.phase_v = { status: 'blocked', reason: 'Phase II must run first (matrix needs Phase II gold replay + inputs)', ran_at: startedAt };
      await markPhase('v', 'blocked');
      phaseFailed = true;
      return;
    }
    await markPhase('v', 'running');
    const baseline = await readBaseline(INPUTS.workbook);
    const goldSum = segmentDurations(INPUTS.textgrid, path.join(OUT_DIR, 'validation', 'gold_script2_raw.txt'), { praatOk }).summary;
    const gen035 = fs.existsSync(goldGenPath) ? segmentDurations(goldGenPath, path.join(OUT_DIR, 'phase-ii', thresholdDirName(0.35), 'script2_raw.txt'), { praatOk }).summary : null;
    if (!gen035) limitations.push('Phase V: no generated 0.35 TextGrid found — 0.35 matrix columns blocked (run Phase II with Praat).');
    await mark('v', 'prereq', 'done');

    await mark('v', 'columns', 'running');
    const matrix = buildMatrix({ recordingId: RECORDING_ID, speaker: 'SpeakerX', replay025: goldSum, generated035: gen035, syllables: baseline.syllables });
    await mark('v', 'columns', 'done');

    await mark('v', 'matrix', 'running');
    const p5 = path.join(OUT_DIR, 'phase-v');
    const matrixCsv = path.join(p5, 'validation_matrix_speakerx.csv');
    const matrixXlsx = path.join(p5, 'validation_matrix_speakerx.xlsx');
    writeCsv(matrixCsv, matrix.columns, [matrix.row]);
    await writeWorkbook(matrixXlsx, [
      { name: 'Matrix', headers: matrix.columns, rows: [matrix.row] },
      { name: 'Summary', headers: ['key', 'value'], rows: [
        { key: 'recording_id', value: RECORDING_ID }, { key: 'group_status_025', value: matrix.row.group_status_025 }, { key: 'group_status_035', value: matrix.row.group_status_035 },
        { key: 'cols_1_7', value: '0.25 threshold (gold replay)' }, { key: 'cols_8_14', value: '0.35 threshold (generated, no gold)' },
        { key: 'cols_15+', value: 'Phase IV TAALES/TAALED/AntConc — pending_not_implemented' }, { key: 'generated_at', value: startedAt },
      ] },
    ]);
    report.phase_v = { status: 'passed', ran_at: startedAt, xlsx: matrixXlsx, csv: matrixCsv, columns: matrix.columns, row: matrix.row };
    limitations.push('Matrix AS-unit (between/within) and Phase IV (TAALES/TAALED/AntConc) columns are pending_not_implemented — Layer 2.');
    await markPhase('v', 'passed');
  }

  if (phases.includes('ii')) await runPhaseII();
  if (phases.includes('iii')) await runPhaseIII();
  if (phases.includes('iv')) await runPhaseIV();
  if (phases.includes('v')) await runPhaseV();

  // ---- rebuild artifact list from what exists on disk ----
  const A = (name, p, kind) => (fs.existsSync(p) ? [{ name, path: p, kind }] : []);
  report.artifacts = [
    ...A('gold_script2_segment_durations.csv', path.join(OUT_DIR, 'validation', 'gold_script2_segment_durations.csv'), 'durations'),
    ...A('speakerx_025_baseline_comparison.json', path.join(OUT_DIR, 'validation', 'speakerx_025_baseline_comparison.json'), 'comparison'),
    ...A('generated_vs_expert_025.json', path.join(OUT_DIR, 'validation', 'generated_vs_expert_025.json'), 'comparison'),
    ...args.thresholds.flatMap((t) => A(`generated_${t}.TextGrid`, path.join(OUT_DIR, 'phase-ii', thresholdDirName(t), 'generated.TextGrid'), 'textgrid')),
    ...args.thresholds.flatMap((t) => A(`script2_summary_${t}.json`, path.join(OUT_DIR, 'phase-ii', thresholdDirName(t), 'script2_summary.json'), 'durations')),
    ...A(`${RECORDING_ID}_RAW-TIMING.txt`, path.join(OUT_DIR, 'phase-iii', `${RECORDING_ID}_RAW-TIMING.txt`), 'transcript'),
    ...A(`${RECORDING_ID}_TIDY-PHRASE.txt`, path.join(OUT_DIR, 'phase-iii', `${RECORDING_ID}_TIDY-PHRASE.txt`), 'transcript'),
    ...A('assemblyai_RAW-TIMING.txt', path.join(OUT_DIR, 'phase-iii', 'assemblyai_RAW-TIMING.txt'), 'transcript'),
    ...A('assemblyai_TIDY-PHRASE.txt', path.join(OUT_DIR, 'phase-iii', 'assemblyai_TIDY-PHRASE.txt'), 'transcript'),
    ...A('transcript_validation.json', path.join(OUT_DIR, 'phase-iii', 'transcript_validation.json'), 'comparison'),
    ...A('assemblyai_transcript.txt', path.join(OUT_DIR, 'phase-iii', 'assemblyai_transcript.txt'), 'transcript'),
    ...A('asr_run.log', path.join(OUT_DIR, 'logs', 'asr_run.log'), 'log'),
    ...A('validation_matrix_speakerx.xlsx', path.join(OUT_DIR, 'phase-v', 'validation_matrix_speakerx.xlsx'), 'matrix'),
    ...A('validation_matrix_speakerx.csv', path.join(OUT_DIR, 'phase-v', 'validation_matrix_speakerx.csv'), 'matrix'),
    ...A('text_variable_placeholders.json', path.join(OUT_DIR, 'phase-iv', 'text_variable_placeholders.json'), 'placeholder'),
    ...A('praat_script1_run.log', path.join(OUT_DIR, 'logs', 'praat_script1_run.log'), 'log'),
    ...A('praat_script2_run.log', path.join(OUT_DIR, 'logs', 'praat_script2_run.log'), 'log'),
    // always produced this run (written just below):
    { name: 'validation_report.json', path: reportPath, kind: 'report' },
    { name: 'validation_report.md', path: path.join(OUT_DIR, 'validation', 'validation_report.md'), kind: 'report' },
    { name: 'method_log.json', path: path.join(OUT_DIR, 'logs', 'method_log.json'), kind: 'log' },
  ];

  const goldPassed = report.phase_ii && report.phase_ii.status === 'passed';
  report.readiness = goldPassed ? (praatOk ? 'ready' : 'ready_with_caveats') : report.phase_ii ? 'blocked' : 'partial';
  finalReadiness = report.readiness;
  limitations.push('Workbook articulation rate is syllables/min and "phonation time" = total audio; differs from PRD §5 — reconcile before sign-off.');
  report.limitations = [...new Set(limitations)];

  writeJson(path.join(OUT_DIR, 'logs', 'method_log.json'), {
    generated_at: startedAt, finished_at: new Date().toISOString(), node: process.version, phase: args.phase,
    praat: { available: praatOk, binary: praatBin, version: praatOk ? praatVersion(praatBin) : null },
    thresholds_sec: args.thresholds, tolerances: CONFIG.tolerances, log,
  });
  writeJson(reportPath, report);
  writeText(path.join(OUT_DIR, 'validation', 'validation_report.md'), renderReportMd(report));
  writeProgress(true, !phaseFailed);

  console.log(`Validation Sprint — phase=${args.phase}`);
  if (report.phase_ii) console.log(`  Phase II: ${report.phase_ii.status}`);
  if (report.phase_iii) console.log(`  Phase III: ${report.phase_iii.status}`);
  if (report.phase_v) console.log(`  Phase V: ${report.phase_v.status}`);
  console.log(`  Readiness: ${report.readiness}`);
  process.exit(phaseFailed && args.strict ? 1 : 0);
}

function fmt(x) {
  return typeof x === 'number' ? (Number.isInteger(x) ? x : x.toFixed(6)) : x;
}
function renderReportMd(report) {
  const L = [`# Validation Sprint — ${report.recording_id}`, '', `- Run: ${report.generated_at}`, `- Phase I: **skipped** (monologue)`, `- Praat: ${report.praat.available ? 'available' : 'unavailable'}`, `- Readiness: **${report.readiness}**`, ''];
  const g = report.phase_ii && report.phase_ii.gold_replay;
  if (g) {
    L.push(`## Phase II — Gold replay (0.25): **${report.phase_ii.status.toUpperCase()}**`, '', '| Metric | Ours | Gold | Δ | Tol | Pass |', '|---|---:|---:|---:|---|:--:|');
    for (const r of g.rows) L.push(`| ${r.metric} | ${fmt(r.ours)} | ${fmt(r.gold)} | ${typeof r.delta === 'number' ? r.delta.toExponential(2) : r.delta} | ${r.tolerance} | ${r.pass ? '✅' : '❌'} |`);
    L.push('');
    if (report.phase_ii.thresholds) {
      L.push('| Threshold | Kind | Status | silent |', '|---|---|---|---:|');
      for (const t of report.phase_ii.thresholds) L.push(`| ${t.threshold} | ${t.kind} | ${t.status} | ${t.durations ? t.durations.silent_count : '—'} |`);
      L.push('');
    }
  } else if (report.phase_ii) L.push(`## Phase II — ${report.phase_ii.status}: ${report.phase_ii.reason || ''}`, '');
  if (report.phase_iii) {
    const p3 = report.phase_iii;
    const line = `- Client RAW ${p3.raw_words ?? '—'}w / Client TIDY ${p3.tidy_words ?? '—'}w`;
    const asrLine = p3.validation?.method === 'assemblyai'
      ? `- AssemblyAI comparison: WER ${((p3.validation.wer || 0) * 100).toFixed(1)}%, agreement ${((p3.validation.word_agreement || 0) * 100).toFixed(1)}%`
      : '- AssemblyAI comparison: skipped';
    L.push(`## Phase III — ${p3.status}`, line, asrLine, '');
  }
  if (report.phase_v) L.push(`## Phase V — ${report.phase_v.status}`, report.phase_v.columns ? `- columns: ${report.phase_v.columns.length}` : `- ${report.phase_v.reason || ''}`, '');
  L.push('## Limitations');
  for (const lim of report.limitations) L.push(`- ${lim}`);
  L.push('', '## Tests', `- unit ${report.tests?.unit ? report.tests.unit.passed + '/' + report.tests.unit.failed : 'n/a'} · integration ${report.tests?.integration ? report.tests.integration.passed + '/' + report.tests.integration.failed : 'n/a'} · ui ${report.tests?.ui ? report.tests.ui.passed + '/' + report.tests.ui.failed : 'n/a'}`);
  return L.join('\n') + '\n';
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
