import React, { useEffect, useState } from 'react';
import { ValidationRunner } from './ValidationConsole';
import { StatusBadge } from './StatusBadge';

// Original LDT-style app shell: homepage hero + Console with a left phase sidebar.
// "Validation" is added as the top sidebar item (above Phase I); Phase I–V remain as
// workflow context/preview. Future development builds out the phase panels.

const Lock = (
  <svg className="vc-icon-sm" viewBox="0 0 24 24">
    <rect x="5" y="11" width="14" height="10" rx="2" />
    <path d="M8 11V7a4 4 0 0 1 8 0v4" />
  </svg>
);

const PHASES = [
  {
    key: 'i', roman: 'I', name: 'Diarization & Isolation', side: 'skipped',
    sub: 'skipped · monologue', locked: true,
    io: ['Group recording · speaker count (default 3)', 'AI diarization → muted-mirror WAVs → draft TextGrid', 'Reviewed TextGrid + WAVs → Phase II & III'],
    note: 'Skipped for this single-speaker validation sample — there is nothing to diarize. This is where a multilogue recording is isolated in the production workflow.',
  },
  {
    key: 'ii', roman: 'II', name: 'Pause & Duration', side: 'validated',
    sub: 'validated in this sprint',
    io: ['Reviewed TextGrid · muted-mirror WAVs', 'Script 1 (200 s window + Scale times) → Script 2 calculate_segment_durations.praat', '0.25 / 0.35 TextGrids + duration tables'],
    note: 'Exercised by the Validation run: gold replay vs the client workbook (exact), generated 0.25/0.35 drafts, generated-vs-expert diagnostic.',
  },
  {
    key: 'iii', roman: 'III', name: 'Transcript Split', side: 'validated',
    sub: 'validated in this sprint',
    io: ['Reviewed transcript', 'Split into verbatim + cleaned variants', 'RAW-TIMING.txt · TIDY-PHRASE.txt'],
    note: 'Exercised by the Validation run: RAW-TIMING (verbatim) + TIDY-PHRASE (cleaned) with a transformation log.',
  },
  {
    key: 'iv', roman: 'IV', name: 'Lexical / MWU', side: 'placeholder', locked: true,
    sub: 'placeholders · Layer 2',
    io: ['TIDY transcripts · MWU defs · AS-units', 'TAALES · TAALED · AntConc', 'Lexical / MWU feature tables → Phase V'],
    note: 'Text variables (TAALES / TAALED / AntConc) are placeholders for this validation run — columns 15+ reserved, pending_not_implemented. No values fabricated.',
  },
  {
    key: 'v', roman: 'V', name: 'Synthesis & Export', side: 'validated',
    sub: 'validated in this sprint',
    io: ['All upstream outputs + metadata', 'Merge to long-format matrix', 'validation_matrix_speakerx.xlsx / .csv'],
    note: 'Exercised by the Validation run: long-format matrix (cols 1–7 = 0.25, 8–14 = 0.35, 15+ = Phase IV placeholders).',
  },
];

export function ValidationApp() {
  const [view, setView] = useState<'home' | 'console'>('home');
  const [sel, setSel] = useState<string>('validation');
  const [report, setReport] = useState<any>(null);

  useEffect(() => {
    const p = new URLSearchParams(window.location.search);
    if (p.get('view') === 'report' || p.get('view') === 'console' || p.get('autorun')) setView('console');
    fetch('/api/report').then((r) => r.json()).then((j) => setReport(j && j.readiness !== 'idle' ? j : null)).catch(() => {});
  }, []);

  function enter() {
    setView('console');
    setSel('validation');
    window.scrollTo({ top: 0 });
  }

  const sideStatus = (k: string) => {
    if (!report) return null;
    const s = k === 'ii' ? report.phase_ii : k === 'iii' ? report.phase_iii : k === 'iv' ? report.phase_iv : k === 'v' ? report.phase_v : null;
    if (k === 'i') return 'skipped';
    if (!s) return null;
    return s.status === 'passed' ? 'passed' : s.status === 'placeholder_ready' ? 'placeholder' : s.status;
  };

  return (
    <div>
      <nav className="vc-nav">
        <div className="vc-nav-inner">
          <div className="vc-brand" onClick={() => setView('home')} style={{ cursor: 'pointer' }}>
            <div className="vc-sq">M</div>
            <div className="vc-wm">
              MWU <span>Pipeline</span>
            </div>
          </div>
          <div className="vc-tabs">
            <button className={`vc-tab ${view === 'home' ? 'active' : ''}`} onClick={() => setView('home')}>
              <svg className="vc-icon" viewBox="0 0 24 24"><path d="M3 12l9-9 9 9M5 10v10a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V10" /></svg>
              Overview
            </button>
            <button className={`vc-tab ${view === 'console' ? 'active' : ''}`} onClick={() => setView('console')}>
              <svg className="vc-icon" viewBox="0 0 24 24"><path d="M9 17v-6M15 17V7M5 21h14a2 2 0 0 0 2-2V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2Z" /></svg>
              Console
            </button>
          </div>
          <div className="vc-avatar">H</div>
        </div>
      </nav>

      {view === 'home' ? (
        <div className="vc-wrap">
          <div className="vc-hero">
            <div>
              <div className="vc-badge2"><span className="vc-ping"><b /><i /></span>MWU Pipeline · Validation Ready</div>
              <h1>L2 Dialogic Fluency<br /><span className="u">Research Pipeline</span></h1>
              <p className="lede">A phase-based, human-verifiable workflow that turns conversation recordings into publication-ready fluency &amp; multiword-unit data. Run the SpeakerX benchmark validation, then build out Phase I–V on the same console.</p>
              <div className="vc-cta2">
                <button className="vc-btn-lg vc-btn-pri" onClick={enter}>
                  <svg className="vc-icon-sm" viewBox="0 0 24 24"><path d="M5 12h14M13 6l6 6-6 6" /></svg>
                  Enter Console
                </button>
                <button className="vc-btn-lg vc-btn-out" onClick={enter}>
                  <svg className="vc-icon-sm" viewBox="0 0 24 24" style={{ stroke: 'var(--blue-600)' }}><path d="m5 3 14 9-14 9V3Z" /></svg>
                  Run Validation
                </button>
              </div>
              <div className="vc-callout2">
                <svg className="vc-icon" viewBox="0 0 24 24" style={{ width: 26, height: 26, stroke: 'var(--amber-600)', flex: '0 0 auto' }}><path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h16.9a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z" /><path d="M12 9v4M12 17h.01" /></svg>
                <div><b>Current run:</b> Validation Sprint on the SpeakerX <b>monologue</b> benchmark. Phase I (diarization) is out of scope for this single-speaker sample.</div>
              </div>
            </div>
            <div>
              <div className="vc-preview">
                <div className="wb"><i /><i /><i /></div>
                <div className="vc-prow on"><span className="n">✓</span>Validation · SpeakerX benchmark</div>
                <div className="vc-prow"><span className="n">I</span>Phase I · skipped</div>
                <div className="vc-prow"><span className="n">II</span>Phase II · Pause &amp; Duration</div>
                <div className="vc-prow"><span className="n">III</span>Phase III · Transcript Split</div>
                <div className="vc-prow"><span className="n">IV</span>Phase IV · placeholders</div>
                <div className="vc-prow"><span className="n">V</span>Phase V · Matrix</div>
              </div>
            </div>
          </div>

          <div className="vc-features2">
            <div className="vc-feat"><div className="fi"><svg className="vc-icon" viewBox="0 0 24 24" style={{ width: 22, height: 22 }}><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" /><path d="M22 4 12 14.01l-3-3" /></svg></div><h3>Gold validation</h3><p>One Run Validation reproduces the client's Praat/Excel baseline exactly — count exact, durations ≤ 0.001 s.</p></div>
            <div className="vc-feat"><div className="fi"><svg className="vc-icon" viewBox="0 0 24 24" style={{ width: 22, height: 22 }}><path d="M3 3h18v18H3zM3 9h18M9 3v18" /></svg></div><h3>Praat automation</h3><p>Script 1 (200 s window + Scale times) and Script 2 (calculate_segment_durations.praat) run headless.</p></div>
            <div className="vc-feat"><div className="fi"><svg className="vc-icon" viewBox="0 0 24 24" style={{ width: 22, height: 22 }}><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z" /><path d="M14 2v6h6" /></svg></div><h3>Phase-based console</h3><p>Validation today; Phase I–V modules build out on the same left-rail console for future development.</p></div>
          </div>
        </div>
      ) : (
        <div className="vc-wrap">
          <div className="vc-console-head">
            <h2>Workflow Console</h2>
            <p className="sub">Validation runs the SpeakerX benchmark end-to-end. Phase I–V are the workflow modules — context for now, built out next.</p>
          </div>
          <div className="vc-layout">
            <aside className="vc-side">
              <div className="st">Console</div>
              <div className="vc-pnav">
                <button className={`vc-pitem ${sel === 'validation' ? 'active' : ''}`} onClick={() => setSel('validation')}>
                  <span className="vc-pnum" style={{ background: sel === 'validation' ? 'var(--blue-600)' : undefined, color: sel === 'validation' ? '#fff' : undefined, borderColor: sel === 'validation' ? 'transparent' : undefined }}>✦</span>
                  <span>
                    <span className="vc-pn">Validation</span>
                    <span className="vc-ps">SpeakerX benchmark</span>
                  </span>
                  <span className="vc-side-badge2">{report ? (report.readiness === 'ready' ? 'passed' : report.readiness) : 'run'}</span>
                </button>
                <div className="st" style={{ paddingTop: 12 }}>Workflow phases</div>
                {PHASES.map((p) => (
                  <button key={p.key} className={`vc-pitem ${sel === p.key ? 'active' : ''} ${p.locked ? 'locked' : ''}`} onClick={() => setSel(p.key)}>
                    <span className="vc-pnum">{p.roman}</span>
                    <span>
                      <span className="vc-pn">{p.name}</span>
                      <span className="vc-ps" style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                        {p.locked && Lock}
                        {p.sub}
                      </span>
                    </span>
                    <span className="vc-side-badge2">{sideStatus(p.key) || ''}</span>
                  </button>
                ))}
              </div>
              <div className="vc-scope">“Validation” runs the benchmark now. Phase I–V are workflow context for future development on this console.</div>
            </aside>

            <div className="panel">
              {sel === 'validation' ? (
                <ValidationRunner />
              ) : (
                <PhasePreview phase={PHASES.find((p) => p.key === sel)!} status={sideStatus(sel)} />
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function PhasePreview({ phase, status }: { phase: any; status: string | null }) {
  return (
    <div>
      <div className="vc-phead">
        <span className="vc-ph-no" style={{ background: phase.locked ? 'var(--slate-400)' : 'var(--blue-600)' }}>{phase.roman}</span>
        <h2>Phase {phase.roman} — {phase.name}</h2>
        <StatusBadge state={phase.side === 'skipped' ? 'skipped' : phase.side === 'placeholder' ? 'generated_no_gold' : status === 'passed' ? 'passed' : 'ready'} />
      </div>
      <div className="vc-card">
        <div className="vc-card-h">
          <h3>Module context</h3>
          <span className="hint">workflow preview</span>
        </div>
        <div className="vc-card-b">
          <p className="vc-note" style={{ marginTop: 0 }}>{phase.note}</p>
          <div className="vc-io">
            <div className="b"><h6>Input</h6><p>{phase.io[0]}</p></div>
            <div className="b"><h6>Process</h6><p>{phase.io[1]}</p></div>
            <div className="b"><h6>Output</h6><p>{phase.io[2]}</p></div>
          </div>
        </div>
      </div>
      <div className="vc-card">
        <div className="vc-card-b" style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <svg className="vc-icon" viewBox="0 0 24 24" style={{ width: 20, height: 20, stroke: 'var(--blue-600)' }}><path d="M9 17v-6M15 17V7M5 21h14a2 2 0 0 0 2-2V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2Z" /></svg>
          <p className="vc-note" style={{ margin: 0 }}>
            This phase is shown as workflow context. The functional run for this validation sprint lives under the <b>Validation</b> item — open it and press <b>Run Validation</b>.
          </p>
        </div>
      </div>
    </div>
  );
}
