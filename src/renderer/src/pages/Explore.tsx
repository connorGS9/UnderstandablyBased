import { useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from 'react';
import { useStore } from '../store';
import { api } from '../api';
import { Guide } from '../components/Guide';
import { FlowCanvas } from '../components/FlowCanvas';
import { CodeView } from '../components/CodeView';
import { Inspector } from '../components/Inspector';
import { roleColor } from '../lib/roles';
import { IconCode, IconFlow, IconHome, IconPanel, IconRoute } from '../components/Icons';

export function Explore() {
  const trail = useStore((s) => s.trail);
  const flowRoot = useStore((s) => s.flowRoot);
  const center = useStore((s) => s.center);
  const code = useStore((s) => s.code);
  const goCrumb = useStore((s) => s.goCrumb);
  const goHome = useStore((s) => s.goHome);
  const showFlow = useStore((s) => s.showFlow);
  const openCode = useStore((s) => s.openCode);
  const [inspector, setInspector] = useState(true);
  const [widths, setWidths] = useState(() => {
    try {
      return { guide: 300, inspector: 340, ...JSON.parse(localStorage.getItem('ub.panelWidths') ?? '{}') };
    } catch {
      return { guide: 300, inspector: 340 };
    }
  });
  const dragging = useRef<null | 'guide' | 'inspector'>(null);

  /** Drag the borders between panels to resize them; widths are remembered. */
  const startDrag = (which: 'guide' | 'inspector') => (e: ReactPointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    dragging.current = which;
    const startX = e.clientX;
    const start = widths[which];
    const move = (ev: PointerEvent) => {
      const dx = ev.clientX - startX;
      const next = Math.round(Math.min(640, Math.max(200, which === 'guide' ? start + dx : start - dx)));
      setWidths((w: typeof widths) => {
        const nw = { ...w, [which]: next };
        try {
          localStorage.setItem('ub.panelWidths', JSON.stringify(nw));
        } catch {
          /* ignore */
        }
        return nw;
      });
    };
    const up = () => {
      dragging.current = null;
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };
  const selected = useStore((s) => s.selected);
  const summary = useStore((s) => s.summary)!;
  const dive = useStore((s) => s.dive);

  /** The Code tab shows the last code you opened, or else the selected box (or the route's handler). */
  const showCode = async () => {
    // Reopen the last code view unless a different box has been selected since.
    if (code && (!selected || selected === code.symbolId || selected === flowRoot)) {
      openCode(code);
      return;
    }
    const entry = summary.entries.find((e) => e.id === (selected ?? flowRoot));
    const target = entry?.handlerId ?? selected ?? flowRoot;
    if (!target) return;
    const d = await api.symbol(target);
    const s = d?.symbol;
    if (s?.file) dive({ id: s.id, label: s.container ? `${s.container}.${s.name}` : s.name, role: s.role ?? 'other', file: s.file, line: s.range.sl });
    else if (entry?.file) openCode({ file: entry.file, line: entry.line }, entry.label, 'route');
  };

  const currentIdx = trail.length - 1;

  return (
    <div className={`explore ${inspector ? '' : 'no-inspector'}`} style={{ '--guide-w': `${widths.guide}px`, '--inspector-w': `${widths.inspector}px` } as CSSProperties}>
      <Guide />
      <section className="center" aria-label="Flow and code" style={{ position: 'relative' }}>
        <div className="resize-handle" style={{ position: 'absolute', left: 0, top: 0, bottom: 0 }} onPointerDown={startDrag('guide')} title="Drag to resize" />
        {inspector && <div className="resize-handle" style={{ position: 'absolute', right: 0, top: 0, bottom: 0 }} onPointerDown={startDrag('inspector')} title="Drag to resize" />}
        <div className="center-bar">
          <button className="icon-btn" onClick={goHome} disabled={!trail.length} title="Back to the starting point (the route or entry you picked)" aria-label="Home">
            <IconHome />
          </button>
          <nav className="crumbs grow" aria-label="Path you followed">
            {trail.length === 0 && <span className="faint">Pick a route or entry point on the left to start.</span>}
            {trail.map((c, i) => (
              <span key={c.id + i} className="row" style={{ gap: 2 }}>
                {i > 0 && <span className="crumb-sep">›</span>}
                <button className={`crumb ${i === currentIdx ? 'current' : ''}`} onClick={() => goCrumb(i)} title={c.label}>
                  <span className="role-dot" style={{ '--rc': roleColor(c.role) } as CSSProperties} />
                  <span className="ellipsis">{c.label}</span>
                </button>
              </span>
            ))}
          </nav>
          {flowRoot && (
            <div className="seg" style={{ flexShrink: 0 }}>
              <button className={center === 'flow' ? 'active' : ''} onClick={showFlow} title="Diagram of calls">
                <IconFlow size={13} /> Flow
              </button>
              <button className={center === 'code' ? 'active' : ''} onClick={showCode} title="Source code of the selected box">
                <IconCode size={13} /> Code
              </button>
            </div>
          )}
          <button className="icon-btn" onClick={() => setInspector((v) => !v)} title={inspector ? 'Hide inspector' : 'Show inspector'} aria-label="Toggle inspector">
            <IconPanel />
          </button>
        </div>
        <div className="center-body">
          {center === 'code' && code ? (
            <CodeView loc={code} />
          ) : flowRoot ? (
            <FlowCanvas rootId={flowRoot} />
          ) : (
            <div className="welcome">
              <div className="welcome-card">
                <IconRoute size={34} />
                <h3>Follow a request through the code</h3>
                <p>
                  Choose an entry point on the left. You will see every function it calls, grouped by layer: controllers, services, data access, and the tables it reads or writes.
                </p>
                <p className="faint" style={{ fontSize: 12 }}>
                  Double-click any box to read its code. Underlined calls in the code are links you can click to keep going. The trail above lets you jump back to any step.
                </p>
              </div>
            </div>
          )}
        </div>
      </section>
      {inspector ? <Inspector /> : <div />}
    </div>
  );
}
