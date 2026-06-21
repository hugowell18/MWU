import React from 'react';

// steps: [{ label, desc, state: 'done'|'pending'|'blocked'|'running' }]
export function RunStepper({ steps, subtitle }: { steps: any[]; subtitle?: string }) {
  return (
    <div className="vc-card">
      <div className="vc-card-h">
        <div className="ci">
          <svg className="vc-icon" viewBox="0 0 24 24">
            <path d="M22 12h-4l-3 9L9 3l-3 9H2" />
          </svg>
        </div>
        <h3>Run pipeline</h3>
        <span className="hint">{subtitle}</span>
      </div>
      <div className="vc-card-b">
        <div className="vc-steps">
          {steps.map((s, i) => (
            <div className={`vc-step ${s.state === 'done' ? 'done' : ''}`} key={i}>
              <div className="lab">
                <span className={`vc-dot ${s.state}`}>
                  {s.state === 'done' ? '✓' : s.state === 'blocked' ? '!' : i + 1}
                </span>
                {s.label}
              </div>
              <div className="desc">{s.desc}</div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
