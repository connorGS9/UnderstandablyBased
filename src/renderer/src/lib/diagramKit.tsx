import { memo, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { BaseEdge, getSmoothStepPath, useInternalNode, useReactFlow, type Edge, type EdgeProps } from '@xyflow/react';
import type { Point } from './layout';

/**
 * Shared tools that keep big diagrams readable:
 *  - RoutedEdge draws the route the layout engine planned between boxes instead of a straight cut across them;
 *  - useDiagramFocus highlights what a box connects to (hover or click), N hops out, and can isolate it;
 *  - DiagramToolbar finds a box by name and holds the focus controls.
 */

// ---------------- routed edges ----------------

export type RoutedEdgeData = {
  /** Planned route, in diagram coordinates. */
  points?: Point[];
  /** Where both boxes were when the route was planned; if either moved (dragged), fall back to a step line. */
  at?: { s: Point; t: Point };
} & Record<string, unknown>;

const near = (a: Point, b: Point) => Math.abs(a.x - b.x) < 1 && Math.abs(a.y - b.y) < 1;

/** A polyline with rounded corners, plus the point halfway along it for the label. */
function roundedPath(pts: Point[], radius = 8): [string, number, number] {
  let d = `M ${pts[0].x} ${pts[0].y}`;
  for (let i = 1; i < pts.length - 1; i++) {
    const p = pts[i - 1];
    const c = pts[i];
    const n = pts[i + 1];
    const r = Math.min(radius, Math.hypot(c.x - p.x, c.y - p.y) / 2, Math.hypot(n.x - c.x, n.y - c.y) / 2);
    const a = toward(c, p, r);
    const b = toward(c, n, r);
    d += ` L ${a.x} ${a.y} Q ${c.x} ${c.y} ${b.x} ${b.y}`;
  }
  const last = pts[pts.length - 1];
  d += ` L ${last.x} ${last.y}`;
  // Label at the middle of the route by length.
  const lens = pts.slice(1).map((q, i) => Math.hypot(q.x - pts[i].x, q.y - pts[i].y));
  let half = lens.reduce((x, y) => x + y, 0) / 2;
  for (let i = 0; i < lens.length; i++) {
    if (half <= lens[i] || i === lens.length - 1) {
      const f = lens[i] ? Math.min(1, half / lens[i]) : 0;
      return [d, pts[i].x + (pts[i + 1].x - pts[i].x) * f, pts[i].y + (pts[i + 1].y - pts[i].y) * f];
    }
    half -= lens[i];
  }
  return [d, pts[0].x, pts[0].y];
}

function toward(from: Point, to: Point, dist: number): Point {
  const len = Math.hypot(to.x - from.x, to.y - from.y) || 1;
  return { x: from.x + ((to.x - from.x) / len) * dist, y: from.y + ((to.y - from.y) / len) * dist };
}

export const RoutedEdge = memo(function RoutedEdge(props: EdgeProps<Edge<RoutedEdgeData>>) {
  const { source, target, data, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, markerEnd, style, label, labelStyle, labelBgStyle, interactionWidth } = props;
  const s = useInternalNode(source);
  const t = useInternalNode(target);
  const pts = data?.points;
  const fresh = !!pts && pts.length >= 2 && !!data?.at && !!s && !!t && near(s.internals.positionAbsolute, data.at.s) && near(t.internals.positionAbsolute, data.at.t);
  const [path, lx, ly] = fresh ? roundedPath(pts!) : getSmoothStepPath({ sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition });
  return <BaseEdge path={path} markerEnd={markerEnd} style={style} label={label} labelX={lx} labelY={ly} labelStyle={labelStyle} labelBgStyle={labelBgStyle} interactionWidth={interactionWidth} />;
});

export const routedEdgeTypes = { routed: RoutedEdge };

/** Data for a routed edge from a finished layout. */
export function routeData(layout: { pos: Map<string, Point>; routes: Map<string, Point[]> } | null, id: string, from: string, to: string): RoutedEdgeData | undefined {
  const s = layout?.pos.get(from);
  const t = layout?.pos.get(to);
  const points = layout?.routes.get(id);
  return s && t && points ? { points, at: { s, t } } : undefined;
}

// ---------------- focus ----------------

export type LinesMode = 'all' | 'focus';

export interface DiagramFocus {
  selected: string | null;
  select: (id: string | null) => void;
  setHovered: (id: string | null) => void;
  hops: number;
  setHops: (n: number) => void;
  isolated: boolean;
  setIsolated: (v: boolean) => void;
  lines: LinesMode;
  setLines: (m: LinesMode) => void;
  /** Distance from the focused box for everything in focus; null when nothing is focused. */
  dist: Map<string, number> | null;
  inFocus: (id: string) => boolean;
  edgeInFocus: (from: string, to: string) => boolean;
  /** When isolated, the only ids to draw (the focused neighbourhood); otherwise null. Stable between renders. */
  isolatedSet: Set<string> | null;
}

/**
 * Focus for a diagram: hovering previews a box's direct connections, clicking pins the focus, and the
 * neighbourhood can grow to 2–3 hops or be isolated into its own small layout.
 * `relate` overrides how a neighbourhood is found (the route map follows the tree instead of any edge).
 */
export function useDiagramFocus(
  edges: { from: string; to: string }[],
  opts: {
    defaultLines?: LinesMode;
    relate?: (id: string, hops: number) => Map<string, number>;
    /** Boxes that join almost everything (a users table): shown in a focus, but not walked through. */
    barriers?: Set<string>;
  } = {},
): DiagramFocus {
  const [selected, setSelected] = useState<string | null>(null);
  const [hovered, setHovered] = useState<string | null>(null);
  const [hops, setHops] = useState(1);
  const [isolated, setIsolated] = useState(false);
  const [lines, setLines] = useState<LinesMode>(opts.defaultLines ?? 'all');
  const adj = useMemo(() => {
    const m = new Map<string, string[]>();
    for (const e of edges) {
      if (e.from === e.to) continue;
      m.set(e.from, [...(m.get(e.from) ?? []), e.to]);
      m.set(e.to, [...(m.get(e.to) ?? []), e.from]);
    }
    return m;
  }, [edges]);
  const focusId = selected ?? hovered;
  const depth = selected ? hops : 1;
  const relate = opts.relate;
  const barriers = opts.barriers;
  const dist = useMemo(() => {
    if (!focusId) return null;
    if (relate) return relate(focusId, depth);
    const d = new Map([[focusId, 0]]);
    let frontier = [focusId];
    for (let h = 1; h <= depth && frontier.length; h++) {
      const next: string[] = [];
      for (const id of frontier) {
        if (id !== focusId && barriers?.has(id)) continue;
        for (const n of adj.get(id) ?? []) if (!d.has(n)) (d.set(n, h), next.push(n));
      }
      frontier = next;
    }
    return d;
  }, [focusId, depth, adj, relate, barriers]);
  const isolatedSet = useMemo(() => (isolated && selected && dist ? new Set(dist.keys()) : null), [isolated, selected, dist]);
  return {
    selected,
    select: (id) => {
      setSelected(id);
      if (!id) setIsolated(false);
    },
    setHovered,
    hops,
    setHops,
    isolated: isolated && !!selected,
    setIsolated,
    lines,
    setLines,
    dist,
    inFocus: (id) => !dist || dist.has(id),
    // An edge is part of the focus when it joins two focused boxes and lies on a path out from the centre.
    edgeInFocus: (from, to) => !!dist && dist.has(from) && dist.has(to) && Math.min(dist.get(from)!, dist.get(to)!) < depth,
    isolatedSet,
  };
}

/** Escape steps back: closes isolation first, then clears the selection. */
export function useEscapeToClear(focus: DiagramFocus) {
  const ref = useRef(focus);
  ref.current = focus;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || (e.target as HTMLElement)?.closest?.('input, textarea, select, .palette')) return;
      const f = ref.current;
      if (f.isolated) f.setIsolated(false);
      else if (f.selected) f.select(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
}

// ---------------- toolbar ----------------

export interface FindItem {
  id: string;
  label: string;
  sub?: string;
}

/**
 * Top-left toolbar: find a box by name (Enter or click centres on it and focuses it), then widen the focus,
 * isolate it, or switch between all lines and only the focused box's lines.
 */
export function DiagramToolbar({ items, focus, onPick, noun, extra, linesToggle = true }: { items: FindItem[]; focus: DiagramFocus; onPick?: (id: string) => void; noun: string; extra?: ReactNode; linesToggle?: boolean }) {
  const rf = useReactFlow();
  const [q, setQ] = useState('');
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const matches = useMemo(() => {
    const s = q.trim().toLowerCase();
    if (!s) return [];
    const hits = items.filter((i) => i.label.toLowerCase().includes(s) || i.sub?.toLowerCase().includes(s));
    return hits.sort((a, b) => Number(!a.label.toLowerCase().startsWith(s)) - Number(!b.label.toLowerCase().startsWith(s)) || a.label.length - b.label.length).slice(0, 8);
  }, [q, items]);

  // "/" jumps to the find box, as in many code tools.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === '/' && !(e.target as HTMLElement)?.closest?.('input, textarea, select, [contenteditable]')) {
        e.preventDefault();
        inputRef.current?.focus();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const pick = (id: string) => {
    onPick?.(id);
    focus.select(id);
    setOpen(false);
    setQ('');
    inputRef.current?.blur();
    // Let the box render (it may have been hidden or collapsed) before centring on it.
    setTimeout(() => rf.fitView({ nodes: [{ id }], duration: 350, maxZoom: 1.1, padding: 0.8 }), 80);
  };

  return (
    <div className="diagram-tools" role="toolbar" aria-label="Diagram tools">
      <div className="find">
        <input
          ref={inputRef}
          className="input"
          placeholder={`Find a ${noun}…  /`}
          value={q}
          aria-label={`Find a ${noun}`}
          onChange={(e) => {
            setQ(e.target.value);
            setOpen(true);
            setActive(0);
          }}
          onFocus={() => setOpen(true)}
          onBlur={() => setTimeout(() => setOpen(false), 150)}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') {
              e.preventDefault();
              setActive((a) => Math.min(matches.length - 1, a + 1));
            } else if (e.key === 'ArrowUp') {
              e.preventDefault();
              setActive((a) => Math.max(0, a - 1));
            } else if (e.key === 'Enter' && matches[active]) pick(matches[active].id);
            else if (e.key === 'Escape') {
              setQ('');
              inputRef.current?.blur();
            }
          }}
        />
        {open && matches.length > 0 && (
          <div className="find-results" role="listbox">
            {matches.map((m, i) => (
              <button key={m.id} role="option" aria-selected={i === active} className={i === active ? 'active' : ''} onMouseDown={(e) => e.preventDefault()} onClick={() => pick(m.id)} onMouseEnter={() => setActive(i)}>
                <span className="ellipsis mono">{m.label}</span>
                {m.sub && <span className="faint ellipsis">{m.sub}</span>}
              </button>
            ))}
          </div>
        )}
        {open && q.trim() && matches.length === 0 && <div className="find-results faint" style={{ padding: 8 }}>No {noun} matches.</div>}
      </div>
      {focus.selected && (
        <>
          <div className="seg small" role="group" aria-label="How far to follow connections">
            {[1, 2, 3].map((h) => (
              <button key={h} className={focus.hops === h ? 'active' : ''} onClick={() => focus.setHops(h)} title={h === 1 ? 'Direct connections' : `Connections up to ${h} steps away`}>
                {h === 1 ? 'Direct' : `${h} hops`}
              </button>
            ))}
          </div>
          <button className={`btn small ${focus.isolated ? 'primary' : ''}`} onClick={() => focus.setIsolated(!focus.isolated)} title="Redraw only the focused part of the diagram (Esc to go back)">
            {focus.isolated ? 'Show everything' : 'Isolate'}
          </button>
          <button className="btn small ghost" onClick={() => focus.select(null)} title="Clear the focus (Esc)">
            Clear
          </button>
        </>
      )}
      {linesToggle && (
        <label className="toggle" title="On big diagrams, drawing every line hides more than it shows. Lines for the focused box are always drawn.">
          <input type="checkbox" checked={focus.lines === 'all'} onChange={(e) => focus.setLines(e.target.checked ? 'all' : 'focus')} />
          All lines
        </label>
      )}
      {extra}
    </div>
  );
}
