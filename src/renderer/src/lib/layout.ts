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
  opts: { direction?: 'RIGHT' | 'DOWN'; layerGap?: number; nodeGap?: number; partitions?: boolean } = {},
): Promise<Map<string, { x: number; y: number }>> {
  const ids = new Set(nodes.map((n) => n.id));
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
      'elk.spacing.componentComponent': '40',
      ...(opts.partitions ? { 'elk.partitioning.activate': 'true' } : {}),
    },
    children: nodes.map((n) => ({
      id: n.id,
      width: n.width,
      height: n.height,
      ...(opts.partitions && n.partition !== undefined ? { layoutOptions: { 'elk.partitioning.partition': String(n.partition) } } : {}),
    })),
    edges: edges.filter((e) => ids.has(e.from) && ids.has(e.to) && e.from !== e.to).map((e) => ({ id: e.id, sources: [e.from], targets: [e.to] })),
  };
  const res = await elk.layout(graph);
  const out = new Map<string, { x: number; y: number }>();
  for (const c of res.children ?? []) out.set(c.id, { x: c.x ?? 0, y: c.y ?? 0 });
  return out;
}

export interface MeasuredLayout {
  key: string;
  pos: Map<string, { x: number; y: number }>;
  sizes: Map<string, { w: number; h: number }>;
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
    layoutGraph(
      nodeIds.map((id) => ({ id, width: sizes.get(id)!.w, height: sizes.get(id)!.h, partition: partitionOf?.(id) })),
      edges,
      opts,
    )
      .then((pos) => {
        if (running.current === graphKey) setState({ key: graphKey, pos, sizes });
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
