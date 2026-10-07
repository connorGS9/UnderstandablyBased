// Generates a large synthetic web app for stress-testing the diagrams and the route list:
// ~180 SQL tables in realistic foreign-key clusters (one hub table many others point at) and a few hundred routes.
// Usage: npm run gen:large  →  test/.generated/large-app (git-ignored). Open that folder in the app.
import fs from 'node:fs';
import path from 'node:path';

const out = path.resolve(import.meta.dirname, '..', 'test', '.generated', 'large-app');
fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(path.join(out, 'src', 'routes'), { recursive: true });

// Deterministic pseudo-random numbers so every run produces the same app.
let seed = 42;
const rand = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
const pick = <T,>(xs: T[]) => xs[Math.floor(rand() * xs.length)];

const domains = ['billing', 'catalog', 'orders', 'shipping', 'support', 'analytics', 'auth', 'content', 'inventory', 'marketing', 'hr', 'payments'];
const nouns = ['item', 'record', 'event', 'log', 'note', 'tag', 'setting', 'rule', 'batch', 'entry', 'link', 'version', 'snapshot', 'audit', 'queue'];
const tables: { name: string; domain: string; fks: string[] }[] = [{ name: 'users', domain: 'core', fks: [] }, { name: 'organizations', domain: 'core', fks: [] }, { name: 'accounts', domain: 'core', fks: ['organizations'] }];
for (const d of domains) {
  const root = `${d}_root`;
  tables.push({ name: root, domain: d, fks: ['organizations'] });
  for (let i = 0; i < 14; i++) {
    const name = `${d}_${nouns[i]}s`;
    const local = tables.filter((t) => t.domain === d).map((t) => t.name);
    const fks = new Set<string>([pick(local)]);
    if (rand() < 0.75) fks.add('users');
    if (rand() < 0.3) fks.add('accounts');
    if (rand() < 0.15) fks.add(pick(tables).name);
    tables.push({ name, domain: d, fks: [...fks] });
  }
}
let sql = '';
for (const t of tables) {
  const cols = ['  id SERIAL PRIMARY KEY', ...t.fks.map((f) => `  ${f.replace(/s$/, '')}_id INT REFERENCES ${f}(id)`), '  name TEXT', '  created_at TIMESTAMP'];
  sql += `CREATE TABLE ${t.name} (\n${cols.join(',\n')}\n);\n`;
  if (t.fks.length) sql += `CREATE INDEX idx_${t.name}_${t.fks[0].replace(/s$/, '')} ON ${t.name} (${t.fks[0].replace(/s$/, '')}_id);\n`;
}
fs.writeFileSync(path.join(out, 'schema.sql'), sql);

// Routes: CRUD per table, mounted per domain, plus a family of thin "tool" routes.
fs.writeFileSync(path.join(out, 'package.json'), JSON.stringify({ name: 'large-app', main: 'src/app.js', dependencies: { express: '^4.19.0', pg: '^8.0.0' } }, null, 2));
fs.writeFileSync(path.join(out, 'src', 'db.js'), "const { Pool } = require('pg');\nconst pool = new Pool();\nmodule.exports = { query: (text, params) => pool.query(text, params) };\n");
let app = "const express = require('express');\nconst app = express();\napp.use(express.json());\n";
for (const d of ['core', ...domains]) {
  const own = tables.filter((t) => t.domain === d);
  let r = "const express = require('express');\nconst db = require('../db');\nconst router = express.Router();\n\n";
  for (const t of own) {
    const seg = t.name.replace(`${d}_`, '');
    r += `router.get('/${seg}', async (req, res) => res.json((await db.query('SELECT * FROM ${t.name}')).rows));\n`;
    r += `router.get('/${seg}/:id', async (req, res) => res.json((await db.query('SELECT * FROM ${t.name} WHERE id = $1', [req.params.id])).rows[0]));\n`;
    r += `router.post('/${seg}', async (req, res) => res.json(await db.query('INSERT INTO ${t.name} (name) VALUES ($1)', [req.body.name])));\n`;
    if (rand() < 0.5) r += `router.delete('/${seg}/:id', async (req, res) => res.json(await db.query('DELETE FROM ${t.name} WHERE id = $1', [req.params.id])));\n`;
  }
  r += '\nmodule.exports = router;\n';
  fs.writeFileSync(path.join(out, 'src', 'routes', `${d}.js`), r);
  app += `app.use('/api/${d}', require('./routes/${d}'));\n`;
}
let tools = "const express = require('express');\nconst { runTool } = require('../tools');\nconst router = express.Router();\n\n";
for (let i = 0; i < 40; i++) tools += `router.post('/tool-${i}', (req, res) => runTool('tool_${i}', req.body, res));\n`;
fs.writeFileSync(path.join(out, 'src', 'routes', 'tools.js'), tools + '\nmodule.exports = router;\n');
fs.writeFileSync(
  path.join(out, 'src', 'tools.js'),
  "const db = require('./db');\nasync function runTool(name, args, res) {\n  await db.query('INSERT INTO analytics_events (name) VALUES ($1)', [name]);\n  res.json(await fetch(`http://tools/run/${name}`, { method: 'POST', body: JSON.stringify(args) }));\n}\nmodule.exports = { runTool };\n",
);
app += "app.use('/api/tools', require('./routes/tools'));\napp.listen(3000);\n";
fs.writeFileSync(path.join(out, 'src', 'app.js'), app);
console.log(`${tables.length} tables and ${(app.match(/app.use\('\/api/g) ?? []).length} routers written to ${out}`);
