import React from 'react';

// 8 required states + skipped
const LABEL: Record<string, string> = {
  idle: 'idle',
  ready: 'ready',
  running: 'running',
  passed: 'passed',
  failed: 'failed',
  generated_no_gold: 'generated · no gold',
  pending_gold: 'pending gold',
  blocked: 'blocked',
  skipped: 'skipped',
};

export function StatusBadge({ state }: { state: string }) {
  const s = state || 'idle';
  return (
    <span className={`vc-badge vc-s-${s}`}>
      <span className="dot" />
      {LABEL[s] || s}
    </span>
  );
}
