// Core data model shared by the engine, the worker, and the UI.
// Everything the UI renders is derived from these plain JSON-serializable shapes.

export type Lang =
  | 'javascript'
  | 'typescript'
  | 'tsx'
  | 'java'
  | 'python'
  | 'c'
  | 'cpp'
  | 'go'
  | 'rust'
  | 'csharp';

/** 1-based lines and columns, matching Monaco. */
export interface Range {
  sl: number;
  sc: number;
  el: number;
  ec: number;
}

export type SymbolKind =
  | 'function'
  | 'method'
  | 'constructor'
  | 'class'
  | 'interface'
  | 'struct'
  | 'enum'
  | 'handler'; // anonymous function passed as a callback (e.g. an inline Express handler)

/** What part a piece of code plays in the architecture. Drives colors and diagram columns. */
export type Role =
  | 'route'
  | 'page'
  | 'entry'
  | 'middleware'
  | 'controller'
  | 'service'
  | 'repository'
  | 'model'
  | 'view'
  | 'client'
  | 'util'
  | 'config'
  | 'test'
  | 'table'
  | 'external'
  | 'channel'
  | 'other';

/** A syntactic argument (call argument, annotation argument, decorator argument). */
export interface Arg {
  kind: 'string' | 'number' | 'ident' | 'member' | 'func' | 'call' | 'array' | 'object' | 'other';
  text: string;
  /** Unquoted value for string literals. */
  value?: string;
  /** Keyword / named argument key (`prefix=` in Python, `value =` in Java annotations). */
  key?: string;
  /** Symbol id when the argument is an inline function we created a symbol for. */
  symbolId?: string;
  /** For calls: callee name. */
  callee?: string;
  items?: Arg[];
  line: number;
}

export interface Annotation {
  name: string;
  args: Arg[];
}

export interface CodeSymbol {
  id: string;
  name: string;
  kind: SymbolKind;
  /** Enclosing class/struct name, if any. */
  container?: string;
  /** Enclosing class symbol id, if any. */
  containerId?: string;
  file: string;
  lang: Lang;
  range: Range;
  nameRange: Range;
  signature: string;
  annotations: Annotation[];
  /** Base classes / implemented interfaces (type names only). */
  supers?: string[];
  /** Generic type arguments of supers, e.g. JpaRepository<Order, Long> -> { JpaRepository: [Order, Long] } */
  superArgs?: Record<string, string[]>;
  exported?: boolean;
  isDefaultExport?: boolean;
  role?: Role;
  /** Short reason for the role guess, shown in the UI ("@Service annotation"). */
  roleReason?: string;
}

export interface CallSite {
  /** Enclosing symbol id, or `file:<path>` for top-level code. */
  from: string;
  callee: string;
  receiver?: string;
  args: Arg[];
  range: Range;
  /** Range of just the callee name (what the code view underlines). */
  nameRange?: Range;
  isNew?: boolean;
}

export interface ImportFact {
  /** Raw module specifier as written. */
  source: string;
  /** Local binding name. */
  local: string;
  /** Imported name; 'default' for default imports, '*' for namespace/module imports. */
  imported: string;
  line: number;
}

export interface ExportFact {
  name: string;
  local: string;
  isDefault?: boolean;
  /** Re-export source: `export { a } from './x'` / `export * from './x'` (name '*'). */
  source?: string;
}

export interface FieldFact {
  ownerId: string;
  owner: string;
  name: string;
  type?: string;
  /** Generic arguments of the declared type, e.g. List<Order> -> [Order]. */
  typeArgs?: string[];
  value?: string;
  /** For `x = models.ForeignKey(Order, ...)`: the call and its args. */
  valueCall?: { callee: string; receiver?: string; args: Arg[] };
  annotations: Annotation[];
  range: Range;
}

/** `x = something(...)` or a typed local/param declaration. Used for type inference and router wiring. */
export interface VarFact {
  scope: string;
  name: string;
  type?: string;
  call?: { callee: string; receiver?: string; args: Arg[] };
  /** Plain value text when not a call (truncated). */
  valueText?: string;
  line: number;
}

/** String literals that look like SQL, URLs, or IPC endpoints, plus the scope they appear in. */
export interface StringFact {
  scope: string;
  value: string;
  line: number;
}

/** JSX <Route path="/x" element={<Page/>} /> declarations (React Router). */
export interface JsxRouteFact {
  path: string;
  component?: string;
  /** Lazy-loaded component module: `() => import('./views/Users.vue')`. */
  importSource?: string;
  /** 'jsx' (<Route>), 'object' (Vue/Angular route arrays), 'tanstack' (createFileRoute). */
  style?: 'jsx' | 'object' | 'tanstack';
  line: number;
  scope: string;
}

export interface FileFacts {
  file: string;
  lang: Lang;
  lines: number;
  symbols: CodeSymbol[];
  calls: CallSite[];
  imports: ImportFact[];
  exports: ExportFact[];
  fields: FieldFact[];
  vars: VarFact[];
  strings: StringFact[];
  jsxRoutes: JsxRouteFact[];
  /** Type aliases: `using TickRing = RingBuffer<Tick>`, `typedef struct x X`, `type ID = string`. */
  aliases?: { name: string; target: string }[];
  /** Python `if __name__ == "__main__":` */
  hasMainGuard?: boolean;
  parseErrors?: boolean;
}

export type EdgeKind = 'calls' | 'reads' | 'writes' | 'http' | 'publishes' | 'subscribes' | 'renders' | 'uses';
export type Confidence = 'certain' | 'likely' | 'guess';

export interface ResolvedCall {
  site: CallSite;
  targets: string[];
  confidence: Confidence;
  /** Why we chose this target — shown on hover so users can judge accuracy. */
  reason: string;
}

export type EntryKind = 'http-route' | 'page' | 'process' | 'channel' | 'job' | 'custom';

export interface EntryPoint {
  id: string;
  kind: EntryKind;
  label: string;
  method?: string;
  path?: string;
  group: string;
  framework: string;
  /** The symbol the flow starts from. */
  handlerId?: string;
  handlerName?: string;
  /** Middleware symbol ids (or names when unresolved) that run before the handler. */
  middleware?: { name: string; id?: string }[];
  file: string;
  line: number;
  notes?: string[];
}

export interface Evidence {
  text: string;
  file?: string;
  line?: number;
}

export type ProjectKind =
  | 'web-backend'
  | 'web-frontend'
  | 'fullstack-web'
  | 'low-latency'
  | 'game'
  | 'cli'
  | 'library'
  | 'desktop'
  | 'generic';

export interface ProjectProfile {
  kinds: { kind: ProjectKind; label: string; score: number; evidence: Evidence[] }[];
  frameworks: { name: string; category: string; evidence: Evidence[] }[];
  languages: { lang: string; files: number; lines: number }[];
}

export interface DbColumn {
  name: string;
  type: string;
  pk?: boolean;
  nullable?: boolean;
  unique?: boolean;
  indexed?: boolean;
  fk?: { table: string; column?: string };
}

export interface DbIndex {
  name: string;
  columns: string[];
  unique?: boolean;
  primary?: boolean;
}

export interface DbTable {
  name: string;
  columns: DbColumn[];
  indexes: DbIndex[];
  /** Where it was declared (SQL file, ORM model...). */
  source: { kind: string; file: string; line: number; symbolId?: string };
  /** ORM class name if declared through a model/entity. */
  modelName?: string;
}

/** A node that is not a code symbol: a DB table, an external HTTP service, an IPC channel. */
export interface SinkNode {
  id: string;
  kind: 'table' | 'external' | 'channel';
  label: string;
  detail?: string;
}

export interface SinkEdge {
  from: string;
  to: string;
  kind: EdgeKind;
  line: number;
  file: string;
  detail?: string;
}

export interface FileEntry {
  path: string;
  lang: Lang | null;
  size: number;
  lines: number;
  /** Modification time, used to reuse parse results when re-indexing. */
  mtime?: number;
}

/**
 * Per-project choices the user can make when the automatic analysis is not what they want.
 * Stored by the app per folder; a team can also commit the same shape as `understandably.json`.
 */
export interface ProjectSettings {
  /** gitignore-style patterns (relative to the project root) to leave out of the analysis. */
  exclude: string[];
  /** 'auto' skips tests only in very large projects. */
  tests: 'auto' | 'include' | 'exclude';
  /** Force the role of code the analyzer got wrong. `match` is a path glob, a class/function name, or `Class.method`. */
  roleOverrides: { match: string; role: Role }[];
  /** Extra entry points: `Class.method`, `function`, or `path/to/file.ext#name`. */
  entryPoints: { symbol: string; label?: string }[];
  /** Override the detected kind of program. */
  projectKind?: ProjectKind;
  /** Re-index automatically when files change on disk. */
  autoRefresh: boolean;
}

export const DEFAULT_SETTINGS: ProjectSettings = { exclude: [], tests: 'auto', roleOverrides: [], entryPoints: [], autoRefresh: true };

export interface ProjectSummary {
  root: string;
  name: string;
  indexedAt: number;
  durationMs: number;
  profile: ProjectProfile;
  stats: { files: number; sourceFiles: number; symbols: number; calls: number; resolvedCalls: number; lines: number; tables: number };
  entries: EntryPoint[];
  files: FileEntry[];
  warnings: string[];
  settings: ProjectSettings;
  /** Where team-shared settings were read from, if the repo has an understandably.json. */
  repoSettingsFile?: string;
}

// ---------- Query results ----------

export interface FlowNode {
  id: string;
  kind: 'symbol' | 'entry' | 'table' | 'external' | 'channel';
  label: string;
  sublabel?: string;
  role: Role;
  file?: string;
  line?: number;
  depth: number;
  /** Number of outgoing calls not yet shown (UI renders an expander). */
  hiddenChildren: number;
  /** True if this node was already shown elsewhere in the flow (cycle / shared callee). */
  repeated?: boolean;
}

export interface FlowEdge {
  id: string;
  from: string;
  to: string;
  kind: EdgeKind;
  confidence: Confidence;
  label?: string;
  /** Line of the call site within the caller. */
  line?: number;
  order: number;
}

export interface FlowGraph {
  rootId: string;
  nodes: FlowNode[];
  edges: FlowEdge[];
  truncated: boolean;
}

export interface SymbolRef {
  id: string;
  name: string;
  container?: string;
  kind: SymbolKind | 'table' | 'external' | 'channel';
  role: Role;
  file?: string;
  line?: number;
}

export interface CallRef {
  target: SymbolRef;
  line: number;
  confidence: Confidence;
  reason: string;
}

export interface SymbolDetail {
  symbol: CodeSymbol;
  callees: CallRef[];
  callers: CallRef[];
  sinks: { node: SinkNode; kind: EdgeKind; line: number }[];
  /** Entry points that reach this symbol (within the default trace depth). */
  usedBy: { id: string; label: string }[];
  snippet: string;
}

export interface CodeLink {
  range: Range;
  targets: SymbolRef[];
  confidence: Confidence;
  reason: string;
}

export interface FileView {
  path: string;
  lang: Lang | null;
  content: string;
  symbols: { id: string; name: string; kind: SymbolKind; range: Range; container?: string; role?: Role }[];
  links: CodeLink[];
}

export interface SearchHit {
  type: 'entry' | 'symbol' | 'file' | 'table';
  id: string;
  label: string;
  detail: string;
  role?: Role;
  score: number;
}

export interface DiagramNode {
  id: string;
  label: string;
  sublabel?: string;
  role: Role;
  group?: string;
  /** Count of underlying symbols (for aggregated components). */
  size?: number;
  /** Symbol id or entry id to jump to in the explorer. */
  target?: string;
}

export interface DiagramEdge {
  id: string;
  from: string;
  to: string;
  kind: EdgeKind;
  weight: number;
}

export interface RouteTreeNode {
  segment: string;
  fullPath: string;
  routes: { id: string; method: string; handlerName?: string }[];
  children: RouteTreeNode[];
}

export interface Diagrams {
  dataflow: { nodes: DiagramNode[]; edges: DiagramEdge[]; mode: string; note?: string };
  modules: { nodes: DiagramNode[]; edges: DiagramEdge[] };
  database: { tables: DbTable[]; usage: Record<string, { id: string; name: string; kind: EdgeKind }[]> };
  routes: RouteTreeNode;
}

export interface Progress {
  phase: 'scan' | 'parse' | 'resolve' | 'analyze' | 'done';
  done: number;
  total: number;
  message: string;
}
