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

export async function extractFile(file: string, src: string, lang: Lang): Promise<FileFacts> {
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
