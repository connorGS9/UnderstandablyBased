import { useEffect, useRef, useState } from 'react';
import { api } from '../api';
import { useStore } from '../store';
import type { SearchHit } from '../../../engine/types';
import { RoleDot } from './Bits';
import { entryRole } from './Guide';

export function CommandPalette() {
  const setPalette = useStore((s) => s.setPalette);
  const summary = useStore((s) => s.summary)!;
  const openEntry = useStore((s) => s.openEntry);
  const dive = useStore((s) => s.dive);
  const traceFrom = useStore((s) => s.traceFrom);
  const openCode = useStore((s) => s.openCode);
  const setView = useStore((s) => s.setView);
  const setDiagramTab = useStore((s) => s.setDiagramTab);
  const [q, setQ] = useState('');
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [active, setActive] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!q.trim()) {
      setHits([]);
      return;
    }
    const t = setTimeout(() => {
      api.search(q).then((h) => {
        setHits(h);
        setActive(0);
      });
    }, 90);
    return () => clearTimeout(t);
  }, [q]);

  useEffect(() => {
    listRef.current?.querySelector('.palette-item.active')?.scrollIntoView({ block: 'nearest' });
  }, [active]);

  const choose = (h: SearchHit, alt: boolean) => {
    setPalette(false);
    if (h.type === 'entry') {
      const e = summary.entries.find((x) => x.id === h.id);
      if (e) openEntry(e.id, e.label, entryRole(e), e.handlerId);
    } else if (h.type === 'symbol') {
      const [file, line] = h.detail.split(' · ')[1]?.split(':') ?? [];
      if (alt) traceFrom(h.id, h.label, h.role ?? 'other');
      else dive({ id: h.id, label: h.label, role: h.role ?? 'other', file, line: Number(line) });
    } else if (h.type === 'file') {
      openCode({ file: h.id }, h.label, 'other');
    } else if (h.type === 'table') {
      setDiagramTab('database');
      setView('diagrams');
    }
  };

  return (
    <div className="palette-backdrop" onMouseDown={() => setPalette(false)}>
      <div className="palette" onMouseDown={(e) => e.stopPropagation()} role="dialog" aria-label="Search">
        <input
          autoFocus
          placeholder="Search routes, functions, classes, files, tables…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') setPalette(false);
            else if (e.key === 'ArrowDown') {
              e.preventDefault();
              setActive((a) => Math.min(hits.length - 1, a + 1));
            } else if (e.key === 'ArrowUp') {
              e.preventDefault();
              setActive((a) => Math.max(0, a - 1));
            } else if (e.key === 'Enter' && hits[active]) choose(hits[active], e.shiftKey);
          }}
        />
        <div className="palette-list" ref={listRef}>
          {!q && <div className="faint" style={{ padding: 12 }}>Type to search. Enter opens the code; Shift+Enter draws the flow from a function.</div>}
          {q && hits.length === 0 && <div className="faint" style={{ padding: 12 }}>No matches.</div>}
          {hits.map((h, i) => (
            <button key={h.type + h.id} className={`palette-item ${i === active ? 'active' : ''}`} onMouseEnter={() => setActive(i)} onClick={(e) => choose(h, e.shiftKey)}>
              <span className="palette-type">{h.type}</span>
              <RoleDot role={h.role} />
              <span className="grow col" style={{ minWidth: 0 }}>
                <span className="ellipsis" style={{ fontWeight: 500 }}>{h.label}</span>
                <span className="faint mono ellipsis" style={{ fontSize: 11 }}>
                  {h.detail}
                </span>
              </span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
