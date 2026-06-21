import React from 'react';

const Download = (
  <svg className="vc-icon-sm" viewBox="0 0 24 24">
    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3" />
  </svg>
);

export function ArtifactDownloads({ artifacts }: { artifacts: any[] }) {
  // deliverables only — TextGrid / txt / xlsx (drop csv, json, logs, md)
  const list = (artifacts || []).filter((a) => /\.(textgrid|txt|xlsx)$/i.test(a.name));
  return (
    <div className="vc-card">
      <div className="vc-card-h">
        <div className="ci">{Download}</div>
        <h3>Artifacts</h3>
        <span className="hint">{list.length ? `${list.length} files · TextGrid / txt / xlsx` : 'generated after run'}</span>
      </div>
      <div className="vc-card-b">
        {list.length === 0 && <p className="vc-note" style={{ marginTop: 0 }}>No artifacts yet — run the sprint.</p>}
        {list.map((a) => (
          <div className="vc-arow" key={a.name}>
            <svg className="vc-icon" viewBox="0 0 24 24" style={{ stroke: 'var(--slate-400)' }}>
              <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z" />
              <path d="M14 2v6h6" />
            </svg>
            <span className="vc-an">{a.name}</span>
            <span className="vc-am">{a.kind}</span>
            <a className="vc-ad" href={`/api/file?path=${encodeURIComponent(a.path)}`} target="_blank" rel="noreferrer">
              {Download} download
            </a>
          </div>
        ))}
      </div>
    </div>
  );
}
