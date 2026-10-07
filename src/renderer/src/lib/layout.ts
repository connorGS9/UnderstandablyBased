import { useEffect, useRef, useState } from 'react';
import { useReactFlow, useStore as useFlowStore } from '@xyflow/react';
import ELK from 'elkjs/lib/elk.bundled.js';

const elk = new ELK();

export interface LayoutNode {
  id: string;
  width: number;
  height: number;
  /** Column hint (lower = further left). Used for architecture diagrams. */
  partition?: number;
}
export interface LayoutEdge {
  id: string;
  from: string;
  to: string;
  /** Handle ids the edge attaches to (e.g. one table column), so routes end exactly there. */
  fromPort?: string;
  toPort?: string;
}

export type Point = { x: number; y: number };
/** Where an attachment point sits on a node, relative to its top-left corner. */
export type PortSpec = { id: string; x: number; y: number; side: 'EAST' | 'WEST' | 'NORTH' | 'SOUTH' };

export interface GraphLayout {
  pos: Map<string, Point>;
  /** Orthogonal edge routes that run between boxes rather than across them. */
  routes: Map<string, Point[]>;
}

let canvas: HTMLCanvasElement | null = null;
/** Measure label text so boxes fit their content instead of guessing from character counts. */
export function textWidth(text: string, font = '600 12.5px Inter, system-ui, sans-serif'): number {
  canvas ??= document.createElement('canvas');
  const ctx = canvas.getContext('2d')!;
  ctx.font = font;
  return ctx.measureText(text).width;
}

export async function layoutGraph(
  nodes: LayoutNode[],
  edges: LayoutEdge[],
  opts: { direction?: 'RIGHT' | 'DOWN'; layerGap?: number; nodeGap?: number; partitions?: boolean; ports?: Map<string, PortSpec[]>; aspectRatio?: number; componentGap?: number } = {},
): Promise<GraphLayout> {
  const ids = new Set(nodes.map((n) => n.id));
  const portId = (node: string, handle: string) => `${node}::${handle}`;
  const hasPort = (node: string, handle?: string) => !!handle && !!opts.ports?.get(node)?.some((p) => p.id === handle);
  const graph = {
    id: 'root',
    layoutOptions: {
      'elk.algorithm': 'layered',
      'elk.direction': opts.direction ?? 'RIGHT',
      'elk.layered.spacing.nodeNodeBetweenLayers': String(opts.layerGap ?? 80),
      'elk.spacing.nodeNode': String(opts.nodeGap ?? 18),
      'elk.layered.nodePlacement.strategy': 'BRANDES_KOEPF',
      'elk.layered.crossingMinimization.strategy': 'LAYER_SWEEP',
      'elk.layered.cycleBreaking.strategy': 'DEPTH_FIRST',
      'elk.layered.considerModelOrder.strategy': 'NODES_AND_EDGES',
      // With column partitions every component must share the same columns, so lay them out together.
      'elk.separateConnectedComponents': opts.partitions ? 'false' : 'true',
      'elk.spacing.componentComponent': String(opts.componentGap ?? 40),
      // Unconnected clusters are packed into rows that roughly match a screen's shape.
      'elk.aspectRatio': String(opts.aspectRatio ?? 1.6),
      // Leave room between parallel lines and around boxes so routes stay readable.
      'elk.edgeRouting': 'ORTHOGONAL',
      'elk.layered.spacing.edgeEdgeBetweenLayers': '8',
      'elk.layered.spacing.edgeNodeBetweenLayers': '16',
      'elk.spacing.edgeNode': '14',
      'elk.spacing.edgeEdge': '8',
      ...(opts.partitions ? { 'elk.partitioning.activate': 'true' } : {}),
    },
    children: nodes.map((n) => {
      const ports = opts.ports?.get(n.id);
      return {
        id: n.id,
        width: n.width,
        height: n.height,
        layoutOptions: {
          ...(opts.partitions && n.partition !== undefined ? { 'elk.partitioning.partition': String(n.partition) } : {}),
          ...(ports?.length ? { 'elk.portConstraints': 'FIXED_POS' } : {}),
        },
        ports: ports?.map((p) => ({ id: portId(n.id, p.id), x: p.x, y: p.y, width: 0, height: 0, layoutOptions: { 'elk.port.side': p.side } })),
      };
    }),
    edges: edges
      .filter((e) => ids.has(e.from) && ids.has(e.to) && e.from !== e.to)
      .map((e) => ({ id: e.id, sources: [hasPort(e.from, e.fromPort) ? portId(e.from, e.fromPort!) : e.from], targets: [hasPort(e.to, e.toPort) ? portId(e.to, e.toPort!) : e.to] })),
  };
  const res = await elk.layout(graph);
  const pos = new Map<string, Point>();
  for (const c of res.children ?? []) pos.set(c.id, { x: c.x ?? 0, y: c.y ?? 0 });
  const routes = new Map<string, Point[]>();
  for (const e of (res.edges ?? []) as { id: string; sections?: { startPoint: Point; endPoint: Point; bendPoints?: Point[] }[] }[]) {
    const sec = e.sections?.[0];
    if (sec) routes.set(e.id, [sec.startPoint, ...(sec.bendPoints ?? []), sec.endPoint]);
  }
  return { pos, routes };
}

export interface MeasuredLayout {
  key: string;
  pos: Map<string, Point>;
  sizes: Map<string, { w: number; h: number }>;
  routes: Map<string, Point[]>;
}

/**
 * Lay out a React Flow graph using the sizes the browser actually rendered (so labels always fit,
 * whatever fonts the OS has). Nodes render invisibly first, get measured, then ELK positions them.
 * `graphKey` must change whenever the set of nodes changes.
 */
export function useMeasuredLayout(
  graphKey: string | null,
  nodeIds: string[],
  edges: LayoutEdge[],
  opts: Parameters<typeof layoutGraph>[2],
  partitionOf?: (id: string) => number | undefined,
): MeasuredLayout | null {
  const rf = useReactFlow();
  // Count of nodes the browser has measured. Read from React Flow's internal store because measured
  // sizes are not written back to controlled nodes; this also re-renders us when measuring finishes.
  const measuredCount = useFlowStore((s) => {
    let c = 0;
    for (const n of s.nodeLookup.values()) if (n.measured?.width && n.measured?.height) c++;
    return c;
  });
  const [state, setState] = useState<MeasuredLayout | null>(null);
  const running = useRef<string | null>(null);

  useEffect(() => {
    if (!graphKey || state?.key === graphKey || running.current === graphKey || measuredCount < nodeIds.length) return;
    const ns = nodeIds.map((id) => rf.getInternalNode(id));
    if (ns.some((n) => !n?.measured?.width || !n.measured.height)) return;
    running.current = graphKey;
    const sizes = new Map(ns.map((n) => [n!.id, { w: Math.ceil(n!.measured.width!), h: Math.ceil(n!.measured.height!) }]));
    // Edges that name a handle get a fixed port where the browser drew that handle (e.g. a table column).
    let ports: Map<string, PortSpec[]> | undefined;
    if (edges.some((e) => e.fromPort || e.toPort)) {
      ports = new Map();
      for (const n of ns) {
        const hb = n!.internals.handleBounds;
        const list: PortSpec[] = [];
        for (const h of [...(hb?.source ?? []), ...(hb?.target ?? [])]) {
          if (!h.id) continue;
          const side = h.position === 'left' ? 'WEST' : h.position === 'right' ? 'EAST' : h.position === 'top' ? 'NORTH' : 'SOUTH';
          list.push({ id: h.id, x: side === 'EAST' ? sizes.get(n!.id)!.w : side === 'WEST' ? 0 : h.x + h.width / 2, y: side === 'SOUTH' ? sizes.get(n!.id)!.h : side === 'NORTH' ? 0 : h.y + h.height / 2, side });
        }
        if (list.length) ports.set(n!.id, list);
      }
    }
    layoutGraph(
      nodeIds.map((id) => ({ id, width: sizes.get(id)!.w, height: sizes.get(id)!.h, partition: partitionOf?.(id) })),
      edges,
      { ...opts, ports },
    )
      .then(({ pos, routes }) => {
        if (running.current === graphKey) setState({ key: graphKey, pos, sizes, routes });
      })
      .catch((e) => console.error('layout failed', e))
      .finally(() => {
        if (running.current === graphKey) running.current = null;
      });
  });

  return state?.key === graphKey ? state : null;
}

/** Bounding box of a laid-out graph. */
export function boundsOf(l: MeasuredLayout) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const [id, p] of l.pos) {
    const s = l.sizes.get(id) ?? { w: 0, h: 0 };
    minX = Math.min(minX, p.x);
    minY = Math.min(minY, p.y);
    maxX = Math.max(maxX, p.x + s.w);
    maxY = Math.max(maxY, p.y + s.h);
  }
  return { minX, minY, maxX, maxY };
}
