#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const argumentIndex = process.argv.indexOf('--dir');
const buildDir = path.resolve(argumentIndex >= 0 ? process.argv[argumentIndex + 1] : path.join(ROOT, 'build-validation'));
const htmlPath = path.join(buildDir, 'validation.html');

if (!fs.existsSync(htmlPath)) throw new Error(`Missing validation.html in ${buildDir}`);
const html = fs.readFileSync(htmlPath, 'utf8');
const references = [...html.matchAll(/(?:src|href)=["']([^"']+)["']/g)]
  .map((match) => match[1])
  .filter((value) => !/^(?:https?:|data:|#)/.test(value));
const missing = references
  .map((value) => ({ reference: value, file: path.resolve(buildDir, value.replace(/^\.\//, '').replace(/^\//, '')) }))
  .filter((item) => !fs.existsSync(item.file));

const report = {
  schema_version: 'validation-build-integrity-v1',
  checked_at: new Date().toISOString(),
  build_dir: buildDir,
  html: htmlPath,
  references,
  missing,
  ok: missing.length === 0 && references.some((value) => /\.js(?:$|\?)/.test(value)) && references.some((value) => /\.css(?:$|\?)/.test(value)),
};
fs.writeFileSync(path.join(buildDir, 'build-integrity.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
if (!report.ok) throw new Error(`Validation build integrity failed: ${JSON.stringify(missing)}`);
console.log(`Validation build integrity OK (${references.length} referenced assets)`);
