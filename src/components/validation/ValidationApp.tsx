import React, { useEffect, useState } from 'react';
import {
  ArrowRight,
  AudioWaveform,
  BookOpenCheck,
  CheckCircle2,
  ChevronRight,
  CircleGauge,
  FileAudio,
  FileOutput,
  Flag,
  Gauge,
  Layers3,
  ListChecks,
  Network,
  ShieldCheck,
  SlidersHorizontal,
  TableProperties,
  Tags,
  UsersRound,
  Workflow,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { ValidationRunner } from './ValidationConsole';
import { MultilogueV2Runner } from './MultilogueV2Runner';

type LayerKey = 'l1a' | 'l1b' | 'l2' | 'l3';

type LayerDefinition = {
  key: LayerKey;
  short: string;
  phase: string;
  title: string;
  nav: string;
  navDetail: string;
  summary: string;
  icon: LucideIcon;
  inputs: string[];
  process: Array<{ title: string; detail: string }>;
  outputs: string[];
  handoff: string;
  startCondition?: string;
};

const LAYERS: LayerDefinition[] = [
  {
    key: 'l1a',
    short: 'L1a',
    phase: 'Phase I',
    title: 'Shared Evidence, Speaker Attribution & Isolation',
    nav: 'Speaker Evidence',
    navDetail: 'Attribution · N listening tracks',
    summary: 'Establish one canonical audio clock, attribute speaker activity and preserve the evidence needed to build the interaction timeline.',
    icon: UsersRound,
    inputs: [
      'Original room-mix WAV',
      'Task start and end boundaries',
      'Automatic or configured speaker count (two or more)',
      'Canonical speaker IDs',
      'Approved AI-provider configuration',
    ],
    process: [
      { title: 'Audio preflight', detail: 'Validate PCM/WAV and establish the canonical timeline.' },
      { title: 'Evidence extraction', detail: 'Collect diarization, timed-word and room-activity evidence.' },
      { title: 'Speaker mapping', detail: 'Map provider identities to canonical speaker IDs.' },
      { title: 'Stage 1 classification', detail: 'Record vocalisation, laughter, artifact and uncertainty evidence.' },
    ],
    outputs: [
      'Speaker activity RTTM, CSV and JSON',
      'Speaker-attribution TextGrid',
      'One full-duration muted-mirror WAV per speaker',
      'Confidence and review flags',
      'Provider evidence archive',
      'Phase I manifest and canonical-clock report',
      'Callable floor and nine-label engine',
    ],
    handoff: 'Phase I evidence and the callable label engine continue to L1b. Timed transcript evidence also continues to Layer 2.',
  },
  {
    key: 'l1b',
    short: 'L1b',
    phase: 'Phase II',
    title: 'Multi-Threshold Praat/TextGrid Automation',
    nav: 'Interaction Timing',
    navDetail: 'P025/P035 · N+3 TextGrid',
    summary: 'Run the approved interaction method independently for each pause threshold and package a Praat-readable draft for researcher correction.',
    icon: AudioWaveform,
    inputs: [
      'Original room-mix WAV',
      'L1a evidence and callable engine',
      'Versioned method parameters',
      'P025/P035 or another configured threshold list',
      'Research-team review strategy',
    ],
    process: [
      { title: 'Independent threshold runs', detail: 'Execute P025 and P035 separately on the canonical timeline.' },
      { title: 'Floor resolution', detail: 'Apply persistent floor rules R1–R5.' },
      { title: 'Nine-label timeline', detail: 'Assign s, f, bc, ol, op, pf, tr, shs and x.' },
      { title: 'Path B transitions', detail: 'Record overlap present with offset not measured; never serialize missing FTO as zero.' },
      { title: 'Praat validation', detail: 'Check full coverage, tier schema and replay manifests.' },
    ],
    outputs: [
      'One dynamic N+3-tier TextGrid per threshold',
      'Nine-label interval table',
      'Floor timeline, turn-end/start, raw-gap and transition evidence',
      'Review flags and interaction summary',
      'Duration summary and per-pause table',
      'Overlap capability, evidence IDs and missing-FTO flags',
      'Method, provenance and validation reports',
    ],
    handoff: 'The researcher-reviewed nine-label timeline continues to Phase IV. Signed FTO, where supported, is reserved for Phase V.',
    startCondition: 'Draft outputs remain reviewable. The researcher-corrected TextGrid becomes the accepted downstream artifact.',
  },
  {
    key: 'l2',
    short: 'L2',
    phase: 'Phases III–IV + early V',
    title: 'Transcript & Research Analysis Expansion',
    nav: 'Research Analysis',
    navDetail: 'Transcript · AS-units · MWU',
    summary: 'Create reviewed transcript units and derive lexical, MWU, pause-location and rate features under signed research definitions.',
    icon: BookOpenCheck,
    inputs: [
      'Timed transcript evidence from L1a',
      'Reviewed nine-label timeline from L1b',
      'Transcript and disfluency conventions',
      'AS-unit, clause, MWU and rate definitions',
      'Representative gold examples',
    ],
    process: [
      { title: 'Transcript split', detail: 'Prepare RAW-TIMING and TIDY-PHRASE forms.' },
      { title: 'Unit mapping', detail: 'Apply approved AS-unit and clause boundaries.' },
      { title: 'Feature extraction', detail: 'Run lexical, MWU, pause-location and rate calculations.' },
      { title: 'Alignment review', detail: 'Include reviewed word alignment where signed definitions require it.' },
    ],
    outputs: [
      'RAW-TIMING and TIDY-PHRASE transcripts',
      'AS-unit and clause mapping tables',
      'Lexical and MWU feature tables',
      'Label-aware pause-location features',
      'Rate metrics and early Phase V merge table',
    ],
    handoff: 'Accepted feature tables and method notes continue to the Layer 3 synthesis workspace.',
    startCondition: 'Starts after the research team signs the transcript, AS-unit/clause, MWU, syllable/repair and tool definitions.',
  },
  {
    key: 'l3',
    short: 'L3',
    phase: 'Phase V',
    title: 'Matrix, Validation & Research Export',
    nav: 'Final Synthesis',
    navDetail: 'Matrix · reports · archive',
    summary: 'Merge accepted upstream artifacts into a traceable research matrix, validation package and archive-ready operational export.',
    icon: TableProperties,
    inputs: [
      'Accepted Layer 1 interaction metrics',
      'Accepted Layer 2 transcript and research features',
      'Signed matrix schema and codebook',
      'Expected sample rows and validation rules',
    ],
    process: [
      { title: 'Cross-layer merge', detail: 'Join timing, speaker, transcript and research-feature evidence.' },
      { title: 'Schema validation', detail: 'Check types, required fields, lineage and unsupported values.' },
      { title: 'Research export', detail: 'Compile the workbook, R/Python matrix and codebook.' },
      { title: 'Archive package', detail: 'Bundle method logs, validation evidence and manifests.' },
    ],
    outputs: [
      'R/Python-ready analysis matrix',
      'Research workbook and data codebook',
      'Gold/reference comparison report',
      'Method log and validation package',
      'Archive manifest and downloadable artifact set',
    ],
    handoff: 'Final outputs are released only from accepted upstream artifacts; unsupported fields remain pending or are excluded by agreement.',
    startCondition: 'Starts after the final matrix schema, codebook, expected sample rows and validation package are signed.',
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
  { roman: 'I', title: 'Shared Evidence', body: 'Create the canonical clock, speaker attribution, N muted-mirror listening tracks and reusable evidence engine.', status: 'Layer 1a' },
  { roman: 'II', title: 'Interaction Timing', body: 'Resolve floor state and nine labels independently at each configured pause threshold.', status: 'Layer 1b' },
  { roman: 'III', title: 'Transcript Units', body: 'Prepare verbatim and tidy transcripts with approved AS-unit and clause mappings.', status: 'Layer 2' },
  { roman: 'IV', title: 'Lexical / MWU', body: 'Combine reviewed interaction timing with lexical, MWU, pause-location and rate features.', status: 'Layer 2' },
  { roman: 'V', title: 'Research Export', body: 'Compile accepted evidence into the final matrix, codebook, validation and archive package.', status: 'Layer 3' },
];

const NINE_LABELS = [
  ['s', 'speech'], ['f', 'filled hesitation'], ['bc', 'backchannel'], ['ol', 'overlap'], ['op', 'own pause'],
  ['pf', 'passive floor'], ['tr', 'transition'], ['shs', 'shared silence'], ['x', 'unusable audio'],
];

function LayerWorkspace({ layer }: { layer: LayerDefinition }) {
  const Icon = layer.icon;
  const isL1b = layer.key === 'l1b';
  const isLayer1 = layer.key === 'l1a' || isL1b;

  return (
    <div className="vc-layer-page">
      <header className="vc-layer-head">
        <div className="vc-layer-icon"><Icon size={22} /></div>
        <div>
          <div className="vc-layer-eyebrow"><span>{layer.short}</span>{layer.phase}</div>
          <h1>{layer.title}</h1>
          <p>{layer.summary}</p>
        </div>
        <div className="vc-method-state"><ShieldCheck size={15} /> {isLayer1 ? 'Method baseline' : 'Definition-gated'}</div>
      </header>

      <div className="vc-contract-grid">
        <section className="vc-contract-card">
          <div className="vc-contract-title"><FileAudio size={17} /><span>Inputs</span></div>
          <ul>{layer.inputs.map((item) => <li key={item}><CheckCircle2 size={14} />{item}</li>)}</ul>
        </section>
        <section className="vc-contract-card vc-contract-output">
          <div className="vc-contract-title"><FileOutput size={17} /><span>Outputs</span></div>
          <ul>{layer.outputs.map((item) => <li key={item}><ChevronRight size={14} />{item}</li>)}</ul>
        </section>
      </div>

      <section className="vc-process-card">
        <div className="vc-process-head">
          <div><span className="vc-section-k">Automation path</span><h2>{isLayer1 ? 'Canonical evidence processing' : 'Research processing'}</h2></div>
          {isL1b && <div className="vc-path-badge"><Network size={14} /> Path B baseline</div>}
        </div>
        <div className={`vc-process-flow ${layer.process.length === 5 ? 'five' : ''}`}>
          {layer.process.map((step, index) => (
            <React.Fragment key={step.title}>
              <div className="vc-process-step">
                <span>{String(index + 1).padStart(2, '0')}</span>
                <strong>{step.title}</strong>
                <p>{step.detail}</p>
              </div>
              {index < layer.process.length - 1 && <ArrowRight className="vc-process-arrow" size={16} />}
            </React.Fragment>
          ))}
        </div>
      </section>

      {isL1b && (
        <div className="vc-method-grid-new">
          <section className="vc-method-panel">
            <div className="vc-contract-title"><SlidersHorizontal size={17} /><span>Threshold configuration</span></div>
            <div className="vc-threshold-row">
              <div><b>P025</b><span>0.25 s independent run</span></div>
              <div><b>P035</b><span>0.35 s independent run</span></div>
              <div><b>200 s</b><span>intensity window</span></div>
              <div><b>N+3</b><span>dynamic tier schema</span></div>
            </div>
          </section>
          <section className="vc-method-panel">
            <div className="vc-contract-title"><Tags size={17} /><span>Nine timeline labels</span></div>
            <div className="vc-label-grid">
              {NINE_LABELS.map(([code, name]) => <span key={code}><b>{code}</b>{name}</span>)}
            </div>
          </section>
        </div>
      )}

      {isL1b && (
        <section className="vc-rule-strip">
          <div><ListChecks size={17} /><strong>Floor rules</strong></div>
          <span>R1 start FREE</span><span>R2 claim floor</span><span>R3 retain floor</span><span>R4 competing turn</span><span>R5 resolve silence</span>
        </section>
      )}

      {layer.startCondition && (
        <section className="vc-start-note">
          <Flag size={17} />
          <div><strong>{isLayer1 ? 'Review state' : 'Start condition'}</strong><p>{layer.startCondition}</p></div>
        </section>
      )}

      <section className="vc-handoff">
        <div className="vc-handoff-icon"><Workflow size={18} /></div>
        <div><span>Downstream handoff</span><p>{layer.handoff}</p></div>
        <ArrowRight size={18} />
      </section>
    </div>
  );
}

function InternalValidation({ mode, setMode }: { mode: 'speakerx' | 'multilogue'; setMode: (mode: 'speakerx' | 'multilogue') => void }) {
  const [report, setReport] = useState<any>(null);
  const [multilogueInput, setMultilogueInput] = useState<any>(null);
  const [multilogueReport, setMultilogueReport] = useState<any>(null);

  useEffect(() => {
    fetch('/api/report').then((r) => r.json()).then((j) => setReport(j && j.readiness !== 'idle' ? j : null)).catch(() => {});
    fetch('/api/multilogue-v2/input').then((r) => r.json()).then(setMultilogueInput).catch(() => {});
    fetch('/api/multilogue-v2/report').then((r) => r.json()).then((j) => setMultilogueReport(j && j.status !== 'idle' ? j : null)).catch(() => {});
  }, []);

  return (
    <div className="vc-internal">
      <div className="vc-internal-switch" aria-label="Internal regression selector">
        <button className={mode === 'speakerx' ? 'active' : ''} onClick={() => setMode('speakerx')}>SpeakerX</button>
        <button className={mode === 'multilogue' ? 'active' : ''} onClick={() => setMode('multilogue')}>Multilogue04</button>
      </div>
      {mode === 'speakerx'
        ? <ValidationRunner report={report} onReport={setReport} />
        : <MultilogueV2Runner input={multilogueInput} initialReport={multilogueReport} onReport={setMultilogueReport} />}
    </div>
  );
}

function MethodologyAtlas() {
  return (
    <main className="vc-atlas-page">
      <header className="vc-atlas-head">
        <div>
          <span className="vc-section-k">Academic reference</span>
          <h1>Methodology Atlas</h1>
          <p>Five-phase workflow, dynamic N+3 TextGrid contract, nine timeline labels and floor rules R1–R5.</p>
        </div>
        <a href="/methodology-atlas.html#workflow" target="_blank" rel="noreferrer">Open standalone <ArrowRight size={15} /></a>
      </header>
      <iframe className="vc-atlas-frame" src="/methodology-atlas.html?embed=1#workflow" title="MWU Pipeline Methodology Atlas" />
    </main>
  );
}

export function ValidationApp() {
  const [view, setView] = useState<'home' | 'workspace' | 'methodology'>('home');
  const [selectedLayer, setSelectedLayer] = useState<LayerKey>('l1a');
  const [heroIndex, setHeroIndex] = useState(0);
  const [internalValidation, setInternalValidation] = useState(false);
  const [internalMode, setInternalMode] = useState<'speakerx' | 'multilogue'>('multilogue');

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const requestedLayer = params.get('layer') as LayerKey | null;
    if (requestedLayer && LAYERS.some((layer) => layer.key === requestedLayer)) {
      setSelectedLayer(requestedLayer);
      setView('workspace');
    }
    if (params.get('internal') === 'validation') {
      setInternalValidation(true);
      setView('workspace');
      if (params.get('benchmark') === 'speakerx') setInternalMode('speakerx');
    }
    if (params.get('view') === 'methodology') setView('methodology');
  }, []);

  useEffect(() => {
    if (view !== 'home') return;
    const timer = window.setInterval(() => setHeroIndex((index) => (index + 1) % HERO_SLIDES.length), 5200);
    return () => window.clearInterval(timer);
  }, [view]);

  function openLayer(layer: LayerKey) {
    setInternalValidation(false);
    setSelectedLayer(layer);
    setView('workspace');
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  const selected = LAYERS.find((layer) => layer.key === selectedLayer)!;

  return (
    <div>
      <nav className="vc-nav">
        <div className="vc-nav-inner">
          <button className="vc-brand" onClick={() => setView('home')}>
            <div className="vc-sq">M</div>
            <div className="vc-wm">MWU <span>Pipeline</span></div>
          </button>
          <div className="vc-tabs">
            <button title="Overview" className={`vc-tab ${view === 'home' ? 'active' : ''}`} onClick={() => setView('home')}><CircleGauge size={16} /> Overview</button>
            <button title="Workspace" className={`vc-tab ${view === 'workspace' ? 'active' : ''}`} onClick={() => setView('workspace')}><Layers3 size={16} /> Workspace</button>
            <button title="Methodology Atlas" className={`vc-tab ${view === 'methodology' ? 'active' : ''}`} onClick={() => setView('methodology')}><BookOpenCheck size={16} /> Methodology</button>
          </div>
          <div className="vc-avatar">H</div>
        </div>
      </nav>

      {view === 'home' ? (
        <main className="vc-wrap">
          <section className="vc-hero-new">
            <div className="vc-hero-copy">
              <h1>From multilogue audio to reviewable research evidence.</h1>
              <p className="lede">A five-phase workflow for L2 fluency and multiword vocabulary research, combining speaker attribution, Praat-compatible interaction timing, reviewed transcripts and traceable research exports.</p>
              <div className="vc-hero-actions">
                <button className="vc-btn-lg vc-btn-pri" onClick={() => openLayer('l1a')}><UsersRound size={17} /> Open Layer 1a</button>
                <button className="vc-btn-lg vc-btn-out" onClick={() => openLayer('l1b')}><AudioWaveform size={17} /> Review Layer 1b</button>
              </div>
              <div className="vc-hero-proof"><span>Research line</span><b>fluency × vocabulary × reviewed Praat evidence</b></div>
            </div>
            <div className="vc-hero-gallery" aria-label="International L2 research image carousel">
              {HERO_SLIDES.map((slide, index) => <img key={slide.src} src={slide.src} alt={slide.title} className={`vc-hero-img ${index === heroIndex ? 'active' : ''}`} />)}
              <div className="vc-hero-caption"><p>{HERO_SLIDES[heroIndex].title}</p><span>{HERO_SLIDES[heroIndex].caption}</span></div>
              <div className="vc-hero-dots">
                {HERO_SLIDES.map((slide, index) => <button key={slide.src} className={index === heroIndex ? 'active' : ''} onClick={() => setHeroIndex(index)} aria-label={`Show hero image ${index + 1}`} />)}
              </div>
            </div>
          </section>

          <section className="vc-research-band">
            <div><span className="vc-section-k">Research background</span><h2>Why the workflow exists</h2></div>
            <div className="vc-research-grid">
              <div><h3>Utterance fluency</h3><p>Praat timing supports breakdown and speed measures: pauses, sounding time, articulation rate and pause density.</p></div>
              <div><h3>Multiword vocabulary</h3><p>Reviewed transcripts support MWU analysis beyond isolated word counts and preserve disfluency evidence.</p></div>
              <div><h3>Human-verifiable data</h3><p>Automation prepares drafts and evidence packages; researcher-corrected artifacts remain the analytical record.</p></div>
            </div>
          </section>

          <section className="vc-phase-runway">
            <div className="vc-section-head"><div><span className="vc-section-k">Five-stage research workflow</span><h2>One traceable chain from audio to analysis matrix</h2></div></div>
            <div className="vc-phase-grid">
              {OVERVIEW_PHASES.map((phase) => <article key={phase.roman} className="vc-phase-card"><div className="vc-phase-roman">{phase.roman}</div><h3>{phase.title}</h3><p>{phase.body}</p><span>{phase.status}</span></article>)}
            </div>
          </section>

          <section className="vc-layer-architecture">
            <div className="vc-layer-architecture-copy">
              <span className="vc-section-k">Delivery architecture</span>
              <h2>Four layers, explicit handoffs</h2>
              <p>Each layer exposes its required inputs, processing boundary and downloadable outputs. Layer 1 uses the original recording as the canonical acoustic clock; downstream analysis begins from reviewed artifacts.</p>
            </div>
            <div className="vc-layer-links">
              {LAYERS.map((layer) => {
                const Icon = layer.icon;
                return <button key={layer.key} onClick={() => openLayer(layer.key)}><Icon size={18} /><span><b>{layer.short}</b>{layer.nav}</span><ArrowRight size={15} /></button>;
              })}
            </div>
          </section>
        </main>
      ) : view === 'workspace' ? (
        <main className="vc-wrap">
          <div className="vc-console-head"><span className="vc-section-k">Operational workspace</span><h2>Layer workflow</h2><p className="sub">Inspect the formal input, processing and output contract for each delivery layer.</p></div>
          <div className="vc-layout">
            <aside className="vc-side">
              <div className="st">Delivery layers</div>
              <div className="vc-pnav">
                {LAYERS.map((layer) => {
                  const Icon = layer.icon;
                  const active = !internalValidation && selectedLayer === layer.key;
                  return (
                    <button key={layer.key} className={`vc-pitem ${active ? 'active' : ''}`} onClick={() => openLayer(layer.key)}>
                      <span className="vc-pnum"><Icon size={14} /></span>
                      <span><span className="vc-pn">{layer.short} · {layer.nav}</span><span className="vc-ps">{layer.navDetail}</span></span>
                      <ChevronRight size={13} className="vc-side-chevron" />
                    </button>
                  );
                })}
              </div>
              <div className="vc-scope"><Gauge size={14} /> Original WAV is the canonical acoustic clock. Draft evidence remains distinct from researcher-reviewed data.</div>
            </aside>
            <div className="panel">
              {internalValidation ? <InternalValidation mode={internalMode} setMode={setInternalMode} /> : <LayerWorkspace layer={selected} />}
            </div>
          </div>
        </main>
      ) : <MethodologyAtlas />}
    </div>
  );
}
