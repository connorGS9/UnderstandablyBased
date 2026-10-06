import type { Node, Tree } from 'web-tree-sitter';
import type { Annotation, Arg } from '../types';
import { Collector, baseTypeName, children, field, rangeOf, truncate, walk } from './collector';

const INTERESTING = new Set([
  'class_definition',
  'function_definition',
  'call',
  'import_statement',
  'import_from_statement',
  'assignment',
  'string',
  'if_statement',
  'lambda',
]);

function pyString(n: Node): string | undefined {
  if (n.type === 'concatenated_string') return children(n).map((s) => pyString(s) ?? '').join('');
  if (n.type !== 'string') return undefined;
  return children(n)
    .filter((x) => x.type === 'string_content')
    .map((x) => x.text)
    .join('');
}

export function extractPython(c: Collector, tree: Tree) {
  const toArg = (n: Node): Arg => {
    const line = n.startPosition.row + 1;
    switch (n.type) {
      case 'string':
      case 'concatenated_string':
        return { kind: 'string', text: truncate(n.text, 200), value: pyString(n), line };
      case 'integer':
      case 'float':
        return { kind: 'number', text: n.text, line };
      case 'identifier':
        return { kind: 'ident', text: n.text, line };
      case 'attribute':
        return { kind: 'member', text: n.text, line };
      case 'keyword_argument': {
        const v = field(n, 'value');
        const k = field(n, 'name')?.text;
        return v ? { ...toArg(v), key: k } : { kind: 'other', text: n.text, key: k, line };
      }
      case 'list':
      case 'tuple':
      case 'set':
        return { kind: 'array', text: truncate(n.text), items: children(n).map(toArg), line };
      case 'dictionary': {
        const items: Arg[] = [];
        for (const p of children(n)) {
          if (p.type !== 'pair') continue;
          const k = field(p, 'key');
          const v = field(p, 'value');
          if (k && v) items.push({ ...toArg(v), key: pyString(k) ?? k.text });
        }
        return { kind: 'object', text: truncate(n.text), items, line };
      }
      case 'call': {
        const fn = field(n, 'function');
        const callee = fn?.type === 'attribute' ? field(fn, 'attribute')?.text : fn?.text;
        const inner = children(field(n, 'arguments')).map(toArg);
        return { kind: 'call', text: truncate(n.text), callee, items: inner, value: inner.find((a) => a.kind === 'string')?.value, line };
      }
      case 'lambda':
        return { kind: 'func', text: truncate(n.text, 60), symbolId: c.anonId(n), line };
      default:
        return { kind: 'other', text: truncate(n.text), line };
    }
  };

  const decoratorsOf = (n: Node): Annotation[] => {
    const p = n.parent;
    if (p?.type !== 'decorated_definition') return [];
    return children(p)
      .filter((d) => d.type === 'decorator')
      .map((d) => {
        const e = d.namedChild(0);
        if (e?.type === 'call') return { name: field(e, 'function')?.text ?? '?', args: children(field(e, 'arguments')).map(toArg) };
        return { name: e?.text ?? '?', args: [] };
      });
  };

  const callInfo = (v: Node | null) => {
    if (!v) return undefined;
    if (v.type === 'await') v = v.namedChild(0);
    if (v?.type !== 'call') return undefined;
    const fn = field(v, 'function');
    const callee = fn?.type === 'attribute' ? field(fn, 'attribute')?.text : fn?.text;
    const receiver = fn?.type === 'attribute' ? field(fn, 'object')?.text : undefined;
    return { callee: callee ?? '?', receiver, args: children(field(v, 'arguments')).map(toArg) };
  };

  const typeOf = (t: Node | null) => baseTypeName(t?.text);

  walk(
    tree,
    INTERESTING,
    (n) => {
      switch (n.type) {
        case 'class_definition': {
          const nm = field(n, 'name');
          if (!nm) return;
          const supers: string[] = [];
          const superArgs: Record<string, string[]> = {};
          for (const s of children(field(n, 'superclasses'))) {
            if (s.type === 'keyword_argument') continue;
            const b = baseTypeName(s.text);
            if (b.name) {
              supers.push(s.type === 'attribute' ? s.text : b.name);
              if (b.args.length) superArgs[b.name] = b.args;
            }
          }
          const sym = c.addSymbol({ node: n, nameNode: nm, name: nm.text, kind: 'class', annotations: decoratorsOf(n), supers, superArgs, exported: true });
          c.pushScope('class', sym);
          return 1;
        }
        case 'function_definition': {
          const nm = field(n, 'name');
          if (!nm) return;
          const inClass = n.parent?.parent?.type === 'class_definition' || n.parent?.parent?.parent?.type === 'class_definition';
          const cls = c.currentClass;
          const sym = c.addSymbol({
            node: n.parent?.type === 'decorated_definition' ? n.parent : n,
            nameNode: nm,
            name: nm.text,
            kind: inClass && cls ? (nm.text === '__init__' ? 'constructor' : 'method') : 'function',
            annotations: decoratorsOf(n),
            container: inClass ? cls : undefined,
            signature: c.signature(n),
            exported: !nm.text.startsWith('_'),
          });
          if (!inClass) {
            // keep top-level/nested functions from inheriting the class container
            sym.container = undefined;
            sym.containerId = undefined;
          }
          for (const p of children(field(n, 'parameters'))) {
            if (p.type === 'typed_parameter' || p.type === 'typed_default_parameter') {
              const pn = p.type === 'typed_parameter' ? children(p).find((x) => x.type === 'identifier')?.text : field(p, 'name')?.text;
              const t = typeOf(field(p, 'type'));
              if (pn && t.name) c.facts.vars.push({ scope: sym.id, name: pn, type: t.name, line: p.startPosition.row + 1 });
            }
          }
          c.pushScope('func', sym);
          return 1;
        }
        case 'lambda': {
          if (n.parent?.type !== 'argument_list') return;
          const sym = c.addSymbol({ node: n, name: 'lambda callback', kind: 'handler', id: c.anonId(n) });
          c.pushScope('func', sym);
          return 1;
        }
        case 'call': {
          const fn = field(n, 'function');
          if (!fn) return;
          const args = children(field(n, 'arguments')).map(toArg);
          if (fn.type === 'identifier') c.addCall(n, fn.text, undefined, args, false, fn);
          else if (fn.type === 'attribute') {
            const attr = field(fn, 'attribute');
            if (attr) c.addCall(n, attr.text, field(fn, 'object')?.text, args, false, attr);
          }
          return;
        }
        case 'import_statement': {
          const line = n.startPosition.row + 1;
          for (const part of children(n)) {
            if (part.type === 'dotted_name') c.facts.imports.push({ source: part.text, local: part.text, imported: '*', line });
            else if (part.type === 'aliased_import') {
              const name = field(part, 'name')?.text;
              const alias = field(part, 'alias')?.text;
              if (name) c.facts.imports.push({ source: name, local: alias ?? name, imported: '*', line });
            }
          }
          return;
        }
        case 'import_from_statement': {
          const line = n.startPosition.row + 1;
          const mod = field(n, 'module_name');
          if (!mod) return;
          const source = mod.text; // relative imports keep their leading dots
          for (const part of children(n)) {
            if (part.startIndex === mod.startIndex) continue;
            if (part.type === 'dotted_name') c.facts.imports.push({ source, local: part.text, imported: part.text, line });
            else if (part.type === 'aliased_import') {
              const name = field(part, 'name')?.text;
              const alias = field(part, 'alias')?.text;
              if (name) c.facts.imports.push({ source, local: alias ?? name, imported: name, line });
            } else if (part.type === 'wildcard_import') c.facts.imports.push({ source, local: '*', imported: '*', line });
          }
          return;
        }
        case 'assignment': {
          const left = field(n, 'left');
          const right = field(n, 'right');
          const tNode = field(n, 'type');
          if (!left) return;
          const cls = c.currentClass;
          const t = typeOf(tNode);
          const call = callInfo(right);
          if (left.type === 'identifier' && cls && c.scopes[c.scopes.length - 1]?.kind === 'class') {
            c.facts.fields.push({
              ownerId: cls.id,
              owner: cls.name,
              name: left.text,
              type: t.name,
              typeArgs: t.args,
              value: right ? truncate(right.text, 200) : undefined,
              valueCall: call,
              annotations: [],
              range: rangeOf(n),
            });
            return;
          }
          if (left.type === 'attribute' && field(left, 'object')?.text === 'self' && cls) {
            // self.repo = repo / self.repo = OrderRepo()
            let type = t.name;
            if (!type && call && /^[A-Z]/.test(call.callee)) type = call.callee;
            if (!type && right?.type === 'identifier') {
              const param = c.facts.vars.find((v) => v.scope === c.scopeId && v.name === right.text);
              type = param?.type;
            }
            c.facts.fields.push({
              ownerId: cls.id,
              owner: cls.name,
              name: field(left, 'attribute')?.text ?? '?',
              type,
              annotations: [],
              range: rangeOf(n),
            });
            return;
          }
          if (left.type === 'identifier') {
            let type = t.name;
            if (!type && call && /^[A-Z]/.test(call.callee) && !call.receiver) type = call.callee;
            c.facts.vars.push({
              scope: c.scopeId,
              name: left.text,
              type,
              call,
              valueText: !call && right ? truncate(right.text, 160) : undefined,
              line: n.startPosition.row + 1,
            });
          }
          return;
        }
        case 'string': {
          const v = pyString(n);
          if (v) c.addString(v, n);
          return;
        }
        case 'if_statement': {
          const cond = field(n, 'condition');
          if (cond && /__name__\s*==\s*['"]__main__['"]/.test(cond.text)) c.facts.hasMainGuard = true;
          return;
        }
      }
    },
    c,
  );
}
