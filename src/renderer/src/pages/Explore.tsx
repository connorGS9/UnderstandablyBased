import { useState, type CSSProperties } from 'react';
import { useStore } from '../store';
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

  const currentIdx = trail.length - 1;

  return (
    <div className={`explore ${inspector ? '' : 'no-inspector'}`}>
      <Guide />
      <section className="center" aria-label="Flow and code">
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
              <button className={center === 'code' ? 'active' : ''} disabled={!code} onClick={() => code && openCode(code)} title="Source code">
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
