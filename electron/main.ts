import { app, BrowserWindow, dialog, ipcMain, shell, nativeTheme } from 'electron';
import { Worker } from 'node:worker_threads';
import path from 'node:path';
import fs from 'node:fs/promises';
import { statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { RecentProject } from '../src/shared/api';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
let win: BrowserWindow | null = null;
let worker: Worker | null = null;
let nextId = 1;
const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
let currentRoot: string | null = null;

/** `understandably-based ./some/repo` opens that folder straight away. */
function folderFromArgs(argv: string[]): string | null {
  for (const a of argv.slice(app.isPackaged ? 1 : 2)) {
    if (a.startsWith('-')) continue;
    try {
      const abs = path.resolve(a);
      if (statSync(abs).isDirectory() && abs !== process.cwd() + path.sep + 'out') return abs;
    } catch {
      /* not a path */
    }
  }
  return null;
}
let initialFolder: string | null = folderFromArgs(process.argv);

if (app.isPackaged) process.env.UB_WASM_DIR = path.join(process.resourcesPath, 'wasm');
// The worker inherits this and stores per-project settings there.
process.env.UB_SETTINGS_FILE = path.join(app.getPath('userData'), 'project-settings.json');

function startWorker() {
  // In packaged builds the worker and its native-ish deps (WASM parsers) are unpacked next to the asar.
  const workerPath = path.join(__dirname, 'worker.js').replace(`app.asar${path.sep}`, `app.asar.unpacked${path.sep}`);
  worker = new Worker(workerPath);
  worker.on('message', (msg: any) => {
    if (msg.type === 'progress') {
      win?.webContents.send('ub:progress', msg.progress);
      return;
    }
    if (msg.type === 'event') {
      win?.webContents.send('ub:event', msg.event);
      return;
    }
    const p = pending.get(msg.id);
    if (!p) return;
    pending.delete(msg.id);
    if (msg.type === 'error') p.reject(new Error(msg.error));
    else p.resolve(msg.result);
  });
  worker.on('error', (e) => {
    for (const p of pending.values()) p.reject(e as Error);
    pending.clear();
  });
  worker.on('exit', () => {
    worker = null;
  });
}

function call(method: string, params: unknown): Promise<unknown> {
  if (!worker) startWorker();
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    worker!.postMessage({ id, method, params });
  });
}

const recentFile = () => path.join(app.getPath('userData'), 'recent-projects.json');
async function readRecent(): Promise<RecentProject[]> {
  try {
    return JSON.parse(await fs.readFile(recentFile(), 'utf8'));
  } catch {
    return [];
  }
}
async function writeRecent(list: RecentProject[]) {
  await fs.mkdir(path.dirname(recentFile()), { recursive: true });
  await fs.writeFile(recentFile(), JSON.stringify(list.slice(0, 12), null, 2));
}

function createWindow() {
  win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 960,
    minHeight: 600,
    title: 'UnderstandablyBased',
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#0f1115' : '#f7f7f8',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  if (process.env.ELECTRON_RENDERER_URL) win.loadURL(process.env.ELECTRON_RENDERER_URL);
  else win.loadFile(path.join(__dirname, '../renderer/index.html'));

  // Developer aid: UB_SCREENSHOT=out.png captures the window after UB_SCREENSHOT_DELAY ms (used for automated checks).
  if (process.env.UB_SCREENSHOT) {
    const target = process.env.UB_SCREENSHOT;
    win.webContents.once('did-finish-load', () => {
      setTimeout(async () => {
        const img = await win!.webContents.capturePage();
        await fs.writeFile(target, img.toPNG());
        if (process.env.UB_EXIT) app.quit();
      }, Number(process.env.UB_SCREENSHOT_DELAY ?? 6000));
    });
  }
}

ipcMain.handle('ub:initialFolder', () => {
  const f = initialFolder;
  initialFolder = null;
  return f;
});

ipcMain.handle('ub:pickFolder', async () => {
  const r = await dialog.showOpenDialog(win!, { properties: ['openDirectory'], title: 'Choose a codebase folder' });
  return r.canceled ? null : r.filePaths[0];
});

ipcMain.handle('ub:call', async (_e, method: string, params: any) => {
  const result = await call(method, params);
  if (method === 'open') {
    const summary = result as { root: string; name: string; profile: { kinds: { label: string }[] }; stats: { files: number } };
    currentRoot = summary.root;
    const list = (await readRecent()).filter((r) => r.root !== summary.root);
    list.unshift({ root: summary.root, name: summary.name, openedAt: Date.now(), summary: `${summary.profile.kinds[0]?.label ?? 'Code'} · ${summary.stats.files} files` });
    await writeRecent(list);
    win?.setTitle(`${summary.name} — UnderstandablyBased`);
  }
  return result;
});

ipcMain.handle('ub:recent', async () => {
  const list = await readRecent();
  const alive: RecentProject[] = [];
  for (const r of list) {
    try {
      await fs.access(r.root);
      alive.push(r);
    } catch {
      /* folder was moved or deleted */
    }
  }
  return alive;
});

ipcMain.handle('ub:forgetRecent', async (_e, root: string) => {
  await writeRecent((await readRecent()).filter((r) => r.root !== root));
});

ipcMain.handle('ub:openInEditor', async (_e, file: string, line?: number) => {
  if (!currentRoot) return;
  const abs = path.resolve(currentRoot, file);
  if (!abs.startsWith(currentRoot)) return;
  // VS Code's URL handler is the most widely installed; fall back to the OS default app.
  try {
    await shell.openExternal(`vscode://file/${abs}${line ? `:${line}` : ''}`);
  } catch {
    await shell.openPath(abs);
  }
});

ipcMain.handle('ub:reveal', async (_e, file: string) => {
  if (!currentRoot) return;
  const abs = path.resolve(currentRoot, file);
  if (abs.startsWith(currentRoot)) shell.showItemInFolder(abs);
});

app.whenReady().then(() => {
  startWorker();
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  worker?.terminate();
  if (process.platform !== 'darwin') app.quit();
});
