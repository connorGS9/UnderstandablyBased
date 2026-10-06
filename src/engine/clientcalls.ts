import type { Arg, CallSite, Confidence, EntryPoint, Lang, VarFact } from './types';
import type { CodeGraph } from './graph';
import { resolveStringExpr } from './routes';

/**
 * HTTP calls made *by* code (browser frontends, or one service calling another), and the logic
 * that matches them to HTTP routes defined in the same project, so a flow can cross the network:
 *   UserList → fetchUsers → GET /api/users → UsersController.list → users table
 */

export interface HttpCall {
  /** HTTP method if known (fetch defaults to GET). */
  method?: string;
  /** Path with dynamic parts as `{}` (e.g. `/api/users/{}`); undefined if the URL could not be read. */
  path?: string;
  /** The URL starts with something we could not resolve (e.g. `${API_BASE}/users`): match by suffix. */
  unknownPrefix?: boolean;
  /** Host for absolute URLs. Internal hosts (localhost, docker service names) still get matched. */
  host?: string;
  external?: boolean;
  /** Client library, for the UI ("axios", "fetch", "HttpClient"...). */
  lib: string;
  /** URL as written, for display. */
  raw: string;
}

const FETCH_FNS = /^(fetch|\$fetch|ofetch|useFetch|useLazyFetch|ky|got|superagent|axios|useSWR|useSWRImmutable|useSWRInfinite|wretch|xhr)$/;
const CONFIG_FNS = /^(axios|request|ajax|__request|apiRequest|httpRequest|fetch|http|call|send|makeRequest)$/;
const VERBS = /^(get|post|put|patch|delete|del|head|options|request|GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS|getJSON|Get|Post|Put|Delete|Patch|PostForm|GetAsync|PostAsync|PutAsync|DeleteAsync|PatchAsync|SendAsync|GetFromJsonAsync|PostAsJsonAsync|PutAsJsonAsync|getForObject|getForEntity|postForObject|postForEntity|exchange|uri)$/;
/** Receivers that are HTTP clients by name: axios, this.http (Angular), this.$http (Vue), $ (jQuery), api/client instances... */
const CLIENT_RECV = /^(axios|ky|got|superagent|request|requests|httpx|aiohttp|session|\$|jQuery|\$http|this\.\$http|http|https|this\.http|httpClient|this\.httpClient|_http|this\._http|_httpClient|HttpClient|client|this\.client|_client|apiClient|this\.apiClient|api|this\.api|\$api|instance|axiosInstance|httpService|this\.httpService|restTemplate|this\.restTemplate|webClient|this\.webClient|reqwest|fetcher|ofetch|\$fetch)$/;
/** Factories whose result is an HTTP client, with the option that sets its base URL. */
const CLIENT_FACTORIES: [RegExp, RegExp, string][] = [
  [/^create$/, /^(axios)$/, 'baseURL'],
  [/^(create|extend)$/, /^(ky)$/, 'prefixUrl'],
  [/^create$/, /^(\$fetch|ofetch)$/, 'baseURL'],
  [/^createClient$/, /^$/, 'baseUrl'], // openapi-fetch
  [/^wretch$/, /^$/, ''],
];
const INTERNAL_HOST = /^(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]|[a-z][\w-]*)(:\d+)?$/i; // single-label hosts are docker/k8s service names

const isJs = (l: Lang) => l === 'javascript' || l === 'typescript' || l === 'tsx';

/** Find a variable by name: in the current function, the file, or imported from another file. */
function findVar(graph: CodeGraph, file: string, scope: string, name: string): { v: VarFact; file: string } | undefined {
  const local = graph.varsByScope.get(scope)?.get(name) ?? graph.varsByScope.get(`file:${file}`)?.get(name);
  if (local) return { v: local, file };
  const imp = graph.importsByFile.get(file)?.get(name);
  for (const r of imp?.resolved ?? []) {
    const exportedName = imp!.imported === '*' || imp!.imported === 'default' ? graph.lookupExport(r, 'default')?.varName : graph.lookupExport(r, imp!.imported)?.varName ?? imp!.imported;
    const v = exportedName ? graph.varsByScope.get(`file:${r}`)?.get(exportedName) : undefined;
    if (v) return { v, file: r };
  }
  return undefined;
}

/** Read a URL expression: string/template literals, `BASE + '/x/' + id`, or a constant. `${expr}` parts become `{}`. */
function readUrl(graph: CodeGraph, file: string, scope: string, a: Arg | undefined): { url: string; unknownPrefix: boolean } | undefined {
  if (!a) return undefined;
  let pieces: { lit?: string; expr?: string }[] = [];
  if (a.kind === 'string' && a.value !== undefined) {
    const v = a.value;
    let last = 0;
    for (const m of v.matchAll(/\$\{([^}]*)\}|\{\{([^}]*)\}\}/g)) {
      if (m.index! > last) pieces.push({ lit: v.slice(last, m.index) });
      pieces.push({ expr: (m[1] ?? m[2]).trim() });
      last = m.index! + m[0].length;
    }
    if (last < v.length) pieces.push({ lit: v.slice(last) });
  } else if (a.kind === 'other' && a.text.includes('+')) {
    pieces = splitConcat(a.text).map((p) => {
      const lit = /^(['"`])([\s\S]*)\1$/.exec(p.trim());
      return lit ? { lit: lit[2] } : { expr: p.trim() };
    });
  } else if (a.kind === 'ident' || a.kind === 'member') {
    const s = constString(graph, file, scope, a.text);
    if (s === undefined) return undefined;
    pieces = [{ lit: s }];
  } else return undefined;

  let url = '';
  let unknownPrefix = false;
  pieces.forEach((p, i) => {
    if (p.lit !== undefined) url += p.lit;
    else if (i === 0) {
      // Leading expression is usually a base URL constant: try to resolve it.
      const s = constString(graph, file, scope, p.expr!);
      if (s !== undefined) url += s;
      else unknownPrefix = true;
    } else url += '{}';
  });
  return { url, unknownPrefix };
}

function constString(graph: CodeGraph, file: string, scope: string, expr: string): string | undefined {
  if (/^[\w$.]+$/.test(expr)) {
    const r = resolveStringExpr(graph, file, expr);
    if (r !== undefined) return r;
    // Local constant inside the function, or an env/config object: `environment.apiUrl`.
    const [head, ...rest] = expr.split('.');
    const fv = findVar(graph, file, scope, head);
    const vt = fv?.v.valueText;
    if (vt) {
      if (!rest.length) {
        const m = /^(['"`])([^'"`$]*)\1$/.exec(vt.trim());
        if (m) return m[2];
      } else {
        const m = new RegExp(`\\b${rest[rest.length - 1]}\\s*:\\s*(['"\`])([^'"\`$]*)\\1`).exec(vt);
        if (m) return m[2];
      }
    }
  }
  return undefined;
}

function splitConcat(s: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let cur = '';
  for (const ch of s) {
    if (quote) {
      cur += ch;
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') quote = ch;
    if (ch === '(' || ch === '[' || ch === '{') depth++;
    if (ch === ')' || ch === ']' || ch === '}') depth--;
    if (ch === '+' && depth === 0) {
      out.push(cur);
      cur = '';
    } else cur += ch;
  }
  out.push(cur);
  return out;
}

const objItem = (a: Arg | undefined, ...keys: string[]) => a?.kind === 'object' ? a.items?.find((i) => i.key && keys.includes(i.key)) : undefined;

/** Turn a raw URL into a route-comparable path, noting the host of absolute URLs. */
function finish(raw: { url: string; unknownPrefix: boolean } | undefined, method: string | undefined, lib: string, base?: string): HttpCall {
  if (!raw) return { method, lib, raw: '' };
  let url = raw.url.trim();
  let unknownPrefix = raw.unknownPrefix;
  let host: string | undefined;
  const abs = /^(?:https?:|wss?:)?\/\/([^/?#]*)(.*)$/i.exec(url);
  if (abs) {
    host = abs[1];
    url = abs[2] || '/';
  } else if (base !== undefined && !url.startsWith('/')) {
    url = `${base.replace(/\/$/, '')}/${url}`;
  } else if (base !== undefined) {
    url = base.replace(/\/$/, '') + url;
  } else if (!url.startsWith('/') && !url.startsWith('{}')) {
    unknownPrefix = true; // relative to an unknown base
  }
  // The base itself may be absolute (axios.create({ baseURL: 'http://localhost:3000/api' })).
  const abs2 = /^(?:https?:)?\/\/([^/?#]*)(.*)$/i.exec(url);
  if (abs2) {
    host = abs2[1];
    url = abs2[2] || '/';
  }
  url = url.replace(/[?#].*$/, '');
  const external = !!host && !host.includes('{}') && !INTERNAL_HOST.test(host);
  if (host?.includes('{}')) unknownPrefix = true;
  return { method, path: url.startsWith('/') || unknownPrefix ? url : '/' + url, unknownPrefix, host, external, lib, raw: raw.url };
}

/** If this call is an HTTP request, describe it. */
export function detectHttpCall(graph: CodeGraph, file: string, lang: Lang, site: CallSite): HttpCall | undefined {
  const recv = (site.receiver ?? '').replace(/->/g, '.').replace(/\?\./g, '.').replace(/\(\)$/, '');
  const callee = site.callee;
  const scope = site.from;
  const args = site.args;

  // 1. Config-object calls: axios({ url, method }), $.ajax({ url, type }), __request(OpenAPI, { method, url }) (generated clients)
  for (const a of args) {
    const urlItem = objItem(a, 'url');
    if (!urlItem) continue;
    const m = objItem(a, 'method', 'type');
    if (m || CONFIG_FNS.test(callee)) {
      return finish(readUrl(graph, file, scope, urlItem), (m?.value ?? m?.text.replace(/['"]/g, ''))?.toUpperCase(), callee === '__request' ? 'generated client' : recv || callee);
    }
  }

  // 2. Function-style clients: fetch(url, { method }), $fetch(url), useSWR(url), ky(url)
  if (!recv && FETCH_FNS.test(callee) && isJs(lang)) {
    const opts = args.find((a, i) => i > 0 && a.kind === 'object');
    const m = objItem(opts, 'method');
    const method = (m?.value ?? m?.text.replace(/['"]/g, ''))?.toUpperCase() ?? (/^useSWR/.test(callee) || callee === 'fetch' || callee === '$fetch' || callee === 'ofetch' || callee === 'useFetch' ? 'GET' : undefined);
    const raw = readUrl(graph, file, scope, args[0]);
    if (!raw && callee !== 'fetch') return undefined;
    return finish(raw, method, callee);
  }

  // 3. Method-style clients: axios.get(url), this.http.post(url) (Angular), api.get(url) (axios instance), client.GET(path) (openapi-fetch)
  if (recv && VERBS.test(callee)) {
    const head = recv.split('.')[0];
    let isClient = CLIENT_RECV.test(recv) || /http|rest|webclient/i.test(recv.split('.').pop() ?? '');
    let base: string | undefined;
    // Instances: const api = axios.create({ baseURL: '/api' })
    const varName = head === 'this' ? undefined : head;
    const fv = varName ? findVar(graph, file, scope, varName) : undefined;
    const call = fv?.v.call;
    if (call) {
      for (const [calleeRe, recvRe, opt] of CLIENT_FACTORIES) {
        if (calleeRe.test(call.callee) && recvRe.test(call.receiver ?? '')) {
          isClient = true;
          const cfg = call.args.find((a) => a.kind === 'object');
          const b = opt ? objItem(cfg, opt) : call.args[0];
          const r = b ? readUrl(graph, fv!.file, fv!.v.scope, b) : undefined;
          if (r && !r.unknownPrefix) base = r.url;
          break;
        }
      }
    }
    // Angular: constructor(private http: HttpClient)
    if (!isClient) {
      const t = graph.inferType(recv, graph.symbols.get(scope), file);
      if (t && /^(HttpClient|HttpService|AxiosInstance|RestTemplate|WebClient|HttpClientModule)$/.test(t)) isClient = true;
    }
    if (!isClient) return undefined;
    let method = callee.toUpperCase().replace(/ASYNC$|FORJSONASYNC$|ASJSONASYNC$/, '').replace(/^DEL$/, 'DELETE').replace(/^GETJSON$/, 'GET').replace(/FOROBJECT$|FORENTITY$/, '');
    if (!/^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)$/.test(method)) method = '';
    const urlArg = callee === 'request' || callee === 'exchange' ? args.find((a) => a.kind === 'string') : args[0];
    if (callee === 'request' && objItem(args[0], 'url')) return undefined; // handled as config object above
    return finish(readUrl(graph, file, scope, urlArg), method || undefined, recv, base);
  }

  // 4. Go net/http and libcurl
  if (recv === 'http' && /^(Get|Post|Head|PostForm|NewRequest|NewRequestWithContext)$/.test(callee)) {
    const urlArg = callee.startsWith('NewRequest') ? args.find((a, i) => i >= 1 && a.kind === 'string') : args[0];
    const m = callee.startsWith('NewRequest') ? args.find((a) => a.kind === 'string' && /^(GET|POST|PUT|PATCH|DELETE)$/.test(a.value ?? ''))?.value : callee.toUpperCase().replace('POSTFORM', 'POST');
    return finish(readUrl(graph, file, scope, urlArg), m, 'net/http');
  }
  if (callee === 'curl_easy_setopt' && args[1]?.text === 'CURLOPT_URL') return finish(readUrl(graph, file, scope, args[2]), undefined, 'libcurl');
  return undefined;
}

// ---------------- matching calls to routes ----------------

type Seg = string; // literal (lowercase), '{}' for a parameter, '**' for catch-all

function segsOf(path: string, isRoute: boolean): Seg[] {
  return path
    .split('/')
    .filter(Boolean)
    .map((s) => {
      if (isRoute) {
        if (/^(\*|\*\*|\.\.\.|\[\.\.\.|\[\[\.\.\.|\{\*|\{\.\.\.)/.test(s) || /^\*\w*$/.test(s)) return '**';
        if (/^:|^\{.*\}$|^<.*>$|^\[.*\]$|^\$/.test(s) || /\{[^}]*\}/.test(s)) return '{}';
      } else if (s.includes('{}')) return '{}';
      return s.toLowerCase();
    });
}

interface Candidate {
  entry: EntryPoint;
  score: number;
  exact: boolean;
}

function compare(c: Seg[], r: Seg[], offsetC: number, offsetR: number, len: number): { penalty: number; literals: number } | null {
  let penalty = 0;
  let literals = 0;
  for (let i = 0; i < len; i++) {
    const cs = c[offsetC + i];
    const rs = r[offsetR + i];
    if (rs === '**') return { penalty: penalty + 2, literals };
    if (cs === '{}' && rs === '{}') continue;
    if (rs === '{}') {
      penalty += 1; // a literal value in a parameter slot: /users/me vs /users/:id
      continue;
    }
    if (cs === '{}') {
      penalty += 4; // a variable where the route has a fixed word: possible but less likely
      continue;
    }
    if (cs !== rs) return null;
    literals++;
  }
  return { penalty, literals };
}

/** Best-matching routes for one call (empty when nothing matches convincingly). */
export function matchRoutes(call: HttpCall, routes: { entry: EntryPoint; segs: Seg[] }[]): { entries: EntryPoint[]; confidence: Confidence; reason: string } | undefined {
  if (!call.path || call.external) return undefined;
  const c = segsOf(call.path, false);
  if (!c.length) return undefined;
  const cands: Candidate[] = [];
  for (const { entry, segs: r } of routes) {
    if (call.method && entry.method && entry.method !== 'ANY' && entry.method !== call.method) continue;
    const methodPenalty = call.method ? 0 : 2;
    const catchAll = r[r.length - 1] === '**';
    // a) whole path lines up
    if (c.length === r.length || (catchAll && c.length >= r.length - 1)) {
      const res = compare(c, r, 0, 0, Math.min(c.length, r.length));
      if (res && res.literals >= 1) cands.push({ entry, score: 100 - res.penalty - methodPenalty - (call.unknownPrefix ? 6 : 0), exact: !call.unknownPrefix && res.penalty === 0 && !catchAll });
    }
    // b) the call omits a prefix the route has: axios baseURL we could not read, or `${API}/users`
    if (r.length > c.length && !catchAll) {
      const res = compare(c, r, 0, r.length - c.length, c.length);
      if (res && res.literals >= 1 && (res.literals >= 2 || c.length >= 2)) cands.push({ entry, score: 100 - res.penalty - methodPenalty - (call.unknownPrefix ? 8 : 18), exact: false });
    }
    // c) the call has a prefix the route lacks: a dev proxy that strips /api
    if (c.length > r.length && !call.unknownPrefix) {
      const stripped = c.slice(0, c.length - r.length);
      if (stripped.every((s) => /^(api|v\d+|backend|server|svc|service|rest)$/.test(s))) {
        const res = compare(c, r, c.length - r.length, 0, r.length);
        if (res && res.literals >= 1) cands.push({ entry, score: 100 - res.penalty - methodPenalty - 15, exact: false });
      }
    }
  }
  if (!cands.length) return undefined;
  const best = Math.max(...cands.map((x) => x.score));
  if (best < 70) return undefined;
  const top = cands.filter((x) => x.score === best);
  const entries = [...new Map(top.map((x) => [x.entry.id, x.entry])).values()];
  if (entries.length > 3) return undefined; // too ambiguous to be useful
  const exact = top.some((x) => x.exact) && entries.length === 1;
  const confidence: Confidence = exact ? 'certain' : best >= 85 && entries.length === 1 ? 'likely' : 'guess';
  const how = exact ? 'URL and method match the route' : call.unknownPrefix ? 'URL ends like the route (base URL not known statically)' : 'URL matches the route with a different prefix or parameter';
  return { entries, confidence, reason: `${call.method ?? 'HTTP'} ${call.raw || call.path} — ${how}` };
}

export function routeTable(entries: EntryPoint[]) {
  return entries.filter((e) => e.kind === 'http-route' && e.path).map((entry) => ({ entry, segs: segsOf(entry.path!, true) }));
}
