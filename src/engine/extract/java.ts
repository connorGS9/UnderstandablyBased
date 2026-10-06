import type { Node, Tree } from 'web-tree-sitter';
import type { Annotation, Arg } from '../types';
import { Collector, baseTypeName, children, field, rangeOf, truncate, unquote, walk } from './collector';

const INTERESTING = new Set([
  'class_declaration',
  'interface_declaration',
  'enum_declaration',
  'record_declaration',
  'method_declaration',
  'constructor_declaration',
  'compact_constructor_declaration',
  'field_declaration',
  'local_variable_declaration',
  'method_invocation',
  'object_creation_expression',
  'import_declaration',
  'string_literal',
  'text_block',
  'lambda_expression',
  'enhanced_for_statement',
  'catch_formal_parameter',
]);

export function extractJava(c: Collector, tree: Tree) {
  const toArg = (n: Node, key?: string): Arg => {
    const line = n.startPosition.row + 1;
    switch (n.type) {
      case 'string_literal':
      case 'text_block':
        return { kind: 'string', text: truncate(n.text, 200), value: unquote(n.text.replace(/^"""|"""$/g, '"')), key, line };
      case 'decimal_integer_literal':
      case 'decimal_floating_point_literal':
        return { kind: 'number', text: n.text, key, line };
      case 'identifier':
        return { kind: 'ident', text: n.text, key, line };
      case 'field_access':
      case 'scoped_identifier':
        return { kind: 'member', text: n.text, key, line };
      case 'element_value_array_initializer':
      case 'array_initializer':
        return { kind: 'array', text: truncate(n.text), items: children(n).map((x) => toArg(x)), key, line };
      case 'annotation':
      case 'marker_annotation': {
        const a = annotationOf(n);
        return { kind: 'call', text: truncate(n.text), callee: a.name, items: a.args, key, line };
      }
      case 'lambda_expression':
        return { kind: 'func', text: truncate(n.text, 60), symbolId: c.anonId(n), key, line };
      case 'method_invocation':
        return { kind: 'call', text: truncate(n.text), callee: field(n, 'name')?.text, key, line };
      case 'class_literal':
        return { kind: 'ident', text: n.text.replace(/\.class$/, ''), key, line };
      default:
        return { kind: 'other', text: truncate(n.text), key, line };
    }
  };

  const annotationOf = (n: Node): Annotation => {
    const name = baseTypeName(field(n, 'name')?.text).name ?? '?';
    const args: Arg[] = [];
    for (const a of children(field(n, 'arguments'))) {
      if (a.type === 'element_value_pair') {
        const v = field(a, 'value');
        if (v) args.push(toArg(v, field(a, 'key')?.text));
      } else args.push(toArg(a));
    }
    return { name, args };
  };

  const annotationsOf = (n: Node): Annotation[] => {
    const mods = children(n).find((x) => x.type === 'modifiers');
    return children(mods)
      .filter((x) => x.type === 'annotation' || x.type === 'marker_annotation')
      .map(annotationOf);
  };

  const supersOf = (n: Node) => {
    const supers: string[] = [];
    const superArgs: Record<string, string[]> = {};
    const add = (t: Node) => {
      const b = baseTypeName(t.text);
      if (b.name) {
        supers.push(b.name);
        if (b.args.length) superArgs[b.name] = b.args;
      }
    };
    const sc = field(n, 'superclass');
    if (sc) children(sc).forEach(add);
    for (const part of children(n)) {
      if (part.type === 'super_interfaces' || part.type === 'extends_interfaces') {
        for (const tl of children(part)) children(tl).forEach(add);
      }
    }
    return { supers, superArgs };
  };

  walk(
    tree,
    INTERESTING,
    (n) => {
      switch (n.type) {
        case 'class_declaration':
        case 'interface_declaration':
        case 'enum_declaration':
        case 'record_declaration': {
          const nm = field(n, 'name');
          if (!nm) return;
          const s = supersOf(n);
          const sym = c.addSymbol({
            node: n,
            nameNode: nm,
            name: nm.text,
            kind: n.type === 'interface_declaration' ? 'interface' : n.type === 'enum_declaration' ? 'enum' : 'class',
            annotations: annotationsOf(n),
            supers: s.supers,
            superArgs: s.superArgs,
            exported: true,
          });
          c.pushScope('class', sym);
          return 1;
        }
        case 'method_declaration':
        case 'constructor_declaration':
        case 'compact_constructor_declaration': {
          const nm = field(n, 'name');
          if (!nm) return;
          const sym = c.addSymbol({
            node: n,
            nameNode: nm,
            name: nm.text,
            kind: n.type === 'method_declaration' ? 'method' : 'constructor',
            annotations: annotationsOf(n),
          });
          for (const p of children(field(n, 'parameters'))) {
            if (p.type !== 'formal_parameter' && p.type !== 'spread_parameter') continue;
            const t = baseTypeName(field(p, 'type')?.text);
            const pn = field(p, 'name')?.text;
            if (pn && t.name) c.facts.vars.push({ scope: sym.id, name: pn, type: t.name, line: p.startPosition.row + 1 });
          }
          c.pushScope('func', sym);
          return 1;
        }
        case 'lambda_expression': {
          if (n.parent?.type !== 'argument_list') return;
          const call = n.parent.parent;
          const callee = call ? field(call, 'name')?.text ?? field(call, 'type')?.text : undefined;
          const firstStr = children(n.parent).find((a) => a.type === 'string_literal');
          const sym = c.addSymbol({ node: n, name: `${callee ?? 'callback'}(${firstStr ? firstStr.text : '…'}) callback`, kind: 'handler', id: c.anonId(n) });
          c.pushScope('func', sym);
          return 1;
        }
        case 'field_declaration': {
          const cls = c.currentClass;
          if (!cls) return;
          const t = baseTypeName(field(n, 'type')?.text);
          const anns = annotationsOf(n);
          for (const d of children(n)) {
            if (d.type !== 'variable_declarator') continue;
            const nm = field(d, 'name')?.text;
            const value = field(d, 'value');
            if (nm)
              c.facts.fields.push({
                ownerId: cls.id,
                owner: cls.name,
                name: nm,
                type: t.name,
                typeArgs: t.args,
                value: value ? truncate(value.text, 160) : undefined,
                annotations: anns,
                range: rangeOf(n),
              });
          }
          return;
        }
        case 'enhanced_for_statement': {
          const t = baseTypeName(field(n, 'type')?.text).name;
          const nm = field(n, 'name')?.text;
          if (t && nm && t !== 'var') c.facts.vars.push({ scope: c.scopeId, name: nm, type: t, line: n.startPosition.row + 1 });
          return;
        }
        case 'catch_formal_parameter':
          return;
        case 'local_variable_declaration': {
          const tText = field(n, 'type')?.text;
          for (const d of children(n)) {
            if (d.type !== 'variable_declarator') continue;
            const nm = field(d, 'name')?.text;
            const value = field(d, 'value');
            let type = tText === 'var' ? undefined : baseTypeName(tText).name;
            if (!type && value?.type === 'object_creation_expression') type = baseTypeName(field(value, 'type')?.text).name;
            if (nm) c.facts.vars.push({ scope: c.scopeId, name: nm, type, line: n.startPosition.row + 1 });
          }
          return;
        }
        case 'method_invocation': {
          const nm = field(n, 'name');
          if (!nm) return;
          const obj = field(n, 'object');
          c.addCall(n, nm.text, obj?.text, children(field(n, 'arguments')).map((a) => toArg(a)), false, nm);
          return;
        }
        case 'object_creation_expression': {
          const t = baseTypeName(field(n, 'type')?.text).name;
          if (t) c.addCall(n, t, undefined, children(field(n, 'arguments')).map((a) => toArg(a)), true, field(n, 'type'));
          return;
        }
        case 'import_declaration': {
          const id = children(n).find((x) => x.type === 'scoped_identifier' || x.type === 'identifier');
          if (!id) return;
          const full = id.text;
          const isStar = children(n).some((x) => x.type === 'asterisk');
          const last = full.split('.').pop()!;
          c.facts.imports.push({ source: full, local: isStar ? '*' : last, imported: isStar ? '*' : last, line: n.startPosition.row + 1 });
          return;
        }
        case 'string_literal':
        case 'text_block': {
          const v = unquote(n.text.replace(/^"""|"""$/g, '"'));
          if (v) c.addString(v, n);
          return;
        }
      }
    },
    c,
  );
}
