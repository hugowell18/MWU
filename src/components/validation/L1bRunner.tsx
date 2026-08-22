import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  Activity,
  AlertCircle,
  Check,
  CheckCircle2,
  Clock3,
  Download,
  FileAudio,
  FileText,
  Layers3,
  Package,
  Play,
  RotateCcw,
  Settings2,
  ShieldCheck,
} from 'lucide-react';

type L1bRunnerProps = {
  onReport?: (report: any) => void;
};

const DEFAULT_THRESHOLDS = [0.25, 0.35];
const FLOW_STAGES = [
  ['l1a_handoff_gate', 'L1a handoff gate'],
  ['assemblyai_timed_words', 'Timed-word evidence'],
  ['stage1_evidence', 'Stage-1 evidence'],
  ['path_b_thresholds', 'P025 + P035 Path B'],
] as const;

export function L1bRunner({ onReport }: L1bRunnerProps) {
  const [input, setInput] = useState<any>(null);
  const [selectedManifest, setSelectedManifest] = useState('');
  const [report, setReport] = useState<any>(null);
  const [progress, setProgress] = useState<any>(null);
  const [runState, setRunState] = useState<'idle' | 'running' | 'done' | 'failed'>('idle');
  const [customOn, setCustomOn] = useState(false);
  const [customThreshold, setCustomThreshold] = useState('0.50');
  const [error, setError] = useState<string | null>(null);
  const poll = useRef<number | null>(null);

  const busy = runState === 'running';
  const thresholds = useMemo(() => {
    const values = [...DEFAULT_THRESHOLDS];
    const custom = Number(customThreshold);
    if (customOn && custom > 0 && custom < 5 && !values.includes(custom)) values.push(custom);
    return values.sort((left, right) => left - right);
  }, [customOn, customThreshold]);

  async function loadInput() {
    const response = await fetch('/api/l1b/input');
    const value = await response.json();
    setInput(value);
    return value;
  }

  async function loadReport(manifestPath = selectedManifest) {
    const suffix = manifestPath ? `?manifest=${encodeURIComponent(manifestPath)}` : '';
    const response = await fetch(`/api/l1b/report${suffix}`);
    const value = await response.json();
    const usable = value && value.status !== 'idle' ? value : null;
    setReport(usable);
    if (usable) onReport?.(usable);
    return usable;
  }

  useEffect(() => {
    loadInput()
      .catch((reason) => setError(String(reason)));
    return () => {
      if (poll.current) window.clearInterval(poll.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function run() {
    if (busy || !selectedReady) return;
    setError(null);
    setProgress(null);
    setReport(null);
    onReport?.(null);
    setRunState('running');
    try {
      const response = await fetch('/api/l1b/run', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ manifest: selected.path, thresholds }),
      });
      const value = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(value.error || 'L1b could not start');
      poll.current = window.setInterval(tick, 500);
    } catch (reason: any) {
      setError(reason.message || String(reason));
      setRunState('failed');
    }
  }

  async function tick() {
    try {
      const response = await fetch('/api/l1b/status');
      const value = await response.json();
      setProgress(value);
      if (value.done) {
        if (poll.current) window.clearInterval(poll.current);
        const latest = await loadReport(selectedManifest);
        setRunState(value.status === 'ready_for_praat_review' && latest ? 'done' : 'failed');
        if (value.error) setError(value.error);
      }
    } catch {
      // The next poll can recover from a partially written progress file.
    }
  }

  const sessionInputs = input?.accepted || input?.available || [];
  const runnableInputs = input?.available || [];
  const selected = sessionInputs.find((item: any) => item.path === selectedManifest) || null;
  const speakers = selected?.speakers || [];
  const selectedReady = selected?.l1b_runnable === true;

  function clearRunView() {
    if (poll.current) window.clearInterval(poll.current);
    poll.current = null;
    setReport(null);
    setProgress(null);
    setRunState('idle');
    setError(null);
    onReport?.(null);
  }

  async function chooseInput(manifestPath: string) {
    setSelectedManifest(manifestPath);
    clearRunView();
    if (!manifestPath) return;
    try {
      const existing = await loadReport(manifestPath);
      if (existing?.status === 'ready_for_praat_review') setRunState('done');
      else if (existing?.status === 'failed') setRunState('failed');
    } catch (reason: any) {
      setError(reason.message || String(reason));
    }
  }

  function resetWorkspace() {
    if (busy) return;
    setSelectedManifest('');
    setCustomOn(false);
    setCustomThreshold('0.50');
    clearRunView();
  }

  return (
    <div className="l1b-page">
      <header className="vc-head l1b-head">
        <div>
          <div className="vc-crumb"><span>Layer 1</span><span>/</span><span>L1b</span><span>/</span><span>Phase II</span></div>
          <h1>Path B interaction timing</h1>
          <p className="sub">Continue only from the latest accepted L1a handoff, then generate threshold-specific nine-label TextGrids and timing evidence.</p>
        </div>
        <div className="l1b-head-actions">
          <button className="vc-runbtn lg" onClick={run} disabled={!selectedReady || busy} title={selectedReady ? 'Generate L1b drafts from the selected L1a session' : 'Select an accepted L1a session first'}>
            {busy ? <Clock3 size={17} /> : <Play size={17} />}
            {busy ? 'Generating Path B...' : 'Generate L1b drafts'}
          </button>
          <button className="vc-runbtn lg secondary" onClick={resetWorkspace} disabled={busy || (!selectedManifest && !report && !progress && !customOn && !error)} title="Clear the selected L1a session and current L1b workspace state">
            <RotateCcw size={17} /> Reset
          </button>
        </div>
      </header>

      {error && <Message tone="fail" title="L1b needs attention" text={error} />}

      <section className="l1b-section" aria-labelledby="l1b-input-title">
        <SectionHeading icon={<ShieldCheck size={18} />} eyebrow="Input from L1a" title="Accepted handoff gate" id="l1b-input-title" status={!input ? 'LOADING' : !sessionInputs.length ? 'BLOCKED' : !selectedManifest ? 'WAITING' : selectedReady ? 'PASS' : 'BLOCKED'} />
        <label className="l1b-input-picker">
          <span>Accepted L1a session input</span>
          <select value={selectedManifest} onChange={(event) => void chooseInput(event.target.value)} disabled={busy || !sessionInputs.length}>
            {sessionInputs.length
              ? <option value="">Choose an accepted L1a session</option>
              : <option value="">No accepted L1a session available</option>}
            {sessionInputs.map((item: any) => (
              <option key={item.path} value={item.path}>
                {item.l1b_runnable ? 'Ready' : 'Blocked'} · {item.recording_id} · {item.speakers?.length || 0} speakers · review-v{String(item.review_revision || 0).padStart(4, '0')} · {item.session_id}
              </option>
            ))}
          </select>
          <small>{sessionInputs.length} accepted session{sessionInputs.length === 1 ? '' : 's'} · {runnableInputs.length} ready for L1b</small>
        </label>
        <div className="l1b-input-summary">
          <div><span>Recording</span><strong>{selected?.source_audio || 'No accepted L1a run'}</strong></div>
          <div><span>Canonical speakers</span><strong>{speakers.length ? `S1-S${speakers.length}` : 'Not available'}</strong></div>
          <div><span>Master clock</span><strong>{formatSeconds(selected?.duration_seconds)}</strong></div>
          <div><span>TextGrid contract</span><strong>{speakers.length ? `${speakers.length + 3} tiers (N+3)` : 'Blocked'}</strong></div>
        </div>
        <div className="l1b-gate-grid">
          <GateItem passed={selected?.handoff_gate?.passed} label="Latest accepted revision" />
          <GateItem passed={selected?.handoff_gate?.passed} label="Source WAV and hashes sealed" />
          <GateItem passed={selected?.handoff_gate?.passed} label="Canonical S1-SN mapping" />
          <GateItem passed={speakers.length >= 2 && speakers.every((speaker: any) => speaker.wav_ready && speaker.invalid_ready)} label="N speaker handoff artifacts ready" />
        </div>
        <div className="l1b-speaker-grid">
          {speakers.map((speaker: any) => (
            <article className="l1b-speaker-input" key={speaker.speaker}>
              <div className="l1b-speaker-title"><span>{speaker.speaker}</span><CheckCircle2 size={16} /></div>
              <FileLine icon={<FileAudio size={15} />} label="Muted-mirror input" value={speaker.wav_name} ready={speaker.wav_ready} />
              <FileLine icon={<FileText size={15} />} label="Invalid evidence" value={speaker.invalid_name} ready={speaker.invalid_ready} />
            </article>
          ))}
          {!speakers.length && <div className="l1b-inline-empty">{sessionInputs.length ? 'Select an accepted L1a session to inspect its handoff.' : 'Complete and accept L1a before starting this layer.'}</div>}
        </div>
        {selected && !selectedReady && <p className="l1b-blocker-note">Blocked: {(selected.l1b_blockers || ['Accepted L1a handoff is not ready for L1b.']).join(' ')}</p>}
      </section>

      <div className="l1b-two-col">
        <section className="l1b-section" aria-labelledby="l1b-params-title">
          <SectionHeading icon={<Settings2 size={18} />} eyebrow="Run settings" title="Pause thresholds" id="l1b-params-title" />
          <div className="l1b-thresholds">
            {DEFAULT_THRESHOLDS.map((threshold) => (
              <div className="l1b-threshold selected" key={threshold}><Check size={15} /><strong>{threshold.toFixed(2)} s</strong><span>required run</span></div>
            ))}
          </div>
          <label className="l1b-custom-control">
            <input type="checkbox" checked={customOn} disabled={busy} onChange={(event) => setCustomOn(event.target.checked)} />
            <span>Additional threshold</span>
            <input aria-label="Additional pause threshold in seconds" type="number" min="0.01" max="4.99" step="0.01" value={customThreshold} disabled={!customOn || busy} onChange={(event) => setCustomThreshold(event.target.value)} />
            <span>seconds</span>
          </label>
        </section>

        <section className="l1b-section" aria-labelledby="l1b-method-title">
          <SectionHeading icon={<Layers3 size={18} />} eyebrow="Method" title="Path B contract" id="l1b-method-title" />
          <div className="l1b-method-grid">
            <div><span>Speaker tiers</span><strong>S1-SN</strong></div>
            <div><span>Shared tiers</span><strong>floor / transitions / flags</strong></div>
            <div><span>Label set</span><strong>s · f · bc · ol · op · pf · tr · shs · x</strong></div>
            <div><span>Floor policy</span><strong>R1-R5 · Path B</strong></div>
          </div>
          <p className="l1b-small-note">Overlap remains visible as evidence; signed FTO is not claimed where overlap offset is not measured.</p>
        </section>
      </div>

      <section className="l1b-section" aria-labelledby="l1b-run-title">
        <SectionHeading icon={<Activity size={18} />} eyebrow="Execution" title="Accepted L1a to L1b" id="l1b-run-title" status={runStatusLabel(runState, report, selectedReady)} />
        <div className="l1b-flow">
          {FLOW_STAGES.map(([id, label]) => <FlowStep key={id} label={label} state={flowState(id, progress, report, selected)} />)}
          <FlowStep label="Delivery package" state={report?.status === 'ready_for_praat_review' ? 'passed' : busy ? 'running' : 'pending'} />
        </div>
        <p className="l1b-small-note">The accepted S1-SN mapping fixes N for this run. L1b then prepares or reuses timed-word and Stage-1 evidence before generating the dynamic N+3 outputs.</p>
      </section>

      {!report ? (
        <div className="l1b-results-empty"><Activity size={24} /><div><h3>Results will appear by threshold</h3><p>Run L1b after the accepted L1a handoff is available.</p></div></div>
      ) : report.status === 'ready_for_praat_review' ? (
        <L1bResults report={report} />
      ) : (
        <Message tone="fail" title="Latest L1b result is not current" text={report.error || report.stale_reason || 'A new run is required.'} />
      )}
    </div>
  );
}

function L1bResults({ report }: any) {
  const artifacts = report.artifacts || [];
  const delivery = artifacts.find((artifact: any) => artifact.group === 'package');
  const packageContents = report.delivery_package_contents || [];
  const textgrids = packageContents.filter((artifact: any) => String(artifact.name).endsWith('.TextGrid'));
  return (
    <div className="l1b-results">
      <Message tone="pass" title="L1b drafts generated" text={`${report.threshold_reports?.length || 0} threshold runs passed structural validation. These are automatic drafts for Praat/researcher correction.`} />
      <section className="l1b-section" aria-labelledby="l1b-result-overview">
        <SectionHeading icon={<CheckCircle2 size={18} />} eyebrow="Results" title="Run overview" id="l1b-result-overview" />
        <div className="l1b-kpis">
          <Kpi value={report.speakers?.length || 0} label="canonical speakers" />
          <Kpi value={report.threshold_reports?.length || 0} label="TextGrid drafts" />
          <Kpi value="9" label="interaction labels" />
          <Kpi value={formatSeconds(report.duration_seconds)} label="full timeline" />
        </div>
        <div className="l1b-qa-strip">
          <QaItem passed={report.handoff_gate?.passed} label="L1a gate sealed" />
          <QaItem passed={report.threshold_reports?.every((item: any) => item.schema_valid)} label="N+3 schema valid" />
          <QaItem passed={report.threshold_reports?.every((item: any) => item.tier5_consistent)} label="Transition tier consistent" />
          <QaItem passed={Boolean(delivery)} label="Package built" />
        </div>
      </section>
      <section className="l1b-section" aria-labelledby="l1b-deliverables">
        <SectionHeading icon={<Package size={18} />} eyebrow="Layer 1b output" title="Praat draft package" id="l1b-deliverables" />
        <div className="l1b-package-primary">
          <div className="l1b-package-primary-icon"><Package size={23} /></div>
          <div className="l1b-package-primary-copy"><span>Customer download</span><strong>{artifactName(delivery) || 'Package not generated'}</strong><p>{textgrids.length} dynamic N+3 TextGrid drafts, one pre-review diagnostic workbook and a short review note.</p></div>
          {delivery && <DownloadLink artifact={delivery} primary label="Download ZIP" />}
        </div>
        <details className="l1b-package-contents">
          <summary>View package contents ({packageContents.length} files)</summary>
          <div>
            {packageContents.map((artifact: any) => <p key={artifact.path || artifact.name}><FileText size={14} /><span>{artifact.name}</span></p>)}
          </div>
        </details>
        <div className="l1b-local-review-step">
          <Play size={17} />
          <div><strong>Next: review locally in Praat</strong><p>Correct the selected draft, save the reviewed TextGrid locally, then upload that file when Layer 2 begins. Layer 1b does not require a second upload or finalization step.</p></div>
        </div>
      </section>
    </div>
  );
}

function SectionHeading({ icon, eyebrow, title, id, status }: any) {
  return <div className="l1b-section-head"><div className="l1b-section-icon">{icon}</div><div><span>{eyebrow}</span><h2 id={id}>{title}</h2></div>{status && <span className="l1b-section-status">{status}</span>}</div>;
}

function FileLine({ icon, label, value, ready }: any) {
  return <div className="l1b-file-line"><span>{icon}</span><div><small>{label}</small><p>{value}</p></div>{ready ? <Check size={15} /> : <AlertCircle size={15} />}</div>;
}

function GateItem({ passed, label }: { passed?: boolean; label: string }) {
  const state = passed === undefined ? 'pending' : passed ? 'passed' : 'failed';
  const icon = passed === undefined ? <Clock3 size={16} /> : passed ? <CheckCircle2 size={16} /> : <AlertCircle size={16} />;
  return <div className={state}>{icon}<span>{label}</span></div>;
}

function FlowStep({ label, state }: { label: string; state: string }) {
  return <div className={`l1b-flow-step ${state}`}><span>{state === 'passed' ? <Check size={14} /> : state === 'running' ? <Clock3 size={14} /> : null}</span><strong>{label}</strong></div>;
}

function Message({ tone, title, text }: { tone: 'pass' | 'fail'; title: string; text: string }) {
  return <div className={`vc-banner ${tone}`}><div className="bi">{tone === 'pass' ? <Check size={20} /> : <AlertCircle size={20} />}</div><div><h4>{title}</h4><p>{text}</p></div></div>;
}

function Kpi({ value, label }: any) {
  return <div className="l1b-kpi"><strong>{value}</strong><span>{label}</span></div>;
}

function QaItem({ passed, label }: { passed: boolean; label: string }) {
  return <div className={passed ? 'passed' : 'failed'}>{passed ? <CheckCircle2 size={16} /> : <AlertCircle size={16} />}<span>{label}</span></div>;
}

function DownloadLink({ artifact, primary = false, label }: any) {
  return <a className={`l1b-download ${primary ? 'primary' : ''}`} href={`/api/l1b/file?path=${encodeURIComponent(artifact.path)}`}><Download size={15} />{label || 'Download'}</a>;
}


function flowState(id: string, progress: any, report: any, selected: any) {
  if (id === 'l1a_handoff_gate' && selected?.handoff_gate?.passed) return 'passed';
  const stage = progress?.stages?.find((item: any) => item.id === id);
  if (stage?.status) return stage.status;
  if (report?.status === 'ready_for_praat_review') return 'passed';
  return progress?.status === 'running' ? 'running' : 'pending';
}

function artifactName(artifact: any) {
  if (!artifact) return '';
  const pieces = String(artifact.name || artifact.path || '').split('/');
  return pieces[pieces.length - 1];
}

function runStatusLabel(runState: string, report: any, selectedReady: boolean) {
  if (runState === 'running') return 'Running';
  if (runState === 'failed') return 'Failed';
  if (report?.status === 'ready_for_praat_review') return 'Outputs ready';
  return selectedReady ? 'Ready to run' : 'Waiting for input';
}

function formatSeconds(value: any) {
  return Number.isFinite(Number(value)) ? `${Number(value).toFixed(3)} s` : 'Not available';
}
