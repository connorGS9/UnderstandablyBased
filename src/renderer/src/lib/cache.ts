import { api } from '../api';
import type { Diagrams, FileView } from '../../../engine/types';

// Per-project caches. Cleared whenever a project is opened.
let diagramsPromise: Promise<Diagrams> | null = null;
const fileCache = new Map<string, Promise<FileView>>();

export function loadDiagrams(): Promise<Diagrams> {
  diagramsPromise ??= api.diagrams();
  diagramsPromise.catch(() => (diagramsPromise = null));
  return diagramsPromise;
}

export function loadFile(path: string): Promise<FileView> {
  let p = fileCache.get(path);
  if (!p) {
    p = api.file(path);
    fileCache.set(path, p);
    p.catch(() => fileCache.delete(path));
  }
  return p;
}

export function clearCaches() {
  diagramsPromise = null;
  fileCache.clear();
}
