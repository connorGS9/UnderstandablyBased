import type { Backbone, EntryFamily, EntryKind, EntryPoint, EntryTrait } from './types';
import type { Project } from './project';

/**
 * Which entry points matter most, judged from the code alone (no git history, logs or traffic needed),
 * so it works the same for a web app, a Rust service or a decompiled game:
 *  - families: entry points that do little themselves and hand off to the same shared code (e.g. 150 "tool"
 *    routes that all call runTool) are grouped, and each member gets a one-line gist of what sets it apart;
 *  - key entry points: the ones that reach the most code and data, are used from many places, or do something
 *    distinctive (call an AI model, stream responses, handle authentication);
 *  - backbone: code that most entry points pass through (auth middleware, a request wrapper, the DB layer).
 */

const AI_HOSTS = /(^|\.)(openai\.com|openai\.azure\.com|anthropic\.com|generativelanguage\.googleapis\.com|aiplatform\.googleapis\.com|mistral\.ai|cohere\.(ai|com)|groq\.com|openrouter\.ai|together\.xyz|deepseek\.com|x\.ai|perplexity\.ai|huggingface\.co|replicate\.com|fireworks\.ai)$|bedrock-runtime|^localhost:11434$/i;
const AI_PKGS = /^(openai|anthropic|@anthropic-ai\/[\w-]+|ai|@ai-sdk\/[\w-]+|langchain[\w.-]*|@langchain\/[\w-]+|llama_index[\w.]*|llamaindex|ollama|groq|groq-sdk|mistralai|@mistralai\/[\w-]+|cohere|cohere-ai|google\.generativeai|google\.genai|@google\/generative-ai|@google\/genai|litellm|vllm|async_openai|async-openai|semantic_kernel|Microsoft\.SemanticKernel|Azure\.AI\.OpenAI|OpenAI|Anthropic|org\.springframework\.ai[\w.]*|dev\.langchain4j[\w.]*|rig|genkit|@genkit-ai\/[\w-]+)$/i;
/** Names specific enough to mean "calls a language model" anywhere. */
const AI_CALLS = /^(streamText|generateText|streamObject|generateObject|streamUI|createChatCompletion|chatCompletion|chat_completion|generateContent|generateContentStream|generate_content|acompletion)$/;
/** Generic method names that mean "calls a model" inside a file that imports an AI SDK. */
const AI_CALLS_LOOSE = /^(create|acreate|stream|astream|invoke|ainvoke|generate|agenerate|chat|complete|completion|predict|embed|embed_documents|embed_query|run|arun|batch|call)$/;
const STREAM_CALLS = /^(StreamingResponse|EventSourceResponse|streamSSE|streamText|toDataStreamResponse|toTextStreamResponse|toUIMessageStreamResponse|pipeDataStreamToResponse|createDataStreamResponse|createUIMessageStream|SseEmitter|ServerSentEvent|Sse|stream_with_context|StreamingHttpResponse|text_event_stream|flushHeaders)$/;
const AUTH_SEG = /^(login|logout|signin|sign-in|sign_in|signout|sign-out|signup|sign-up|sign_up|register|auth|oauth|oauth2|token|tokens|refresh|session|sessions|sso|saml|callback|password|reset-password|forgot-password|2fa|mfa|otp|me|whoami|jwt|authorize|access-token)$/i;
const AUTH_NAME = /(log_?in|log_?out|sign_?in|sign_?up|register_?user|authenticat|authoriz|oauth|refresh_?token|access_?token|create_?session)/i;
const AUTH_STEP = /((hash|verify|check)_?password|password_?(hash|verify)|bcrypt|argon2|create_(access|refresh)_token|(sign|issue|generate|create)_?(jwt|token)s?$|jwt_?(encode|sign))/i;

/** Calls that wrap real work rather than doing it: guards, checks, logging, response helpers. */
const HELPER_NAME = /^(assert|check|ensure|validate|verify|guard|require|log|debug|info|warn|error|trace|track|emit|send|respond|json|ok|fail|toResponse|toResponseError|handleError|wrap)/i;
const NOUN: Record<EntryKind, string> = { 'http-route': 'route', page: 'page', process: 'process', job: 'job', channel: 'channel', custom: 'entry point' };
const BACKBONE_ROLES = new Set(['middleware', 'service', 'repository', 'client']);

export function computeInsights(p: Project): { families: EntryFamily[]; backbone: Backbone[] } {
  const g = p.graph;
  const entries = p.entries.filter((e) => e.handlerId && e.kind !== 'channel');
  const byKind = new Map<EntryKind, EntryPoint[]>();
  for (const e of entries) byKind.set(e.kind, [...(byKind.get(e.kind) ?? []), e]);
  const kindOf = new Map(p.entries.map((e) => [e.id, e.kind]));

  // What each entry point reaches, and how many entry points of each kind reach each piece of code.
  const reachOfEntry = new Map<string, Set<string>>();
  const df = new Map<string, Map<EntryKind, number>>();
  const ids = [...g.symbols.keys(), ...p.sinks.nodes.keys(), ...p.entries.map((e) => e.id)];
  for (const id of ids) {
    const r = p.reachOf(id);
    if (!r) continue;
    const counts = new Map<EntryKind, number>();
    for (const eid of r) {
      if (eid === id) continue;
      let s = reachOfEntry.get(eid);
      if (!s) reachOfEntry.set(eid, (s = new Set()));
      s.add(id);
      const k = kindOf.get(eid);
      if (k) counts.set(k, (counts.get(k) ?? 0) + 1);
    }
    df.set(id, counts);
  }
  const dfOf = (id: string, k: EntryKind) => df.get(id)?.get(k) ?? 0;

  // Traits of individual functions: calls an AI model, streams a response.
  const ai = new Map<string, string>();
  const streams = new Set<string>();
  for (const [file, f] of g.facts) {
    const aiImport = f.imports.find((i) => AI_PKGS.test(i.source) || AI_PKGS.test(i.source.split('::')[0]) || AI_PKGS.test(i.source.split('/')[0]) || AI_PKGS.test(i.source.split('.')[0]));
    for (const c of f.calls) {
      if (AI_CALLS.test(c.callee) || (aiImport && AI_CALLS_LOOSE.test(c.callee) && c.receiver) || /(^|\.)chat\.completions$|(^|\.)responses$/.test(c.receiver ?? '') && /^(create|stream|parse)$/.test(c.callee)) {
        if (!ai.has(c.from)) ai.set(c.from, aiImport?.source ?? c.callee);
      }
      if (STREAM_CALLS.test(c.callee) || c.args.some((a) => (a.key === 'stream' && /^(True|true)$/.test(a.text)) || a.items?.some((i) => i.key === 'stream' && /^(True|true)$/.test(i.text)))) streams.add(c.from);
    }
    for (const s of f.strings) if (s.value === 'text/event-stream') streams.add(s.scope);
    void file;
  }
  for (const [id, n] of p.sinks.nodes) if (n.kind === 'external' && AI_HOSTS.test(n.label)) ai.set(id, n.label);

  // ---- families ----
  const families: EntryFamily[] = [];
  const familyOf = new Map<string, EntryFamily>();
  const subtree = new Map<string, number>();
  const subtreeSize = (id: string) => {
    let n = subtree.get(id);
    if (n !== undefined) return n;
    const seen = new Set([id]);
    const q = [id];
    while (q.length && seen.size < 300) for (const c of p.calleesFor(q.shift()!)) if (!seen.has(c.to) && g.symbols.has(c.to)) (seen.add(c.to), q.push(c.to));
    subtree.set(id, (n = seen.size));
    return n;
  };
  for (const [kind, list] of byKind) {
    if (list.length < 6) continue;
    const groups = new Map<string, { shared: string[]; members: EntryPoint[]; label?: string; explain?: string }>();
    const parallel: EntryPoint[] = [];
    // One handler bound to many entry points (a generic proxy or dispatcher).
    const byHandler = new Map<string, EntryPoint[]>();
    for (const e of list) byHandler.set(e.handlerId!, [...(byHandler.get(e.handlerId!) ?? []), e]);
    for (const [h, es] of byHandler) if (es.length >= 3) groups.set(`h:${h}`, { shared: [h], members: es });
    for (const e of list) {
      if ((byHandler.get(e.handlerId!)?.length ?? 0) >= 3) continue;
      const reach = [...(reachOfEntry.get(e.id) ?? [])].filter((id) => g.symbols.has(id));
      const unique = reach.filter((id) => dfOf(id, kind) <= 1).length;
      const shared = p.calleesFor(e.handlerId!).filter((c) => c.kind === 'calls' && g.symbols.has(c.to) && dfOf(c.to, kind) >= 3);
      if (!shared.length) {
        parallel.push(e);
        continue;
      }
      // The shared code must do most of the work; otherwise it is just a helper (a guard, a validator, a logger).
      const direct = p.calleesFor(e.handlerId!).filter((c) => c.kind === 'calls' && g.symbols.has(c.to)).map((c) => c.to);
      const biggest = direct.sort((a, b) => subtreeSize(b) - subtreeSize(a) || a.localeCompare(b))[0];
      const main = shared.map((c) => c.to).sort((a, b) => subtreeSize(b) - subtreeSize(a) || a.localeCompare(b))[0];
      const rest = direct.filter((d) => d !== main).reduce((n, d) => n + subtreeSize(d), 0);
      if (unique > 6 || main !== biggest || subtreeSize(main) < unique || rest * 2 > subtreeSize(main) || HELPER_NAME.test(g.symbols.get(main)!.name)) {
        parallel.push(e);
        continue;
      }
      const key = `c:${main}`;
      const gr = groups.get(key) ?? { shared: [main], members: [] };
      gr.members.push(e);
      groups.set(key, gr);
    }
    // Parallel implementations: thin entry points that each call their *own* function, where those functions live
    // side by side (app/tools/weather.py, app/tools/search.py) or override the same base (WeatherTool.run, SearchTool.run).
    for (const e of parallel) {
      const direct = p.calleesFor(e.handlerId!).filter((c) => c.kind === 'calls' && g.symbols.has(c.to) && !p.isTrivial(c.to));
      if (!direct.length || direct.length > 2) continue;
      const main = g.symbols.get(direct.map((c) => c.to).sort((a, b) => subtreeSize(b) - subtreeSize(a) || a.localeCompare(b))[0])!;
      if (HELPER_NAME.test(main.name) || dfOf(main.id, kind) > 2) continue;
      const cls = main.containerId ? g.symbols.get(main.containerId) : undefined;
      const base = cls?.supers?.[0];
      const dir = main.file.includes('/') ? main.file.slice(0, main.file.lastIndexOf('/')) : '.';
      const key = base ? `s:${base}.${main.name}` : `d:${dir}${main.container ? `:${main.name}` : ''}`;
      const gr = groups.get(key) ?? {
        shared: [],
        members: [],
        label: base ? `via ${base} subclasses (.${main.name})` : `via ${dir.split('/').slice(-2).join('/')}/${main.container ? `*.${main.name}` : '*'}`,
        explain: base
          ? `${NOUN[kind]}s that each call their own ${base} implementation (${main.name}); they share a shape, not code. The line under each names its implementation.`
          : `${NOUN[kind]}s that each call their own function in ${dir}/; they share a shape, not code. The line under each names the function it calls.`,
      };
      gr.members.push(e);
      groups.set(key, gr);
    }
    for (const [key, gr] of groups) {
      if (gr.members.length < 4) continue;
      const names = gr.shared.map((id) => {
        const s = g.symbols.get(id);
        return { id, name: s ? (s.kind === 'handler' ? 'one shared handler' : s.container ? `${s.container}.${s.name}` : s.name) : id };
      });
      const prefix = commonPrefix(gr.members.map((m) => m.path ?? ''));
      const noun = NOUN[kind];
      const fam: EntryFamily = {
        id: `family:${kind}:${key}`,
        kind,
        label: `${prefix && prefix !== '/' ? `${prefix}/* ` : ''}${gr.label ?? `via ${names[0].name}`}`,
        explain: gr.explain
          ? `${gr.members.length} ${gr.explain}`
          : key.startsWith('h:')
          ? `${gr.members.length} ${noun}s are answered by the same code (${names[0].name}). Open any one to see it; the line under each says what is different.`
          : `${gr.members.length} ${noun}s do little themselves: each hands its work to ${names[0].name}, which does the rest. Open any one to see the shared flow; the line under each says what it adds.`,
        shared: names,
        members: gr.members.map((m) => m.id),
      };
      families.push(fam);
      for (const m of gr.members) familyOf.set(m.id, fam);
    }
  }
  families.sort((a, b) => b.members.length - a.members.length);

  // ---- per-entry insight ----
  // How much code and data an entry point reaches only means something next to its siblings: in a big app
  // nearly everything reaches 100+ functions, so rank against the other entry points of the same kind.
  const dataWeight = (e: EntryPoint) => {
    let w = 0;
    const seen = new Set<string>();
    for (const id of reachOfEntry.get(e.id) ?? []) for (const se of p.sinks.edges.get(id) ?? []) if (p.sinks.nodes.get(se.to)?.kind === 'table' && !seen.has(se.to + se.kind)) (seen.add(se.to + se.kind), (w += se.kind === 'writes' ? 2 : 1));
    return w;
  };
  const rankOf = (values: number[]) => {
    const sorted = [...values].sort((a, b) => a - b);
    return (v: number) => {
      if (!sorted.length || sorted[sorted.length - 1] === 0) return 0;
      let lo = 0;
      while (lo < sorted.length && sorted[lo] < v) lo++;
      return v === 0 ? 0 : (lo + 1) / sorted.length;
    };
  };
  const percentiles = new Map<EntryKind, { size: (v: number) => number; data: (v: number) => number }>();
  for (const [kind, list] of byKind) {
    percentiles.set(kind, {
      size: rankOf(list.map((e) => [...(reachOfEntry.get(e.id) ?? [])].filter((id) => g.symbols.has(id)).length)),
      data: rankOf(list.map(dataWeight)),
    });
  }
  const pagesReaching = (e: EntryPoint) => [...(p.reachOf(e.id) ?? [])].filter((id) => kindOf.get(id) === 'page' && id !== e.id).length;
  for (const e of p.entries) {
    if (!e.handlerId || e.kind === 'channel') continue;
    const kind = e.kind;
    const n = byKind.get(kind)?.length ?? 1;
    // Something most entry points do (shared auth middleware, a common AI helper) does not set one apart.
    const distinctive = (id: string) => n < 4 || dfOf(id, kind) <= Math.max(2, n * 0.5);
    const reach = [...(reachOfEntry.get(e.id) ?? [])];
    const fam = familyOf.get(e.id);
    const fns = reach.filter((id) => g.symbols.has(id));
    const traits = new Set<EntryTrait>();
    const reasons: string[] = [];

    const aiHit = [e.handlerId, ...reach].find((id) => ai.has(id) && distinctive(id));
    if (aiHit) {
      traits.add('ai');
      reasons.push(`calls an AI model (${ai.get(aiHit)})`);
    }
    if ([e.handlerId, ...reach].some((id) => streams.has(id) && distinctive(id))) {
      traits.add('stream');
      reasons.push('streams its response');
    }
    if (e.method === 'WS' || /(^|\/)(ws|wss|socket|websocket|realtime|live)(\/|$)/i.test(e.path ?? '')) {
      traits.add('realtime');
      reasons.push('keeps a live connection open');
    }
    const segs = (e.path ?? '').split('/').filter(Boolean);
    const authStep = fns.find((id) => dfOf(id, kind) <= Math.max(3, n * 0.1) && AUTH_STEP.test(g.symbols.get(id)!.name));
    if (segs.some((s) => AUTH_SEG.test(s)) || AUTH_NAME.test(e.handlerName ?? '') || authStep) {
      traits.add('auth');
      reasons.push(authStep ? `authentication (${g.symbols.get(authStep)!.name})` : 'authentication / sessions');
    }
    const pages = pagesReaching(e);
    const callers = e.clientCallers?.length ?? 0;
    if (pages >= 2 || callers >= 2) {
      traits.add('popular');
      reasons.push(pages >= 2 ? `used by ${pages} pages` : `called from ${callers} places in the frontend`);
    }
    const writes = new Set<string>();
    const reads = new Set<string>();
    const hosts = new Set<string>();
    // The same, minus data that most siblings touch too: what the gist shows to tell siblings apart.
    const own = { writes: new Set<string>(), reads: new Set<string>(), hosts: new Set<string>() };
    for (const id of [e.handlerId, ...fns]) {
      const mine = !fam || dfOf(id, kind) <= 2 || id === e.handlerId;
      for (const se of p.sinks.edges.get(id) ?? []) {
        const node = p.sinks.nodes.get(se.to);
        if (!node) continue;
        if (node.kind === 'table') {
          (se.kind === 'writes' ? writes : reads).add(node.label);
          if (mine) (se.kind === 'writes' ? own.writes : own.reads).add(node.label);
        } else if (node.kind === 'external' && !/^HTTP via /.test(node.label)) {
          hosts.add(node.label);
          if (mine) own.hosts.add(node.label);
        }
      }
    }
    for (const w of writes) reads.delete(w);
    for (const w of own.writes) own.reads.delete(w);
    if (writes.size) {
      traits.add('writes');
      reasons.push(`writes ${list3([...writes])}`);
    } else if (reads.size >= 2) reasons.push(`reads ${reads.size} tables`);
    if (hosts.size) {
      traits.add('external');
      if (!aiHit || hosts.size > 1) reasons.push(`talks to ${list3([...hosts])}`);
    }
    if (fns.length >= 25) {
      traits.add('large');
      reasons.push(`reaches ${fns.length} functions`);
    }
    if (fam) reasons.push(`works like ${fam.members.length - 1} other ${NOUN[kind]}s (${fam.label})`);

    const pct = percentiles.get(kind)!;
    let score =
      28 * pct.size(fns.length) +
      14 * pct.data(2 * writes.size + reads.size) +
      Math.min(8, 3 * hosts.size) +
      Math.min(18, 6 * Math.log2(1 + pages + callers)) +
      (traits.has('ai') ? 22 : 0) +
      (traits.has('stream') ? 16 : 0) +
      (traits.has('auth') ? 13 : 0) +
      (traits.has('realtime') ? 8 : 0);
    if (fam) score *= 0.45;
    e.insight = { score: Math.round(Math.min(100, score)), tier: fam ? 'routine' : 'normal', traits: [...traits], reasons, gist: gistOf(p, e, fam, dfOf, own.writes, own.reads, own.hosts), family: fam?.id };
  }

  // Key entry points: the top of each kind, only worth singling out when there are many.
  for (const [, list] of byKind) {
    if (list.length < 12) continue;
    const cands = list.filter((e) => e.insight && e.insight.tier !== 'routine' && (e.insight.score >= 30 || (e.insight.score >= 20 && e.insight.traits.some((t) => t === 'ai' || t === 'auth' || t === 'stream')))).sort((a, b) => b.insight!.score - a.insight!.score);
    const k = Math.max(3, Math.min(15, Math.round(list.length * 0.1)));
    cands.forEach((e, i) => {
      const special = e.insight!.traits.some((t) => t === 'ai' || t === 'auth' || t === 'stream');
      if (i < k || (special && i < k + 5)) e.insight!.tier = 'key';
    });
  }

  // ---- backbone ----
  const backbone: Backbone[] = [];
  const handlerIds = new Set(entries.map((e) => e.handlerId));
  for (const [kind, all] of byKind) {
    // Families have their own shared code; the backbone is what the rest of the app has in common.
    const list = all.filter((e) => !familyOf.has(e.id));
    if (list.length < 4) continue;
    const cands: Backbone[] = [];
    const count = new Map<string, number>();
    for (const e of list) for (const id of reachOfEntry.get(e.id) ?? []) count.set(id, (count.get(id) ?? 0) + 1);
    // Middleware the framework runs before handlers is the clearest "every request passes through here".
    const mw = new Map<string, number>();
    for (const e of all) for (const m of e.middleware ?? []) if (m.id) mw.set(m.id, (mw.get(m.id) ?? 0) + 1);
    for (const [id, c] of mw) {
      const s = g.symbols.get(id);
      if (s && c >= all.length * 0.3) cands.push({ kind, id, name: s.container ? `${s.container}.${s.name}` : s.name, role: 'middleware', share: c / all.length });
    }
    for (const [id, c] of count) {
      const s = g.symbols.get(id);
      if (!s || handlerIds.has(id) || mw.has(id) || c < list.length * 0.5 || !BACKBONE_ROLES.has(s.role ?? 'other') || p.isTrivial(id) || s.kind === 'class' || s.kind === 'constructor' || /Error$|Exception$|Logger$|Log$/.test(s.container ?? '') || HELPER_NAME.test(s.name)) continue;
      cands.push({ kind, id, name: s.container ? `${s.container}.${s.name}` : s.name, role: s.role ?? 'other', share: c / list.length });
    }
    const rank = (b: Backbone) => (b.role === 'middleware' ? 0 : b.role === 'service' || b.role === 'client' ? 1 : 2);
    backbone.push(...cands.sort((a, b) => b.share - a.share || rank(a) - rank(b)).slice(0, 6));
  }
  return { families, backbone };
}

/** One line on what this entry point does beyond its siblings. */
function gistOf(p: Project, e: EntryPoint, fam: EntryFamily | undefined, dfOf: (id: string, k: EntryKind) => number, writes: Set<string>, reads: Set<string>, hosts: Set<string>): string | undefined {
  const g = p.graph;
  const parts: string[] = [];
  const calls = g.callsFrom.get(e.handlerId!) ?? [];
  if (fam) {
    // What the handler passes to the shared code is usually what tells siblings apart: runTool("get_weather", …)
    const shared = new Set(fam.shared.map((s) => s.id));
    const lits = calls.filter((rc) => rc.targets.some((t) => shared.has(t))).flatMap((rc) => rc.site.args.filter((a) => a.kind === 'string' && a.value && a.value.length <= 40).map((a) => `"${a.value}"`));
    parts.push(...lits.slice(0, 2));
  }
  // Its own steps: functions few other entry points use.
  const own = calls
    .flatMap((rc) => rc.targets)
    .filter((t, i, a) => a.indexOf(t) === i && !fam?.shared.some((s) => s.id === t) && dfOf(t, e.kind) <= 2 && !p.isTrivial(t))
    .map((t) => g.symbols.get(t))
    .filter((s) => s && s.kind !== 'handler')
    .map((s) => (s!.container ? `${s!.container}.${s!.name}` : s!.name));
  if (parts.length < 2) parts.push(...own.slice(0, 2 - parts.length));
  if (writes.size) parts.push(`writes ${list3([...writes], 2)}`);
  else if (reads.size) parts.push(`reads ${list3([...reads], 2)}`);
  if (hosts.size && parts.length < 4) parts.push(`calls ${[...hosts][0]}`);
  return parts.length ? parts.slice(0, 4).join(' · ') : undefined;
}

function list3(xs: string[], max = 3): string {
  return xs.length <= max ? xs.join(', ') : `${xs.slice(0, max).join(', ')} +${xs.length - max}`;
}

function commonPrefix(paths: string[]): string {
  if (!paths.length || paths.some((x) => !x)) return '';
  const split = paths.map((x) => x.split('/'));
  const out: string[] = [];
  for (let i = 0; i < split[0].length; i++) {
    const s = split[0][i];
    if (s.startsWith(':') || s.startsWith('{') || !split.every((x) => x[i] === s && i < x.length - 1)) break;
    out.push(s);
  }
  return out.join('/');
}
