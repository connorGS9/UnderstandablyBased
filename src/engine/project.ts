import fs from 'node:fs/promises';
import path from 'node:path';
import { scanProject } from './scan';
import { extractFile } from './extract';
import { CodeGraph } from './graph';
import { assignRoles } from './roles';
import { extractOrmTables, mergeTables, parsePrisma, parseSql } from './db';
import { buildSinks, type SinkIndex } from './sinks';
import { extractEntries } from './routes';
import { detectProfile } from './detect';
import { buildDiagrams } from './diagrams';
import type {
  CallRef,
  CodeLink,
  CodeSymbol,
  Confidence,
  DbTable,
  Diagrams,
  EntryPoint,
  FileEntry,
  FileFacts,
  FileView,
  FlowEdge,
  FlowGraph,
  FlowNode,
  Progress,
  ProjectSummary,
  Role,
  SearchHit,
  SymbolDetail,
  SymbolRef,
} from './types';

const LARGE_PROJECT_FILES = 4000;

export interface FlowOptions {
  depth?: number;
  expanded?: string[];
  collapsed?: string[];
  hideGuesses?: boolean;
  /** Show getters/setters and other one-line accessors (hidden by default as noise). */
  showTrivial?: boolean;
  maxNodes?: number;
}

function stripJsonComments(s: string): string {
  // Remove // and /* */ comments outside strings, then trailing commas (tsconfig is JSONC).
  let out = '';
  let inStr = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (inStr) {
      out += ch;
      if (ch === '\\') out += s[++i] ?? '';
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') {
      inStr = true;
      out += ch;
    } else if (ch === '/' && s[i + 1] === '/') {
      while (i < s.length && s[i] !== '\n') i++;
      out += '\n';
    } else if (ch === '/' && s[i + 1] === '*') {
      i += 2;
      while (i < s.length && !(s[i] === '*' && s[i + 1] === '/')) i++;
      i++;
    } else out += ch;
  }
  return out.replace(/,(\s*[}\]])/g, '$1');
}

function parseJsonLoose(text: string): any {
  try {
    return JSON.parse(stripJsonComments(text));
  } catch {
    return undefined;
  }
}

export class Project {
  root = '';
  name = '';
  files: FileEntry[] = [];
  graph!: CodeGraph;
  tables: DbTable[] = [];
  sinks!: SinkIndex;
  entries: EntryPoint[] = [];
  entryById = new Map<string, EntryPoint>();
  summary!: ProjectSummary;
  private reach = new Map<string, Set<string>>();
  private diagrams?: Diagrams;

  static async open(root: string, onProgress?: (p: Progress) => void): Promise<Project> {
    const p = new Project();
    await p.load(root, onProgress);
    return p;
  }

  private async load(root: string, onProgress?: (p: Progress) => void) {
    const started = Date.now();
    this.root = path.resolve(root);
    this.name = path.basename(this.root);
    const warnings: string[] = [];
    const report = (phase: Progress['phase'], done: number, total: number, message: string) => onProgress?.({ phase, done, total, message });

    report('scan', 0, 0, 'Finding source files…');
    const scan = await scanProject(this.root, (n) => report('scan', n, 0, `Found ${n} source files…`));
    this.files = scan.files;
    if (scan.truncated) warnings.push(`Only the first ${scan.files.length} source files were analyzed.`);
    // Very large repositories: tests can be most of the code but rarely explain the architecture.
    const TEST_FILE = /(^|\/)(__tests__|__mocks__|tests?|spec|specs|testing|e2e|fixtures?)\/|\.(test|spec)\.[jt]sx?$|_test\.(go|py)$|(^|\/)test_[^/]+\.py$|Tests?\.(java|cs|kt)$/;
    let skipTests = false;
    if (this.files.length > LARGE_PROJECT_FILES) {
      const tests = this.files.filter((f) => TEST_FILE.test(f.path)).length;
      if (tests > 0) {
        skipTests = true;
        warnings.push(`This is a large project, so ${tests.toLocaleString()} test files were skipped to keep things fast.`);
      }
    }
    if (scan.skippedLarge) warnings.push(`${scan.skippedLarge} very large files were skipped.`);

    // Parse
    const allFacts: FileFacts[] = [];
    const total = this.files.length;
    let lastReport = 0;
    for (let i = 0; i < total; i++) {
      const fe = this.files[i];
      try {
        const src = await fs.readFile(path.join(this.root, fe.path), 'utf8');
        fe.lines = src.split('\n').length;
        if (fe.lang && !(skipTests && TEST_FILE.test(fe.path)) && !(fe.size > 300_000 && /^.{2000,}$/m.test(src.slice(0, 20000)))) {
          allFacts.push(await extractFile(fe.path, src, fe.lang));
        }
      } catch (e) {
        warnings.push(`Could not parse ${fe.path}: ${(e as Error).message}`);
      }
      if (Date.now() - lastReport > 80 || i === total - 1) {
        lastReport = Date.now();
        report('parse', i + 1, total, `Parsing ${fe.path}`);
      }
    }

    // Config/manifests
    report('resolve', 0, 1, 'Linking calls across files…');
    const readExtra = async (rel: string) => {
      try {
        return await fs.readFile(path.join(this.root, rel), 'utf8');
      } catch {
        return '';
      }
    };
    const manifests: { file: string; text: string }[] = [];
    const tsconfigs: { file: string; json: any }[] = [];
    const goMods: { file: string; text: string }[] = [];
    const pkgJsons: { file: string; json: any }[] = [];
    const sqlTables: DbTable[] = [];
    const prismaTables: DbTable[] = [];
    const extraIndexes: Parameters<typeof mergeTables>[1] = [];
    const fks: Parameters<typeof mergeTables>[2] = [];
    for (const rel of scan.extras) {
      const base = path.posix.basename(rel);
      const text = await readExtra(rel);
      if (!text) continue;
      if (base.endsWith('.sql')) {
        if (text.length > 3_000_000) continue;
        const r = parseSql(text, rel);
        sqlTables.push(...r.tables);
        extraIndexes.push(...r.extraIndexes);
        fks.push(...r.fks);
        continue;
      }
      if (base.endsWith('.prisma')) {
        prismaTables.push(...parsePrisma(text, rel));
        continue;
      }
      manifests.push({ file: rel, text: text.slice(0, 200_000) });
      if (base === 'tsconfig.json' || base === 'jsconfig.json') tsconfigs.push({ file: rel, json: parseJsonLoose(text) });
      if (base === 'go.mod') goMods.push({ file: rel, text });
      if (base === 'package.json') {
        const json = parseJsonLoose(text);
        if (json) pkgJsons.push({ file: rel, json });
      }
    }

    this.graph = new CodeGraph(this.root, allFacts, { tsconfigs, goMods });
    this.graph.resolveAll();
    report('analyze', 0, 1, 'Classifying code and finding entry points…');
    assignRoles(this.graph.symbols);

    const ormTables = extractOrmTables(this.graph);
    this.tables = mergeTables([sqlTables, prismaTables, ormTables], extraIndexes, fks);
    this.sinks = buildSinks(this.graph, this.tables);

    const allDeps = pkgJsons.map((p) => Object.keys({ ...(p.json.dependencies ?? {}), ...(p.json.devDependencies ?? {}) }).join(' ')).join(' ');
    const projectHasServerLib =
      /\b(express|koa|fastify|hono|restify|polka|@nestjs\/core|elysia)\b/.test(allDeps) || goMods.some((g) => /gin-gonic|labstack\/echo|go-chi|gorilla\/mux|gofiber/.test(g.text));
    const hasNext = /(^|\s)next(\s|$)/.test(allDeps);
    this.entries = extractEntries(this.graph, this.sinks, { pkgJsons, projectHasServerLib, hasNext });
    // Route handlers are controllers even when nothing else says so.
    for (const e of this.entries) {
      const s = e.handlerId ? this.graph.symbols.get(e.handlerId) : undefined;
      if (s && (!s.role || s.role === 'other' || s.role === 'util')) {
        s.role = e.kind === 'page' ? 'view' : e.kind === 'process' ? 'entry' : 'controller';
        s.roleReason = `handles ${e.label}`;
      }
    }
    this.entries.sort((a, b) => kindOrder(a.kind) - kindOrder(b.kind) || (a.path ?? a.label).localeCompare(b.path ?? b.label) || (a.method ?? '').localeCompare(b.method ?? ''));
    for (const e of this.entries) this.entryById.set(e.id, e);
    this.computeReach();

    const profile = detectProfile(this.graph, this.files, manifests, scan.extras, this.entries);
    this.releaseAnalysisData();
    const lines = this.files.reduce((a, f) => a + f.lines, 0);
    this.summary = {
      root: this.root,
      name: this.name,
      indexedAt: Date.now(),
      durationMs: Date.now() - started,
      profile,
      stats: {
        files: this.files.length,
        sourceFiles: allFacts.length,
        symbols: this.graph.symbols.size,
        calls: this.graph.stats.calls,
        resolvedCalls: this.graph.stats.resolved,
        lines,
        tables: this.tables.length + [...this.sinks.nodes.values()].filter((n) => n.kind === 'table' && !this.tables.some((t) => t.name.toLowerCase() === n.label.toLowerCase())).length,
      },
      entries: this.entries,
      files: this.files,
      warnings,
    };
    report('done', 1, 1, 'Ready');
  }

  /**
   * Call arguments, string literals and local variable facts are only needed while analyzing.
   * Dropping them roughly halves memory on large repositories.
   */
  private releaseAnalysisData() {
    for (const f of this.graph.facts.values()) {
      for (const c of f.calls) c.args = [];
      f.strings = [];
      f.vars = [];
      f.jsxRoutes = [];
    }
    this.graph.varsByScope.clear();
  }

  // ---------------- helpers ----------------

  /** `main` is ambiguous in multi-process repos; name it after its process ("main · feed"). */
  private displayName(s: CodeSymbol): string {
    if (s.name === 'main' || s.name === 'Main') {
      const proc = this.entries.find((e) => e.kind === 'process' && e.handlerId === s.id);
      if (proc && proc.label !== s.name) return `${s.name} · ${proc.label}`;
    }
    return s.name;
  }

  private ref(id: string): SymbolRef | undefined {
    const s = this.graph.symbols.get(id);
    if (s && s.kind === 'constructor') return { id, name: `new ${s.container ?? s.name}`, kind: s.kind, role: s.role ?? 'other', file: s.file, line: s.range.sl };
    if (s) return { id, name: this.displayName(s), container: s.container, kind: s.kind, role: s.role ?? 'other', file: s.file, line: s.range.sl };
    const sink = this.sinks.nodes.get(id);
    if (sink) return { id, name: sink.label, kind: sink.kind, role: sink.kind === 'table' ? 'table' : sink.kind === 'channel' ? 'channel' : 'external' };
    if (id.startsWith('file:')) return { id, name: `${path.posix.basename(id.slice(5))} (top level)`, kind: 'function', role: 'entry', file: id.slice(5), line: 1 };
    return undefined;
  }

  /** Getters, setters and other tiny leaf methods that add noise to a flow without explaining anything. */
  isTrivial(id: string): boolean {
    const s = this.graph.symbols.get(id);
    if (!s || (s.kind !== 'method' && s.kind !== 'function')) return false;
    if (s.range.el - s.range.sl > 3) return false;
    if (!/^(get|set|is|has|to|as)[A-Z_]|^__(str|repr|eq|hash)__$|^(toString|hashCode|equals|valueOf)$/.test(s.name)) return false;
    return !this.graph.callsFrom.get(id)?.length && !this.sinks.edges.get(id)?.length;
  }

  private calleesOf(id: string, hideGuesses = false, showTrivial = false): { to: string; line: number; confidence: Confidence; reason: string; kind: FlowEdge['kind'] }[] {
    const out: { to: string; line: number; confidence: Confidence; reason: string; kind: FlowEdge['kind'] }[] = [];
    const seen = new Set<string>();
    const sym = this.graph.symbols.get(id);
    // Classes only expand to their data sinks (e.g. repository -> table) to avoid pulling in every method.
    if (!sym || (sym.kind !== 'class' && sym.kind !== 'interface' && sym.kind !== 'struct')) {
      for (const rc of this.graph.callsFrom.get(id) ?? []) {
        if (hideGuesses && rc.confidence === 'guess') continue;
        for (const t of rc.targets) {
          if (seen.has(t)) continue;
          const ts = this.graph.symbols.get(t);
          if (ts?.role === 'test' && sym?.role !== 'test') continue;
          if (!showTrivial && this.isTrivial(t)) continue;
          seen.add(t);
          out.push({ to: t, line: rc.site.range.sl, confidence: rc.confidence, reason: rc.reason, kind: 'calls' });
        }
      }
    } else if (sym.role === 'controller') {
      // Class-based views/controllers (Django View, DRF ViewSet, Flask MethodView): the framework calls these methods.
      for (const m of this.graph.membersByContainer.get(sym.name)?.values() ?? []) {
        for (const mm of m) {
          if (mm.containerId !== sym.id || !/^(get|post|put|patch|delete|head|options|dispatch|list|create|retrieve|update|partial_update|destroy|perform_create|get_queryset)$/.test(mm.name)) continue;
          if (seen.has(mm.id)) continue;
          seen.add(mm.id);
          out.push({ to: mm.id, line: mm.range.sl, confidence: 'certain', reason: 'called by the framework for matching requests', kind: 'calls' });
        }
      }
    }
    for (const se of this.sinks.edges.get(id) ?? []) {
      if (seen.has(se.to)) continue;
      seen.add(se.to);
      out.push({ to: se.to, line: se.line, confidence: 'certain', reason: se.detail ?? se.kind, kind: se.kind });
    }
    return out.sort((a, b) => a.line - b.line);
  }

  private computeReach() {
    for (const e of this.entries) {
      if (!e.handlerId || e.kind === 'channel') continue;
      const seen = new Set<string>([e.handlerId]);
      const queue: [string, number][] = [[e.handlerId, 0]];
      for (const m of e.middleware ?? []) if (m.id) queue.push([m.id, 0]);
      while (queue.length && seen.size < 500) {
        const [id, d] = queue.shift()!;
        let set = this.reach.get(id);
        if (!set) this.reach.set(id, (set = new Set()));
        set.add(e.id);
        if (d >= 8) continue;
        for (const c of this.calleesOf(id, true)) {
          if (seen.has(c.to)) continue;
          seen.add(c.to);
          queue.push([c.to, d + 1]);
        }
      }
    }
  }

  // ---------------- queries ----------------

  flow(rootId: string, opts: FlowOptions = {}): FlowGraph {
    const depthLimit = opts.depth ?? 3;
    const expanded = new Set(opts.expanded ?? []);
    const collapsed = new Set(opts.collapsed ?? []);
    const maxNodes = opts.maxNodes ?? 140;
    const nodes = new Map<string, FlowNode>();
    const edges = new Map<string, FlowEdge>();
    let order = 0;
    let truncated = false;

    const nodeFor = (id: string, depth: number): FlowNode | undefined => {
      const ex = nodes.get(id);
      if (ex) return ex;
      const s = this.graph.symbols.get(id);
      let n: FlowNode | undefined;
      if (s) {
        n = {
          id,
          kind: 'symbol',
          label: s.kind === 'handler' ? 'inline handler' : s.kind === 'constructor' ? `new ${s.container ?? s.name}` : s.container ? `${s.container}.${s.name}` : this.displayName(s),
          sublabel: `${s.file}:${s.range.sl}`,
          role: s.role ?? 'other',
          file: s.file,
          line: s.range.sl,
          depth,
          hiddenChildren: 0,
        };
        if (s.kind === 'class' || s.kind === 'interface') n.sublabel = `${s.kind} · ${s.file}:${s.range.sl}`;
      } else if (this.sinks.nodes.has(id)) {
        const sk = this.sinks.nodes.get(id)!;
        n = { id, kind: sk.kind, label: sk.label, sublabel: sk.detail, role: sk.kind === 'table' ? 'table' : sk.kind === 'channel' ? 'channel' : 'external', depth, hiddenChildren: 0 };
      } else if (id.startsWith('file:')) {
        const f = id.slice(5);
        n = { id, kind: 'symbol', label: `${path.posix.basename(f)} (top level)`, sublabel: f, role: 'entry', file: f, line: 1, depth, hiddenChildren: 0 };
      } else if (id.startsWith('mw:')) {
        n = { id, kind: 'symbol', label: id.slice(3).replace(/#\d+$/, ''), sublabel: 'middleware (not resolved)', role: 'middleware', depth, hiddenChildren: 0 };
      }
      if (n) {
        if (nodes.size >= maxNodes) {
          truncated = true;
          return undefined;
        }
        nodes.set(id, n);
      }
      return n;
    };
    const addEdge = (from: string, to: string, kind: FlowEdge['kind'], confidence: Confidence, line?: number, label?: string) => {
      const id = `${from}->${to}`;
      if (edges.has(id)) return;
      edges.set(id, { id, from, to, kind, confidence, line, label, order: order++ });
    };

    // Root
    const queue: [string, number][] = [];
    const entry = this.entryById.get(rootId);
    let effectiveRoot = rootId;
    if (entry) {
      const isChannel = entry.kind === 'channel';
      const rootNode: FlowNode = {
        id: entry.id,
        kind: 'entry',
        label: entry.label,
        sublabel: entry.framework,
        role: entry.kind === 'http-route' ? 'route' : entry.kind === 'page' ? 'page' : isChannel ? 'channel' : 'entry',
        file: entry.file || undefined,
        line: entry.line || undefined,
        depth: 0,
        hiddenChildren: 0,
      };
      nodes.set(entry.id, rootNode);
      if (isChannel && entry.handlerId) return this.channelFlow(entry, rootNode);
      let prev = entry.id;
      (entry.middleware ?? []).forEach((m, i) => {
        const mid = m.id ?? `mw:${m.name}#${i}`;
        const n = nodeFor(mid, 1);
        if (!n) return;
        if (n.role === 'other' || n.role === 'util') n.role = 'middleware';
        addEdge(prev, mid, 'calls', m.id ? 'certain' : 'likely', undefined, 'then');
        prev = mid;
        if (m.id) queue.push([m.id, 1]);
      });
      if (entry.handlerId) {
        const h = nodeFor(entry.handlerId, 1);
        if (h) {
          addEdge(prev, entry.handlerId, 'calls', 'certain', undefined, entry.middleware?.length ? 'then' : undefined);
          queue.push([entry.handlerId, 1]);
        }
      }
    } else {
      if (!nodeFor(rootId, 0)) return { rootId, nodes: [], edges: [], truncated: false };
      queue.push([rootId, 0]);
      effectiveRoot = rootId;
    }

    const visited = new Set<string>();
    while (queue.length) {
      const [id, depth] = queue.shift()!;
      if (visited.has(id)) continue;
      visited.add(id);
      const node = nodes.get(id);
      if (!node) continue;
      const children = this.calleesOf(id, opts.hideGuesses, opts.showTrivial);
      const canExpand = !collapsed.has(id) && (depth < depthLimit || expanded.has(id));
      if (!canExpand) {
        node.hiddenChildren = children.filter((c) => !nodes.has(c.to) || !edges.has(`${id}->${c.to}`)).length;
        continue;
      }
      let hidden = 0;
      for (const c of children) {
        const existed = nodes.has(c.to);
        const child = nodeFor(c.to, depth + 1);
        if (!child) {
          hidden++;
          continue;
        }
        if (existed && c.to !== effectiveRoot) child.repeated = child.repeated || visited.has(c.to);
        addEdge(id, c.to, c.kind, c.confidence, c.line, c.kind === 'calls' ? undefined : c.kind);
        if (!existed) queue.push([c.to, depth + 1]);
      }
      node.hiddenChildren = hidden;
    }
    return { rootId, nodes: [...nodes.values()], edges: [...edges.values()], truncated };
  }

  private channelFlow(entry: EntryPoint, rootNode: FlowNode): FlowGraph {
    const chan = entry.handlerId!;
    const nodes = new Map<string, FlowNode>([[rootNode.id, rootNode]]);
    const edges: FlowEdge[] = [];
    let order = 0;
    for (const [from, list] of this.sinks.edges) {
      for (const se of list) {
        if (se.to !== chan) continue;
        const r = this.ref(from);
        if (!r) continue;
        if (!nodes.has(from)) nodes.set(from, { id: from, kind: 'symbol', label: r.container ? `${r.container}.${r.name}` : r.name, sublabel: `${r.file}:${r.line}`, role: r.role, file: r.file, line: r.line, depth: 1, hiddenChildren: 0 });
        if (se.kind === 'subscribes') edges.push({ id: `${rootNode.id}->${from}`, from: rootNode.id, to: from, kind: 'subscribes', confidence: 'certain', label: se.detail, order: order++ });
        else edges.push({ id: `${from}->${rootNode.id}`, from, to: rootNode.id, kind: se.kind, confidence: 'certain', label: se.detail, order: order++ });
        // one level of callers for context: which process/function uses this
        for (const caller of (this.graph.callsTo.get(from) ?? []).slice(0, 4)) {
          const cr = this.ref(caller.from);
          if (!cr || nodes.has(caller.from)) continue;
          nodes.set(caller.from, { id: caller.from, kind: 'symbol', label: cr.container ? `${cr.container}.${cr.name}` : cr.name, sublabel: `${cr.file}:${cr.line}`, role: cr.role, file: cr.file, line: cr.line, depth: 2, hiddenChildren: 0 });
          edges.push({ id: `${caller.from}->${from}`, from: caller.from, to: from, kind: 'calls', confidence: caller.confidence, order: order++ });
        }
      }
    }
    return { rootId: rootNode.id, nodes: [...nodes.values()], edges, truncated: false };
  }

  symbol(id: string): SymbolDetail | undefined {
    const sink = this.sinks.nodes.get(id);
    if (sink) {
      const callers: CallRef[] = [];
      for (const [from, list] of this.sinks.edges) {
        for (const e of list) {
          if (e.to !== id) continue;
          const r = this.ref(from);
          if (r && r.role !== 'test') callers.push({ target: r, line: e.line, confidence: 'certain', reason: `${e.kind}${e.detail ? ' · ' + e.detail : ''}` });
        }
      }
      const role: Role = sink.kind === 'table' ? 'table' : sink.kind === 'channel' ? 'channel' : 'external';
      return {
        symbol: { id, name: sink.label, kind: 'class', file: '', lang: 'typescript', range: { sl: 0, sc: 0, el: 0, ec: 0 }, nameRange: { sl: 0, sc: 0, el: 0, ec: 0 }, signature: sink.detail ?? '', annotations: [], role },
        callees: [],
        callers,
        sinks: [],
        usedBy: [],
        snippet: '',
      };
    }
    const s = this.graph.symbols.get(id) ?? this.pseudoSymbol(id);
    if (!s) return undefined;
    const callees: CallRef[] = [];
    for (const c of this.calleesOf(id, false, true)) {
      if (c.kind !== 'calls') continue;
      const r = this.ref(c.to);
      if (r) callees.push({ target: r, line: c.line, confidence: c.confidence, reason: c.reason });
    }
    const callers: CallRef[] = [];
    const seen = new Set<string>();
    for (const c of this.graph.callsTo.get(id) ?? []) {
      if (seen.has(c.from)) continue;
      seen.add(c.from);
      const r = this.ref(c.from);
      if (r) callers.push({ target: r, line: c.site.range.sl, confidence: c.confidence, reason: c.reason });
    }
    // Production callers first; tests are useful but rarely what someone is trying to understand.
    callers.sort((a, b) => Number(a.target.role === 'test') - Number(b.target.role === 'test'));
    const sinks = (this.sinks.edges.get(id) ?? []).map((e) => ({ node: this.sinks.nodes.get(e.to)!, kind: e.kind, line: e.line })).filter((x) => x.node);
    const usedBy = [...(this.reach.get(id) ?? [])].slice(0, 30).map((eid) => ({ id: eid, label: this.entryById.get(eid)?.label ?? eid }));
    return { symbol: s, callees, callers, sinks, usedBy, snippet: '' };
  }

  private pseudoSymbol(id: string): CodeSymbol | undefined {
    if (!id.startsWith('file:')) return undefined;
    const file = id.slice(5);
    const f = this.graph.facts.get(file);
    if (!f) return undefined;
    return {
      id,
      name: `${path.posix.basename(file)} (top level)`,
      kind: 'function',
      file,
      lang: f.lang,
      range: { sl: 1, sc: 1, el: f.lines, ec: 1 },
      nameRange: { sl: 1, sc: 1, el: 1, ec: 1 },
      signature: `top-level code in ${file}`,
      annotations: [],
      role: 'entry',
      roleReason: 'runs when the file is executed',
    };
  }

  async file(rel: string): Promise<FileView> {
    const abs = path.resolve(this.root, rel);
    if (!abs.startsWith(this.root + path.sep) && abs !== this.root) throw new Error('Path is outside the project');
    const content = await fs.readFile(abs, 'utf8');
    const f = this.graph.facts.get(rel);
    const links: CodeLink[] = [];
    for (const rc of this.graph.resolvedByFile.get(rel) ?? []) {
      const targets = rc.targets.map((t) => this.ref(t)).filter((x): x is SymbolRef => !!x);
      if (!targets.length) continue;
      links.push({ range: rc.site.nameRange ?? rc.site.range, targets, confidence: rc.confidence, reason: rc.reason });
    }
    return {
      path: rel,
      lang: f?.lang ?? null,
      content,
      symbols: (f?.symbols ?? []).map((s) => ({ id: s.id, name: s.name, kind: s.kind, range: s.range, container: s.container, role: s.role })),
      links,
    };
  }

  search(q: string, limit = 40): SearchHit[] {
    const query = q.trim().toLowerCase();
    if (!query) return [];
    const hits: SearchHit[] = [];
    const score = (text: string): number => {
      const t = text.toLowerCase();
      if (t === query) return 100;
      if (t.startsWith(query)) return 80 - Math.min(20, t.length - query.length);
      const i = t.indexOf(query);
      if (i >= 0) return 50 - Math.min(30, i);
      // subsequence (camel-case friendly)
      let qi = 0;
      for (let k = 0; k < t.length && qi < query.length; k++) if (t[k] === query[qi]) qi++;
      return qi === query.length ? 15 : 0;
    };
    for (const e of this.entries) {
      const s = Math.max(score(e.label), score(e.handlerName ?? '') - 10);
      if (s > 0) hits.push({ type: 'entry', id: e.id, label: e.label, detail: `${e.framework}${e.handlerName ? ' → ' + e.handlerName : ''}`, role: e.kind === 'page' ? 'page' : e.kind === 'http-route' ? 'route' : 'entry', score: s + 15 });
    }
    for (const s of this.graph.symbols.values()) {
      if (s.kind === 'handler') continue;
      const full = s.container ? `${s.container}.${s.name}` : s.name;
      const sc = Math.max(score(s.name), score(full));
      if (sc > 0) hits.push({ type: 'symbol', id: s.id, label: full, detail: `${s.kind} · ${s.file}:${s.range.sl}`, role: s.role, score: sc + (s.kind === 'class' ? 5 : 0) - (s.role === 'test' ? 20 : 0) });
    }
    for (const f of this.files) {
      const sc = score(path.posix.basename(f.path));
      if (sc > 0) hits.push({ type: 'file', id: f.path, label: path.posix.basename(f.path), detail: f.path, score: sc - 5 });
    }
    for (const t of this.tables) {
      const sc = score(t.name);
      if (sc > 0) hits.push({ type: 'table', id: `table:${t.name.toLowerCase()}`, label: t.name, detail: `table · ${t.columns.length} columns`, role: 'table', score: sc });
    }
    return hits.sort((a, b) => b.score - a.score).slice(0, limit);
  }

  getDiagrams(): Diagrams {
    if (!this.diagrams) this.diagrams = buildDiagrams(this);
    return this.diagrams;
  }

  /** For diagrams: which entries reach a symbol. */
  reachOf(id: string): Set<string> | undefined {
    return this.reach.get(id);
  }

  calleesFor(id: string) {
    return this.calleesOf(id, true);
  }
}

function kindOrder(k: EntryPoint['kind']): number {
  return { 'http-route': 0, page: 1, process: 2, job: 3, channel: 4 }[k] ?? 5;
}

export type { Role };
