import { createRequire } from 'node:module';
import path from 'node:path';
import fs from 'node:fs';
import { Parser, Language } from 'web-tree-sitter';
import type { Lang } from './types';

const require = createRequire(import.meta.url);

const EXT_LANG: Record<string, Lang> = {
  '.js': 'javascript',
  '.mjs': 'javascript',
  '.cjs': 'javascript',
  '.jsx': 'javascript',
  '.ts': 'typescript',
  '.mts': 'typescript',
  '.cts': 'typescript',
  '.tsx': 'tsx',
  // Single-file components: only the <script> block is analyzed (see prepareSource).
  '.vue': 'typescript',
  '.svelte': 'typescript',
  '.java': 'java',
  '.py': 'python',
  '.c': 'c',
  '.h': 'cpp', // most real-world .h files in mixed repos parse fine as C++
  '.cc': 'cpp',
  '.cpp': 'cpp',
  '.cxx': 'cpp',
  '.hpp': 'cpp',
  '.hh': 'cpp',
  '.hxx': 'cpp',
  '.ipp': 'cpp',
  '.inl': 'cpp',
  '.go': 'go',
  '.rs': 'rust',
  '.cs': 'csharp',
};

const GRAMMAR_FILE: Record<Lang, string> = {
  javascript: 'tree-sitter-javascript.wasm',
  typescript: 'tree-sitter-typescript.wasm',
  tsx: 'tree-sitter-tsx.wasm',
  java: 'tree-sitter-java.wasm',
  python: 'tree-sitter-python.wasm',
  c: 'tree-sitter-c.wasm',
  cpp: 'tree-sitter-cpp.wasm',
  go: 'tree-sitter-go.wasm',
  rust: 'tree-sitter-rust.wasm',
  csharp: 'tree-sitter-c_sharp.wasm',
};

export function langForFile(file: string): Lang | null {
  return EXT_LANG[path.extname(file).toLowerCase()] ?? null;
}

/** Packaged apps unpack .wasm files next to the asar; prefer that copy when it exists. */
function unpacked(p: string): string {
  const alt = p.replace(`app.asar${path.sep}`, `app.asar.unpacked${path.sep}`);
  return alt !== p && fs.existsSync(alt) ? alt : p;
}

let initPromise: Promise<void> | null = null;
const languages = new Map<Lang, Promise<Language>>();
const parsers = new Map<Lang, Parser>();

/** Packaged builds set UB_WASM_DIR to the resources folder that holds every .wasm file. */
const packagedWasmDir = () => process.env.UB_WASM_DIR;

function grammarDir(): string {
  return packagedWasmDir() ?? unpacked(path.join(path.dirname(require.resolve('tree-sitter-wasms/package.json')), 'out'));
}

export function initParser(): Promise<void> {
  if (!initPromise) {
    const runtimeDir = packagedWasmDir() ?? path.dirname(require.resolve('web-tree-sitter'));
    initPromise = Parser.init({
      locateFile: (name: string) => unpacked(path.join(runtimeDir, name)),
    });
  }
  return initPromise;
}

export async function getParser(lang: Lang): Promise<Parser> {
  await initParser();
  let parser = parsers.get(lang);
  if (parser) return parser;
  let langPromise = languages.get(lang);
  if (!langPromise) {
    langPromise = Language.load(path.join(grammarDir(), GRAMMAR_FILE[lang]));
    languages.set(lang, langPromise);
  }
  parser = new Parser();
  parser.setLanguage(await langPromise);
  parsers.set(lang, parser);
  return parser;
}
