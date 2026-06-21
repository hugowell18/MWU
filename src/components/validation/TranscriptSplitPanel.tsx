import React from 'react';

const Check = (<svg className="vc-icon-sm" viewBox="0 0 24 24"><path d="M20 6 9 17l-5-5" /></svg>);
const pct = (x: number) => `${(x * 100).toFixed(1)}%`;

export function TranscriptSplitPanel({ phase3 }: { phase3: any }) {
  const p = phase3 || {};
  const asr = p.transcription && p.transcription.startsWith('assemblyai') && p.validation && p.validation.method === 'assemblyai';
  const v = p.validation;
  const reps = p.repetitions || [];
  const idx = p.cleaning_index || [];
  const diff = p.diff || [];
  const removed = diff.filter((d: any) => d.op === 'remove').length;

  return (
    <>
      {asr ? (
        <div className="vc-card">
          <div className="vc-card-h">
            <div className="ci"><svg className="vc-icon" viewBox="0 0 24 24"><path d="M3 18v-6a9 9 0 0 1 18 0v6M21 19a2 2 0 0 1-2 2h-3v-7h3zM3 19a2 2 0 0 0 2 2h3v-7H3z" /></svg></div>
            <h3>AI transcript vs client standard — real ASR (AssemblyAI)</h3>
            <span className="hint">{p.asr?.model} · conf {p.asr?.confidence != null ? p.asr.confidence.toFixed(3) : '—'}</span>
          </div>
          <div className="vc-card-b">
            <div className={`vc-banner ${v.status === 'passed' ? 'pass' : v.status === 'failed' ? 'fail' : ''}`} style={v.status === 'passed_with_diff' ? { background: 'var(--amber-50)', borderColor: 'var(--amber-200)' } : {}}>
              <div className="bi" style={v.status === 'passed_with_diff' ? { background: 'var(--amber-600)' } : {}}>
                <svg className="vc-icon" viewBox="0 0 24 24"><path d={v.status === 'failed' ? 'M18 6 6 18M6 6l12 12' : 'M20 6 9 17l-5-5'} /></svg>
              </div>
              <div>
                <h4 style={v.status === 'passed_with_diff' ? { color: 'var(--amber-700)' } : {}}>
                  WER {pct(v.wer)} · word agreement {pct(v.word_agreement)} — {v.status}
                </h4>
                <p>Our independent AssemblyAI transcript of the .wav compared to your provided standard answer ({v.reference_words} words).</p>
              </div>
            </div>
            <table className="vc-table">
              <thead><tr><th>Metric</th><th>Value</th></tr></thead>
              <tbody>
                <tr><td>Reference (standard) words</td><td className="num">{v.reference_words}</td></tr>
                <tr><td>ASR (our AI) words</td><td className="num">{v.hypothesis_words}</td></tr>
                <tr><td>Word edits (S+D+I)</td><td className="num">{v.edits}</td></tr>
                <tr><td>Word Error Rate</td><td className="num">{pct(v.wer)}</td></tr>
                <tr><td>Word agreement</td><td className="num">{pct(v.word_agreement)}</td></tr>
              </tbody>
            </table>
            <p className="vc-note">This is the real “AI solution vs standard answer” check: ASR runs on the audio, then we measure WER against your transcript. The RAW/TIDY files below are split from the AI transcript.</p>
          </div>
        </div>
      ) : (
        <div className="vc-banner" style={{ marginBottom: 16, background: 'var(--amber-50)', borderColor: 'var(--amber-200)' }}>
          <div className="bi" style={{ background: 'var(--amber-600)' }}>
            <svg className="vc-icon" viewBox="0 0 24 24"><path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h16.9a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z" /><path d="M12 9v4M12 17h.01" /></svg>
          </div>
          <div>
            <h4 style={{ color: 'var(--amber-700)' }}>No speech recognition ran — split-only</h4>
            <p>{p.transcription || 'No ASSEMBLYAI_API_KEY set.'} Set <span className="vc-mono">ASSEMBLYAI_API_KEY</span> in <span className="vc-mono">.env</span> and re-run to do the real ASR-vs-standard (WER) check. RAW is currently a verbatim copy of the provided transcript (not a validation).</p>
          </div>
        </div>
      )}

      <div className="vc-card">
        <div className="vc-card-h">
          <div className="ci"><svg className="vc-icon" viewBox="0 0 24 24"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z" /><path d="M14 2v6h6M8 13h8M8 17h5" /></svg></div>
          <h3>Two text databases + cleaning index</h3>
          <span className="hint">{asr ? 'split from AI transcript' : 'split from provided transcript'}</span>
        </div>
        <div className="vc-card-b">
          <div className="vc-kv"><span className="k">RAW-TIMING (verbatim — fillers / false starts / repairs / X kept)</span><span className="v">{p.raw_words != null ? `${p.raw_words} words` : '—'}</span></div>
          <div className="vc-kv"><span className="k">TIDY-PHRASE (fillers/laughter removed — repetitions kept)</span><span className="v">{p.tidy_words != null ? `${p.tidy_words} words` : '—'}</span></div>
          <div className="vc-kv"><span className="k">Repetitions / restatements kept</span><span className="v">{p.repetitions_kept ?? 0}</span></div>
          <div className="vc-kv"><span className="k">Non-lexical fillers removed (TIDY)</span><span className="v">{p.fillers_removed ?? 0}</span></div>
          {reps.length > 0 && <p className="vc-note">Repetitions kept: {reps.map((r: any, i: number) => <span className="vc-chip" key={i} style={{ marginRight: 6 }}>{r.kind}: “{r.phrase}”</span>)}</p>}
          {idx.length > 0 && <p className="vc-note">Cleaning index: {idx.slice(0, 12).map((c: any, i: number) => <span className="vc-chip amber" key={i} style={{ marginRight: 6 }}>{c.kind}: “{c.token}”</span>)}{idx.length > 12 ? ` +${idx.length - 12}` : ''}</p>}
          <p className="vc-note">Each speaker's turns are concatenated into one file to prevent cross-turn boundary contamination of the phrase/MWU tools.</p>
        </div>
      </div>

      {/* word-level RAW → TIDY diff */}
      {diff.length > 0 && (
        <div className="vc-card">
          <div className="vc-card-h">
            <div className="ci"><svg className="vc-icon" viewBox="0 0 24 24"><path d="M9 3H5a2 2 0 0 0-2 2v4m6-6h10a2 2 0 0 1 2 2v4M3 15v4a2 2 0 0 0 2 2h4m6 0h4a2 2 0 0 0 2-2v-4" /></svg></div>
            <h3>RAW → TIDY word diff</h3>
            <span className="hint">{removed} removed · {diff.length - removed} kept</span>
          </div>
          <div className="vc-card-b">
            <p className="vc-note" style={{ marginTop: 0 }}>
              <span className="vc-diff-rm" style={{ marginRight: 4 }}>struck red</span> = removed in TIDY (non-lexical fillers / laughter). Everything else — including <b>every exact repetition and restatement</b> — is kept.
              {removed === 0 && <> The ASR transcript had no non-lexical fillers, so TIDY equals RAW here.</>}
            </p>
            <div className="vc-diff">
              {diff.map((d: any, i: number) => (
                d.op === 'remove'
                  ? <span key={i} className="vc-diff-rm" title={d.kind}>{d.w} </span>
                  : <span key={i}>{d.w} </span>
              ))}
            </div>
          </div>
        </div>
      )}
    </>
  );
}
