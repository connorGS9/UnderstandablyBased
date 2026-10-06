import type { Node, Tree } from 'web-tree-sitter';
import type { Arg, CodeSymbol } from '../types';
import { Collector, baseTypeName, children, field, rangeOf, truncate, unquote, walk } from './collector';

const INTERESTING = new Set([
  'function_declaration',
  'method_declaration',
  'type_spec',
  'func_literal',
  'call_expression',
  'import_spec',
  'short_var_declaration',
  'var_spec',
  'interpreted_string_literal',
  'raw_string_literal',
]);

export function extractGo(c: Collector, tree: Tree) {
  const toArg = (n: Node): Arg => {
    const line = n.startPosition.row + 1;
    switch (n.type) {
      case 'interpreted_string_literal':
      case 'raw_string_literal':
        return { kind: 'string', text: truncate(n.text, 200), value: unquote(n.text), line };
      case 'int_literal':
      case 'float_literal':
        return { kind: 'number', text: n.text, line };
      case 'identifier':
        return { kind: 'ident', text: n.text, line };
      case 'selector_expression':
        return { kind: 'member', text: n.text, line };
      case 'func_literal':
        return { kind: 'func', text: truncate(n.text, 60), symbolId: c.anonId(n), line };
      case 'call_expression': {
        const fn = field(n, 'function');
        const callee = fn?.type === 'selector_expression' ? field(fn, 'field')?.text : fn?.text;
        return { kind: 'call', text: truncate(n.text), callee, items: children(field(n, 'arguments')).map(toArg), line };
      }
      default:
        return { kind: 'other', text: truncate(n.text), line };
    }
  };

  const recordParams = (fn: Node, sym: CodeSymbol, fieldName = 'parameters') => {
    for (const p of children(field(fn, fieldName))) {
      if (p.type !== 'parameter_declaration') continue;
      const t = baseTypeName(field(p, 'type')?.text).name;
      for (const nm of p.childrenForFieldName('name')) if (nm && t) c.facts.vars.push({ scope: sym.id, name: nm.text, type: t, line: p.startPosition.row + 1 });
    }
  };

  walk(
    tree,
    INTERESTING,
    (n) => {
      switch (n.type) {
        case 'function_declaration': {
          const nm = field(n, 'name');
          if (!nm) return;
          const sym = c.addSymbol({ node: n, nameNode: nm, name: nm.text, kind: 'function', exported: /^[A-Z]/.test(nm.text) });
          recordParams(n, sym);
          c.pushScope('func', sym);
          return 1;
        }
        case 'method_declaration': {
          const nm = field(n, 'name');
          if (!nm) return;
          const recv = children(field(n, 'receiver')).find((p) => p.type === 'parameter_declaration');
          const recvType = baseTypeName(field(recv, 'type')?.text).name;
          const sym = c.addSymbol({ node: n, nameNode: nm, name: nm.text, kind: 'method', exported: /^[A-Z]/.test(nm.text) });
          if (recvType) {
            sym.container = recvType;
            sym.id = c.symbolId(nm.text, sym.range.sl, recvType);
          }
          recordParams(n, sym);
          recordParams(n, sym, 'receiver');
          c.pushScope('func', sym);
          return 1;
        }
        case 'type_spec': {
          const nm = field(n, 'name');
          const t = field(n, 'type');
          if (!nm || !t) return;
          if (t.type === 'struct_type') {
            const sym = c.addSymbol({ node: n, nameNode: nm, name: nm.text, kind: 'struct', exported: /^[A-Z]/.test(nm.text), signature: `type ${nm.text} struct` });
            const list = children(t).find((x) => x.type === 'field_declaration_list');
            const supers: string[] = [];
            for (const f of children(list)) {
              if (f.type !== 'field_declaration') continue;
              const ft = baseTypeName(field(f, 'type')?.text);
              const names = f.childrenForFieldName('name').filter((x): x is Node => !!x);
              if (!names.length && ft.name) supers.push(ft.name); // embedded struct
              const tag = children(f).find((x) => x.type === 'raw_string_literal' || x.type === 'interpreted_string_literal');
              for (const fn of names)
                c.facts.fields.push({ ownerId: sym.id, owner: sym.name, name: fn.text, type: ft.name, typeArgs: ft.args, value: tag?.text, annotations: [], range: rangeOf(f) });
            }
            if (supers.length) sym.supers = supers;
          } else if (t.type === 'interface_type') {
            const sym = c.addSymbol({ node: n, nameNode: nm, name: nm.text, kind: 'interface', exported: /^[A-Z]/.test(nm.text), signature: `type ${nm.text} interface` });
            for (const m of children(t)) {
              const mn = m.type === 'method_spec' || m.type === 'method_elem' ? field(m, 'name') : null;
              if (mn) c.addSymbol({ node: m, nameNode: mn, name: mn.text, kind: 'method', container: sym, signature: truncate(m.text) });
            }
          }
          return;
        }
        case 'func_literal': {
          if (n.parent?.type !== 'argument_list') return;
          const call = n.parent.parent;
          const fn = call ? field(call, 'function') : null;
          const callee = fn?.type === 'selector_expression' ? field(fn, 'field')?.text : fn?.text;
          const firstStr = children(n.parent).find((a) => a.type === 'interpreted_string_literal' || a.type === 'raw_string_literal');
          const sym = c.addSymbol({ node: n, name: `${callee ?? 'callback'}(${firstStr ? firstStr.text : '…'}) callback`, kind: 'handler', id: c.anonId(n) });
          recordParams(n, sym);
          c.pushScope('func', sym);
          return 1;
        }
        case 'call_expression': {
          const fn = field(n, 'function');
          if (!fn) return;
          const args = children(field(n, 'arguments')).map(toArg);
          if (fn.type === 'identifier') c.addCall(n, fn.text, undefined, args, false, fn);
          else if (fn.type === 'selector_expression') {
            const f = field(fn, 'field');
            if (f) c.addCall(n, f.text, field(fn, 'operand')?.text, args, false, f);
          }
          return;
        }
        case 'import_spec': {
          const p = unquote(field(n, 'path')?.text ?? '');
          if (!p) return;
          const name = field(n, 'name')?.text;
          c.facts.imports.push({ source: p, local: name ?? p.split('/').pop()!, imported: '*', line: n.startPosition.row + 1 });
          return;
        }
        case 'short_var_declaration': {
          const left = children(field(n, 'left'));
          const right = children(field(n, 'right'));
          left.forEach((l, i) => {
            const r = right[i] ?? (right.length === 1 ? right[0] : undefined);
            if (l.type !== 'identifier' || !r) return;
            let type: string | undefined;
            let call: { callee: string; receiver?: string; args: Arg[] } | undefined;
            let v: Node | null = r;
            if (v.type === 'unary_expression') v = field(v, 'operand');
            if (v?.type === 'composite_literal') type = baseTypeName(field(v, 'type')?.text).name;
            if (v?.type === 'call_expression') {
              const fn = field(v, 'function');
              const callee = fn?.type === 'selector_expression' ? field(fn, 'field')?.text : fn?.text;
              call = { callee: callee ?? '?', receiver: fn?.type === 'selector_expression' ? field(fn, 'operand')?.text : undefined, args: children(field(v, 'arguments')).map(toArg) };
              // Constructor convention: NewFoo() returns *Foo
              const m = /^New([A-Z]\w*)$/.exec(callee ?? '');
              if (m && i === 0) type = m[1];
            }
            c.facts.vars.push({ scope: c.scopeId, name: l.text, type, call, line: n.startPosition.row + 1 });
          });
          return;
        }
        case 'var_spec': {
          const t = baseTypeName(field(n, 'type')?.text).name;
          for (const nm of n.childrenForFieldName('name')) if (nm) c.facts.vars.push({ scope: c.scopeId, name: nm.text, type: t, line: n.startPosition.row + 1 });
          return;
        }
        case 'interpreted_string_literal':
        case 'raw_string_literal': {
          const v = unquote(n.text);
          if (v) c.addString(v, n);
          return;
        }
      }
    },
    c,
  );
}
