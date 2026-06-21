import React from 'react';

export function ThresholdConfig({
  config,
  goldThreshold = 0.25,
  customOn,
  customVal,
  disabled,
  onCustomToggle,
  onCustomChange,
}: {
  config: any;
  goldThreshold?: number;
  customOn?: boolean;
  customVal?: string;
  disabled?: boolean;
  onCustomToggle?: (v: boolean) => void;
  onCustomChange?: (v: string) => void;
}) {
  const thresholds: number[] = (config && config.thresholds_sec) || [0.25, 0.35];
  return (
    <div className="vc-card">
      <div className="vc-card-h">
        <div className="ci">
          <svg className="vc-icon" viewBox="0 0 24 24">
            <path d="M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3M1 14h6M9 8h6M17 16h6" />
          </svg>
        </div>
        <h3>Parameters</h3>
        <span className="hint">configurable array</span>
      </div>
      <div className="vc-card-b">
        <div className="vc-kv">
          <span className="k">Pause thresholds</span>
          <span className="v" style={{ display: 'flex', gap: 6, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
            <span className="vc-chip blue">0.25 s · gold</span>
            <span className="vc-chip amber">0.35 s · no-gold</span>
            {customOn && parseFloat(customVal || '') > 0 && <span className="vc-chip amber">{customVal} s · custom</span>}
          </span>
        </div>
        {onCustomToggle && (
          <div className="vc-kv">
            <label className="k" style={{ display: 'inline-flex', alignItems: 'center', gap: 7, cursor: 'pointer' }}>
              <input type="checkbox" checked={!!customOn} disabled={disabled} onChange={(e) => onCustomToggle(e.target.checked)} style={{ accentColor: 'var(--blue-600)' }} />
              Custom threshold
            </label>
            <span className="v">
              <input
                type="number"
                step="0.01"
                min="0.05"
                max="2"
                value={customVal}
                disabled={disabled || !customOn}
                onChange={(e) => onCustomChange && onCustomChange(e.target.value)}
                style={{ width: 90, padding: '5px 8px', borderRadius: 7, border: '1px solid var(--slate-200)', fontFamily: 'ui-monospace,Menlo,monospace', fontSize: 12 }}
              />{' '}
              s
            </span>
          </div>
        )}
        <div className="vc-kv">
          <span className="k">Praat window size</span>
          <span className="v">{(config && config.praat_window_sec) || 200} s</span>
        </div>
        <div className="vc-kv">
          <span className="k">Label contract</span>
          <span className="v">sounding · silent · invalid</span>
        </div>
        <div className="vc-kv">
          <span className="k">Tolerances</span>
          <span className="v">count exact · duration ≤ 0.001 s</span>
        </div>
      </div>
    </div>
  );
}
