// Dev harness: index a folder and print what the engine found.
// Usage: npx tsx scripts/inspect.ts <folder> [--flow <entryId|symbolId>] [--json]
import { Project } from '../src/engine/project';

const args = process.argv.slice(2);
const root = args[0];
if (!root) {
  console.error('usage: tsx scripts/inspect.ts <folder> [--flow id]');
  process.exit(1);
}
const flowIdx = args.indexOf('--flow');
const p = await Project.open(root);
const s = p.summary;
console.log(`\n== ${s.name}: ${s.stats.files} files, ${s.stats.lines} lines, ${s.stats.symbols} symbols, calls ${s.stats.resolvedCalls}/${s.stats.calls} resolved (${Math.round((100 * s.stats.resolvedCalls) / Math.max(1, s.stats.calls))}%) in ${s.durationMs}ms`);
console.log('kinds:', s.profile.kinds.map((k) => `${k.label} (${k.score})`).join(' | '));
console.log('frameworks:', s.profile.frameworks.map((f) => f.name).join(', '));
console.log('languages:', s.profile.languages.map((l) => `${l.lang} ${l.files}f/${l.lines}l`).join(', '));
if (s.warnings.length) console.log('warnings:', s.warnings.slice(0, 5));
const byKind = new Map<string, number>();
for (const e of s.entries) byKind.set(e.kind, (byKind.get(e.kind) ?? 0) + 1);
console.log('entries:', [...byKind].map(([k, n]) => `${k}=${n}`).join(' '));
for (const e of s.entries.slice(0, Number(process.env.N ?? 40))) {
  console.log(`  [${e.kind}] ${e.label.padEnd(45)} -> ${e.handlerName ?? (e.kind === 'channel' ? 'channel' : '?')}${e.handlerId ? '' : ' (UNRESOLVED)'}  {${e.framework}} ${e.middleware?.length ? 'mw=' + e.middleware.map((m) => m.name).join(',') : ''}`);
}
console.log('tables:', p.tables.map((t) => `${t.name}(${t.columns.length}c,${t.indexes.length}i,${t.source.kind})`).join(' '));
const sinkKinds = new Map<string, number>();
for (const n of p.sinks.nodes.values()) sinkKinds.set(n.kind, (sinkKinds.get(n.kind) ?? 0) + 1);
console.log('sinks:', [...sinkKinds].map(([k, n]) => `${k}=${n}`).join(' '), [...p.sinks.nodes.values()].filter((n) => n.kind !== 'table').slice(0, 10).map((n) => n.label).join(', '));
const roles = new Map<string, number>();
for (const sym of p.graph.symbols.values()) roles.set(sym.role ?? '?', (roles.get(sym.role ?? '?') ?? 0) + 1);
console.log('roles:', [...roles].map(([k, n]) => `${k}=${n}`).join(' '));
const flowId = flowIdx >= 0 ? args[flowIdx + 1] : s.entries.find((e) => e.kind === 'http-route' && e.handlerId)?.id ?? s.entries[0]?.id;
if (flowId) {
  const f = p.flow(flowId, { depth: 4 });
  console.log(`\nflow ${flowId}: ${f.nodes.length} nodes`);
  const byId = new Map(f.nodes.map((n) => [n.id, n]));
  const kids = new Map<string, typeof f.edges>();
  for (const e of f.edges) kids.set(e.from, [...(kids.get(e.from) ?? []), e]);
  const seen = new Set<string>();
  const pr = (id: string, d: number) => {
    const n = byId.get(id)!;
    console.log(`${'  '.repeat(d)}- ${n.label} [${n.role}]${n.hiddenChildren ? ` (+${n.hiddenChildren})` : ''}`);
    if (seen.has(id) || d > 8) return;
    seen.add(id);
    for (const e of kids.get(id) ?? []) {
      process.stdout.write(`${'  '.repeat(d + 1)}${e.confidence !== 'certain' ? '(' + e.confidence + ') ' : ''}`);
      pr(e.to, d + 1);
    }
  };
  if (byId.has(f.rootId)) pr(f.rootId, 0);
}
const d = p.getDiagrams();
console.log(`\ndiagrams: dataflow ${d.dataflow.nodes.length}n/${d.dataflow.edges.length}e (${d.dataflow.mode}), modules ${d.modules.nodes.length}n/${d.modules.edges.length}e, db ${d.database.tables.length} tables`);
