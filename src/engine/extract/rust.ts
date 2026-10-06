import type { Node, Tree } from 'web-tree-sitter';
import type { Arg, CodeSymbol } from '../types';
import { Collector, baseTypeName, children, field, rangeOf, truncate, unquote, walk } from './collector';

const INTERESTING = new Set([
  'struct_item',
  'enum_item',
  'trait_item',
  'impl_item',
  'function_item',
  'function_signature_item',
  'closure_expression',
  'call_expression',
  'use_declaration',
  'let_declaration',
  'string_literal',
  'raw_string_literal',
]);

export function extractRust(c: Collector, tree: Tree) {
  // impl blocks are not symbols themselves; track the type they implement for method containers.
  const implStack: { type: string; trait?: string; end: number }[] = [];

  const toArg = (n: Node): Arg => {
    const line = n.startPosition.row + 1;
    switch (n.type) {
      case 'string_literal':
      case 'raw_string_literal':
        return { kind: 'string', text: truncate(n.text, 200), value: unquote(n.text.replace(/^r#*"/, '"').replace(/"#*$/, '"')), line };
      case 'integer_literal':
      case 'float_literal':
        return { kind: 'number', text: n.text, line };
      case 'identifier':
        return { kind: 'ident', text: n.text, line };
      case 'field_expression':
      case 'scoped_identifier':
        return { kind: 'member', text: n.text, line };
      case 'closure_expression':
        return { kind: 'func', text: truncate(n.text, 60), symbolId: c.anonId(n), line };
      case 'call_expression': {
        const fn = field(n, 'function');
        return { kind: 'call', text: truncate(n.text), callee: calleeOf(fn).name, items: children(field(n, 'arguments')).map(toArg), line };
      }
      default:
        return { kind: 'other', text: truncate(n.text), line };
    }
  };

  const calleeOf = (fn: Node | null): { name?: string; receiver?: string; node?: Node | null } => {
    if (!fn) return {};
    if (fn.type === 'identifier') return { name: fn.text, node: fn };
    if (fn.type === 'field_expression') return { name: field(fn, 'field')?.text, receiver: field(fn, 'value')?.text, node: field(fn, 'field') };
    if (fn.type === 'scoped_identifier') return { name: field(fn, 'name')?.text, receiver: field(fn, 'path')?.text, node: field(fn, 'name') };
    if (fn.type === 'generic_function') return calleeOf(field(fn, 'function'));
    return {};
  };

  const recordParams = (fn: Node, sym: CodeSymbol) => {
    for (const p of children(field(fn, 'parameters'))) {
      if (p.type !== 'parameter') continue;
      const pat = field(p, 'pattern');
      const t = baseTypeName(field(p, 'type')?.text).name;
      if (pat?.type === 'identifier' && t) c.facts.vars.push({ scope: sym.id, name: pat.text, type: t, line: p.startPosition.row + 1 });
    }
  };

  const currentImpl = (n: Node) => {
    while (implStack.length && implStack[implStack.length - 1].end <= n.startIndex) implStack.pop();
    return implStack[implStack.length - 1];
  };

  walk(
    tree,
    INTERESTING,
    (n) => {
      switch (n.type) {
        case 'struct_item':
        case 'enum_item':
        case 'trait_item': {
          const nm = field(n, 'name');
          if (!nm) return;
          const sym = c.addSymbol({ node: n, nameNode: nm, name: nm.text, kind: n.type === 'trait_item' ? 'interface' : n.type === 'enum_item' ? 'enum' : 'struct', exported: n.text.startsWith('pub') });
          if (n.type === 'struct_item') {
            for (const f of children(field(n, 'body'))) {
              if (f.type !== 'field_declaration') continue;
              const t = baseTypeName(field(f, 'type')?.text);
              const fn = field(f, 'name')?.text;
              if (fn) c.facts.fields.push({ ownerId: sym.id, owner: sym.name, name: fn, type: t.name, typeArgs: t.args, annotations: [], range: rangeOf(f) });
            }
          }
          if (n.type === 'trait_item') {
            c.pushScope('class', sym);
            return 1;
          }
          return;
        }
        case 'impl_item': {
          const t = baseTypeName(field(n, 'type')?.text).name;
          const trait = baseTypeName(field(n, 'trait')?.text).name;
          if (t) implStack.push({ type: t, trait, end: n.endIndex });
          return;
        }
        case 'function_item':
        case 'function_signature_item': {
          const nm = field(n, 'name');
          if (!nm) return;
          const impl = currentImpl(n);
          const cls = c.currentClass; // trait
          const container = impl?.type ?? cls?.name;
          const sym = c.addSymbol({ node: n, nameNode: nm, name: nm.text, kind: container ? 'method' : 'function', exported: n.text.startsWith('pub') });
          if (impl) {
            sym.container = impl.type;
            sym.containerId = undefined;
            sym.id = c.symbolId(nm.text, sym.range.sl, impl.type);
            if (impl.trait) sym.supers = [impl.trait];
          }
          recordParams(n, sym);
          if (n.type === 'function_signature_item') return;
          c.pushScope('func', sym);
          return 1;
        }
        case 'closure_expression': {
          if (n.parent?.type !== 'arguments') return;
          const call = n.parent.parent;
          const callee = call ? calleeOf(field(call, 'function')).name : undefined;
          const sym = c.addSymbol({ node: n, name: `${callee ?? 'callback'}(…) closure`, kind: 'handler', id: c.anonId(n) });
          c.pushScope('func', sym);
          return 1;
        }
        case 'call_expression': {
          const { name, receiver, node } = calleeOf(field(n, 'function'));
          if (name) c.addCall(n, name, receiver, children(field(n, 'arguments')).map(toArg), false, node);
          return;
        }
        case 'use_declaration': {
          const line = n.startPosition.row + 1;
          const arg = field(n, 'argument');
          const visit = (node: Node | null, prefix: string) => {
            if (!node) return;
            if (node.type === 'scoped_identifier' || node.type === 'identifier') {
              const full = prefix ? `${prefix}::${node.text}` : node.text;
              c.facts.imports.push({ source: full, local: full.split('::').pop()!, imported: full.split('::').pop()!, line });
            } else if (node.type === 'use_as_clause') {
              const p = field(node, 'path')?.text ?? '';
              const full = prefix ? `${prefix}::${p}` : p;
              c.facts.imports.push({ source: full, local: field(node, 'alias')?.text ?? full.split('::').pop()!, imported: full.split('::').pop()!, line });
            } else if (node.type === 'scoped_use_list') {
              const p = field(node, 'path')?.text ?? '';
              for (const item of children(field(node, 'list'))) visit(item, prefix ? `${prefix}::${p}` : p);
            } else if (node.type === 'use_list') {
              for (const item of children(node)) visit(item, prefix);
            }
          };
          visit(arg, '');
          return;
        }
        case 'let_declaration': {
          const pat = field(n, 'pattern');
          if (pat?.type !== 'identifier') return;
          let type = baseTypeName(field(n, 'type')?.text).name;
          const v = field(n, 'value');
          let call: { callee: string; receiver?: string; args: Arg[] } | undefined;
          if (v?.type === 'call_expression') {
            const ci = calleeOf(field(v, 'function'));
            call = { callee: ci.name ?? '?', receiver: ci.receiver, args: children(field(v, 'arguments')).map(toArg) };
            if (!type && ci.name === 'new' && ci.receiver && /^[A-Z]/.test(ci.receiver)) type = baseTypeName(ci.receiver).name;
          } else if (v?.type === 'struct_expression') type = type ?? baseTypeName(field(v, 'name')?.text).name;
          c.facts.vars.push({ scope: c.scopeId, name: pat.text, type, call, line: n.startPosition.row + 1 });
          return;
        }
        case 'string_literal':
        case 'raw_string_literal': {
          const v = unquote(n.text.replace(/^r#*"/, '"').replace(/"#*$/, '"'));
          if (v) c.addString(v, n);
          return;
        }
      }
    },
    c,
  );
}
