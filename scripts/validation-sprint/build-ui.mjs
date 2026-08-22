#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const target = path.join(ROOT, 'build-validation');
const staging = path.join(ROOT, 'build-validation.next');
const backup = path.join(ROOT, 'build-validation.previous');

fs.rmSync(staging, { recursive: true, force: true });
fs.rmSync(backup, { recursive: true, force: true });

const build = spawnSync(path.join(ROOT, 'node_modules', '.bin', 'vite'), ['build', '--config', 'vite.validation.config.mjs'], {
  cwd: ROOT,
  env: { ...process.env, MWU_VALIDATION_BUILD_DIR: 'build-validation.next' },
  stdio: 'inherit',
});
if (build.status !== 0) process.exit(build.status || 1);

const verify = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'validation-sprint', 'verify-build.mjs'), '--dir', staging], {
  cwd: ROOT,
  stdio: 'inherit',
});
if (verify.status !== 0) process.exit(verify.status || 1);

try {
  if (fs.existsSync(target)) fs.renameSync(target, backup);
  fs.renameSync(staging, target);
  fs.rmSync(backup, { recursive: true, force: true });
} catch (error) {
  if (!fs.existsSync(target) && fs.existsSync(backup)) fs.renameSync(backup, target);
  throw error;
}

console.log(`Atomically published ${target}`);
