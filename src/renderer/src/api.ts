import type { FlowOptions, HostEvent, RecentProject, UBApi } from '../../shared/api';
import type { Progress } from '../../engine/types';

interface Bridge {
  platform: 'electron';
  pickFolder(): Promise<string | null>;
  call(method: string, params: unknown): Promise<any>;
  recent(): Promise<RecentProject[]>;
  forgetRecent(root: string): Promise<void>;
  openInEditor(file: string, line?: number): Promise<void>;
  reveal(file: string): Promise<void>;
  onProgress(cb: (p: Progress) => void): () => void;
  pathForFile(file: File): string;
  initialFolder(): Promise<string | null>;
  onEvent(cb: (e: HostEvent) => void): () => void;
}

function electronApi(b: Bridge): UBApi {
  return {
    platform: 'electron',
    pickFolder: () => b.pickFolder(),
    open: (root) => b.call('open', { root }),
    reindex: () => b.call('reindex', {}),
    saveSettings: (settings) => b.call('saveSettings', { settings }),
    onEvent: (cb) => b.onEvent(cb),
    flow: (rootId, opts?: FlowOptions) => b.call('flow', { rootId, opts }),
    symbol: (id) => b.call('symbol', { id }),
    file: (path) => b.call('file', { path }),
    search: (q) => b.call('search', { q }),
    diagrams: () => b.call('diagrams', {}),
    recent: () => b.recent(),
    forgetRecent: (root) => b.forgetRecent(root),
    openInEditor: (file, line) => b.openInEditor(file, line),
    reveal: (file) => b.reveal(file),
    onProgress: (cb) => b.onProgress(cb),
    pathForFile: (f) => b.pathForFile(f),
    initialFolder: () => b.initialFolder(),
  };
}

async function post(route: string, body: unknown = {}): Promise<any> {
  const r = await fetch(`/api/${route}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const data = await r.json();
  if (!r.ok) throw new Error(data?.error ?? `Request failed (${r.status})`);
  return data;
}

function webApi(): UBApi {
  return {
    platform: 'web',
    pickFolder: async () => null,
    open: (root) => post('open', { root }),
    reindex: () => post('reindex'),
    saveSettings: (settings) => post('saveSettings', { settings }),
    onEvent: (cb) => {
      const es = new EventSource('/api/events');
      es.onmessage = (e) => cb(JSON.parse(e.data));
      return () => es.close();
    },
    flow: (rootId, opts) => post('flow', { rootId, opts }),
    symbol: (id) => post('symbol', { id }),
    file: (path) => post('file', { path }),
    search: (q) => post('search', { q }),
    diagrams: () => post('diagrams'),
    recent: () => post('recent'),
    forgetRecent: (root) => post('forgetRecent', { root }),
    openInEditor: async () => {},
    reveal: async () => {},
    initialFolder: async () => {
      const f = new URLSearchParams(location.search).get('open');
      if (f) history.replaceState(null, '', location.pathname);
      return f;
    },
    onProgress: (cb) => {
      const es = new EventSource('/api/progress');
      es.onmessage = (e) => cb(JSON.parse(e.data));
      return () => es.close();
    },
  };
}

const bridge = (window as unknown as { ub?: Bridge }).ub;
export const api: UBApi = bridge ? electronApi(bridge) : webApi();
