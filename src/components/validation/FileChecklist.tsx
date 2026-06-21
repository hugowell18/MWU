import React from 'react';

export const ROLES = [
  { role: 'wav', label: 'Audio (.wav)', accept: '.wav', hint: 'monologue recording' },
  { role: 'textgrid', label: 'Expert TextGrid', accept: '.TextGrid', hint: 'gold segmentation' },
  { role: 'transcript', label: 'Transcript (.txt)', accept: '.txt', hint: 'checked & pruned' },
  { role: 'workbook', label: 'Gold workbook (.xlsx)', accept: '.xlsx', hint: 'fluency baseline' },
];

function kb(bytes: number) {
  if (!bytes) return '';
  if (bytes > 1e6) return (bytes / 1e6).toFixed(1) + ' MB';
  return (bytes / 1e3).toFixed(0) + ' KB';
}

// Interactive upload checklist. selected: { role: File|null }. useSample toggles the bundled SpeakerX benchmark.
export function FileChecklist({
  selected,
  useSample,
  onPick,
  onToggleSample,
  disabled,
  roleKeys,
  title = 'Benchmark inputs',
}: {
  selected: Record<string, File | null>;
  useSample: boolean;
  onPick: (role: string, file: File | null) => void;
  onToggleSample: (v: boolean) => void;
  disabled?: boolean;
  roleKeys?: string[];
  title?: string;
}) {
  const shown = roleKeys ? ROLES.filter((r) => roleKeys.includes(r.role)) : ROLES;
  return (
    <div className="vc-card">
      <div className="vc-card-h">
        <div className="ci">
          <svg className="vc-icon" viewBox="0 0 24 24">
            <path d="M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z" />
          </svg>
        </div>
        <h3>{title}</h3>
        <label className="vc-sample-toggle">
          <input type="checkbox" checked={useSample} disabled={disabled} onChange={(e) => onToggleSample(e.target.checked)} />
          Use SpeakerX sample
        </label>
      </div>
      <div className="vc-card-b">
        {shown.map((r) => {
          const f = selected[r.role];
          const ready = useSample || !!f;
          return (
            <div className="vc-uprow" key={r.role}>
              <div className={`vc-fi ${ready ? 'ok' : ''}`}>
                <svg className="vc-icon" viewBox="0 0 24 24">
                  <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z" />
                  <path d="M14 2v6h6" />
                </svg>
              </div>
              <div className="vc-upmeta">
                <div className="vc-fname">{r.label}</div>
                <div className="vc-fmeta">
                  {useSample ? `SpeakerX sample · ${r.hint}` : f ? `${f.name} · ${kb(f.size)}` : r.hint}
                </div>
              </div>
              {useSample ? (
                <span className="vc-badge vc-s-ready">
                  <span className="dot" />
                  sample
                </span>
              ) : (
                <label className={`vc-upload-btn ${disabled ? 'disabled' : ''}`}>
                  {f ? 'replace' : 'choose'}
                  <input
                    type="file"
                    accept={r.accept}
                    disabled={disabled}
                    style={{ display: 'none' }}
                    onChange={(e) => onPick(r.role, e.target.files && e.target.files[0] ? e.target.files[0] : null)}
                  />
                </label>
              )}
            </div>
          );
        })}
        <p className="vc-note">
          Single-speaker monologue — Phase I diarization is skipped. Upload your own four files, or use the bundled SpeakerX
          benchmark.
        </p>
      </div>
    </div>
  );
}
