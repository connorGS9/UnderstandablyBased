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
