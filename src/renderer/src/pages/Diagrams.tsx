import { memo, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
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
  const [selected, setSelected] = useState<string | null>(null);
  const [hidden, setHidden] = useState<Set<Role>>(new Set(['util', 'config']));

  const visible = useMemo(() => nodes.filter((n) => !hidden.has(n.role)), [nodes, hidden]);
  const visIds = useMemo(() => new Set(visible.map((n) => n.id)), [visible]);
  const visEdges = useMemo(() => edges.filter((e) => visIds.has(e.from) && visIds.has(e.to)), [edges, visIds]);

  const ids = useMemo(() => visible.map((n) => n.id), [visible]);
  const layoutEdges = useMemo(() => visEdges.map((e) => ({ id: e.id, from: e.from, to: e.to })), [visEdges]);
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

  const neighbors = useMemo(() => {
    if (!selected) return null;
    const s = new Set([selected]);
    for (const e of visEdges) {
      if (e.from === selected) s.add(e.to);
      if (e.to === selected) s.add(e.from);
    }
    return s;
  }, [selected, visEdges]);

  const rfNodes: Node<DNodeData>[] = useMemo(
    () =>
      visible.map((n) => ({
        id: n.id,
        type: 'box',
        position: layout?.pos.get(n.id) ?? { x: 0, y: 0 },
        data: { ...n, selected: n.id === selected, dim: !!neighbors && !neighbors.has(n.id) },
        style: layout ? undefined : { visibility: 'hidden' as const },
      })),
    [visible, layout, selected, neighbors],
  );
  const maxW = Math.max(1, ...visEdges.map((e) => e.weight));
  const rfEdges: Edge[] = useMemo(
    () =>
      visEdges.map((e) => {
        const on = !neighbors || (neighbors.has(e.from) && neighbors.has(e.to) && (e.from === selected || e.to === selected));
        const network = e.kind === 'http' && e.to.startsWith('entries:');
        const color = e.kind === 'reads' || e.kind === 'writes' ? 'var(--role-table)' : network ? 'var(--role-route)' : e.kind === 'http' ? 'var(--role-external)' : e.kind === 'publishes' || e.kind === 'subscribes' || e.kind === 'uses' ? 'var(--role-channel)' : 'var(--edge)';
        return {
          id: e.id,
          source: e.from,
          target: e.to,
          type: 'smoothstep',
          hidden: !layout,
          markerEnd: { type: MarkerType.ArrowClosed, width: 12, height: 12, color },
          style: { stroke: color, strokeWidth: 1 + Math.log2(1 + (4 * e.weight) / maxW), opacity: on ? 0.9 : 0.1 },
          label: e.kind === 'reads' || e.kind === 'writes' ? e.kind : network ? 'HTTP' : undefined,
          animated: network,
          labelStyle: { fill: 'var(--text-dim)', fontSize: 10 },
          labelBgStyle: { fill: 'var(--bg)' },
        };
      }),
    [visEdges, neighbors, selected, maxW, layout],
  );

  const sel = nodes.find((n) => n.id === selected);
  const presentRoles = useMemo(() => [...new Set(nodes.map((n) => n.role))].sort((a, b) => ROLE_RANK[a] - ROLE_RANK[b]), [nodes]);

  if (!nodes.length)
    return (
      <div className="welcome">
        <div className="welcome-card">{emptyText}</div>
      </div>
    );

  return (
    <div className="diagram-body">
      <div className="diagram-canvas" data-hint="diagram">
        <ReactFlow nodes={rfNodes} edges={rfEdges} nodeTypes={graphNodeTypes} onNodeClick={(_, n) => setSelected(n.id)} onPaneClick={() => setSelected(null)} minZoom={0.1} proOptions={{ hideAttribution: true }} nodesConnectable={false} elementsSelectable={false}>
          <Background gap={22} size={1.2} color="var(--canvas-dot)" />
          <Controls showInteractive={false} position="bottom-right" />
          {visible.length > 30 && <MiniMap pannable zoomable nodeColor={(n) => roleColor((n.data as DNodeData).role)} maskColor="rgba(0,0,0,0.25)" position="top-left" style={{ width: 150, height: 100 }} />}
        </ReactFlow>
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

type TableData = { table: DbTable; selected: boolean; dim: boolean; used: number } & Record<string, unknown>;

const TableBox = memo(function TableBox({ data }: NodeProps<Node<TableData>>) {
  const t = data.table;
  const cols = t.columns.slice(0, MAX_COLS);
  return (
    <div className={`table-node node-surface ${data.selected ? 'selected' : ''}`} style={{ opacity: data.dim ? 0.3 : 1 }}>
      <div className="thead">
        <IconDatabase size={14} style={{ color: 'var(--role-table)' }} />
        <span className="ellipsis grow">{t.name}</span>
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
    </div>
  );
});

const tableTypes = { table: TableBox };


function DatabaseDiagram({ db }: { db: DiagramData['database'] }) {
  const [selected, setSelected] = useState<string | null>(null);
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

  const tableIds = useMemo(() => db.tables.map((t) => t.name), [db]);
  const layoutEdges = useMemo(() => fkEdges.map((e) => ({ id: e.id, from: e.from, to: e.to })), [fkEdges]);
  const layout = useMeasuredLayout(tableIds.join('|'), tableIds, layoutEdges, { layerGap: 90, nodeGap: 30 });
  useFitOnLayout(layout?.key);

  const related = useMemo(() => {
    if (!selected) return null;
    const s = new Set([selected]);
    for (const e of fkEdges) {
      if (e.from === selected) s.add(e.to);
      if (e.to === selected) s.add(e.from);
    }
    return s;
  }, [selected, fkEdges]);

  // Memoized: React Flow forgets measured sizes when it receives new node objects.
  const nodes: Node<TableData>[] = useMemo(
    () =>
      db.tables.map((t) => ({
        id: t.name,
        type: 'table',
        position: layout?.pos.get(t.name) ?? { x: 0, y: 0 },
        data: { table: t, selected: selected === t.name, dim: !!related && !related.has(t.name), used: new Set((db.usage[t.name.toLowerCase()] ?? []).map((u) => u.id)).size },
        style: layout ? undefined : { visibility: 'hidden' as const },
      })),
    [db, layout, selected, related],
  );
  const edges: Edge[] = fkEdges.map((e) => {
    const on = !related || (related.has(e.from) && related.has(e.to) && (e.from === selected || e.to === selected));
    return {
      id: e.id,
      source: e.from,
      target: e.to,
      sourceHandle: `out-${e.fromCol}`,
      targetHandle: e.toCol ? `in-${e.toCol}` : 'in-head',
      type: 'smoothstep',
      hidden: !layout,
      markerEnd: { type: MarkerType.ArrowClosed, width: 12, height: 12, color: 'var(--role-model)' },
      style: { stroke: 'var(--role-model)', strokeWidth: 1.5, opacity: on ? 0.85 : 0.1 },
    };
  });

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

  const sel = selected ? byName.get(selected.toLowerCase()) : undefined;
  return (
    <div className="diagram-body">
      <div className="diagram-canvas" data-hint="diagram">
        <ReactFlow nodes={nodes} edges={edges} nodeTypes={tableTypes} onNodeClick={(_, n) => setSelected(n.id)} onPaneClick={() => setSelected(null)} minZoom={0.1} proOptions={{ hideAttribution: true }} nodesConnectable={false} elementsSelectable={false}>
          <Background gap={22} size={1.2} color="var(--canvas-dot)" />
          <Controls showInteractive={false} position="bottom-right" />
        </ReactFlow>
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
          <span>{db.tables.length} tables</span>
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

type RouteData = { node: RouteTreeNode } & Record<string, unknown>;

const RouteBox = memo(function RouteBox({ data }: NodeProps<Node<RouteData>>) {
  const openEntry = useStore((s) => s.openEntry);
  const summary = useStore((s) => s.summary)!;
  const n = data.node;
  return (
    <div className="route-node node-surface" style={{ borderColor: n.routes.length ? 'color-mix(in srgb, var(--role-route) 55%, var(--border-strong))' : undefined }}>
      <Handle type="target" position={Position.Left} />
      <span className="seg-name ellipsis" title={n.fullPath}>
        {n.segment === '/' ? '/' : '/' + n.segment}
      </span>
      {n.routes.length > 0 && (
        <span className="methods">
          {n.routes.map((r) => {
            const e = summary.entries.find((x) => x.id === r.id);
            return (
              <span key={r.id} className="nodrag" onClick={() => e && openEntry(e.id, e.label, entryRole(e), e.handlerId)} title={`${r.method} ${n.fullPath} → ${r.handlerName ?? '?'}\nClick to explore`}>
                <MethodBadge method={r.method} />
              </span>
            );
          })}
        </span>
      )}
      <Handle type="source" position={Position.Right} />
    </div>
  );
});

const routeTypes = { route: RouteBox };

function RouteDiagram({ tree }: { tree: RouteTreeNode }) {
  const flat = useMemo(() => {
    const nodes: { id: string; node: RouteTreeNode }[] = [];
    const edges: { id: string; from: string; to: string }[] = [];
    const walk = (n: RouteTreeNode, parent?: string) => {
      const id = n.fullPath;
      nodes.push({ id, node: n });
      if (parent) edges.push({ id: `${parent}->${id}`, from: parent, to: id });
      n.children.forEach((c) => walk(c, id));
    };
    walk(tree);
    return { nodes, edges };
  }, [tree]);

  const routeIds = useMemo(() => flat.nodes.map((n) => n.id), [flat]);
  const layout = useMeasuredLayout(routeIds.join('|'), routeIds, flat.edges, { layerGap: 50, nodeGap: 10 });
  useFitOnLayout(layout?.key);
  const routeNodes = useMemo(
    () => flat.nodes.map((n) => ({ id: n.id, type: 'route', position: layout?.pos.get(n.id) ?? { x: 0, y: 0 }, data: { node: n.node }, style: layout ? undefined : { visibility: 'hidden' as const } })),
    [flat, layout],
  );
  const routeEdges = useMemo(() => flat.edges.map((e) => ({ id: e.id, source: e.from, target: e.to, type: 'smoothstep', hidden: !layout, style: { stroke: 'var(--edge)', strokeWidth: 1.4 } })), [flat, layout]);

  if (flat.nodes.length <= 1 && !tree.routes.length)
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
          minZoom={0.1}
          proOptions={{ hideAttribution: true }}
          nodesConnectable={false}
          elementsSelectable={false}
        >
          <Background gap={22} size={1.2} color="var(--canvas-dot)" />
          <Controls showInteractive={false} position="bottom-right" />
        </ReactFlow>
        <div className="flow-legend">
          <span>Each box is one segment of a URL path. Badges are the HTTP methods answered there. Click a badge to follow that route.</span>
        </div>
      </div>
    </div>
  );
}

