// Read the SpeakerX gold baseline (column B) from the client workbook.
// Sheets: "Durations" (raw segments) + "Fluency measures" (computed metrics).
// SpeakerY (C) / SpeakerZ (D) are ignored. No separate 0.35 gold columns exist.
import ExcelJS from 'exceljs/lib/exceljs.nodejs.js';

function flatten(v) {
  if (v == null) return '';
  if (typeof v === 'object') {
    if (Array.isArray(v.richText)) return v.richText.map((r) => r.text).join('');
    if (v.result !== undefined) return v.result;
    if (v.text !== undefined) return v.text;
    return '';
  }
  return v;
}

function num(v) {
  const f = flatten(v);
  return typeof f === 'number' ? f : Number(f);
}

export async function readBaseline(workbookPath) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(workbookPath);
  const sheets = wb.worksheets.map((w) => w.name);
  const fm = wb.getWorksheet('Fluency measures');
  if (!fm) throw new Error('Workbook missing "Fluency measures" sheet');

  // Build label(colA) -> value(colB) map, label normalized to lower-case text.
  const byLabel = [];
  fm.eachRow({ includeEmpty: false }, (row) => {
    const label = String(flatten(row.getCell('A').value) || '').replace(/\s+/g, ' ').trim();
    const b = row.getCell('B').value;
    if (label) byLabel.push({ label, b });
  });
  const find = (re) => byLabel.find((r) => re.test(r.label));
  const val = (re) => {
    const hit = find(re);
    return hit ? num(hit.b) : null;
  };

  const baseline = {
    speaker: 'SpeakerX',
    column: 'B',
    sheets,
    total_audio: val(/^total duration of audio/i),
    phonation_time: val(/^phonation time/i),
    speaking_time: val(/^speaking time \(secs?\)/i),
    speaking_min: val(/^speaking time \(min/i),
    syllables: val(/^no\. of syllables/i),
    silent_pauses: val(/^no\. of silent pauses\s*$/i),
    mean_silent_pause: val(/^mean of silent pauses/i),
    total_silent_pausing: val(/^total silent pausing time/i),
    // mid-clause = within ASU ; end-clause = between ASU (exclude "per min" rows)
    mid_clause: val(/no\. of .*mid-clause pauses/i),
    end_clause: val(/no\. of .*end-clause pauses/i),
    repairs: val(/^total no\. of repairs$/i),
    articulation_rate: val(/^articulation rate/i),
  };

  // Confirm no 0.35-threshold gold variables anywhere (only individual pause durations near 0.35).
  let has_035_gold = false;
  for (const ws of wb.worksheets) {
    ws.eachRow({ includeEmpty: false }, (row) => {
      row.eachCell({ includeEmpty: false }, (c) => {
        const t = String(flatten(c.value) || '').toLowerCase();
        if (/threshold/.test(t) && /0\.?35|0\.?25/.test(t)) has_035_gold = true;
      });
    });
  }
  baseline.has_035_gold = has_035_gold;
  return baseline;
}
