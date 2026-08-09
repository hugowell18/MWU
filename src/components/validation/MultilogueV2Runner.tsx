import React, { useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  Archive,
  Check,
  Clock3,
  Download,
  FileAudio,
  FlaskConical,
  Layers3,
  LoaderCircle,
  Play,
  ShieldCheck,
} from 'lucide-react';

type ProgressStep = { key: string; status: string; detail?: string };

const STEP_LABELS: Record<string, string> = {
  phase_i_evidence: 'Phase I evidence',
  P025: 'P025 draft',
  P035: 'P035 draft',
  gate_qa: 'Gate QA',
  delivery_package: 'Delivery package',
};

export function MultilogueV2Runner({ onReport }: { onReport?: (report: any) => void }) {
  const [input, setInput] = useState<any>(null);
  const [report, setReport] = useState<any>(null);
  const [progress, setProgress] = useState<any>(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState('');

  async function load() {
    const [inputResponse, reportResponse, statusResponse] = await Promise.all([
      fetch('/api/multilogue-v2/input'),
      fetch('/api/multilogue-v2/report'),
      fetch('/api/multilogue-v2/status'),
    ]);
    const [nextInput, nextReport, nextProgress] = await Promise.all([
      inputResponse.json(), reportResponse.json(), statusResponse.json(),
    ]);
    setInput(nextInput);
    if (nextReport.status !== 'idle') {
      setReport(nextReport);
      onReport?.(nextReport);
    }
    setProgress(nextProgress);
    setRunning(!nextProgress.done && ['running', 'starting'].includes(nextProgress.status));
  }

  useEffect(() => { load().catch((value) => setError(String(value))); }, []);

  useEffect(() => {
    if (!running) return;
    const timer = window.setInterval(async () => {
      const response = await fetch('/api/multilogue-v2/status');
      const next = await response.json();
      setProgress(next);
      if (next.done) {
        window.clearInterval(timer);
        setRunning(false);
        if (next.status === 'ready_draft') await load();
        else setError(next.error || 'The local draft run failed.');
      }
    }, 350);
    return () => window.clearInterval(timer);
  }, [running]);

  async function run() {
    setError('');
    const response = await fetch('/api/multilogue-v2/run', { method: 'POST' });
    const body = await response.json();
    if (!response.ok) {
      setError(body.error || 'Unable to start the local run.');
      return;
    }
    setReport(null);
    setRunning(true);
    setProgress({ status: 'starting', done: false, active_step: 'phase_i_evidence', steps: [] });
  }

  const steps: ProgressStep[] = useMemo(() => {
    const source = progress?.steps?.length ? progress.steps : report?.pipeline || [];
    return Object.keys(STEP_LABELS).map((key) => source.find((item: ProgressStep) => item.key === key) || ({ key, status: 'pending' }));
  }, [progress, report]);

  return (
    <div className="m2-page">
      <header className="vc-head m2-head">
        <div>
          <div className="vc-crumb"><FlaskConical size={14} /> Validation Sprint / Benchmark 02</div>
          <h1>Multilogue04 v2 · Phase I → II</h1>
          <p className="sub">A local-only Path B draft run using the original recording and cached provider evidence.</p>
        </div>
        <button className="vc-runbtn" onClick={run} disabled={running || !input?.ready}>
          {running ? <LoaderCircle className="m2-spin" size={16} /> : <Play size={16} />}
          {running ? 'Running locally' : 'Run draft validation'}
        </button>
      </header>

      {error && <div className="vc-banner fail"><div className="bi"><AlertTriangle size={20} /></div><div><h4>Run stopped</h4><p>{error}</p></div></div>}

      <section className="m2-status-strip" aria-label="Evidence status">
        <StatusFact label="Output" value="Draft integration evidence" tone="blue" />
        <StatusFact label="Accuracy" value="Unavailable" tone="amber" />
        <StatusFact label="Review strategy" value="Awaiting research team" tone="amber" />
      </section>

      <Section icon={<FileAudio size={18} />} number="01" title="Input" state={input?.ready ? 'Local evidence ready' : 'Input incomplete'}>
        <div className="m2-input-grid">
          <Metric label="Recording" value={input?.recording_name || 'Multilogue04_C_Level30 D1G4.wav'} />
          <Metric label="Canonical duration" value={report ? formatSeconds6(report.input.canonical_duration_sec) : '501.013333s'} />
          <Metric label="Speakers" value="3 temporary IDs" />
          <Metric label="Evidence source" value="Local + cached only" />
        </div>
        <p className="m2-footnote">No customer audio is uploaded or sent to an external service during this run.</p>
      </Section>

      <Section icon={<Layers3 size={18} />} number="02" title="Pipeline" state={progress?.status || report?.status || 'Ready'}>
        <div className="m2-pipeline">
          {steps.map((step, index) => (
            <React.Fragment key={step.key}>
              <div className={`m2-pipeline-step ${step.status}`}>
                <span>{step.status === 'passed' ? <Check size={13} /> : step.status === 'failed' ? <AlertTriangle size={13} /> : index + 1}</span>
                <div><strong>{STEP_LABELS[step.key]}</strong><small>{step.detail || stateText(step.status)}</small></div>
              </div>
              {index < steps.length - 1 && <div className="m2-arrow" aria-hidden="true">›</div>}
            </React.Fragment>
          ))}
        </div>
      </Section>

      {report ? (
        <>
          <section className="m2-threshold-grid" aria-label="Threshold results">
            {report.thresholds.map((threshold: any) => <ThresholdPanel key={threshold.key} threshold={threshold} />)}
          </section>

          <Section icon={<ShieldCheck size={18} />} number="05" title="Evidence & limitations" state="Draft boundary">
            <div className="m2-evidence-grid">
              <div className="m2-evidence-card">
                <span>Phase I evidence</span>
                <strong>{report.g1.overlap_candidates} qualified overlap candidates · {report.g1.overlap_candidate_duration_sec.toFixed(3)} s</strong>
                <p>{report.g1.overlap_subthreshold} sub-100 ms regions ({report.g1.overlap_subthreshold_duration_sec.toFixed(3)} s) are retained separately and never forced to <code>ol</code>.</p>
                <p>{report.g1.unknown_residuals} unknown residual intervals remain review flags.</p>
              </div>
              <div className="m2-evidence-card warn">
                <span>Research categories</span>
                <strong><code>ol</code> unavailable · <code>x</code> unavailable</strong>
                <p>Zeros are not rendered as observations because these categories cannot yet be established from the draft.</p>
              </div>
              <div className="m2-evidence-card warn">
                <span>Acceptance evidence</span>
                <strong>Accuracy unavailable</strong>
                <p>A researcher-reviewed Multilogue04 reference is still required for calibration and measurement.</p>
              </div>
            </div>
          </Section>

          <Section icon={<Archive size={18} />} number="06" title="Download package" state={`${report.delivery.entries} files · safe ZIP`}>
            <div className="m2-package">
              <div className="m2-package-icon"><Archive size={22} /></div>
              <div className="m2-package-copy">
                <span>Path B PoC draft</span>
                <strong>{report.delivery.name}</strong>
                <p>Two draft TextGrids, threshold tables, method evidence and G0–G2 gate reports. No audio or transcript payload.</p>
                <small>SHA-256 {report.delivery.sha256}</small>
              </div>
              <DownloadLink id={report.delivery.artifact_id} label="Download ZIP" primary />
            </div>
          </Section>
        </>
      ) : (
        <div className="vc-empty m2-empty">
          <div className="vc-empty-ic"><Clock3 size={22} /></div>
          <h3>{running ? 'Building the draft evidence package' : 'Ready to run'}</h3>
          <p>{running ? 'Progress is reported above as each local gate completes.' : 'Run the local Phase I to Phase II validation to generate threshold-specific draft evidence.'}</p>
        </div>
      )}
    </div>
  );
}

function Section({ icon, number, title, state, children }: any) {
  return (
    <section className="m2-section">
      <div className="m2-section-head">
        <div className="m2-section-icon">{icon}</div>
        <div><span>{number}</span><h2>{title}</h2></div>
        <b>{state}</b>
      </div>
      {children}
    </section>
  );
}

function StatusFact({ label, value, tone }: any) {
  return <div className={`m2-status ${tone}`}><span>{label}</span><strong>{value}</strong></div>;
}

function Metric({ label, value }: any) {
  return <div className="m2-metric"><span>{label}</span><strong>{value}</strong></div>;
}

function ThresholdPanel({ threshold }: { threshold: any }) {
  const labels = ['s', 'f', 'bc', 'op', 'pf', 'tr', 'shs'];
  const artifact = (suffix: string) => threshold.artifacts.find((item: any) => item.id.endsWith(suffix));
  return (
    <section className="m2-threshold">
      <div className="m2-threshold-head">
        <div><span>{threshold.key}</span><h2>{threshold.threshold_sec.toFixed(2)} s threshold</h2></div>
        <b><Check size={13} /> Praat readable</b>
      </div>
      <div className="m2-threshold-kpis">
        <Metric label="Flags" value={threshold.flags_count.toLocaleString()} />
        <Metric label="Transfer reviews" value={threshold.provisional_transfer_reviews} />
        <Metric label="Overlap FTO held" value={
          Number(threshold.transition_evidence?.qualified_overlap_fto_suppressed || 0)
          + Number(threshold.transition_evidence?.subthreshold_overlap_fto_suppressed || 0)
        } />
        <Metric label="Timeline" value={formatSeconds6(threshold.timeline_validation.duration_sec)} />
      </div>
      <div className="m2-table-wrap">
        <table className="m2-label-table">
          <thead><tr><th>Speaker</th>{labels.map((label) => <th key={label}>{label}</th>)}</tr></thead>
          <tbody>{Object.entries(threshold.label_summary).map(([speaker, values]: any) => (
            <tr key={speaker}><td>{speaker}</td>{labels.map((label) => <td key={label}>{Number(values[label]?.duration_sec || 0).toFixed(2)}</td>)}</tr>
          ))}</tbody>
        </table>
      </div>
      <p className="m2-table-note">Draft duration seconds by temporary speaker ID. <code>ol</code> and <code>x</code> are intentionally excluded because they are unavailable.</p>
      <div className="m2-downloads">
        <DownloadLink id={artifact('_textgrid')?.id} label="TextGrid" />
        <DownloadLink id={artifact('_labels')?.id} label="Label table" />
        <DownloadLink id={artifact('_flags')?.id} label="Flags" />
        <DownloadLink id={artifact('_transitions')?.id} label="Transitions" />
        <DownloadLink id={artifact('_transition_evidence')?.id} label="Transition evidence" />
        <DownloadLink id={artifact('_overlap_capability')?.id} label="Overlap evidence" />
        <DownloadLink id={artifact('_summary')?.id} label="Summary" />
        <DownloadLink id={artifact('_method')?.id} label="Method" />
      </div>
    </section>
  );
}

function DownloadLink({ id, label, primary = false }: any) {
  if (!id) return null;
  return <a className={`m2-download ${primary ? 'primary' : ''}`} href={`/api/multilogue-v2/file?path=${encodeURIComponent(id)}`}><Download size={14} /> {label}</a>;
}

function stateText(state: string) {
  if (state === 'passed') return 'Passed';
  if (state === 'running') return 'Running';
  if (state === 'failed') return 'Stopped';
  return 'Waiting';
}

function formatSeconds6(value: number) {
  return `${Number(value).toFixed(6)}s`;
}
