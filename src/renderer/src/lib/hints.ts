import { useEffect } from 'react';
import { create } from 'zustand';

/**
 * Contextual tips: each tip explains the screen the user just reached, once.
 * Tips are global (not per project) except the project intro, which greets every newly opened codebase.
 * Everything is optional — one click turns them all off, with an Undo in case it was a mistake.
 */
export type HintId =
  | 'project-intro'
  | 'tabs'
  | 'explore-guide'
  | 'explore-flow'
  | 'inspector'
  | 'explore-trail'
  | 'code-view'
  | 'search'
  | 'settings'
  | 'diagrams-dataflow'
  | 'diagrams-database'
  | 'diagrams-routes'
  | 'diagrams-modules';

export interface HintContent {
  title: string;
  body: string;
  /** CSS selector of the element this tip is about; it gets a gentle highlight while the tip is shown. */
  target?: string;
  /** Short key hints rendered as keycaps. */
  keys?: string[];
}

export const HINTS: Record<Exclude<HintId, 'project-intro'>, HintContent> = {
  tabs: {
    title: 'Three ways to look at a codebase',
    body: 'Overview says what kind of program this is and where to start. Explore lets you follow one request through the code. Diagrams show the big picture: architecture, database and routes.',
    target: '[data-hint="tabs"]',
    keys: ['Ctrl+1', 'Ctrl+2', 'Ctrl+3'],
  },
  'explore-guide': {
    title: 'Pick a starting point',
    body: 'The list on the left holds every way into this program: HTTP routes, pages, processes, jobs and channels. Click one to draw everything it calls. Use the filter and method chips to narrow a long list.',
    target: '[data-hint="guide"]',
  },
  'explore-flow': {
    title: 'Reading a flow',
    body: 'Boxes are functions, colored by their job. Arrows go from caller to callee. Click a box to learn about it, double-click to read its code, and use the +N badges to expand calls that are hidden. Dashed or dotted lines are less certain links.',
    target: '[data-hint="flow"]',
  },
  inspector: {
    title: 'The inspector explains the selection',
    body: 'The panel on the right says what the selected code does and why we think so, what it calls, what calls it, and which data it touches. If a role is wrong, fix it with "Wrong role?". Pin things we missed as entry points.',
    target: '[data-hint="inspector"]',
  },
  'explore-trail': {
    title: 'You can always find your way back',
    body: 'The trail at the top records every step you took. Click any step to jump back to it, or the house icon to return to where you started. Back and forward work like a browser.',
    target: '[data-hint="trail"]',
    keys: ['Alt+←', 'Alt+→'],
  },
  'code-view': {
    title: 'Underlined calls are links',
    body: 'Click an underlined name to follow that call into its code. Hover one to see where it goes and how sure we are. Hold Alt while clicking to just place the cursor. "Trace from here" draws a new flow starting at this function.',
    target: '[data-hint="code"]',
  },
  search: {
    title: 'Jump anywhere',
    body: 'Search finds routes, functions, classes, files and tables. Enter opens the code; Shift+Enter draws the flow from a function.',
    target: '[data-hint="search"]',
    keys: ['Ctrl+K'],
  },
  settings: {
    title: 'Make the map fit this project',
    body: 'Project settings let you ignore folders, include or skip tests, correct roles and pin entry points. The analysis also refreshes on its own when you edit files; the refresh button re-runs it on demand.',
    target: '[data-hint="settings"]',
  },
  'diagrams-dataflow': {
    title: 'Data flow: the architecture at a glance',
    body: 'Columns go from entry points on the left to data stores on the right. Thicker arrows mean more calls. Click a box to highlight what it talks to; use the checkboxes at the bottom to hide layers.',
    target: '[data-hint="diagram"]',
  },
  'diagrams-database': {
    title: 'Database: tables, keys and indexes',
    body: 'PK marks primary keys, FK foreign keys (the arrow points to the referenced table) and IX indexed columns. Click a table to see its indexes and every function that reads or writes it.',
    target: '[data-hint="diagram"]',
  },
  'diagrams-routes': {
    title: 'Route map: every URL',
    body: 'Each box is one segment of a URL path, with the HTTP methods answered there. Click a method badge to open that route in Explore.',
    target: '[data-hint="diagram"]',
  },
  'diagrams-modules': {
    title: 'Modules: how folders depend on each other',
    body: 'Each box is a folder; arrows show imports and calls between them. Folders with many incoming arrows are shared foundations — change them with care.',
    target: '[data-hint="diagram"]',
  },
};

/** Reading order for tips that arrive together. */
const ORDER: HintId[] = ['project-intro', 'tabs', 'explore-guide', 'explore-flow', 'inspector', 'explore-trail', 'code-view', 'diagrams-dataflow', 'diagrams-database', 'diagrams-routes', 'diagrams-modules', 'search', 'settings'];

interface QueuedHint {
  id: HintId;
  content: HintContent;
}

interface HintState {
  enabled: boolean;
  seen: Set<string>;
  queue: QueuedHint[];
  /** Shown right after tips are turned off, so a mis-click is one click to undo. */
  undoVisible: boolean;
  request(id: HintId, content?: HintContent, seenKey?: string): void;
  dismiss(): void;
  /** Drop a not-yet-dismissed tip (its screen went away); it will be offered again next time. */
  withdraw(seenKey: string): void;
  disable(): void;
  enable(): void;
  undoDisable(): void;
  hideUndo(): void;
  replayAll(): void;
}

const load = <T,>(key: string, fallback: T): T => {
  try {
    const v = localStorage.getItem(key);
    return v === null ? fallback : (JSON.parse(v) as T);
  } catch {
    return fallback;
  }
};
const save = (key: string, v: unknown) => {
  try {
    localStorage.setItem(key, JSON.stringify(v));
  } catch {
    /* storage unavailable: tips still work for this session */
  }
};

/** Seen-keys of the hints currently queued, so the same tip is never queued twice. */
const keyOf = new WeakMap<QueuedHint, string>();

export const useHints = create<HintState>((set, get) => ({
  enabled: load('ub.hints.enabled', true),
  seen: new Set(load<string[]>('ub.hints.seen', [])),
  queue: [],
  undoVisible: false,

  request(id, content, seenKey = id) {
    const s = get();
    if (!s.enabled || s.seen.has(seenKey) || s.queue.some((q) => keyOf.get(q) === seenKey)) return;
    const c = content ?? HINTS[id as keyof typeof HINTS];
    if (!c) return;
    const q: QueuedHint = { id, content: c };
    keyOf.set(q, seenKey);
    // Keep a natural reading order when several tips arrive at once (never reorder the one on screen).
    const [head, ...rest] = s.queue;
    const sorted = [...rest, q].sort((a, b) => ORDER.indexOf(a.id) - ORDER.indexOf(b.id));
    set({ queue: head ? [head, ...sorted] : sorted });
  },

  dismiss() {
    const s = get();
    const [cur, ...rest] = s.queue;
    if (!cur) return;
    const seen = new Set(s.seen).add(keyOf.get(cur) ?? cur.id);
    save('ub.hints.seen', [...seen]);
    set({ queue: rest, seen });
  },

  withdraw(seenKey) {
    const q = get().queue;
    if (q.some((h) => keyOf.get(h) === seenKey)) set({ queue: q.filter((h) => keyOf.get(h) !== seenKey) });
  },

  disable() {
    save('ub.hints.enabled', false);
    set({ enabled: false, undoVisible: true });
  },

  enable() {
    save('ub.hints.enabled', true);
    set({ enabled: true, undoVisible: false });
  },

  undoDisable() {
    // Keep whatever was queued so the user lands back exactly where they were.
    get().enable();
  },

  hideUndo() {
    set({ undoVisible: false });
  },

  replayAll() {
    save('ub.hints.seen', []);
    save('ub.hints.enabled', true);
    set({ seen: new Set(), enabled: true, undoVisible: false, queue: [] });
  },
}));

/** Ask for a tip when `when` becomes true (e.g. the screen it explains is visible). */
export function useHint(id: HintId, when = true, content?: HintContent, seenKey: string = id) {
  const enabled = useHints((s) => s.enabled);
  const seen = useHints((s) => s.seen.has(seenKey));
  useEffect(() => {
    if (!when || !enabled || seen) return;
    // A short delay lets the screen render first, so the tip appears next to what it describes.
    const t = setTimeout(() => useHints.getState().request(id, content, seenKey), 600);
    return () => {
      clearTimeout(t);
      // Leaving the screen (or the condition no longer holding) takes the tip away unseen.
      useHints.getState().withdraw(seenKey);
    };
    // content is derived from props that are captured by seenKey
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, when, enabled, seen, seenKey]);
}

// Dev-only handle for debugging tip state from the console.
if (import.meta.env.DEV) (window as unknown as { __hints: typeof useHints }).__hints = useHints;
