import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CONFIG } from '../config.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT1 = path.join(__dirname, '..', 'praat', 'silences.praat');
const SCRIPT2 = path.join(__dirname, '..', 'praat', 'calculate_segment_durations.praat');

export function praatAvailable(binary = CONFIG.praat.binary) {
  return fs.existsSync(binary);
}

// Script 1 — rolling intensity / silence detection at `threshold` (= minimum silent interval),
// over `window_size`-s windows, with Scale times applied → full-timeline TextGrid.
export function runScript1(wav, outTextGrid, threshold, params = CONFIG.praat, invalidPath = 'none') {
  fs.mkdirSync(path.dirname(outTextGrid), { recursive: true });
  const args = [
    '--run', SCRIPT1, wav, outTextGrid,
    String(threshold), String(params.silence_threshold_db), String(params.min_sounding_interval),
    String(params.min_pitch), String(params.window_size), invalidPath,
  ];
  const res = spawnSync(params.binary, args, { encoding: 'utf8', timeout: 120000 });
  return {
    ok: res.status === 0 && fs.existsSync(outTextGrid),
    threshold, window_size: params.window_size,
    status: res.status, stdout: (res.stdout || '').trim(), stderr: (res.stderr || '').trim(),
    command: [params.binary, ...args].join(' '),
  };
}

// Script 2 — run the real calculate_segment_durations.praat on a TextGrid; returns parsed segments.
export function runScript2(textgrid, outTxt, tier = 'silences', binary = CONFIG.praat.binary) {
  fs.mkdirSync(path.dirname(outTxt), { recursive: true });
  const args = ['--run', SCRIPT2, textgrid, tier, outTxt];
  const res = spawnSync(binary, args, { encoding: 'utf8', timeout: 60000 });
  const ok = res.status === 0 && fs.existsSync(outTxt);
  return {
    ok, status: res.status, stderr: (res.stderr || '').trim(),
    command: [binary, ...args].join(' '),
    text: ok ? fs.readFileSync(outTxt, 'utf8') : '',
  };
}
