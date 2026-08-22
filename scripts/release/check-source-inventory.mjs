#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const REPORT_PATHS = [
  path.join(ROOT, 'tests', 'l1a', 'artifacts', 'release-inventory-report.json'),
  path.join(ROOT, 'MWU_Delivery_Package_V1.0', '03_Validation', 'L1a', 'release-inventory-report.json'),
];
const INCLUDE_ROOTS = [
  'src/', 'scripts/', 'tests/', 'spec/', 'public/',
  'package.json', 'package-lock.json', 'vite.config.ts', 'vite.validation.config.mjs', 'validation.html',
];
const EXCLUSIONS = [
  { pattern: /(^|\/)\.env(?:\.|$)/i, reason: 'local environment or credentials' },
  { pattern: /(^|\/)(sample|samples|outputs?|tmp|node_modules|\.git)(\/|$)/i, reason: 'participant data, runtime output or local dependency' },
  { pattern: /\.(wav|mp3|m4a|flac|aac|ogg|rttm)$/i, reason: 'audio or diarization data' },
  { pattern: /(assemblyai|pyannote).*(raw|response|payload).*\.json$/i, reason: 'provider raw payload' },
  { pattern: /(^|\/)\.DS_Store$/i, reason: 'local filesystem metadata' },
];
const SENSITIVE_LITERAL = /(?:api[_-]?key|secret|token|password)\s*[:=]\s*['"]([^'"]+)['"]/gi;

function walk(dir, output = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (['.git', 'node_modules', 'build-validation.next', 'build-validation.previous'].includes(entry.name)) continue;
    const absolute = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(absolute, output);
    else output.push(path.relative(ROOT, absolute).replaceAll(path.sep, '/'));
  }
  return output;
}

function includedByRoot(file) {
  return INCLUDE_ROOTS.some((root) => root.endsWith('/') ? file.startsWith(root) : file === root);
}

function exclusionFor(file) {
  return EXCLUSIONS.find((entry) => entry.pattern.test(file)) || null;
}

function hasSensitiveLiteral(text) {
  SENSITIVE_LITERAL.lastIndex = 0;
  for (const match of text.matchAll(SENSITIVE_LITERAL)) {
    const value = String(match[1] || '').trim();
    if (value.length >= 12 && !/(example|placeholder|replace|your[_-]|test[_-]|dummy|redacted|unknown)/i.test(value)) return true;
  }
  return false;
}

const files = walk(ROOT).sort();
const included = [];
const excluded = [];
const outsideAllowlist = [];
for (const file of files) {
  const exclusion = exclusionFor(file);
  if (exclusion) excluded.push({ path: file, reason: exclusion.reason });
  else if (includedByRoot(file)) included.push(file);
  else outsideAllowlist.push(file);
}

const violations = [];
for (const file of included) {
  if (/(^|\/)(sample|samples|outputs?)(\/|$)/i.test(file) || /\.(wav|mp3|m4a|flac|aac|ogg)$/i.test(file)) {
    violations.push({ path: file, reason: 'sensitive path or media escaped the exclusion policy' });
    continue;
  }
  if (/\.(?:js|mjs|cjs|ts|tsx|json|md|html|css|yml|yaml|txt)$/i.test(file)) {
    const text = fs.readFileSync(path.join(ROOT, file), 'utf8');
    if (hasSensitiveLiteral(text) && !/\.example$/i.test(file)) violations.push({ path: file, reason: 'possible inline credential literal' });
  }
}

const report = {
  schema_version: 'mwu-source-release-inventory-v1',
  generated_at: new Date().toISOString(),
  status: violations.length ? 'blocked' : 'ready_for_qa_review',
  policy: {
    include_roots: INCLUDE_ROOTS,
    exclusions: EXCLUSIONS.map((entry) => ({ pattern: entry.pattern.source, reason: entry.reason })),
    note: 'This inventory defines the source handover candidate set. It does not delete or reclassify repository history.',
  },
  counts: { included: included.length, excluded: excluded.length, outside_allowlist: outsideAllowlist.length, violations: violations.length },
  included,
  excluded_summary: Object.entries(excluded.reduce((summary, item) => {
    summary[item.reason] = (summary[item.reason] || 0) + 1;
    return summary;
  }, {})).map(([reason, count]) => ({ reason, count })),
  excluded_examples: excluded.slice(0, 40),
  outside_allowlist_examples: outsideAllowlist.slice(0, 40),
  violations,
};
for (const reportPath of REPORT_PATHS) {
  fs.mkdirSync(path.dirname(reportPath), { recursive: true });
  fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
}
console.log(JSON.stringify({ status: report.status, counts: report.counts, reports: REPORT_PATHS.map((value) => path.relative(ROOT, value)) }, null, 2));
if (violations.length) process.exitCode = 1;
