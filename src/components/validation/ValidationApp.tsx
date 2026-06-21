import React, { useEffect, useState } from 'react';
import { ValidationRunner } from './ValidationConsole';
import { StatusBadge } from './StatusBadge';

// Validation app shell: homepage hero + Console with a left phase sidebar.
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

const HERO_SLIDES = [
  {
    src: '/assets/overview/overview-l2-seminar.png',
    title: 'International L2 speaking data',
    caption: 'Small-group spoken English tasks become analyzable fluency and vocabulary evidence.',
  },
  {
    src: '/assets/overview/overview-campus-dialogue.png',
    title: 'Dialogic fluency in context',
    caption: 'The workflow is designed for real conversational performance, not only isolated monologues.',
  },
  {
    src: '/assets/overview/overview-language-class.png',
    title: 'Research-ready language learning',
    caption: 'Human review remains the final evidence layer while automation reduces repetitive preparation work.',
  },
];

const OVERVIEW_PHASES = [
  {
    roman: 'I',
    title: 'Speaker Isolation',
    body: 'Separate multilogue recordings into reviewed speaker-specific audio tracks before acoustic analysis.',
    status: 'Future multilogue module',
  },
  {
    roman: 'II',
    title: 'Pause & Duration',
    body: 'Run Praat-based pause extraction at configurable thresholds and calculate sounding/silent durations.',
    status: 'Validated by SpeakerX benchmark',
  },
  {
    roman: 'III',
    title: 'Transcript Split',
    body: 'Prepare RAW-TIMING and TIDY-PHRASE transcript files for later fluency and lexical work.',
    status: 'Validated by SpeakerX benchmark',
  },
  {
    roman: 'IV',
    title: 'Lexical / MWU Features',
    body: 'Reserve TAALES, TAALED, AntConc and multiword-unit variables once definitions are signed off.',
    status: 'Placeholders in validation',
  },
  {
    roman: 'V',
    title: 'Matrix Export',
    body: 'Compile parallel 0.25 and 0.35 threshold columns plus Phase IV text-variable fields.',
    status: 'Validated by SpeakerX benchmark',
  },
];

export function ValidationApp() {
  const [view, setView] = useState<'home' | 'console'>('home');
  const [sel, setSel] = useState<string>('validation');
  const [report, setReport] = useState<any>(null);
  const [heroIndex, setHeroIndex] = useState(0);

  useEffect(() => {
    const p = new URLSearchParams(window.location.search);
    if (p.get('view') === 'report' || p.get('view') === 'console' || p.get('autorun')) setView('console');
    fetch('/api/report').then((r) => r.json()).then((j) => setReport(j && j.readiness !== 'idle' ? j : null)).catch(() => {});
  }, []);

  useEffect(() => {
    if (view !== 'home') return;
    const timer = window.setInterval(() => {
      setHeroIndex((i) => (i + 1) % HERO_SLIDES.length);
    }, 5200);
    return () => window.clearInterval(timer);
  }, [view]);

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
          <section className="vc-hero-new">
            <div className="vc-hero-copy">
              <h1>L2 fluency and multiword-unit research, built for real spoken data.</h1>
              <p className="lede">The project studies how second-language speakers use multiword sequences during spoken performance, and how those patterns relate to pause behavior, repair, and speed fluency. The software turns audio, Praat-reviewed timing, transcripts, and lexical tools into a reproducible research matrix.</p>
              <div className="vc-hero-actions">
                <button className="vc-btn-lg vc-btn-pri" onClick={enter}>
                  <svg className="vc-icon-sm" viewBox="0 0 24 24"><path d="M5 12h14M13 6l6 6-6 6" /></svg>
                  Open Validation Console
                </button>
                <button className="vc-btn-lg vc-btn-out" onClick={enter}>
                  <svg className="vc-icon-sm" viewBox="0 0 24 24" style={{ stroke: 'var(--blue-600)' }}><path d="m5 3 14 9-14 9V3Z" /></svg>
                  Run SpeakerX Benchmark
                </button>
              </div>
              <div className="vc-hero-proof">
                <span>Research line</span>
                <b>fluency × vocabulary × reviewed Praat evidence</b>
              </div>
            </div>
            <div className="vc-hero-gallery" aria-label="International L2 research image carousel">
              {HERO_SLIDES.map((slide, i) => (
                <img
                  key={slide.src}
                  src={slide.src}
                  alt={slide.title}
                  className={`vc-hero-img ${i === heroIndex ? 'active' : ''}`}
                />
              ))}
              <div className="vc-hero-caption">
                <p>{HERO_SLIDES[heroIndex].title}</p>
                <span>{HERO_SLIDES[heroIndex].caption}</span>
              </div>
              <div className="vc-hero-dots">
                {HERO_SLIDES.map((slide, i) => (
                  <button
                    key={slide.src}
                    className={i === heroIndex ? 'active' : ''}
                    onClick={() => setHeroIndex(i)}
                    aria-label={`Show hero image ${i + 1}`}
                  />
                ))}
              </div>
            </div>
          </section>

          <section className="vc-research-band">
            <div>
              <span className="vc-section-k">Research Background</span>
              <h2>Why the workflow exists</h2>
            </div>
            <div className="vc-research-grid">
              <div>
                <h3>Utterance fluency</h3>
                <p>Praat timing supports breakdown and speed measures: silent pauses, sounding time, articulation rate, and pause density.</p>
              </div>
              <div>
                <h3>Multiword vocabulary</h3>
                <p>Transcripts feed lexical-bundle and MWU analysis so vocabulary use can be studied beyond single-word counts.</p>
              </div>
              <div>
                <h3>Human-verifiable data</h3>
                <p>Automation creates drafts and matrices; reviewed Praat/TextGrid and workbook checks remain the evidence boundary.</p>
              </div>
            </div>
          </section>

          <section className="vc-phase-runway">
            <div className="vc-section-head">
              <span className="vc-section-k">Five-stage research workflow</span>
              <h2>From spoken interaction to a reproducible research matrix</h2>
            </div>
            <div className="vc-phase-grid">
              {OVERVIEW_PHASES.map((phase) => (
                <article key={phase.roman} className="vc-phase-card">
                  <div className="vc-phase-roman">{phase.roman}</div>
                  <h3>{phase.title}</h3>
                  <p>{phase.body}</p>
                  <span>{phase.status}</span>
                </article>
              ))}
            </div>
          </section>

          <section className="vc-validation-strip">
            <div>
              <span className="vc-section-k">Current delivery</span>
              <h2>SpeakerX validation benchmark</h2>
              <p>The current runnable package uses the supplied monologue WAV, expert TextGrid, transcript, and workbook to prove Phase II, Phase III, Phase IV placeholders, and Phase V export before official multilogue data arrives.</p>
            </div>
            <button className="vc-btn-lg vc-btn-pri" onClick={enter}>Run Validation</button>
          </section>
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
