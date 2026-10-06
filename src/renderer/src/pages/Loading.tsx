import { useEffect, useState } from 'react';
import { api } from '../api';
import { useStore } from '../store';
import type { Progress } from '../../../engine/types';

const PHASES: { key: Progress['phase']; label: string }[] = [
  { key: 'scan', label: 'Find files' },
  { key: 'parse', label: 'Read code' },
  { key: 'resolve', label: 'Link calls' },
  { key: 'analyze', label: 'Find entry points' },
];

export function Loading() {
  const initial = useStore((s) => s.progress);
  const [p, setP] = useState<Progress | undefined>(initial);
  useEffect(() => api.onProgress(setP), []);
  const idx = PHASES.findIndex((x) => x.key === p?.phase);
  const pct = p && p.total > 0 ? Math.round((100 * p.done) / p.total) : undefined;
  return (
    <div className="loading">
      <div className="loading-card" role="status" aria-live="polite">
        <div style={{ fontWeight: 700, fontSize: 16 }}>Reading the codebase…</div>
        <div className="progress-track">
          <div className={`progress-bar ${pct === undefined ? 'indeterminate' : ''}`} style={{ width: `${pct ?? 0}%` }} />
        </div>
        <div className="dim mono ellipsis" style={{ fontSize: 12 }}>
          {p?.message ?? 'Starting…'}
          {pct !== undefined && p?.phase === 'parse' ? ` (${p.done}/${p.total})` : ''}
        </div>
        <div className="phase-list">
          {PHASES.map((ph, i) => (
            <span key={ph.key} className="pill" style={i < idx ? { color: 'var(--ok)' } : i === idx ? { color: 'var(--text)', borderColor: 'var(--accent)' } : undefined}>
              {i < idx ? '✓ ' : ''}
              {ph.label}
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}
