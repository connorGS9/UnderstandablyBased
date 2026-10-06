import { memo, useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import {
  ReactFlow,
  Background,
  Controls,
  MiniMap,
  Handle,
  Position,
  MarkerType,
  useReactFlow,
  ReactFlowProvider,
  type Edge,
  type Node,
  type NodeProps,
} from '@xyflow/react';
import { api } from '../api';
import { useStore } from '../store';
import type { FlowGraph, FlowNode } from '../../../engine/types';
import { layoutGraph, textWidth } from '../lib/layout';
import { CONFIDENCE, ROLES, roleColor } from '../lib/roles';
import { IconFit } from './Icons';

type FlowNodeData = FlowNode & { selected: boolean; onExpand: (id: string) => void; isRoot: boolean } & Record<string, unknown>;

const NODE_H = 54;
const MIN_READABLE_ZOOM = 0.8;

/** Short location for the box; the full path is in the tooltip and the inspector. */
function subFor(n: FlowNode): string | undefined {
  if (!n.file || n.kind === 'entry') return n.sublabel;
  const base = `${n.file.split('/').pop()}${n.line ? ':' + n.line : ''}`;
  const kind = n.sublabel?.match(/^(class|interface) · /)?.[1];
  return kind ? `${kind} · ${base}` : base;
}

function nodeWidth(n: FlowNode): number {
  const w = Math.max(textWidth(n.label), textWidth(subFor(n) ?? '', '10.5px monospace') * 0.95, 80);
  return Math.round(Math.min(300, Math.max(150, w + 34)));
}

const FlowBox = memo(function FlowBox({ data }: NodeProps<Node<FlowNodeData>>) {
  const sink = data.kind === 'table' || data.kind === 'external' || data.kind === 'channel';
  const kindLabel = data.kind === 'entry' ? ROLES[data.role].label : sink ? ROLES[data.role].label : ROLES[data.role].short;
  return (
    <div
      className={`fnode ${data.selected ? 'selected' : ''} ${data.kind === 'entry' ? 'entry' : ''} ${sink ? 'sink ' + data.kind : ''}`}
      style={{ '--rc': roleColor(data.role) } as CSSProperties}
      title={`${data.label}\n${data.sublabel ?? ''}\n\n${ROLES[data.role].label}: ${ROLES[data.role].explain}${data.repeated ? '\n\n(also called elsewhere in this flow)' : ''}`}
    >
      <Handle type="target" position={Position.Left} />
      <div className="stripe" />
      <div className="content">
        <span className="kind">
          {kindLabel}
          {data.repeated ? ' · again' : ''}
        </span>
        <span className="title">{data.label}</span>
        {subFor(data) && <span className="sub">{subFor(data)}</span>}
      </div>
      {data.hiddenChildren > 0 && (
        <button
          className="expander nodrag"
          title={`Show ${data.hiddenChildren} more call${data.hiddenChildren > 1 ? 's' : ''} from here`}
          onClick={(e) => {
            e.stopPropagation();
            data.onExpand(data.id);
          }}
        >
          +{data.hiddenChildren}
        </button>
      )}
      <Handle type="source" position={Position.Right} />
    </div>
  );
});

const nodeTypes = { box: FlowBox };

function edgeStyle(kind: string, confidence: string): { stroke: string; dash?: string; width: number; opacity: number } {
  const stroke =
    kind === 'reads' || kind === 'writes' ? 'var(--role-table)' : kind === 'http' ? 'var(--role-external)' : kind === 'publishes' || kind === 'subscribes' || kind === 'uses' ? 'var(--role-channel)' : 'var(--border-strong)';
  if (confidence === 'guess') return { stroke, dash: '2 4', width: 1.3, opacity: 0.6 };
  if (confidence === 'likely') return { stroke, dash: '6 4', width: 1.5, opacity: 0.9 };
  return { stroke, width: 1.6, opacity: 1 };
}

function Canvas({ rootId }: { rootId: string }) {
  const prefs = useStore((s) => s.flowPrefs);
  const setPrefs = useStore((s) => s.setFlowPrefs);
  const expanded = useStore((s) => s.expanded[rootId]);
  const toggleExpanded = useStore((s) => s.toggleExpanded);
  const selected = useStore((s) => s.selected);
  const select = useStore((s) => s.select);
  const dive = useStore((s) => s.dive);
  const [graph, setGraph] = useState<FlowGraph | null>(null);
  const [positions, setPositions] = useState<Map<string, { x: number; y: number }>>(new Map());
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const rf = useReactFlow();
  const lastRoot = useRef<string>('');
  const wrapRef = useRef<HTMLDivElement>(null);

  /** Fit small flows to the screen; for big ones keep text readable and start at the root on the left. */
  const smartFit = useCallback(
    (g: FlowGraph, pos: Map<string, { x: number; y: number }>, animate: boolean) => {
      const el = wrapRef.current;
      if (!el || !g.nodes.length) return;
      const W = el.clientWidth;
      const H = el.clientHeight;
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (const n of g.nodes) {
        const p = pos.get(n.id) ?? { x: 0, y: 0 };
        minX = Math.min(minX, p.x);
        minY = Math.min(minY, p.y);
        maxX = Math.max(maxX, p.x + nodeWidth(n));
        maxY = Math.max(maxY, p.y + NODE_H);
      }
      const pad = 48;
      const fit = Math.min(1.05, (W - pad * 2) / Math.max(1, maxX - minX), (H - pad * 2 - 40) / Math.max(1, maxY - minY));
      const duration = animate ? 250 : 0;
      if (fit >= MIN_READABLE_ZOOM) {
        rf.setViewport({ x: (W - (maxX - minX) * fit) / 2 - minX * fit, y: (H - (maxY - minY) * fit) / 2 - minY * fit, zoom: fit }, { duration });
        return;
      }
      const z = MIN_READABLE_ZOOM;
      const root = pos.get(g.rootId) ?? { x: minX, y: minY };
      const graphH = (maxY - minY) * z;
      const y = graphH + pad * 2 < H ? (H - graphH) / 2 - minY * z : H / 2 - (root.y + NODE_H / 2) * z;
      rf.setViewport({ x: pad - minX * z, y, zoom: z }, { duration });
    },
    [rf],
  );

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    api
      .flow(rootId, { depth: prefs.depth, expanded: expanded ?? [], hideGuesses: prefs.hideGuesses, showTrivial: prefs.showTrivial })
      .then(async (g) => {
        const pos = await layoutGraph(
          g.nodes.map((n) => ({ id: n.id, width: nodeWidth(n), height: NODE_H })),
          g.edges.map((e) => ({ id: e.id, from: e.from, to: e.to })),
          { layerGap: 56, nodeGap: 14 },
        );
        if (cancelled) return;
        setGraph(g);
        setPositions(pos);
        setLoading(false);
        const rootChanged = lastRoot.current !== rootId;
        lastRoot.current = rootId;
        requestAnimationFrame(() => smartFit(g, pos, !rootChanged));
      })
      .catch((e) => {
        if (!cancelled) {
          setError(String(e.message ?? e));
          setLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [rootId, prefs.depth, prefs.hideGuesses, prefs.showTrivial, expanded, smartFit]);

  const onExpand = useCallback((id: string) => toggleExpanded(id), [toggleExpanded]);

  const nodes: Node<FlowNodeData>[] = useMemo(() => {
    if (!graph) return [];
    return graph.nodes.map((n) => ({
      id: n.id,
      type: 'box',
      position: positions.get(n.id) ?? { x: 0, y: 0 },
      data: { ...n, selected: n.id === selected, onExpand, isRoot: n.id === graph.rootId },
      style: { width: nodeWidth(n), height: NODE_H },
      draggable: true,
    }));
  }, [graph, positions, selected, onExpand]);

  const edges: Edge[] = useMemo(() => {
    if (!graph) return [];
    return graph.edges.map((e) => {
      const st = edgeStyle(e.kind, e.confidence);
      const highlighted = e.from === selected || e.to === selected;
      return {
        id: e.id,
        source: e.from,
        target: e.to,
        type: 'smoothstep',
        label: e.label,
        animated: false,
        markerEnd: { type: MarkerType.ArrowClosed, width: 14, height: 14, color: highlighted ? 'var(--accent)' : st.stroke },
        style: { stroke: highlighted ? 'var(--accent)' : st.stroke, strokeWidth: highlighted ? 2.2 : st.width, strokeDasharray: st.dash, opacity: st.opacity },
        labelStyle: { fill: 'var(--text-dim)', fontSize: 10 },
        labelBgStyle: { fill: 'var(--bg)' },
        zIndex: highlighted ? 2 : 0,
        data: { confidence: e.confidence },
      } satisfies Edge;
    });
  }, [graph, selected]);

  const nodeById = useMemo(() => new Map(graph?.nodes.map((n) => [n.id, n]) ?? []), [graph]);

  const openNode = (id: string) => {
    const n = nodeById.get(id);
    if (!n) return;
    if (n.kind === 'symbol' && n.file) dive({ id: n.id, label: n.label, role: n.role, file: n.file, line: n.line });
    else if (n.kind === 'entry' && n.file) dive({ id: n.id, label: n.label, role: n.role, file: n.file, line: n.line });
  };

  return (
    <div className="flow-wrap" ref={wrapRef}>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        onNodeClick={(_, n) => select(n.id)}
        onNodeDoubleClick={(_, n) => openNode(n.id)}
        onPaneClick={() => select(undefined)}
        minZoom={0.15}
        maxZoom={2}
        proOptions={{ hideAttribution: true }}
        nodesConnectable={false}
        elementsSelectable={false}
        onlyRenderVisibleElements
      >
        <Background gap={22} size={1.2} color="var(--canvas-dot)" />
        <Controls showInteractive={false} position="bottom-right" />
        {graph && graph.nodes.length > 25 && <MiniMap pannable zoomable nodeColor={(n) => roleColor((n.data as FlowNodeData).role)} maskColor="rgba(0,0,0,0.25)" position="top-left" style={{ width: 150, height: 100 }} />}
      </ReactFlow>
      <div className="flow-toolbar">
        <label className="toggle" title="How many calls deep to show before you expand nodes by hand">
          Depth
          <select className="select" value={prefs.depth} onChange={(e) => setPrefs({ depth: Number(e.target.value) })}>
            {[1, 2, 3, 4, 5, 6, 8].map((d) => (
              <option key={d} value={d}>
                {d}
              </option>
            ))}
          </select>
        </label>
        <label className="toggle" title={CONFIDENCE.guess.explain}>
          <input type="checkbox" checked={prefs.hideGuesses} onChange={(e) => setPrefs({ hideGuesses: e.target.checked })} />
          Hide guesses
        </label>
        <label className="toggle" title="Getters, setters and other one-line helpers are hidden by default because they rarely explain the flow">
          <input type="checkbox" checked={prefs.showTrivial} onChange={(e) => setPrefs({ showTrivial: e.target.checked })} />
          Getters/setters
        </label>
        <button className="icon-btn" title="Fit everything on screen" aria-label="Fit to screen" onClick={() => rf.fitView({ padding: 0.12, duration: 250 })}>
          <IconFit />
        </button>
        {loading && <span className="spinner" aria-label="Loading" />}
      </div>
      <div className="flow-legend">
        <span>
          <b style={{ color: 'var(--text)' }}>Click</b> a box to inspect it · <b style={{ color: 'var(--text)' }}>double-click</b> to read its code
        </span>
        <span title={CONFIDENCE.certain.explain}>── certain</span>
        <span title={CONFIDENCE.likely.explain}>- - likely</span>
        <span title={CONFIDENCE.guess.explain} style={{ opacity: 0.75 }}>
          ··· guess
        </span>
        {graph?.truncated && <span style={{ color: 'var(--warn)' }}>Flow is large; some branches are collapsed.</span>}
      </div>
      {error && (
        <div className="welcome">
          <div className="error-banner">{error}</div>
        </div>
      )}
      {graph && graph.nodes.length <= 1 && !loading && (
        <div className="welcome" style={{ position: 'absolute', inset: 0, pointerEvents: 'none' }}>
          <div className="welcome-card">
            <h3>No calls found from here</h3>
            <p>This entry point does not call any other code in this project that could be traced statically. Double-click it to read its code.</p>
          </div>
        </div>
      )}
    </div>
  );
}

export function FlowCanvas({ rootId }: { rootId: string }) {
  return (
    <ReactFlowProvider>
      <Canvas rootId={rootId} />
    </ReactFlowProvider>
  );
}
