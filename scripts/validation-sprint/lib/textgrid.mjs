// Minimal Praat ooTextFile (long form) TextGrid parser + serializer.
// Handles IntervalTier (sounding/silent) grids used by this Sprint.

function unquote(v) {
  const m = v.match(/^"([\s\S]*)"\s*$/);
  return m ? m[1] : v.trim();
}

export function parseTextGrid(text) {
  const lines = text.split(/\r?\n/);
  let gxmin = null;
  let gxmax = null;
  const tiers = [];
  let cur = null; // current tier
  let curInt = null; // current interval

  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;

    if (/^item\s*\[\d+\]\s*:/.test(line)) {
      cur = { name: null, class: null, xmin: null, xmax: null, intervals: [] };
      tiers.push(cur);
      curInt = null;
      continue;
    }
    if (/^item\s*\[\s*\]\s*:/.test(line)) continue; // array header
    if (/^intervals\s*\[\d+\]\s*:/.test(line)) {
      curInt = { xmin: null, xmax: null, text: '' };
      cur.intervals.push(curInt);
      continue;
    }

    const m = line.match(/^(.+?)\s*=\s*([\s\S]+?)\s*$/);
    if (!m) continue;
    const key = m[1].trim();
    const val = m[2].trim();

    if (key === 'xmin') {
      const f = parseFloat(val);
      if (curInt) curInt.xmin = f;
      else if (cur && cur.xmin === null) cur.xmin = f;
      else if (gxmin === null) gxmin = f;
    } else if (key === 'xmax') {
      const f = parseFloat(val);
      if (curInt) curInt.xmax = f;
      else if (cur && cur.xmax === null) cur.xmax = f;
      else if (gxmax === null) gxmax = f;
    } else if (key === 'text') {
      if (curInt) curInt.text = unquote(val);
    } else if (key === 'name') {
      if (cur) cur.name = unquote(val);
    } else if (key === 'class') {
      if (cur) cur.class = unquote(val);
    }
  }

  if (gxmin === null && tiers[0]) gxmin = tiers[0].xmin;
  if (gxmax === null && tiers[0]) gxmax = tiers[0].xmax;
  return { xmin: gxmin, xmax: gxmax, tiers };
}

// Serialize a single-IntervalTier grid (used if we ever emit one from JS).
export function serializeIntervalTier({ xmin, xmax, name, intervals }) {
  const out = [];
  out.push('File type = "ooTextFile"');
  out.push('Object class = "TextGrid"');
  out.push('');
  out.push(`xmin = ${xmin} `);
  out.push(`xmax = ${xmax} `);
  out.push('tiers? <exists> ');
  out.push('size = 1 ');
  out.push('item []: ');
  out.push('    item [1]:');
  out.push('        class = "IntervalTier" ');
  out.push(`        name = "${name}" `);
  out.push(`        xmin = ${xmin} `);
  out.push(`        xmax = ${xmax} `);
  out.push(`        intervals: size = ${intervals.length} `);
  intervals.forEach((iv, i) => {
    out.push(`        intervals [${i + 1}]:`);
    out.push(`            xmin = ${iv.xmin} `);
    out.push(`            xmax = ${iv.xmax} `);
    out.push(`            text = "${iv.text}" `);
  });
  return out.join('\n') + '\n';
}
