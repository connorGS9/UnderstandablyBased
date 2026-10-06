import type { Arg, DbTable, EdgeKind, SinkEdge, SinkNode } from './types';
import type { CodeGraph } from './graph';

/**
 * Finds where code touches the outside world: database tables, HTTP services, IPC channels and
 * message topics. These become leaf nodes in flows and the right-hand column in data-flow diagrams.
 */
export interface SinkIndex {
  nodes: Map<string, SinkNode>;
  edges: Map<string, SinkEdge[]>;
}

const READ_OPS = /^(find|get|select|query|fetch|load|list|count|exists|search|read|retrieve|filter|all|first|aggregate|scan|lookup|one|paginate|where|exclude|values|raw)/i;
const WRITE_OPS = /^(save|insert|create|update|upsert|delete|destroy|remove|persist|merge|put|add|bulk|set|patch|increment|decrement|truncate|execute|exec|flush|commit|store|write|modify|replace)/i;
const DATA_OPS = new RegExp(`${READ_OPS.source}|${WRITE_OPS.source}`, 'i');

const SQL_KEYWORDS = new Set(['select', 'where', 'lateral', 'unnest', 'dual', 'values', 'set', 'only', 'table', 'the', 'a', 'an', 'json_table', 'generate_series', 'information_schema', 'pg_catalog']);

function opKind(name: string): EdgeKind {
  if (WRITE_OPS.test(name)) return 'writes';
  if (READ_OPS.test(name)) return 'reads';
  return 'uses';
}

function sqlTables(sql: string): { table: string; kind: EdgeKind }[] {
  const out: { table: string; kind: EdgeKind }[] = [];
  const add = (re: RegExp, kind: EdgeKind) => {
    for (const m of sql.matchAll(re)) {
      const t = m[1].replace(/[`"\[\]]/g, '').split('.').pop()!;
      if (!t || SQL_KEYWORDS.has(t.toLowerCase()) || /^\d/.test(t) || t.startsWith('$') || t.startsWith(':')) continue;
      out.push({ table: t, kind });
    }
  };
  add(/\bfrom\s+([`"\[]?[A-Za-z_][\w.]*[`"\]]?)/gi, 'reads');
  add(/\bjoin\s+([`"\[]?[A-Za-z_][\w.]*[`"\]]?)/gi, 'reads');
  add(/\binsert\s+(?:ignore\s+)?into\s+([`"\[]?[A-Za-z_][\w.]*[`"\]]?)/gi, 'writes');
  add(/\bupdate\s+([`"\[]?[A-Za-z_][\w.]*[`"\]]?)\s+set\b/gi, 'writes');
  add(/\bdelete\s+from\s+([`"\[]?[A-Za-z_][\w.]*[`"\]]?)/gi, 'writes');
  add(/\bmerge\s+into\s+([`"\[]?[A-Za-z_][\w.]*[`"\]]?)/gi, 'writes');
  // "delete from" also matched "from" as a read; drop reads shadowed by writes on the same table
  const writes = new Set(out.filter((o) => o.kind === 'writes').map((o) => o.table));
  return out.filter((o) => !(o.kind === 'reads' && writes.has(o.table)));
}

const HTTP_CLIENT_RECV = /^(axios|got|ky|superagent|request|requests|httpx|aiohttp|urllib3|fetch|\$http|http|https|this\.http|this\.httpClient|httpClient|HttpClient|_httpClient|client|session|this\.client|restTemplate|this\.restTemplate|webClient|this\.webClient|_client|reqwest|api|this\.api|apiClient)$/;
const HTTP_VERBS = /^(get|post|put|patch|delete|head|options|request|fetch|send|Get|Post|Put|Delete|Head|PostForm|GetAsync|PostAsync|PutAsync|DeleteAsync|PatchAsync|SendAsync|GetStringAsync|GetFromJsonAsync|PostAsJsonAsync|PutAsJsonAsync|getForObject|getForEntity|postForObject|postForEntity|exchange|retrieve|uri)$/;

const MSG_SEND = /^(send|produce|publish|basicPublish|basic_publish|Publish|Produce|emit|xadd|lpush|rpush|sendMessage|send_message|convertAndSend|SendMessageAsync)$/;
const MSG_RECV = /^(subscribe|Subscribe|consume|basicConsume|basic_consume|QueueSubscribe|psubscribe|xread|xreadgroup|blpop|brpop|receive|receiveMessage|ReceiveMessageAsync)$/;
const MSG_RECV_RECV = /(producer|consumer|kafka|template|channel|redis|nats|nc|js|pubsub|bus|queue|mq|rabbit|sqs|sns|stream|broker|publisher|subscriber|client)/i;

const IPC_NAMED_CALLS = new Map<string, string>([
  ['shm_open', 'shared memory'],
  ['shm_unlink', 'shared memory'],
  ['mq_open', 'POSIX message queue'],
  ['mq_unlink', 'POSIX message queue'],
  ['sem_open', 'named semaphore'],
  ['mkfifo', 'named pipe'],
  ['ftok', 'System V IPC'],
  ['managed_shared_memory', 'shared memory'],
  ['shared_memory_object', 'shared memory'],
  ['managed_mapped_file', 'memory-mapped file'],
  ['message_queue', 'message queue'],
  ['named_mutex', 'named mutex'],
  ['named_condition', 'named condition'],
  ['CreateFileMapping', 'shared memory'],
  ['CreateFileMappingA', 'shared memory'],
  ['CreateFileMappingW', 'shared memory'],
  ['OpenFileMapping', 'shared memory'],
  ['CreateNamedPipe', 'named pipe'],
  ['CreateNamedPipeA', 'named pipe'],
  ['CreateNamedPipeW', 'named pipe'],
]);

const SOCKET_ENDPOINT = /^(tcp|ipc|inproc|pgm|epgm|udp|aeron|aeron-spy|unix|ws|wss):\/?\/?/i;

function firstString(args: Arg[]): Arg | undefined {
  for (const a of args) {
    if (a.kind === 'string') return a;
    if (a.kind === 'call' && a.items) {
      const s = a.items.find((x) => x.kind === 'string');
      if (s) return s;
    }
  }
  return undefined;
}

function urlLabel(raw: string): { id: string; label: string; detail: string } {
  const v = raw.replace(/\$\{[^}]*\}/g, '{…}').replace(/\{\{[^}]*\}\}/g, '{…}');
  const m = /^(https?|wss?):\/\/([^/?#]+)(\/[^?#]*)?/i.exec(v);
  if (m) return { id: `ext:${m[2].toLowerCase()}`, label: m[2], detail: v };
  if (v.startsWith('/')) return { id: `ext:api${v.split('/').slice(0, 3).join('/')}`, label: `API ${v.split('/').slice(0, 3).join('/')}`, detail: v };
  return { id: `ext:${v.slice(0, 40)}`, label: v.slice(0, 40), detail: v };
}

export function buildSinks(graph: CodeGraph, tables: DbTable[]): SinkIndex {
  const nodes = new Map<string, SinkNode>();
  const edges = new Map<string, SinkEdge[]>();
  const tableByLower = new Map(tables.map((t) => [t.name.toLowerCase(), t]));
  const tableByModel = new Map<string, DbTable>();
  for (const t of tables) if (t.modelName) tableByModel.set(t.modelName, t);
  // prisma.user.findMany(), db.order.create(), tx.article.update(): client accessor named after the model/table
  const clientAccessors = new Map<string, DbTable>();
  for (const t of tables) {
    for (const n of [t.modelName, t.name]) if (n) clientAccessors.set(n.charAt(0).toLowerCase() + n.slice(1), t);
  }

  const tableNode = (name: string): string => {
    // JPQL/HQL queries name entity classes ("FROM PetType"), not tables.
    const known = tableByLower.get(name.toLowerCase()) ?? tableByModel.get(name);
    const label = known?.name ?? name;
    const id = `table:${label.toLowerCase()}`;
    if (!nodes.has(id)) nodes.set(id, { id, kind: 'table', label, detail: known ? `${known.columns.length} columns · ${known.source.kind}` : 'table referenced in a query' });
    return id;
  };
  const addEdge = (from: string, to: string, kind: EdgeKind, file: string, line: number, detail?: string) => {
    const list = edges.get(from) ?? [];
    if (list.some((e) => e.to === to && e.kind === kind)) return;
    list.push({ from, to, kind, file, line, detail });
    edges.set(from, list);
  };
  const ownerOf = (scope: string, file: string, line: number): string | undefined => {
    // Tests talk to fake databases and endpoints; keep them out of the architecture picture.
    if (graph.symbols.get(scope)?.role === 'test') return undefined;
    if (!scope.startsWith('file:')) return scope;
    // File-scope strings (e.g. Java SQL constants): attach to the enclosing class.
    const cls = (graph.symbolsByFile.get(file) ?? []).find((s) => (s.kind === 'class' || s.kind === 'struct') && s.range.sl <= line && s.range.el >= line);
    return cls?.id;
  };

  // 1. SQL strings
  for (const [file, f] of graph.facts) {
    for (const s of f.strings) {
      if (!/\b(select|insert|update|delete|merge)\b/i.test(s.value)) continue;
      const owner = ownerOf(s.scope, file, s.line);
      if (!owner) continue;
      for (const t of sqlTables(s.value)) {
        if (!tableByLower.has(t.table.toLowerCase()) && !tableByModel.has(t.table) && tables.length > 0 && !/^[a-z_][a-z0-9_]*$/i.test(t.table)) continue;
        addEdge(owner, tableNode(t.table), t.kind, file, s.line, 'SQL');
      }
    }
  }

  // 2. Repository classes typed with an entity: JpaRepository<Order, Long>, Repository<Order>
  const repoEntity = new Map<string, DbTable>();
  for (const s of graph.symbols.values()) {
    if (!(s.kind === 'class' || s.kind === 'interface')) continue;
    for (const [sup, args] of Object.entries(s.superArgs ?? {})) {
      if (!/Repository|Dao|Repo|DbSet|Crud/i.test(sup)) continue;
      const t = tableByModel.get(args[0]);
      if (t) {
        repoEntity.set(s.name, t);
        addEdge(s.id, tableNode(t.name), 'uses', s.file, s.range.sl, `${sup}<${args[0]}>`);
        for (const m of graph.membersByContainer.get(s.name)?.values() ?? []) for (const mm of m) addEdge(mm.id, tableNode(t.name), opKind(mm.name), mm.file, mm.range.sl, `${s.name} manages ${args[0]}`);
      }
    }
  }

  // 3. Calls: ORM model access, HTTP clients, IPC, messaging
  for (const [file, f] of graph.facts) {
    for (const site of f.calls) {
      const owner = ownerOf(site.from, file, site.range.sl);
      if (!owner) continue;
      const line = site.range.sl;
      const recv = (site.receiver ?? '').replace(/->/g, '.').replace(/\?\./g, '.');
      const segs = recv.split('.');
      const last = segs[segs.length - 1];

      // ORM model receivers
      if (tables.length && recv && DATA_OPS.test(site.callee)) {
        const modelRecv = recv.replace(/\.(objects|query|all_objects)$/, '').split('.').pop()!;
        const clientish = segs.length >= 2 && /prisma|db|database|client|tx|trx|ctx|knex|orm|conn/i.test(segs[segs.length - 2]);
        const t = tableByModel.get(modelRecv) ?? (clientish ? clientAccessors.get(last) : undefined);
        if (t) {
          addEdge(owner, tableNode(t.name), opKind(site.callee), file, line, `${recv}.${site.callee}()`);
          continue;
        }
        // field typed Repository<Order> / DbSet<Order>
        const scopeSym = graph.symbols.get(site.from);
        if (scopeSym?.container && segs.length >= 1) {
          const fieldName = segs[0] === 'this' || segs[0] === 'self' ? segs[1] : segs[0];
          const fieldFact = fieldName ? graph.fieldsByOwner.get(scopeSym.container)?.get(fieldName) : undefined;
          const entity = fieldFact?.typeArgs?.[0] ?? (fieldFact?.type ? repoEntity.get(fieldFact.type)?.modelName : undefined);
          const tt = entity ? tableByModel.get(entity) : undefined;
          if (tt && !repoEntity.has(fieldFact?.type ?? '')) {
            addEdge(owner, tableNode(tt.name), opKind(site.callee), file, line, `${recv}.${site.callee}()`);
            continue;
          }
        }
      }
      // SQLAlchemy / SQLModel: session.query(Order), select(Order), db.get(Order, id)
      if (tables.length && /^(query|select|get|delete|update|insert|exec)$/.test(site.callee)) {
        const modelArg = site.args.find((a) => a.kind === 'ident' && tableByModel.has(a.text));
        if (modelArg) {
          const t = tableByModel.get(modelArg.text)!;
          addEdge(owner, tableNode(t.name), site.callee === 'select' || site.callee === 'query' || site.callee === 'get' ? 'reads' : 'writes', file, line, `${site.callee}(${modelArg.text})`);
          continue;
        }
      }

      // HTTP
      const isFetch = !recv && site.callee === 'fetch';
      const isHttpLib = recv && HTTP_VERBS.test(site.callee) && (HTTP_CLIENT_RECV.test(recv) || /http|rest|webclient|client/i.test(last ?? ''));
      const isGoHttp = recv === 'http' && /^(Get|Post|Head|PostForm|NewRequest|NewRequestWithContext)$/.test(site.callee);
      const isCurl = site.callee === 'curl_easy_setopt' && site.args[1]?.text === 'CURLOPT_URL';
      if (isFetch || isHttpLib || isGoHttp || isCurl) {
        const urlArg = isGoHttp && site.callee.startsWith('NewRequest') ? site.args.find((a, i) => i >= 1 && a.kind === 'string') : isCurl ? site.args[2] : site.args[0];
        if (urlArg?.kind === 'string' || isFetch || isGoHttp || /client|http|rest/i.test(recv)) {
          const lbl = urlArg?.kind === 'string' && urlArg.value ? urlLabel(urlArg.value) : { id: `ext:${recv || 'http'}`, label: `HTTP via ${recv || site.callee}`, detail: urlArg?.text ?? '' };
          // relative URLs from frontend code hit our own backend; label them as such
          if (!nodes.has(lbl.id)) nodes.set(lbl.id, { id: lbl.id, kind: 'external', label: lbl.label, detail: lbl.detail });
          addEdge(owner, lbl.id, 'http', file, line, `${site.callee.toUpperCase()} ${urlArg?.value ?? ''}`.trim());
          continue;
        }
      }

      // IPC: named shared memory, queues, pipes
      const ipcKind = IPC_NAMED_CALLS.get(site.callee);
      if (ipcKind) {
        const nameArg = firstString(site.args);
        const label = nameArg?.value ?? site.args.find((a) => a.kind === 'ident')?.text ?? '(unnamed)';
        const id = `chan:${ipcKind}:${label}`;
        if (!nodes.has(id)) nodes.set(id, { id, kind: 'channel', label, detail: ipcKind });
        addEdge(owner, id, 'uses', file, line, `${site.callee}()`);
        continue;
      }
      // Socket endpoints (ZeroMQ, nanomsg, Aeron, unix sockets)
      if (/^(bind|connect|nn_bind|nn_connect|zmq_bind|zmq_connect|addPublication|addSubscription|add_publication|add_subscription|Listen|Dial)$/.test(site.callee)) {
        const s = firstString(site.args);
        if (s?.value && (SOCKET_ENDPOINT.test(s.value) || s.value.endsWith('.sock'))) {
          const id = `chan:socket:${s.value}`;
          if (!nodes.has(id)) nodes.set(id, { id, kind: 'channel', label: s.value, detail: /aeron/i.test(s.value) ? 'Aeron channel' : 'socket endpoint' });
          const kind: EdgeKind = /Publication|publication/.test(site.callee) ? 'publishes' : /Subscription|subscription/.test(site.callee) ? 'subscribes' : 'uses';
          addEdge(owner, id, kind, file, line, `${site.callee}("${s.value}")`);
          continue;
        }
      }
      // Message topics
      if ((MSG_SEND.test(site.callee) || MSG_RECV.test(site.callee)) && recv && MSG_RECV_RECV.test(recv)) {
        const s = firstString(site.args);
        const topicArg = s ?? (site.args[0]?.kind === 'array' ? site.args[0].items?.find((x) => x.kind === 'string') : undefined);
        if (topicArg?.value && topicArg.value.length < 120 && !/\s/.test(topicArg.value)) {
          const id = `chan:topic:${topicArg.value}`;
          if (!nodes.has(id)) nodes.set(id, { id, kind: 'channel', label: topicArg.value, detail: 'message topic / queue' });
          addEdge(owner, id, MSG_SEND.test(site.callee) ? 'publishes' : 'subscribes', file, line, `${recv}.${site.callee}()`);
        }
      }
    }
  }

  // 3b. A class that connects a member socket to an endpoint (usually in its constructor) talks to that
  // endpoint whenever any of its methods sends or receives on that member.
  const memberChannels = new Map<string, string>(); // `${class}#${field}` -> channel id
  for (const [file, f] of graph.facts) {
    for (const site of f.calls) {
      if (!/^(bind|connect|zmq_bind|zmq_connect|nn_bind|nn_connect)$/.test(site.callee) || !site.receiver) continue;
      const scope = graph.symbols.get(site.from);
      const s = firstString(site.args);
      if (!scope?.container || !s?.value) continue;
      const id = `chan:socket:${s.value}`;
      if (!nodes.has(id)) continue;
      const fieldName = site.receiver.replace(/^(this->|this\.|self\.)/, '');
      memberChannels.set(`${scope.container}#${fieldName}`, id);
      void file;
    }
  }
  if (memberChannels.size) {
    for (const [file, f] of graph.facts) {
      for (const site of f.calls) {
        if (!site.receiver || !/^(send|send_multipart|recv|recv_multipart|write|read|publish|push|pop|offer|poll|zmq_send|zmq_recv)$/.test(site.callee)) continue;
        const scope = graph.symbols.get(site.from);
        if (!scope?.container) continue;
        const fieldName = site.receiver.replace(/^(this->|this\.|self\.)/, '');
        const ch = memberChannels.get(`${scope.container}#${fieldName}`);
        if (ch) addEdge(site.from, ch, /recv|read|pop|poll/.test(site.callee) ? 'subscribes' : 'publishes', file, site.range.sl, `${site.receiver}.${site.callee}()`);
      }
    }
  }

  // 4. Listener annotations: @KafkaListener(topics = "orders"), @RabbitListener(queues = "x"), @EventPattern('x')
  for (const s of graph.symbols.values()) {
    if (s.role === 'test') continue;
    for (const a of s.annotations) {
      if (!/^(KafkaListener|RabbitListener|JmsListener|SqsListener|StreamListener|EventPattern|MessagePattern|Subscribe|EventHandler|OnEvent)$/.test(a.name)) continue;
      const topics: string[] = [];
      for (const arg of a.args) {
        if (arg.kind === 'string' && arg.value) topics.push(arg.value);
        for (const it of arg.items ?? []) if (it.kind === 'string' && it.value) topics.push(it.value);
      }
      for (const t of topics) {
        const id = `chan:topic:${t}`;
        if (!nodes.has(id)) nodes.set(id, { id, kind: 'channel', label: t, detail: 'message topic / queue' });
        addEdge(s.id, id, 'subscribes', s.file, s.range.sl, `@${a.name}`);
      }
    }
  }

  return { nodes, edges };
}
