import type { Node, Tree } from 'web-tree-sitter';
import type { Annotation, Arg, CodeSymbol } from '../types';
import { Collector, baseTypeName, children, field, rangeOf, truncate, unquote, walk } from './collector';

const INTERESTING = new Set([
  'class_declaration',
  'interface_declaration',
  'struct_declaration',
  'record_declaration',
  'enum_declaration',
  'method_declaration',
  'constructor_declaration',
  'local_function_statement',
  'field_declaration',
  'property_declaration',
  'local_declaration_statement',
  'invocation_expression',
  'object_creation_expression',
  'using_directive',
  'string_literal',
  'verbatim_string_literal',
  'raw_string_literal',
  'lambda_expression',
]);

export function extractCsharp(c: Collector, tree: Tree) {
  const toArg = (n: Node, key?: string): Arg => {
    const line = n.startPosition.row + 1;
    if (n.type === 'argument' || n.type === 'attribute_argument') {
      const nameEq = children(n).find((x) => x.type === 'name_equals' || x.type === 'name_colon');
      const val = children(n).filter((x) => x.type !== 'name_equals' && x.type !== 'name_colon').pop();
      const k = nameEq ? nameEq.text.replace(/[=:]\s*$/, '').trim() : key;
      return val ? toArg(val, k) : { kind: 'other', text: n.text, key: k, line };
    }
    switch (n.type) {
      case 'string_literal':
      case 'verbatim_string_literal':
      case 'raw_string_literal':
        return { kind: 'string', text: truncate(n.text, 200), value: unquote(n.text), key, line };
      case 'integer_literal':
      case 'real_literal':
        return { kind: 'number', text: n.text, key, line };
      case 'identifier':
        return { kind: 'ident', text: n.text, key, line };
      case 'member_access_expression':
        return { kind: 'member', text: n.text, key, line };
      case 'lambda_expression':
        return { kind: 'func', text: truncate(n.text, 60), symbolId: c.anonId(n), key, line };
      case 'typeof_expression':
        return { kind: 'ident', text: n.text.replace(/^typeof\s*\(|\)$/g, ''), key, line };
      default:
        return { kind: 'other', text: truncate(n.text), key, line };
    }
  };

  const attributesOf = (n: Node): Annotation[] => {
    const out: Annotation[] = [];
    for (const list of children(n)) {
      if (list.type !== 'attribute_list') continue;
      for (const a of children(list)) {
        if (a.type !== 'attribute') continue;
        const name = (baseTypeName(field(a, 'name')?.text).name ?? '?').replace(/Attribute$/, '');
        const argList = children(a).find((x) => x.type === 'attribute_argument_list');
        out.push({ name, args: children(argList).map((x) => toArg(x)) });
      }
    }
    return out;
  };

  const calleeOf = (fn: Node | null): { name?: string; receiver?: string; node?: Node | null } => {
    if (!fn) return {};
    if (fn.type === 'identifier') return { name: fn.text, node: fn };
    if (fn.type === 'generic_name') return { name: children(fn).find((x) => x.type === 'identifier')?.text, node: fn };
    if (fn.type === 'member_access_expression') {
      const nm = field(fn, 'name');
      const name = nm?.type === 'generic_name' ? children(nm).find((x) => x.type === 'identifier')?.text : nm?.text;
      return { name, receiver: field(fn, 'expression')?.text, node: nm };
    }
    return {};
  };

  const recordParams = (fn: Node, sym: CodeSymbol) => {
    for (const p of children(field(fn, 'parameters'))) {
      if (p.type !== 'parameter') continue;
      const t = baseTypeName(field(p, 'type')?.text).name;
      const nm = field(p, 'name')?.text;
      if (t && nm) c.facts.vars.push({ scope: sym.id, name: nm, type: t, line: p.startPosition.row + 1 });
    }
  };

  walk(
    tree,
    INTERESTING,
    (n) => {
      switch (n.type) {
        case 'class_declaration':
        case 'interface_declaration':
        case 'struct_declaration':
        case 'record_declaration':
        case 'enum_declaration': {
          const nm = field(n, 'name');
          if (!nm) return;
          const supers: string[] = [];
          const superArgs: Record<string, string[]> = {};
          const bases = field(n, 'bases') ?? children(n).find((x) => x.type === 'base_list');
          for (const b of children(bases)) {
            const t = baseTypeName(b.text);
            if (t.name) {
              supers.push(t.name);
              if (t.args.length) superArgs[t.name] = t.args;
            }
          }
          const kind = n.type === 'interface_declaration' ? 'interface' : n.type === 'struct_declaration' ? 'struct' : n.type === 'enum_declaration' ? 'enum' : 'class';
          const sym = c.addSymbol({ node: n, nameNode: nm, name: nm.text, kind, annotations: attributesOf(n), supers, superArgs, exported: true });
          c.pushScope('class', sym);
          return 1;
        }
        case 'method_declaration':
        case 'constructor_declaration':
        case 'local_function_statement': {
          const nm = field(n, 'name');
          if (!nm) return;
          const sym = c.addSymbol({ node: n, nameNode: nm, name: nm.text, kind: n.type === 'constructor_declaration' ? 'constructor' : c.currentClass ? 'method' : 'function', annotations: attributesOf(n) });
          recordParams(n, sym);
          c.pushScope('func', sym);
          return 1;
        }
        case 'lambda_expression': {
          if (n.parent?.type !== 'argument') return;
          const call = n.parent.parent?.parent;
          const callee = call ? calleeOf(field(call, 'function')).name : undefined;
          const sym = c.addSymbol({ node: n, name: `${callee ?? 'callback'}(…) lambda`, kind: 'handler', id: c.anonId(n) });
          c.pushScope('func', sym);
          return 1;
        }
        case 'field_declaration':
        case 'property_declaration': {
          const cls = c.currentClass;
          if (!cls) return;
          const anns = attributesOf(n);
          if (n.type === 'property_declaration') {
            const t = baseTypeName(field(n, 'type')?.text);
            const nm = field(n, 'name')?.text;
            if (nm) c.facts.fields.push({ ownerId: cls.id, owner: cls.name, name: nm, type: t.name, typeArgs: t.args, annotations: anns, range: rangeOf(n) });
            return;
          }
          const vd = children(n).find((x) => x.type === 'variable_declaration');
          const t = baseTypeName(field(vd, 'type')?.text);
          for (const d of children(vd)) {
            if (d.type !== 'variable_declarator') continue;
            const nm = field(d, 'name')?.text ?? children(d).find((x) => x.type === 'identifier')?.text;
            if (nm) c.facts.fields.push({ ownerId: cls.id, owner: cls.name, name: nm, type: t.name, typeArgs: t.args, annotations: anns, range: rangeOf(n) });
          }
          return;
        }
        case 'local_declaration_statement': {
          const vd = children(n).find((x) => x.type === 'variable_declaration');
          const tNode = field(vd, 'type');
          for (const d of children(vd)) {
            if (d.type !== 'variable_declarator') continue;
            const nm = field(d, 'name')?.text ?? children(d).find((x) => x.type === 'identifier')?.text;
            let type = tNode && tNode.type !== 'implicit_type' ? baseTypeName(tNode.text).name : undefined;
            if (!type) {
              const oc = d.descendantsOfType('object_creation_expression')[0];
              if (oc) type = baseTypeName(field(oc, 'type')?.text).name;
            }
            if (nm) c.facts.vars.push({ scope: c.scopeId, name: nm, type, line: n.startPosition.row + 1 });
          }
          return;
        }
        case 'invocation_expression': {
          const { name, receiver, node } = calleeOf(field(n, 'function'));
          if (name) c.addCall(n, name, receiver, children(field(n, 'arguments')).map((a) => toArg(a)), false, node);
          return;
        }
        case 'object_creation_expression': {
          const t = baseTypeName(field(n, 'type')?.text).name;
          if (t) c.addCall(n, t, undefined, children(field(n, 'arguments')).map((a) => toArg(a)), true, field(n, 'type'));
          return;
        }
        case 'using_directive': {
          const nm = children(n).find((x) => x.type === 'qualified_name' || x.type === 'identifier');
          if (nm) c.facts.imports.push({ source: nm.text, local: '*', imported: '*', line: n.startPosition.row + 1 });
          return;
        }
        case 'string_literal':
        case 'verbatim_string_literal':
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
