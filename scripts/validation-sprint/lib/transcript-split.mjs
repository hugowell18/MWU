// Phase III — independent transcript module (email spec).
// Verbatim separation per speaker (turns concatenated to avoid boundary contamination),
// then two databases per speaker:
//   RAW-TIMING : keep fillers (uh/um), false starts, repairs, X placeholders.
//   TIDY-PHRASE: remove non-lexical fillers + laughter, but KEEP every exact word
//                repetition and phrase restatement (for the MWU/phrase tools).
// Also emits a transparent "cleaning index" so the word-cleaning can be verified, and the
// data needed to validate our RAW output against the client's provided standard transcript.

const DEFAULT_FILLERS = ['uh', 'uhh', 'um', 'umm', 'uhm', 'er', 'err', 'erm', 'mm', 'hmm', 'mhm', 'mm-hmm', 'mmhmm'];
const LAUGHTER = [/\[laugh[^\]]*\]/gi, /\(laugh[^)]*\)/gi, /\[laughter\]/gi, /\bha(?:ha)+\b/gi];

const tokens = (s) => s.match(/\S+/g) || [];
const wkey = (w) => w.toLowerCase().replace(/[^a-z0-9']/g, '');

// detect speaker turns; "Name:" labels split speakers, otherwise the whole text is one speaker.
function separateSpeakers(text, defaultName = 'SpeakerX') {
  const hasLabels = /(^|\n)\s*[A-Z][A-Za-z .'’-]{0,30}:\s/.test(text);
  if (!hasLabels) return [{ name: defaultName, turns: [text.trim()] }];
  const parts = text.split(/(?=(?:^|\n)\s*[A-Z][A-Za-z .'’-]{0,30}:\s)/);
  const map = new Map();
  for (const p of parts) {
    const m = p.match(/^\s*([A-Z][A-Za-z .'’-]{0,30}):\s*([\s\S]*)$/);
    if (!m) continue;
    const name = m[1].trim();
    if (!map.has(name)) map.set(name, []);
    map.get(name).push(m[2].trim());
  }
  return [...map.entries()].map(([name, turns]) => ({ name, turns }));
}

// adjacent exact word + bigram repetitions (kept in TIDY). "these these", "a method a method"
function findRepetitions(text) {
  const w = tokens(text).map((t) => ({ raw: t, k: wkey(t) })).filter((t) => t.k);
  const reps = [];
  for (let i = 0; i + 1 < w.length; i++) {
    if (w[i].k && w[i].k === w[i + 1].k) reps.push({ phrase: w[i].k, kind: 'word' });
  }
  for (let i = 0; i + 3 < w.length; i++) {
    if (w[i].k === w[i + 2].k && w[i + 1].k === w[i + 3].k && w[i].k !== w[i + 1].k)
      reps.push({ phrase: `${w[i].k} ${w[i + 1].k}`, kind: 'bigram' });
  }
  return reps;
}

function isLaughter(tok) {
  return LAUGHTER.some((re) => {
    re.lastIndex = 0;
    return re.test(tok);
  });
}

// Token-based clean → also yields a word-level RAW→TIDY diff (keep / remove per token).
function clean(text, fillers) {
  const fset = new Set(fillers.map((f) => f.toLowerCase()));
  const index = [];
  const diff = [];
  const kept = [];
  for (const tok of tokens(text)) {
    const k = tok.toLowerCase().replace(/[^a-z0-9'-]/g, '');
    const laugh = isLaughter(tok);
    if (laugh || fset.has(k)) {
      const kind = laugh ? 'laughter' : 'filler';
      index.push({ token: tok, kind, action: 'removed' });
      diff.push({ w: tok, op: 'remove', kind });
    } else {
      kept.push(tok);
      diff.push({ w: tok, op: 'keep' });
    }
  }
  const cleaned = kept.join(' ').replace(/\s+([.,!?;:])/g, '$1').trim();
  return { cleaned, index, diff };
}

export function splitTranscript(text, fillers = DEFAULT_FILLERS) {
  const speakers = separateSpeakers(text);
  const out = speakers.map((sp) => {
    // boundary control: concatenate this speaker's turns into ONE text
    const raw = sp.turns.join(' ').replace(/[ \t]+/g, ' ').trim();
    const { cleaned: tidy, index, diff } = clean(raw, fillers);
    const reps = findRepetitions(raw);
    const x_count = (raw.match(/\bX\b/g) || []).length;
    return {
      name: sp.name,
      turns: sp.turns.length,
      raw,
      tidy,
      cleaning_index: index,
      diff,
      repetitions: reps,
      x_count,
      raw_words: tokens(raw).length,
      tidy_words: tokens(tidy).length,
    };
  });

  // sprint targets a single speaker; expose the primary one plus the per-speaker array.
  const primary = out[0];
  const log = ['separated speakers: ' + speakers.map((s) => s.name).join(', '), `concatenated turns per speaker`, `removed ${primary.cleaning_index.length} non-lexical tokens`, `preserved ${primary.repetitions.length} exact repetition(s)`, `preserved ${primary.x_count} X placeholder(s)`];
  if (primary.cleaning_index.length === 0) log.push('no non-lexical fillers/laughter present in this transcript');

  return {
    speakers: out,
    raw: primary.raw + '\n',
    tidy: primary.tidy + '\n',
    report: {
      speakers: out.length,
      raw_words: primary.raw_words,
      tidy_words: primary.tidy_words,
      fillers_removed: primary.cleaning_index.length,
      repetitions_kept: primary.repetitions.length,
      x_placeholders: primary.x_count,
      cleaning_index: primary.cleaning_index,
      diff: primary.diff,
      repetitions: primary.repetitions,
      transforms: log.length,
      log,
    },
  };
}

// Validate our RAW (verbatim) output against the client's provided standard transcript.
// RAW must reproduce the master word-for-word (no distortion); report word agreement.
export function validateAgainstMaster(rawText, masterText) {
  const a = tokens(rawText).map(wkey).filter(Boolean);
  const b = tokens(masterText).map(wkey).filter(Boolean);
  let match = 0;
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < Math.min(a.length, b.length); i++) if (a[i] === b[i]) match++;
  const agreement = n ? match / n : 1;
  return {
    master_words: b.length,
    raw_words: a.length,
    words_matched: match,
    agreement,
    status: agreement >= 0.999 && a.length === b.length ? 'passed' : agreement >= 0.98 ? 'passed_with_diff' : 'failed',
  };
}
