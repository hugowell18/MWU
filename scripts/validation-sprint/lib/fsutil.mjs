import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function writeJson(file, obj) {
  ensureDir(path.dirname(file));
  fs.writeFileSync(file, JSON.stringify(obj, null, 2));
  return file;
}

export function writeText(file, text) {
  ensureDir(path.dirname(file));
  fs.writeFileSync(file, text);
  return file;
}

// minimal CSV writer; values stringified, quoted when needed
export function writeCsv(file, headers, rows) {
  const esc = (v) => {
    if (v === null || v === undefined) return '';
    const s = String(v);
    return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  const lines = [headers.map(esc).join(',')];
  for (const r of rows) lines.push(headers.map((h) => esc(r[h])).join(','));
  ensureDir(path.dirname(file));
  fs.writeFileSync(file, lines.join('\n') + '\n');
  return file;
}

export function sha256(file) {
  try {
    return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  } catch {
    return null;
  }
}

export function fileInfo(name, file) {
  const present = fs.existsSync(file);
  return {
    name,
    path: file,
    present,
    bytes: present ? fs.statSync(file).size : 0,
    sha256: present ? sha256(file) : null,
  };
}

export function readText(file) {
  return fs.readFileSync(file, 'utf8');
}
