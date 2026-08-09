import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';

import { canonicalJson } from '../core/contracts.mjs';

export function writeCanonicalJson(filePath, value) {
  writeFileSync(filePath, canonicalJson(value));
}

export function writeFrozenCsv(filePath, schema, rows) {
  if (!Array.isArray(schema) || schema.length === 0) throw new Error('CSV schema is required');
  const lines = [schema.map(csvCell).join(',')];
  for (const [index, row] of rows.entries()) {
    const keys = Object.keys(row);
    if (keys.length !== schema.length || keys.some((key, keyIndex) => key !== schema[keyIndex])) {
      throw new Error(`CSV row ${index} does not match frozen schema`);
    }
    lines.push(schema.map((column) => csvCell(serializeCell(row[column]))).join(','));
  }
  writeFileSync(filePath, `${lines.join('\n')}\n`);
}

export function sha256File(filePath) {
  return createHash('sha256').update(readFileSync(filePath)).digest('hex');
}

export function digestFiles(baseDir, relativePaths) {
  return Object.fromEntries(relativePaths.map((relativePath) => [relativePath, sha256File(`${baseDir}/${relativePath}`)]));
}

function serializeCell(value) {
  if (value === null || value === undefined) return '';
  if (Array.isArray(value) || (typeof value === 'object' && value !== null)) return JSON.stringify(value);
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  return String(value);
}

function csvCell(value) {
  const text = String(value ?? '');
  return `"${text.replaceAll('"', '""')}"`;
}
