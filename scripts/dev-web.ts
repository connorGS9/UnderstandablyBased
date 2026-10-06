// Runs the UI in a normal browser against the same engine, for fast UI iteration without Electron.
// Usage: npm run dev:web  (then open http://localhost:5317)
import { createServer, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';
import fs from 'node:fs/promises';
import os from 'node:os';
import { handle } from '../electron/engine-host';
import type { Progress } from '../src/engine/types';
import type { RecentProject } from '../src/shared/api';

const root = path.resolve(import.meta.dirname, '..');
const recentPath = path.join(os.tmpdir(), 'understandably-based-recent.json');
const listeners = new Set<(p: Progress) => void>();

async function readBody(req: import('node:http').IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const text = Buffer.concat(chunks).toString('utf8');
  return text ? JSON.parse(text) : {};
}

const apiPlugin: Plugin = {
  name: 'ub-api',
  configureServer(server) {
    server.middlewares.use(async (req, res, next) => {
      if (!req.url?.startsWith('/api/')) return next();
      const route = req.url.slice(5).split('?')[0];
      try {
        if (route === 'progress') {
          res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
          const fn = (p: Progress) => res.write(`data: ${JSON.stringify(p)}\n\n`);
          listeners.add(fn);
          req.on('close', () => listeners.delete(fn));
          return;
        }
        const body = await readBody(req);
        let result: unknown;
        if (route === 'recent') {
          result = JSON.parse(await fs.readFile(recentPath, 'utf8').catch(() => '[]'));
        } else if (route === 'forgetRecent') {
          const list: RecentProject[] = JSON.parse(await fs.readFile(recentPath, 'utf8').catch(() => '[]'));
          await fs.writeFile(recentPath, JSON.stringify(list.filter((r) => r.root !== body.root)));
        } else {
          result = await handle(route as any, body, (p) => listeners.forEach((l) => l(p)));
          if (route === 'open') {
            const s = result as any;
            const list: RecentProject[] = JSON.parse(await fs.readFile(recentPath, 'utf8').catch(() => '[]')).filter((r: RecentProject) => r.root !== s.root);
            list.unshift({ root: s.root, name: s.name, openedAt: Date.now(), summary: `${s.profile.kinds[0]?.label ?? 'Code'} · ${s.stats.files} files` });
            await fs.writeFile(recentPath, JSON.stringify(list.slice(0, 12)));
          }
        }
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify(result ?? null));
      } catch (e) {
        res.statusCode = 500;
        res.end(JSON.stringify({ error: (e as Error).message }));
      }
    });
  },
};

const server = await createServer({
  root: path.join(root, 'src/renderer'),
  plugins: [react(), apiPlugin],
  server: { port: Number(process.env.PORT ?? 5317), strictPort: true },
});
await server.listen();
server.printUrls();
