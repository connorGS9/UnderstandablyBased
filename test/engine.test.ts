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
