import React from 'react';

function fmt(x: any) {
  if (typeof x !== 'number') return x;
  if (Number.isInteger(x)) return x;
  return x.toFixed(6);
}
function delta(d: any) {
  if (typeof d !== 'number') return d;
  if (d === 0) return '0';
  return Math.abs(d).toExponential(2);
}

const Check = (
  <svg className="vc-icon-sm" viewBox="0 0 24 24">
    <path d="M20 6 9 17l-5-5" />
  </svg>
);
const X = (
  <svg className="vc-icon-sm" viewBox="0 0 24 24">
    <path d="M18 6 6 18M6 6l12 12" />
  </svg>
);

// Gold comparison: rows = [{metric,ours,gold,delta,tolerance,pass}]
export function MetricComparisonTable({ rows, awaiting }: { rows: any[]; awaiting?: boolean }) {
  return (
    <table className="vc-table">
      <thead>
        <tr>
          <th>Metric (0.25 s · gold replay)</th>
          <th>Our output</th>
          <th>SpeakerX gold</th>
          <th>Δ</th>
          <th>Tol.</th>
          <th>Status</th>
        </tr>
      </thead>
      <tbody>
        {(rows || []).map((r) => (
          <tr key={r.metric}>
            <td>{r.metric}</td>
            <td className="num">{awaiting ? '—' : fmt(r.ours)}</td>
            <td className="num">{fmt(r.gold)}</td>
            <td className="num">{awaiting ? '—' : delta(r.delta)}</td>
            <td>{r.tolerance}</td>
            <td>
              {awaiting ? (
                <span className="vc-none">awaiting run</span>
              ) : r.pass ? (
                <span className="vc-ok">{Check} pass</span>
              ) : (
                <span className="vc-no">{X} fail</span>
              )}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

// Generated 0.35 (no gold)
export function NoGoldTable({ entry }: { entry: any }) {
  const d = entry && entry.durations;
  const rows = d
    ? [
        { metric: 'Silent intervals (≥ 0.35 s)', value: d.silent_count },
        { metric: 'Total silent (s)', value: fmt(d.total_silent) },
        { metric: 'Speaking time (s)', value: fmt(d.total_sounding) },
        { metric: 'Mean silent pause (s)', value: fmt(d.mean_silent) },
      ]
    : [];
  return (
    <table className="vc-table">
      <thead>
        <tr>
          <th>Metric (0.35 s · generated)</th>
          <th>Our output</th>
          <th>Gold</th>
          <th>Status</th>
        </tr>
      </thead>
      <tbody>
        {rows.length === 0 && (
          <tr>
            <td colSpan={4}>
              <span className="vc-none">{entry && entry.status === 'blocked' ? 'blocked — Praat unavailable' : 'awaiting run'}</span>
            </td>
          </tr>
        )}
        {rows.map((r) => (
          <tr key={r.metric}>
            <td>{r.metric}</td>
            <td className="num">{r.value}</td>
            <td className="num">—</td>
            <td>
              <span className="vc-badge vc-s-generated_no_gold">
                <span className="dot" />
                no gold
              </span>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
