// Runs engine requests against the currently open project. Shared by the Electron worker and the web dev server.
// Also owns per-project settings, the parse cache used for fast re-indexing, and the file watcher.
import fs from 'node:fs';
import path from 'node:path';
import { Project } from '../src/engine/project';
import { SKIPPED_DIRS } from '../src/engine/scan';
import { langForFile } from '../src/engine/parser';
import { DEFAULT_SETTINGS, type FileFacts, type ProjectSettings, type Progress } from '../src/engine/types';
import type { EngineMethod, HostEvent } from '../src/shared/api';

let project: Project | null = null;
let opening: Promise<Project> | null = null;
let root: string | null = null;
let cache = new Map<string, { mtime: number; size: number; lines: number; facts?: FileFacts }>();
let watcher: fs.FSWatcher | null = null;
let refreshTimer: NodeJS.Timeout | null = null;
let emit: (e: HostEvent) => void = () => {};

/** Called once by the hosting process to receive background events (auto-refresh). */
export function onHostEvent(fn: (e: HostEvent) => void) {
  emit = fn;
}

// ---------------- settings ----------------

const REPO_SETTINGS = 'understandably.json';
const settingsFile = () => process.env.UB_SETTINGS_FILE ?? path.join(process.cwd(), '.understandably-settings.json');

function readAll(): Record<string, Partial<ProjectSettings>> {
  try {
    return JSON.parse(fs.readFileSync(settingsFile(), 'utf8'));
  } catch {
    return {};
  }
}

/** Team settings committed to the repo, overridden by this user's own settings. */
function loadSettings(dir: string): { settings: ProjectSettings; repoFile?: string } {
  let repo: Partial<ProjectSettings> = {};
  let repoFile: string | undefined;
  try {
    repo = JSON.parse(fs.readFileSync(path.join(dir, REPO_SETTINGS), 'utf8'));
    repoFile = REPO_SETTINGS;
  } catch {
    /* no repo settings */
  }
  return { settings: { ...DEFAULT_SETTINGS, ...repo, ...(readAll()[dir] ?? {}) }, repoFile };
}

function saveSettings(dir: string, s: ProjectSettings) {
  const all = readAll();
  all[dir] = s;
  fs.mkdirSync(path.dirname(settingsFile()), { recursive: true });
  fs.writeFileSync(settingsFile(), JSON.stringify(all, null, 2));
}

// ---------------- indexing ----------------

async function index(dir: string, onProgress: (p: Progress) => void): Promise<Project> {
  const { settings, repoFile } = loadSettings(dir);
  opening = Project.open(dir, onProgress, { settings, cache, repoSettingsFile: repoFile });
  try {
    project = await opening;
  } finally {
    opening = null;
  }
  return project;
}

function watch(dir: string) {
  watcher?.close();
  watcher = null;
  try {
    watcher = fs.watch(dir, { recursive: true }, (_event, file) => {
      if (!file || !project?.settings.autoRefresh) return;
      const rel = file.toString().split(path.sep).join('/');
      if (rel.split('/').some((seg) => SKIPPED_DIRS.has(seg) || (seg.startsWith('.') && seg !== '.github'))) return;
      const base = rel.split('/').pop()!;
      if (!langForFile(base) && !/\.(sql|prisma)$|^(package\.json|pom\.xml|build\.gradle(\.kts)?|go\.mod|Cargo\.toml|tsconfig\.json|understandably\.json)$/.test(base)) return;
      scheduleRefresh();
    });
    watcher.on('error', () => {
      watcher?.close();
      watcher = null;
    });
  } catch {
    // Recursive watching is unavailable on some platforms/filesystems; manual re-index still works.
  }
}

function scheduleRefresh() {
  if (refreshTimer) clearTimeout(refreshTimer);
  refreshTimer = setTimeout(async () => {
    refreshTimer = null;
    if (!root || opening) return scheduleRefresh();
    emit({ type: 'updating' });
    try {
      const p = await index(root, () => {});
      emit({ type: 'updated', summary: p.summary });
    } catch (e) {
      emit({ type: 'update-failed', error: (e as Error).message });
    }
  }, 1200);
}

export async function handle(method: EngineMethod, params: any, onProgress: (p: Progress) => void): Promise<unknown> {
  if (method === 'open') {
    const dir = path.resolve(params.root);
    if (dir !== root) cache = new Map();
    root = dir;
    const p = await index(dir, onProgress);
    watch(dir);
    return p.summary;
  }
  if (opening) await opening;
  if (!project || !root) throw new Error('No project is open');
  switch (method) {
    case 'reindex':
      return (await index(root, onProgress)).summary;
    case 'saveSettings': {
      saveSettings(root, { ...DEFAULT_SETTINGS, ...params.settings });
      return (await index(root, onProgress)).summary;
    }
    case 'flow':
      return project.flow(params.rootId, params.opts ?? {});
    case 'symbol':
      return project.symbol(params.id) ?? null;
    case 'file':
      return project.file(params.path);
    case 'search':
      return project.search(params.q);
    case 'diagrams':
      return project.getDiagrams();
  }
  throw new Error(`Unknown method ${method}`);
}

export function currentRoot(): string | null {
  return root;
}
