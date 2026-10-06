import path from 'node:path';
import type { DiagramEdge, DiagramNode, Diagrams, EdgeKind, Role, RouteTreeNode } from './types';
import type { Project } from './project';

const posix = path.posix;
const MAX_COMPONENTS = 90;

function majorityRole(roles: Role[]): Role {
  const counts = new Map<Role, number>();
  for (const r of roles) if (r !== 'other') counts.set(r, (counts.get(r) ?? 0) + 1);
  let best: Role = 'other';
  let n = 0;
  for (const [r, c] of counts) if (c > n) [best, n] = [r, c];
  return best;
}

export function buildDiagrams(p: Project): Diagrams {
  return {
    dataflow: dataflow(p),
    modules: modules(p),
    database: database(p),
    routes: routeTree(p),
  };
}

function dataflow(p: Project): Diagrams['dataflow'] {
  const g = p.graph;
  const hasEntries = p.entries.some((e) => e.handlerId && e.kind !== 'channel');
  const inScope = (id: string) => {
    const s = g.symbols.get(id);
    if (!s || s.role === 'test') return false;
    return hasEntries ? !!p.reachOf(id) : true;
  };

  // When grouping by directory, cut paths at a depth that keeps the number of boxes readable.
  let dirDepth = 99;
  const dirOf = (file: string) => posix.dirname(file).split('/').slice(0, dirDepth).join('/');
  const compOfSymbol = (id: string, byDir: boolean): string | undefined => {
    if (id.startsWith('file:')) return byDir ? `dir:${dirOf(id.slice(5))}` : id;
    const s = g.symbols.get(id);
    if (!s) return p.sinks.nodes.has(id) ? id : undefined;
    if (byDir) return `dir:${dirOf(s.file)}`;
    if (s.kind === 'class' || s.kind === 'interface' || s.kind === 'struct') return s.id;
    if (s.containerId) return s.containerId;
    return `file:${s.file}`;
  };

  const build = (byDir: boolean) => {
    const nodes = new Map<string, DiagramNode & { roles: Role[] }>();
    const edges = new Map<string, DiagramEdge>();
    const ensure = (cid: string): (DiagramNode & { roles: Role[] }) | undefined => {
      let n = nodes.get(cid);
      if (n) return n;
      if (p.sinks.nodes.has(cid)) {
        const sk = p.sinks.nodes.get(cid)!;
        n = { id: cid, label: sk.label, sublabel: sk.detail, role: sk.kind === 'table' ? 'table' : sk.kind === 'channel' ? 'channel' : 'external', roles: [], target: sk.kind === 'channel' ? `channel:${cid}` : undefined };
      } else if (cid.startsWith('dir:')) {
        const d = cid.slice(4);
        n = { id: cid, label: d === '.' ? '(root)' : d.split('/').slice(-2).join('/'), sublabel: d, role: 'other', roles: [], size: 0 };
      } else if (cid.startsWith('file:')) {
        const f = cid.slice(5);
        n = { id: cid, label: posix.basename(f), sublabel: posix.dirname(f), role: 'other', roles: [], size: 0, target: undefined };
      } else {
        const s = g.symbols.get(cid);
        if (!s) return undefined;
        n = { id: cid, label: s.name, sublabel: s.file, role: s.role ?? 'other', roles: [], size: 0, target: s.id };
      }
      nodes.set(cid, n);
      return n;
    };
    const addEdge = (from: string, to: string, kind: EdgeKind) => {
      if (from === to) return;
      const id = `${from}->${to}`;
      const e = edges.get(id);
      if (e) e.weight++;
      else edges.set(id, { id, from, to, kind, weight: 1 });
    };

    // Entry groups on the far left
    const groups = new Map<string, { count: number; handlers: Set<string>; kind: string }>();
    for (const e of p.entries) {
      if (!e.handlerId || e.kind === 'channel') continue;
      const gid = `entries:${e.kind}:${e.group}`;
      const gr = groups.get(gid) ?? { count: 0, handlers: new Set(), kind: e.kind };
      gr.count++;
      gr.handlers.add(e.handlerId);
      for (const m of e.middleware ?? []) if (m.id) gr.handlers.add(m.id);
      groups.set(gid, gr);
    }
    for (const [gid, gr] of groups) {
      const name = gid.split(':').slice(2).join(':');
      const noun = gr.kind === 'http-route' ? 'route' : gr.kind === 'page' ? 'page' : gr.kind === 'process' ? 'process' : 'job';
      nodes.set(gid, { id: gid, label: name, sublabel: `${gr.count} ${noun}${gr.count > 1 ? 's' : ''}`, role: gr.kind === 'page' ? 'page' : gr.kind === 'http-route' ? 'route' : 'entry', roles: [], size: gr.count });
      for (const h of gr.handlers) {
        const c = compOfSymbol(h, byDir);
        if (c && ensure(c)) addEdge(gid, c, 'calls');
      }
    }

    for (const s of g.symbols.values()) {
      if (!inScope(s.id)) continue;
      const from = compOfSymbol(s.id, byDir);
      if (!from) continue;
      const fn = ensure(from);
      if (!fn) continue;
      fn.roles.push(s.role ?? 'other');
      fn.size = (fn.size ?? 0) + 1;
      for (const c of p.calleesFor(s.id)) {
        if (!p.sinks.nodes.has(c.to) && !inScope(c.to)) continue;
        const to = compOfSymbol(c.to, byDir);
        if (!to || !ensure(to)) continue;
        addEdge(from, to, c.kind);
      }
    }
    // file: entry roots (top-level scripts)
    for (const e of p.entries) {
      if (e.handlerId?.startsWith('file:')) {
        const from = compOfSymbol(e.handlerId, byDir)!;
        const fn = ensure(from);
        if (!fn) continue;
        fn.roles.push('entry');
        for (const c of p.calleesFor(e.handlerId)) {
          const to = compOfSymbol(c.to, byDir);
          if (to && ensure(to)) addEdge(from, to, c.kind);
        }
      }
    }
    for (const n of nodes.values()) {
      if ((n.id.startsWith('file:') || n.id.startsWith('dir:')) && n.roles.length) n.role = majorityRole(n.roles);
      if (n.target === undefined && n.id.startsWith('file:')) n.target = undefined;
    }
    return { nodes, edges };
  };

  let mode = 'components';
  let res = build(false);
  const compCount = [...res.nodes.values()].filter((n) => !p.sinks.nodes.has(n.id) && !n.id.startsWith('entries:')).length;
  let note: string | undefined;
  if (compCount > MAX_COMPONENTS) {
    const files = [...new Set([...g.symbols.values()].filter((s) => inScope(s.id)).map((s) => s.file))];
    for (dirDepth = 8; dirDepth > 1; dirDepth--) {
      if (new Set(files.map(dirOf)).size <= MAX_COMPONENTS) break;
    }
    res = build(true);
    mode = 'directories';
    note = `${compCount} components were grouped by folder to keep the diagram readable.`;
  }
  // Drop isolated nodes (no edges) unless they're sinks/entries
  const connected = new Set<string>();
  for (const e of res.edges.values()) {
    connected.add(e.from);
    connected.add(e.to);
  }
  const nodes = [...res.nodes.values()].filter((n) => connected.has(n.id)).map(({ roles: _r, ...n }) => n);
  return { nodes, edges: [...res.edges.values()], mode, note };
}

function modules(p: Project): Diagrams['modules'] {
  const g = p.graph;
  const files = [...g.facts.keys()].filter((f) => {
    const syms = g.symbolsByFile.get(f) ?? [];
    return !syms.length || syms.some((s) => s.role !== 'test');
  });
  // Skip the shared directory prefix (src/main/java/com/acme/...) so modules are the meaningful folders.
  const dirs = files.map((f) => posix.dirname(f).split('/'));
  let common = 0;
  if (dirs.length > 1) {
    while (dirs.every((d) => d.length > common + 1 && d[common] === dirs[0][common])) common++;
  }
  let depth = 1;
  const groupAt = (f: string, d: number) => {
    const parts = posix.dirname(f).split('/');
    if (parts[0] === '.') return '(root)';
    return parts.slice(0, Math.min(parts.length, common + d)).join('/');
  };
  for (let d = 1; d <= 6; d++) {
    const count = new Set(files.map((f) => groupAt(f, d))).size;
    depth = d;
    if (count >= 8) break;
  }
  while (depth > 1 && new Set(files.map((f) => groupAt(f, depth))).size > 45) depth--;
  const nodes = new Map<string, DiagramNode & { roles: Role[] }>();
  const edges = new Map<string, DiagramEdge>();
  for (const f of files) {
    const m = groupAt(f, depth);
    const n = nodes.get(m) ?? { id: `mod:${m}`, label: m.split('/').slice(-2).join('/'), sublabel: m, role: 'other', roles: [], size: 0 };
    n.size = (n.size ?? 0) + 1;
    for (const s of g.symbolsByFile.get(f) ?? []) n.roles.push(s.role ?? 'other');
    nodes.set(m, n);
  }
  const add = (a: string, b: string, kind: EdgeKind) => {
    if (a === b || !nodes.has(a) || !nodes.has(b)) return;
    const id = `mod:${a}->mod:${b}`;
    const e = edges.get(id);
    if (e) e.weight++;
    else edges.set(id, { id, from: `mod:${a}`, to: `mod:${b}`, kind, weight: 1 });
  };
  for (const f of files) {
    const from = groupAt(f, depth);
    for (const imp of g.importsByFile.get(f)?.values() ?? []) for (const r of imp.resolved ?? []) add(from, groupAt(r, depth), 'uses');
    for (const rc of g.resolvedByFile.get(f) ?? []) {
      for (const t of rc.targets) {
        const ts = g.symbols.get(t);
        if (ts) add(from, groupAt(ts.file, depth), 'calls');
      }
    }
  }
  for (const n of nodes.values()) n.role = majorityRole(n.roles);
  return { nodes: [...nodes.values()].map(({ roles: _r, ...n }) => n), edges: [...edges.values()] };
}

function database(p: Project): Diagrams['database'] {
  const usage: Diagrams['database']['usage'] = {};
  for (const [from, list] of p.sinks.edges) {
    for (const e of list) {
      const node = p.sinks.nodes.get(e.to);
      if (node?.kind !== 'table') continue;
      const s = p.graph.symbols.get(from);
      if (!s || s.role === 'test') continue;
      const key = node.label.toLowerCase();
      (usage[key] ??= []).push({ id: from, name: s.container ? `${s.container}.${s.name}` : s.name, kind: e.kind });
    }
  }
  // Tables referenced from queries but not declared anywhere still deserve a box.
  const declared = new Set(p.tables.map((t) => t.name.toLowerCase()));
  const tables = [...p.tables];
  for (const n of p.sinks.nodes.values()) {
    if (n.kind === 'table' && !declared.has(n.label.toLowerCase())) {
      tables.push({ name: n.label, columns: [], indexes: [], source: { kind: 'referenced in code only', file: '', line: 0 } });
    }
  }
  return { tables, usage };
}

function routeTree(p: Project): RouteTreeNode {
  const root: RouteTreeNode = { segment: '/', fullPath: '/', routes: [], children: [] };
  for (const e of p.entries) {
    if ((e.kind !== 'http-route' && e.kind !== 'page') || !e.path) continue;
    const segs = e.path.split('/').filter(Boolean);
    let cur = root;
    let acc = '';
    for (const s of segs) {
      acc += '/' + s;
      let child = cur.children.find((c) => c.segment === s);
      if (!child) {
        child = { segment: s, fullPath: acc, routes: [], children: [] };
        cur.children.push(child);
      }
      cur = child;
    }
    cur.routes.push({ id: e.id, method: e.kind === 'page' ? 'PAGE' : e.method ?? 'ANY', handlerName: e.handlerName });
  }
  const sort = (n: RouteTreeNode) => {
    n.children.sort((a, b) => a.segment.localeCompare(b.segment));
    n.children.forEach(sort);
  };
  sort(root);
  return root;
}
