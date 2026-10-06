import { useState } from 'react';
import { useStore } from '../store';
import type { ProjectKind, ProjectSettings, Role } from '../../../engine/types';
import { ROLES } from '../lib/roles';
import { IconX } from './Icons';

const KINDS: { kind: ProjectKind; label: string }[] = [
  { kind: 'web-backend', label: 'Web backend / API' },
  { kind: 'web-frontend', label: 'Web frontend' },
  { kind: 'fullstack-web', label: 'Full-stack web app' },
  { kind: 'low-latency', label: 'Low-latency / systems (IPC)' },
  { kind: 'game', label: 'Game' },
  { kind: 'cli', label: 'Command-line tool' },
  { kind: 'desktop', label: 'Desktop app' },
  { kind: 'library', label: 'Library' },
  { kind: 'generic', label: 'General program' },
];

const EDITABLE_ROLES: Role[] = ['controller', 'service', 'repository', 'model', 'middleware', 'client', 'view', 'entry', 'util', 'config', 'test', 'other'];

/** Per-project settings: what to analyze, and corrections when the automatic analysis gets something wrong. */
export function SettingsDialog() {
  const summary = useStore((s) => s.summary)!;
  const close = () => useStore.getState().setSettingsOpen(false);
  const saveSettings = useStore((s) => s.saveSettings);
  const updating = useStore((s) => s.updating);
  const [draft, setDraft] = useState<ProjectSettings>(() => structuredClone(summary.settings));
  const [exclude, setExclude] = useState(draft.exclude.join('\n'));

  const save = async () => {
    const settings = { ...draft, exclude: exclude.split('\n').map((l) => l.trim()).filter(Boolean) };
    await saveSettings(settings);
    close();
  };

  const repoJson = JSON.stringify({ ...draft, exclude: exclude.split('\n').map((l) => l.trim()).filter(Boolean) }, null, 2);

  return (
    <div className="palette-backdrop" onMouseDown={close}>
      <div className="dialog" onMouseDown={(e) => e.stopPropagation()} role="dialog" aria-label="Project settings">
        <div className="dialog-head">
          <div>
            <div style={{ fontWeight: 700, fontSize: 15 }}>Project settings</div>
            <div className="faint mono" style={{ fontSize: 11 }}>{summary.root}</div>
          </div>
          <button className="icon-btn" onClick={close} aria-label="Close">
            <IconX />
          </button>
        </div>
        <div className="dialog-body">
          <section className="setting">
            <label className="setting-label" htmlFor="kind">What kind of program is this?</label>
            <p className="setting-help">Detected: {summary.profile.kinds.find((k) => !k.evidence.some((e) => e.text.startsWith('Set by you')))?.label ?? 'unknown'}. Override it if the guess is wrong.</p>
            <select id="kind" className="select" value={draft.projectKind ?? ''} onChange={(e) => setDraft({ ...draft, projectKind: (e.target.value || undefined) as ProjectKind | undefined })}>
              <option value="">Detect automatically</option>
              {KINDS.map((k) => (
                <option key={k.kind} value={k.kind}>
                  {k.label}
                </option>
              ))}
            </select>
          </section>

          <section className="setting">
            <label className="setting-label" htmlFor="exclude">Folders and files to ignore</label>
            <p className="setting-help">One pattern per line, like a .gitignore: <span className="mono">legacy/</span>, <span className="mono">**/generated/**</span>, <span className="mono">*.pb.go</span>. Dependencies, build output and .gitignored files are already skipped.</p>
            <textarea id="exclude" className="textarea mono" rows={4} value={exclude} onChange={(e) => setExclude(e.target.value)} placeholder="legacy/&#10;scripts/" />
          </section>

          <section className="setting">
            <span className="setting-label">Tests</span>
            <div className="seg" style={{ width: 'fit-content' }}>
              {(['auto', 'include', 'exclude'] as const).map((t) => (
                <button key={t} className={draft.tests === t ? 'active' : ''} onClick={() => setDraft({ ...draft, tests: t })}>
                  {t === 'auto' ? 'Automatic' : t === 'include' ? 'Always include' : 'Skip tests'}
                </button>
              ))}
            </div>
            <p className="setting-help">Automatic includes tests, except in very large projects where they are skipped for speed.</p>
          </section>

          <section className="setting">
            <span className="setting-label">Role corrections</span>
            <p className="setting-help">
              Force the role of code that was classified wrongly. Match a class or function name (<span className="mono">OrderService</span>), one method (<span className="mono">OrderService.place</span>) or a path pattern (<span className="mono">src/legacy/**</span>). You can also do this from the Inspector.
            </p>
            {draft.roleOverrides.map((o, i) => (
              <div key={i} className="row" style={{ marginBottom: 6 }}>
                <input
                  className="input grow mono"
                  value={o.match}
                  onChange={(e) => {
                    const roleOverrides = [...draft.roleOverrides];
                    roleOverrides[i] = { ...o, match: e.target.value };
                    setDraft({ ...draft, roleOverrides });
                  }}
                />
                <select
                  className="select"
                  value={o.role}
                  onChange={(e) => {
                    const roleOverrides = [...draft.roleOverrides];
                    roleOverrides[i] = { ...o, role: e.target.value as Role };
                    setDraft({ ...draft, roleOverrides });
                  }}
                >
                  {EDITABLE_ROLES.map((r) => (
                    <option key={r} value={r}>
                      {ROLES[r].label}
                    </option>
                  ))}
                </select>
                <button className="icon-btn" aria-label="Remove" onClick={() => setDraft({ ...draft, roleOverrides: draft.roleOverrides.filter((_, j) => j !== i) })}>
                  <IconX size={14} />
                </button>
              </div>
            ))}
            <button className="btn small" onClick={() => setDraft({ ...draft, roleOverrides: [...draft.roleOverrides, { match: '', role: 'service' }] })}>
              Add correction
            </button>
          </section>

          <section className="setting">
            <span className="setting-label">Pinned entry points</span>
            <p className="setting-help">
              Extra starting points the analyzer did not find: <span className="mono">Class.method</span>, <span className="mono">function</span>, or <span className="mono">path/file.ext#name</span>.
            </p>
            {draft.entryPoints.map((ep, i) => (
              <div key={i} className="row" style={{ marginBottom: 6 }}>
                <input
                  className="input grow mono"
                  value={ep.symbol}
                  onChange={(e) => {
                    const entryPoints = [...draft.entryPoints];
                    entryPoints[i] = { ...ep, symbol: e.target.value };
                    setDraft({ ...draft, entryPoints });
                  }}
                />
                <button className="icon-btn" aria-label="Remove" onClick={() => setDraft({ ...draft, entryPoints: draft.entryPoints.filter((_, j) => j !== i) })}>
                  <IconX size={14} />
                </button>
              </div>
            ))}
            <button className="btn small" onClick={() => setDraft({ ...draft, entryPoints: [...draft.entryPoints, { symbol: '' }] })}>
              Add entry point
            </button>
          </section>

          <section className="setting">
            <label className="toggle">
              <input type="checkbox" checked={draft.autoRefresh} onChange={(e) => setDraft({ ...draft, autoRefresh: e.target.checked })} />
              Refresh automatically when files change
            </label>
          </section>

          <details className="setting">
            <summary className="setting-label" style={{ cursor: 'pointer' }}>
              Share these settings with your team
            </summary>
            <p className="setting-help">
              Save this as <span className="mono">understandably.json</span> in the project root and commit it. Everyone who opens the project starts with these settings; their own changes still take priority.
              {summary.repoSettingsFile && ' This project already has one, and it was loaded.'}
            </p>
            <textarea className="textarea mono" rows={6} readOnly value={repoJson} onFocus={(e) => e.currentTarget.select()} />
          </details>
        </div>
        <div className="dialog-foot">
          <button className="btn" onClick={close}>
            Cancel
          </button>
          <button className="btn primary" onClick={save} disabled={updating}>
            {updating ? 'Re-analyzing…' : 'Save and re-analyze'}
          </button>
        </div>
      </div>
    </div>
  );
}
