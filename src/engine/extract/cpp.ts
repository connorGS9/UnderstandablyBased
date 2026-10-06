import type { Node, Tree } from 'web-tree-sitter';
import type { Arg, CodeSymbol } from '../types';
import { Collector, baseTypeName, children, field, rangeOf, truncate, unquote, walk } from './collector';

const INTERESTING = new Set([
  'class_specifier',
  'struct_specifier',
  'function_definition',
  'field_declaration',
  'declaration',
  'call_expression',
  'preproc_include',
  'string_literal',
  'raw_string_literal',
  'lambda_expression',
  'new_expression',
  'alias_declaration',
  'type_definition',
]);

/** Unwraps pointer/reference declarators to reach the function_declarator. */
function functionDeclarator(n: Node | null): Node | null {
  let cur = n;
  for (let i = 0; cur && i < 6; i++) {
    if (cur.type === 'function_declarator') return cur;
    cur = field(cur, 'declarator');
  }
  return null;
}

function innerName(n: Node | null): Node | null {
  let cur = n;
  for (let i = 0; cur && i < 6; i++) {
    if (cur.type === 'identifier' || cur.type === 'field_identifier') return cur;
    cur = field(cur, 'declarator') ?? cur.namedChild(0);
  }
  return null;
}

export function extractCpp(c: Collector, tree: Tree) {
  const toArg = (n: Node): Arg => {
    const line = n.startPosition.row + 1;
    switch (n.type) {
      case 'string_literal':
      case 'raw_string_literal':
        return { kind: 'string', text: truncate(n.text, 200), value: stringValue(n), line };
      case 'concatenated_string':
        return { kind: 'string', text: truncate(n.text, 200), value: children(n).map((s) => stringValue(s) ?? '').join(''), line };
      case 'number_literal':
        return { kind: 'number', text: n.text, line };
      case 'identifier':
        return { kind: 'ident', text: n.text, line };
      case 'field_expression':
      case 'qualified_identifier':
        return { kind: 'member', text: n.text, line };
      case 'lambda_expression':
        return { kind: 'func', text: truncate(n.text, 60), symbolId: c.anonId(n), line };
      case 'call_expression': {
        const fn = field(n, 'function');
        return { kind: 'call', text: truncate(n.text), callee: calleeName(fn), items: children(field(n, 'arguments')).map(toArg), line };
      }
      default:
        return { kind: 'other', text: truncate(n.text), line };
    }
  };

  const stringValue = (n: Node): string | undefined => {
    if (n.type === 'raw_string_literal') {
      const m = /R"([^(]*)\(([\s\S]*)\)\1"/.exec(n.text);
      return m ? m[2] : undefined;
    }
    const content = children(n).find((x) => x.type === 'string_content');
    return content ? content.text : unquote(n.text.replace(/^(u8|u|U|L)/, '')) ?? '';
  };

  const calleeName = (fn: Node | null): string | undefined => {
    if (!fn) return undefined;
    if (fn.type === 'identifier' || fn.type === 'field_identifier') return fn.text;
    if (fn.type === 'field_expression') return calleeName(field(fn, 'field'));
    if (fn.type === 'qualified_identifier') return calleeName(field(fn, 'name'));
    if (fn.type === 'template_function') return field(fn, 'name')?.text;
    if (fn.type === 'template_method') return field(fn, 'name')?.text;
    if (fn.type === 'destructor_name') return fn.text;
    return undefined;
  };

  const calleeNode = (fn: Node | null): Node | null => {
    if (!fn) return null;
    if (fn.type === 'identifier' || fn.type === 'field_identifier') return fn;
    if (fn.type === 'field_expression') return field(fn, 'field');
    if (fn.type === 'qualified_identifier') return calleeNode(field(fn, 'name'));
    if (fn.type === 'template_function' || fn.type === 'template_method') return field(fn, 'name');
    return fn;
  };

  const recordParams = (decl: Node, sym: CodeSymbol) => {
    for (const p of children(field(decl, 'parameters'))) {
      if (p.type !== 'parameter_declaration' && p.type !== 'optional_parameter_declaration') continue;
      const t = baseTypeName(field(p, 'type')?.text).name;
      const nm = innerName(field(p, 'declarator'));
      if (nm && t) c.facts.vars.push({ scope: sym.id, name: nm.text, type: t, line: p.startPosition.row + 1 });
    }
  };

  walk(
    tree,
    INTERESTING,
    (n) => {
      switch (n.type) {
        case 'class_specifier':
        case 'struct_specifier': {
          const body = field(n, 'body');
          const nm = field(n, 'name');
          if (!body || !nm) return; // forward declarations / anonymous structs
          const supers: string[] = [];
          const superArgs: Record<string, string[]> = {};
          for (const ch of children(n)) {
            if (ch.type !== 'base_class_clause') continue;
            for (const b of children(ch)) {
              if (b.type === 'access_specifier') continue;
              const t = baseTypeName(b.text);
              if (t.name) {
                supers.push(t.name);
                if (t.args.length) superArgs[t.name] = t.args;
              }
            }
          }
          const name = baseTypeName(nm.text).name ?? nm.text;
          const sym = c.addSymbol({ node: n, nameNode: nm, name, kind: n.type === 'class_specifier' ? 'class' : 'struct', supers, superArgs, signature: truncate(c.src.slice(n.startIndex, body.startIndex), 200), exported: true });
          c.pushScope('class', sym);
          return 1;
        }
        case 'function_definition': {
          const decl = functionDeclarator(field(n, 'declarator'));
          if (!decl) return;
          const target = field(decl, 'declarator');
          if (!target) return;
          let name = target.text;
          let containerName: string | undefined;
          let nameNode: Node = target;
          if (target.type === 'qualified_identifier') {
            // ns::Class::method -> container "Class", name "method"
            const parts = target.text.replace(/<[^<>]*>/g, '').split('::');
            name = parts[parts.length - 1];
            containerName = parts.length > 1 ? parts[parts.length - 2] : undefined;
            let inner: Node | null = target;
            while (inner && inner.type === 'qualified_identifier') inner = field(inner, 'name');
            if (inner) nameNode = inner;
          }
          const cls = c.currentClass;
          const kind = containerName || cls ? (name === (containerName ?? cls?.name) ? 'constructor' : 'method') : 'function';
          const sym = c.addSymbol({ node: n, nameNode, name, kind, signature: c.signature(n), exported: true });
          if (containerName && !cls) {
            sym.container = containerName;
            sym.id = c.symbolId(name, sym.range.sl, containerName);
          }
          recordParams(decl, sym);
          c.pushScope('func', sym);
          return 1;
        }
        case 'lambda_expression': {
          if (n.parent?.type !== 'argument_list') return;
          const call = n.parent.parent;
          const callee = call ? calleeName(field(call, 'function')) : undefined;
          const sym = c.addSymbol({ node: n, name: `${callee ?? 'callback'}(…) lambda`, kind: 'handler', id: c.anonId(n) });
          c.pushScope('func', sym);
          return 1;
        }
        case 'field_declaration': {
          const cls = c.currentClass;
          if (!cls || c.scopeId !== c.fileScope) return;
          const decl = field(n, 'declarator');
          if (!decl || functionDeclarator(decl)) return; // method declarations
          const t = baseTypeName(field(n, 'type')?.text);
          for (const d of n.childrenForFieldName('declarator')) {
            const nm = innerName(d);
            if (nm) c.facts.fields.push({ ownerId: cls.id, owner: cls.name, name: nm.text, type: t.name, typeArgs: t.args, annotations: [], range: rangeOf(n) });
          }
          return;
        }
        case 'declaration': {
          const tNode = field(n, 'type');
          const tText = tNode?.text ?? '';
          for (const d of n.childrenForFieldName('declarator')) {
            if (!d) continue;
            // Most vexing parse: inside a function body `Foo foo(bar);` is a variable constructed with `bar`,
            // even though the grammar reads it as a function declaration.
            if (d.type === 'function_declarator' && c.scopeId !== c.fileScope) {
              const vn = field(d, 'declarator');
              const type = baseTypeName(tText).name;
              if (vn?.type === 'identifier' && type && /^[A-Z]/.test(type)) {
                const params = children(field(d, 'parameters')).map((p) => ({ kind: 'ident' as const, text: p.text, line: p.startPosition.row + 1 }));
                c.facts.vars.push({ scope: c.scopeId, name: vn.text, type, call: { callee: type, args: params }, line: n.startPosition.row + 1 });
                c.addCall(d, type, undefined, params, true, tNode);
              }
              continue;
            }
            if (functionDeclarator(d)) continue;
            const nm = innerName(d);
            if (!nm) continue;
            let type = tText === 'auto' ? undefined : baseTypeName(tText).name;
            const value = d.type === 'init_declarator' ? field(d, 'value') : null;
            let call: { callee: string; receiver?: string; args: Arg[] } | undefined;
            if (value?.type === 'call_expression') {
              const fn = field(value, 'function');
              const callee = calleeName(fn);
              call = { callee: callee ?? '?', receiver: fn?.type === 'field_expression' ? field(fn, 'argument')?.text : fn?.type === 'qualified_identifier' ? field(fn, 'scope')?.text : undefined, args: children(field(value, 'arguments')).map(toArg) };
              if (!type && fn) {
                // auto x = make_unique<Foo>() / auto x = Foo(...)
                const tf = fn.type === 'qualified_identifier' ? field(fn, 'name') : fn;
                if (tf?.type === 'template_function') type = baseTypeName(field(tf, 'arguments')?.text.slice(1, -1)).name;
                else if (callee && /^[A-Z]/.test(callee)) type = callee;
              }
            } else if (value?.type === 'new_expression') type = type ?? baseTypeName(field(value, 'type')?.text).name;
            // Constructor-style declarations: `Foo foo(args);` / `boost::interprocess::shared_memory_object shm(open_or_create, "name", ...)`
            if (d.type === 'init_declarator' && !value) {
              const argList = children(d).find((x) => x.type === 'argument_list');
              if (argList) call = { callee: type ?? '?', args: children(argList).map(toArg) };
            }
            c.facts.vars.push({ scope: c.scopeId, name: nm.text, type, call, line: n.startPosition.row + 1 });
            if (call && d.type === 'init_declarator' && !value) c.addCall(d, call.callee, undefined, call.args, true, tNode);
            // `OrderGateway gateway;` runs the default constructor of a user-defined class.
            else if (!call && type && /^[A-Z]/.test(type) && c.scopeId !== c.fileScope && (d.type === 'identifier' || d.type === 'init_declarator')) c.addCall(n, type, undefined, [], true, tNode);
          }
          return;
        }
        case 'call_expression': {
          const fn = field(n, 'function');
          const name = calleeName(fn);
          if (!fn || !name) return;
          let receiver: string | undefined;
          if (fn.type === 'field_expression') receiver = field(fn, 'argument')?.text;
          else if (fn.type === 'qualified_identifier') receiver = field(fn, 'scope')?.text;
          c.addCall(n, name, receiver, children(field(n, 'arguments')).map(toArg), false, calleeNode(fn));
          return;
        }
        case 'new_expression': {
          const t = baseTypeName(field(n, 'type')?.text).name;
          if (t) c.addCall(n, t, undefined, children(field(n, 'arguments')).map(toArg), true, field(n, 'type'));
          return;
        }
        case 'alias_declaration':
        case 'type_definition': {
          const nm = n.type === 'alias_declaration' ? field(n, 'name') : innerName(field(n, 'declarator'));
          const t = baseTypeName(field(n, 'type')?.text).name;
          if (nm && t && nm.text !== t) (c.facts.aliases ??= []).push({ name: nm.text, target: t });
          return;
        }
        case 'preproc_include': {
          const p = field(n, 'path');
          if (!p) return;
          const source = p.type === 'system_lib_string' ? p.text.slice(1, -1) : stringValue(p) ?? '';
          c.facts.imports.push({ source, local: p.type === 'system_lib_string' ? '<system>' : '', imported: '#include', line: n.startPosition.row + 1 });
          return;
        }
        case 'string_literal':
        case 'raw_string_literal': {
          const v = stringValue(n);
          if (v) c.addString(v, n);
          return;
        }
      }
    },
    c,
  );
}
