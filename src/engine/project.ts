import fs from 'node:fs/promises';
import path from 'node:path';
import { scanProject } from './scan';
import { extractFile } from './extract';
import { CodeGraph } from './graph';
import { applyRoleOverrides, assignRoles } from './roles';
import { extractOrmTables, mergeTables, parsePrisma, parseSql } from './db';
import { buildSinks, type SinkIndex } from './sinks';
import { extractEntries } from './routes';
import { detectProfile } from './detect';
import { buildDiagrams } from './diagrams';
import { matchRoutes, routeTable } from './clientcalls';
import { DEFAULT_SETTINGS } from './types';
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
  ProjectSettings,
  Role,
  SearchHit,
  SymbolDetail,
  SymbolRef,
} from './types';

const LARGE_PROJECT_FILES = 4000;

export interface OpenOptions {
  settings?: Partial<ProjectSettings>;
  /** Parse results from a previous run, keyed by file path; updated in place. */
  cache?: Map<string, { mtime: number; size: number; lines: number; facts?: FileFacts }>;
  repoSettingsFile?: string;
}

const KIND_LABELS: Record<string, string> = {
  'web-backend': 'Web backend / API',
  'web-frontend': 'Web frontend',
  'fullstack-web': 'Full-stack web app',
  'low-latency': 'Low-latency / systems (IPC, trading-style)',
  game: 'Game',
  cli: 'Command-line tool',
  library: 'Library',
  desktop: 'Desktop app',
  generic: 'General program',
};

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
  settings: ProjectSettings = DEFAULT_SETTINGS;
  private reach = new Map<string, Set<string>>();
  /** HTTP calls in this project's code that hit this project's own routes: caller id -> links. */
  private routeLinks = new Map<string, { entryId: string; line: number; confidence: Confidence; reason: string }[]>();
  private linkedHttpCalls = 0;
  /** Inline callbacks created inside each scope (`onMounted(() => …)`, `.then(x => …)`), keyed by scope id. */
  private callbacks = new Map<string, { id: string; line: number; callee: string }[]>();
  private diagrams?: Diagrams;

  static async open(root: string, onProgress?: (p: Progress) => void, opts: OpenOptions = {}): Promise<Project> {
    const p = new Project();
    await p.load(root, onProgress, opts);
    return p;
  }

  private async load(root: string, onProgress?: (p: Progress) => void, opts: OpenOptions = {}) {
    const started = Date.now();
    this.root = path.resolve(root);
    this.name = path.basename(this.root);
    const settings: ProjectSettings = { ...DEFAULT_SETTINGS, ...(opts.settings ?? {}) };
    this.settings = settings;
    const cache = opts.cache;
    const warnings: string[] = [];
    const report = (phase: Progress['phase'], done: number, total: number, message: string) => onProgress?.({ phase, done, total, message });

    report('scan', 0, 0, 'Finding source files…');
    const scan = await scanProject(this.root, (n) => report('scan', n, 0, `Found ${n} source files…`), settings.exclude);
    this.files = scan.files;
    if (scan.truncated) warnings.push(`Only the first ${scan.files.length} source files were analyzed.`);
    // Very large repositories: tests can be most of the code but rarely explain the architecture.
    const TEST_FILE = /(^|\/)(__tests__|__mocks__|tests?|spec|specs|testing|e2e|fixtures?)\/|\.(test|spec)\.[jt]sx?$|_test\.(go|py)$|(^|\/)test_[^/]+\.py$|Tests?\.(java|cs|kt)$/;
    let skipTests = settings.tests === 'exclude';
    if (settings.tests === 'auto' && this.files.length > LARGE_PROJECT_FILES) {
      const tests = this.files.filter((f) => TEST_FILE.test(f.path)).length;
      if (tests > 0) {
        skipTests = true;
        warnings.push(`This is a large project, so ${tests.toLocaleString()} test files were skipped to keep things fast. You can include them in Project settings.`);
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
        if (skipTests && TEST_FILE.test(fe.path)) continue;
        // Re-indexing reuses the facts of files that have not changed since the last run.
        const hit = cache?.get(fe.path);
        if (hit && hit.mtime === fe.mtime && hit.size === fe.size) {
          fe.lines = hit.lines;
          if (hit.facts) allFacts.push(hit.facts);
          continue;
        }
        const src = await fs.readFile(path.join(this.root, fe.path), 'utf8');
        fe.lines = src.split('\n').length;
        let facts: FileFacts | undefined;
        if (fe.lang && !(fe.size > 300_000 && /^.{2000,}$/m.test(src.slice(0, 20000)))) {
          facts = await extractFile(fe.path, src, fe.lang);
          allFacts.push(facts);
        }
        cache?.set(fe.path, { mtime: fe.mtime ?? 0, size: fe.size, lines: fe.lines, facts });
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
    for (const f of allFacts) {
      for (const c of f.calls) {
        for (const a of c.args) {
          if (a.kind !== 'func' || !a.symbolId || !this.graph.symbols.has(a.symbolId)) continue;
          const list = this.callbacks.get(c.from) ?? [];
          list.push({ id: a.symbolId, line: c.range.sl, callee: c.callee });
          this.callbacks.set(c.from, list);
        }
      }
    }
    // Closures defined inside a function (React `queryFn`/`onSubmit`, Python inner functions) run as part of it.
    for (const s of this.graph.symbols.values()) {
      if (!s.parentFn || !this.graph.symbols.has(s.parentFn)) continue;
      const list = this.callbacks.get(s.parentFn) ?? [];
      if (list.some((x) => x.id === s.id)) continue;
      list.push({ id: s.id, line: s.range.sl, callee: '' });
      this.callbacks.set(s.parentFn, list);
    }
    report('analyze', 0, 1, 'Classifying code and finding entry points…');
    assignRoles(this.graph.symbols);
    applyRoleOverrides(this.graph.symbols, settings.roleOverrides);

    const ormTables = extractOrmTables(this.graph);
    this.tables = mergeTables([sqlTables, prismaTables, ormTables], extraIndexes, fks);
    this.sinks = buildSinks(this.graph, this.tables);

    const allDeps = pkgJsons.map((p) => Object.keys({ ...(p.json.dependencies ?? {}), ...(p.json.devDependencies ?? {}) }).join(' ')).join(' ');
    const projectHasServerLib =
      /\b(express|koa|fastify|hono|restify|polka|@nestjs\/core|elysia)\b/.test(allDeps) || goMods.some((g) => /gin-gonic|labstack\/echo|go-chi|gorilla\/mux|gofiber/.test(g.text));
    const hasNext = /(^|\s)next(\s|$)/.test(allDeps);
    const hasClientRouter = /(^|\s)(vue-router|@angular\/router|react-router|react-router-dom|@tanstack\/(react|vue|solid)-router|@solidjs\/router)(\s|$)/.test(allDeps);
    this.entries = extractEntries(this.graph, this.sinks, { pkgJsons, projectHasServerLib, hasNext, hasClientRouter });
    this.entries.push(...this.customEntries(settings.entryPoints, warnings));
    // Code that calls an outside HTTP API and does not handle a route is a client (e.g. a frontend's src/api/*.ts).
    const handlerIds = new Set(this.entries.map((e) => e.handlerId));
    for (const [from, list] of this.sinks.edges) {
      const s = this.graph.symbols.get(from);
      if (!s || handlerIds.has(from) || s.roleReason?.startsWith('set by you') || !list.some((e) => e.kind === 'http')) continue;
      if (s.role === 'controller' || s.role === 'other' || s.role === 'util') {
        s.role = 'client';
        s.roleReason = 'calls an HTTP API';
      }
    }
    // Route handlers are controllers even when nothing else says so (unless the user said otherwise).
    for (const e of this.entries) {
      const s = e.handlerId ? this.graph.symbols.get(e.handlerId) : undefined;
      if (s && (!s.role || s.role === 'other' || s.role === 'util') && !s.roleReason?.startsWith('set by you')) {
        s.role = e.kind === 'page' ? 'view' : e.kind === 'process' ? 'entry' : 'controller';
        s.roleReason = `handles ${e.label}`;
      }
    }
    this.entries.sort((a, b) => kindOrder(a.kind) - kindOrder(b.kind) || (a.path ?? a.label).localeCompare(b.path ?? b.label) || (a.method ?? '').localeCompare(b.method ?? ''));
    // Lazy route components (`component: () => import('./views/Users.vue')`) start at the component itself.
    for (const e of this.entries) {
      const calls = e.handlerId ? this.graph.callsFrom.get(e.handlerId) : undefined;
      if (calls?.length === 1 && calls[0].site.callee === 'import' && calls[0].targets.length === 1) {
        const t = this.graph.symbols.get(calls[0].targets[0]);
        if (!t) continue;
        e.handlerId = t.id;
        e.handlerName = t.name;
      }
    }
    for (const e of this.entries) this.entryById.set(e.id, e);
    this.linkHttpCalls();
    this.computeReach();

    const profile = detectProfile(this.graph, this.files, manifests, scan.extras, this.entries);
    if (settings.projectKind) {
      // The user knows best: put their choice first, keep the detected kinds as alternatives.
      const chosen = profile.kinds.find((k) => k.kind === settings.projectKind);
      const rest = profile.kinds.filter((k) => k.kind !== settings.projectKind);
      profile.kinds = [{ kind: settings.projectKind, label: chosen?.label ?? KIND_LABELS[settings.projectKind], score: chosen?.score ?? 0, evidence: [{ text: 'Set by you in Project settings' }, ...(chosen?.evidence ?? [])] }, ...rest];
    }
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
        linkedHttpCalls: this.linkedHttpCalls,
        tables: this.tables.length + [...this.sinks.nodes.values()].filter((n) => n.kind === 'table' && !this.tables.some((t) => t.name.toLowerCase() === n.label.toLowerCase())).length,
      },
      entries: this.entries,
      files: this.files,
      warnings,
      settings,
      repoSettingsFile: opts.repoSettingsFile,
    };
    report('done', 1, 1, 'Ready');
  }

  /** Entry points the user pinned in settings: `Class.method`, `function` or `path/file.ext#name`. */
  private customEntries(specs: ProjectSettings['entryPoints'], warnings: string[]): EntryPoint[] {
    const out: EntryPoint[] = [];
    for (const spec of specs) {
      const [filePart, namePart] = spec.symbol.includes('#') ? spec.symbol.split('#') : [undefined, spec.symbol];
      const dot = namePart.lastIndexOf('.');
      const container = dot > 0 ? namePart.slice(0, dot) : undefined;
      const name = dot > 0 ? namePart.slice(dot + 1) : namePart;
      const hits = [...this.graph.symbols.values()].filter(
        (s) => s.name === name && (container ? s.container === container : true) && (!filePart || s.file === filePart || s.file.endsWith('/' + filePart)) && s.kind !== 'handler',
      );
      if (!hits.length) {
        warnings.push(`Pinned entry point "${spec.symbol}" was not found.`);
        continue;
      }
      for (const s of hits.slice(0, 5)) {
        const label = spec.label ?? (s.container ? `${s.container}.${s.name}` : s.name);
        out.push({ id: `custom:${s.id}`, kind: 'custom', label, group: 'Pinned by you', framework: 'pinned', handlerId: s.id, handlerName: s.container ? `${s.container}.${s.name}` : s.name, file: s.file, line: s.range.sl });
      }
    }
    return out;
  }

  /** Replace "external API" leaves with links to the matching routes defined in this project. */
  private linkHttpCalls() {
    const routes = routeTable(this.entries);
    if (!routes.length) return;
    type Edge = (typeof this.sinks.edges extends Map<string, (infer E)[]> ? E : never);
    const matched = new Map<Edge, NonNullable<ReturnType<typeof matchRoutes>>>();
    // Wrappers recognized only by shape (`fooApiRequest('GET', '/agents')`) may call someone else's API whose
    // paths happen to look like ours. Trust a wrapper only if most of its calls match routes in this project.
    const wrapperStats = new Map<string, { calls: number; hits: number }>();
    for (const list of this.sinks.edges.values()) {
      for (const e of list) {
        if (!e.http) continue;
        const m = matchRoutes(e.http as Parameters<typeof matchRoutes>[0], routes);
        if (m) matched.set(e, m);
        if (e.http.wrapper) {
          const st = wrapperStats.get(e.http.lib) ?? { calls: 0, hits: 0 };
          st.calls++;
          if (m && m.confidence !== 'guess') st.hits++;
          wrapperStats.set(e.http.lib, st);
        }
      }
    }
    for (const [from, list] of this.sinks.edges) {
      const keep = [];
      for (const e of list) {
        const m = matched.get(e);
        const st = e.http?.wrapper ? wrapperStats.get(e.http.lib) : undefined;
        if (st && st.hits * 2 < st.calls) continue; // someone else's API: the wrapper's own request already shows where it goes
        if (!m) {
          keep.push(e);
          continue;
        }
        this.linkedHttpCalls++;
        const caller = this.graph.symbols.get(from);
        for (const entry of m.entries) {
          const links = this.routeLinks.get(from) ?? [];
          links.push({ entryId: entry.id, line: e.line, confidence: m.confidence, reason: m.reason });
          this.routeLinks.set(from, links);
          const callers = (entry.clientCallers ??= []);
          if (!callers.some((c) => c.id === from)) callers.push({ id: from, name: caller ? (caller.container ? `${caller.container}.${caller.name}` : caller.name) : from, file: e.file, line: e.line, confidence: m.confidence });
        }
      }
      this.sinks.edges.set(from, keep);
    }
    const used = new Set([...this.sinks.edges.values()].flat().map((e) => e.to));
    for (const [id, n] of this.sinks.nodes) if (n.kind === 'external' && !used.has(id)) this.sinks.nodes.delete(id);
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
    return !this.graph.callsFrom.get(id)?.length && !this.sinks.edges.get(id)?.length && !this.routeLinks.has(id);
  }

  private dataReach?: Set<string>;
  /** Whether code eventually touches a table, an external system or a route in this project. */
  reachesData(id: string): boolean {
    if (!this.dataReach) {
      // Walk callers backwards from everything that touches data: exact, and linear in the size of the graph.
      const parents = new Map<string, string[]>();
      for (const [from, list] of this.callbacks) for (const cb of list) parents.set(cb.id, [...(parents.get(cb.id) ?? []), from]);
      const set = new Set<string>([...this.sinks.edges.keys(), ...this.routeLinks.keys()]);
      const queue = [...set];
      while (queue.length) {
        const id = queue.pop()!;
        for (const up of [...(this.graph.callsTo.get(id) ?? []).map((c) => c.from), ...(parents.get(id) ?? [])]) {
          if (set.has(up)) continue;
          set.add(up);
          queue.push(up);
        }
      }
      this.dataReach = set;
    }
    return this.dataReach.has(id);
  }

  private calleesOf(id: string, hideGuesses = false, showTrivial = false): { to: string; line: number; confidence: Confidence; reason: string; kind: FlowEdge['kind'] }[] {
    const out: { to: string; line: number; confidence: Confidence; reason: string; kind: FlowEdge['kind'] }[] = [];
    const seen = new Set<string>();
    const entry = this.entryById.get(id);
    if (entry) {
      for (const m of entry.middleware ?? []) if (m.id) out.push({ to: m.id, line: entry.line, confidence: 'certain', reason: 'middleware', kind: 'calls' });
      if (entry.handlerId) out.push({ to: entry.handlerId, line: entry.line, confidence: 'certain', reason: 'route handler', kind: 'calls' });
      return out;
    }
    for (const l of this.routeLinks.get(id) ?? []) {
      if (hideGuesses && l.confidence === 'guess') continue;
      if (!seen.has(l.entryId)) {
        seen.add(l.entryId);
        out.push({ to: l.entryId, line: l.line, confidence: l.confidence, reason: l.reason, kind: 'http' });
      }
    }
    const sym = this.graph.symbols.get(id);
    const uiCaller = sym?.role === 'view' || sym?.role === 'page';
    // Classes only expand to their data sinks (e.g. repository -> table) to avoid pulling in every method.
    if (!sym || (sym.kind !== 'class' && sym.kind !== 'interface' && sym.kind !== 'struct')) {
      for (const rc of this.graph.callsFrom.get(id) ?? []) {
        if (hideGuesses && rc.confidence === 'guess') continue;
        for (const t of rc.targets) {
          if (seen.has(t)) continue;
          const ts = this.graph.symbols.get(t);
          if (ts?.role === 'test' && sym?.role !== 'test') continue;
          if (!showTrivial && this.isTrivial(t)) continue;
          // Rendered components that never reach data or an API (buttons, dialogs, layout) are visual noise in a flow,
          // and so is a UI component's display logic (formatting, computed values, i18n, telemetry).
          if (!showTrivial && (rc.site.render || uiCaller) && !this.reachesData(t)) continue;
          seen.add(t);
          out.push({ to: t, line: rc.site.range.sl, confidence: rc.confidence, reason: rc.reason, kind: 'calls' });
        }
      }
    } else if (sym.role === 'controller' || sym.role === 'view') {
      // Class-based views/controllers (Django View, DRF ViewSet, Flask MethodView) and UI component classes
      // (Angular, React): the framework calls these methods for you.
      const FRAMEWORK_METHODS =
        sym.role === 'controller'
          ? /^(get|post|put|patch|delete|head|options|dispatch|list|create|retrieve|update|partial_update|destroy|perform_create|get_queryset)$/
          : /^(constructor|ngOnInit|ngOnChanges|ngAfterViewInit|ngOnDestroy|componentDidMount|componentDidUpdate|componentWillUnmount|render|setup|mounted|created|beforeMount|onMounted)$/;
      for (const m of this.graph.membersByContainer.get(sym.name)?.values() ?? []) {
        for (const mm of m) {
          if (mm.containerId !== sym.id || !FRAMEWORK_METHODS.test(mm.name)) continue;
          if (seen.has(mm.id)) continue;
          seen.add(mm.id);
          out.push({ to: mm.id, line: mm.range.sl, confidence: 'certain', reason: 'called by the framework for matching requests', kind: 'calls' });
        }
      }
    }
    // Callbacks handed to other code (event handlers, promise chains, lifecycle hooks) run as part of this flow.
    for (const cb of this.callbacks.get(id) ?? []) {
      if (seen.has(cb.id)) continue;
      seen.add(cb.id);
      if (!showTrivial && (!cb.callee || uiCaller) && !this.reachesData(cb.id)) continue;
      out.push({ to: cb.id, line: cb.line, confidence: 'likely', reason: cb.callee ? `callback passed to ${cb.callee}()` : 'defined inside and run by it', kind: 'calls' });
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
          label: s.kind === 'handler' ? (/^\w+\(/.test(s.name) ? `${s.name.split('(')[0]}(…) callback` : 'inline handler') : s.kind === 'constructor' ? `new ${s.container ?? s.name}` : s.container ? `${s.container}.${s.name}` : this.displayName(s),
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
      } else if (this.entryById.has(id)) {
        const e = this.entryById.get(id)!;
        n = { id, kind: 'entry', label: e.label, sublabel: e.framework, role: e.kind === 'page' ? 'page' : 'route', file: e.file, line: e.line, depth, hiddenChildren: 0 };
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
        routeCalls: [],
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
    const routeCalls = (this.routeLinks.get(id) ?? []).map((l) => ({ entryId: l.entryId, label: this.entryById.get(l.entryId)?.label ?? l.entryId, line: l.line, confidence: l.confidence, reason: l.reason }));
    return { symbol: s, callees, callers, routeCalls, sinks, usedBy, snippet: '' };
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
  return { custom: -1, 'http-route': 0, page: 1, process: 2, job: 3, channel: 4 }[k] ?? 5;
}

export type { Role };
