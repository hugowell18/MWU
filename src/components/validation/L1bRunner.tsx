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
  Package,
  Play,
  Settings2,
  Sheet,
  ShieldCheck,
  Users,
} from 'lucide-react';

type L1bRunnerProps = {
  onReport?: (report: any) => void;
};

const DEFAULT_THRESHOLDS = [0.25, 0.35];

export function L1bRunner({ onReport }: L1bRunnerProps) {
  const [input, setInput] = useState<any>(null);
  const [report, setReport] = useState<any>(null);
  const [progress, setProgress] = useState<any>(null);
  const [runState, setRunState] = useState<'idle' | 'running' | 'done' | 'failed'>('idle');
  const [customOn, setCustomOn] = useState(false);
  const [customThreshold, setCustomThreshold] = useState('0.5');
  const [error, setError] = useState<string | null>(null);
  const poll = useRef<number | null>(null);

  const busy = runState === 'running';
  const thresholds = useMemo(() => {
    const values = [...DEFAULT_THRESHOLDS];
    const custom = Number(customThreshold);
    if (customOn && custom > 0 && custom < 5 && !values.includes(custom)) values.push(custom);
    return values.sort((a, b) => a - b);
  }, [customOn, customThreshold]);

  async function loadInput() {
    const response = await fetch('/api/l1b/input');
    const value = await response.json();
    setInput(value);
    return value;
  }

  async function loadReport() {
    const response = await fetch('/api/l1b/report');
    const value = await response.json();
    const usable = value && value.status !== 'idle' ? value : null;
    setReport(usable);
    if (usable) onReport?.(usable);
    return usable;
  }

  useEffect(() => {
    Promise.all([loadInput(), loadReport()]).catch((reason) => setError(String(reason)));
    return () => {
      if (poll.current) window.clearInterval(poll.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function run() {
    if (busy || !input?.ready) return;
    setError(null);
    setProgress(null);
    setRunState('running');
    try {
      const response = await fetch('/api/l1b/run', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ manifest: input.selected.path, thresholds }),
      });
      const value = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(value.error || 'L1b could not start');
      poll.current = window.setInterval(tick, 300);
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
        const latest = await loadReport();
        setRunState(value.status === 'ready_for_praat_review' && latest ? 'done' : 'failed');
        if (value.error) setError(value.error);
      }
    } catch {
      // The next poll can recover from an incomplete progress-file read.
    }
  }

  const selected = input?.selected;
  const speakers = selected?.speakers || [];
  const progressJobs = progress?.jobs?.length ? progress.jobs : jobsFromReport(report);

  return (
    <div className="l1b-page">
      <header className="vc-head l1b-head">
        <div>
          <div className="vc-crumb">
            <span>Validation Sprint</span><span>/</span><span>Multilogue benchmark</span><span>/</span><span>L1a → L1b</span>
          </div>
          <h1>Multilogue L1b pause benchmark</h1>
          <p className="sub">Continue from the latest L1a speaker handoff and generate threshold-specific Praat TextGrids, duration metrics, and the L1b PoC package.</p>
        </div>
        <button className="vc-runbtn lg" onClick={run} disabled={!input?.ready || busy}>
          {busy ? <Clock3 size={17} /> : <Play size={17} />}
          {busy ? 'Running validation...' : report ? 'Run multilogue again' : 'Run multilogue validation'}
        </button>
      </header>

      {error && <Message tone="fail" title="L1b could not complete" text={error} />}

      <section className="l1b-section" aria-labelledby="l1b-input-title">
        <SectionHeading icon={<Users size={18} />} eyebrow="Input from L1a" title="Phase I speaker handoff" id="l1b-input-title" status={input?.ready ? 'Benchmark ready' : 'Blocked'} />
        <div className="l1b-input-summary">
          <div><span>Recording</span><strong>{selected?.source_audio || 'No L1a run found'}</strong></div>
          <div><span>Speakers</span><strong>{speakers.length || 0}</strong></div>
          <div><span>Timeline</span><strong>{formatSeconds(selected?.duration_seconds)}</strong></div>
          <div><span>Overlap detected</span><strong>{selected?.overlap ? `${selected.overlap.count} regions` : 'Not reported'}</strong></div>
        </div>
        <div className="l1b-speaker-grid">
          {speakers.map((speaker: any) => (
            <article className="l1b-speaker-input" key={speaker.speaker}>
              <div className="l1b-speaker-title"><span>{speaker.speaker}</span><CheckCircle2 size={16} /></div>
              <FileLine icon={<FileAudio size={15} />} label="Muted mirror" value={speaker.wav_name} ready={speaker.wav_ready} />
              <FileLine icon={<FileText size={15} />} label="Invalid ranges" value={speaker.invalid_name} ready={speaker.invalid_ready} />
            </article>
          ))}
          {!speakers.length && <div className="l1b-inline-empty">Run L1a first or place a valid Phase I manifest in the multilogue output folder.</div>}
        </div>
      </section>

      <div className="l1b-two-col">
        <section className="l1b-section" aria-labelledby="l1b-params-title">
          <SectionHeading icon={<Settings2 size={18} />} eyebrow="Run settings" title="Pause thresholds" id="l1b-params-title" />
          <div className="l1b-thresholds">
            {DEFAULT_THRESHOLDS.map((threshold) => (
              <div className="l1b-threshold selected" key={threshold}>
                <Check size={15} /><strong>{threshold}s</strong><span>required run</span>
              </div>
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
          <SectionHeading icon={<ShieldCheck size={18} />} eyebrow="Deterministic method" title="Praat contract" id="l1b-method-title" />
          <div className="l1b-method-grid">
            <div><span>Window</span><strong>200 seconds</strong></div>
            <div><span>Scale times</span><strong>Full timeline</strong></div>
            <div><span>Labels</span><strong>sounding / silent / invalid</strong></div>
            <div><span>Duration engine</span><strong>Praat Script 2</strong></div>
          </div>
          <p className="l1b-small-note">All parameters and the exact Praat version are written into the method log and delivery workbook.</p>
        </section>
      </div>

      <section className="l1b-section" aria-labelledby="l1b-run-title">
        <SectionHeading icon={<Activity size={18} />} eyebrow="Execution" title="L1a to L1b pipeline" id="l1b-run-title" status={runStatusLabel(runState, report)} />
        <div className="l1b-flow">
          <FlowStep label="L1a handoff" state={selected?.ready ? 'passed' : 'pending'} />
          <FlowStep label="Praat extraction" state={stageState(progressJobs, 'praat_extraction', busy)} />
          <FlowStep label="TextGrid QA" state={stageState(progressJobs, 'textgrid_qa', busy)} />
          <FlowStep label="Duration metrics" state={stageState(progressJobs, 'duration_calculation', busy)} />
          <FlowStep label="Delivery package" state={report?.status === 'ready_for_praat_review' ? 'passed' : busy ? 'running' : 'pending'} />
        </div>
        <div className="l1b-job-grid">
          {(speakers.length ? speakers.map((speaker: any) => speaker.speaker) : uniqueSpeakers(progressJobs)).map((speaker: string) => (
            <SpeakerJobs key={speaker} speaker={speaker} thresholds={thresholds} jobs={progressJobs} />
          ))}
        </div>
        <p className="l1b-small-note">This validation run uses the accepted L1a draft handoff. Production L1b requires the Phase I reviewed baseline; any corrected invalid boundaries must remain identical across the 0.25 s and 0.35 s reviewed TextGrids.</p>
      </section>

      {!report ? (
        <div className="l1b-results-empty">
          <Activity size={24} />
          <div><h3>Results will appear here by section</h3><p>Run L1b to generate TextGrids, duration metrics, the method record and the client delivery package.</p></div>
        </div>
      ) : report.status === 'ready_for_praat_review' ? (
        <L1bResults report={report} />
      ) : (
        <Message tone="fail" title="Latest L1b run failed" text={report.error || 'No delivery package was created.'} />
      )}
    </div>
  );
}

function L1bResults({ report }: any) {
  const grouped = groupSummary(report.summary || []);
  const artifacts = report.artifacts || [];
  const textgrids = artifacts.filter((artifact: any) => artifact.group === 'textgrids');
  const workbook = artifacts.find((artifact: any) => artifact.group === 'metrics');
  const method = artifacts.find((artifact: any) => artifact.group === 'method');
  const delivery = artifacts.find((artifact: any) => artifact.group === 'package');

  return (
    <div className="l1b-results">
      <Message tone="pass" title="L1b PoC outputs ready" text={`${report.qa.jobs_passed}/${report.qa.jobs_total} speaker-threshold jobs completed. The TextGrids, duration diagnostics, method record, and package are available below.`} />

      <section className="l1b-section" aria-labelledby="l1b-result-overview">
        <SectionHeading icon={<CheckCircle2 size={18} />} eyebrow="Results" title="Quality overview" id="l1b-result-overview" />
        <div className="l1b-kpis">
          <Kpi value={report.speakers?.length || 0} label="speakers" />
          <Kpi value={report.qa.textgrids_generated} label="TextGrid drafts" />
          <Kpi value={report.thresholds?.map((value: number) => `${value}s`).join(' + ')} label="thresholds" />
          <Kpi value={formatSeconds(report.duration_seconds)} label="full timeline" />
        </div>
        <div className="l1b-qa-strip">
          <QaItem passed={report.qa.no_blank_intervals} label="No blank intervals" />
          <QaItem passed={report.qa.full_timeline} label="Full timeline covered" />
          <QaItem passed={report.qa.invalid_duration_match} label="Invalid duration matched" />
          <QaItem passed={report.qa.script2_parity} label="Script 2 parity" />
        </div>
      </section>

      <section className="l1b-section" aria-labelledby="l1b-speaker-results">
        <SectionHeading icon={<Users size={18} />} eyebrow="Duration metrics" title="Results by speaker" id="l1b-speaker-results" />
        <div className="l1b-result-speakers">
          {Object.entries(grouped).map(([speaker, rows]: any) => (
            <article className="l1b-result-speaker" key={speaker}>
              <div className="l1b-result-speaker-head"><strong>{speaker}</strong><span>{rows.length} threshold runs</span></div>
              <div className="l1b-mini-table" role="table" aria-label={`${speaker} duration results`}>
                <div className="l1b-mini-row head" role="row"><span>Threshold</span><span>Sounding</span><span>Silent</span><span>Pauses</span></div>
                {rows.map((row: any) => (
                  <div className="l1b-mini-row" role="row" key={row['Threshold (s)']}>
                    <strong>{row['Threshold (s)']}s</strong>
                    <span>{numberSeconds(row['Total sounding (s)'])}</span>
                    <span>{numberSeconds(row['Total silent (s)'])}</span>
                    <span>{row['Silent pause count']}</span>
                  </div>
                ))}
              </div>
            </article>
          ))}
        </div>
      </section>

      <section className="l1b-section" aria-labelledby="l1b-deliverables">
        <SectionHeading icon={<Package size={18} />} eyebrow="L1b outputs" title="Download package" id="l1b-deliverables" />
        <div className="l1b-package-primary">
          <div className="l1b-package-primary-icon"><Package size={23} /></div>
          <div className="l1b-package-primary-copy">
            <span>L1b PoC package</span>
            <strong>{delivery?.name || 'Package not generated'}</strong>
            <p>Six threshold-specific TextGrids plus duration diagnostics and the reproducible method record.</p>
          </div>
          {delivery && <DownloadLink artifact={delivery} primary label="Download L1b package" />}
        </div>

        <div className="l1b-delivery-columns">
          <section className="l1b-delivery-group" aria-label="Metrics and method files">
            <div className="l1b-delivery-group-head"><span>Supporting outputs</span><strong>Metrics and method files</strong></div>
            {workbook && <ArtifactRow artifact={workbook} icon={<Sheet size={18} />} kind="Duration diagnostics" description="Praat Script 2 metrics for the generated TextGrids" />}
            {method && <ArtifactRow artifact={method} icon={<FileText size={18} />} kind="Method record" description="Parameters · labels · Praat version · 200 s window" />}
          </section>

          <section className="l1b-delivery-group" aria-label="TextGrid drafts by speaker">
            <div className="l1b-delivery-group-head"><span>Praat outputs</span><strong>TextGrids by speaker</strong></div>
            <div className="l1b-textgrid-groups">
              {uniqueSpeakers(textgrids).map((speaker) => (
                <div className="l1b-textgrid-group" key={speaker}>
                  <div><Users size={15} /><strong>{speaker}</strong></div>
                  {textgrids.filter((artifact: any) => artifact.speaker === speaker).map((artifact: any) => (
                    <div className="l1b-textgrid-row" key={artifact.name}>
                      <span>{Number(artifact.threshold).toFixed(2)}s</span>
                      <strong title={artifact.name}>Pause segmentation</strong>
                      <DownloadLink artifact={artifact} label="Download" />
                    </div>
                  ))}
                </div>
              ))}
            </div>
          </section>
        </div>
      </section>

      <div className="l1b-review-boundary">
        <ShieldCheck size={21} />
        <div><strong>PoC output boundary</strong><p>Expert inspection and any correction in Praat take place outside this validation console before research use.</p></div>
      </div>
    </div>
  );
}

function SectionHeading({ icon, eyebrow, title, id, status }: any) {
  return (
    <div className="l1b-section-head">
      <div className="l1b-section-icon">{icon}</div>
      <div><span>{eyebrow}</span><h2 id={id}>{title}</h2></div>
      {status && <span className="l1b-section-status">{status}</span>}
    </div>
  );
}

function FileLine({ icon, label, value, ready }: any) {
  return <div className="l1b-file-line"><span>{icon}</span><div><small>{label}</small><p>{value}</p></div>{ready ? <Check size={15} /> : <AlertCircle size={15} />}</div>;
}

function FlowStep({ label, state }: { label: string; state: string }) {
  return <div className={`l1b-flow-step ${state}`}><span>{state === 'passed' ? <Check size={14} /> : state === 'running' ? <Clock3 size={14} /> : null}</span><strong>{label}</strong></div>;
}

function SpeakerJobs({ speaker, thresholds, jobs }: any) {
  return (
    <article className="l1b-speaker-jobs">
      <div className="l1b-speaker-jobs-head"><strong>{speaker}</strong><span>Praat jobs</span></div>
      <div className="l1b-speaker-job-runs">
        {thresholds.map((threshold: number) => {
          const job = jobs.find((candidate: any) => candidate.speaker === speaker && Number(candidate.threshold) === Number(threshold));
          const state = job?.state || 'pending';
          return <div className={`l1b-job ${state}`} key={threshold}><span>{threshold}s</span><strong>{stateLabel(state)}</strong></div>;
        })}
      </div>
    </article>
  );
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

function ArtifactRow({ artifact, icon, kind, description }: any) {
  return (
    <div className="l1b-artifact-row">
      <div className="l1b-artifact-icon">{icon}</div>
      <div className="l1b-artifact-copy">
        <span>{kind}</span>
        <strong title={artifact.name}>{artifact.name}</strong>
        <p>{description}</p>
      </div>
      <DownloadLink artifact={artifact} />
    </div>
  );
}

function jobsFromReport(report: any) {
  return (report?.jobs || []).map((job: any) => ({
    speaker: job.speaker,
    threshold: job.threshold,
    state: job.qa?.passed ? 'passed' : 'failed',
    stages: {
      praat_extraction: job.qa?.passed ? 'passed' : 'failed',
      textgrid_qa: job.qa?.passed ? 'passed' : 'failed',
      duration_calculation: job.qa?.script2_parity_ok ? 'passed' : 'failed',
    },
  }));
}

function stageState(jobs: any[], stage: string, busy: boolean) {
  if (!jobs.length) return busy ? 'running' : 'pending';
  if (jobs.some((job) => job.stages?.[stage] === 'failed')) return 'failed';
  if (jobs.every((job) => job.stages?.[stage] === 'passed')) return 'passed';
  if (jobs.some((job) => job.stages?.[stage] === 'running')) return 'running';
  return 'pending';
}

function stateLabel(state: string) {
  if (state === 'passed') return 'Ready';
  if (state === 'running') return 'Running';
  if (state === 'failed') return 'Failed';
  return 'Queued';
}

function runStatusLabel(runState: string, report: any) {
  if (runState === 'running') return 'Running';
  if (runState === 'failed') return 'Failed';
  if (report?.status === 'ready_for_praat_review') return 'Outputs ready';
  return 'Ready to run';
}

function groupSummary(rows: any[]) {
  return rows.reduce((output, row) => {
    (output[row.Speaker] ||= []).push(row);
    return output;
  }, {} as Record<string, any[]>);
}

function uniqueSpeakers(items: any[]) {
  return [...new Set((items || []).map((item: any) => item.speaker).filter(Boolean))] as string[];
}

function formatSeconds(value: any) {
  return Number.isFinite(Number(value)) ? `${Number(value).toFixed(2)}s` : 'Not available';
}

function numberSeconds(value: any) {
  return Number.isFinite(Number(value)) ? `${Number(value).toFixed(2)}s` : '-';
}
