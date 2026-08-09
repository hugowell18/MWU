#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(TEST_DIR, '../..');
const OUTPUT = path.join(TEST_DIR, 'artifacts', 'regression-report.json');
const suites = [
  ['G2 Path B', 'npm', ['run', 'multilogue:v2:path-b:test']],
  ['G1 Stage-1 adapter', 'npm', ['run', 'multilogue:v2:stage1:test']],
  ['Phase I adapter', 'npm', ['run', 'phase1:pyannote:test']],
  ['Nine-label core', process.execPath, ['tests/multilogue-v2/run-tests.mjs']],
  ['SpeakerX offline (--no-asr)', 'npm', ['run', 'sprint:test:offline'], { ASSEMBLYAI_API_KEY: '', ASSEMBLYAI_SOURCE: 'disabled' }],
  ['G3 delivery', 'npm', ['run', 'multilogue:v2:delivery:test']],
  ['Validation UI', 'npm', ['run', 'sprint:ui-test'], { VC_PORT: '4173' }],
  ['Application build', 'npm', ['run', 'build']],
  ['Validation build', 'npm', ['run', 'sprint:build-ui']],
  ['Machine browser QA', 'npm', ['run', 'multilogue:v2:browser-qa']],
  ['Diff hygiene', 'git', ['diff', '--check']],
];

function countSummary(text) {
  const patterns = [
    /\b\d+\/\d+ tests passed\b/g,
    /\b\d+ passed\s*\/\s*0 failed\b/g,
    /\b\d+ passed, 0 failed\b/g,
    /\bUNIT: \d+ passed \/ 0 failed\b/g,
    /\bINTEGRATION: \d+ passed \/ 0 failed\b/g,
    /\bUI: \d+ passed \/ 0 failed\b/g,
  ];
  return [...new Set(patterns.flatMap((pattern) => text.match(pattern) || []))];
}

const results = [];
for (const [name, command, args, envPatch = {}] of suites) {
  const started = Date.now();
  const result = spawnSync(command, args, {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 240000,
    env: { ...process.env, ...envPatch },
  });
  const combined = `${result.stdout || ''}\n${result.stderr || ''}`;
  results.push({
    name,
    status: result.status === 0 ? 'passed' : 'failed',
    exit_code: result.status,
    elapsed_ms: Date.now() - started,
    counts: countSummary(combined),
    failure_tail: result.status === 0 ? [] : combined.trim().split('\n').slice(-12),
  });
  console.log(`${result.status === 0 ? 'PASS' : 'FAIL'} ${name}${countSummary(combined).length ? ` · ${countSummary(combined).join(', ')}` : ''}`);
}

const report = {
  suite: 'G3-regression-and-build',
  passed: results.filter((item) => item.status === 'passed').length,
  failed: results.filter((item) => item.status === 'failed').length,
  results,
  generated_at: new Date().toISOString(),
};
mkdirSync(path.dirname(OUTPUT), { recursive: true });
writeFileSync(OUTPUT, `${JSON.stringify(report, null, 2)}\n`);
if (report.failed) process.exitCode = 1;
