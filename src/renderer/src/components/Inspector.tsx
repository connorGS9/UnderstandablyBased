import { useEffect, useState, type CSSProperties } from 'react';
import { api } from '../api';
import { useStore } from '../store';
import type { CallRef, DbTable, EntryPoint, SymbolDetail } from '../../../engine/types';
import { CONFIDENCE, ROLES, roleColor } from '../lib/roles';
import { MethodBadge, RoleChip, RoleDot, shortFile } from './Bits';
import { IconCode, IconExternal, IconFlow } from './Icons';
import { entryRole } from './Guide';
import { loadDiagrams } from '../lib/cache';


function refLabel(r: CallRef['target']) {
  return r.container ? `${r.container}.${r.name}` : r.name;
}

export function Inspector() {
  const selected = useStore((s) => s.selected);
  const summary = useStore((s) => s.summary)!;
  const entry = selected ? summary.entries.find((e) => e.id === selected) : undefined;
  const symbolId = entry ? entry.handlerId : selected;
  const [detail, setDetail] = useState<SymbolDetail | null>(null);
  const [table, setTable] = useState<DbTable | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setDetail(null);
    setTable(null);
    if (!symbolId || symbolId.startsWith('mw:')) return;
    setLoading(true);
    api
      .symbol(symbolId)
      .then((d) => !cancelled && setDetail(d))
      .finally(() => !cancelled && setLoading(false));
    if (symbolId.startsWith('table:')) {
      loadDiagrams().then((d) => {
        if (cancelled) return;
        setTable(d.database.tables.find((t) => `table:${t.name.toLowerCase()}` === symbolId) ?? null);
      });
    }
    return () => {
      cancelled = true;
    };
  }, [symbolId]);

  if (!selected) {
    return (
      <aside className="panel inspector" aria-label="Inspector">
        <div className="insp-section">
          <h4>Inspector</h4>
          <div className="dim">Select a box in the flow to see what it does, what calls it, and what it calls.</div>
        </div>
      </aside>
    );
  }

  return (
    <aside className="panel inspector" aria-label="Inspector">
      <div className="panel-body">
        {entry && <EntryHeader entry={entry} />}
        {selected.startsWith('mw:') && (
          <div className="insp-section">
            <h4>Middleware</h4>
            <div className="insp-title mono">{selected.slice(3).replace(/#\d+$/, '')}</div>
            <p className="dim">This middleware runs before the handler, but its code could not be located statically (it may come from a library or be built at runtime).</p>
          </div>
        )}
        {loading && !detail && (
          <div className="insp-section row dim">
            <span className="spinner" /> Loading…
          </div>
        )}
        {detail && (detail.symbol.role === 'table' || detail.symbol.role === 'external' || detail.symbol.role === 'channel') ? (
          <SinkDetail detail={detail} table={table} />
        ) : (
          detail && <SymbolInfo detail={detail} isHandler={!!entry} />
        )}
      </div>
    </aside>
  );
}

function EntryHeader({ entry }: { entry: EntryPoint }) {
  const role = entryRole(entry);
  return (
    <div className="insp-section" style={{ background: `color-mix(in srgb, ${roleColor(role)} 7%, transparent)` }}>
      <h4>
        {entry.kind === 'http-route' ? 'HTTP route' : ROLES[role].label} · {entry.framework}
      </h4>
      <div className="row" style={{ alignItems: 'flex-start' }}>
        {entry.kind === 'http-route' && <MethodBadge method={entry.method} />}
        <div className="insp-title mono" style={{ fontSize: 14 }}>
          {entry.path ?? entry.label}
        </div>
      </div>
      <p className="dim" style={{ margin: '8px 0 0', fontSize: 12 }}>
        {entry.kind === 'http-route'
          ? `When a client sends ${entry.method === 'ANY' ? 'a request' : `a ${entry.method} request`} to this URL, ${entry.middleware?.length ? 'the middleware below runs first, then ' : ''}${entry.handlerName ?? 'the handler'} takes over.`
          : entry.kind === 'page'
            ? `Visiting this URL renders ${entry.handlerName ?? 'this page component'}.`
            : entry.kind === 'process'
              ? `A separate program starts here at ${entry.handlerName ?? 'main'}.`
              : entry.kind === 'channel'
                ? 'Processes and functions connect through this channel. The flow shows who writes to it and who reads from it.'
                : `The framework calls ${entry.handlerName} for you (${entry.framework}).`}
      </p>
      {!!entry.middleware?.length && (
        <div style={{ marginTop: 10 }}>
          <div className="faint" style={{ fontSize: 11, marginBottom: 4 }}>Runs first:</div>
          <div className="row" style={{ flexWrap: 'wrap', gap: 4 }}>
            {entry.middleware.map((m, i) => (
              <span key={i} className="pill mono" style={{ fontSize: 11 }}>
                {i + 1}. {m.name}
              </span>
            ))}
          </div>
        </div>
      )}
      {entry.notes?.map((n, i) => (
        <div key={i} className="faint" style={{ fontSize: 11.5, marginTop: 6 }}>
          ⚠ {n}
        </div>
      ))}
    </div>
  );
}

function SymbolInfo({ detail, isHandler }: { detail: SymbolDetail; isHandler: boolean }) {
  const { symbol: s } = detail;
  const dive = useStore((st) => st.dive);
  const traceFrom = useStore((st) => st.traceFrom);
  const openEntry = useStore((st) => st.openEntry);
  const summary = useStore((st) => st.summary)!;
  const role = s.role ?? 'other';
  const label = s.container ? `${s.container}.${s.name}` : s.name;
  const goRef = (r: CallRef['target']) => r.file && dive({ id: r.id, label: refLabel(r), role: r.role, file: r.file, line: r.line });

  return (
    <>
      <div className="insp-section">
        <h4>{isHandler ? 'Handled by' : s.kind === 'handler' ? 'Inline function' : s.kind}</h4>
        <div className="insp-title">{s.kind === 'handler' ? 'Inline handler' : label}</div>
        <div className="row" style={{ marginTop: 6, flexWrap: 'wrap' }}>
          <RoleChip role={role} />
          <button className="link mono" style={{ fontSize: 11.5 }} onClick={() => dive({ id: s.id, label, role, file: s.file, line: s.range.sl })} title="Open the code">
            {shortFile(s.file, 3)}:{s.range.sl}
          </button>
        </div>
        <div className="explain" style={{ '--rc': roleColor(role), marginTop: 10 } as CSSProperties}>
          <b style={{ color: 'var(--text)' }}>{ROLES[role].label}.</b> {ROLES[role].explain}
          {s.roleReason && <div className="faint" style={{ marginTop: 4 }}>Why we think so: {s.roleReason}.</div>}
        </div>
        <div className="actions" style={{ marginTop: 10 }}>
          <button className="btn small" onClick={() => dive({ id: s.id, label, role, file: s.file, line: s.range.sl })}>
            <IconCode size={14} /> Read code
          </button>
          <button className="btn small" onClick={() => traceFrom(s.id, label, role)} title="Draw a new flow that starts at this function">
            <IconFlow size={14} /> Trace from here
          </button>
          {api.platform === 'electron' && (
            <button className="btn small ghost" onClick={() => api.openInEditor(s.file, s.range.sl)}>
              <IconExternal size={14} /> Editor
            </button>
          )}
        </div>
      </div>

      <div className="insp-section">
        <h4>Signature</h4>
        <div className="sig">{s.signature}</div>
        {s.annotations.length > 0 && (
          <div className="row" style={{ flexWrap: 'wrap', gap: 4, marginTop: 8 }}>
            {s.annotations.map((a, i) => (
              <span key={i} className="pill mono" style={{ fontSize: 11 }}>
                @{a.name}
              </span>
            ))}
          </div>
        )}
      </div>

      {detail.sinks.length > 0 && (
        <div className="insp-section">
          <h4>Data it touches</h4>
          {detail.sinks.map((sk, i) => (
            <div key={i} className="ref-row" style={{ cursor: 'default' }}>
              <RoleDot role={sk.node.kind === 'table' ? 'table' : sk.node.kind === 'channel' ? 'channel' : 'external'} />
              <span className="name grow ellipsis">{sk.node.label}</span>
              <span className="pill">{sk.kind}</span>
              <span className="faint" style={{ fontSize: 11 }}>
                L{sk.line}
              </span>
            </div>
          ))}
        </div>
      )}

      <RefList title={`Calls (${detail.callees.length})`} refs={detail.callees} onPick={goRef} empty="Calls nothing else in this project (only libraries, if anything)." />
      <RefList title={`Called by (${detail.callers.length})`} refs={detail.callers} onPick={goRef} empty={isHandler ? 'Called by the framework when the route is hit.' : 'No callers found in this project. It may be called by a framework, through reflection, or not at all.'} />

      {detail.usedBy.length > 0 && (
        <div className="insp-section">
          <h4>Reached from ({detail.usedBy.length})</h4>
          {detail.usedBy.slice(0, 12).map((u) => {
            const e = summary.entries.find((x) => x.id === u.id);
            return (
              <button key={u.id} className="ref-row" onClick={() => e && openEntry(e.id, e.label, entryRole(e), e.handlerId)}>
                {e?.kind === 'http-route' ? <MethodBadge method={e.method} /> : <RoleDot role={e ? entryRole(e) : 'entry'} />}
                <span className="name mono ellipsis grow">{e?.path ?? u.label}</span>
              </button>
            );
          })}
          {detail.usedBy.length > 12 && <div className="faint" style={{ fontSize: 11, padding: '4px 6px' }}>…and {detail.usedBy.length - 12} more</div>}
        </div>
      )}
    </>
  );
}

function RefList({ title, refs, onPick, empty }: { title: string; refs: CallRef[]; onPick: (r: CallRef['target']) => void; empty: string }) {
  return (
    <div className="insp-section">
      <h4>{title}</h4>
      {refs.length === 0 ? (
        <div className="faint" style={{ fontSize: 12 }}>
          {empty}
        </div>
      ) : (
        refs.slice(0, 40).map((r, i) => (
          <button key={r.target.id + i} className="ref-row" onClick={() => onPick(r.target)} title={`${CONFIDENCE[r.confidence].label}: ${r.reason}\n${r.target.file ?? ''}:${r.target.line ?? ''}`}>
            <RoleDot role={r.target.role} />
            <span className="name grow ellipsis">{refLabel(r.target)}</span>
            {r.confidence !== 'certain' && <span className={`conf-${r.confidence}`} style={{ fontSize: 11 }}>{r.confidence}</span>}
            <span className="faint" style={{ fontSize: 11 }}>
              L{r.line}
            </span>
          </button>
        ))
      )}
    </div>
  );
}

function SinkDetail({ detail, table }: { detail: SymbolDetail; table: DbTable | null }) {
  const dive = useStore((s) => s.dive);
  const setView = useStore((s) => s.setView);
  const setDiagramTab = useStore((s) => s.setDiagramTab);
  const role = detail.symbol.role ?? 'external';
  return (
    <>
      <div className="insp-section">
        <h4>{ROLES[role].label}</h4>
        <div className="insp-title mono">{detail.symbol.name}</div>
        {detail.symbol.signature && <div className="faint" style={{ marginTop: 4 }}>{detail.symbol.signature}</div>}
        <div className="explain" style={{ '--rc': roleColor(role), marginTop: 10 } as CSSProperties}>
          {ROLES[role].explain}
        </div>
        {role === 'table' && (
          <div className="actions" style={{ marginTop: 10 }}>
            <button className="btn small" onClick={() => (setDiagramTab('database'), setView('diagrams'))}>
              Open database diagram
            </button>
          </div>
        )}
      </div>
      {table && (
        <div className="insp-section">
          <h4>Columns ({table.columns.length})</h4>
          {table.columns.map((c) => (
            <div key={c.name} className="row mono" style={{ fontSize: 11.5, padding: '2px 0' }}>
              <span className={`key-icon ${c.pk ? 'key-pk' : c.fk ? 'key-fk' : c.indexed ? 'key-ix' : ''}`}>{c.pk ? 'PK' : c.fk ? 'FK' : c.indexed ? 'IX' : ''}</span>
              <span className="grow ellipsis">{c.name}</span>
              <span className="faint">{c.type}</span>
            </div>
          ))}
          {table.indexes.filter((i) => !i.primary).length > 0 && (
            <>
              <h4 style={{ marginTop: 12 }}>Indexes</h4>
              {table.indexes
                .filter((i) => !i.primary)
                .map((i) => (
                  <div key={i.name} className="mono" style={{ fontSize: 11.5, padding: '2px 0' }}>
                    {i.unique ? 'UNIQUE ' : ''}
                    {i.name} <span className="faint">({i.columns.join(', ')})</span>
                  </div>
                ))}
            </>
          )}
          {table.source.file && (
            <button className="link mono" style={{ fontSize: 11.5, marginTop: 8 }} onClick={() => dive({ id: table.source.symbolId ?? `${table.source.file}:${table.source.line}`, label: table.name, role: 'table', file: table.source.file, line: table.source.line })}>
              Defined in {shortFile(table.source.file, 3)}:{table.source.line} ({table.source.kind})
            </button>
          )}
        </div>
      )}
      <RefList title={`Used by (${detail.callers.length})`} refs={detail.callers} onPick={(r) => r.file && dive({ id: r.id, label: refLabel(r), role: r.role, file: r.file, line: r.line })} empty="No code found that uses this." />
    </>
  );
}
