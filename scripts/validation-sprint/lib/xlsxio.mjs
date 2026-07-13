import ExcelJS from 'exceljs/lib/exceljs.nodejs.js';
import path from 'node:path';
import { ensureDir } from './fsutil.mjs';

const HEADER_FILL = '173F4F';
const HEADER_TEXT = 'FFFFFF';
const ROW_ALT_FILL = 'F4F7F7';
const BORDER = 'D9E1E3';

function inferredWidth(header, rows) {
  const longest = rows.reduce((length, row) => {
    const value = row[header];
    return Math.max(length, value === null || value === undefined ? 0 : String(value).length);
  }, String(header).length);
  return Math.min(38, Math.max(10, longest + 2));
}

// sheets: [{ name, headers:[...], rows:[{col:val}], columnWidths?, numberFormats? }]
export async function writeWorkbook(file, sheets) {
  ensureDir(path.dirname(file));
  const wb = new ExcelJS.Workbook();
  wb.creator = 'MWU Validation Sprint';
  wb.created = new Date();
  wb.modified = new Date();
  for (const s of sheets) {
    const ws = wb.addWorksheet(s.name, {
      views: [{ state: 'frozen', ySplit: 1, showGridLines: false }],
    });
    ws.addRow(s.headers);
    const header = ws.getRow(1);
    header.height = 30;
    header.font = { name: 'Aptos', size: 10, bold: true, color: { argb: HEADER_TEXT } };
    header.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: HEADER_FILL } };
    header.alignment = { vertical: 'middle', horizontal: 'left', wrapText: true };
    header.eachCell((cell) => {
      cell.border = { bottom: { style: 'medium', color: { argb: HEADER_FILL } } };
    });

    for (const r of s.rows) ws.addRow(s.headers.map((h) => r[h]));

    s.headers.forEach((name, index) => {
      const column = ws.getColumn(index + 1);
      column.width = s.columnWidths?.[name] ?? inferredWidth(name, s.rows);
      if (s.numberFormats?.[name]) column.numFmt = s.numberFormats[name];
      column.alignment = {
        vertical: 'middle',
        horizontal: s.alignments?.[name] ?? 'left',
        wrapText: Boolean(s.wrapColumns?.includes(name)),
      };
    });

    for (let rowIndex = 2; rowIndex <= ws.rowCount; rowIndex += 1) {
      const row = ws.getRow(rowIndex);
      row.height = s.rowHeight ?? 21;
      row.font = { name: 'Aptos', size: 10, color: { argb: '203036' } };
      if (rowIndex % 2 === 0) {
        row.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: ROW_ALT_FILL } };
      }
      row.eachCell((cell) => {
        cell.border = { bottom: { style: 'hair', color: { argb: BORDER } } };
      });
    }

    if (ws.rowCount > 1) ws.autoFilter = { from: 'A1', to: ws.getRow(1).getCell(s.headers.length).address };
    ws.pageSetup = { orientation: s.headers.length > 8 ? 'landscape' : 'portrait', fitToPage: true, fitToWidth: 1 };
    ws.properties.defaultRowHeight = 21;
  }
  await wb.xlsx.writeFile(file);
  return file;
}
