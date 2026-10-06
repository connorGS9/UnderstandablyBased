import path from 'node:path';
import type { Annotation, Arg, CallSite, EntryPoint, FileFacts } from './types';
import type { CodeGraph } from './graph';
import type { SinkIndex } from './sinks';

const posix = path.posix;
const HTTP_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'HEAD'];

export function joinPaths(...parts: (string | undefined)[]): string {
  const joined = parts
    .filter((p) => p !== undefined && p !== '')
    .map((p) => p!.trim())
    .join('/')
    .replace(/\/{2,}/g, '/');
  let out = joined.startsWith('/') ? joined : '/' + joined;
  if (out.length > 1 && out.endsWith('/')) out = out.slice(0, -1);
  return out;
}

const strArgs = (args: Arg[] | undefined, key?: string): string[] => {
  const out: string[] = [];
  for (const a of args ?? []) {
    if (key !== undefined && a.key !== key) continue;
    if (key === undefined && a.key && a.key !== 'value' && a.key !== 'path') continue;
    if (a.kind === 'string' && a.value !== undefined) out.push(a.value);
    if (a.kind === 'array') for (const it of a.items ?? []) if (it.kind === 'string' && it.value !== undefined) out.push(it.value);
  }
  return out;
};

const TEST_FILE = /(^|\/)(__tests__|__mocks__|tests?|spec|specs|testing|e2e|fixtures?)\/|\.(test|spec)\.[jt]sx?$|_test\.(go|py)$|(^|\/)test_[^/]+\.py$|Tests?\.(java|cs|kt)$/;

/** `/${endpoint}/x` -> `/{endpoint}/x` so dynamic segments read like route parameters. */
function cleanPath(p: string | undefined): string | undefined {
  return p?.replace(/\$\{(?:this\.)?([^}]+)\}/g, '{$1}');
}

class EntryCollector {
  entries: EntryPoint[] = [];
  private ids = new Map<string, number>();

  add(e: Omit<EntryPoint, 'id'> & { id?: string }) {
    if (e.file && TEST_FILE.test(e.file) && e.kind !== 'channel') return;
    if (e.path) {
      e.path = cleanPath(e.path);
      e.label = e.kind === 'http-route' ? `${e.method} ${e.path}` : e.kind === 'page' ? e.path! : e.label;
    }
    let id = e.id ?? `${e.kind}:${e.method ?? ''} ${e.path ?? e.label}`;
    const n = this.ids.get(id) ?? 0;
    this.ids.set(id, n + 1);
    if (n) id = `${id}#${n + 1}`;
    this.entries.push({ ...e, id } as EntryPoint);
  }
}

// ---------------- annotation-based controllers ----------------

const SPRING_METHOD: Record<string, string> = { GetMapping: 'GET', PostMapping: 'POST', PutMapping: 'PUT', DeleteMapping: 'DELETE', PatchMapping: 'PATCH' };
const NEST_METHOD: Record<string, string> = { Get: 'GET', Post: 'POST', Put: 'PUT', Delete: 'DELETE', Patch: 'PATCH', Options: 'OPTIONS', Head: 'HEAD', All: 'ANY' };
const ASPNET_METHOD: Record<string, string> = { HttpGet: 'GET', HttpPost: 'POST', HttpPut: 'PUT', HttpDelete: 'DELETE', HttpPatch: 'PATCH', HttpHead: 'HEAD', HttpOptions: 'OPTIONS' };
const JAXRS_METHOD: Record<string, string> = { GET: 'GET', POST: 'POST', PUT: 'PUT', DELETE: 'DELETE', PATCH: 'PATCH', HEAD: 'HEAD', OPTIONS: 'OPTIONS' };

function annotationControllers(graph: CodeGraph, out: EntryCollector) {
  for (const cls of graph.symbols.values()) {
    if (cls.kind !== 'class') continue;
    const anns = cls.annotations;
    const lang = cls.lang;
    let prefixes: string[] = [''];
    let framework = '';
    const reqMap = anns.find((a) => a.name === 'RequestMapping');
    // NestJS @Controller, routing-controllers @JsonController, n8n-style @RestController
    const nestCtl = lang !== 'java' && lang !== 'csharp' ? anns.find((a) => /^(Controller|RestController|JsonController|ApiController)$/.test(a.name)) : undefined;
    const aspRoute = lang === 'csharp' ? anns.find((a) => a.name === 'Route') : undefined;
    const jaxPath = lang === 'java' ? anns.find((a) => a.name === 'Path') : undefined;
    if (reqMap) {
      prefixes = strArgs(reqMap.args).length ? strArgs(reqMap.args) : [''];
      framework = 'Spring MVC';
    } else if (nestCtl) {
      const a = nestCtl.args[0];
      prefixes = a?.kind === 'string' ? [a.value ?? ''] : a?.kind === 'object' ? [a.items?.find((i) => i.key === 'path')?.value ?? ''] : [''];
      framework = 'NestJS';
    } else if (aspRoute) {
      prefixes = strArgs(aspRoute.args);
      framework = 'ASP.NET Core';
    } else if (jaxPath) {
      prefixes = strArgs(jaxPath.args);
      framework = 'JAX-RS';
    }
    const members = [...(graph.membersByContainer.get(cls.name)?.values() ?? [])].flat().filter((m) => m.containerId === cls.id);
    const guardsOf = (list: Annotation[]) => resolveGuards(graph, guardNames(list));
    const classGuards = guardsOf(anns);
    for (const m of members) {
      for (const a of m.annotations) {
        let methods: string[] = [];
        let paths: string[] = [];
        let fw = framework;
        if (lang === 'java' || lang === 'csharp' || lang === 'typescript' || lang === 'tsx' || lang === 'javascript') {
          if (lang === 'java' && SPRING_METHOD[a.name]) {
            methods = [SPRING_METHOD[a.name]];
            paths = strArgs(a.args);
            fw = 'Spring MVC';
          } else if (lang === 'java' && a.name === 'RequestMapping') {
            const mArg = a.args.find((x) => x.key === 'method');
            const ms = mArg ? (mArg.items ?? [mArg]).map((x) => x.text.split('.').pop()!.toUpperCase()) : ['ANY'];
            methods = ms;
            paths = strArgs(a.args);
            fw = 'Spring MVC';
          } else if (lang === 'java' && JAXRS_METHOD[a.name]) {
            methods = [JAXRS_METHOD[a.name]];
            const p = m.annotations.find((x) => x.name === 'Path');
            paths = p ? strArgs(p.args) : [''];
            fw = 'JAX-RS';
          } else if ((lang === 'typescript' || lang === 'tsx' || lang === 'javascript') && NEST_METHOD[a.name] && (nestCtl || framework === 'NestJS')) {
            methods = [NEST_METHOD[a.name]];
            const p = a.args[0];
            paths = p?.kind === 'string' ? [p.value ?? ''] : p?.kind === 'array' ? strArgs([p]) : [''];
            fw = 'NestJS';
          } else if (lang === 'csharp' && ASPNET_METHOD[a.name]) {
            methods = [ASPNET_METHOD[a.name]];
            const own = strArgs(a.args);
            const r = m.annotations.find((x) => x.name === 'Route');
            paths = own.length ? own : r ? strArgs(r.args) : [''];
            fw = 'ASP.NET Core';
          }
        }
        if (!methods.length) continue;
        if (!paths.length) paths = [''];
        for (const pre of prefixes) {
          for (const p of paths) {
            let full: string;
            if (fw === 'ASP.NET Core') {
              const ctl = cls.name.replace(/Controller$/, '');
              full = p.startsWith('/') || p.startsWith('~/') ? joinPaths(p.replace(/^~/, '')) : joinPaths(pre, p);
              full = full.replace(/\[controller\]/gi, ctl.toLowerCase()).replace(/\[action\]/gi, m.name.toLowerCase());
            } else full = joinPaths(pre, p);
            for (const method of methods) {
              out.add({
                kind: 'http-route',
                label: `${method} ${full}`,
                method,
                path: full,
                group: cls.name,
                framework: fw || 'annotations',
                handlerId: m.id,
                handlerName: `${cls.name}.${m.name}`,
                middleware: [...classGuards, ...guardsOf(m.annotations)],
                file: m.file,
                line: m.range.sl,
              });
            }
          }
        }
      }
    }
  }
}

function guardNames(anns: Annotation[]): { name: string; classes: string[] }[] {
  const out: { name: string; classes: string[] }[] = [];
  for (const a of anns) {
    if (/^(UseGuards|UseInterceptors|UsePipes|UseFilters|Authorize|PreAuthorize|Secured|RolesAllowed|login_required|permission_required)$/.test(a.name)) {
      const inner = a.args.map((x) => x.value ?? x.text).filter(Boolean);
      out.push({ name: inner.length ? `${a.name}(${inner.join(', ')})` : a.name, classes: a.args.filter((x) => x.kind === 'ident').map((x) => x.text) });
    }
  }
  return out;
}

/** NestJS guards/interceptors are classes; link to the method the framework actually runs. */
function resolveGuards(graph: CodeGraph, guards: { name: string; classes: string[] }[]): { name: string; id?: string }[] {
  return guards.map((g) => {
    for (const cls of g.classes) {
      for (const m of ['canActivate', 'intercept', 'transform', 'catch', 'use']) {
        const hit = graph.membersByContainer.get(cls)?.get(m)?.[0];
        if (hit) return { name: `${cls}.${m}`, id: hit.id };
      }
    }
    return { name: g.name };
  });
}

// ---------------- python decorators: FastAPI / Flask ----------------

interface RouterKey {
  file: string;
  name: string;
}
const keyStr = (k: RouterKey) => `${k.file}#${k.name}`;

/** Resolve an expression naming a router/app (`router`, `orders.router`, `api_router`) to the file+var that defines it. */
function routerKeyFor(graph: CodeGraph, file: string, expr: string): RouterKey {
  const imports = graph.importsByFile.get(file);
  const parts = expr.split('.');
  if (parts.length === 1) {
    const imp = imports?.get(expr);
    if (imp?.resolved?.length) {
      if (imp.imported === '*' || imp.imported === 'default') {
        const def = graph.lookupExport(imp.resolved[0], 'default');
        return { file: imp.resolved[0], name: def?.varName ?? def?.sym?.name ?? 'default' };
      }
      const ex = graph.lookupExport(imp.resolved[0], imp.imported);
      return { file: ex?.file ?? imp.resolved[0], name: ex?.varName ?? ex?.sym?.name ?? imp.imported };
    }
    return { file, name: expr };
  }
  const head = parts.slice(0, -1).join('.');
  const tail = parts[parts.length - 1];
  const imp = imports?.get(head) ?? imports?.get(parts[0]);
  if (imp?.resolved?.length) return { file: imp.resolved[0], name: tail };
  return { file, name: expr };
}

function pythonDecoratorRoutes(graph: CodeGraph, out: EntryCollector) {
  // router var -> own prefix ; mounts: child router -> (parent, prefix)
  const ownPrefix = new Map<string, string>();
  const mounts = new Map<string, { parent: string; prefix: string }[]>();
  const routerVars = new Set<string>();
  for (const [file, f] of graph.facts) {
    if (f.lang !== 'python') continue;
    for (const v of f.vars) {
      if (!v.call || v.scope !== `file:${file}`) continue;
      if (/^(APIRouter|FastAPI|Flask|Blueprint|Starlette|Quart|Sanic)$/.test(v.call.callee)) {
        const key = keyStr({ file, name: v.name });
        routerVars.add(key);
        const pre = v.call.args.find((a) => a.key === 'prefix' || a.key === 'url_prefix');
        const val = pre ? (pre.kind === 'string' ? pre.value : resolveStringExpr(graph, file, pre.text)) : undefined;
        if (val) ownPrefix.set(key, val);
      }
    }
    for (const c of f.calls) {
      if (c.callee !== 'include_router' && c.callee !== 'register_blueprint' && c.callee !== 'mount') continue;
      const child = c.args.find((a) => !a.key && (a.kind === 'ident' || a.kind === 'member'));
      if (!child || !c.receiver) continue;
      const preArg = c.args.find((a) => a.key === 'prefix' || a.key === 'url_prefix');
      const pre = (preArg ? (preArg.kind === 'string' ? preArg.value : resolveStringExpr(graph, file, preArg.text) ?? `{${preArg.text}}`) : undefined) ?? (c.callee === 'mount' ? c.args[0]?.value : undefined) ?? '';
      const childKey = keyStr(routerKeyFor(graph, file, child.text));
      const parentKey = keyStr(routerKeyFor(graph, file, c.receiver));
      const list = mounts.get(childKey) ?? [];
      list.push({ parent: parentKey, prefix: pre });
      mounts.set(childKey, list);
    }
  }
  const fullPrefixes = (key: string, depth = 0): string[] => {
    const own = ownPrefix.get(key) ?? '';
    const ms = mounts.get(key);
    if (!ms?.length || depth > 6) return [own];
    return ms.flatMap((m) => fullPrefixes(m.parent, depth + 1).map((pp) => joinPaths(pp, m.prefix, own)));
  };

  for (const s of graph.symbols.values()) {
    if (s.lang !== 'python') continue;
    for (const a of s.annotations) {
      const m = /^(.*)\.(get|post|put|patch|delete|options|head|route|api_route|websocket)$/.exec(a.name);
      if (!m) continue;
      const recv = m[1];
      const verb = m[2];
      const p = a.args.find((x) => !x.key && x.kind === 'string')?.value ?? a.args.find((x) => x.key === 'path' || x.key === 'rule')?.value;
      if (p === undefined) continue;
      let methods: string[];
      if (verb === 'route' || verb === 'api_route') {
        const ms = a.args.find((x) => x.key === 'methods');
        methods = ms?.items?.map((x) => (x.value ?? x.text).toUpperCase()) ?? ['GET'];
      } else if (verb === 'websocket') methods = ['WS'];
      else methods = [verb.toUpperCase()];
      const key = keyStr(routerKeyFor(graph, s.file, recv));
      const isFlask = graph.facts.get(s.file)?.imports.some((i) => /^flask/.test(i.source)) ?? false;
      for (const pre of fullPrefixes(key)) {
        const full = joinPaths(pre, p);
        for (const method of methods)
          out.add({
            kind: 'http-route',
            label: `${method} ${full}`,
            method,
            path: full,
            group: posix.basename(s.file, '.py'),
            framework: isFlask ? 'Flask' : 'FastAPI',
            handlerId: s.id,
            handlerName: s.name,
            middleware: dependsOf(a),
            file: s.file,
            line: s.range.sl,
            notes: routerVars.has(key) || recv === 'app' ? undefined : ['router mount not found; path may be missing a prefix'],
          });
      }
    }
  }
}

function dependsOf(a: Annotation): { name: string }[] {
  const deps = a.args.find((x) => x.key === 'dependencies');
  return (deps?.items ?? []).map((d) => ({ name: d.text }));
}

// ---------------- Django urls.py ----------------

function djangoRoutes(graph: CodeGraph, out: EntryCollector) {
  const urlFiles = [...graph.facts.values()].filter((f) => f.lang === 'python' && /(^|\/)urls\.py$/.test(f.file));
  if (!urlFiles.length) return;
  const pyModuleFile = (from: string, mod: string) => graph.resolveModule(from, mod, 'python')[0];
  const includes: { from: string; to: string; prefix: string }[] = [];
  for (const f of urlFiles) {
    for (const c of f.calls) {
      if (c.callee !== 'path' && c.callee !== 're_path' && c.callee !== 'url') continue;
      const inc = c.args.find((a) => a.kind === 'call' && a.callee === 'include');
      const route = c.args[0]?.value ?? '';
      if (inc) {
        const modArg = inc.items?.[0];
        const mod = modArg?.kind === 'string' ? modArg.value : undefined;
        const target = mod ? pyModuleFile(f.file, mod) : undefined;
        if (target) includes.push({ from: f.file, to: target, prefix: route });
      }
    }
  }
  const included = new Set(includes.map((i) => i.to));
  const computePrefixes = (file: string, depth = 0): string[] => {
    const parents = includes.filter((i) => i.to === file);
    if (!parents.length || depth > 5) return [''];
    return parents.flatMap((p) => computePrefixes(p.from, depth + 1).map((pp) => pp + p.prefix));
  };
  for (const f of urlFiles) {
    const pres = included.has(f.file) ? computePrefixes(f.file) : [''];
    for (const c of f.calls) {
      if (c.callee !== 'path' && c.callee !== 're_path' && c.callee !== 'url') continue;
      if (c.args.some((a) => a.kind === 'call' && a.callee === 'include')) continue;
      const route = c.args[0]?.value;
      const view = c.args[1];
      if (route === undefined || !view) continue;
      let handlerId: string | undefined;
      let handlerName = view.text;
      // views.order_detail / OrderView.as_view()
      const viewExpr = view.kind === 'call' && view.callee === 'as_view' ? view.text.replace(/\.as_view\(.*$/, '') : view.text;
      const parts = viewExpr.split('.');
      const site: CallSite = { from: `file:${f.file}`, callee: parts[parts.length - 1], receiver: parts.length > 1 ? parts.slice(0, -1).join('.') : undefined, args: [], range: { sl: c.range.sl, sc: 1, el: c.range.sl, ec: 1 } };
      const r = graph.resolveCall(site, f.file, 'python');
      if (r?.targets.length) {
        const t = r.targets[0];
        handlerId = t.id;
        handlerName = t.container ? `${t.container}.${t.name}` : t.name;
        if (t.kind === 'constructor' || t.kind === 'class') {
          handlerName = t.container ?? t.name;
          handlerId = (t.kind === 'class' ? t : graph.symbols.get(t.containerId ?? ''))?.id ?? t.id;
        }
      }
      for (const pre of pres) {
        const full = joinPaths(djangoPath(pre + route));
        out.add({ kind: 'http-route', label: `ANY ${full}`, method: 'ANY', path: full, group: posix.dirname(f.file).split('/').pop() || 'urls', framework: 'Django', handlerId, handlerName, file: f.file, line: c.range.sl });
      }
    }
  }
}

function djangoPath(p: string): string {
  return p
    .replace(/^\^/, '')
    .replace(/\$$/, '')
    .replace(/<(?:\w+:)?(\w+)>/g, ':$1')
    .replace(/\(\?P<(\w+)>[^)]*\)/g, ':$1');
}

// ---------------- call-registered routes (Express, Koa, Fastify, Hono, Gin, Echo, Chi, net/http, Axum, minimal APIs) ----------------

const ROUTE_VERBS = new Map<string, string>([
  ['get', 'GET'],
  ['post', 'POST'],
  ['put', 'PUT'],
  ['patch', 'PATCH'],
  ['delete', 'DELETE'],
  ['del', 'DELETE'],
  ['options', 'OPTIONS'],
  ['head', 'HEAD'],
  ['all', 'ANY'],
  ['any', 'ANY'],
  ['GET', 'GET'],
  ['POST', 'POST'],
  ['PUT', 'PUT'],
  ['PATCH', 'PATCH'],
  ['DELETE', 'DELETE'],
  ['OPTIONS', 'OPTIONS'],
  ['HEAD', 'HEAD'],
  ['Any', 'ANY'],
  ['Get', 'GET'],
  ['Post', 'POST'],
  ['Put', 'PUT'],
  ['Patch', 'PATCH'],
  ['Delete', 'DELETE'],
  ['MapGet', 'GET'],
  ['MapPost', 'POST'],
  ['MapPut', 'PUT'],
  ['MapPatch', 'PATCH'],
  ['MapDelete', 'DELETE'],
  ['HandleFunc', 'ANY'],
  ['Handle', 'ANY'],
  ['HandlerFunc', 'ANY'],
  ['route', 'ROUTE'],
]);

const ROUTER_FACTORIES = /^(express|Router|Hono|Elysia|fastify|Fastify|Koa|KoaRouter|default|New|NewRouter|NewServeMux|Default|Group|Route|createRouter|Javalin|create|Build|polka|restify|createServer|Application|App)$/;
const SERVER_LIBS = /^(express|koa|@koa\/router|koa-router|fastify|hono|elysia|restify|polka|@hapi\/hapi|next-connect|itty-router|h3|github\.com\/gin-gonic\/gin|github\.com\/labstack\/echo|github\.com\/go-chi\/chi|github\.com\/gorilla\/mux|github\.com\/gofiber\/fiber|net\/http|github\.com\/julienschmidt\/httprouter|axum|actix_web|warp|rocket|io\.javalin|spark)/;
const CLIENT_LIBS = /^(axios|ky|got|superagent|node-fetch|cross-fetch|@angular\/common\/http|swr|@tanstack\/react-query|react-query)$/;
const CHAIN_BASE = /^(express\.Router\(|Router\(|express\(|new Hono\(|new Elysia\(|new Router\(|Router::new\(|fastify\()/;

/** Best-effort value of an expression used as a path prefix: string literals, constants, settings fields. */
export function resolveStringExpr(graph: CodeGraph, file: string, expr: string, depth = 0): string | undefined {
  const lit = /^(['"`])(.*)\1$/.exec(expr.trim());
  if (lit) return lit[2];
  if (depth > 4) return undefined;
  const strOf = (v?: string) => {
    if (!v) return undefined;
    const m = /^[rbuf]?(['"`])(.*)\1$/.exec(v.trim());
    return m ? m[2] : undefined;
  };
  const parts = expr.split('.');
  if (parts.length === 1) {
    const mv = graph.varsByScope.get(`file:${file}`)?.get(expr);
    if (mv?.valueText) return strOf(mv.valueText) ?? resolveStringExpr(graph, file, mv.valueText, depth + 1);
    const imp = graph.importsByFile.get(file)?.get(expr);
    for (const r of imp?.resolved ?? []) {
      const v = graph.varsByScope.get(`file:${r}`)?.get(imp!.imported);
      if (v?.valueText) return strOf(v.valueText);
    }
    return undefined;
  }
  const head = parts.slice(0, -1).join('.');
  const tail = parts[parts.length - 1];
  // settings.API_V1_STR -> type of settings -> field default
  let type = graph.inferType(head, undefined, file);
  if (!type) {
    const imp = graph.importsByFile.get(file)?.get(head);
    for (const r of imp?.resolved ?? []) {
      const v = graph.varsByScope.get(`file:${r}`)?.get(imp!.imported === '*' ? head : imp!.imported);
      type = v?.type ?? (v?.call && /^[A-Z]/.test(v.call.callee) ? v.call.callee : undefined);
      if (imp!.imported === '*') {
        const mv = graph.varsByScope.get(`file:${r}`)?.get(tail);
        if (mv?.valueText) return strOf(mv.valueText);
      }
      if (type) break;
    }
  }
  if (!type && /^[A-Z]/.test(head)) type = head;
  const field = type ? graph.fieldsByOwner.get(type)?.get(tail) : undefined;
  return strOf(field?.value);
}

const ROUTER_NAME = /^(app|router|r|api|server|srv|e|mux|g|v\d+|routes|route|apiRouter|.*Router|.*router|.*App|.*Routes|.*routes|.*Group|.*group|engine|handler|web)$/;

function callRoutes(graph: CodeGraph, out: EntryCollector, projectHasServerLib: boolean) {
  // 1. Find router variables and mounts.
  const prefixOf = new Map<string, { parent: string; prefix: string; mw: { name: string; id?: string }[] }[]>();
  const routerKeys = new Set<string>();
  const globalMw = new Map<string, { name: string; id?: string }[]>();

  // `const api = Router().use(a).use(b)`: calls inside the chain belong to the variable that starts on that line.
  const chainOwners = new Map<string, string>();
  const ownerKey = (file: string, c: CallSite, recv: string): string => {
    if (/[()]/.test(recv)) {
      const owner = chainOwners.get(`${file}:${c.range.sl}`);
      if (owner) return owner;
    }
    return keyStr(routerKeyFor(graph, file, recv.replace(/\(.*$/s, '')));
  };
  const addMount = (child: string, parent: string, prefix: string, mw: { name: string; id?: string }[] = []) => {
    const list = prefixOf.get(child) ?? [];
    if (!list.some((x) => x.parent === parent && x.prefix === prefix)) list.push({ parent, prefix, mw });
    prefixOf.set(child, list);
  };

  for (const [file, f] of graph.facts) {
    if (f.lang === 'python' || f.lang === 'java' || f.lang === 'c' || f.lang === 'cpp') continue;
    for (const v of f.vars) {
      if (!v.call) continue;
      const chainedFactory = !!v.call.receiver && /^(use|route|get|post|put|patch|delete|all|basePath)$/.test(v.call.callee) && CHAIN_BASE.test(v.call.receiver);
      const calleeOk = chainedFactory || ROUTER_FACTORIES.test(v.call.callee) || (v.call.callee === 'Router' && v.call.receiver === 'express') || (v.call.callee === 'new' && v.call.receiver === 'Router');
      if (!calleeOk) continue;
      const key = keyStr({ file, name: v.name });
      routerKeys.add(key);
      if (chainedFactory) chainOwners.set(`${file}:${v.line}`, key);
      // r.Group("/v1") / app.route('/api') / new Hono().basePath('/api')
      if (/^(Group|Route|group|route|basePath)$/.test(v.call.callee) && v.call.receiver) {
        const pre = v.call.args.find((a) => a.kind === 'string')?.value;
        if (pre !== undefined) addMount(key, keyStr(routerKeyFor(graph, file, v.call.receiver)), pre);
      }
      // const router = new Router({ prefix: '/x' }) (koa-router)
      const obj = v.call.args.find((a) => a.kind === 'object');
      const pre = obj?.items?.find((i) => i.key === 'prefix')?.value;
      if (pre) addMount(key, '<root>', pre);
    }
  }
  for (const [file, f] of graph.facts) {
    if (f.lang === 'python' || f.lang === 'java' || f.lang === 'c' || f.lang === 'cpp') continue;
    for (const c of f.calls) {
      // app.use('/api', router) / app.route('/api', sub) (Hono) / r.Mount("/x", sub) / Router::new().nest("/api", api)
      if (!/^(use|route|Mount|mount|nest|register|Use)$/.test(c.callee) || !c.receiver) continue;
      const pathArg = c.args[0]?.kind === 'string' ? c.args[0].value : c.args.length > 1 && (c.args[0]?.kind === 'member' || c.args[0]?.kind === 'ident') && c.callee !== 'use' ? resolveStringExpr(graph, file, c.args[0].text) : undefined;
      const parentKey = ownerKey(file, c, c.receiver);
      const rest = pathArg !== undefined ? c.args.slice(1) : c.args;
      // app.use('/api/orders', requireAuth, ordersRouter): middleware listed before a router only guards that mount.
      const mountMw: { name: string; id?: string }[] = [];
      for (const a of rest) {
        let childKey: string | undefined;
        if (a.kind === 'ident' || a.kind === 'member') childKey = keyStr(routerKeyFor(graph, file, a.text));
        else if (a.kind === 'call' && a.callee === 'require' && a.value) {
          const target = graph.resolveModule(file, a.value, f.lang)[0];
          if (target) {
            const def = graph.lookupExport(target, 'default');
            childKey = keyStr({ file: target, name: def?.varName ?? def?.sym?.name ?? 'default' });
          }
        }
        if (!childKey) continue;
        const looksLikeRouter = routerKeys.has(childKey) || /router|routes|api|app|controller/i.test(a.text);
        if (looksLikeRouter) addMount(childKey, parentKey, pathArg ?? '', [...mountMw]);
        else if (c.callee === 'use' || c.callee === 'Use') {
          const site: CallSite = { ...c, callee: a.text.split('.').pop()!.replace(/\(.*$/, ''), receiver: a.kind === 'member' ? a.text.split('.').slice(0, -1).join('.') : undefined, args: [] };
          const r = a.kind === 'ident' || a.kind === 'member' ? graph.resolveCall(site, file, f.lang) : undefined;
          const mw = { name: a.kind === 'call' ? `${a.callee}()` : a.text, id: r?.targets[0]?.id };
          if (pathArg !== undefined) mountMw.push(mw);
          else {
            // router-wide middleware: runs for every route on this router and the routers mounted under it
            const list = globalMw.get(parentKey) ?? [];
            list.push(mw);
            globalMw.set(parentKey, list);
          }
        }
      }
    }
  }

  type Mount = { path: string; mw: { name: string; id?: string }[] };
  const fullPrefixes = (key: string, depth = 0, seen = new Set<string>()): Mount[] => {
    const own = globalMw.get(key) ?? [];
    const ms = prefixOf.get(key);
    if (!ms?.length || depth > 8 || seen.has(key)) return [{ path: '', mw: own }];
    seen.add(key);
    return ms.flatMap((m) =>
      m.parent === '<root>'
        ? [{ path: m.prefix, mw: [...m.mw, ...own] }]
        : fullPrefixes(m.parent, depth + 1, new Set(seen)).map((pp) => ({ path: joinPaths(pp.path, m.prefix), mw: [...pp.mw, ...m.mw, ...own] })),
    );
  };

  // 2. Route registrations.
  for (const [file, f] of graph.facts) {
    if (f.lang === 'python' || f.lang === 'java' || f.lang === 'c' || f.lang === 'cpp') continue;
    const importsServer = f.imports.some((i) => SERVER_LIBS.test(i.source));
    const importsClient = f.imports.some((i) => CLIENT_LIBS.test(i.source));
    for (const c of f.calls) {
      const verb = ROUTE_VERBS.get(c.callee);
      if (!verb || !c.receiver) continue;
      let recv = c.receiver;
      let p: string | undefined;
      let handlers: Arg[];
      let method = verb;
      // router.route('/x').get(h)
      const chained = /^(.*?)\.route\((['"`])(.*?)\2\)$/.exec(recv);
      if (chained) {
        recv = chained[1];
        p = chained[3];
        handlers = c.args;
      } else {
        if (c.args[0]?.kind !== 'string') continue;
        p = c.args[0].value ?? '';
        handlers = c.args.slice(1);
      }
      if (!handlers.length) continue;
      if (verb === 'ROUTE') {
        // Hono/Axum style: .route("/x", get(handler).post(other))
        if (f.lang !== 'rust') continue;
        for (const h of handlers) {
          for (const m of (h.text ?? '').matchAll(/\b(get|post|put|patch|delete|any)\((\w[\w:]*)\)/g)) {
            emit(file, f, c, m[1].toUpperCase(), p, recv, [{ kind: 'ident', text: m[2].split('::').pop()!, line: c.range.sl }]);
          }
        }
        continue;
      }
      if (!p.startsWith('/') && p !== '' && p !== '*' && !/^(GET|POST|PUT|PATCH|DELETE|OPTIONS|HEAD)\s+\//.test(p)) continue;
      const recvKey = ownerKey(file, c, recv.split('.')[0]);
      const knownRouter = routerKeys.has(recvKey) || routerKeys.has(keyStr({ file, name: recv }));
      const nameOk = ROUTER_NAME.test(recv.split('.').pop()!) && !/^(axios|http|https|client|request|fetch|api)$/.test(recv) || (recv === 'http' && /^Handle/.test(c.callee));
      if (!knownRouter && !(nameOk && (importsServer || (projectHasServerLib && !importsClient)))) continue;
      if (importsClient && !knownRouter) continue;
      const m = /^(GET|POST|PUT|PATCH|DELETE|OPTIONS|HEAD)\s+(\/.*)$/.exec(p);
      if (m) {
        method = m[1];
        p = m[2];
      }
      emit(file, f, c, method, p, recv, handlers);
    }
  }

  function emit(file: string, f: FileFacts, c: CallSite, method: string, p: string, recv: string, handlers: Arg[]) {
    const recvKey = ownerKey(file, c, recv.split('.')[0]);
    const localKey = keyStr({ file, name: recv });
    const key = prefixOf.has(localKey) || routerKeys.has(localKey) ? localKey : recvKey;
    const handlerArg = handlers[handlers.length - 1];
    const mwArgs = handlers.slice(0, -1);
    const resolveArg = (a: Arg): { id?: string; name: string } => {
      if (a.kind === 'func') return { id: a.symbolId, name: `inline handler (${posix.basename(file)}:${a.line})` };
      if (a.kind === 'ident' || a.kind === 'member') {
        const parts = a.text.split('.');
        const site: CallSite = { ...c, callee: parts[parts.length - 1], receiver: parts.length > 1 ? parts.slice(0, -1).join('.') : undefined, args: [] };
        const r = graph.resolveCall(site, file, f.lang);
        const t = r?.targets[0];
        return { id: t?.id, name: t ? (t.container ? `${t.container}.${t.name}` : t.name) : a.text };
      }
      if (a.kind === 'call') {
        // asyncHandler(controller.create) / wrap(fn)
        const inner = a.items?.find((x) => x.kind === 'ident' || x.kind === 'member' || x.kind === 'func');
        if (inner) return resolveArg(inner);
        return { name: `${a.callee}()` };
      }
      return { name: a.text };
    };
    const h = resolveArg(handlerArg);
    const framework = detectFramework(f);
    const pres = fullPrefixes(key);
    for (const pre of pres) {
      const full = joinPaths(pre.path, p);
      const mws = [...pre.mw, ...mwArgs.map(resolveArg)];
      out.add({
        kind: 'http-route',
        label: `${method} ${full}`,
        method,
        path: full,
        group: posix.basename(file).replace(/\.[^.]+$/, ''),
        framework,
        handlerId: h.id,
        handlerName: h.name,
        middleware: mws,
        file,
        line: c.range.sl,
        notes: !h.id ? ['handler could not be resolved statically'] : undefined,
      });
    }
  }
}

function detectFramework(f: FileFacts): string {
  const srcs = f.imports.map((i) => i.source);
  const has = (re: RegExp) => srcs.some((s) => re.test(s));
  if (has(/^express$/)) return 'Express';
  if (has(/koa/)) return 'Koa';
  if (has(/^fastify/)) return 'Fastify';
  if (has(/^hono/)) return 'Hono';
  if (has(/gin-gonic/)) return 'Gin';
  if (has(/labstack\/echo/)) return 'Echo';
  if (has(/go-chi/)) return 'Chi';
  if (has(/gorilla\/mux/)) return 'Gorilla mux';
  if (has(/gofiber/)) return 'Fiber';
  if (has(/^net\/http$/)) return 'net/http';
  if (has(/^axum/)) return 'Axum';
  if (f.lang === 'csharp') return 'ASP.NET minimal API';
  if (f.lang === 'javascript' || f.lang === 'typescript' || f.lang === 'tsx') return 'Express-style';
  return 'router';
}

// ---------------- Next.js file-system routes ----------------

function nextRoutes(graph: CodeGraph, out: EntryCollector, hasNext: boolean) {
  for (const [file, f] of graph.facts) {
    if (!(f.lang === 'typescript' || f.lang === 'tsx' || f.lang === 'javascript')) continue;
    const appM = /^(?:(.*)\/)?(?:src\/)?app\/(.*?)(?:\/)?(route|page)\.(t|j)sx?$/.exec(file);
    const pagesM = /^(?:(.*)\/)?(?:src\/)?pages\/(.*)\.(t|j)sx?$/.exec(file);
    if (!hasNext) return;
    if (appM) {
      const segs = appM[2] ? appM[2].split('/') : [];
      const urlPath = joinPaths(
        ...segs
          .filter((s) => !/^\(.*\)$/.test(s) && !s.startsWith('@') && !s.startsWith('_'))
          .map((s) => s.replace(/^\[\[\.\.\.(\w+)\]\]$/, '*$1').replace(/^\[\.\.\.(\w+)\]$/, '*$1').replace(/^\[(\w+)\]$/, ':$1')),
      );
      if (appM[3] === 'route') {
        for (const s of f.symbols) {
          if (s.container || !HTTP_METHODS.includes(s.name)) continue;
          out.add({ kind: 'http-route', label: `${s.name} ${urlPath}`, method: s.name, path: urlPath, group: segs.filter((x) => !/^\(.*\)$/.test(x))[0] ?? '/', framework: 'Next.js route handler', handlerId: s.id, handlerName: s.name, file, line: s.range.sl });
        }
      } else {
        const def = f.symbols.find((s) => s.isDefaultExport) ?? graph.lookupExport(file, 'default')?.sym;
        out.add({ kind: 'page', label: urlPath, path: urlPath, group: 'Pages', framework: 'Next.js app router', handlerId: def?.id ?? `file:${file}`, handlerName: def?.name ?? posix.basename(file), file, line: def?.range.sl ?? 1 });
      }
      continue;
    }
    if (pagesM && !/(^|\/)_(app|document|error)\.|\/components\//.test(file) && graph.facts.has(file)) {
      const rel = pagesM[2].replace(/(^|\/)index$/, '');
      const urlPath = joinPaths(...rel.split('/').map((s) => s.replace(/^\[\[\.\.\.(\w+)\]\]$/, '*$1').replace(/^\[\.\.\.(\w+)\]$/, '*$1').replace(/^\[(\w+)\]$/, ':$1')));
      const def = f.symbols.find((s) => s.isDefaultExport) ?? graph.lookupExport(file, 'default')?.sym;
      if (rel.startsWith('api/') || rel === 'api') {
        out.add({ kind: 'http-route', label: `ANY ${urlPath}`, method: 'ANY', path: urlPath, group: 'api', framework: 'Next.js API route', handlerId: def?.id ?? `file:${file}`, handlerName: def?.name ?? 'handler', file, line: def?.range.sl ?? 1 });
      } else if (def) {
        out.add({ kind: 'page', label: urlPath, path: urlPath, group: 'Pages', framework: 'Next.js pages router', handlerId: def.id, handlerName: def.name, file, line: def.range.sl });
      }
    }
  }
}

// ---------------- React Router <Route> ----------------

function reactRouterRoutes(graph: CodeGraph, out: EntryCollector) {
  for (const [file, f] of graph.facts) {
    for (const r of f.jsxRoutes) {
      let handlerId: string | undefined;
      if (r.component) {
        const site: CallSite = { from: r.scope, callee: r.component, args: [], range: { sl: r.line, sc: 1, el: r.line, ec: 1 } };
        handlerId = graph.resolveCall(site, file, f.lang)?.targets[0]?.id;
      }
      const p = r.path.startsWith('/') ? r.path : '/' + r.path;
      out.add({ kind: 'page', label: p, path: p, group: 'Pages', framework: 'React Router', handlerId, handlerName: r.component, file, line: r.line });
    }
  }
}

// ---------------- processes / jobs / channels ----------------

function processEntries(graph: CodeGraph, out: EntryCollector, pkgJsons: { file: string; json: any }[]) {
  for (const s of graph.symbols.values()) {
    const isMain =
      (s.name === 'main' && s.kind === 'function' && (s.lang === 'c' || s.lang === 'cpp' || s.lang === 'go' || s.lang === 'rust' || s.lang === 'python')) ||
      (s.name === 'main' && s.kind === 'method' && s.lang === 'java' && /\bstatic\b/.test(s.signature)) ||
      (s.name === 'Main' && s.lang === 'csharp' && /\bstatic\b/.test(s.signature));
    if (!isMain) continue;
    if (s.lang === 'python' && !graph.facts.get(s.file)?.hasMainGuard) continue;
    if (/(^|\/)(tests?|examples?|benchmarks?|bench)\//i.test(s.file) && graph.symbols.size > 50) continue;
    const dir = posix.dirname(s.file);
    const base = posix.basename(s.file).replace(/\.\w+$/, '');
    // main.cpp / main.go / Program.cs are named after their folder (feed/main.cpp -> "feed").
    const generic = /^(main|index|app|program|server|cmd)$/i.test(base);
    const name = (s.lang === 'go' || s.lang === 'rust' || generic) && dir !== '.' ? dir.split('/').filter((d) => d !== 'src' && d !== 'cmd').pop() ?? base : base;
    out.add({ kind: 'process', label: `${name}`, group: 'Processes', framework: s.lang, handlerId: s.id, handlerName: s.container ? `${s.container}.${s.name}` : s.name, file: s.file, line: s.range.sl, notes: [`${s.file}`] });
  }
  for (const [file, f] of graph.facts) {
    if (f.lang === 'python' && f.hasMainGuard && !f.symbols.some((s) => s.name === 'main' && !s.container)) {
      out.add({ kind: 'process', label: posix.basename(file, '.py'), group: 'Processes', framework: 'python', handlerId: `file:${file}`, handlerName: `${posix.basename(file)} (top level)`, file, line: 1 });
    }
    if (f.lang === 'csharp' && /(^|\/)Program\.cs$/.test(file) && !f.symbols.some((s) => s.name === 'Main')) {
      out.add({ kind: 'process', label: posix.dirname(file).split('/').pop() || 'Program', group: 'Processes', framework: '.NET', handlerId: `file:${file}`, handlerName: 'Program.cs (top-level statements)', file, line: 1 });
    }
  }
  // Node entry files from package.json
  for (const { file, json } of pkgJsons) {
    const base = posix.dirname(file) === '.' ? '' : posix.dirname(file);
    const cands = new Set<string>();
    if (typeof json.main === 'string') cands.add(json.main);
    if (typeof json.bin === 'string') cands.add(json.bin);
    else if (json.bin && typeof json.bin === 'object') Object.values(json.bin).forEach((b) => typeof b === 'string' && cands.add(b));
    for (const script of [json.scripts?.start, json.scripts?.dev, json.scripts?.serve]) {
      const m = typeof script === 'string' ? /(?:node|nodemon|ts-node|tsx|bun|ts-node-dev)\s+(?:--?\S+\s+)*([\w./-]+\.(?:js|ts|mjs|cjs))/.exec(script) : null;
      if (m) cands.add(m[1]);
    }
    for (const c of ['server.js', 'server.ts', 'app.js', 'app.ts', 'index.js', 'index.ts', 'src/server.ts', 'src/server.js', 'src/index.ts', 'src/index.js', 'src/main.ts', 'src/app.ts', 'src/app.js', 'bin/www']) cands.add(c);
    let added = 0;
    for (const c of cands) {
      const rel = posix.normalize(posix.join(base, c.replace(/^\.\//, '')));
      const variants = [rel, rel.replace(/^dist\//, 'src/').replace(/\.js$/, '.ts'), rel.replace(/\.js$/, '.ts')];
      const hit = variants.find((v) => graph.facts.has(v));
      if (!hit) continue;
      const f = graph.facts.get(hit)!;
      // only count files that actually do something at top level (start a server, call main...)
      if (!f.calls.some((cl) => cl.from === `file:${hit}` && /^(listen|bootstrap|main|start|run|createServer|serve)$/.test(cl.callee))) continue;
      if (out.entries.some((e) => e.handlerId === `file:${hit}`)) continue;
      out.add({ kind: 'process', label: json.name ? `${json.name} (${posix.basename(hit)})` : posix.basename(hit), group: 'Processes', framework: 'node', handlerId: `file:${hit}`, handlerName: `${posix.basename(hit)} (top level)`, file: hit, line: 1 });
      if (++added >= 2) break;
    }
  }
}

function jobEntries(graph: CodeGraph, out: EntryCollector) {
  for (const s of graph.symbols.values()) {
    for (const a of s.annotations) {
      const n = a.name.split('.').pop()!;
      if (!/^(Scheduled|Cron|Interval|Timeout|shared_task|task|periodic_task|scheduled_job|job|BackgroundService|Process|Processor|EventListener|TransactionalEventListener|KafkaListener|RabbitListener|JmsListener|SqsListener|EventPattern|MessagePattern|OnEvent)$/.test(n)) continue;
      if (n === 'task' && !/celery|app|huey|dramatiq/.test(a.name)) continue;
      const detail = a.args.map((x) => (x.key ? `${x.key}=${x.value ?? x.text}` : x.value ?? x.text)).join(', ');
      out.add({ kind: 'job', label: `${s.container ? s.container + '.' : ''}${s.name}`, group: /Listener|Pattern|OnEvent/.test(n) ? 'Event listeners' : 'Scheduled & background jobs', framework: `@${n}`, handlerId: s.id, handlerName: s.name, file: s.file, line: s.range.sl, notes: detail ? [`@${n}(${detail})`] : undefined });
    }
  }
}

function channelEntries(sinks: SinkIndex, out: EntryCollector) {
  for (const n of sinks.nodes.values()) {
    if (n.kind !== 'channel') continue;
    out.add({ id: `channel:${n.id}`, kind: 'channel', label: n.label, group: n.detail ?? 'Channels', framework: n.detail ?? 'channel', handlerId: n.id, file: '', line: 0 });
  }
}

export function extractEntries(graph: CodeGraph, sinks: SinkIndex, ctx: { pkgJsons: { file: string; json: any }[]; projectHasServerLib: boolean; hasNext: boolean }): EntryPoint[] {
  const out = new EntryCollector();
  annotationControllers(graph, out);
  pythonDecoratorRoutes(graph, out);
  djangoRoutes(graph, out);
  callRoutes(graph, out, ctx.projectHasServerLib);
  nextRoutes(graph, out, ctx.hasNext);
  reactRouterRoutes(graph, out);
  jobEntries(graph, out);
  processEntries(graph, out, ctx.pkgJsons);
  channelEntries(sinks, out);
  return out.entries;
}
