import ExcelJS from 'exceljs/lib/exceljs.nodejs.js';
import path from 'node:path';
import { ensureDir } from './fsutil.mjs';

// sheets: [{ name, headers:[...], rows:[{col:val}] }]
export async function writeWorkbook(file, sheets) {
  ensureDir(path.dirname(file));
  const wb = new ExcelJS.Workbook();
  wb.creator = 'MWU Validation Sprint';
  for (const s of sheets) {
    const ws = wb.addWorksheet(s.name);
    ws.addRow(s.headers);
    ws.getRow(1).font = { bold: true };
    for (const r of s.rows) ws.addRow(s.headers.map((h) => r[h]));
  }
  await wb.xlsx.writeFile(file);
  return file;
}
