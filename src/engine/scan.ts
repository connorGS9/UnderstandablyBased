import fs from 'node:fs/promises';
import path from 'node:path';
import ignore, { type Ignore } from 'ignore';
import { langForFile } from './parser';
import type { FileEntry } from './types';

/** Directories that are never interesting for understanding a codebase. */
const ALWAYS_SKIP = new Set([
  '.git',
  '.hg',
  '.svn',
  'node_modules',
  'bower_components',
  'vendor',
  '.venv',
  'venv',
  'env',
  '__pycache__',
  '.mypy_cache',
  '.pytest_cache',
  '.tox',
  'dist',
  'build',
  'out',
  'target',
  'bin',
  'obj',
  '.next',
  '.nuxt',
  '.svelte-kit',
  '.turbo',
  '.cache',
  'coverage',
  '.idea',
  '.vscode',
  '.gradle',
  'cmake-build-debug',
  'cmake-build-release',
  'third_party',
  'external',
  'Pods',
  'DerivedData',
]);

/** Non-source files we still read because analyzers need them. */
const CONFIG_FILES = new Set([
  'package.json',
  'tsconfig.json',
  'jsconfig.json',
  'pom.xml',
  'build.gradle',
  'build.gradle.kts',
  'settings.gradle',
  'requirements.txt',
  'pyproject.toml',
  'Pipfile',
  'setup.py',
  'go.mod',
  'Cargo.toml',
  'CMakeLists.txt',
  'Makefile',
  'meson.build',
  'conanfile.txt',
  'vcpkg.json',
  'schema.prisma',
  'project.godot',
  'manage.py',
  'application.properties',
  'application.yml',
  'application.yaml',
]);

export const MAX_FILE_BYTES = 1_500_000;
export const MAX_FILES = 25_000;

export interface ScanResult {
  files: FileEntry[];
  /** Non-source files the analyzers want (manifests, SQL, prisma). */
  extras: string[];
  skippedLarge: number;
  truncated: boolean;
}

export async function scanProject(root: string, onProgress?: (n: number) => void): Promise<ScanResult> {
  const files: FileEntry[] = [];
  const extras: string[] = [];
  let skippedLarge = 0;
  let truncated = false;

  const loadIgnore = async (dir: string): Promise<Ignore | null> => {
    try {
      const txt = await fs.readFile(path.join(dir, '.gitignore'), 'utf8');
      return ignore().add(txt);
    } catch {
      return null;
    }
  };

  const walkDir = async (rel: string, ignores: { base: string; ig: Ignore }[]) => {
    if (files.length >= MAX_FILES) {
      truncated = true;
      return;
    }
    const abs = path.join(root, rel);
    let entries: import('node:fs').Dirent[];
    try {
      entries = await fs.readdir(abs, { withFileTypes: true });
    } catch {
      return;
    }
    const local = await loadIgnore(abs);
    const igs = local ? [...ignores, { base: rel, ig: local }] : ignores;
    const isIgnored = (relPath: string, dir: boolean) =>
      igs.some(({ base, ig }) => {
        const sub = base ? path.posix.relative(base, relPath) : relPath;
        if (!sub || sub.startsWith('..')) return false;
        return ig.ignores(dir ? sub + '/' : sub);
      });

    for (const e of entries) {
      const relPath = rel ? `${rel}/${e.name}` : e.name;
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) {
        if (ALWAYS_SKIP.has(e.name) || (e.name.startsWith('.') && e.name !== '.github')) continue;
        if (isIgnored(relPath, true)) continue;
        await walkDir(relPath, igs);
        continue;
      }
      if (!e.isFile()) continue;
      const lang = langForFile(e.name);
      const lower = e.name.toLowerCase();
      const wanted = CONFIG_FILES.has(e.name) || lower.endsWith('.sql') || lower.endsWith('.prisma') || lower.endsWith('.csproj') || lower.endsWith('.uproject');
      if (!lang && !wanted) continue;
      if (isIgnored(relPath, false)) continue;
      if (/\.min\.(js|css)$|\.bundle\.js$|\.d\.ts$|\.pb\.(go|cc|h)$|_pb2\.py$|\.generated\./.test(lower)) continue;
      let size = 0;
      try {
        size = (await fs.stat(path.join(root, relPath))).size;
      } catch {
        continue;
      }
      if (lang) {
        if (size > MAX_FILE_BYTES) {
          skippedLarge++;
          continue;
        }
        files.push({ path: relPath, lang, size, lines: 0 });
        if (files.length % 200 === 0) onProgress?.(files.length);
        if (files.length >= MAX_FILES) {
          truncated = true;
          return;
        }
      }
      if (wanted) extras.push(relPath);
    }
  };

  await walkDir('', []);
  files.sort((a, b) => a.path.localeCompare(b.path));
  return { files, extras, skippedLarge, truncated };
}
