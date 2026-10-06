// Runs engine requests against the currently open project. Shared by the Electron worker and the web dev server.
import { Project } from '../src/engine/project';
import type { Progress } from '../src/engine/types';
import type { EngineMethod } from '../src/shared/api';

let project: Project | null = null;
let opening: Promise<Project> | null = null;

export async function handle(method: EngineMethod, params: any, onProgress: (p: Progress) => void): Promise<unknown> {
  if (method === 'open') {
    opening = Project.open(params.root, onProgress);
    try {
      project = await opening;
    } finally {
      opening = null;
    }
    return project.summary;
  }
  if (opening) await opening;
  if (!project) throw new Error('No project is open');
  switch (method) {
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
  return project?.root ?? null;
}
