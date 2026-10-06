import type { FileFacts, Lang } from '../types';
import { getParser } from '../parser';
import { Collector } from './collector';
import { extractJs } from './javascript';
import { extractJava } from './java';
import { extractPython } from './python';
import { extractGo } from './go';
import { extractCpp } from './cpp';
import { extractRust } from './rust';
import { extractCsharp } from './csharp';

/**
 * Vue/Svelte single-file components: keep only the <script> blocks, blanking everything else but
 * newlines so line and column numbers still match the original file.
 */
export function prepareSource(file: string, src: string): string {
  if (!/\.(vue|svelte)$/.test(file)) return src;
  let out = '';
  let last = 0;
  const re = /<script\b[^>]*>([\s\S]*?)<\/script>/gi;
  let m: RegExpExecArray | null;
  const blank = (s: string) => s.replace(/[^\n]/g, ' ');
  while ((m = re.exec(src))) {
    const bodyStart = m.index + m[0].indexOf('>') + 1;
    const bodyEnd = bodyStart + m[1].length;
    out += blank(src.slice(last, bodyStart)) + src.slice(bodyStart, bodyEnd);
    last = bodyEnd;
  }
  return out + blank(src.slice(last));
}

export async function extractFile(file: string, rawSrc: string, lang: Lang): Promise<FileFacts> {
  const src = prepareSource(file, rawSrc);
  const parser = await getParser(lang);
  const tree = parser.parse(src);
  const c = new Collector(file, lang, src);
  if (!tree) return c.facts;
  try {
    c.facts.parseErrors = tree.rootNode.hasError || undefined;
    switch (lang) {
      case 'javascript':
      case 'typescript':
      case 'tsx':
        extractJs(c, tree);
        break;
      case 'java':
        extractJava(c, tree);
        break;
      case 'python':
        extractPython(c, tree);
        break;
      case 'go':
        extractGo(c, tree);
        break;
      case 'c':
      case 'cpp':
        extractCpp(c, tree);
        break;
      case 'rust':
        extractRust(c, tree);
        break;
      case 'csharp':
        extractCsharp(c, tree);
        break;
    }
  } finally {
    tree.delete();
  }
  return c.facts;
}
