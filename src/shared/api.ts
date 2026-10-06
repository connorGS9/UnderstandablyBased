import type { Diagrams, FileView, FlowGraph, Progress, ProjectSummary, SearchHit, SymbolDetail } from '../engine/types';

export interface FlowOptions {
  depth?: number;
  expanded?: string[];
  collapsed?: string[];
  hideGuesses?: boolean;
  showTrivial?: boolean;
  maxNodes?: number;
}

export interface RecentProject {
  root: string;
  name: string;
  openedAt: number;
  summary?: string;
}

/** Everything the UI can ask of the backend. Implemented over Electron IPC, or HTTP in web dev mode. */
export interface UBApi {
  platform: 'electron' | 'web';
  pickFolder(): Promise<string | null>;
  open(root: string): Promise<ProjectSummary>;
  flow(rootId: string, opts?: FlowOptions): Promise<FlowGraph>;
  symbol(id: string): Promise<SymbolDetail | null>;
  file(path: string): Promise<FileView>;
  search(q: string): Promise<SearchHit[]>;
  diagrams(): Promise<Diagrams>;
  recent(): Promise<RecentProject[]>;
  forgetRecent(root: string): Promise<void>;
  openInEditor(file: string, line?: number): Promise<void>;
  reveal(file: string): Promise<void>;
  onProgress(cb: (p: Progress) => void): () => void;
  /** Path of a folder dropped onto the window (Electron only). */
  pathForFile?(file: File): string;
  /** Folder passed on the command line, if any (consumed once). */
  initialFolder(): Promise<string | null>;
}

/** Methods the engine worker understands (shared by Electron worker and the web dev server). */
export type EngineMethod = 'open' | 'flow' | 'symbol' | 'file' | 'search' | 'diagrams';
