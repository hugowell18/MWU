import React, { useEffect, useRef, useState } from 'react';
import { StatusBadge } from './StatusBadge';
import { FileChecklist, ROLES } from './FileChecklist';
import { ThresholdConfig } from './ThresholdConfig';
import { MetricComparisonTable, NoGoldTable } from './MetricComparisonTable';
import { TranscriptSplitPanel } from './TranscriptSplitPanel';
import { MatrixPanel } from './MatrixPanel';
import { ArtifactDownloads } from './ArtifactDownloads';

// The Validation Console is a SINGLE entry: one "Run Validation" button runs the whole pipeline
// (Phase I skipped → II → III → IV → V). The pipeline below is progress display only.

const Play = (
  <svg className="vc-icon-sm" viewBox="0 0 24 24">
    <path d="m5 3 14 9-14 9V3Z" />
  </svg>
);

// The Validation RUNNER — this is the content of the "Validation" sidebar item inside the
// LDT-style phase console (see ValidationApp). One "Run Validation" button runs the whole pipeline.
export function ValidationRunner() {
  const [useSample, setUseSample] = useState(false);
  const [customOn, setCustomOn] = useState(false);
  const [customVal, setCustomVal] = useState('0.5');
  const [files, setFiles] = useState<Record<string, File | null>>({ wav: null, textgrid: null, transcript: null, workbook: null });
  const [runState, setRunState] = useState<'idle' | 'uploading' | 'running' | 'done' | 'failed'>('idle');
  const [steps, setSteps] = useState<any[] | null>(null); // live phase-level steps from /api/status
  const [report, setReport] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);
  const poll = useRef<any>(null);

  async function loadReport() {
    const rep = await (await fetch('/api/report')).json().catch(() => null);
    setReport(rep && rep.readiness !== 'idle' ? rep : null);
    return rep;
  }
  useEffect(() => {
    const p = new URLSearchParams(window.location.search);
    if (p.get('view') === 'report') loadReport();
    else if (p.get('autorun') === 'sample') {
      setUseSample(true);
      runValidation(true);
    }
    return () => poll.current && clearInterval(poll.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const allPicked = ROLES.every((r) => !!files[r.role]);
  const busy = runState === 'uploading' || runState === 'running';
  const canRun = (useSample || allPicked) && !busy;

  async function runValidation(sample = useSample) {
    if (busy || !(sample || allPicked)) return;
    setError(null);
    setReport(null);
    setSteps(null);
    setRunState('uploading');
    try {
      if (!sample) for (const r of ROLES) if (files[r.role]) await fetch(`/api/upload?role=${r.role}`, { method: 'POST', body: files[r.role] as File });
      const thresholds = [0.25, 0.35];
      const cv = parseFloat(customVal);
      if (customOn && cv > 0 && cv < 5 && !thresholds.includes(cv)) thresholds.push(cv);
      const res = await fetch('/api/run', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ phase: 'all', useSample: sample, thresholds }) });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        setError(j.error || 'run failed to start');
        setRunState('failed');
        return;
      }
      setRunState('running');
      poll.current = setInterval(tick, 350);
    } catch (e: any) {
      setError(String(e));
      setRunState('failed');
    }
  }
  async function tick() {
    try {
      const s = await (await fetch('/api/status')).json();
      if (s.steps && s.steps.length) setSteps(s.steps);
      if (s.done) {
        clearInterval(poll.current);
        const rep = await loadReport();
        setRunState(!rep || rep.readiness === 'blocked' ? 'failed' : 'done');
      }
    } catch {
      /* keep polling */
    }
  }

  const gold = report?.phase_ii?.gold_replay;
  const t035 = (report?.phase_ii?.thresholds || []).find((t: any) => Number(t.threshold) === 0.35);
  const topBadge = busy ? 'running' : report ? (report.readiness === 'blocked' ? 'blocked' : report.readiness === 'partial' ? 'generated_no_gold' : 'passed') : 'idle';
  const displaySteps = steps || deriveSteps(report, busy);

  return (
    <div>
      <div className="vc-head">
          <div>
            <div className="vc-crumb">
              <span>Validation</span>
              <svg className="vc-icon-sm" viewBox="0 0 24 24" style={{ stroke: 'var(--slate-400)' }}>
                <path d="m9 18 6-6-6-6" />
              </svg>
              <span>SpeakerX benchmark</span>
            </div>
            <h1>Validation Sprint — SpeakerX monologue benchmark</h1>
            <p className="sub">Select the four benchmark files (or use the sample), press <b>Run Validation</b>, and the whole pipeline runs end-to-end. Results compare ours vs the client baseline, with every artifact downloadable.</p>
          </div>
          <button className="vc-runbtn lg" onClick={() => runValidation()} disabled={!canRun}>
            {Play}
            {runState === 'uploading' ? 'Uploading…' : runState === 'running' ? 'Running…' : report ? 'Re-run Validation' : 'Run Validation'}
          </button>
        </div>

        <div className="vc-grid2">
          <FileChecklist selected={files} useSample={useSample} disabled={busy} onToggleSample={setUseSample} onPick={(role, f) => setFiles((s) => ({ ...s, [role]: f }))} />
          <ThresholdConfig config={report?.config} customOn={customOn} customVal={customVal} disabled={busy} onCustomToggle={setCustomOn} onCustomChange={setCustomVal} />
        </div>

        <PipelineProgress steps={displaySteps} />

        {error && (
          <div className="vc-banner fail" style={{ marginBottom: 16 }}>
            <div className="bi">
              <svg className="vc-icon" viewBox="0 0 24 24">
                <path d="M18 6 6 18M6 6l12 12" />
              </svg>
            </div>
            <div>
              <h4>Run could not complete</h4>
              <p>{error}</p>
            </div>
          </div>
        )}

        {!report ? (
          <EmptyHint busy={busy} canRun={canRun} />
        ) : (
          <>
            {/* pass/fail summary */}
            <div className={`vc-banner ${gold?.status === 'passed' ? 'pass' : 'fail'}`} style={{ marginBottom: 16 }}>
              <div className="bi">
                <svg className="vc-icon" viewBox="0 0 24 24">
                  <path d={gold?.status === 'passed' ? 'M20 6 9 17l-5-5' : 'M18 6 6 18M6 6l12 12'} />
                </svg>
              </div>
              <div>
                <h4>{gold?.status === 'passed' ? `Validation passed — 0.25 s baseline reproduced (${gold.rows.filter((r: any) => r.pass).length}/${gold.rows.length} within tolerance)` : 'Validation failed — values diverge from the client baseline'}</h4>
                <p>Phase I skipped (monologue) · Phase IV text variables are placeholders · 0.35 s is generated_no_gold.</p>
              </div>
            </div>

            {/* Phase II */}
            <SectionTitle n="II" title="Pause & Duration — Script 1 + Script 2" />
            {report.phase_ii?.gold_replay && <Script12Panel p2={report.phase_ii} />}
            <Card title="Gold replay — ours vs expected baseline (0.25)" hint="expert TextGrid → Script 2 → workbook · 0.25 is the comparison target">
              <MetricComparisonTable rows={gold?.rows || []} />
              <details className="vc-details">
                <summary>
                  <svg className="vc-icon-sm vc-det-arrow" viewBox="0 0 24 24"><path d="m9 18 6-6-6-6" /></svg>
                  Other thresholds (0.35{(report.phase_ii?.thresholds || []).some((t: any) => ![0.25, 0.35].includes(Number(t.threshold))) ? ' / custom' : ''}) — reference only
                </summary>
                <div className="vc-det-body">
                  <AllThresholdTable p2={report.phase_ii} />
                </div>
              </details>
            </Card>

            {/* Phase III */}
            <SectionTitle n="III" title="Transcript Splitting" />
            <TranscriptSplitPanel phase3={report.phase_iii} />

            {/* Phase IV */}
            <SectionTitle n="IV" title="Lexical / MWU — text-variable placeholders" />
            <PhaseIVCard p4={report.phase_iv} />

            {/* Phase V */}
            <SectionTitle n="V" title="Matrix Verification" />
            <MatrixPanel phase5={report.phase_v} />

            {/* Downloads */}
            <SectionTitle n="↓" title="Download package — TextGrids · TXT · XLSX" />
            <ArtifactDownloads artifacts={report?.artifacts} />

            {/* Limitations */}
            {report.limitations?.length > 0 && (
              <Card title="Limitations & next steps">
                <ul className="vc-lim">
                  {report.limitations.map((l: string, i: number) => (
                    <li key={i}>{l}</li>
                  ))}
                </ul>
              </Card>
            )}
          </>
        )}

    </div>
  );
}

function mapStatus(p: any) {
  if (!p) return 'pending';
  if (p.status === 'passed') return 'passed';
  if (p.status === 'blocked') return 'blocked';
  if (p.status === 'placeholder_ready') return 'placeholder';
  return p.status || 'pending';
}
function deriveSteps(report: any, busy: boolean) {
  const s = (p: any) => (busy ? 'pending' : mapStatus(p));
  return [
    { key: 'i', label: 'Phase I', desc: 'Diarization', state: 'skipped' },
    { key: 'ii', label: 'Phase II', desc: 'Pause & duration', state: s(report?.phase_ii) },
    { key: 'iii', label: 'Phase III', desc: 'Transcript split', state: s(report?.phase_iii) },
    { key: 'iv', label: 'Phase IV', desc: 'Lexical / MWU', state: report?.phase_iv ? 'placeholder' : 'pending' },
    { key: 'v', label: 'Phase V', desc: 'Matrix', state: s(report?.phase_v) },
  ];
}

function PipelineProgress({ steps }: { steps: any[] }) {
  return (
    <div className="vc-card">
      <div className="vc-card-h">
        <div className="ci">
          <svg className="vc-icon" viewBox="0 0 24 24">
            <path d="M22 12h-4l-3 9L9 3l-3 9H2" />
          </svg>
        </div>
        <h3>Pipeline progress</h3>
        <span className="hint">single run · Phase I skipped → II → III → IV → V</span>
      </div>
      <div className="vc-card-b">
        <div className="vc-pipe">
          {steps.map((s, i) => (
            <React.Fragment key={s.key}>
              <div className={`vc-stage vc-st-${s.state}`}>
                <div className="vc-stage-top">
                  <span className="vc-stage-dot" />
                  <span className="vc-stage-name">{s.label}</span>
                </div>
                <div className="vc-stage-desc">{s.desc}</div>
                <div className="vc-stage-state">{s.state}</div>
              </div>
              {i < steps.length - 1 && <span className="vc-pipe-arrow">→</span>}
            </React.Fragment>
          ))}
        </div>
      </div>
    </div>
  );
}

function Card({ title, hint, children }: any) {
  return (
    <div className="vc-card">
      <div className="vc-card-h">
        <h3>{title}</h3>
        {hint && <span className="hint">{hint}</span>}
      </div>
      <div className="vc-card-b">{children}</div>
    </div>
  );
}
function SectionTitle({ n, title }: { n: string; title: string }) {
  return (
    <div className="vc-sect">
      <span className="vc-sect-n">{n}</span>
      <h2>{title}</h2>
    </div>
  );
}

function PhaseIVCard({ p4 }: any) {
  const cols = p4?.columns || ['TAALES_*', 'TAALED_*', 'AntConc_*'];
  const tools = p4?.tools || ['TAALES', 'TAALED', 'AntConc'];
  return (
    <div className="vc-card">
      <div className="vc-card-h">
        <h3>Text-variable placeholders (not computed)</h3>
        <span className="vc-chip amber">placeholder · pending</span>
      </div>
      <div className="vc-card-b">
        <p className="vc-note" style={{ marginTop: 0 }}>
          Phase IV runs the lexical / MWU tools (<b>{tools.join(' · ')}</b>) to fill matrix columns 15+. They are <b>not part of this
          validation sprint</b>, so every column below is reserved and written as <span className="vc-mono">pending_not_implemented</span> —
          no values are computed or fabricated. The {cols.length} chips are the reserved column names, not results.
        </p>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          {cols.map((c: string) => (
            <span className="vc-chip" key={c}>
              {c} · pending
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}

function WorkflowPreview({ report }: any) {
  const phases = [
    { roman: 'I', name: 'Diarization & Isolation', note: 'skipped for monologue', tone: 'skip' },
    { roman: 'II', name: 'Pause & Duration', note: 'Script 1 + Script 2 · gold replay', tone: report?.phase_ii?.status === 'passed' ? 'ok' : 'idle' },
    { roman: 'III', name: 'Transcript Split', note: 'RAW + TIDY', tone: report?.phase_iii ? 'ok' : 'idle' },
    { roman: 'IV', name: 'Lexical / MWU', note: 'TAALES/TAALED/AntConc placeholders', tone: 'warn' },
    { roman: 'V', name: 'Synthesis & Export', note: 'matrix', tone: report?.phase_v ? 'ok' : 'idle' },
  ];
  return (
    <div className="vc-wfgrid">
      {phases.map((p) => (
        <div className={`vc-wfcard vc-wf-${p.tone}`} key={p.roman}>
          <div className="vc-wf-no">{p.roman}</div>
          <div>
            <div className="vc-wf-name">{p.name}</div>
            <div className="vc-wf-note">{p.note}</div>
          </div>
        </div>
      ))}
    </div>
  );
}

function EmptyHint({ busy, canRun }: { busy: boolean; canRun: boolean }) {
  return (
    <div className="vc-empty">
      <div className="vc-empty-ic">
        <svg className="vc-icon" viewBox="0 0 24 24" style={{ width: 26, height: 26 }}>
          <path d="M3 3v18h18M7 14l4-4 3 3 5-6" />
        </svg>
      </div>
      <h3>{busy ? 'Running validation…' : 'No results yet'}</h3>
      <p>{busy ? 'The pipeline is running — phases light up above. The comparison vs baseline and all downloadable files appear here when it finishes.' : canRun ? 'Press “Run Validation” to execute the whole pipeline. Results and downloads appear here.' : 'Provide the four benchmark files (or tick “Use SpeakerX sample”), then press “Run Validation”.'}</p>
    </div>
  );
}

// ---- shared sub-cards (Script 1/2 + diagnostic) ----
function Script12Panel({ p2 }: any) {
  const s1 = p2.script1 || [];
  const s2 = p2.script2 || [];
  const ths = p2.thresholds || [];
  return (
    <Card title="Script 1 & Script 2" hint={`window ${p2.praat_window_sec}s · Scale times applied`}>
      <table className="vc-table">
        <thead>
          <tr>
            <th>Threshold</th>
            <th>Script 1 (intensity)</th>
            <th>Full timeline</th>
            <th>Script 2</th>
            <th>sounding / silent / invalid</th>
          </tr>
        </thead>
        <tbody>
          {s1.map((row: any) => {
            const th = ths.find((t: any) => t.threshold === row.threshold);
            const sc2 = s2.find((x: any) => x.threshold === row.threshold);
            const d = th?.durations;
            return (
              <tr key={row.threshold}>
                <td>{row.threshold}s {row.threshold === 0.25 ? '(gold)' : '(no-gold)'}</td>
                <td>{row.status}</td>
                <td>{th?.full_timeline_ok ? <span className="vc-ok">ok</span> : <span className="vc-none">—</span>}</td>
                <td>{sc2?.method || '—'}</td>
                <td className="num">{d ? `${d.sounding_count} / ${d.silent_count} / ${d.invalid_count}` : '—'}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <p className="vc-note">
        Script 1 = rolling intensity over a {p2.praat_window_sec} s window with Praat “Scale times” → full timeline. Script 2 ={' '}
        <span className="vc-mono">calculate_segment_durations.praat</span>. Labels: {(p2.label_contract || []).join(' / ')} (invalid = other
        speakers; 0 for this monologue).
      </p>
    </Card>
  );
}
function AllThresholdTable({ p2 }: any) {
  const expert = p2.gold_replay?.totals || {};
  const ths = (p2.thresholds || []).filter((t: any) => t.durations);
  const fmt = (x: any) => (typeof x === 'number' ? (Number.isInteger(x) ? x : x.toFixed(6)) : x ?? '—');
  const rows = [
    { label: 'Silent intervals', k: 'silent_count' },
    { label: 'Sounding intervals', k: 'sounding_count' },
    { label: 'Total sounding (s)', k: 'total_sounding' },
    { label: 'Total silent (s)', k: 'total_silent' },
    { label: 'Mean silent pause (s)', k: 'mean_silent' },
  ];
  return (
    <>
      <div className="vc-matrix-scroll">
        <table className="vc-table">
          <thead>
            <tr>
              <th>Metric</th>
              <th>Expert (gold · 0.25)</th>
              {ths.map((t: any) => (
                <th key={t.threshold}>
                  Gen {t.threshold}s {t.threshold === 0.25 ? '(gold)' : '(no-gold)'}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.k}>
                <td>{r.label}</td>
                <td className="num">{fmt(expert[r.k])}</td>
                {ths.map((t: any) => (
                  <td className="num" key={t.threshold}>{fmt(t.durations[r.k])}</td>
                ))}
              </tr>
            ))}
            <tr>
              <td>Gold status</td>
              <td><span className="vc-ok">reference</span></td>
              {ths.map((t: any) => (
                <td key={t.threshold}>
                  {t.threshold === 0.25 ? (
                    <span className="vc-none">diagnostic</span>
                  ) : (
                    <span className="vc-badge vc-s-generated_no_gold"><span className="dot" />no gold</span>
                  )}
                </td>
              ))}
            </tr>
          </tbody>
        </table>
      </div>
      <p className="vc-note">
        Expert = Dan's reviewed segmentation (the only 0.25 client gold). Generated columns are our Praat auto-segmentation per
        threshold — they differ from the expert (expected), and only 0.25 has a client gold. No generated column is a gold pass.
      </p>
    </>
  );
}

function DiagnosticCard({ diag }: any) {
  return (
    <Card title="Generated 0.25 vs expert — diagnostic" hint="not a gold pass">
      <table className="vc-table">
        <thead>
          <tr>
            <th>Metric</th>
            <th>Generated 0.25</th>
            <th>Expert</th>
            <th>Δ</th>
          </tr>
        </thead>
        <tbody>
          {(diag.rows || []).map((r: any) => (
            <tr key={r.metric}>
              <td>{r.metric}</td>
              <td className="num">{r.generated}</td>
              <td className="num">{r.expert}</td>
              <td className="num">{r.delta}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="vc-note">{diag.note}</p>
    </Card>
  );
}
