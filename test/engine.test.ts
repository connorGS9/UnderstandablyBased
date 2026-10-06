// Engine regression tests: each fixture is a tiny but realistic project for one framework/architecture.
// Run with: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { Project } from '../src/engine/project';
import type { FlowGraph } from '../src/engine/types';

const fixture = (name: string) => path.join(import.meta.dirname, 'fixtures', name);
const cache = new Map<string, Promise<Project>>();
const open = (name: string) => {
  if (!cache.has(name)) cache.set(name, Project.open(fixture(name)));
  return cache.get(name)!;
};

function routes(p: Project) {
  return p.entries.filter((e) => e.kind === 'http-route').map((e) => `${e.method} ${e.path} -> ${e.handlerName}`);
}

/** Labels of every node reachable from the root, in BFS order. */
function reach(f: FlowGraph): string[] {
  const out: string[] = [];
  const byId = new Map(f.nodes.map((n) => [n.id, n]));
  const kids = new Map<string, string[]>();
  for (const e of f.edges) kids.set(e.from, [...(kids.get(e.from) ?? []), e.to]);
  const seen = new Set<string>();
  const q = [f.rootId];
  while (q.length) {
    const id = q.shift()!;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(byId.get(id)!.label);
    q.push(...(kids.get(id) ?? []));
  }
  return out;
}

test('express: mounted routers, mount-scoped middleware, SQL tables, external calls', async () => {
  const p = await open('express-mini');
  assert.equal(p.summary.profile.kinds[0].kind, 'web-backend');
  const r = routes(p);
  assert.ok(r.some((x) => x.startsWith('GET /api/orders ->')), r.join('\n'));
  assert.ok(r.some((x) => x.startsWith('POST /api/orders/:id/cancel ->')));
  assert.ok(r.some((x) => x.startsWith('GET /health ->')));
  const cancel = p.entries.find((e) => e.path === '/api/orders/:id/cancel')!;
  assert.deepEqual(cancel.middleware?.map((m) => m.name), ['requireAuth']);
  assert.equal(p.entries.find((e) => e.path === '/health')!.middleware?.length ?? 0, 0, 'mount middleware must not leak to other routes');
  const flow = reach(p.flow(cancel.id, { depth: 6 }));
  for (const expected of ['requireAuth', 'cancelOrder', 'orders', 'notifyWarehouse', 'warehouse.example.com']) assert.ok(flow.includes(expected), `${expected} missing from ${flow.join(' > ')}`);
  const orders = p.tables.find((t) => t.name === 'orders')!;
  assert.equal(orders.columns.find((c) => c.name === 'customer_id')?.fk?.table, 'customers');
  assert.ok(orders.indexes.some((i) => i.name === 'idx_orders_customer'));
});

test('spring: class prefixes, interface -> implementation, JPA repository -> table', async () => {
  const p = await open('spring-mini');
  assert.deepEqual(routes(p).sort(), ['GET /api/products -> ProductController.list', 'POST /api/products/{id}/restock -> ProductController.restock']);
  const flow = reach(p.flow('http-route:POST /api/products/{id}/restock', { depth: 6 }));
  assert.ok(flow.includes('ProductServiceImpl.restock'), flow.join(' > '));
  assert.ok(flow.includes('Product.addStock'));
  assert.ok(flow.includes('products'));
  const products = p.tables.find((t) => t.name === 'products')!;
  assert.ok(products.columns.some((c) => c.name === 'category_id' && c.fk?.table === 'categories'));
  assert.ok(products.indexes.some((i) => i.name === 'idx_products_sku' && i.unique));
  const roles = (n: string) => [...p.graph.symbols.values()].find((s) => s.name === n)?.role;
  assert.equal(roles('ProductController'), 'controller');
  assert.equal(roles('ProductServiceImpl'), 'service');
  assert.equal(roles('ProductRepository'), 'repository');
});

test('fastapi: router prefix from settings object, SQLModel tables', async () => {
  const p = await open('fastapi-mini');
  assert.deepEqual(routes(p).sort(), ['GET /api/v1/users/{user_id} -> get_user', 'POST /api/v1/users -> create_user']);
  const flow = reach(p.flow('http-route:POST /api/v1/users', { depth: 5 }));
  assert.ok(flow.includes('UserService.register'), flow.join(' > '));
  const user = p.tables.find((t) => t.name === 'user')!;
  assert.ok(user.columns.some((c) => c.name === 'email' && c.unique), 'inherited SQLModel column');
  assert.ok(user.columns.some((c) => c.name === 'id' && c.pk));
});

test('go/gin: route groups, handler methods via struct fields, SQL in strings', async () => {
  const p = await open('go-gin-mini');
  assert.deepEqual(routes(p).sort(), ['GET /v1/items/:id -> ItemHandler.Get', 'POST /v1/items -> ItemHandler.Create']);
  const flow = reach(p.flow('http-route:POST /v1/items', { depth: 5 }));
  assert.ok(flow.includes('ItemStore.Insert'), flow.join(' > '));
  assert.ok(flow.includes('items'));
});

test('nestjs: controller decorators, guards, injected services, TypeORM entities', async () => {
  const p = await open('nest-mini');
  const e = p.entries.find((x) => x.path === '/orders/:id')!;
  assert.equal(e.handlerName, 'OrdersController.findOne');
  assert.deepEqual(e.middleware?.map((m) => m.name), ['AuthGuard.canActivate']);
  const flow = reach(p.flow(e.id, { depth: 5 }));
  assert.ok(flow.includes('OrdersService.findOne'), flow.join(' > '));
  assert.ok(flow.includes('orders'));
  const t = p.tables.find((x) => x.name === 'orders')!;
  assert.ok(t.columns.some((c) => c.name === 'customerEmail' && c.indexed));
});

test('django: include() prefixes, function and class-based views, models', async () => {
  const p = await open('django-mini');
  assert.deepEqual(routes(p).sort(), ['ANY /orders -> order_list', 'ANY /orders/:pk -> OrderDetailView']);
  const flow = reach(p.flow('http-route:ANY /orders/:pk', { depth: 5 }));
  assert.ok(flow.includes('OrderDetailView.get'), flow.join(' > '));
  assert.ok(flow.includes('orders_order'));
  const order = p.tables.find((t) => t.name === 'orders_order')!;
  assert.ok(order.columns.some((c) => c.name === 'customer_id' && c.fk?.table === 'orders_customer'));
});

test('c++ ipc: processes, shared memory and socket channels, type aliases', async () => {
  const p = await open('cpp-ipc');
  assert.equal(p.summary.profile.kinds[0].kind, 'low-latency');
  const procs = p.entries.filter((e) => e.kind === 'process').map((e) => e.label).sort();
  assert.deepEqual(procs, ['feed', 'strategy']);
  const chans = p.entries.filter((e) => e.kind === 'channel').map((e) => e.label).sort();
  assert.deepEqual(chans, ['/md_ticks', 'ipc:///tmp/orders.sock']);
  const strat = reach(p.flow('process: strategy', { depth: 6 }));
  for (const expected of ['RingBuffer.pop', 'MeanReversionStrategy.onTick', 'OrderGateway.sendOrder', 'ipc:///tmp/orders.sock', '/md_ticks']) assert.ok(strat.includes(expected), `${expected} missing from ${strat.join(' > ')}`);
  const feed = reach(p.flow('process: feed', { depth: 6 }));
  assert.ok(feed.includes('RingBuffer.push'), feed.join(' > '));
});

test('search finds routes, symbols and tables', async () => {
  const p = await open('spring-mini');
  const hits = p.search('restock');
  assert.ok(hits.some((h) => h.type === 'entry'));
  assert.ok(hits.some((h) => h.type === 'symbol' && h.label === 'ProductServiceImpl.restock'));
  assert.ok(p.search('products').some((h) => h.type === 'table'));
});

test('file view links calls to their targets', async () => {
  const p = await open('express-mini');
  const view = await p.file('src/services/orderService.js');
  const link = view.links.find((l) => l.targets.some((t) => t.name === 'notifyWarehouse'));
  assert.ok(link, 'call to notifyWarehouse should be a clickable link');
  assert.equal(link!.range.sl, 9);
});

test('vue: router config, lazy .vue views, script setup callbacks', async () => {
  const p = await open('vue-mini');
  const pages = p.entries.filter((e) => e.kind === 'page').map((e) => `${e.path} -> ${e.handlerName}`).sort();
  assert.deepEqual(pages, ['/ -> Home', '/users -> Users.vue', '/users/:id -> UserDetail.vue']);
  const flow = reach(p.flow('page: /users', { depth: 5 }));
  assert.ok(flow.includes('fetchUsers'), flow.join(' > '));
  assert.ok(flow.some((l) => l.includes('/api/users')));
  assert.equal([...p.graph.symbols.values()].find((s) => s.name === 'fetchUsers')?.role, 'client');
});

test('angular: route arrays, nested loadComponent, component lifecycle', async () => {
  const p = await open('angular-mini');
  const pages = p.entries.filter((e) => e.kind === 'page').map((e) => `${e.path} -> ${e.handlerName}`).sort();
  assert.deepEqual(pages, ['/orders/:id -> OrderDetailComponent', '/users -> UsersComponent']);
  const flow = reach(p.flow('page: /users', { depth: 5 }));
  assert.ok(flow.includes('UserService.load'), flow.join(' > '));
});

test('tanstack router: createFileRoute', async () => {
  const p = await open('tanstack-mini');
  const e = p.entries.find((x) => x.kind === 'page')!;
  assert.equal(e.path, '/posts/:postId');
  assert.equal(e.handlerName, 'PostPage');
  // `_auth` is a pathless layout: it groups routes without adding to the URL.
  assert.ok(p.entries.some((x) => x.kind === 'page' && x.path === '/settings' && x.handlerName === 'Settings'), p.entries.map((x) => x.path).join(', '));
});

test('full stack: frontend HTTP calls link to backend routes', async () => {
  const p = await open('fullstack-mini');
  const callers = (path: string, method: string) => p.entries.find((e) => e.kind === 'http-route' && e.path === path && e.method === method)?.clientCallers?.map((c) => `${c.name} ${c.confidence}`).sort() ?? [];
  // axios instance with baseURL, fetch with a constant + concatenation
  assert.deepEqual(callers('/api/users', 'GET'), ['getUsers certain']);
  assert.deepEqual(callers('/api/users', 'POST'), ['createUser certain']);
  // template literal param, Angular HttpClient with environment.apiUrl (absolute localhost URL), concatenation
  assert.deepEqual(callers('/api/users/:id', 'GET'), ['InvoiceService.userDetail certain', 'fetchUser likely', 'getUser certain']);
  // hey-api generated SDK and Angular service
  assert.deepEqual(callers('/api/invoices', 'GET'), ['InvoiceService.list certain', 'InvoicesService.listInvoices certain']);
  // project wrappers recognized by shape; the base URL they add is unknown, so these are "likely"
  assert.deepEqual(callers('/api/users/:id', 'DELETE'), ['deleteUser likely', 'removeUser likely']);
  // a wrapper around someone else's API must not link, even when one of its paths looks like ours
  assert.ok(!p.entries.some((e) => e.clientCallers?.some((c) => c.name === 'stripeUser')));
  assert.ok([...p.sinks.nodes.values()].some((n) => n.label === 'api.weather.example.com'), 'real external APIs stay external');

  // One flow from the page all the way to the table: page > component > handler > API function > route > handler > table
  const page = p.entries.find((e) => e.kind === 'page' && e.path === '/users')!;
  const flow = reach(p.flow(page.id, { depth: 10 }));
  for (const expected of ['Users', 'onAdd', 'createUser', 'POST /api/users', 'insertUser', 'users', 'UserRow', 'onDelete', 'DELETE /api/users/:id', 'getUsers', 'GET /api/users']) assert.ok(flow.includes(expected), `${expected} missing from ${flow.join(' > ')}`);
  // Purely visual components are left out of flows unless asked for
  assert.ok(!flow.includes('Badge'));
  assert.ok(reach(p.flow(page.id, { depth: 10, showTrivial: true })).includes('Badge'));

  const detail = p.symbol([...p.graph.symbols.values()].find((s) => s.name === 'createUser')!.id)!;
  assert.deepEqual(detail.routeCalls.map((r) => r.label), ['POST /api/users']);
  assert.equal(p.summary.stats.linkedHttpCalls, 9);
});

test('sveltekit: +page/+server files, load runs first, template events and components', async () => {
  const p = await open('sveltekit-mini');
  const labels = p.entries.map((e) => `${e.kind} ${e.label}`).sort();
  assert.deepEqual(labels, ['http-route GET /api/posts', 'http-route POST /api/posts', 'page /blog/:slug', 'page /settings']);
  const blog = p.entries.find((e) => e.path === '/blog/:slug')!;
  assert.deepEqual(blog.middleware?.map((m) => m.name), ['load (+page.server.ts)']);
  const flow = reach(p.flow(blog.id, { depth: 8 }));
  // onclick={like} in the template, <Comments /> rendered, its on:click handler fetching our own endpoint
  for (const expected of ['load', '+page.svelte', 'like', 'Comments', 'GET /api/posts', 'posts']) assert.ok(flow.includes(expected), `${expected} missing from ${flow.join(' > ')}`);
  const post = reach(p.flow('http-route:POST /api/posts', { depth: 6 }));
  assert.ok(post.includes('savePost') && post.includes('posts'), post.join(' > '));
});

test('nuxt: pages/, server/api with method suffixes, useFetch and $fetch', async () => {
  const p = await open('nuxt-mini');
  const labels = p.entries.map((e) => `${e.kind} ${e.label}`).sort();
  assert.deepEqual(labels, ['http-route DELETE /api/users/:id', 'http-route GET /api/users/:id', 'page /', 'page /users/:id']);
  const flow = reach(p.flow('page: /users/:id', { depth: 6 }));
  for (const expected of ['GET /api/users/:id', 'remove', 'DELETE /api/users/:id']) assert.ok(flow.includes(expected), `${expected} missing from ${flow.join(' > ')}`);
  assert.ok(!flow.includes('UserCard'), 'purely visual components stay out of the flow');
});

test('remix: flat routes, loaders run first, actions and resource routes', async () => {
  const p = await open('remix-mini');
  const labels = p.entries.map((e) => `${e.kind} ${e.label}`).sort();
  assert.deepEqual(labels, ['http-route GET /api/health', 'http-route POST /notes/:noteId', 'page /', 'page /login', 'page /notes/:noteId']);
  const note = p.entries.find((e) => e.kind === 'page' && e.path === '/notes/:noteId')!;
  assert.equal(note.handlerName, 'NotePage');
  const flow = reach(p.flow(note.id, { depth: 4 }));
  for (const expected of ['loader', 'getNote', 'notes', 'NotePage']) assert.ok(flow.includes(expected), `${expected} missing from ${flow.join(' > ')}`);
  assert.ok(reach(p.flow('http-route:POST /notes/:noteId', { depth: 4 })).includes('deleteNote'));
});

test('importance: key routes, families of look-alike routes, gists that tell them apart', async () => {
  const p = await open('ai-app');
  const ins = (path: string) => p.entries.find((e) => e.path === path)!.insight!;
  const chat = ins('/chat/{conversation_id}/messages');
  assert.equal(chat.tier, 'key');
  assert.ok(chat.traits.includes('ai') && chat.traits.includes('stream'), chat.reasons.join('; '));
  assert.equal(ins('/auth/login').tier, 'key');
  assert.ok(ins('/auth/login').traits.includes('auth'));

  const fams = p.summary.families.map((f) => `${f.label} (${f.members.length})`).sort();
  assert.deepEqual(fams, ['/integrations/* via app/integrations/* (5)', '/tools/* via run_tool (8)']);
  // Members stay recognizable: the gist says what each one adds, not what they all share
  const weather = ins('/tools/get-weather');
  assert.equal(weather.tier, 'routine');
  assert.equal(weather.gist, '"get_weather"');
  assert.ok(ins('/integrations/slack/sync').gist!.includes('sync_slack'));
  assert.ok(ins('/integrations/slack/sync').gist!.includes('slack_items'));
  // Key routes outrank routine ones; the tool runner is the family's code, not the app's backbone
  assert.ok(chat.score > weather.score);
  assert.ok(!p.summary.backbone.some((b) => b.name === 'run_tool'));
});

test('settings: excludes, role corrections, pinned entry points, project kind', async () => {
  const p = await Project.open(fixture('express-mini'), undefined, {
    settings: {
      exclude: ['src/db.js'],
      roleOverrides: [{ match: 'listOrders', role: 'repository' }],
      entryPoints: [{ symbol: 'notifyWarehouse' }],
      projectKind: 'library',
    },
  });
  assert.ok(!p.files.some((f) => f.path === 'src/db.js'), 'excluded file must not be analyzed');
  const sym = [...p.graph.symbols.values()].find((s) => s.name === 'listOrders')!;
  assert.equal(sym.role, 'repository');
  assert.match(sym.roleReason ?? '', /set by you/);
  const pinned = p.entries.find((e) => e.kind === 'custom');
  assert.equal(pinned?.handlerName, 'notifyWarehouse');
  assert.ok(reach(p.flow(pinned!.id, { depth: 3 })).includes('warehouse.example.com'));
  assert.equal(p.summary.profile.kinds[0].kind, 'library');
});

test('re-indexing reuses parse results for unchanged files', async () => {
  const cache = new Map();
  const a = await Project.open(fixture('spring-mini'), undefined, { cache });
  const before = a.graph.facts.get('src/main/java/com/acme/shop/web/ProductController.java');
  const b = await Project.open(fixture('spring-mini'), undefined, { cache });
  assert.equal(b.graph.facts.get('src/main/java/com/acme/shop/web/ProductController.java'), before, 'unchanged file should not be re-parsed');
  assert.deepEqual(routes(b).sort(), routes(a).sort());
});
