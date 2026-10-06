import { create } from 'zustand';
import type { Progress, ProjectSettings, ProjectSummary, Role } from '../../engine/types';
import { api } from './api';
import { clearCaches } from './lib/cache';

export type View = 'overview' | 'explore' | 'diagrams';
export type DiagramTab = 'dataflow' | 'database' | 'routes' | 'modules';

export interface CodeLoc {
  file: string;
  line?: number;
  endLine?: number;
  symbolId?: string;
}

/** One step of the path the user dove through: a route, then each function they followed. */
export interface Crumb {
  id: string;
  label: string;
  role: Role;
  /** Where this crumb takes you back to. */
  center: 'flow' | 'code';
  flowRoot: string;
  code?: CodeLoc;
}

interface Snapshot {
  view: View;
  flowRoot?: string;
  trail: Crumb[];
  selected?: string;
  center: 'flow' | 'code';
  code?: CodeLoc;
  diagramTab: DiagramTab;
}

export interface FlowPrefs {
  depth: number;
  hideGuesses: boolean;
  showTrivial: boolean;
}

interface State extends Snapshot {
  summary?: ProjectSummary;
  /** Bumped whenever the analysis is refreshed, so views re-fetch their data. */
  revision: number;
  /** Background re-index in progress (auto-refresh or settings change). */
  updating: boolean;
  updateError?: string;
  settingsOpen: boolean;
  progress?: Progress;
  error?: string;
  opening: boolean;
  history: Snapshot[];
  histIndex: number;
  expanded: Record<string, string[]>;
  flowPrefs: FlowPrefs;
  paletteOpen: boolean;

  openProject(root: string): Promise<void>;
  closeProject(): void;
  setView(v: View): void;
  setDiagramTab(t: DiagramTab): void;
  openEntry(entryId: string, label: string, role: Role, handlerId?: string): void;
  traceFrom(symbolId: string, label: string, role: Role): void;
  dive(target: { id: string; label: string; role: Role; file?: string; line?: number }): void;
  openCode(loc: CodeLoc, label?: string, role?: Role): void;
  showFlow(): void;
  select(id: string | undefined): void;
  goCrumb(index: number): void;
  goHome(): void;
  back(): void;
  forward(): void;
  toggleExpanded(nodeId: string): void;
  setFlowPrefs(p: Partial<FlowPrefs>): void;
  setPalette(open: boolean): void;
  setSettingsOpen(open: boolean): void;
  /** Replace the analysis (after re-index) while keeping the user where they are. */
  applySummary(summary: ProjectSummary): void;
  reindex(): Promise<void>;
  saveSettings(settings: ProjectSettings): Promise<void>;
  /** Convenience edits used by the inspector. */
  updateSettings(fn: (s: ProjectSettings) => ProjectSettings): Promise<void>;
}

const snapshotOf = (s: State): Snapshot => ({
  view: s.view,
  flowRoot: s.flowRoot,
  trail: s.trail,
  selected: s.selected,
  center: s.center,
  code: s.code,
  diagramTab: s.diagramTab,
});

const loadPrefs = (): FlowPrefs => {
  try {
    const raw = localStorage.getItem('ub.flowPrefs');
    if (raw) return { depth: 3, hideGuesses: false, showTrivial: false, ...JSON.parse(raw) };
  } catch {
    /* storage unavailable */
  }
  return { depth: 3, hideGuesses: false, showTrivial: false };
};

export const useStore = create<State>((set, get) => {
  /** Apply a navigation change and record it in history so Back/Forward work everywhere. */
  const navigate = (patch: Partial<Snapshot>) => {
    const s = get();
    const next: Snapshot = { ...snapshotOf(s), ...patch };
    const history = s.history.slice(0, s.histIndex + 1);
    history.push(next);
    if (history.length > 200) history.shift();
    set({ ...next, history, histIndex: history.length - 1 });
  };

  return {
    view: 'overview',
    trail: [],
    center: 'flow',
    diagramTab: 'dataflow',
    opening: false,
    history: [],
    histIndex: -1,
    expanded: {},
    flowPrefs: loadPrefs(),
    paletteOpen: false,
    revision: 0,
    updating: false,
    settingsOpen: false,

    async openProject(root) {
      set({ opening: true, error: undefined, progress: { phase: 'scan', done: 0, total: 0, message: 'Starting…' } });
      try {
        const summary = await api.open(root);
        clearCaches();
        const initial: Snapshot = { view: 'overview', trail: [], center: 'flow', diagramTab: 'dataflow', flowRoot: undefined, selected: undefined, code: undefined };
        set({ summary, opening: false, progress: undefined, ...initial, history: [initial], histIndex: 0, expanded: {} });
      } catch (e) {
        set({ opening: false, error: (e as Error).message, progress: undefined });
      }
    },

    closeProject() {
      set({ summary: undefined, history: [], histIndex: -1, trail: [], flowRoot: undefined, selected: undefined, code: undefined, view: 'overview' });
    },

    setView(view) {
      navigate({ view });
    },

    setDiagramTab(diagramTab) {
      navigate({ diagramTab });
    },

    openEntry(entryId, label, role, handlerId) {
      navigate({
        view: 'explore',
        flowRoot: entryId,
        center: 'flow',
        selected: handlerId ?? entryId,
        code: undefined,
        trail: [{ id: entryId, label, role, center: 'flow', flowRoot: entryId }],
      });
    },

    traceFrom(symbolId, label, role) {
      const s = get();
      const trail = s.trail.length ? [...s.trail] : [];
      const idx = trail.findIndex((c) => c.id === symbolId);
      const crumb: Crumb = { id: symbolId, label, role, center: 'flow', flowRoot: symbolId };
      if (idx >= 0) trail.splice(idx, trail.length - idx, crumb);
      else trail.push(crumb);
      navigate({ view: 'explore', flowRoot: symbolId, center: 'flow', selected: symbolId, trail });
    },

    dive(target) {
      const s = get();
      const trail = [...s.trail];
      const idx = trail.findIndex((c) => c.id === target.id);
      const code: CodeLoc | undefined = target.file ? { file: target.file, line: target.line, symbolId: target.id } : undefined;
      const crumb: Crumb = { id: target.id, label: target.label, role: target.role, center: code ? 'code' : 'flow', flowRoot: s.flowRoot ?? target.id, code };
      if (idx >= 0) trail.splice(idx, trail.length - idx, crumb);
      else trail.push(crumb);
      if (!trail.length || !s.flowRoot) {
        navigate({ view: 'explore', trail, flowRoot: target.id, selected: target.id, center: code ? 'code' : 'flow', code });
        return;
      }
      navigate({ view: 'explore', trail, selected: target.id, center: code ? 'code' : 'flow', code: code ?? s.code });
    },

    openCode(loc, label, role) {
      const s = get();
      const trail = [...s.trail];
      if (label) {
        const id = loc.symbolId ?? `${loc.file}:${loc.line ?? 1}`;
        const idx = trail.findIndex((c) => c.id === id);
        const crumb: Crumb = { id, label, role: role ?? 'other', center: 'code', flowRoot: s.flowRoot ?? id, code: loc };
        if (idx >= 0) trail.splice(idx, trail.length - idx, crumb);
        else trail.push(crumb);
      }
      navigate({ view: 'explore', center: 'code', code: loc, selected: loc.symbolId ?? s.selected, trail });
    },

    showFlow() {
      navigate({ view: 'explore', center: 'flow' });
    },

    select(id) {
      // Selection is lightweight: it does not create a history entry.
      set({ selected: id });
    },

    goCrumb(index) {
      const s = get();
      const crumb = s.trail[index];
      if (!crumb) return;
      navigate({
        view: 'explore',
        trail: s.trail.slice(0, index + 1),
        flowRoot: crumb.flowRoot,
        center: crumb.center,
        code: crumb.code,
        selected: crumb.id,
      });
    },

    goHome() {
      get().goCrumb(0);
    },

    back() {
      const s = get();
      if (s.histIndex <= 0) return;
      const snap = s.history[s.histIndex - 1];
      set({ ...snap, histIndex: s.histIndex - 1 });
    },

    forward() {
      const s = get();
      if (s.histIndex >= s.history.length - 1) return;
      const snap = s.history[s.histIndex + 1];
      set({ ...snap, histIndex: s.histIndex + 1 });
    },

    toggleExpanded(nodeId) {
      const s = get();
      const root = s.flowRoot ?? '';
      const cur = new Set(s.expanded[root] ?? []);
      if (cur.has(nodeId)) cur.delete(nodeId);
      else cur.add(nodeId);
      set({ expanded: { ...s.expanded, [root]: [...cur] } });
    },

    setFlowPrefs(p) {
      const flowPrefs = { ...get().flowPrefs, ...p };
      try {
        localStorage.setItem('ub.flowPrefs', JSON.stringify(flowPrefs));
      } catch {
        /* ignore */
      }
      set({ flowPrefs });
    },

    setPalette(paletteOpen) {
      set({ paletteOpen });
    },

    setSettingsOpen(settingsOpen) {
      set({ settingsOpen });
    },

    applySummary(summary) {
      clearCaches();
      set((s) => ({ summary, revision: s.revision + 1, updating: false, updateError: undefined }));
    },

    async reindex() {
      set({ updating: true, updateError: undefined });
      try {
        get().applySummary(await api.reindex());
      } catch (e) {
        set({ updating: false, updateError: (e as Error).message });
      }
    },

    async saveSettings(settings) {
      set({ updating: true, updateError: undefined });
      try {
        get().applySummary(await api.saveSettings(settings));
      } catch (e) {
        set({ updating: false, updateError: (e as Error).message });
      }
    },

    async updateSettings(fn) {
      const cur = get().summary?.settings;
      if (cur) await get().saveSettings(fn(structuredClone(cur)));
    },
  };
});
