// Validation Sprint — central config & input paths.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(__dirname, '../..'); // repo root

function loadEnv(envPath = path.join(ROOT, '.env')) {
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const i = t.indexOf('=');
    if (i === -1) continue;
    const k = t.slice(0, i).trim();
    let v = t.slice(i + 1).trim();
    if (!k || process.env[k] != null) continue;
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    process.env[k] = v;
  }
}

loadEnv();

function resolvePraatBinary() {
  if (process.env.PRAAT_BIN) return process.env.PRAAT_BIN;

  const candidates = [];
  if (process.platform === 'win32') {
    const localAppData = process.env.LOCALAPPDATA || (process.env.USERPROFILE ? path.join(process.env.USERPROFILE, 'AppData', 'Local') : null);
    if (localAppData) {
      candidates.push(path.join(localAppData, 'Microsoft', 'WinGet', 'Packages', 'UniversityOfAmsterdam.praat_Microsoft.Winget.Source_8wekyb3d8bbwe', 'Praat.exe'));
    }
    if (process.env.ProgramFiles) candidates.push(path.join(process.env.ProgramFiles, 'Praat', 'Praat.exe'));
    if (process.env['ProgramFiles(x86)']) candidates.push(path.join(process.env['ProgramFiles(x86)'], 'Praat', 'Praat.exe'));
  } else if (process.platform === 'darwin') {
    candidates.push('/Applications/Praat.app/Contents/MacOS/Praat');
  }
  candidates.push('praat');

  return candidates.find((p) => path.isAbsolute(p) && fs.existsSync(p)) || candidates[0];
}

// SAMPLE_DIR / OUT_DIR are overridable via env for isolated test runs.
export const SAMPLE_DIR = process.env.SPRINT_SAMPLE_DIR || path.join(ROOT, 'sample');
export const RECORDING_ID = '8_STEM_SpeakerX';
export const OUT_DIR = process.env.SPRINT_OUT_DIR || path.join(ROOT, 'outputs/validation-sprint', RECORDING_ID);

export const INPUTS = {
  wav: path.join(SAMPLE_DIR, '8_STEM_SpeakerX_checked_and_pruned.wav'),
  textgrid: path.join(SAMPLE_DIR, '8 STEM SpeakerX.TextGrid'),
  transcript: path.join(SAMPLE_DIR, '8 STEM SpeakerX checked and pruned.txt'),
  workbook: path.join(SAMPLE_DIR, 'Example fluency measures calculations SpeakerX.xlsx'),
};

export const CONFIG = {
  recording_id: RECORDING_ID,
  speaker: 'SpeakerX',
  // Configurable threshold array — NEVER assume exactly two.
  thresholds_sec: [0.25, 0.35],
  gold_threshold: 0.25,
  tolerances: { duration: 0.001, boundary: 0.001, articulation: 0.001 },
  praat: {
    binary: resolvePraatBinary(),
    // wide macro window for a stable intensity baseline over long recordings (email Phase II).
    // Hardcodable default; exposed for future change. Single window when audio <= window.
    window_size: 200,
    silence_threshold_db: -25,
    min_sounding_interval: 0.1,
    min_pitch: 100,
  },
  // Generated-TextGrid label contract (email Phase II): three mutually-exclusive labels.
  // invalid = periods when other speakers talk (from Phase I); 0 for a monologue.
  labels: { sounding: 'sounding', silent: 'silent', invalid: 'invalid' },
  // non-lexical fillers removed by TIDY-PHRASE (case-insensitive, whole-word)
  fillers: ['uh', 'um', 'uhm', 'er', 'erm', 'mm', 'hmm', 'mhm', 'mm-hmm'],
};

export function thresholdDirName(t) {
  // 0.25 -> threshold_0.25 ; 0.2 -> threshold_0.2
  return `threshold_${t}`;
}
