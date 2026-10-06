import { useEffect, useState, type DragEvent } from 'react';
import { api } from '../api';
import { useStore } from '../store';
import type { RecentProject } from '../../../shared/api';
import { IconFolder, IconX, IconMoon, IconSun } from '../components/Icons';
import { useTheme } from '../lib/theme';

function timeAgo(t: number): string {
  const s = (Date.now() - t) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return `${Math.floor(s / 86400)} d ago`;
}

export function Landing() {
  const openProject = useStore((s) => s.openProject);
  const error = useStore((s) => s.error);
  const [recent, setRecent] = useState<RecentProject[]>([]);
  const [drag, setDrag] = useState(false);
  const [manualPath, setManualPath] = useState('');
  const [theme, setTheme] = useTheme();

  useEffect(() => {
    api.recent().then(setRecent).catch(() => setRecent([]));
    api.initialFolder().then((f) => {
      if (f) openProject(f);
    });
  }, [openProject]);

  const pick = async () => {
    const p = await api.pickFolder();
    if (p) openProject(p);
  };

  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setDrag(false);
    const f = e.dataTransfer.files?.[0];
    if (f && api.pathForFile) {
      const p = api.pathForFile(f);
      if (p) openProject(p);
    }
  };

  const forget = async (root: string) => {
    await api.forgetRecent(root);
    setRecent((r) => r.filter((x) => x.root !== root));
  };

  return (
    <div className="landing">
      <div className="landing-inner">
        <div className="row" style={{ justifyContent: 'space-between' }}>
          <div className="brand">
            <div className="brand-mark">UB</div>
            <div>
              <div style={{ fontWeight: 700, fontSize: 15 }}>UnderstandablyBased</div>
              <div className="faint" style={{ fontSize: 12 }}>See how any codebase actually works</div>
            </div>
          </div>
          <button className="icon-btn" onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')} title="Toggle theme" aria-label="Toggle theme">
            {theme === 'dark' ? <IconSun /> : <IconMoon />}
          </button>
        </div>

        <h1>Open a codebase to explore it</h1>
        <p className="lede">
          UnderstandablyBased reads the code in a folder and works out what kind of program it is. It finds where requests come in (routes, pages, main
          functions, message channels) and lets you follow each one through every function it calls, down to the database.
        </p>

        <div
          className={`dropzone ${drag ? 'drag' : ''}`}
          onDragOver={(e) => {
            e.preventDefault();
            setDrag(true);
          }}
          onDragLeave={() => setDrag(false)}
          onDrop={onDrop}
        >
          {api.platform === 'electron' ? (
            <div className="row" style={{ gap: 14, flexWrap: 'wrap' }}>
              <button className="btn primary" onClick={pick} autoFocus>
                <IconFolder size={18} /> Choose folder…
              </button>
              <span className="dim">or drag a project folder here</span>
            </div>
          ) : (
            <form
              className="row"
              onSubmit={(e) => {
                e.preventDefault();
                if (manualPath.trim()) openProject(manualPath.trim());
              }}
            >
              <input className="input grow" style={{ height: 40 }} placeholder="Absolute path to a project folder, e.g. /home/me/code/my-app" value={manualPath} onChange={(e) => setManualPath(e.target.value)} autoFocus />
              <button className="btn primary" type="submit">
                <IconFolder size={18} /> Open
              </button>
            </form>
          )}
          <div className="row faint" style={{ fontSize: 12, gap: 6 }}>
            <span className="pill" title="Coming soon">
              Clone from a Git URL · coming soon
            </span>
            <span>Everything runs locally. Your code never leaves this machine.</span>
          </div>
        </div>

        {error && (
          <div className="error-banner" style={{ marginTop: 14 }}>
            Could not open that folder: {error}
          </div>
        )}

        {recent.length > 0 && (
          <>
            <div className="section-title">Recent</div>
            <div className="recent-list">
              {recent.map((r) => (
                <div key={r.root} className="row" style={{ gap: 0 }}>
                  <button className="recent-item" onClick={() => openProject(r.root)}>
                    <span className="recent-icon">
                      <IconFolder />
                    </span>
                    <span className="grow col">
                      <span style={{ fontWeight: 600 }}>{r.name}</span>
                      <span className="faint mono ellipsis">{r.root}</span>
                    </span>
                    <span className="col" style={{ alignItems: 'flex-end' }}>
                      <span className="dim" style={{ fontSize: 12 }}>{r.summary}</span>
                      <span className="faint" style={{ fontSize: 11 }}>{timeAgo(r.openedAt)}</span>
                    </span>
                  </button>
                  <button className="icon-btn" title="Remove from recent" aria-label={`Remove ${r.name} from recent`} onClick={() => forget(r.root)}>
                    <IconX size={14} />
                  </button>
                </div>
              ))}
            </div>
          </>
        )}

        <div className="section-title">What you get</div>
        <div className="feature-grid">
          <div className="feature">
            <b>Entry points, found for you</b>
            <span className="dim">HTTP routes (Spring, Express, FastAPI, Django, Gin, ASP.NET…), pages, main() functions, jobs and IPC channels.</span>
          </div>
          <div className="feature">
            <b>Follow the flow</b>
            <span className="dim">Click a route to see every function it calls, layer by layer. Click any step to read its code.</span>
          </div>
          <div className="feature">
            <b>Diagrams</b>
            <span className="dim">Data-flow architecture, database tables with keys and indexes, and a map of every route.</span>
          </div>
        </div>
      </div>
    </div>
  );
}
