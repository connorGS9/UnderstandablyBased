import { useEffect } from 'react';
import { useStore, type View } from '../store';
import { Overview } from './Overview';
import { Explore } from './Explore';
import { Diagrams } from './Diagrams';
import { CommandPalette } from '../components/CommandPalette';
import { SettingsDialog } from '../components/SettingsDialog';
import { api } from '../api';
import { IconBack, IconForward, IconGear, IconMoon, IconRefresh, IconSearch, IconSun, IconX } from '../components/Icons';
import { useTheme } from '../lib/theme';

const TABS: { key: View; label: string; hint: string }[] = [
  { key: 'overview', label: 'Overview', hint: 'What kind of program this is and where to start' },
  { key: 'explore', label: 'Explore', hint: 'Pick a route or entry point and follow the code' },
  { key: 'diagrams', label: 'Diagrams', hint: 'Data flow, database tables and route maps' },
];

const isMac = navigator.platform.toLowerCase().includes('mac');

export function Workspace() {
  const s = useStore();
  const [theme, setTheme] = useTheme();
  const summary = s.summary!;

  // Auto-refresh: the engine re-indexes when files change and pushes the new analysis here.
  useEffect(
    () =>
      api.onEvent((e) => {
        if (e.type === 'updating') useStore.setState({ updating: true });
        else if (e.type === 'updated') useStore.getState().applySummary(e.summary);
        else useStore.setState({ updating: false, updateError: e.error });
      }),
    [],
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = isMac ? e.metaKey : e.ctrlKey;
      if (mod && (e.key === 'k' || e.key === 'p')) {
        e.preventDefault();
        useStore.getState().setPalette(true);
      } else if (e.altKey && e.key === 'ArrowLeft') {
        e.preventDefault();
        useStore.getState().back();
      } else if (e.altKey && e.key === 'ArrowRight') {
        e.preventDefault();
        useStore.getState().forward();
      } else if (mod && /^[123]$/.test(e.key)) {
        e.preventDefault();
        useStore.getState().setView(TABS[Number(e.key) - 1].key);
      }
    };
    // Mouse back/forward buttons, like a browser.
    const onMouse = (e: MouseEvent) => {
      if (e.button === 3) useStore.getState().back();
      if (e.button === 4) useStore.getState().forward();
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('mouseup', onMouse);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('mouseup', onMouse);
    };
  }, []);

  return (
    <div className="workspace">
      <header className="topbar">
        <div className="project">
          <div className="brand-mark">UB</div>
          <div className="col" style={{ minWidth: 0 }}>
            <span className="ellipsis" style={{ fontWeight: 700 }}>{summary.name}</span>
            <span className="faint mono ellipsis" style={{ fontSize: 10.5 }} title={summary.root}>
              {summary.root}
            </span>
          </div>
        </div>
        <div className="row" style={{ gap: 2 }}>
          <button className="icon-btn" onClick={s.back} disabled={s.histIndex <= 0} title="Back (Alt+←)" aria-label="Back">
            <IconBack />
          </button>
          <button className="icon-btn" onClick={s.forward} disabled={s.histIndex >= s.history.length - 1} title="Forward (Alt+→)" aria-label="Forward">
            <IconForward />
          </button>
        </div>
        <nav className="tabs" aria-label="Views">
          {TABS.map((t, i) => (
            <button key={t.key} className={`tab ${s.view === t.key ? 'active' : ''}`} onClick={() => s.setView(t.key)} title={`${t.hint} (${isMac ? '⌘' : 'Ctrl'}+${i + 1})`}>
              {t.label}
            </button>
          ))}
        </nav>
        <div className="grow" />
        {s.updating && (
          <span className="updating-pill" role="status">
            <span className="spinner" /> Updating…
          </span>
        )}
        {s.updateError && !s.updating && (
          <span className="updating-pill" style={{ color: 'var(--danger)' }} title={s.updateError}>
            Update failed
          </span>
        )}
        <button className="search-trigger" onClick={() => s.setPalette(true)}>
          <IconSearch size={14} />
          <span className="grow" style={{ textAlign: 'left' }}>Search routes, code, tables…</span>
          <span className="kbd">{isMac ? '⌘K' : 'Ctrl K'}</span>
        </button>
        <button className="icon-btn" onClick={s.reindex} disabled={s.updating} title="Re-analyze the project (only changed files are re-read)" aria-label="Re-analyze">
          <IconRefresh />
        </button>
        <button className="icon-btn" onClick={() => s.setSettingsOpen(true)} title="Project settings: ignored folders, tests, role corrections, pinned entry points" aria-label="Project settings">
          <IconGear />
        </button>
        <button className="icon-btn" onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')} title="Toggle light/dark" aria-label="Toggle theme">
          {theme === 'dark' ? <IconSun /> : <IconMoon />}
        </button>
        <button className="icon-btn" onClick={s.closeProject} title="Close project" aria-label="Close project">
          <IconX />
        </button>
      </header>
      <main className="main-area">
        {s.view === 'overview' && <Overview />}
        {s.view === 'explore' && <Explore />}
        {s.view === 'diagrams' && <Diagrams />}
      </main>
      {s.paletteOpen && <CommandPalette />}
      {s.settingsOpen && <SettingsDialog />}
    </div>
  );
}
