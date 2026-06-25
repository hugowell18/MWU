#!/usr/bin/env node

import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  readJson,
  readWavForMuting,
  turnsFromPyannoteJson,
  writePhase1Artifacts,
} from './phase1/lib/diarization-artifacts.mjs';

function parseArgs(argv) {
  const args = {
    turnsJson: '',
    audio: '',
    outDir: '',
    prefix: '',
    source: 'turns_json',
    durationSeconds: null,
  };

  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === '--turns-json' && next) {
      args.turnsJson = next;
      i += 1;
    } else if (arg === '--audio' && next) {
      args.audio = next;
      i += 1;
    } else if (arg === '--out-dir' && next) {
      args.outDir = next;
      i += 1;
    } else if (arg === '--prefix' && next) {
      args.prefix = next;
      i += 1;
    } else if (arg === '--source' && next) {
      args.source = next;
      i += 1;
    } else if (arg === '--duration-seconds' && next) {
      args.durationSeconds = Number(next);
      i += 1;
    } else if (arg === '--help' || arg === '-h') {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`Unknown or incomplete argument: ${arg}`);
    }
  }

  if (!args.turnsJson) throw new Error('--turns-json is required');
  if (!args.audio) throw new Error('--audio is required');
  if (!args.outDir) throw new Error('--out-dir is required');
  if (args.durationSeconds != null && (!Number.isFinite(args.durationSeconds) || args.durationSeconds <= 0)) {
    throw new Error('--duration-seconds must be a positive number');
  }
  return args;
}

function printHelp() {
  console.log(`Usage:
  node scripts/phase1-artifacts-from-turns.mjs --turns-json <turns.json> --audio <wav> --out-dir <dir> [options]

Options:
  --prefix <name>              Output filename prefix. Default: audio stem.
  --source <name>              Source label for manifest. Default: turns_json.
  --duration-seconds <number>  Optional local timeline override.
`);
}

function main() {
  const args = parseArgs(process.argv);
  const turnsPath = resolve(args.turnsJson);
  const audioPath = resolve(args.audio);
  const outDir = resolve(args.outDir);
  if (!existsSync(turnsPath)) throw new Error(`Turns JSON does not exist: ${turnsPath}`);
  if (!existsSync(audioPath)) throw new Error(`Audio file does not exist: ${audioPath}`);
  const wav = readWavForMuting(audioPath);
  const duration = args.durationSeconds ?? wav.durationSeconds;
  const turns = turnsFromPyannoteJson(readJson(turnsPath), duration);
  const { manifestPath, manifest } = writePhase1Artifacts({
    turns,
    audioPath,
    outDir,
    prefix: args.prefix,
    source: args.source,
    method: {
      name: 'phase1_artifacts_from_speaker_turns',
      note: 'Generic artifact builder used by local pyannote and tests. It creates speaker turns, RTTM, speaker TextGrid, muted-mirror WAVs, and Phase II invalid-interval inputs.',
    },
    durationSeconds: duration,
  });
  console.log(`Wrote manifest: ${manifestPath}`);
  console.log(JSON.stringify({
    duration_seconds: manifest.duration_seconds,
    speakers: manifest.speakers,
    utterance_count: manifest.utterance_count,
    outputs: manifest.outputs.muted_mirror_wavs.length,
    phase_ii_ready: manifest.phase_ii_handoff.ready,
  }, null, 2));
}

try {
  main();
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
