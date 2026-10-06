import path from 'node:path';
import type { CallSite, CodeSymbol, Confidence, FieldFact, FileFacts, ImportFact, Lang, ResolvedCall, VarFact } from './types';

const posix = path.posix;

/** Method/function names so generic that matching them by name alone would produce noise. */
const NAME_STOPLIST = new Set(
  (
    'log info warn error debug trace then catch finally map filter reduce forEach push pop shift unshift slice splice concat join split ' +
    'includes indexOf keys values entries toString valueOf equals hashCode length size append extend items format replace trim ' +
    'toLowerCase toUpperCase json status send end set get has add clear apply call bind emit on once off next resolve reject all ' +
    'sort reverse some every assign freeze parse stringify isArray from of max min floor ceil round abs now String Number Boolean ' +
    'print len range str int float list dict tuple isinstance getattr setattr hasattr super Println Printf Sprintf Errorf Error ' +
    'make new cap close copy delete begin size empty push_back emplace_back emplace insert erase at data c_str load store fetch_add ' +
    'fetch_sub lock unlock reset release move forward swap make_shared make_unique printf fprintf snprintf memcpy memset strlen ' +
    'malloc free exit assert require expect it describe test beforeEach afterEach toBe toEqual sleep wait run main init ' +
    'setState useState useEffect useMemo useCallback useRef useContext render createElement querySelector addEventListener ' +
    'setTimeout setInterval clearTimeout clearInterval Sprint Fatal Fatalf Panic Wrap Wrapf unwrap expect clone to_string into ' +
    'iter collect ok err is_some is_none unwrap_or as_str as_ref borrow borrow_mut lower upper strip encode decode read write ' +
    'readline flush getLogger format_exc stream toList collectors orElse orElseThrow isPresent ifPresent stream builder build ' +
    'getMessage printStackTrace ToString Equals GetType Add Remove Contains Count Any Where Select First FirstOrDefault ToList ' +
    'ToListAsync Include ConfigureAwait'
  ).split(/\s+/),
);

/** Receivers whose methods are almost always standard library / framework calls. */
const RECEIVER_STOPLIST = new Set(
  'console Math JSON Object Array Promise Number String Date Reflect Symbol res req ctx next logger log LOG LOGGER Logger std fmt os sys re json time datetime np pd math System System.out System.err Arrays Collections Objects Optional Stream Collectors strings strconv errors sync context http.Error ioutil io bytes filepath path url Console Task Debug Trace String.Format window document localStorage sessionStorage process Buffer'.split(
    ' ',
  ),
);

const IMPLICIT_THIS_LANGS = new Set<Lang>(['java', 'csharp', 'cpp', 'c']);

export interface Resolution {
  targets: CodeSymbol[];
  confidence: Confidence;
  reason: string;
}

export class CodeGraph {
  symbols = new Map<string, CodeSymbol>();
  facts = new Map<string, FileFacts>();
  byName = new Map<string, CodeSymbol[]>();
  classesByName = new Map<string, CodeSymbol[]>();
  membersByContainer = new Map<string, Map<string, CodeSymbol[]>>();
  subtypes = new Map<string, CodeSymbol[]>();
  fieldsByOwner = new Map<string, Map<string, FieldFact>>();
  varsByScope = new Map<string, Map<string, VarFact>>();
  importsByFile = new Map<string, Map<string, ImportFact & { resolved?: string[] }>>();
  symbolsByFile = new Map<string, CodeSymbol[]>();
  aliases = new Map<string, string>();
  topLevelByFile = new Map<string, Map<string, CodeSymbol>>();
  filesByDir = new Map<string, string[]>();
  exportsByFile = new Map<string, FileFacts['exports']>();

  /** Resolved outgoing calls keyed by caller scope id. */
  callsFrom = new Map<string, ResolvedCall[]>();
  /** Reverse edges: target symbol id -> caller info. */
  callsTo = new Map<string, { from: string; site: CallSite; confidence: Confidence; reason: string }[]>();
  resolvedByFile = new Map<string, ResolvedCall[]>();
  stats = { calls: 0, resolved: 0 };

  private tsPaths: { dir: string; baseUrl: string; paths: Record<string, string[]> }[] = [];
  private pyModules = new Map<string, string[]>();
  private goModules: { dir: string; module: string }[] = [];
  private fileSet = new Set<string>();

  constructor(
    public root: string,
    allFacts: FileFacts[],
    configs: { tsconfigs: { file: string; json: any }[]; goMods: { file: string; text: string }[] },
  ) {
    for (const f of allFacts) this.addFacts(f);
    for (const t of configs.tsconfigs) {
      const co = t.json?.compilerOptions ?? {};
      const dir = posix.dirname(t.file);
      if (co.paths || co.baseUrl) this.tsPaths.push({ dir: dir === '.' ? '' : dir, baseUrl: posix.join(dir === '.' ? '' : dir, co.baseUrl ?? '.'), paths: co.paths ?? {} });
    }
    this.tsPaths.sort((a, b) => b.dir.length - a.dir.length);
    for (const g of configs.goMods) {
      const m = /^module\s+(\S+)/m.exec(g.text);
      const dir = posix.dirname(g.file);
      if (m) this.goModules.push({ dir: dir === '.' ? '' : dir, module: m[1] });
    }
    this.linkContainers();
    this.indexPython();
    this.resolveImports();
  }

  private addFacts(f: FileFacts) {
    this.facts.set(f.file, f);
    this.fileSet.add(f.file);
    const dir = posix.dirname(f.file);
    if (!this.filesByDir.has(dir)) this.filesByDir.set(dir, []);
    this.filesByDir.get(dir)!.push(f.file);
    this.symbolsByFile.set(f.file, f.symbols);
    for (const a of f.aliases ?? []) if (!this.aliases.has(a.name)) this.aliases.set(a.name, a.target);
    this.exportsByFile.set(f.file, f.exports);
    const top = new Map<string, CodeSymbol>();
    for (const s of f.symbols) {
      this.symbols.set(s.id, s);
      if (s.kind !== 'handler') push(this.byName, s.name, s);
      if (s.kind === 'class' || s.kind === 'interface' || s.kind === 'struct' || s.kind === 'enum') {
        push(this.classesByName, s.name, s);
        for (const sup of s.supers ?? []) push(this.subtypes, sup.split('.').pop()!, s);
      }
      if (!s.container && s.kind !== 'handler' && !top.has(s.name)) top.set(s.name, s);
      if (s.container && s.kind !== 'handler') {
        let m = this.membersByContainer.get(s.container);
        if (!m) this.membersByContainer.set(s.container, (m = new Map()));
        push(m, s.name, s);
      }
    }
    // Classes are also reachable as top-level names even when nested inside a namespace.
    for (const s of f.symbols) if ((s.kind === 'class' || s.kind === 'struct' || s.kind === 'interface') && !top.has(s.name)) top.set(s.name, s);
    this.topLevelByFile.set(f.file, top);
    for (const fl of f.fields) {
      let m = this.fieldsByOwner.get(fl.owner);
      if (!m) this.fieldsByOwner.set(fl.owner, (m = new Map()));
      if (!m.has(fl.name) || (!m.get(fl.name)!.type && fl.type)) m.set(fl.name, fl);
    }
    for (const v of f.vars) {
      let m = this.varsByScope.get(v.scope);
      if (!m) this.varsByScope.set(v.scope, (m = new Map()));
      if (!m.has(v.name) || (!m.get(v.name)!.type && v.type)) m.set(v.name, v);
    }
  }

  /** Go/C++/Rust methods can live outside their type's file; link them to the type symbol by name. */
  private linkContainers() {
    for (const s of this.symbols.values()) {
      if (s.container && !s.containerId) {
        const cls = this.pickClosest(this.classesByName.get(s.container) ?? [], s.file);
        if (cls) s.containerId = cls.id;
      }
    }
  }

  private indexPython() {
    for (const file of this.fileSet) {
      if (!file.endsWith('.py')) continue;
      let mod = file.slice(0, -3).split('/');
      if (mod[mod.length - 1] === '__init__') mod = mod.slice(0, -1);
      for (let i = 0; i < mod.length; i++) push(this.pyModules, mod.slice(i).join('.'), file);
    }
  }

  // ---------- module resolution ----------

  private tryJsFile(base: string): string | undefined {
    const exts = ['', '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.vue', '.svelte', '/index.ts', '/index.tsx', '/index.js', '/index.jsx', '/index.mjs'];
    const clean = base.replace(/\.(js|jsx|mjs|cjs)$/, '');
    for (const cand of [base, clean]) for (const e of exts) if (this.fileSet.has(cand + e)) return cand + e;
    return undefined;
  }

  resolveModule(fromFile: string, source: string, lang: Lang): string[] {
    if (lang === 'javascript' || lang === 'typescript' || lang === 'tsx') {
      if (source.startsWith('.')) {
        const r = this.tryJsFile(posix.normalize(posix.join(posix.dirname(fromFile), source)));
        return r ? [r] : [];
      }
      for (const cfg of this.tsPaths) {
        if (cfg.dir && !fromFile.startsWith(cfg.dir + '/')) continue;
        for (const [pattern, targets] of Object.entries(cfg.paths)) {
          const star = pattern.indexOf('*');
          const prefix = star >= 0 ? pattern.slice(0, star) : pattern;
          if (star >= 0 ? source.startsWith(prefix) : source === pattern) {
            const rest = star >= 0 ? source.slice(prefix.length) : '';
            for (const t of targets) {
              const r = this.tryJsFile(posix.normalize(posix.join(cfg.baseUrl, t.replace('*', rest))));
              if (r) return [r];
            }
          }
        }
        const r = this.tryJsFile(posix.normalize(posix.join(cfg.baseUrl, source)));
        if (r) return [r];
      }
      // Common unconfigured aliases, resolved from the importing file's project (monorepos have several):
      // "@/x", "~/x" (Vite, Vue, Nuxt) -> src/x, x or app/x; "~~/x", "@@/x" (Nuxt root); "$lib/x" (SvelteKit) -> src/lib/x
      const m = /^(\$lib|~~|@@|[@~])\/(.*)$/.exec(source);
      if (m) {
        const bases = m[1] === '$lib' ? ['src/lib'] : m[1].length === 2 ? [''] : ['src', '', 'app'];
        for (let dir = posix.dirname(fromFile); ; dir = posix.dirname(dir)) {
          for (const base of bases) {
            const r = this.tryJsFile(posix.join(dir === '.' ? '' : dir, base, m[2]));
            if (r) return [r];
          }
          if (dir === '.' || dir === '/' || dir === '') break;
        }
      }
      return [];
    }
    if (lang === 'python') {
      if (source.startsWith('.')) {
        const dots = /^\.+/.exec(source)![0].length;
        let dir = posix.dirname(fromFile);
        for (let i = 1; i < dots; i++) dir = posix.dirname(dir);
        const rest = source.slice(dots).replace(/\./g, '/');
        const base = rest ? posix.join(dir === '.' ? '' : dir, rest) : dir;
        const out: string[] = [];
        if (this.fileSet.has(base + '.py')) out.push(base + '.py');
        if (this.fileSet.has(posix.join(base, '__init__.py'))) out.push(posix.join(base, '__init__.py'));
        return out;
      }
      const cands = this.pyModules.get(source) ?? [];
      if (cands.length <= 1) return cands;
      // Prefer the candidate whose path is closest to the importing file.
      return [this.closestFile(cands, fromFile)];
    }
    if (lang === 'go') {
      for (const gm of this.goModules) {
        if (source === gm.module || source.startsWith(gm.module + '/')) {
          const rel = posix.join(gm.dir, source.slice(gm.module.length + 1));
          return this.filesByDir.get(rel || '.') ?? [];
        }
      }
      return [];
    }
    if (lang === 'java') {
      const cls = this.classesByName.get(source.split('.').pop()!);
      const hit = cls?.find((c) => c.lang === 'java' && source.replace(/\./g, '/').endsWith(c.file.replace(/\.java$/, '').split('/').slice(-source.split('.').length).join('/')));
      return hit ? [hit.file] : cls?.length === 1 ? [cls[0].file] : [];
    }
    if (lang === 'c' || lang === 'cpp') {
      const local = posix.normalize(posix.join(posix.dirname(fromFile), source));
      if (this.fileSet.has(local)) return [local];
      const hits: string[] = [];
      for (const f of this.fileSet) if (f === source || f.endsWith('/' + source)) hits.push(f);
      return hits.length ? [this.closestFile(hits, fromFile)] : [];
    }
    return [];
  }

  private resolveImports() {
    for (const [file, f] of this.facts) {
      const m = new Map<string, ImportFact & { resolved?: string[] }>();
      for (const imp of f.imports) {
        let resolved = this.resolveModule(file, imp.source, f.lang);
        let entry = { ...imp, resolved };
        if (f.lang === 'python' && imp.imported !== '*') {
          // `from pkg import mod` may import a submodule rather than a symbol
          const sub = this.resolveModule(file, imp.source.endsWith('.') ? imp.source + imp.imported : `${imp.source}.${imp.imported}`, 'python');
          if (sub.length && !resolved.some((r) => this.topLevelByFile.get(r)?.has(imp.imported))) {
            resolved = sub;
            entry = { ...imp, imported: '*', resolved };
          }
        }
        m.set(imp.local, entry);
      }
      this.importsByFile.set(file, m);
    }
  }

  // ---------- lookups ----------

  closestFile(files: string[], from: string): string {
    let best = files[0];
    let bestScore = -1;
    for (const f of files) {
      const s = commonPrefixLen(f, from);
      if (s > bestScore) {
        best = f;
        bestScore = s;
      }
    }
    return best;
  }

  pickClosest(cands: CodeSymbol[], fromFile: string): CodeSymbol | undefined {
    if (cands.length <= 1) return cands[0];
    const same = cands.filter((c) => c.file === fromFile);
    if (same.length) return same[0];
    let best = cands[0];
    let bestScore = -1;
    for (const c of cands) {
      const s = commonPrefixLen(c.file, fromFile);
      if (s > bestScore) {
        best = c;
        bestScore = s;
      }
    }
    return best;
  }

  /** Export lookup through re-exports and CommonJS patterns. Returns a symbol, or a module-level var name. */
  lookupExport(file: string, name: string, depth = 0): { sym?: CodeSymbol; varName?: string; file: string } | undefined {
    if (depth > 5) return undefined;
    const exports = this.exportsByFile.get(file) ?? [];
    const top = this.topLevelByFile.get(file);
    if (name === 'default') {
      const sym = (this.symbolsByFile.get(file) ?? []).find((s) => s.isDefaultExport);
      if (sym) return { sym, file };
      const ex = exports.find((e) => e.isDefault && !e.source);
      if (ex) {
        const s = top?.get(ex.local);
        return s ? { sym: s, file } : { varName: ex.local, file };
      }
      const re = exports.find((e) => e.isDefault && e.source);
      if (re) {
        const target = this.resolveModule(file, re.source!, this.facts.get(file)!.lang)[0];
        if (target) return this.lookupExport(target, re.local, depth + 1);
      }
      return undefined;
    }
    const ex = exports.find((e) => e.name === name);
    if (ex && !ex.source) {
      const s = top?.get(ex.local);
      return s ? { sym: s, file } : { varName: ex.local, file };
    }
    if (ex?.source) {
      const target = this.resolveModule(file, ex.source, this.facts.get(file)!.lang)[0];
      if (target) return this.lookupExport(target, ex.local, depth + 1);
    }
    const s = top?.get(name);
    if (s) return { sym: s, file };
    for (const star of exports.filter((e) => e.name === '*' && e.source)) {
      const target = this.resolveModule(file, star.source!, this.facts.get(file)!.lang)[0];
      if (target) {
        const r = this.lookupExport(target, name, depth + 1);
        if (r) return r;
      }
    }
    // Default export object with this property (module.exports = { name })
    return undefined;
  }

  /** Find a member through the type hierarchy. */
  findMember(typeName: string, member: string, fromFile: string, seen = new Set<string>()): CodeSymbol[] {
    if (seen.has(typeName) || seen.size > 12) return [];
    seen.add(typeName);
    const members = this.membersByContainer.get(typeName)?.get(member);
    if (members?.length) {
      const closest = members.length > 1 ? members.filter((m) => posix.dirname(m.file) === posix.dirname(this.pickClosest(members, fromFile)!.file)) : members;
      return closest;
    }
    for (const cls of this.classesByName.get(typeName) ?? []) {
      for (const sup of cls.supers ?? []) {
        const r = this.findMember(sup.split('.').pop()!, member, fromFile, seen);
        if (r.length) return r;
      }
    }
    return [];
  }

  implementationsOf(typeName: string, member: string, fromFile: string): CodeSymbol[] {
    const out: CodeSymbol[] = [];
    const queue = [...(this.subtypes.get(typeName) ?? [])];
    const seen = new Set<string>();
    while (queue.length && out.length < 6) {
      const sub = queue.shift()!;
      if (seen.has(sub.id)) continue;
      seen.add(sub.id);
      const m = this.membersByContainer.get(sub.name)?.get(member);
      if (m?.length) out.push(...m.filter((x) => x.kind !== 'handler'));
      queue.push(...(this.subtypes.get(sub.name) ?? []));
    }
    void fromFile;
    return out;
  }

  fieldType(owner: string, name: string, seen = new Set<string>()): string | undefined {
    if (seen.has(owner)) return undefined;
    seen.add(owner);
    const f = this.fieldsByOwner.get(owner)?.get(name);
    if (f?.type) return f.type;
    for (const cls of this.classesByName.get(owner) ?? []) {
      for (const sup of cls.supers ?? []) {
        const t = this.fieldType(sup.split('.').pop()!, name, seen);
        if (t) return t;
      }
    }
    return undefined;
  }

  /** Follow `using X = Y` / typedef chains to the real type name. */
  unalias(t: string | undefined): string | undefined {
    for (let i = 0; t && i < 5 && this.aliases.has(t) && !this.classesByName.has(t); i++) t = this.aliases.get(t);
    return t;
  }

  /** Best-effort static type of a receiver expression inside a scope. */
  inferType(expr: string, scope: CodeSymbol | undefined, file: string, depth = 0): string | undefined {
    return this.unalias(this.inferTypeRaw(expr, scope, file, depth));
  }

  private inferTypeRaw(expr: string, scope: CodeSymbol | undefined, file: string, depth = 0): string | undefined {
    if (depth > 4) return undefined;
    let e = expr.trim().replace(/^await\s+/, '').replace(/->/g, '.').replace(/^\(+|\)+$/g, '');
    e = e.replace(/^\*+/, '');
    const cls = scope?.container;
    if (e === 'this' || e === 'self' || e === 'Self') return cls;
    if (e === 'super' || e === 'base') {
      const c = cls ? this.classesByName.get(cls)?.[0] : undefined;
      return c?.supers?.[0];
    }
    const lastDot = e.lastIndexOf('.');
    if (lastDot > 0) {
      const head = e.slice(0, lastDot);
      const tail = e.slice(lastDot + 1);
      if (!/^\w+$/.test(tail)) return undefined;
      const ht = this.inferType(head, scope, file, depth + 1);
      if (ht) return this.unalias(this.fieldType(ht, tail));
      return undefined;
    }
    if (!/^\w+$/.test(e)) return undefined;
    // locals and params of the current scope
    const v = scope ? this.varsByScope.get(scope.id)?.get(e) : undefined;
    if (v?.type) return v.type;
    if (v?.call && /^[A-Z]/.test(v.call.callee) && this.classesByName.has(v.call.callee)) return v.call.callee;
    // implicit field access (Java/C#/C++/Go-style receivers are already in vars)
    if (cls) {
      const ft = this.fieldType(cls, e);
      if (ft) return ft;
    }
    // module-level variables
    const mv = this.varsByScope.get(`file:${file}`)?.get(e);
    if (mv?.type) return mv.type;
    if (mv?.call && /^[A-Z]/.test(mv.call.callee) && this.classesByName.has(mv.call.callee)) return mv.call.callee;
    return undefined;
  }

  // ---------- call resolution ----------

  resolveAll() {
    for (const [file, f] of this.facts) {
      const list: ResolvedCall[] = [];
      for (const site of f.calls) {
        this.stats.calls++;
        const r = this.resolveCall(site, file, f.lang);
        if (!r || !r.targets.length) continue;
        // Never link a function to itself through a guess (recursion is rare and guesses are often wrong).
        const targets = r.targets.filter((t) => t.id !== site.from || r.confidence === 'certain');
        if (!targets.length) continue;
        this.stats.resolved++;
        const rc: ResolvedCall = { site, targets: targets.map((t) => t.id), confidence: r.confidence, reason: r.reason };
        list.push(rc);
        push(this.callsFrom, site.from, rc);
        for (const t of targets) push(this.callsTo, t.id, { from: site.from, site, confidence: r.confidence, reason: r.reason });
      }
      this.resolvedByFile.set(file, list);
    }
  }

  resolveCall(site: CallSite, file: string, lang: Lang): Resolution | undefined {
    const scope = this.symbols.get(site.from);
    const name = site.callee;
    const imports = this.importsByFile.get(file);
    const top = this.topLevelByFile.get(file);

    if (!site.receiver && name === 'import' && site.args[0]?.kind === 'string' && site.args[0].value && (lang === 'javascript' || lang === 'typescript' || lang === 'tsx')) {
      for (const r of this.resolveModule(file, site.args[0].value, lang)) {
        const def = this.lookupExport(r, 'default')?.sym;
        if (def) return { targets: [def], confidence: 'certain', reason: `loaded lazily from ${site.args[0].value}` };
      }
      return undefined;
    }
    if (!site.receiver) {
      // 1. sibling method via implicit this
      if (scope?.container && IMPLICIT_THIS_LANGS.has(lang)) {
        const m = byArity(this.findMember(scope.container, name, file), site.args.length);
        if (m.length) return { targets: m, confidence: 'certain', reason: `method of ${scope.container}` };
      }
      // 2. same file
      const local = top?.get(name);
      if (local && local.id !== site.from) return { targets: [this.ctorOrClass(local)], confidence: 'certain', reason: 'defined in the same file' };
      // 2b. a function destructured from a hook/composable/store: const { fetchUsers } = useUsers()
      const dv = this.varsByScope.get(site.from)?.get(name) ?? this.varsByScope.get(`file:${file}`)?.get(name);
      if (dv?.member && dv.call) {
        const m = this.factoryMember(dv.call.callee, dv.member, file, site.from, lang);
        if (m) return { targets: [m], confidence: 'certain', reason: `${dv.member} returned by ${dv.call.callee}()` };
      }
      // 3. imported binding
      const imp = imports?.get(name);
      if (imp) {
        const t = this.fromImport(imp, imp.imported === '*' ? 'default' : imp.imported);
        if (t.length) return { targets: t.map((x) => this.ctorOrClass(x)), confidence: 'certain', reason: `imported from ${imp.source}` };
        if (!imp.resolved?.length) return undefined; // third-party import: stop here
      }
      // 4. Go: same package (directory)
      if (lang === 'go') {
        const pkg = this.filesByDir.get(posix.dirname(file)) ?? [];
        for (const pf of pkg) {
          const s = this.topLevelByFile.get(pf)?.get(name);
          if (s) return { targets: [s], confidence: 'certain', reason: 'same Go package' };
        }
      }
      // 5. Python star imports
      if (lang === 'python') {
        for (const im of imports?.values() ?? []) {
          if (im.local !== '*') continue;
          for (const r of im.resolved ?? []) {
            const s = this.topLevelByFile.get(r)?.get(name);
            if (s) return { targets: [s], confidence: 'certain', reason: `star import from ${im.source}` };
          }
        }
      }
      // 6. class instantiation
      const classes = this.classesByName.get(name);
      if (classes?.length && (site.isNew || /^[A-Z]/.test(name))) {
        const c = this.pickClosest(classes, file)!;
        const target = this.ctorOrClass(c);
        // Plain data structs (`Tick t{}`) have no constructor code worth showing.
        if (target === c && (lang === 'c' || lang === 'cpp' || lang === 'go' || lang === 'rust') && !site.args.length) return undefined;
        return { targets: [target], confidence: classes.length === 1 ? 'certain' : 'likely', reason: `creates ${name}` };
      }
      if (NAME_STOPLIST.has(name)) return undefined;
      // 7. global name match (functions only)
      const cands = (this.byName.get(name) ?? []).filter((s) => s.kind === 'function' && s.id !== site.from && langFamily(s.lang) === langFamily(lang));
      if (cands.length === 1) return { targets: cands, confidence: 'likely', reason: `only function named ${name}` };
      if (cands.length > 1 && cands.length <= 3) return { targets: [this.pickClosest(cands, file)!], confidence: 'guess', reason: `${cands.length} functions named ${name}; picked the closest` };
      return undefined;
    }

    // ----- receiver calls -----
    const recv = site.receiver.replace(/->/g, '.').replace(/\?\./g, '.').trim();
    if (RECEIVER_STOPLIST.has(recv) || RECEIVER_STOPLIST.has(recv.split('.')[0]) && !imports?.has(recv.split('.')[0])) {
      if (!(recv === 'this' || recv === 'self')) return undefined;
    }

    // a) typed receiver
    const type = this.inferType(recv, scope, file);
    if (type) {
      const r = this.memberOnType(type, name, file, site.args.length);
      if (r) return r;
    }

    // a2) the receiver came from a factory: const store = useUserStore(); store.fetchUsers()
    if (/^[\w$]+$/.test(recv) && (lang === 'javascript' || lang === 'typescript' || lang === 'tsx')) {
      const v = this.varsByScope.get(site.from)?.get(recv) ?? this.varsByScope.get(`file:${file}`)?.get(recv);
      if (v?.call && !v.call.receiver && !v.member && /^(use|create|make|get)[A-Z]|Store$|Service$/.test(v.call.callee)) {
        const m = this.factoryMember(v.call.callee, name, file, site.from, lang);
        if (m) return { targets: [m], confidence: 'certain', reason: `${name} returned by ${v.call.callee}()` };
      }
    }

    // b) module / namespace receiver (import * as svc / python module / go package / C++ namespace)
    const head = recv.split('.')[0];
    const imp = imports?.get(recv) ?? imports?.get(head);
    if (imp) {
      if (imp.imported === '*' || imp.imported === 'default') {
        for (const r of imp.resolved ?? []) {
          const ex = this.lookupExport(r, name);
          if (ex?.sym) return { targets: [this.ctorOrClass(ex.sym)], confidence: 'certain', reason: `${name} exported by ${r}` };
          // default-exported object/instance: module.exports = new Service()
          const def = this.lookupExport(r, 'default');
          const defType = def?.sym && (def.sym.kind === 'class' ? def.sym.name : undefined);
          const vType = def?.varName ? this.varsByScope.get(`file:${r}`)?.get(def.varName)?.type : undefined;
          const t = defType ?? vType;
          if (t) {
            const m = this.memberOnType(t, name, file, site.args.length);
            if (m) return m;
          }
          // Go: package-level function in that package
          if (lang === 'go') {
            const s = this.topLevelByFile.get(r)?.get(name);
            if (s) return { targets: [s], confidence: 'certain', reason: `package ${imp.local}` };
          }
        }
      } else {
        // named import used as receiver: an exported instance or class
        const t = this.fromImport(imp, imp.imported);
        for (const s of t) {
          if (s.kind === 'class' || s.kind === 'interface' || s.kind === 'struct') {
            const m = this.memberOnType(s.name, name, file, site.args.length);
            if (m) return m;
          }
        }
        for (const r of imp.resolved ?? []) {
          const v = this.varsByScope.get(`file:${r}`)?.get(imp.imported);
          if (v?.type) {
            const m = this.memberOnType(v.type, name, file, site.args.length);
            if (m) return m;
          }
        }
      }
      if (!imp.resolved?.length && !this.classesByName.has(head)) return undefined; // third-party
    }

    // c) static call on a class name: Foo.bar() / Foo::bar()
    const lastPart = recv.split(/\.|::/).pop()!;
    if (/^[A-Z]/.test(lastPart) && this.classesByName.has(lastPart)) {
      const r = this.memberOnType(lastPart, name, file, site.args.length);
      if (r) return r;
    }

    // d) fallback: unique method name across the project
    if (NAME_STOPLIST.has(name) || name.length < 3) return undefined;
    const cands = (this.byName.get(name) ?? []).filter((s) => (s.kind === 'method' || s.kind === 'function') && s.id !== site.from && langFamily(s.lang) === langFamily(lang));
    if (cands.length === 1) return { targets: cands, confidence: 'guess', reason: `only method named ${name} (receiver type unknown)` };
    if (cands.length > 1 && cands.length <= 3) {
      const containers = new Set(cands.map((c) => c.container));
      // If all candidates share a hierarchy (interface + impl), prefer the concrete ones.
      const concrete = cands.filter((c) => c.containerId && this.symbols.get(c.containerId)?.kind !== 'interface');
      if (containers.size <= 2 && concrete.length) return { targets: concrete.slice(0, 2), confidence: 'guess', reason: `${cands.length} methods named ${name} (receiver type unknown)` };
    }
    return undefined;
  }

  private memberOnType(type: string, name: string, file: string, argCount?: number): Resolution | undefined {
    const typeSyms = this.classesByName.get(type);
    const members = byArity(this.findMember(type, name, file), argCount);
    const isAbstract = (s?: CodeSymbol) => !!s && (s.kind === 'interface' || /\babstract\b/.test(s.signature));
    const ownerOf = (m: CodeSymbol) => (m.containerId ? this.symbols.get(m.containerId) : this.classesByName.get(m.container ?? '')?.[0]);
    if (members.length) {
      const owner = ownerOf(members[0]);
      if (isAbstract(owner) || members.every((m) => m.range.el - m.range.sl < 1 && m.lang !== 'python')) {
        const impls = this.implementationsOf(owner?.name ?? type, name, file);
        if (impls.length) return { targets: impls.slice(0, 3), confidence: impls.length === 1 ? 'certain' : 'likely', reason: `${type} is an interface; implemented by ${[...new Set(impls.map((i) => i.container))].join(', ')}` };
      }
      return { targets: members, confidence: 'certain', reason: `${name} on ${type}` };
    }
    // Interface with only implementations defining the method (Go interfaces, TS interfaces)
    const impls = this.implementationsOf(type, name, file);
    if (impls.length) return { targets: impls.slice(0, 3), confidence: impls.length === 1 ? 'certain' : 'likely', reason: `implemented by ${[...new Set(impls.map((i) => i.container))].join(', ')}` };
    if (typeSyms?.length) {
      // Known project type but the method is inherited from a framework (e.g. JpaRepository.findAll)
      const t = this.pickClosest(typeSyms, file)!;
      return { targets: [t], confidence: 'likely', reason: `${name}() is inherited by ${type} from ${t.supers?.join(', ') || 'a library'}` };
    }
    return undefined;
  }

  private factoryDepth = 0;
  private nestedByParent?: Map<string, Map<string, CodeSymbol>>;
  /**
   * A function named `member` defined inside the factory `factoryName` resolves to: a composable/hook
   * (`function useUsers() { async function fetchUsers() {…} return { fetchUsers } }`) or a Pinia setup store
   * (`export const useUserStore = defineStore('users', () => { … })`).
   */
  factoryMember(factoryName: string, member: string, file: string, from: string, lang: Lang): CodeSymbol | undefined {
    if (!this.nestedByParent) {
      this.nestedByParent = new Map();
      for (const s of this.symbols.values()) {
        if (!s.parentFn) continue;
        const m = this.nestedByParent.get(s.parentFn) ?? new Map<string, CodeSymbol>();
        if (!m.has(s.name)) m.set(s.name, s);
        this.nestedByParent.set(s.parentFn, m);
      }
    }
    if (this.factoryDepth > 3) return undefined;
    const setups: CodeSymbol[] = [];
    this.factoryDepth++;
    const r = this.resolveCall({ from, callee: factoryName, args: [], range: { sl: 0, sc: 0, el: 0, ec: 0 } }, file, lang);
    this.factoryDepth--;
    if (r?.confidence !== 'guess') setups.push(...(r?.targets ?? []));
    // The factory may be a variable holding a wrapped setup function: defineStore('id', () => {…}), createSharedComposable(() => {…})
    const fromVar = (vf: string, varName: string) => {
      const v = this.varsByScope.get(`file:${vf}`)?.get(varName);
      for (const a of v?.call?.args ?? []) if (a.kind === 'func' && a.symbolId && this.symbols.has(a.symbolId)) setups.push(this.symbols.get(a.symbolId)!);
    };
    fromVar(file, factoryName);
    const imp = this.importsByFile.get(file)?.get(factoryName);
    for (const rf of imp?.resolved ?? []) {
      const ex = this.lookupExport(rf, imp!.imported === '*' ? 'default' : imp!.imported);
      if (ex?.varName) fromVar(ex.file, ex.varName);
    }
    for (const s of setups) {
      const m = this.nestedByParent.get(s.id)?.get(member);
      if (m) return m;
    }
    return undefined;
  }

  private fromImport(imp: ImportFact & { resolved?: string[] }, name: string): CodeSymbol[] {
    const out: CodeSymbol[] = [];
    for (const r of imp.resolved ?? []) {
      const ex = this.lookupExport(r, name);
      if (ex?.sym) out.push(ex.sym);
    }
    return out;
  }

  private ctorOrClass(s: CodeSymbol): CodeSymbol {
    if (s.kind !== 'class' && s.kind !== 'struct') return s;
    const ctor = this.membersByContainer.get(s.name)?.get(s.lang === 'python' ? '__init__' : s.lang === 'javascript' || s.lang === 'typescript' || s.lang === 'tsx' ? 'constructor' : s.name);
    // C++ constructors are often defined in the .cpp next to the header that declares the class.
    return ctor?.find((c) => c.file === s.file) ?? ctor?.find((c) => posix.dirname(c.file) === posix.dirname(s.file)) ?? s;
  }
}

/** Count top-level parameters in a signature like `void foo(int a, Map<K, V> b)`. */
export function paramCount(signature: string): number | undefined {
  const open = signature.indexOf('(');
  if (open < 0) return undefined;
  let depth = 0;
  let count = 0;
  let any = false;
  for (let i = open + 1; i < signature.length; i++) {
    const ch = signature[i];
    if (ch === '(' || ch === '<' || ch === '[' || ch === '{') depth++;
    else if (ch === ')' || ch === '>' || ch === ']' || ch === '}') {
      if (depth === 0) return any ? count + 1 : 0;
      depth--;
    } else if (ch === ',' && depth === 0) count++;
    else if (!/\s/.test(ch)) any = true;
  }
  return undefined;
}

/** Narrow overloads by argument count; keep everything when nothing matches exactly (varargs, defaults). */
function byArity(cands: CodeSymbol[], argCount?: number): CodeSymbol[] {
  if (cands.length <= 1 || argCount === undefined) return cands;
  const exact = cands.filter((c) => {
    let n = paramCount(c.signature);
    if (n === undefined) return true;
    if (c.lang === 'python' && /\(\s*(self|cls)\b/.test(c.signature)) n--;
    return n === argCount;
  });
  return exact.length ? exact : cands;
}

function langFamily(l: Lang): string {
  if (l === 'javascript' || l === 'typescript' || l === 'tsx') return 'js';
  if (l === 'c' || l === 'cpp') return 'c';
  return l;
}

function push<K, V>(m: Map<K, V[]>, k: K, v: V) {
  const arr = m.get(k);
  if (arr) arr.push(v);
  else m.set(k, [v]);
}

function commonPrefixLen(a: string, b: string): number {
  const pa = a.split('/');
  const pb = b.split('/');
  let i = 0;
  while (i < pa.length && i < pb.length && pa[i] === pb[i]) i++;
  return i;
}
