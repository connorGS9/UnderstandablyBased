import { memo, useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import {
  ReactFlow,
  ReactFlowProvider,
  Background,
  Controls,
  MiniMap,
  Handle,
  Position,
  MarkerType,
  useReactFlow,
  type Edge,
  type Node,
  type NodeProps,
} from '@xyflow/react';
import { useStore, type DiagramTab } from '../store';
import type { DbTable, DiagramEdge, DiagramNode, Diagrams as DiagramData, RouteTreeNode, Role } from '../../../engine/types';
import { loadDiagrams } from '../lib/cache';
import { useMeasuredLayout } from '../lib/layout';
import { DiagramToolbar, routeData, routedEdgeTypes, useDiagramFocus, useEscapeToClear } from '../lib/diagramKit';
import { useHint } from '../lib/hints';
import { ROLES, ROLE_RANK, roleColor } from '../lib/roles';
import { MethodBadge, RoleDot, shortFile } from '../components/Bits';
import { entryRole } from '../components/Guide';
import { IconDatabase, IconFlow, IconLayers, IconRoute } from '../components/Icons';

const TABS: { key: DiagramTab; label: string; icon: ReactNode; help: string }[] = [
  { key: 'dataflow', label: 'Data flow', icon: <IconFlow size={14} />, help: 'How requests move through the layers of the app, from entry points on the left to data stores on the right.' },
  { key: 'database', label: 'Database', icon: <IconDatabase size={14} />, help: 'Tables, columns, primary keys (PK), foreign keys (FK) and indexes (IX), and which code reads or writes each table.' },
  { key: 'routes', label: 'Route map', icon: <IconRoute size={14} />, help: 'Every URL the app answers, arranged as a tree of path segments.' },
  { key: 'modules', label: 'Modules', icon: <IconLayers size={14} />, help: 'Folders of the codebase and which ones depend on which.' },
];

export function Diagrams() {
  const tab = useStore((s) => s.diagramTab);
  const setTab = useStore((s) => s.setDiagramTab);
  const [data, setData] = useState<DiagramData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const revision = useStore((s) => s.revision);

  useEffect(() => {
    loadDiagrams()
      .then(setData)
      .catch((e) => setError(String(e.message ?? e)));
  }, [revision]);

  const help = TABS.find((t) => t.key === tab)!.help;
  useHint(`diagrams-${tab}`, !!data);

  return (
    <div className="diagrams">
      <div className="diagram-bar">
        <div className="seg">
          {TABS.map((t) => (
            <button key={t.key} className={tab === t.key ? 'active' : ''} onClick={() => setTab(t.key)}>
              <span className="row" style={{ gap: 6 }}>
                {t.icon}
                {t.label}
              </span>
            </button>
          ))}
        </div>
        <span className="dim grow" style={{ fontSize: 12 }}>
          {help}
        </span>
        {data && tab === 'dataflow' && data.dataflow.note && <span className="pill">{data.dataflow.note}</span>}
      </div>
      {error ? (
        <div className="welcome">
          <div className="error-banner">{error}</div>
        </div>
      ) : !data ? (
        <div className="welcome">
          <span className="spinner" />
        </div>
      ) : (
        <ReactFlowProvider key={tab}>
          {tab === 'dataflow' && <GraphDiagram nodes={data.dataflow.nodes} edges={data.dataflow.edges} partitions emptyText="No connections between components were found." />}
          {tab === 'modules' && <GraphDiagram nodes={data.modules.nodes} edges={data.modules.edges} emptyText="This project has a single module." />}
          {tab === 'database' && <DatabaseDiagram db={data.database} />}
          {tab === 'routes' && <RouteDiagram tree={data.routes} />}
        </ReactFlowProvider>
      )}
    </div>
  );
}

/** Fit the whole diagram on screen once each new layout lands. */
function useFitOnLayout(key: string | undefined) {
  const rf = useReactFlow();
  const done = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (!key || done.current === key) return;
    done.current = key;
    requestAnimationFrame(() => rf.fitView({ padding: 0.08, maxZoom: 1 }));
  }, [key, rf]);
}

// ---------------- generic architecture graph ----------------

const shortSub = (s: string) => (s.includes('/') ? s.split('/').slice(-2).join('/') : s);

type DNodeData = DiagramNode & { selected: boolean; dim: boolean } & Record<string, unknown>;

const DBox = memo(function DBox({ data }: NodeProps<Node<DNodeData>>) {
  return (
    <div className={`dnode node-surface ${data.selected ? 'selected' : ''}`} style={{ '--rc': roleColor(data.role), opacity: data.dim ? 0.3 : 1 } as CSSProperties} title={`${data.label}\n${data.sublabel ?? ''}\n${ROLES[data.role].label}`}>
      <Handle type="target" position={Position.Left} />
      <div className="stripe" />
      <div className="content">
        <span className="kind" style={{ fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--rc)' }}>
          {ROLES[data.role].short}
          {data.size && data.size > 1 && !data.id.startsWith('entries:') ? ` · ${data.size}` : ''}
        </span>
        <span className="dtitle">
          {data.label}
        </span>
        {data.sublabel && (
          <span className="ellipsis mono faint" style={{ fontSize: 10.5 }}>
            {shortSub(data.sublabel)}
          </span>
        )}
      </div>
      <Handle type="source" position={Position.Right} />
    </div>
  );
});

const graphNodeTypes = { box: DBox };

function GraphDiagram({ nodes, edges, partitions, emptyText }: { nodes: DiagramNode[]; edges: DiagramEdge[]; partitions?: boolean; emptyText: string }) {
  const [hidden, setHidden] = useState<Set<Role>>(new Set(['util', 'config']));

  const visible = useMemo(() => nodes.filter((n) => !hidden.has(n.role)), [nodes, hidden]);
  const visIds = useMemo(() => new Set(visible.map((n) => n.id)), [visible]);
  const visEdges = useMemo(() => edges.filter((e) => visIds.has(e.from) && visIds.has(e.to)), [edges, visIds]);
  const focus = useDiagramFocus(visEdges, { defaultLines: edges.length > 150 ? 'focus' : 'all' });
  useEscapeToClear(focus);

  // Isolating redraws only the focused neighbourhood, laid out on its own.
  const ids = useMemo(() => visible.map((n) => n.id).filter((id) => !focus.isolatedSet || focus.isolatedSet.has(id)), [visible, focus.isolatedSet]);
  const idSet = useMemo(() => new Set(ids), [ids]);
  const shownNodes = useMemo(() => visible.filter((n) => idSet.has(n.id)), [visible, idSet]);
  const shownEdges = useMemo(() => visEdges.filter((e) => idSet.has(e.from) && idSet.has(e.to)), [visEdges, idSet]);
  const layoutEdges = useMemo(() => shownEdges.map((e) => ({ id: e.id, from: e.from, to: e.to })), [shownEdges]);
  const roleOf = useMemo(() => new Map(visible.map((n) => [n.id, n.role])), [visible]);
  // Full-stack projects: when frontend code calls routes of this project, put the backend in columns after the
  // frontend (page → component → API client ⇢ route → controller → table) so HTTP arrows read left to right.
  const backend = useMemo(() => {
    const linked = visEdges.filter((e) => e.kind === 'http' && e.to.startsWith('entries:'));
    if (!linked.length) return null;
    const out = new Map<string, string[]>();
    for (const e of visEdges) if (e.kind !== 'http' || !e.to.startsWith('entries:')) out.set(e.from, [...(out.get(e.from) ?? []), e.to]);
    const side = new Set<string>();
    const queue = visible.filter((n) => n.id.startsWith('entries:http-route:')).map((n) => n.id);
    while (queue.length) {
      const id = queue.pop()!;
      if (side.has(id)) continue;
      side.add(id);
      queue.push(...(out.get(id) ?? []));
    }
    return side;
  }, [visEdges, visible]);
  const BACKEND_OFFSET = 8;
  const layout = useMeasuredLayout(ids.join('|') + (backend ? '|fs' : ''), ids, layoutEdges, { partitions, layerGap: 90, nodeGap: 14 }, (id) => ROLE_RANK[roleOf.get(id) ?? 'other'] + (backend?.has(id) ? BACKEND_OFFSET : 0));
  useFitOnLayout(layout?.key);

  const rfNodes: Node<DNodeData>[] = useMemo(
    () =>
      shownNodes.map((n) => ({
        id: n.id,
        type: 'box',
        position: layout?.pos.get(n.id) ?? { x: 0, y: 0 },
        data: { ...n, selected: n.id === focus.selected, dim: !focus.inFocus(n.id) },
        style: layout ? undefined : { visibility: 'hidden' as const },
      })),
    // focus.inFocus changes with focus.dist
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [shownNodes, layout, focus.selected, focus.dist],
  );
  const maxW = Math.max(1, ...shownEdges.map((e) => e.weight));
  const rfEdges: Edge[] = useMemo(
    () =>
      shownEdges.map((e) => {
        const on = focus.edgeInFocus(e.from, e.to);
        const network = e.kind === 'http' && e.to.startsWith('entries:');
        const base = e.kind === 'reads' || e.kind === 'writes' ? 'var(--role-table)' : network ? 'var(--role-route)' : e.kind === 'http' ? 'var(--role-external)' : e.kind === 'publishes' || e.kind === 'subscribes' || e.kind === 'uses' ? 'var(--role-channel)' : 'var(--edge)';
        const color = focus.dist && on ? 'var(--accent)' : base;
        const width = 1 + Math.log2(1 + (4 * e.weight) / maxW);
        return {
          id: e.id,
          source: e.from,
          target: e.to,
          type: 'routed',
          data: routeData(layout, e.id, e.from, e.to),
          hidden: !layout || (focus.lines === 'focus' && !on),
          markerEnd: { type: MarkerType.ArrowClosed, width: 12, height: 12, color },
          style: { stroke: color, strokeWidth: on ? width + 1 : width, opacity: !focus.dist ? 0.85 : on ? 1 : 0.06 },
          zIndex: on ? 10 : 0,
          label: e.kind === 'reads' || e.kind === 'writes' ? e.kind : network ? 'HTTP' : undefined,
          animated: network || (on && !!focus.selected),
          labelStyle: { fill: 'var(--text-dim)', fontSize: 10 },
          labelBgStyle: { fill: 'var(--bg)' },
        };
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [shownEdges, focus.dist, focus.lines, focus.selected, maxW, layout],
  );

  const sel = nodes.find((n) => n.id === focus.selected);
  const presentRoles = useMemo(() => [...new Set(nodes.map((n) => n.role))].sort((a, b) => ROLE_RANK[a] - ROLE_RANK[b]), [nodes]);
  const findItems = useMemo(() => nodes.map((n) => ({ id: n.id, label: n.label, sub: n.sublabel })), [nodes]);

  if (!nodes.length)
    return (
      <div className="welcome">
        <div className="welcome-card">{emptyText}</div>
      </div>
    );

  return (
    <div className="diagram-body">
      <div className="diagram-canvas" data-hint="diagram">
        <ReactFlow
          nodes={rfNodes}
          edges={rfEdges}
          nodeTypes={graphNodeTypes}
          edgeTypes={routedEdgeTypes}
          onNodeClick={(_, n) => focus.select(n.id === focus.selected ? null : n.id)}
          onNodeMouseEnter={(_, n) => focus.setHovered(n.id)}
          onNodeMouseLeave={() => focus.setHovered(null)}
          onPaneClick={() => focus.select(null)}
          minZoom={0.1}
          proOptions={{ hideAttribution: true }}
          nodesConnectable={false}
          elementsSelectable={false}
        >
          <Background gap={22} size={1.2} color="var(--canvas-dot)" />
          <Controls showInteractive={false} position="bottom-right" />
          {shownNodes.length > 30 && <MiniMap pannable zoomable nodeColor={(n) => roleColor((n.data as DNodeData).role)} maskColor="rgba(0,0,0,0.25)" position="bottom-left" style={{ width: 150, height: 100, marginBottom: 44 }} />}
        </ReactFlow>
        <DiagramToolbar
          items={findItems}
          focus={focus}
          noun="box"
          onPick={(id) => {
            const r = roleOf.get(id) ?? nodes.find((n) => n.id === id)?.role;
            if (r && hidden.has(r)) setHidden((h) => new Set([...h].filter((x) => x !== r)));
          }}
        />
        <div className="flow-legend">
          {presentRoles.map((r) => (
            <label key={r} className="toggle" title={ROLES[r].explain}>
              <input
                type="checkbox"
                checked={!hidden.has(r)}
                onChange={() =>
                  setHidden((h) => {
                    const n = new Set(h);
                    if (n.has(r)) n.delete(r);
                    else n.add(r);
                    return n;
                  })
                }
              />
              <RoleDot role={r} /> {ROLES[r].short}
            </label>
          ))}
        </div>
      </div>
      {sel && <GraphSide node={sel} edges={edges} nodes={nodes} />}
    </div>
  );
}

function GraphSide({ node, edges, nodes }: { node: DiagramNode; edges: DiagramEdge[]; nodes: DiagramNode[] }) {
  const traceFrom = useStore((s) => s.traceFrom);
  const openEntry = useStore((s) => s.openEntry);
  const summary = useStore((s) => s.summary)!;
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const out = edges.filter((e) => e.from === node.id).map((e) => ({ e, n: byId.get(e.to) })).filter((x) => x.n);
  const inc = edges.filter((e) => e.to === node.id).map((e) => ({ e, n: byId.get(e.from) })).filter((x) => x.n);
  const groupEntries = node.id.startsWith('entries:') ? summary.entries.filter((e) => `entries:${e.kind}:${e.group}` === node.id) : [];
  return (
    <aside className="diagram-side">
      <div className="insp-section">
        <h4>{ROLES[node.role].label}</h4>
        <div className="insp-title">{node.label}</div>
        {node.sublabel && <div className="faint mono" style={{ fontSize: 11.5, marginTop: 2 }}>{node.sublabel}</div>}
        <div className="explain" style={{ '--rc': roleColor(node.role), marginTop: 10 } as CSSProperties}>
          {ROLES[node.role].explain}
        </div>
        {node.target && !node.target.startsWith('channel:') && (
          <div className="actions" style={{ marginTop: 10 }}>
            <button className="btn small" onClick={() => traceFrom(node.target!, node.label, node.role)}>
              <IconFlow size={14} /> Explore from here
            </button>
          </div>
        )}
        {node.target?.startsWith('channel:') && (
          <div className="actions" style={{ marginTop: 10 }}>
            <button className="btn small" onClick={() => openEntry(node.target!, node.label, 'channel')}>
              <IconFlow size={14} /> Who uses this channel
            </button>
          </div>
        )}
      </div>
      {groupEntries.length > 0 && (
        <div className="insp-section">
          <h4>Entry points ({groupEntries.length})</h4>
          {groupEntries.map((e) => (
            <button key={e.id} className="ref-row" onClick={() => openEntry(e.id, e.label, entryRole(e), e.handlerId)}>
              {e.kind === 'http-route' ? <MethodBadge method={e.method} /> : <RoleDot role={entryRole(e)} />}
              <span className="name mono ellipsis grow">{e.path ?? e.label}</span>
            </button>
          ))}
        </div>
      )}
      <div className="insp-section">
        <h4>Talks to ({out.length})</h4>
        {out.length === 0 && <div className="faint">Nothing downstream.</div>}
        {out.map(({ e, n }) => (
          <div key={e.id} className="ref-row" style={{ cursor: 'default' }}>
            <RoleDot role={n!.role} />
            <span className="name grow ellipsis">{n!.label}</span>
            <span className="faint" style={{ fontSize: 11 }}>
              {e.kind !== 'calls' ? e.kind + ' · ' : ''}
              {e.weight}×
            </span>
          </div>
        ))}
      </div>
      <div className="insp-section">
        <h4>Used by ({inc.length})</h4>
        {inc.length === 0 && <div className="faint">Nothing upstream.</div>}
        {inc.map(({ e, n }) => (
          <div key={e.id} className="ref-row" style={{ cursor: 'default' }}>
            <RoleDot role={n!.role} />
            <span className="name grow ellipsis">{n!.label}</span>
            <span className="faint" style={{ fontSize: 11 }}>{e.weight}×</span>
          </div>
        ))}
      </div>
    </aside>
  );
}

// ---------------- database ER diagram ----------------

const HEAD_H = 34;
const MAX_COLS = 18;

type TableData = { table: DbTable; selected: boolean; dim: boolean; used: number; hubOf?: number } & Record<string, unknown>;

const TableBox = memo(function TableBox({ data }: NodeProps<Node<TableData>>) {
  const t = data.table;
  const cols = t.columns.slice(0, MAX_COLS);
  return (
    <div className={`table-node node-surface ${data.selected ? 'selected' : ''}`} style={{ opacity: data.dim ? 0.3 : 1 }}>
      <div className="thead">
        <IconDatabase size={14} style={{ color: 'var(--role-table)' }} />
        <span className="ellipsis grow">{t.name}</span>
        {data.hubOf !== undefined && (
          <span className="pill" style={{ fontSize: 10 }} title={`${data.hubOf} tables reference this one. Their lines are drawn when you focus a table (or tick All lines), so they do not cover the whole diagram.`}>
            ← {data.hubOf}
          </span>
        )}
        {data.used > 0 && (
          <span className="faint" style={{ fontSize: 10.5, fontWeight: 500 }} title={`${data.used} functions read or write this table`}>
            {data.used} uses
          </span>
        )}
      </div>
      {cols.map((c) => (
        <div key={c.name} className="trow" title={`${c.name} ${c.type}${c.pk ? ' · primary key' : ''}${c.fk ? ` · references ${c.fk.table}${c.fk.column ? '.' + c.fk.column : ''}` : ''}${c.unique ? ' · unique' : ''}${c.nullable === false ? ' · not null' : ''}`}>
          <Handle type="target" position={Position.Left} id={`in-${c.name}`} style={{ top: '50%' }} />
          <span className={`key-icon ${c.pk ? 'key-pk' : c.fk ? 'key-fk' : c.indexed ? 'key-ix' : ''}`}>{c.pk ? 'PK' : c.fk ? 'FK' : c.indexed ? 'IX' : ''}</span>
          <span className="ellipsis" style={{ fontWeight: c.pk ? 700 : 400 }}>
            {c.name}
          </span>
          <span className="ttype">{c.type}</span>
          <Handle type="source" position={Position.Right} id={`out-${c.name}`} style={{ top: '50%' }} />
        </div>
      ))}
      {t.columns.length > MAX_COLS && <div className="trow faint">+{t.columns.length - MAX_COLS} more columns</div>}
      {t.columns.length === 0 && <div className="trow faint">columns unknown (referenced in queries)</div>}
      <Handle type="target" position={Position.Left} id="in-head" style={{ top: HEAD_H / 2 }} />
      <Handle type="source" position={Position.Right} id="out-head" style={{ top: HEAD_H / 2 }} />
    </div>
  );
});

const FrameBox = memo(function FrameBox({ data }: NodeProps<Node<{ label: string; count: number; dim: boolean } & Record<string, unknown>>>) {
  return (
    <div className="group-frame" style={{ opacity: data.dim ? 0.35 : 1 }}>
      <span className="group-frame-label">
        {data.label} <span className="faint">· {data.count} tables</span>
      </span>
    </div>
  );
});

const tableTypes = { table: TableBox, frame: FrameBox };


function DatabaseDiagram({ db }: { db: DiagramData['database'] }) {
  const byName = useMemo(() => new Map(db.tables.map((t) => [t.name.toLowerCase(), t])), [db]);

  const fkEdges = useMemo(() => {
    const out: { id: string; from: string; to: string; fromCol: string; toCol?: string }[] = [];
    for (const t of db.tables) {
      for (const c of t.columns) {
        if (!c.fk) continue;
        const target = byName.get(c.fk.table.toLowerCase());
        if (!target) continue;
        const toCol = c.fk.column ?? target.columns.find((x) => x.pk)?.name;
        out.push({ id: `${t.name}.${c.name}->${target.name}`, from: t.name, to: target.name, fromCol: c.name, toCol: target.columns.some((x) => x.name === toCol) ? toCol : undefined });
      }
    }
    return out;
  }, [db, byName]);
  // Columns past the visible rows have no handle of their own: attach to the table header instead.
  const handles = useMemo(() => {
    const shown = new Map(db.tables.map((t) => [t.name, new Set(t.columns.slice(0, MAX_COLS).map((c) => c.name))]));
    return new Map(fkEdges.map((e) => [e.id, { source: shown.get(e.from)?.has(e.fromCol) ? `out-${e.fromCol}` : 'out-head', target: e.toCol && shown.get(e.to)?.has(e.toCol) ? `in-${e.toCol}` : 'in-head' }]));
  }, [db, fkEdges]);

  // Hub tables (users, organizations…) are referenced by most others. Laying out around them squeezes every table
  // into one long column, so they are left out of the layout: each domain's tables form their own cluster, and
  // the hub lines are drawn on focus.
  const hubs = useMemo(() => {
    const inDeg = new Map<string, Set<string>>();
    for (const e of fkEdges) inDeg.set(e.to, (inDeg.get(e.to) ?? new Set()).add(e.from));
    const min = Math.max(8, db.tables.length * 0.12);
    return new Map([...inDeg].filter(([, s]) => s.size >= min).map(([t, s]) => [t, s.size]));
  }, [fkEdges, db]);
  // Big schemas: find groups of tables that mostly reference each other (label propagation over foreign keys,
  // ignoring hubs). Each group is laid out on its own and framed, so a 200-table schema reads as a dozen areas.
  const clusters = useMemo(() => {
    if (db.tables.length <= 30) return null;
    const names = db.tables.map((t) => t.name).sort();
    const adj = new Map<string, string[]>(names.map((n) => [n, []]));
    for (const e of fkEdges) {
      if (hubs.has(e.to) || hubs.has(e.from) || e.from === e.to) continue;
      adj.get(e.from)?.push(e.to);
      adj.get(e.to)?.push(e.from);
    }
    const label = new Map(names.map((n) => [n, n]));
    for (let iter = 0; iter < 20; iter++) {
      let changed = false;
      for (const n of names) {
        const counts = new Map<string, number>();
        for (const m of adj.get(n)!) counts.set(label.get(m)!, (counts.get(label.get(m)!) ?? 0) + 1);
        if (!counts.size) continue;
        const best = Math.max(...counts.values());
        const cur = label.get(n)!;
        if (counts.get(cur) === best) continue;
        const next = [...counts].filter(([, c]) => c === best).map(([l]) => l).sort()[0];
        label.set(n, next);
        changed = true;
      }
      if (!changed) break;
    }
    const members = new Map<string, string[]>();
    for (const [n, l] of label) members.set(l, [...(members.get(l) ?? []), n]);
    const groups = [...members.values()].filter((m) => m.length >= 3);
    if (groups.length < 2) return null;
    const of = new Map<string, string>();
    const names2 = new Map<string, string>();
    for (const m of groups) {
      // Name a group by the prefix its tables share (billing_*), else by its most referenced table.
      let prefix = m.reduce((p, n) => {
        let i = 0;
        while (i < p.length && p[i] === n[i]) i++;
        return p.slice(0, i);
      });
      prefix = prefix.replace(/[_.\-]+$/, '');
      const inner = (n: string) => fkEdges.filter((e) => e.to === n && m.includes(e.from)).length;
      const id = `group:${m[0]}`;
      names2.set(id, prefix.length >= 3 ? prefix : `${[...m].sort((a, b) => inner(b) - inner(a))[0]} group`);
      for (const n of m) of.set(n, id);
    }
    return { of, names: names2 };
  }, [db, fkEdges, hubs]);

  const hubSet = useMemo(() => new Set(hubs.keys()), [hubs]);
  const focus = useDiagramFocus(fkEdges, { barriers: hubSet });
  useEscapeToClear(focus);
  type Lines = 'focus' | 'nohub' | 'all';
  const [lines, setLines] = useState<Lines>(() => (hubs.size || clusters ? 'nohub' : fkEdges.length > 120 ? 'focus' : 'all'));

  // Big schemas: tables without any foreign key in or out fill the screen without telling much; hide them by
  // default (Find still reaches them).
  const linked = useMemo(() => new Set(fkEdges.flatMap((e) => [e.from, e.to])), [fkEdges]);
  const unlinkedCount = db.tables.length - linked.size;
  const [showUnlinked, setShowUnlinked] = useState(() => db.tables.length <= 40 || linked.size === 0);
  const [revealed, setRevealed] = useState<Set<string>>(new Set());

  const tableIds = useMemo(
    () => db.tables.map((t) => t.name).filter((n) => (showUnlinked || linked.has(n) || revealed.has(n)) && (!focus.isolatedSet || focus.isolatedSet.has(n))),
    [db, showUnlinked, linked, revealed, focus.isolatedSet],
  );
  const idSet = useMemo(() => new Set(tableIds), [tableIds]);
  const shownEdges = useMemo(() => fkEdges.filter((e) => idSet.has(e.from) && idSet.has(e.to)), [fkEdges, idSet]);
  const grouped = !!clusters && !focus.isolatedSet;
  const crossGroup = (e: { from: string; to: string }) => hubs.has(e.to) || (!!clusters && clusters.of.get(e.from) !== clusters.of.get(e.to));
  const layoutEdges = useMemo(
    () => shownEdges.filter((e) => !grouped || !crossGroup(e)).map((e) => ({ id: e.id, from: e.from, to: e.to, fromPort: handles.get(e.id)!.source, toPort: handles.get(e.id)!.target })),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [shownEdges, handles, hubs, clusters, grouped],
  );
  const layout = useMeasuredLayout(tableIds.join('|') + (grouped ? '|g' : ''), tableIds, layoutEdges, { layerGap: 70, nodeGap: 24, aspectRatio: 1.8, componentGap: grouped ? 70 : 40 });
  useFitOnLayout(layout?.key);

  // Memoized: React Flow forgets measured sizes when it receives new node objects.
  const nodes: Node<TableData>[] = useMemo(
    () =>
      db.tables
        .filter((t) => idSet.has(t.name))
        .map((t) => ({
          id: t.name,
          type: 'table',
          position: layout?.pos.get(t.name) ?? { x: 0, y: 0 },
          data: { table: t, selected: focus.selected === t.name, dim: !focus.inFocus(t.name), used: new Set((db.usage[t.name.toLowerCase()] ?? []).map((u) => u.id)).size, hubOf: hubs.get(t.name) },
          style: layout ? undefined : { visibility: 'hidden' as const },
        })),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [db, idSet, layout, focus.selected, focus.dist, hubs],
  );
  const edges: Edge[] = useMemo(
    () =>
      shownEdges.map((e) => {
        const on = focus.edgeInFocus(e.from, e.to);
        const color = focus.dist && on ? 'var(--accent)' : 'var(--role-model)';
        return {
          id: e.id,
          source: e.from,
          target: e.to,
          sourceHandle: handles.get(e.id)!.source,
          targetHandle: handles.get(e.id)!.target,
          type: 'routed',
          data: routeData(layout, e.id, e.from, e.to),
          // Lines into hub tables only appear on focus unless every line was asked for.
          hidden: !layout || (!on && !focus.isolatedSet && (lines === 'focus' || (lines === 'nohub' && crossGroup(e)))),
          animated: on && !!focus.selected,
          zIndex: on ? 10 : 0,
          markerEnd: { type: MarkerType.ArrowClosed, width: 12, height: 12, color },
          style: { stroke: color, strokeWidth: on ? 2.4 : 1.5, opacity: !focus.dist ? 0.85 : on ? 1 : 0.06 },
        };
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [shownEdges, handles, layout, focus.dist, lines, focus.selected, hubs, clusters, focus.isolatedSet],
  );
  const findItems = useMemo(() => db.tables.map((t) => ({ id: t.name, label: t.name, sub: t.modelName })), [db]);
  // A labelled frame behind each group of tables.
  const frames: Node[] = useMemo(() => {
    if (!grouped || !layout || !clusters) return [];
    const box = new Map<string, { x0: number; y0: number; x1: number; y1: number; n: number }>();
    for (const id of tableIds) {
      const g = clusters.of.get(id);
      const p = layout.pos.get(id);
      const sz = layout.sizes.get(id);
      if (!g || !p || !sz) continue;
      const b = box.get(g) ?? { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity, n: 0 };
      box.set(g, { x0: Math.min(b.x0, p.x), y0: Math.min(b.y0, p.y), x1: Math.max(b.x1, p.x + sz.w), y1: Math.max(b.y1, p.y + sz.h), n: b.n + 1 });
    }
    const PAD = 18;
    return [...box]
      .filter(([, b]) => b.n >= 2)
      .map(([g, b]) => ({
        id: g,
        type: 'frame',
        position: { x: b.x0 - PAD, y: b.y0 - PAD - 20 },
        data: { label: clusters.names.get(g) ?? g, count: b.n, dim: !!focus.dist && ![...focus.dist.keys()].some((t) => clusters.of.get(t) === g) },
        style: { width: b.x1 - b.x0 + PAD * 2, height: b.y1 - b.y0 + PAD * 2 + 20 },
        zIndex: -1,
        selectable: false,
        draggable: false,
        focusable: false,
      }));
  }, [grouped, layout, clusters, tableIds, focus.dist]);
  const allNodes = useMemo(() => [...frames, ...nodes], [frames, nodes]);

  if (!db.tables.length) {
    return (
      <div className="welcome">
        <div className="welcome-card">
          <IconDatabase size={34} />
          <h3>No database tables found</h3>
          <p>
            Tables are read from SQL migrations and schema files (<span className="mono">CREATE TABLE</span>, <span className="mono">CREATE INDEX</span>), Prisma schemas, JPA/Hibernate <span className="mono">@Entity</span> classes, TypeORM entities, Django
            models and SQLAlchemy/SQLModel models. Tables named inside SQL queries also show up here.
          </p>
        </div>
      </div>
    );
  }

  const sel = focus.selected ? byName.get(focus.selected.toLowerCase()) : undefined;
  return (
    <div className="diagram-body">
      <div className="diagram-canvas" data-hint="diagram">
        <ReactFlow
          nodes={allNodes}
          edges={edges}
          nodeTypes={tableTypes}
          edgeTypes={routedEdgeTypes}
          onNodeClick={(_, n) => n.type !== 'frame' && focus.select(n.id === focus.selected ? null : n.id)}
          onNodeMouseEnter={(_, n) => n.type !== 'frame' && focus.setHovered(n.id)}
          onNodeMouseLeave={() => focus.setHovered(null)}
          onPaneClick={() => focus.select(null)}
          minZoom={0.05}
          proOptions={{ hideAttribution: true }}
          nodesConnectable={false}
          elementsSelectable={false}
        >
          <Background gap={22} size={1.2} color="var(--canvas-dot)" />
          <Controls showInteractive={false} position="bottom-right" />
          {nodes.length > 30 && <MiniMap pannable zoomable nodeColor={(n) => (n.type === 'frame' ? 'transparent' : 'var(--role-table)')} maskColor="rgba(0,0,0,0.25)" position="bottom-left" style={{ width: 150, height: 100, marginBottom: 44 }} />}
        </ReactFlow>
        <DiagramToolbar
          items={findItems}
          focus={focus}
          noun="table"
          linesToggle={false}
          onPick={(id) => !linked.has(id) && !showUnlinked && setRevealed((r) => new Set(r).add(id))}
          extra={
            <>
              {fkEdges.length > 0 && (
                <label className="toggle" title="Which foreign-key lines to draw. Lines for the focused table are always drawn.">
                  Lines
                  <select className="select" value={lines} onChange={(e) => setLines(e.target.value as Lines)} aria-label="Which lines to draw">
                    <option value="focus">Focused table only</option>
                    {(hubs.size > 0 || clusters) && <option value="nohub">{clusters ? 'Within groups' : `All except into hubs (${[...hubs.keys()].join(', ')})`}</option>}
                    <option value="all">All</option>
                  </select>
                </label>
              )}
              {unlinkedCount > 0 && linked.size > 0 && (
                <label className="toggle" title="Tables with no foreign key to or from another table">
                  <input type="checkbox" checked={showUnlinked} onChange={(e) => setShowUnlinked(e.target.checked)} />
                  Unlinked tables ({unlinkedCount})
                </label>
              )}
            </>
          }
        />
        <div className="flow-legend">
          <span>
            <span className="key-icon key-pk">PK</span> primary key
          </span>
          <span>
            <span className="key-icon key-fk">FK</span> foreign key (arrow points to the referenced table)
          </span>
          <span>
            <span className="key-icon key-ix">IX</span> indexed
          </span>
          <span>
            {nodes.length === db.tables.length ? `${db.tables.length} tables` : `${nodes.length} of ${db.tables.length} tables shown`} · hover or click a table to trace its relations
          </span>
        </div>
      </div>
      {sel && <TableSide table={sel} usage={db.usage[sel.name.toLowerCase()] ?? []} />}
    </div>
  );
}

function TableSide({ table, usage }: { table: DbTable; usage: { id: string; name: string; kind: string }[] }) {
  const openCode = useStore((s) => s.openCode);
  const traceFrom = useStore((s) => s.traceFrom);
  const seen = new Set<string>();
  const uses = usage.filter((u) => (seen.has(u.id + u.kind) ? false : (seen.add(u.id + u.kind), true)));
  return (
    <aside className="diagram-side">
      <div className="insp-section">
        <h4>Table</h4>
        <div className="insp-title mono">{table.name}</div>
        {table.modelName && <div className="faint" style={{ marginTop: 4 }}>Model class: {table.modelName}</div>}
        {table.source.file && (
          <button className="link mono" style={{ fontSize: 11.5, marginTop: 6 }} onClick={() => openCode({ file: table.source.file, line: table.source.line, symbolId: table.source.symbolId }, table.name, 'table')}>
            {table.source.kind} · {shortFile(table.source.file, 3)}:{table.source.line}
          </button>
        )}
      </div>
      <div className="insp-section">
        <h4>Indexes ({table.indexes.length})</h4>
        {table.indexes.length === 0 && <div className="faint">No indexes declared. Lookups on columns other than the primary key will scan the whole table.</div>}
        {table.indexes.map((i) => (
          <div key={i.name + i.columns.join()} className="mono" style={{ fontSize: 11.5, padding: '3px 0' }}>
            <span style={{ color: i.primary ? 'var(--role-table)' : i.unique ? 'var(--role-model)' : 'var(--role-service)', fontWeight: 700 }}>{i.primary ? 'PRIMARY' : i.unique ? 'UNIQUE' : 'INDEX'}</span> {i.primary ? '' : i.name}{' '}
            <span className="faint">({i.columns.join(', ')})</span>
          </div>
        ))}
      </div>
      <div className="insp-section">
        <h4>Code that uses it ({uses.length})</h4>
        {uses.length === 0 && <div className="faint">No code in this project was found reading or writing this table.</div>}
        {uses.map((u) => (
          <button key={u.id + u.kind} className="ref-row" onClick={() => traceFrom(u.id, u.name, 'repository')} title="Explore the flow from this function">
            <span className="pill" style={{ color: u.kind === 'writes' ? 'var(--m-put)' : u.kind === 'reads' ? 'var(--m-get)' : undefined }}>
              {u.kind}
            </span>
            <span className="name grow ellipsis">{u.name}</span>
          </button>
        ))}
      </div>
    </aside>
  );
}

// ---------------- route map ----------------

type RouteData = { node: RouteTreeNode; selected: boolean; dim: boolean; collapsed: boolean; hidden: number; onToggle?: () => void } & Record<string, unknown>;

const RouteBox = memo(function RouteBox({ data }: NodeProps<Node<RouteData>>) {
  const openEntry = useStore((s) => s.openEntry);
  const summary = useStore((s) => s.summary)!;
  const n = data.node;
  return (
    <div
      className={`route-node node-surface ${data.selected ? 'selected' : ''}`}
      style={{ borderColor: n.routes.length ? 'color-mix(in srgb, var(--role-route) 55%, var(--border-strong))' : undefined, opacity: data.dim ? 0.25 : 1 }}
    >
      <Handle type="target" position={Position.Left} />
      <span className="seg-name ellipsis" title={n.fullPath}>
        {n.segment === '/' ? '/' : '/' + n.segment}
      </span>
      {n.routes.length > 0 && (
        <span className="methods">
          {n.routes.map((r) => {
            const e = summary.entries.find((x) => x.id === r.id);
            return (
              <span key={r.id} className="nodrag" onClick={(ev) => (ev.stopPropagation(), e && openEntry(e.id, e.label, entryRole(e), e.handlerId))} title={`${r.method} ${n.fullPath} → ${r.handlerName ?? '?'}\nClick to explore`}>
                <MethodBadge method={r.method} />
              </span>
            );
          })}
        </span>
      )}
      {data.onToggle && (
        <button
          className="nodrag route-toggle"
          onClick={(ev) => {
            ev.stopPropagation();
            data.onToggle!();
          }}
          title={data.collapsed ? `Show the ${data.hidden} routes under ${n.fullPath}` : 'Collapse this branch'}
          aria-label={data.collapsed ? `Expand ${n.fullPath}` : `Collapse ${n.fullPath}`}
          aria-expanded={!data.collapsed}
        >
          {data.collapsed ? `+${data.hidden}` : '−'}
        </button>
      )}
      <Handle type="source" position={Position.Right} />
    </div>
  );
});

const routeTypes = { route: RouteBox };
const MAX_ROUTE_BOXES = 120;

function RouteDiagram({ tree }: { tree: RouteTreeNode }) {
  // Index the whole tree once: parents, depths and how many routes sit under each branch.
  const index = useMemo(() => {
    const parent = new Map<string, string>();
    const depth = new Map<string, number>();
    const routesUnder = new Map<string, number>();
    const byId = new Map<string, RouteTreeNode>();
    const walk = (n: RouteTreeNode, d: number, p?: string): number => {
      byId.set(n.fullPath, n);
      depth.set(n.fullPath, d);
      if (p) parent.set(n.fullPath, p);
      let c = n.routes.length;
      for (const ch of n.children) c += walk(ch, d + 1, n.fullPath);
      routesUnder.set(n.fullPath, c);
      return c;
    };
    walk(tree, 0);
    return { parent, depth, routesUnder, byId };
  }, [tree]);

  // Huge apps start collapsed at the deepest level that keeps the map to about MAX_ROUTE_BOXES boxes.
  const [collapsed, setCollapsed] = useState<Set<string>>(() => {
    const perDepth = new Map<number, number>();
    for (const d of index.depth.values()) perDepth.set(d, (perDepth.get(d) ?? 0) + 1);
    let total = 0;
    let cut = Infinity;
    for (let d = 0; perDepth.has(d); d++) {
      total += perDepth.get(d)!;
      if (total > MAX_ROUTE_BOXES) {
        cut = Math.max(1, d - 1);
        break;
      }
    }
    return new Set([...index.byId.values()].filter((n) => n.children.length && index.depth.get(n.fullPath)! >= cut).map((n) => n.fullPath));
  });
  const toggle = (id: string) =>
    setCollapsed((c) => {
      const n = new Set(c);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  const expandTo = (id: string) =>
    setCollapsed((c) => {
      const n = new Set(c);
      for (let p = index.parent.get(id); p; p = index.parent.get(p)) n.delete(p);
      return n;
    });

  const flat = useMemo(() => {
    const nodes: { id: string; node: RouteTreeNode }[] = [];
    const edges: { id: string; from: string; to: string }[] = [];
    const walk = (n: RouteTreeNode, parent?: string) => {
      const id = n.fullPath;
      nodes.push({ id, node: n });
      if (parent) edges.push({ id: `${parent}->${id}`, from: parent, to: id });
      if (!collapsed.has(id)) n.children.forEach((c) => walk(c, id));
    };
    walk(tree);
    return { nodes, edges };
  }, [tree, collapsed]);

  // Focusing a segment lights up its path from the root and the branch below it.
  const relate = useCallback(
    (id: string, hops: number) => {
      const d = new Map([[id, 0]]);
      let i = 1;
      for (let p = index.parent.get(id); p; p = index.parent.get(p)) d.set(p, i++);
      const down = (n: RouteTreeNode, level: number) => {
        if (level > hops + 1) return;
        for (const c of n.children) {
          d.set(c.fullPath, level);
          down(c, level + 1);
        }
      };
      const node = index.byId.get(id);
      if (node) down(node, 1);
      return d;
    },
    [index],
  );
  const focus = useDiagramFocus(flat.edges, { relate });
  useEscapeToClear(focus);

  const routeIds = useMemo(() => flat.nodes.map((n) => n.id).filter((id) => !focus.isolatedSet || focus.isolatedSet.has(id)), [flat, focus.isolatedSet]);
  const idSet = useMemo(() => new Set(routeIds), [routeIds]);
  const shownEdges = useMemo(() => flat.edges.filter((e) => idSet.has(e.from) && idSet.has(e.to)), [flat, idSet]);
  const layout = useMeasuredLayout(routeIds.join('|'), routeIds, shownEdges, { layerGap: 50, nodeGap: 10 });
  useFitOnLayout(layout?.key);
  const routeNodes = useMemo(
    () =>
      flat.nodes
        .filter((n) => idSet.has(n.id))
        .map((n) => ({
          id: n.id,
          type: 'route',
          position: layout?.pos.get(n.id) ?? { x: 0, y: 0 },
          data: {
            node: n.node,
            selected: focus.selected === n.id,
            dim: !focus.inFocus(n.id),
            collapsed: collapsed.has(n.id),
            hidden: index.routesUnder.get(n.id)! - n.node.routes.length,
            onToggle: n.node.children.length ? () => toggle(n.id) : undefined,
          },
          style: layout ? undefined : { visibility: 'hidden' as const },
        })),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [flat, idSet, layout, focus.selected, focus.dist, collapsed, index],
  );
  const routeEdges = useMemo(
    () =>
      shownEdges.map((e) => {
        const on = !!focus.dist && focus.dist.has(e.from) && focus.dist.has(e.to);
        return {
          id: e.id,
          source: e.from,
          target: e.to,
          type: 'routed',
          data: routeData(layout, e.id, e.from, e.to),
          hidden: !layout,
          zIndex: on ? 10 : 0,
          style: { stroke: on ? 'var(--accent)' : 'var(--edge)', strokeWidth: on ? 2.4 : 1.4, opacity: !focus.dist || on ? 1 : 0.15 },
        };
      }),
    [shownEdges, layout, focus.dist],
  );
  const findItems = useMemo(
    () => [...index.byId.values()].filter((n) => n.routes.length).map((n) => ({ id: n.fullPath, label: n.fullPath, sub: n.routes.map((r) => r.method).join(' ') })),
    [index],
  );

  if (flat.nodes.length <= 1 && !tree.routes.length && !tree.children.length)
    return (
      <div className="welcome">
        <div className="welcome-card">
          <IconRoute size={34} />
          <h3>No routes found</h3>
          <p>This project does not seem to expose HTTP routes or pages. Check the Explore tab for processes, jobs and channels instead.</p>
        </div>
      </div>
    );

  return (
    <div className="diagram-body" style={{ gridTemplateColumns: '1fr' }}>
      <div className="diagram-canvas" data-hint="diagram">
        <ReactFlow
          nodes={routeNodes}
          edges={routeEdges}
          nodeTypes={routeTypes}
          edgeTypes={routedEdgeTypes}
          onNodeClick={(_, n) => focus.select(n.id === focus.selected ? null : n.id)}
          onNodeMouseEnter={(_, n) => focus.setHovered(n.id)}
          onNodeMouseLeave={() => focus.setHovered(null)}
          onPaneClick={() => focus.select(null)}
          minZoom={0.05}
          proOptions={{ hideAttribution: true }}
          nodesConnectable={false}
          elementsSelectable={false}
        >
          <Background gap={22} size={1.2} color="var(--canvas-dot)" />
          <Controls showInteractive={false} position="bottom-right" />
        </ReactFlow>
        <DiagramToolbar
          items={findItems}
          focus={focus}
          noun="route"
          linesToggle={false}
          onPick={expandTo}
          extra={
            index.byId.size > 1 && (
              <span className="row" style={{ gap: 4 }}>
                <button className="btn small ghost" onClick={() => setCollapsed(new Set())} disabled={!collapsed.size} title="Show every branch">
                  Expand all
                </button>
                <button
                  className="btn small ghost"
                  onClick={() => setCollapsed(new Set(tree.children.filter((c) => c.children.length).map((c) => c.fullPath)))}
                  title="Show only the top-level sections"
                >
                  Collapse
                </button>
              </span>
            )
          }
        />
        <div className="flow-legend">
          <span>Each box is one segment of a URL path; badges are the HTTP methods answered there (click one to follow it). +N opens a collapsed branch.</span>
        </div>
      </div>
    </div>
  );
}
