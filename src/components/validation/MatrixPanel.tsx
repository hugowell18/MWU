import React from 'react';

export function MatrixPanel({ phase5 }: { phase5: any }) {
  const p = phase5 || {};
  const columns: string[] = p.columns || [];
  const row: any = p.row || {};
  const cell = (c: string) => {
    const v = row[c];
    if (v === 'pending_not_implemented') return <span className="vc-none">pending</span>;
    return <span className="vc-mono">{v}</span>;
  };
  return (
    <div className="vc-card">
      <div className="vc-card-h">
        <div className="ci">
          <svg className="vc-icon" viewBox="0 0 24 24">
            <path d="M3 3h18v18H3zM3 9h18M3 15h18M9 3v18" />
          </svg>
        </div>
        <h3>Matrix verification (Phase V)</h3>
        <span className="hint">{columns.length ? `${columns.length} columns` : 'ready'}</span>
      </div>
      <div className="vc-card-b">
        {columns.length === 0 ? (
          <p className="vc-note" style={{ marginTop: 0 }}>Run to populate the long-format matrix.</p>
        ) : (
          <>
            <div style={{ display: 'flex', gap: 8, marginBottom: 12, flexWrap: 'wrap' }}>
              <span className="vc-chip blue">cols 1–7 · 0.25 {row.group_status_025}</span>
              <span className="vc-chip amber">cols 8–14 · 0.35 {row.group_status_035}</span>
              <span className="vc-chip">cols 15+ · Phase IV pending</span>
            </div>
            <div className="vc-matrix-scroll">
              <table className="vc-table">
                <thead>
                  <tr>
                    {columns.map((c) => (
                      <th key={c} title={c}>
                        {c.replace(/_/g, ' ').replace(/AS Units/g, 'ASU')}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  <tr>
                    {columns.map((c) => (
                      <td key={c}>{cell(c)}</td>
                    ))}
                  </tr>
                </tbody>
              </table>
            </div>
            <p className="vc-note">
              AS-unit (between/within) and Phase IV (TAALES/TAALED/AntConc) columns are <b>pending_not_implemented</b> — Layer 2.
              No fabricated values.
            </p>
          </>
        )}
      </div>
    </div>
  );
}
