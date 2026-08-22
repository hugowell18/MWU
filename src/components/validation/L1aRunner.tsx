import React, { useEffect, useRef, useState } from 'react';
import {
  AlertCircle,
  AudioWaveform,
  Check,
  CheckCircle2,
  Clock3,
  Download,
  FileAudio,
  FileOutput,
  FolderTree,
  GitMerge,
  Package,
  Play,
  RefreshCw,
  RotateCcw,
  ShieldCheck,
  Upload,
  UsersRound,
} from 'lucide-react';

type Decision = {
  candidate_id: string;
  decision: 'include' | 'exclude' | 'uncertain' | 'merge';
  role: 'participant' | 'other_or_incidental' | 'uncertain' | 'unspecified';
  canonical_speaker: string | null;
  merge_into: string | null;
  note: string;
};

type ActionNotice = {
  title: string;
  message: string;
};

const EMPTY: Record<string, Decision> = {};

function providerCandidateOrder(leftValue: string, rightValue: string) {
  const left = String(leftValue);
  const right = String(rightValue);
  const leftMatch = /^(.*?)(\d+)$/.exec(left);
  const rightMatch = /^(.*?)(\d+)$/.exec(right);
  if (leftMatch && rightMatch && leftMatch[1] === rightMatch[1]) {
    return Number(leftMatch[2]) - Number(rightMatch[2]) || left.localeCompare(right);
  }
  return left.localeCompare(right);
}

function orderedProviderCandidates(candidates: any[] = []) {
  return [...candidates].sort((left, right) => providerCandidateOrder(left.candidate_id, right.candidate_id));
}

function defaultDecision(candidateId: string, index: number): Decision {
  return {
    candidate_id: candidateId,
    decision: 'include',
    role: 'participant',
    canonical_speaker: `S${index + 1}`,
    merge_into: null,
    note: '',
  };
}

function unresolvedDecision(candidateId: string): Decision {
  return {
    candidate_id: candidateId,
    decision: 'uncertain',
    role: 'unspecified',
    canonical_speaker: null,
    merge_into: null,
    note: '',
  };
}

export function L1aRunner() {
  const [file, setFile] = useState<File | null>(null);
  const [runId, setRunId] = useState<string | null>(null);
  const [snapshot, setSnapshot] = useState<any>(null);
  const [decisions, setDecisions] = useState<Record<string, Decision>>(EMPTY);
  const [reviewer, setReviewer] = useState('');
  const [busy, setBusy] = useState<'upload' | 'confirm' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<ActionNotice | null>(null);
  const audio = useRef<HTMLAudioElement | null>(null);
  const fileInput = useRef<HTMLInputElement | null>(null);
  const stopTimer = useRef<number | null>(null);
  const outputSection = useRef<HTMLElement | null>(null);

  async function loadSnapshot(id: string) {
    const response = await fetch(`/api/l1a/runs/${encodeURIComponent(id)}/candidates`);
    const value = await response.json();
    if (!response.ok) throw new Error(value.error || 'L1a run could not be loaded');
    setSnapshot(value);
    setRunId(id);
    setReviewer(value.review?.reviewer || '');
    setError(value.state?.status === 'failed' ? (value.state.error || 'Diarization failed') : null);
    if (value.candidates?.candidates) {
      const orderedCandidates = orderedProviderCandidates(value.candidates.candidates);
      const prior = new Map((value.review?.decisions || []).map((item: Decision) => [item.candidate_id, item]));
      const hasPriorReview = prior.size > 0;
      setDecisions(Object.fromEntries(orderedCandidates.map((candidate: any, index: number) => {
        const existing = prior.get(candidate.candidate_id) as Decision | undefined;
        return [candidate.candidate_id, existing || (hasPriorReview
          ? unresolvedDecision(candidate.candidate_id)
          : defaultDecision(candidate.candidate_id, index))];
      })));
    }
    return value;
  }

  useEffect(() => {
    const requestedRun = new URLSearchParams(window.location.search).get('run');
    if (requestedRun) loadSnapshot(requestedRun).catch(() => {});
    return () => {
      if (stopTimer.current) window.clearTimeout(stopTimer.current);
    };
  }, []);

  function setRunUrl(id: string | null) {
    const url = new URL(window.location.href);
    if (id) url.searchParams.set('run', id);
    else url.searchParams.delete('run');
    window.history.replaceState({}, '', url);
  }

  async function poll(id: string) {
    try {
      const value = await loadSnapshot(id);
      if (['provider_pending', 'provider_running'].includes(value.state?.status)) {
        window.setTimeout(() => poll(id), 1200);
      } else {
        setBusy(null);
        if (value.state?.status === 'failed') setError(value.state.error || 'Diarization failed');
      }
    } catch (reason: any) {
      setBusy(null);
      setError(reason.message || String(reason));
    }
  }

  async function uploadAndRun() {
    if (!file || busy) return;
    setBusy('upload');
    setError(null);
    setNotice(null);
    try {
      const response = await fetch(`/api/l1a/run?filename=${encodeURIComponent(file.name)}`, {
        method: 'POST',
        headers: { 'content-type': file.type || 'audio/wav', 'x-file-name': file.name },
        body: file,
      });
      const value = await response.json();
      if (!response.ok) throw new Error(value.error || 'L1a could not start');
      setRunId(value.run_id);
      setRunUrl(value.run_id);
      await poll(value.run_id);
    } catch (reason: any) {
      setBusy(null);
      setError(reason.message || String(reason));
    }
  }

  function selectInputFile(nextFile: File | null) {
    if (busy) return;
    if (stopTimer.current) window.clearTimeout(stopTimer.current);
    if (audio.current) {
      audio.current.pause();
      audio.current.removeAttribute('src');
      audio.current.load();
    }
    setFile(nextFile);
    setRunId(null);
    setSnapshot(null);
    setDecisions({});
    setReviewer('');
    setError(null);
    setNotice(null);
    setRunUrl(null);
  }

  function resetWorkspace() {
    if (busy) return;
    selectInputFile(null);
    if (fileInput.current) fileInput.current.value = '';
  }

  function updateDecision(candidateId: string, patch: Partial<Decision>) {
    setNotice(null);
    setDecisions((current) => {
      const next = {
        ...current,
        [candidateId]: {
          ...current[candidateId],
          ...patch,
          ...(patch.decision && patch.decision !== 'include' ? { canonical_speaker: null } : {}),
          ...(patch.decision && patch.decision !== 'merge' ? { merge_into: null } : {}),
          ...(patch.decision === 'include' ? { role: 'participant' as const } : {}),
          ...(patch.decision === 'exclude' ? { role: 'other_or_incidental' as const } : {}),
          ...(patch.decision === 'uncertain' ? { role: 'uncertain' as const } : {}),
        },
      };
      return patch.decision
        ? renumberIncluded(next, candidates.map((candidate: any) => candidate.candidate_id))
        : next;
    });
  }

  async function confirm() {
    if (!runId || busy) return;
    setBusy('confirm');
    setError(null);
    setNotice(null);
    try {
      const response = await fetch(`/api/l1a/runs/${encodeURIComponent(runId)}/confirm`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ reviewer: reviewer.trim(), decisions: Object.values(decisions) }),
      });
      const value = await response.json();
      if (!response.ok) throw new Error(value.validation_errors?.join('; ') || value.error || 'Mapping could not be confirmed');
      await loadSnapshot(runId);
      setNotice({
        title: 'Participant mapping accepted',
        message: 'The PoC-aligned Layer 1a package was rebuilt and is ready to download.',
      });
      setBusy(null);
      window.requestAnimationFrame(() => outputSection.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }));
    } catch (reason: any) {
      setBusy(null);
      setError(reason.message || String(reason));
    }
  }

  async function playClip(clip: any) {
    if (!audio.current) return;
    if (stopTimer.current) window.clearTimeout(stopTimer.current);
    audio.current.src = clip.audio_url;
    audio.current.currentTime = clip.start;
    await audio.current.play();
    stopTimer.current = window.setTimeout(() => audio.current?.pause(), Math.max(250, (clip.end - clip.start) * 1000));
  }

  const candidates = orderedProviderCandidates(snapshot?.candidates?.candidates || []);
  const state = snapshot?.state;
  const included = Object.values(decisions).filter((item) => item.decision === 'include');
  const resolved = Object.values(decisions).filter((item) => isResolved(item)).length;
  const accepted = state?.status === 'accepted' && !state?.downstream_invalidated;
  const allArtifacts = snapshot?.artifacts || [];
  const clientArtifacts = allArtifacts.filter((artifact: any) => artifact.client_delivery);
  const deliveryPackage = allArtifacts.find((artifact: any) => artifact.primary_package);
  const timelineArtifacts = clientArtifacts.filter((artifact: any) => artifact.kind === 'textgrid');
  const turnArtifacts = clientArtifacts.filter((artifact: any) => ['rttm', 'csv'].includes(artifact.kind));
  const mutedMirrorArtifacts = clientArtifacts.filter((artifact: any) => artifact.kind === 'wav');
  const sessionId = state?.session_id || runId;
  const layerRevision = snapshot?.layer_manifest?.latest_revision || (snapshot?.review?.revision ? `review-v${String(snapshot.review.revision).padStart(4, '0')}` : 'pending');
  const canonicalIds = included.map((item) => item.canonical_speaker).filter(Boolean);
  const expectedCanonicalIds = included.map((_, index) => `S${index + 1}`);
  const mappingComplete = included.length >= 2
    && canonicalIds.length === included.length
    && new Set(canonicalIds).size === canonicalIds.length
    && [...canonicalIds].sort(canonicalSpeakerOrder).join(',') === expectedCanonicalIds.join(',');
  const canConfirm = Boolean(
    reviewer.trim()
    && candidates.length
    && resolved === candidates.length
    && mappingComplete,
  );
  return (
    <div className="l1a-page">
      <audio ref={audio} preload="metadata" className="l1a-audio" />
      <header className="l1a-head">
        <div className="l1a-title-icon"><UsersRound size={22} /></div>
        <div className="l1a-head-copy">
          <div className="vc-layer-eyebrow"><span>L1a</span>Phase I · operational workspace</div>
          <h1>Speaker evidence and participant review</h1>
          <p>Generate acoustic candidates, listen to representative evidence and confirm the participant-to-S1-SN mapping before Phase II starts.</p>
        </div>
      </header>

      {error && <div className="l1a-alert error"><AlertCircle size={17} /><div><strong>L1a needs attention</strong><p>{error}</p></div></div>}
      {notice && <div className="l1a-alert success" role="status" aria-live="polite"><CheckCircle2 size={17} /><div><strong>{notice.title}</strong><p>{notice.message}</p></div></div>}

      <section className="l1a-status-strip">
        <StatusCell label="WAV preflight" value={state?.preflight ? `Passed · ${formatAudio(state.preflight)}` : 'Waiting for WAV'} tone={state?.preflight ? 'pass' : ''} />
        <StatusCell
          label="Server session input"
          value={state?.managed_input?.relative_path || state?.original_filename || '1 room-mix WAV'}
        />
        <StatusCell label="Provider candidates" value={candidates.length ? `${candidates.length} acoustic clusters` : state?.status === 'provider_running' ? 'Processing...' : 'Not generated'} />
        <StatusCell
          label="Researcher review"
          value={!candidates.length ? 'Not started' : accepted ? `${resolved} accepted` : `${candidates.length} prefilled · review required`}
          tone={accepted ? 'pass' : 'warn'}
        />
      </section>

      <div className="l1a-top-grid">
        <section className="l1a-card">
          <SectionTitle eyebrow="Layer 1a input" title="Upload room-mix audio" icon={<FileAudio size={17} />} status={state?.preflight ? 'Input ready' : 'WAV required'} />
          <label className="l1a-upload">
            <input ref={fileInput} type="file" accept="audio/wav,.wav" disabled={!!busy} onChange={(event) => selectInputFile(event.target.files?.[0] || null)} />
            <div><strong>{file?.name || state?.original_filename || 'Choose one room-mix WAV'}</strong><span>{file ? `${formatBytes(file.size)} · ready for preflight` : 'Original WAV becomes the canonical timeline'}</span></div>
            <span className="l1a-upload-button"><Upload size={15} /> Browse</span>
          </label>
          <div className="l1a-input-actions">
            <button className="l1a-button primary" onClick={uploadAndRun} disabled={!file || !!busy}>{busy === 'upload' ? <Clock3 size={15} /> : <AudioWaveform size={15} />}{busy === 'upload' ? 'Running diarization...' : 'Generate candidates'}</button>
            <button className="l1a-button" onClick={resetWorkspace} disabled={(!file && !runId && !snapshot) || !!busy} title="Clear the selected WAV and current workspace state"><RotateCcw size={15} />Reset</button>
          </div>
          <div className="l1a-info"><span>i</span><p><strong>Candidate review follows diarization.</strong> The provider returns acoustic candidates; the researcher decides which voices belong in the study.</p></div>
        </section>

        <section className="l1a-card">
          <SectionTitle eyebrow="Processing state" title="Phase I evidence path" icon={<RefreshCw size={17} />} status={statusLabel(state?.status)} />
          <div className="l1a-flow">
            <FlowStep number="01" label="Preflight" state={state?.preflight ? 'passed' : 'pending'} detail="Canonical clock" />
            <FlowStep number="02" label="Diarization" state={candidates.length ? 'passed' : state?.status === 'provider_running' ? 'running' : 'pending'} detail="All candidates" />
            <FlowStep number="03" label="Review" state={accepted ? 'passed' : candidates.length ? 'running' : 'pending'} detail="Resolve evidence" />
            <FlowStep number="04" label="Mapping" state={accepted ? 'passed' : 'pending'} detail="Confirm S1-SN" />
            <FlowStep number="05" label="Artifacts" state={accepted ? 'passed' : 'pending'} detail="Rebuild handoff" />
          </div>
          <p className="l1a-run-meta">{state ? <>Run <code>{state.run_id}</code> · {formatDuration(state.preflight?.duration_seconds)} canonical timeline</> : 'A run identifier and canonical clock appear after preflight.'}</p>
        </section>
      </div>

      <section className="l1a-card l1a-evidence">
        <SectionTitle eyebrow="Candidate evidence" title="Listen, decide and map" icon={<Play size={17} />} status={candidates.length ? `${candidates.length} candidates` : 'Waiting'} />
        <p className="l1a-card-note">Up to three clips are ranked for speaker identification using clean non-overlap duration, acoustic clarity, clipping, provider confidence and time diversity. Raw clusters are shown in provider-number order; accepted S1-SN values remain run-local research IDs.</p>
        <div className="l1a-table-wrap">
          <table className="l1a-table">
            <thead><tr><th>Raw AI cluster</th><th>Representative evidence</th><th>Activity</th><th>Research role</th><th>Decision</th><th>Research speaker ID</th><th>Review state</th></tr></thead>
            <tbody>
              {candidates.map((candidate: any) => {
                const decision = decisions[candidate.candidate_id];
                if (!decision) return null;
                const decisionResolved = isResolved(decision);
                const reviewState = accepted && decisionResolved ? 'Accepted' : decisionResolved ? 'Prefilled' : 'Decision needed';
                return (
                  <tr key={candidate.candidate_id}>
                    <td><strong>{candidate.candidate_id}</strong><span>Provider acoustic cluster</span></td>
                    <td><div className="l1a-clips">{candidate.clips.map((clip: any) => <button className={clip.review_required ? 'low-quality' : ''} key={clip.id} onClick={() => playClip(clip)} title={clipTooltip(clip)}><Play size={11} />{clip.label} {clock(clip.start)} · Q{Math.round(clip.quality_score)}{clip.contains_overlap ? ' · overlap' : ''}</button>)}</div>{candidate.evidence_quality === 'low_overlap_only' ? <span className="l1a-evidence-warning"><AlertCircle size={11} />No clean non-overlap sample; verify carefully</span> : candidate.identification_quality === 'low' ? <span className="l1a-evidence-warning"><AlertCircle size={11} />Only short or acoustically weak clean samples are available</span> : null}</td>
                    <td><strong>{candidate.active_seconds.toFixed(2)} s</strong><span>{candidate.interval_count} intervals</span></td>
                    <td><select aria-label={`${candidate.candidate_id} research role`} value={decision.role} onChange={(event) => updateDecision(candidate.candidate_id, { role: event.target.value as Decision['role'] })}><option value="unspecified">Not assigned</option><option value="participant">Participant</option><option value="other_or_incidental">Teacher / other</option><option value="uncertain">Uncertain</option></select></td>
                    <td><select aria-label={`${candidate.candidate_id} review decision`} value={decision.decision} onChange={(event) => updateDecision(candidate.candidate_id, { decision: event.target.value as Decision['decision'] })}><option value="uncertain">Uncertain</option><option value="include">Include</option><option value="exclude">Exclude</option><option value="merge">Merge</option></select></td>
                    <td>{decision.decision === 'include' ? <strong aria-label={`${candidate.candidate_id} canonical speaker`}>{decision.canonical_speaker || 'Pending'}</strong> : decision.decision === 'merge' ? <select aria-label={`${candidate.candidate_id} merge target`} value={decision.merge_into || ''} onChange={(event) => updateDecision(candidate.candidate_id, { merge_into: event.target.value || null })}><option value="">Merge target</option>{candidates.filter((item: any) => item.candidate_id !== candidate.candidate_id && decisions[item.candidate_id]?.decision === 'include').map((item: any) => <option key={item.candidate_id} value={item.candidate_id}>{item.candidate_id}</option>)}</select> : <span className="l1a-na">Not assigned</span>}</td>
                    <td><span className={`l1a-review-state ${accepted && decisionResolved ? 'resolved' : 'open'}`}>{accepted && decisionResolved ? <CheckCircle2 size={12} /> : decisionResolved ? <Clock3 size={12} /> : <AlertCircle size={12} />}{reviewState}</span></td>
                  </tr>
                );
              })}
              {!candidates.length && <tr><td colSpan={7} className="l1a-empty">Upload a WAV and generate provider candidates to begin researcher review.</td></tr>}
            </tbody>
          </table>
        </div>
        <div className={`l1a-review-toolbar ${candidates.length ? '' : 'locked'}`}>
          <label className="l1a-reviewer"><span>Reviewer / rater ID</span><input required disabled={!candidates.length || !!busy} value={reviewer} onChange={(event) => { setReviewer(event.target.value); setNotice(null); }} placeholder={candidates.length ? 'Enter assigned ID' : 'Available after generation'} /></label>
          <div className="l1a-action-stack final">
            <span>Final L1a output</span>
            <button className="l1a-button primary" onClick={confirm} disabled={!canConfirm || !!busy} title={canConfirm ? 'Accept the mapping and build the final Layer 1a artifacts' : 'Generate candidates, enter a reviewer ID and resolve every candidate first'}><ShieldCheck size={15} />{busy === 'confirm' ? 'Building outputs...' : 'Accept mapping & build outputs'}</button>
          </div>
        </div>
      </section>

      <section className="l1a-card l1a-output" ref={outputSection}>
        <SectionTitle eyebrow="Layer 1a outputs" title="Speaker evidence deliverables" icon={<FileOutput size={17} />} status={accepted ? 'Accepted package ready' : 'Human gate pending'} />
        <div className="l1a-session-band">
          <FolderTree size={17} />
          <div><span>Execution session</span><strong>{sessionId || 'Created after WAV preflight'}</strong></div>
          <div><span>Layer folder</span><strong>L1a / {layerRevision}</strong></div>
          <div><span>Next-layer input</span><strong>{accepted ? 'L1b handoff ready' : 'Waiting for confirmation'}</strong></div>
        </div>
        <div className="l1a-output-grid">
          <OutputGroup title="Current draft evidence" subtitle="Provider candidate outputs" rows={[
            ['Provider timed turns', candidates.length ? 'Ready' : 'Waiting'],
            ['Candidate activity and clips', candidates.length ? 'Ready' : 'Waiting'],
            ['Accepted review record', accepted && snapshot?.review ? `Revision ${snapshot.review.revision}` : 'Waiting'],
          ]} />
          <div className="l1a-output-group">
            <div className="l1a-output-head"><span>After human gate</span><strong>Accepted L1a package</strong></div>
            {deliveryPackage ? <div className="l1a-package-block">
              <div className="l1a-package-primary">
                <div className="l1a-package-icon"><Package size={21} /></div>
                <div><span>Customer download</span><strong>{deliveryPackage.name}</strong><p>One speaker TextGrid, RTTM, CSV and {mutedMirrorArtifacts.length} full-timeline muted-mirror WAVs.</p></div>
                <a href={`/api/l1a/runs/${encodeURIComponent(runId || '')}/artifact?path=${encodeURIComponent(deliveryPackage.relative_path)}`}><Download size={14} /> Download ZIP</a>
              </div>
              <details className="l1a-package-contents">
                <summary>View package contents ({clientArtifacts.length} files)</summary>
                <div className="l1a-delivery-groups">
                  <DeliverableGroup title="Speaker timeline" detail="1 reviewed speaker TextGrid" artifacts={timelineArtifacts} />
                  <DeliverableGroup title="Turn evidence" detail="RTTM and CSV" artifacts={turnArtifacts} />
                  <DeliverableGroup title="Muted-mirror tracks" detail={`${mutedMirrorArtifacts.length} full-timeline WAVs`} artifacts={mutedMirrorArtifacts} />
                </div>
              </details>
            </div> : <><OutputRow label="Accepted L1a ZIP" state="Waiting" /><OutputRow label="1 TextGrid + RTTM + CSV + N WAVs" state="Waiting" /></>}
          </div>
        </div>
        <div className={`l1a-gate ${accepted ? 'accepted' : ''}`}>
          {accepted ? <CheckCircle2 size={18} /> : <AlertCircle size={18} />}
          <div><strong>{accepted ? 'L1a human gate is complete' : 'L1a human gate is not complete'}</strong><p>{accepted ? 'The accepted mapping and Phase II handoff are ready. Muted-mirror WAVs remain masked room-mix evidence, not clean source separation.' : 'Resolve every candidate, confirm unique contiguous S1-SN assignments, then rebuild Phase I artifacts. A changed mapping invalidates earlier L1b drafts.'}</p></div>
        </div>
      </section>
    </div>
  );
}

function isResolved(item: Decision) {
  if (item.decision === 'include') return Boolean(item.canonical_speaker);
  if (item.decision === 'merge') return Boolean(item.merge_into);
  return item.decision === 'exclude';
}

function renumberIncluded(decisions: Record<string, Decision>, candidateOrder: string[]) {
  let canonicalIndex = 0;
  return Object.fromEntries(candidateOrder.map((candidateId) => {
    const decision = decisions[candidateId];
    if (decision.decision !== 'include') return [candidateId, { ...decision, canonical_speaker: null }];
    canonicalIndex += 1;
    return [candidateId, { ...decision, canonical_speaker: `S${canonicalIndex}` }];
  }));
}

function canonicalSpeakerOrder(left: string | null, right: string | null) {
  return Number(String(left).slice(1)) - Number(String(right).slice(1));
}

function clipTooltip(clip: any) {
  const quality = `Quality ${Math.round(clip.quality_score || 0)}/100`;
  const duration = `${Number(clip.duration_seconds || 0).toFixed(2)} s`;
  const level = clip.median_dbfs == null ? null : `median ${Number(clip.median_dbfs).toFixed(1)} dBFS`;
  const boundary = clip.contains_overlap ? 'overlap-only fallback; verify carefully' : 'clean non-overlap evidence';
  return [quality, duration, level, boundary].filter(Boolean).join(' · ');
}

function StatusCell({ label, value, tone = '' }: { label: string; value: string; tone?: string }) {
  return <div className={tone}><span>{label}</span><strong>{value}</strong></div>;
}

function SectionTitle({ eyebrow, title, icon, status }: { eyebrow: string; title: string; icon: React.ReactNode; status: string }) {
  return <div className="l1a-section-title"><div className="l1a-section-icon">{icon}</div><div><span>{eyebrow}</span><h2>{title}</h2></div><b>{status}</b></div>;
}

function FlowStep({ number, label, detail, state }: { number: string; label: string; detail: string; state: string }) {
  return <div className={`l1a-flow-step ${state}`}><span>{state === 'passed' ? <Check size={13} /> : number}</span><strong>{label}</strong><small>{detail}</small></div>;
}

function OutputGroup({ title, subtitle, rows }: { title: string; subtitle: string; rows: string[][] }) {
  return <div className="l1a-output-group"><div className="l1a-output-head"><span>{title}</span><strong>{subtitle}</strong></div>{rows.map(([label, state]) => <OutputRow key={label} label={label} state={state} />)}</div>;
}

function OutputRow({ label, state }: { label: string; state: string }) {
  return <div className="l1a-output-row"><div><strong>{label}</strong><span>Canonical-timeline evidence</span></div><b>{state}</b></div>;
}

function DeliverableGroup({ title, detail, artifacts }: { title: string; detail: string; artifacts: any[] }) {
  return <div className="l1a-delivery-group">
    <div className="l1a-delivery-group-head"><div><strong>{title}</strong><span>{detail}</span></div><b>{artifacts.length}</b></div>
    {artifacts.map((artifact) => <div className="l1a-output-row" key={artifact.relative_path}>
      <div><strong>{artifact.name}</strong><span>{formatBytes(artifact.bytes)}</span></div>
      <b>{formatBytes(artifact.bytes)}</b>
    </div>)}
  </div>;
}

function statusLabel(status?: string) {
  return ({ provider_pending: 'Preflight passed', provider_running: 'Provider processing', candidate_review: 'Review required', accepted: 'Accepted', failed: 'Failed' } as Record<string, string>)[status || ''] || 'Not started';
}

function formatAudio(preflight: any) {
  return `${Math.round((preflight.sample_rate || 0) / 1000)} kHz · ${preflight.channels || 0} ch`;
}

function formatBytes(bytes: number) {
  if (!Number.isFinite(bytes)) return '0 B';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
}

function formatDuration(seconds?: number) {
  if (!Number.isFinite(seconds)) return '00:00:00.000';
  const hours = Math.floor((seconds || 0) / 3600);
  const minutes = Math.floor(((seconds || 0) % 3600) / 60);
  const secs = (seconds || 0) % 60;
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${secs.toFixed(3).padStart(6, '0')}`;
}

function clock(seconds: number) {
  const minutes = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
}
