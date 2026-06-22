import React from 'react';

const pct = (x: number) => `${(x * 100).toFixed(1)}%`;

export function TranscriptSplitPanel({ phase3 }: { phase3: any }) {
  const p = phase3 || {};
  const v = p.validation;
  const hasAsr = v && v.method === 'assemblyai';
  const reps = p.repetitions || [];
  const idx = p.cleaning_index || [];
  const alignment = v?.alignment || [];

  return (
    <>
      <div className="vc-card">
        <div className="vc-card-h">
          <div className="ci"><svg className="vc-icon" viewBox="0 0 24 24"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z" /><path d="M14 2v6h6M8 13h8M8 17h5" /></svg></div>
          <h3>Client standard transcript split</h3>
          <span className="hint">provided transcript - RAW/TIDY baseline</span>
        </div>
        <div className="vc-card-b">
          <div className="vc-kv"><span className="k">RAW-TIMING (client checked transcript, verbatim)</span><span className="v">{p.raw_words != null ? `${p.raw_words} words` : '-'}</span></div>
          <div className="vc-kv"><span className="k">TIDY-PHRASE (client checked transcript, cleaned for text tools)</span><span className="v">{p.tidy_words != null ? `${p.tidy_words} words` : '-'}</span></div>
          <div className="vc-kv"><span className="k">Repetitions / restatements kept</span><span className="v">{p.repetitions_kept ?? 0}</span></div>
          <div className="vc-kv"><span className="k">Non-lexical fillers removed (TIDY)</span><span className="v">{p.fillers_removed ?? 0}</span></div>
          {reps.length > 0 && <p className="vc-note">Repetitions kept: {reps.map((r: any, i: number) => <span className="vc-chip" key={i} style={{ marginRight: 6 }}>{r.kind}: "{r.phrase}"</span>)}</p>}
          {idx.length > 0 && <p className="vc-note">Cleaning index: {idx.slice(0, 12).map((c: any, i: number) => <span className="vc-chip amber" key={i} style={{ marginRight: 6 }}>{c.kind}: "{c.token}"</span>)}{idx.length > 12 ? ` +${idx.length - 12}` : ''}</p>}
          <p className="vc-note">These files come from the human-checked transcript Chris provided. They are the standard text outputs for this baseline run.</p>
        </div>
      </div>

      {hasAsr ? (
        <div className="vc-card">
          <div className="vc-card-h">
            <div className="ci"><svg className="vc-icon" viewBox="0 0 24 24"><path d="M3 18v-6a9 9 0 0 1 18 0v6M21 19a2 2 0 0 1-2 2h-3v-7h3zM3 19a2 2 0 0 0 2 2h3v-7H3z" /></svg></div>
            <h3>AssemblyAI transcript vs client standard</h3>
            <span className="hint">{p.asr?.model} - conf {p.asr?.confidence != null ? p.asr.confidence.toFixed(3) : '-'}</span>
          </div>
          <div className="vc-card-b">
            <div className={`vc-banner ${v.status === 'passed' ? 'pass' : v.status === 'failed' ? 'fail' : ''}`} style={v.status === 'passed_with_diff' ? { background: 'var(--amber-50)', borderColor: 'var(--amber-200)' } : {}}>
              <div className="bi" style={v.status === 'passed_with_diff' ? { background: 'var(--amber-600)' } : {}}>
                <svg className="vc-icon" viewBox="0 0 24 24"><path d={v.status === 'failed' ? 'M18 6 6 18M6 6l12 12' : 'M20 6 9 17l-5-5'} /></svg>
              </div>
              <div>
                <h4 style={v.status === 'passed_with_diff' ? { color: 'var(--amber-700)' } : {}}>
                  WER {pct(v.wer)} - word agreement {pct(v.word_agreement)} - {v.status}
                </h4>
                <p>AssemblyAI runs on the audio, then its TIDY transcript is compared with the client TIDY standard ({v.reference_words} words).</p>
              </div>
            </div>
            <table className="vc-table">
              <thead><tr><th>Metric</th><th>Value</th></tr></thead>
              <tbody>
                <tr><td>Client TIDY standard words</td><td className="num">{v.reference_words}</td></tr>
                <tr><td>AssemblyAI source</td><td className="num">{p.asr?.source || v.asr_source || '-'}</td></tr>
                <tr><td>AssemblyAI TIDY words</td><td className="num">{v.hypothesis_words}</td></tr>
                <tr><td>AssemblyAI raw words</td><td className="num">{p.asr_raw_words ?? '-'}</td></tr>
                <tr><td>Word edits (S+D+I)</td><td className="num">{v.edits}</td></tr>
                <tr><td>Substitutions (wrong word)</td><td className="num">{v.substitutions ?? '-'}</td></tr>
                <tr><td>Deletions (missing word)</td><td className="num">{v.deletions ?? '-'}</td></tr>
                <tr><td>Insertions (extra word)</td><td className="num">{v.insertions ?? '-'}</td></tr>
                <tr><td>Word Error Rate</td><td className="num">{pct(v.wer)}</td></tr>
                <tr><td>Word agreement</td><td className="num">{pct(v.word_agreement)}</td></tr>
              </tbody>
            </table>
            <p className="vc-note">Client RAW/TIDY and AssemblyAI RAW/TIDY are separate artifacts. The accuracy number is AssemblyAI TIDY vs client TIDY.</p>
          </div>
        </div>
      ) : (
        <div className="vc-banner" style={{ marginBottom: 16, background: 'var(--amber-50)', borderColor: 'var(--amber-200)' }}>
          <div className="bi" style={{ background: 'var(--amber-600)' }}>
            <svg className="vc-icon" viewBox="0 0 24 24"><path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h16.9a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z" /><path d="M12 9v4M12 17h.01" /></svg>
          </div>
          <div>
            <h4 style={{ color: 'var(--amber-700)' }}>AssemblyAI comparison skipped</h4>
            <p>{p.transcription || 'No ASSEMBLYAI_API_KEY set.'} Client RAW/TIDY files were still generated from the checked transcript.</p>
          </div>
        </div>
      )}

      {hasAsr && alignment.length > 0 && (
        <div className="vc-card">
          <div className="vc-card-h">
            <div className="ci"><svg className="vc-icon" viewBox="0 0 24 24"><path d="M9 3H5a2 2 0 0 0-2 2v4m6-6h10a2 2 0 0 1 2 2v4M3 15v4a2 2 0 0 0 2 2h4m6 0h4a2 2 0 0 0 2-2v-4" /></svg></div>
            <h3>AssemblyAI vs client word diff</h3>
            <span className="hint">{v.edits} edits - S {v.substitutions ?? 0} / D {v.deletions ?? 0} / I {v.insertions ?? 0}</span>
          </div>
          <div className="vc-card-b">
            <p className="vc-note" style={{ marginTop: 0 }}>
              Normal text = matched. <span className="vc-diff-sub" style={{ marginRight: 4 }}>client {'->'} AssemblyAI</span> = substitution.
              <span className="vc-diff-del" style={{ margin: '0 4px' }}>missing</span> = word in client standard missing from AssemblyAI.
              <span className="vc-diff-ins" style={{ marginLeft: 4 }}>+extra</span> = extra AssemblyAI word.
            </p>
            <div className="vc-diff">
              {alignment.map((d: any, i: number) => {
                if (d.op === 'substitute') return <span key={i} className="vc-diff-sub" title="substitution">{d.ref} -&gt; {d.hyp} </span>;
                if (d.op === 'delete') return <span key={i} className="vc-diff-del" title="missing in AssemblyAI">{d.ref} </span>;
                if (d.op === 'insert') return <span key={i} className="vc-diff-ins" title="extra in AssemblyAI">+{d.hyp} </span>;
                return <span key={i}>{d.ref} </span>;
              })}
            </div>
          </div>
        </div>
      )}
    </>
  );
}
