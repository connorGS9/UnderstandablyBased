import type { CSSProperties, ReactNode } from 'react';
import { useStore } from '../store';
import { MethodBadge, RoleDot } from '../components/Bits';
import { ROLES, roleColor } from '../lib/roles';
import { KIND_GUIDE } from '../lib/kinds';
import { useHint } from '../lib/hints';
import type { EntryPoint, Role } from '../../../engine/types';
import { IconBolt, IconDatabase, IconFlow, IconLayers, IconRoute } from '../components/Icons';

const LANG_COLORS = ['var(--role-controller)', 'var(--role-service)', 'var(--role-repository)', 'var(--role-route)', 'var(--role-model)', 'var(--role-table)', 'var(--role-external)'];


export function Overview() {
  const summary = useStore((s) => s.summary)!;
  const openEntry = useStore((s) => s.openEntry);
  const traceFrom = useStore((s) => s.traceFrom);
  const setView = useStore((s) => s.setView);
  const setDiagramTab = useStore((s) => s.setDiagramTab);
  const { profile, stats, entries } = summary;
  const top = profile.kinds[0];
  const totalLines = profile.languages.reduce((a, l) => a + l.lines, 0) || 1;
  const routes = entries.filter((e) => e.kind === 'http-route');
  const pages = entries.filter((e) => e.kind === 'page');
  const processes = entries.filter((e) => e.kind === 'process');
  const channels = entries.filter((e) => e.kind === 'channel');
  const jobs = entries.filter((e) => e.kind === 'job');
  const routesWithCallers = summary.entries.filter((e) => e.clientCallers?.length).length;
  const pct = Math.round((100 * stats.resolvedCalls) / Math.max(1, stats.calls));

  // Greet every newly opened codebase with what it is and where to start.
  useHint(
    'project-intro',
    true,
    {
      title: `Welcome to ${summary.name}`,
      body: `${top ? `This looks like a ${top.label.toLowerCase()}. ` : ''}${KIND_GUIDE[top?.kind ?? 'generic'] ?? KIND_GUIDE.generic}`,
      target: '[data-hint="start-here"]',
    },
    `project:${summary.root}`,
  );

  // Most central first: key entry points, never members of a family of look-alikes.
  const best = (list: EntryPoint[]) => [...list].filter((e) => e.insight?.tier !== 'routine').sort((a, b) => (b.insight?.score ?? 0) - (a.insight?.score ?? 0));
  const startHere: EntryPoint[] = [...best(processes).slice(0, 2), ...best(routes.filter((r) => r.handlerId)).slice(0, 6), ...best(pages).slice(0, 3), ...channels.slice(0, 3), ...best(jobs).slice(0, 2)].slice(0, 10);
  const families = summary.families ?? [];
  const backbone = summary.backbone ?? [];
  const keyCount = entries.filter((e) => e.insight?.tier === 'key').length;

  const entryRole = (e: EntryPoint): Role => (e.kind === 'http-route' ? 'route' : e.kind === 'page' ? 'page' : e.kind === 'channel' ? 'channel' : 'entry');

  return (
    <div className="overview">
      <div className="overview-inner">
        <div className="row" style={{ justifyContent: 'space-between', alignItems: 'flex-end', marginBottom: 18 }}>
          <div>
            <div className="faint" style={{ fontSize: 12, marginBottom: 2 }}>Project overview</div>
            <h2>{summary.name}</h2>
          </div>
          <div className="faint" style={{ fontSize: 12 }}>
            Indexed {stats.files.toLocaleString()} files in {(summary.durationMs / 1000).toFixed(1)}s
          </div>
        </div>

        <div className="cards" style={{ gridTemplateColumns: 'minmax(0, 1.4fr) minmax(0, 1fr)' }}>
          <section className="card">
            <h3>What kind of program is this?</h3>
            {top ? (
              <div className="kind-hero">
                <div className="grow">
                  <div className="kind-title">{top.label}</div>
                  <ul className="evidence">
                    {top.evidence.map((ev, i) => (
                      <li key={i}>
                        <span>
                          {ev.text}
                          {ev.file && <span className="faint mono"> · {ev.file}{ev.line ? `:${ev.line}` : ''}</span>}
                        </span>
                      </li>
                    ))}
                  </ul>
                  {profile.kinds.length > 1 && (
                    <div className="row" style={{ marginTop: 12, flexWrap: 'wrap', gap: 6 }}>
                      <span className="faint" style={{ fontSize: 12 }}>Also looks like:</span>
                      {profile.kinds.slice(1, 4).map((k) => (
                        <span key={k.kind} className="pill" title={k.evidence.map((e) => e.text).join('\n')}>
                          {k.label}
                        </span>
                      ))}
                    </div>
                  )}
                  <p className="dim" style={{ marginBottom: 0 }}>{KIND_GUIDE[top.kind] ?? KIND_GUIDE.generic}</p>
                </div>
              </div>
            ) : (
              <div className="dim">Not enough signals to classify this project.</div>
            )}
            {profile.frameworks.length > 0 && (
              <>
                <h3 style={{ marginTop: 16 }}>Frameworks & libraries detected</h3>
                <div className="row" style={{ flexWrap: 'wrap', gap: 6 }}>
                  {profile.frameworks.map((f) => (
                    <span key={f.name} className="pill" title={f.evidence.map((e) => e.text).join('\n')}>
                      {f.name}
                      <span className="faint">· {f.category.replace('-', ' ')}</span>
                    </span>
                  ))}
                </div>
              </>
            )}
          </section>

          <section className="card" data-hint="start-here">
            <h3>Start here</h3>
            {startHere.length ? (
              <div className="start-list">
                {startHere.map((e) => (
                  <button key={e.id} className="start-item" onClick={() => openEntry(e.id, e.label, entryRole(e), e.handlerId)}>
                    {e.kind === 'http-route' ? <MethodBadge method={e.method} /> : <RoleDot role={entryRole(e)} />}
                    <span className="grow col" style={{ minWidth: 0 }}>
                      <span className="mono ellipsis">{e.kind === 'http-route' ? e.path : e.label}</span>
                      <span className="faint ellipsis" style={{ fontSize: 11 }}>
                        {e.insight?.tier === 'key' ? e.insight.reasons.slice(0, 2).join(' · ') : e.insight?.gist ?? e.handlerName ?? e.framework}
                      </span>
                    </span>
                  </button>
                ))}
              </div>
            ) : (
              <div className="dim">No entry points found. Use search (Ctrl+K) to jump to any class or function.</div>
            )}
            <div className="row" style={{ marginTop: 10, gap: 6 }}>
              <button className="btn small" onClick={() => setView('explore')}>
                <IconFlow size={14} /> Explore all
              </button>
            </div>
          </section>
        </div>

        {(families.length > 0 || backbone.length > 0) && (
          <section className="card" style={{ marginTop: 12 }}>
            <h3>The shape of it</h3>
            <p className="dim" style={{ marginTop: 0, fontSize: 12.5 }}>
              {keyCount > 0 && <>{keyCount} entry points stand out as key; they are listed first in Explore. </>}
              {families.length > 0 && (
                <>
                  {families.reduce((n, f) => n + f.members.length, 0)} more follow a handful of repeated patterns. Learn one member of a family and you know the rest; each still has its own one-line summary in Explore.
                </>
              )}
            </p>
            <div className="cards" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', marginTop: 0 }}>
              {families.length > 0 && (
                <div>
                  <div className="faint" style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', marginBottom: 6 }}>Repeated patterns</div>
                  <div className="col" style={{ gap: 4 }}>
                    {families.slice(0, 8).map((f) => (
                      <button key={f.id} className="start-item" title={f.explain} onClick={() => f.shared[0] && traceFrom(f.shared[0].id, f.shared[0].name, 'service')}>
                        <span className="pill">{f.members.length}</span>
                        <span className="grow mono ellipsis" style={{ fontSize: 12 }}>{f.label}</span>
                      </button>
                    ))}
                  </div>
                </div>
              )}
              {backbone.length > 0 && (
                <div>
                  <div className="faint" style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', marginBottom: 6 }} title="Code that most entry points pass through. Changing it affects nearly everything.">
                    Code most requests pass through
                  </div>
                  <div className="col" style={{ gap: 4 }}>
                    {backbone.slice(0, 6).map((b) => (
                      <button key={b.kind + b.id} className="start-item" onClick={() => traceFrom(b.id, b.name, b.role)}>
                        <RoleDot role={b.role} />
                        <span className="grow mono ellipsis" style={{ fontSize: 12 }}>{b.name}</span>
                        <span className="faint" style={{ fontSize: 11 }}>{Math.round(b.share * 100)}% of {b.kind === 'http-route' ? 'routes' : `${b.kind}s`}</span>
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </section>
        )}

        <div className="cards" style={{ marginTop: 12 }}>
          <section className="card">
            <h3>At a glance</h3>
            <div className="stat-row">
              {(routes.length > 0 || !processes.length) && <Stat n={routes.length} label="HTTP routes" icon={<IconRoute size={14} />} />}
              {pages.length > 0 && <Stat n={pages.length} label="UI pages" />}
              {processes.length > 0 && <Stat n={processes.length} label="processes" />}
              {channels.length > 0 && <Stat n={channels.length} label="IPC / topics" icon={<IconBolt size={14} />} />}
              {jobs.length > 0 && <Stat n={jobs.length} label="jobs & listeners" />}
              {stats.tables > 0 && <Stat n={stats.tables} label="database tables" icon={<IconDatabase size={14} />} />}
              <Stat n={stats.symbols} label="functions & classes" />
              <Stat n={stats.lines} label="lines of code" />
            </div>
            <div className="faint" style={{ fontSize: 12, marginTop: 12 }} title="Calls into libraries and the standard library are not linked; this counts links between functions in this project.">
              {stats.resolvedCalls.toLocaleString()} of {stats.calls.toLocaleString()} calls ({pct}%) linked to code in this project. The rest go into libraries.
            </div>
            {!!stats.linkedHttpCalls && (
              <div className="faint" style={{ fontSize: 12, marginTop: 6 }} title="Requests whose URL and method match a route defined in this project, so flows continue from the frontend into the backend.">
                <span style={{ color: 'var(--role-route)' }}>⇢</span> {stats.linkedHttpCalls.toLocaleString()} HTTP {stats.linkedHttpCalls === 1 ? 'request' : 'requests'} from the frontend (or other services) linked to {routesWithCallers} {routesWithCallers === 1 ? 'route' : 'routes'} in this project.
              </div>
            )}
          </section>

          <section className="card">
            <h3>Languages</h3>
            <div className="lang-bar">
              {profile.languages.map((l, i) => (
                <div key={l.lang} style={{ width: `${(100 * l.lines) / totalLines}%`, background: LANG_COLORS[i % LANG_COLORS.length] }} title={`${l.lang}: ${l.lines.toLocaleString()} lines`} />
              ))}
            </div>
            <div className="col" style={{ gap: 4 }}>
              {profile.languages.slice(0, 6).map((l, i) => (
                <div key={l.lang} className="row" style={{ fontSize: 12 }}>
                  <span className="role-dot" style={{ '--rc': LANG_COLORS[i % LANG_COLORS.length] } as CSSProperties} />
                  <span className="grow">{l.lang}</span>
                  <span className="faint">{l.files} files</span>
                  <span className="dim" style={{ width: 70, textAlign: 'right' }}>
                    {l.lines.toLocaleString()} lines
                  </span>
                </div>
              ))}
            </div>
          </section>

          <section className="card">
            <h3>Diagrams</h3>
            <div className="col" style={{ gap: 6 }}>
              <button className="start-item" onClick={() => (setDiagramTab('dataflow'), setView('diagrams'))}>
                <IconFlow /> <span className="grow">Data flow: how the layers talk to each other</span>
              </button>
              {stats.tables > 0 && (
                <button className="start-item" onClick={() => (setDiagramTab('database'), setView('diagrams'))}>
                  <IconDatabase /> <span className="grow">Database: {stats.tables} tables with keys and indexes</span>
                </button>
              )}
              {routes.length + pages.length > 0 && (
                <button className="start-item" onClick={() => (setDiagramTab('routes'), setView('diagrams'))}>
                  <IconRoute /> <span className="grow">Route map: every URL the app answers</span>
                </button>
              )}
              <button className="start-item" onClick={() => (setDiagramTab('modules'), setView('diagrams'))}>
                <IconLayers /> <span className="grow">Modules: which folders depend on which</span>
              </button>
            </div>
          </section>
        </div>

        <section className="card" style={{ marginTop: 12 }}>
          <h3>How to read the map</h3>
          <p className="dim" style={{ marginTop: 0 }}>
            Every piece of code gets a color for the job it does. Most applications, whatever the language, pass a request through the same few layers:
          </p>
          <div className="legend-grid">
            {(['route', 'middleware', 'controller', 'service', 'repository', 'model', 'table', 'external', 'channel', 'view', 'entry', 'client'] as Role[]).map((r) => (
              <div key={r} className="legend-item">
                <span className="role-dot" style={{ '--rc': roleColor(r) } as CSSProperties} />
                <div>
                  <b>{ROLES[r].label}</b>
                  <div className="dim" style={{ fontSize: 12 }}>{ROLES[r].explain}</div>
                </div>
              </div>
            ))}
          </div>
        </section>

        {summary.warnings.length > 0 && (
          <section className="card" style={{ marginTop: 12 }}>
            <h3>Notes</h3>
            {summary.warnings.slice(0, 8).map((w, i) => (
              <div key={i} className="dim" style={{ fontSize: 12 }}>
                {w}
              </div>
            ))}
          </section>
        )}
      </div>
    </div>
  );
}

function Stat({ n, label, icon }: { n: number; label: string; icon?: ReactNode }) {
  return (
    <div className="stat">
      <div className="num">{n.toLocaleString()}</div>
      <div className="lbl row" style={{ gap: 4 }}>
        {icon}
        {label}
      </div>
    </div>
  );
}
