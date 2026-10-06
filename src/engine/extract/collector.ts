import type { Node, Tree } from 'web-tree-sitter';
import type {
  Annotation,
  Arg,
  CallSite,
  CodeSymbol,
  FileFacts,
  Lang,
  Range,
  SymbolKind,
} from '../types';

export function rangeOf(n: Node): Range {
  return {
    sl: n.startPosition.row + 1,
    sc: n.startPosition.column + 1,
    el: n.endPosition.row + 1,
    ec: n.endPosition.column + 1,
  };
}

export function truncate(s: string, max = 120): string {
  const one = s.replace(/\s+/g, ' ').trim();
  return one.length > max ? one.slice(0, max - 1) + '…' : one;
}

export function children(n: Node | null | undefined): Node[] {
  if (!n) return [];
  return n.namedChildren.filter((c): c is Node => c !== null);
}

export function field(n: Node | null | undefined, name: string): Node | null {
  return n ? n.childForFieldName(name) : null;
}

const KEEP_ARGS_CALLEE = /^(use|Use|route|Route|Mount|mount|nest|register|include_router|register_blueprint|add_url_rule|path|re_path|url|include|query|select|get|delete|update|insert|exec|execute|bind|connect|send|publish|subscribe|Group|group|fetch|\$fetch|ofetch|useFetch|useLazyFetch|useSWR|axios|ky|got|request|ajax|__request|post|put|patch|del|head|GET|POST|PUT|PATCH|DELETE|getJSON)$/;

const SQL_RE = /\b(select\s[\s\S]*\sfrom|insert\s+into|update\s+\S+\s+set|delete\s+from|create\s+table|join\s)/i;
const URL_RE = /^(https?|wss?|ipc|tcp|inproc|aeron|udp|unix):\/\//i;

/** Keep only string literals that the analyzers care about, so facts stay small. */
export function interestingString(s: string): boolean {
  if (s.length < 6 || s.length > 4000) return false;
  return SQL_RE.test(s) || URL_RE.test(s);
}

interface Scope {
  kind: 'class' | 'func';
  sym: CodeSymbol;
}

/**
 * Accumulates facts for one file while a language adapter walks the tree.
 * Adapters call `pushScope` for definitions; the walker pops them on exit.
 */
export class Collector {
  facts: FileFacts;
  scopes: Scope[] = [];

  constructor(
    public file: string,
    public lang: Lang,
    public src: string,
  ) {
    this.facts = {
      file,
      lang,
      lines: src.split('\n').length,
      symbols: [],
      calls: [],
      imports: [],
      exports: [],
      fields: [],
      vars: [],
      strings: [],
      jsxRoutes: [],
    };
  }

  get fileScope(): string {
    return `file:${this.file}`;
  }

  /** Innermost function-like scope id (or the file scope for top-level code). */
  get scopeId(): string {
    for (let i = this.scopes.length - 1; i >= 0; i--) {
      if (this.scopes[i].kind === 'func') return this.scopes[i].sym.id;
    }
    return this.fileScope;
  }

  get currentClass(): CodeSymbol | undefined {
    for (let i = this.scopes.length - 1; i >= 0; i--) {
      if (this.scopes[i].kind === 'class') return this.scopes[i].sym;
      // A function nested in a class method still belongs to the class for `this` resolution.
    }
    return undefined;
  }

  symbolId(name: string, line: number, container?: string): string {
    return `${this.file}:${container ? container + '.' : ''}${name}:${line}`;
  }

  anonId(n: Node): string {
    return `${this.file}:λ${n.startPosition.row + 1}_${n.startPosition.column + 1}`;
  }

  signature(n: Node, bodyField = 'body'): string {
    const body = n.childForFieldName(bodyField);
    const end = body ? body.startIndex : Math.min(n.endIndex, n.startIndex + 300);
    return truncate(this.src.slice(n.startIndex, end), 200);
  }

  addSymbol(opts: {
    node: Node;
    nameNode?: Node | null;
    name: string;
    kind: SymbolKind;
    annotations?: Annotation[];
    supers?: string[];
    superArgs?: Record<string, string[]>;
    signature?: string;
    id?: string;
    container?: CodeSymbol;
    exported?: boolean;
    isDefaultExport?: boolean;
  }): CodeSymbol {
    const range = rangeOf(opts.node);
    const cls = opts.container ?? (opts.kind === 'class' || opts.kind === 'interface' || opts.kind === 'struct' || opts.kind === 'enum' ? undefined : this.currentClass);
    const sym: CodeSymbol = {
      id: opts.id ?? this.symbolId(opts.name, range.sl, cls?.name),
      name: opts.name,
      kind: opts.kind,
      container: cls?.name,
      containerId: cls?.id,
      file: this.file,
      lang: this.lang,
      range,
      nameRange: opts.nameNode ? rangeOf(opts.nameNode) : { sl: range.sl, sc: range.sc, el: range.sl, ec: range.sc },
      signature: opts.signature ?? this.signature(opts.node),
      annotations: opts.annotations ?? [],
      supers: opts.supers?.length ? opts.supers : undefined,
      superArgs: opts.superArgs && Object.keys(opts.superArgs).length ? opts.superArgs : undefined,
      exported: opts.exported,
      isDefaultExport: opts.isDefaultExport,
    };
    const top = this.scopes[this.scopes.length - 1];
    if (top?.kind === 'func' && top.sym.id !== sym.id) sym.parentFn = top.sym.id;
    this.facts.symbols.push(sym);
    return sym;
  }

  pushScope(kind: 'class' | 'func', sym: CodeSymbol) {
    this.scopes.push({ kind, sym });
  }

  popScope() {
    this.scopes.pop();
  }

  addCall(n: Node, callee: string, receiver: string | undefined, args: Arg[], isNew = false, nameNode?: Node | null): CallSite {
    // Most calls (`foo(a, b)`) only need their argument count. Keep full arguments where an analyzer reads them:
    // literals (routes, SQL, URLs, channel names), inline callbacks, and router/ORM wiring calls.
    const keep = KEEP_ARGS_CALLEE.test(callee) || args.some((a) => (a.kind !== 'ident' && a.kind !== 'member' && a.kind !== 'number' && a.kind !== 'other') || (a.kind === 'other' && /['"`]/.test(a.text)));
    const site: CallSite = {
      from: this.scopeId,
      callee,
      receiver: receiver ? truncate(receiver, 100) : undefined,
      args: keep ? args : args.map((a) => ({ kind: a.kind, text: a.kind === 'ident' || a.kind === 'member' ? a.text : '', line: a.line })),
      range: rangeOf(n),
      nameRange: nameNode ? rangeOf(nameNode) : undefined,
      isNew: isNew || undefined,
    };
    this.facts.calls.push(site);
    return site;
  }

  addString(value: string, n: Node) {
    if (interestingString(value)) {
      this.facts.strings.push({ scope: this.scopeId, value: value.slice(0, 2000), line: n.startPosition.row + 1 });
    }
  }
}

/**
 * Iterative tree walk using a TreeCursor (much cheaper than materializing every Node).
 * `enter` is only invoked for node types in `interesting`; returning a number tells the walker
 * how many scopes it pushed, which are popped when the node is exited.
 */
export function walk(tree: Tree, interesting: Set<string>, enter: (n: Node) => number | void, collector: Collector) {
  const cursor = tree.walk();
  const pushed: number[] = [];
  try {
    outer: while (true) {
      let count = 0;
      if (interesting.has(cursor.nodeType)) {
        count = enter(cursor.currentNode) || 0;
      }
      pushed.push(count);
      if (cursor.gotoFirstChild()) continue;
      while (true) {
        const c = pushed.pop() ?? 0;
        for (let i = 0; i < c; i++) collector.popScope();
        if (cursor.gotoNextSibling()) continue outer;
        if (!cursor.gotoParent()) break outer;
      }
    }
  } finally {
    cursor.delete();
  }
}

export function unquote(text: string): string | undefined {
  const m = /^(?:[rbuRBUf]{0,2})?(['"`])([\s\S]*)\1$/.exec(text.trim());
  if (m) return m[2];
  const tri = /^(?:[rbuRBUf]{0,2})?("""|''')([\s\S]*)\1$/.exec(text.trim());
  if (tri) return tri[2];
  const raw = /^@?"([\s\S]*)"$/.exec(text.trim());
  if (raw) return raw[1];
  return undefined;
}

/** Strips generics/pointers/qualifiers: `final List<Order>` -> List, `std::shared_ptr<Foo>` -> Foo. */
export function baseTypeName(t: string | undefined): { name?: string; args: string[] } {
  if (!t) return { args: [] };
  let s = t.replace(/\b(const|final|volatile|mut|readonly|struct|class|typename)\b/g, '').replace(/[&*?]/g, '').trim();
  const args: string[] = [];
  const lt = s.indexOf('<');
  if (lt >= 0) {
    const inner = s.slice(lt + 1, s.lastIndexOf('>') > lt ? s.lastIndexOf('>') : undefined);
    for (const a of splitTopLevel(inner)) {
      const b = baseTypeName(a).name;
      if (b) args.push(b);
    }
    s = s.slice(0, lt);
  }
  const bracket = s.indexOf('[');
  if (bracket >= 0) {
    // Python typing: Optional[Foo], List[Foo]
    const inner = s.slice(bracket + 1, s.lastIndexOf(']'));
    for (const a of splitTopLevel(inner)) {
      const b = baseTypeName(a).name;
      if (b) args.push(b);
    }
    s = s.slice(0, bracket);
  }
  s = s.replace(/\[\]$/, '').trim();
  const parts = s.split(/::|\./);
  let name = parts[parts.length - 1]?.trim();
  // Smart pointers / wrappers: use the wrapped type as the effective type.
  const WRAPPERS = new Set(['shared_ptr', 'unique_ptr', 'weak_ptr', 'Optional', 'Option', 'Box', 'Rc', 'Arc', 'Ref', 'Mapped', 'Annotated', 'Promise', 'Lazy', 'Provider', 'Inject']);
  if (name && WRAPPERS.has(name) && args.length) name = args[0];
  return { name: name || undefined, args };
}

export function splitTopLevel(s: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = '';
  for (const ch of s) {
    if (ch === '<' || ch === '[' || ch === '(') depth++;
    if (ch === '>' || ch === ']' || ch === ')') depth--;
    if (ch === ',' && depth === 0) {
      out.push(cur.trim());
      cur = '';
    } else cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}
