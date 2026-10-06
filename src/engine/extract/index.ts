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
  if (/\.(vue|svelte)$/.test(file)) {
    componentSymbol(c, rawSrc);
    templateCalls(c, rawSrc, src);
  }
  return c.facts;
}

/**
 * A Vue/Svelte file *is* a component, though no declaration in it says so. Give it a symbol whose id is the
 * file's top-level scope, so `import UserCard from './UserCard.vue'`, `<UserCard />` and flows all reach it.
 */
function componentSymbol(c: Collector, raw: string) {
  if (c.facts.symbols.some((s) => s.isDefaultExport)) return;
  const base = c.file.split('/').pop()!;
  const stem = base.replace(/\.(vue|svelte)$/, '');
  const name = /^[A-Za-z][\w-]*$/.test(stem) && stem !== 'index' ? stem.replace(/(^|-)(\w)/g, (_, __, ch: string) => ch.toUpperCase()) : base;
  const lines = raw.split('\n').length;
  const script = /<script\b[^>]*>/.exec(raw);
  c.facts.symbols.push({
    id: c.fileScope,
    name,
    kind: 'function',
    file: c.file,
    lang: c.lang,
    range: { sl: 1, sc: 0, el: lines, ec: 0 },
    nameRange: { sl: 1, sc: 0, el: 1, ec: 0 },
    signature: script ? script[0] : `<${name}>`,
    annotations: [],
    exported: true,
    isDefaultExport: true,
  });
}

const HTML_LIKE = /^(Transition|TransitionGroup|KeepAlive|Teleport|Suspense|RouterView|RouterLink|NuxtLink|NuxtPage|NuxtLayout|ClientOnly|Component|Slot)$/;

/**
 * The template of a Vue/Svelte component is how it uses other code: `<UserRow>` renders a component and
 * `@click="save"` / `on:click={save}` / `onclick={() => save(id)}` calls a function from the script.
 * Record those as calls from the file's top level, which is what a page's flow starts from.
 */
function templateCalls(c: Collector, raw: string, scriptOnly: string) {
  const isVue = c.file.endsWith('.vue');
  const lineStarts = [0];
  for (let i = 0; i < raw.length; i++) if (raw[i] === '\n') lineStarts.push(i + 1);
  const pos = (idx: number) => {
    let lo = 0;
    let hi = lineStarts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (lineStarts[mid] <= idx) lo = mid;
      else hi = mid - 1;
    }
    return { line: lo + 1, col: idx - lineStarts[lo] };
  };
  const add = (callee: string, at: number, render: boolean) => {
    const a = pos(at);
    const b = pos(at + callee.length);
    const range = { sl: a.line, sc: a.col, el: b.line, ec: b.col };
    c.facts.calls.push({ from: c.fileScope, callee, args: [], range, nameRange: range, render: render || undefined });
  };
  // Only look outside <script>/<style>: positions where the script-only text was blanked.
  const outside = (i: number) => scriptOnly[i] === ' ' || scriptOnly[i] === '\n';
  const template = raw.replace(/<style\b[\s\S]*?<\/style>/gi, (m) => m.replace(/[^\n]/g, ' '));
  for (const m of template.matchAll(/<([A-Z][\w]*(?:\.[A-Z]\w*)?|[a-z]+(?:-[a-z0-9]+)+)(?=[\s/>])/g)) {
    if (!outside(m.index!)) continue;
    let tag = m[1];
    if (tag.includes('-')) {
      if (!isVue) continue;
      tag = tag.replace(/(^|-)([a-z0-9])/g, (_, __, ch: string) => ch.toUpperCase());
    }
    const name = tag.split('.').pop()!;
    if (HTML_LIKE.test(name)) continue;
    add(name, m.index! + 1 + m[1].length - name.length, true);
  }
  // Event handlers: @click="save", v-on:submit.prevent="onSubmit($event)", on:click={save}, onclick={() => save(id)}
  for (const m of template.matchAll(/(?:@|v-on:|on:)[\w.-]+\s*=\s*(?:"([^"]*)"|'([^']*)'|\{([^}]*)\})|\bon[a-z]+\s*=\s*\{([^}]*)\}/g)) {
    if (!outside(m.index!)) continue;
    const body = m[1] ?? m[2] ?? m[3] ?? m[4] ?? '';
    const bodyAt = m.index! + m[0].indexOf(body);
    const plain = /^\s*([A-Za-z_$][\w$]*)\s*$/.exec(body);
    if (plain) {
      add(plain[1], bodyAt + body.indexOf(plain[1]), false);
      continue;
    }
    for (const call of body.matchAll(/(?<![.\w$])([A-Za-z_$][\w$]*)\s*\(/g)) add(call[1], bodyAt + call.index!, false);
  }
}
