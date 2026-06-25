#!/usr/bin/env node

import { existsSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { resolve } from 'node:path';
import {
  compareDiarizations,
  readJson,
  readWavForMuting,
  renderDiarizationComparisonMarkdown,
  turnsFromAssemblyAi,
  turnsFromPyannoteJson,
  writeJson,
} from './phase1/lib/diarization-artifacts.mjs';

function parseArgs(argv) {
  const args = {
    referenceAssemblyAiJson: '',
    referenceTurnsJson: '',
    candidateTurnsJson: '',
    audio: '',
    output: '',
    frameMs: 100,
    durationSeconds: null,
  };

  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === '--reference-assemblyai-json' && next) {
      args.referenceAssemblyAiJson = next;
      i += 1;
    } else if (arg === '--reference-turns-json' && next) {
      args.referenceTurnsJson = next;
      i += 1;
    } else if (arg === '--candidate-turns-json' && next) {
      args.candidateTurnsJson = next;
      i += 1;
    } else if (arg === '--audio' && next) {
      args.audio = next;
      i += 1;
    } else if (arg === '--output' && next) {
      args.output = next;
      i += 1;
    } else if (arg === '--frame-ms' && next) {
      args.frameMs = Number(next);
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

  if (!args.referenceAssemblyAiJson && !args.referenceTurnsJson) {
    throw new Error('Provide --reference-assemblyai-json or --reference-turns-json');
  }
  if (args.referenceAssemblyAiJson && args.referenceTurnsJson) {
    throw new Error('Use only one reference source');
  }
  if (!args.candidateTurnsJson) throw new Error('--candidate-turns-json is required');
  if (!args.output) throw new Error('--output is required');
  if (!Number.isFinite(args.frameMs) || args.frameMs <= 0) throw new Error('--frame-ms must be positive');
  if (args.durationSeconds != null && (!Number.isFinite(args.durationSeconds) || args.durationSeconds <= 0)) {
    throw new Error('--duration-seconds must be positive');
  }
  return args;
}

function printHelp() {
  console.log(`Usage:
  node scripts/phase1-compare-diarization.mjs --reference-assemblyai-json <raw.json> --candidate-turns-json <pyannote.turns.json> --audio <wav> --output <report.json>

Options:
  --reference-turns-json <json>  Generic reference turns JSON instead of AssemblyAI raw JSON.
  --duration-seconds <number>    Override comparison duration.
  --frame-ms <number>            Frame comparison resolution. Default: 100.
`);
}

function main() {
  const args = parseArgs(process.argv);
  const candidatePath = resolve(args.candidateTurnsJson);
  const outputPath = resolve(args.output);
  if (!existsSync(candidatePath)) throw new Error(`Candidate turns JSON does not exist: ${candidatePath}`);

  let duration = args.durationSeconds;
  if (duration == null) {
    if (!args.audio) throw new Error('--audio is required when --duration-seconds is not provided');
    const audioPath = resolve(args.audio);
    if (!existsSync(audioPath)) throw new Error(`Audio file does not exist: ${audioPath}`);
    duration = readWavForMuting(audioPath).durationSeconds;
  }

  let referenceTurns;
  let referenceSource;
  if (args.referenceAssemblyAiJson) {
    const referencePath = resolve(args.referenceAssemblyAiJson);
    if (!existsSync(referencePath)) throw new Error(`Reference AssemblyAI JSON does not exist: ${referencePath}`);
    referenceTurns = turnsFromAssemblyAi(readJson(referencePath), duration);
    referenceSource = referencePath;
  } else {
    const referencePath = resolve(args.referenceTurnsJson);
    if (!existsSync(referencePath)) throw new Error(`Reference turns JSON does not exist: ${referencePath}`);
    referenceTurns = turnsFromPyannoteJson(readJson(referencePath), duration);
    referenceSource = referencePath;
  }
  const candidateTurns = turnsFromPyannoteJson(readJson(candidatePath), duration);
  const report = {
    generated_at: new Date().toISOString(),
    reference_source: referenceSource,
    candidate_source: candidatePath,
    ...compareDiarizations(referenceTurns, candidateTurns, { duration, frameMs: args.frameMs }),
  };
  writeJson(outputPath, report);
  const mdPath = outputPath.replace(/\.json$/i, '.md');
  writeFileSync(mdPath, renderDiarizationComparisonMarkdown(report), 'utf8');
  console.log(`Wrote comparison: ${outputPath}`);
  console.log(`Wrote comparison markdown: ${mdPath}`);
  console.log(JSON.stringify({
    exact_label_frame_agreement: report.agreement.exact_label_frame_agreement,
    speech_activity_agreement: report.agreement.speech_activity_agreement,
    speaker_agreement_when_both_speech: report.agreement.speaker_agreement_when_both_speech,
    mapping: report.mapping_candidate_to_reference,
  }, null, 2));
}

try {
  main();
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
