import type { Node, Tree } from 'web-tree-sitter';
import type { Annotation, Arg, CodeSymbol } from '../types';
import { Collector, baseTypeName, children, field, rangeOf, truncate, unquote, walk } from './collector';

const INTERESTING = new Set([
  'class_declaration',
  'abstract_class_declaration',
  'interface_declaration',
  'enum_declaration',
  'function_declaration',
  'generator_function_declaration',
  'method_definition',
  'arrow_function',
  'function_expression',
  'function',
  'call_expression',
  'new_expression',
  'import_statement',
  'export_statement',
  'variable_declarator',
  'assignment_expression',
  'public_field_definition',
  'field_definition',
  'string',
  'template_string',
  'jsx_self_closing_element',
  'jsx_opening_element',
  'object',
]);

const ROUTE_COMPONENT_KEYS = new Set(['component', 'element', 'loadComponent', 'Component', 'lazy', 'components', 'loadChildren']);

const FUNC_TYPES = new Set(['arrow_function', 'function_expression', 'function']);

function isDefaultExport(n: Node | null): boolean {
  return !!n && n.type === 'export_statement' && n.children.some((c) => c?.type === 'default');
}

function typeOfAnnotation(n: Node | null): { name?: string; args: string[] } {
  if (!n) return { args: [] };
  // type_annotation -> ": Foo<Bar>"
  return baseTypeName(n.text.replace(/^:\s*/, ''));
}

export function extractJs(c: Collector, tree: Tree) {
  const src = c.src;

  const keyOf = (pair: Node) => {
    const k = field(pair, 'key');
    return k ? unquote(k.text) ?? k.text : '';
  };
  const pairValue = (obj: Node, key: string) => children(obj).find((p) => p.type === 'pair' && keyOf(p) === key)?.childForFieldName('value') ?? null;

  /** What a route renders: `UserList`, `<Home />`, or a lazy `() => import('./x')` (+ `.then(m => m.X)`). */
  const routeComponent = (obj: Node): { component?: string; importSource?: string } => {
    for (const key of ROUTE_COMPONENT_KEYS) {
      const v = pairValue(obj, key);
      if (!v) continue;
      if (v.type === 'identifier' || v.type === 'member_expression') return { component: v.text.split('.').pop() };
      if (v.type === 'jsx_self_closing_element' || v.type === 'jsx_element') {
        const tag = v.type === 'jsx_element' ? field(field(v, 'open_tag'), 'name') : field(v, 'name');
        return { component: tag?.text };
      }
      const imp = v.descendantsOfType('import')[0];
      const call = imp?.parent;
      const source = call ? unquote(children(field(call, 'arguments'))[0]?.text ?? '') : undefined;
      const then = /\.then\(\s*\(?\s*(\w+)\s*\)?\s*=>\s*\1\.(\w+)/.exec(v.text);
      if (source) return { importSource: source, component: then?.[2] };
    }
    return {};
  };

  const toArg = (n: Node): Arg => {
    const line = n.startPosition.row + 1;
    switch (n.type) {
      case 'string':
      case 'template_string': {
        return { kind: 'string', text: truncate(n.text, 200), value: unquote(n.text), line };
      }
      case 'number':
        return { kind: 'number', text: n.text, line };
      case 'identifier':
        return { kind: 'ident', text: n.text, line };
      case 'member_expression':
        return { kind: 'member', text: truncate(n.text), line };
      case 'arrow_function':
      case 'function_expression':
      case 'function':
        return { kind: 'func', text: truncate(n.text, 60), symbolId: c.anonId(n), line };
      case 'call_expression': {
        const fn = field(n, 'function');
        const callee = fn?.type === 'member_expression' ? field(fn, 'property')?.text : fn?.text;
        const inner = children(field(n, 'arguments')).map(toArg);
        return { kind: 'call', text: truncate(n.text), callee, items: inner, value: inner[0]?.value, line };
      }
      case 'array':
        return { kind: 'array', text: truncate(n.text), items: children(n).map(toArg), line };
      case 'object': {
        const items: Arg[] = [];
        for (const p of children(n)) {
          if (p.type === 'pair') {
            const k = field(p, 'key');
            const v = field(p, 'value');
            if (k && v) items.push({ ...toArg(v), key: unquote(k.text) ?? k.text });
          } else if (p.type === 'shorthand_property_identifier') {
            items.push({ kind: 'ident', text: p.text, key: p.text, line: p.startPosition.row + 1 });
          }
        }
        return { kind: 'object', text: truncate(n.text), items, line };
      }
      default:
        return { kind: 'other', text: truncate(n.text), line };
    }
  };

  const decoratorsOf = (n: Node): Annotation[] => {
    const decos: Node[] = [];
    // Decorators can be direct children (class) or preceding siblings (methods/fields in class bodies).
    for (const ch of children(n)) if (ch.type === 'decorator') decos.push(ch);
    if (n.parent?.type === 'export_statement') for (const ch of children(n.parent)) if (ch.type === 'decorator') decos.push(ch);
    let prev = n.previousNamedSibling;
    while (prev && prev.type === 'decorator') {
      decos.unshift(prev);
      prev = prev.previousNamedSibling;
    }
    const seen = new Set<number>();
    return decos.filter((d) => (seen.has(d.startIndex) ? false : (seen.add(d.startIndex), true))).map((d) => {
      const expr = d.namedChild(0);
      if (expr?.type === 'call_expression') {
        return { name: field(expr, 'function')?.text ?? '?', args: children(field(expr, 'arguments')).map(toArg) };
      }
      return { name: expr?.text ?? '?', args: [] };
    });
  };

  const recordParams = (fn: Node, sym: CodeSymbol, cls?: CodeSymbol) => {
    const params = field(fn, 'parameters');
    for (const p of children(params)) {
      if (p.type !== 'required_parameter' && p.type !== 'optional_parameter') continue;
      const pat = field(p, 'pattern');
      const t = typeOfAnnotation(field(p, 'type'));
      if (!pat || pat.type !== 'identifier') continue;
      if (t.name) c.facts.vars.push({ scope: sym.id, name: pat.text, type: t.name, line: p.startPosition.row + 1 });
      // TS parameter properties: constructor(private svc: Service) declares a field.
      const isProp = p.children.some((x) => x?.type === 'accessibility_modifier' || x?.type === 'readonly' || x?.type === 'override_modifier');
      if (isProp && cls && sym.kind === 'constructor') {
        c.facts.fields.push({
          ownerId: cls.id,
          owner: cls.name,
          name: pat.text,
          type: t.name,
          typeArgs: t.args,
          annotations: decoratorsOf(p),
          range: rangeOf(p),
        });
      }
    }
  };

  const heritage = (n: Node): { supers: string[]; superArgs: Record<string, string[]> } => {
    const supers: string[] = [];
    const superArgs: Record<string, string[]> = {};
    const add = (t: Node) => {
      const b = baseTypeName(t.text);
      if (b.name) {
        supers.push(b.name);
        if (b.args.length) superArgs[b.name] = b.args;
      }
    };
    for (const ch of children(n)) {
      if (ch.type === 'class_heritage') {
        for (const cl of children(ch)) {
          if (cl.type === 'extends_clause') {
            const v = field(cl, 'value');
            if (v) add(v);
            const ta = field(cl, 'type_arguments');
            if (v && ta) superArgs[baseTypeName(v.text).name ?? v.text] = children(ta).map((x) => baseTypeName(x.text).name ?? x.text);
          } else if (cl.type === 'implements_clause') children(cl).forEach(add);
        }
      } else if (ch.type === 'extends_type_clause') children(ch).forEach(add);
    }
    return { supers, superArgs };
  };

  const nameForFunction = (n: Node): { name: string; nameNode: Node | null; exported: boolean; isDefault: boolean } | null => {
    const p = n.parent;
    if (!p) return null;
    if (p.type === 'variable_declarator') {
      const nm = field(p, 'name');
      const decl = p.parent;
      const exp = decl?.parent?.type === 'export_statement';
      return nm && nm.type === 'identifier' ? { name: nm.text, nameNode: nm, exported: exp, isDefault: false } : null;
    }
    if (p.type === 'public_field_definition' || p.type === 'field_definition') {
      const nm = field(p, 'name') ?? field(p, 'property');
      return nm ? { name: nm.text, nameNode: nm, exported: false, isDefault: false } : null;
    }
    if (p.type === 'pair') {
      const k = field(p, 'key');
      return k ? { name: unquote(k.text) ?? k.text, nameNode: k, exported: false, isDefault: false } : null;
    }
    if (p.type === 'assignment_expression') {
      const left = field(p, 'left');
      if (!left) return null;
      if (left.text === 'module.exports') {
        const base = c.file.split('/').pop()!.replace(/\.[^.]+$/, '');
        return { name: base, nameNode: left, exported: true, isDefault: true };
      }
      const prop = left.type === 'member_expression' ? field(left, 'property') : left;
      const exported = left.type === 'member_expression' && /^(module\.)?exports$/.test(field(left, 'object')?.text ?? '');
      return prop ? { name: prop.text, nameNode: prop, exported, isDefault: false } : null;
    }
    if (p.type === 'export_statement') {
      return { name: 'default', nameNode: null, exported: true, isDefault: true };
    }
    return null;
  };

  walk(
    tree,
    INTERESTING,
    (n) => {
      switch (n.type) {
        case 'class_declaration':
        case 'abstract_class_declaration':
        case 'interface_declaration':
        case 'enum_declaration': {
          const nm = field(n, 'name');
          if (!nm) return;
          const h = heritage(n);
          const sym = c.addSymbol({
            node: n,
            nameNode: nm,
            name: nm.text,
            kind: n.type === 'interface_declaration' ? 'interface' : n.type === 'enum_declaration' ? 'enum' : 'class',
            annotations: decoratorsOf(n),
            supers: h.supers,
            superArgs: h.superArgs,
            exported: n.parent?.type === 'export_statement',
            isDefaultExport: isDefaultExport(n.parent),
          });
          c.pushScope('class', sym);
          return 1;
        }
        case 'function_declaration':
        case 'generator_function_declaration': {
          const nm = field(n, 'name');
          if (!nm) return;
          const sym = c.addSymbol({
            node: n,
            nameNode: nm,
            name: nm.text,
            kind: 'function',
            exported: n.parent?.type === 'export_statement',
            isDefaultExport: isDefaultExport(n.parent),
          });
          recordParams(n, sym);
          c.pushScope('func', sym);
          return 1;
        }
        case 'method_definition': {
          const nm = field(n, 'name');
          if (!nm) return;
          const cls = c.currentClass;
          const isCtor = nm.text === 'constructor';
          const sym = c.addSymbol({ node: n, nameNode: nm, name: nm.text, kind: isCtor ? 'constructor' : 'method', annotations: decoratorsOf(n) });
          recordParams(n, sym, cls);
          c.pushScope('func', sym);
          return 1;
        }
        case 'arrow_function':
        case 'function_expression':
        case 'function': {
          const p = n.parent;
          if (p?.type === 'arguments') {
            const call = p.parent;
            const fn = call ? field(call, 'function') : null;
            const callee = fn?.type === 'member_expression' ? field(fn, 'property')?.text : fn?.text;
            const firstStr = children(p).find((a) => a.type === 'string' || a.type === 'template_string');
            const label = `${callee ?? 'callback'}(${firstStr ? firstStr.text : '…'}) callback`;
            const sym = c.addSymbol({ node: n, name: label, kind: 'handler', id: c.anonId(n), container: undefined });
            recordParams(n, sym);
            c.pushScope('func', sym);
            return 1;
          }
          const info = nameForFunction(n);
          if (!info) return; // inline lambdas (e.g. inside .map) stay part of their parent
          const inClass = p?.type === 'public_field_definition' || p?.type === 'field_definition';
          const sym = c.addSymbol({
            node: n,
            nameNode: info.nameNode,
            name: info.name,
            kind: inClass ? 'method' : 'function',
            exported: info.exported,
            isDefaultExport: info.isDefault,
            container: inClass ? c.currentClass : undefined,
            annotations: inClass && p ? decoratorsOf(p) : [],
            signature: c.signature(p?.type === 'variable_declarator' ? p : n),
          });
          recordParams(n, sym);
          c.pushScope('func', sym);
          return 1;
        }
        case 'call_expression': {
          const fn = field(n, 'function');
          const argsNode = field(n, 'arguments');
          if (!fn) return;
          // TanStack Router: createFileRoute('/posts/$id')({ component: Post })
          if (fn.type === 'call_expression' && /^create(Lazy)?FileRoute$/.test(field(fn, 'function')?.text ?? '')) {
            const p = unquote(children(field(fn, 'arguments'))[0]?.text ?? '');
            const opts = children(argsNode).find((a) => a.type === 'object');
            if (p !== undefined) c.facts.jsxRoutes.push({ path: tanstackPath(p), ...(opts ? routeComponent(opts) : {}), style: 'tanstack', line: n.startPosition.row + 1, scope: c.scopeId });
          }
          // TanStack/Solid code-based routes: createRoute({ path: '/about', component: About })
          if (fn.type === 'identifier' && fn.text === 'createRoute') {
            const opts = children(argsNode).find((a) => a.type === 'object');
            const p = opts ? pairValue(opts, 'path') : null;
            if (opts && p) c.facts.jsxRoutes.push({ path: tanstackPath(unquote(p.text) ?? ''), ...routeComponent(opts), style: 'tanstack', line: n.startPosition.row + 1, scope: c.scopeId });
          }
          const args = argsNode?.type === 'arguments' ? children(argsNode).map(toArg) : [];
          // Lazy loading: () => import('./views/Users.vue') leads to that module's default export.
          if (fn.type === 'import' && args[0]?.kind === 'string') {
            c.addCall(n, 'import', undefined, args.slice(0, 1), false, fn);
            return;
          }
          if (fn.type === 'identifier') {
            if (fn.text === 'require') return;
            c.addCall(n, fn.text, undefined, args, false, fn);
          } else if (fn.type === 'member_expression') {
            const prop = field(fn, 'property');
            const obj = field(fn, 'object');
            if (prop) c.addCall(n, prop.text, obj?.text, args, false, prop);
          }
          return;
        }
        case 'new_expression': {
          const ctor = field(n, 'constructor');
          if (!ctor) return;
          const args = children(field(n, 'arguments')).map(toArg);
          const name = ctor.type === 'member_expression' ? field(ctor, 'property')?.text : ctor.text;
          if (name) c.addCall(n, name, ctor.type === 'member_expression' ? field(ctor, 'object')?.text : undefined, args, true, ctor.type === 'member_expression' ? field(ctor, 'property') : ctor);
          return;
        }
        case 'import_statement': {
          const source = unquote(field(n, 'source')?.text ?? '');
          if (!source) return;
          const line = n.startPosition.row + 1;
          const clause = children(n).find((x) => x.type === 'import_clause');
          for (const part of children(clause)) {
            if (part.type === 'identifier') c.facts.imports.push({ source, local: part.text, imported: 'default', line });
            else if (part.type === 'namespace_import') {
              const id = children(part).find((x) => x.type === 'identifier');
              if (id) c.facts.imports.push({ source, local: id.text, imported: '*', line });
            } else if (part.type === 'named_imports') {
              for (const spec of children(part)) {
                const name = field(spec, 'name')?.text;
                const alias = field(spec, 'alias')?.text;
                if (name) c.facts.imports.push({ source, local: alias ?? name, imported: name, line });
              }
            }
          }
          return;
        }
        case 'export_statement': {
          const reSource = unquote(field(n, 'source')?.text ?? '');
          if (reSource) {
            const clause = children(n).find((x) => x.type === 'export_clause');
            if (!clause) c.facts.exports.push({ name: '*', local: '*', source: reSource });
            for (const spec of children(clause)) {
              const name = field(spec, 'name')?.text;
              const alias = field(spec, 'alias')?.text;
              if (name) c.facts.exports.push({ name: alias ?? name, local: name, source: reSource, isDefault: alias === 'default' });
            }
            return;
          }
          const decl = field(n, 'declaration');
          if (decl) {
            if (decl.type === 'lexical_declaration' || decl.type === 'variable_declaration') {
              for (const d of children(decl)) {
                const nm = field(d, 'name');
                if (nm?.type === 'identifier') c.facts.exports.push({ name: nm.text, local: nm.text });
              }
            } else {
              const nm = field(decl, 'name');
              if (nm) c.facts.exports.push({ name: isDefaultExport(n) ? 'default' : nm.text, local: nm.text, isDefault: isDefaultExport(n) });
            }
            return;
          }
          const value = field(n, 'value');
          if (value && value.type === 'identifier') {
            c.facts.exports.push({ name: 'default', local: value.text, isDefault: true });
          } else if (value && value.type === 'call_expression') {
            const fn = field(value, 'function');
            const prop = fn?.type === 'member_expression' ? field(fn, 'property')?.text : undefined;
            if (prop && /^(use|route|get|post|put|patch|delete|all|basePath|mount|register)$/.test(prop)) {
              // export default Router().use('/api', api) — the default export is an anonymous router
              c.facts.vars.push({
                scope: c.fileScope,
                name: '__default__',
                call: { callee: prop, receiver: field(fn!, 'object')?.text, args: children(field(value, 'arguments')).map(toArg) },
                line: value.startPosition.row + 1,
              });
              c.facts.exports.push({ name: 'default', local: '__default__', isDefault: true });
            } else {
              // export default connect(...)(Component) / export default withRouter(App)
              const inner = children(field(value, 'arguments')).find((a) => a.type === 'identifier');
              if (inner) c.facts.exports.push({ name: 'default', local: inner.text, isDefault: true });
            }
          }
          const clause = children(n).find((x) => x.type === 'export_clause');
          for (const spec of children(clause)) {
            const name = field(spec, 'name')?.text;
            const alias = field(spec, 'alias')?.text;
            if (name) c.facts.exports.push({ name: alias ?? name, local: name, isDefault: alias === 'default' });
          }
          return;
        }
        case 'variable_declarator': {
          const nm = field(n, 'name');
          const value = field(n, 'value');
          const line = n.startPosition.row + 1;
          const t = typeOfAnnotation(field(n, 'type'));
          if (!nm) return;
          if (value?.type === 'call_expression' && field(value, 'function')?.text === 'require') {
            const source = unquote(children(field(value, 'arguments'))[0]?.text ?? '');
            if (!source) return;
            if (nm.type === 'identifier') c.facts.imports.push({ source, local: nm.text, imported: '*', line });
            else if (nm.type === 'object_pattern') {
              for (const p of children(nm)) {
                if (p.type === 'shorthand_property_identifier_pattern') c.facts.imports.push({ source, local: p.text, imported: p.text, line });
                else if (p.type === 'pair_pattern') {
                  const k = field(p, 'key')?.text;
                  const v = field(p, 'value')?.text;
                  if (k && v) c.facts.imports.push({ source, local: v, imported: k, line });
                }
              }
            }
            return;
          }
          // const { fetchUsers, saveUser: save } = useUsers() — functions handed out by a hook, composable or store
          if (nm.type === 'object_pattern' && (value?.type === 'call_expression' || value?.type === 'await_expression')) {
            const call = value.type === 'await_expression' ? value.namedChild(0) : value;
            const fn = call?.type === 'call_expression' ? field(call, 'function') : null;
            if (fn?.type === 'identifier') {
              for (const p of children(nm)) {
                const key = p.type === 'shorthand_property_identifier_pattern' ? p.text : p.type === 'pair_pattern' ? field(p, 'key')?.text : undefined;
                const local = p.type === 'pair_pattern' ? field(p, 'value')?.text : key;
                if (key && local && /^[\w$]+$/.test(local)) c.facts.vars.push({ scope: c.scopeId, name: local, member: key, call: { callee: fn.text, args: [] }, line });
              }
            }
            return;
          }
          if (nm.type !== 'identifier') return;
          if (value && FUNC_TYPES.has(value.type)) return; // becomes a symbol
          const v: { scope: string; name: string; type?: string; call?: any; valueText?: string; line: number } = {
            scope: c.scopeId,
            name: nm.text,
            type: t.name,
            line,
          };
          if (value?.type === 'call_expression' || value?.type === 'await_expression') {
            const call = value.type === 'await_expression' ? value.namedChild(0) : value;
            if (call?.type === 'call_expression') {
              const fn = field(call, 'function');
              const callee = fn?.type === 'member_expression' ? field(fn, 'property')?.text : fn?.text;
              const receiver = fn?.type === 'member_expression' ? field(fn, 'object')?.text : undefined;
              v.call = { callee: callee ?? '?', receiver, args: children(field(call, 'arguments')).map(toArg) };
            }
          } else if (value?.type === 'new_expression') {
            const ctor = field(value, 'constructor');
            v.type = v.type ?? baseTypeName(ctor?.text).name;
            v.call = { callee: v.type ?? '?', args: children(field(value, 'arguments')).map(toArg) };
          } else if (value) {
            v.valueText = truncate(value.text, 160);
          }
          c.facts.vars.push(v);
          return;
        }
        case 'assignment_expression': {
          const left = field(n, 'left');
          const right = field(n, 'right');
          if (!left || !right) return;
          if (left.text === 'module.exports' || left.text === 'exports') {
            if (right.type === 'identifier') c.facts.exports.push({ name: 'default', local: right.text, isDefault: true });
            else if (right.type === 'object') {
              for (const p of children(right)) {
                if (p.type === 'shorthand_property_identifier') c.facts.exports.push({ name: p.text, local: p.text });
                else if (p.type === 'pair') {
                  const k = field(p, 'key')?.text;
                  const v = field(p, 'value');
                  if (k && v?.type === 'identifier') c.facts.exports.push({ name: k, local: v.text });
                }
              }
            } else if (right.type === 'call_expression' || right.type === 'new_expression') {
              // module.exports = new OrderService() / module.exports = express.Router()
              const fn = field(right, right.type === 'call_expression' ? 'function' : 'constructor');
              const callee = fn?.type === 'member_expression' ? field(fn, 'property')?.text : fn?.text;
              c.facts.vars.push({
                scope: c.fileScope,
                name: 'module.exports',
                type: right.type === 'new_expression' ? callee : undefined,
                call: { callee: callee ?? '?', receiver: fn?.type === 'member_expression' ? field(fn, 'object')?.text : undefined, args: children(field(right, 'arguments')).map(toArg) },
                line: n.startPosition.row + 1,
              });
              c.facts.exports.push({ name: 'default', local: 'module.exports', isDefault: true });
            }
            return;
          }
          if (left.type === 'member_expression' && /^(module\.)?exports$/.test(field(left, 'object')?.text ?? '')) {
            const prop = field(left, 'property')?.text;
            if (prop && right.type === 'identifier') c.facts.exports.push({ name: prop, local: right.text });
            return;
          }
          // this.x = new Foo() inside a class -> field type
          if (left.type === 'member_expression' && field(left, 'object')?.type === 'this') {
            const cls = c.currentClass;
            const prop = field(left, 'property')?.text;
            if (cls && prop && right.type === 'new_expression') {
              const t = baseTypeName(field(right, 'constructor')?.text);
              c.facts.fields.push({ ownerId: cls.id, owner: cls.name, name: prop, type: t.name, typeArgs: t.args, annotations: [], range: rangeOf(n) });
            }
          }
          return;
        }
        case 'public_field_definition':
        case 'field_definition': {
          const cls = c.currentClass;
          const nm = field(n, 'name') ?? field(n, 'property');
          const value = field(n, 'value');
          if (!cls || !nm || (value && FUNC_TYPES.has(value.type))) return;
          const t = typeOfAnnotation(field(n, 'type'));
          let type = t.name;
          if (!type && value?.type === 'new_expression') type = baseTypeName(field(value, 'constructor')?.text).name;
          c.facts.fields.push({
            ownerId: cls.id,
            owner: cls.name,
            name: nm.text,
            type,
            typeArgs: t.args,
            value: value ? truncate(value.text, 160) : undefined,
            annotations: decoratorsOf(n),
            range: rangeOf(n),
          });
          return;
        }
        case 'string':
        case 'template_string': {
          const v = unquote(n.text);
          if (v) c.addString(v, n);
          return;
        }
        case 'object': {
          // Vue Router / Angular / React Router object routes: [{ path: '/users', component: UserList, children: [...] }]
          if (n.parent?.type !== 'array') return;
          const pathNode = pairValue(n, 'path');
          if (!pathNode || (pathNode.type !== 'string' && pathNode.type !== 'template_string')) return;
          const comp = routeComponent(n);
          if (!comp.component && !comp.importSource) return;
          const segs = [unquote(pathNode.text) ?? ''];
          let cur: Node = n;
          // Nested routes: object -> array -> pair(children) -> parent route object
          while (cur.parent?.type === 'array' && cur.parent.parent?.type === 'pair' && keyOf(cur.parent.parent) === 'children' && cur.parent.parent.parent?.type === 'object') {
            const parent: Node = cur.parent.parent.parent;
            const pp = pairValue(parent, 'path');
            if (pp) segs.unshift(unquote(pp.text) ?? '');
            cur = parent;
          }
          let full = '';
          for (const s of segs) full = s.startsWith('/') ? s : `${full.replace(/\/$/, '')}/${s}`;
          c.facts.jsxRoutes.push({ path: full || '/', ...comp, style: 'object', line: n.startPosition.row + 1, scope: c.scopeId });
          return;
        }
        case 'jsx_self_closing_element':
        case 'jsx_opening_element': {
          const nameNode = field(n, 'name');
          const name = nameNode?.text;
          // Rendering a component is how React code "calls" it: <ItemsTable /> → ItemsTable, <Ui.Card> → Card.
          // Lowercase tags are plain HTML elements.
          if (nameNode && name && name !== 'Route' && /^[A-Z]/.test(name.split('.').pop()!) && c.scopeId !== c.fileScope) {
            const dot = name.lastIndexOf('.');
            const last = nameNode.type === 'member_expression' ? field(nameNode, 'property') : nameNode;
            c.addCall(n, name.slice(dot + 1), dot > 0 ? name.slice(0, dot) : undefined, [], false, last).render = true;
          }
          if (name !== 'Route') return;
          let path: string | undefined;
          let component: string | undefined;
          for (const attr of children(n)) {
            if (attr.type !== 'jsx_attribute') continue;
            const key = attr.namedChild(0)?.text;
            const val = attr.namedChild(1);
            if (!val) continue;
            if (key === 'path') path = unquote(val.text) ?? unquote(val.namedChild(0)?.text ?? '');
            if (key === 'element' || key === 'component' || key === 'Component') {
              const inner = val.type === 'jsx_expression' ? val.namedChild(0) : val;
              if (inner?.type === 'jsx_self_closing_element' || inner?.type === 'jsx_element') {
                const tag = inner.type === 'jsx_element' ? field(field(inner, 'open_tag'), 'name') : field(inner, 'name');
                component = tag?.text;
              } else if (inner) component = inner.text;
            }
          }
          if (path !== undefined) c.facts.jsxRoutes.push({ path, component, style: 'jsx', line: n.startPosition.row + 1, scope: c.scopeId });
          return;
        }
      }
    },
    c,
  );
  void src;
}

/**
 * URL of a TanStack Router file route id: `/_layout/posts/$postId` → `/posts/:postId`.
 * `_name` segments are pathless layouts, `(name)` are groups, a trailing `_` un-nests, `$` alone is a splat.
 */
function tanstackPath(id: string): string {
  const segs = id
    .split('/')
    .filter((s) => s && !s.startsWith('_') && !/^\(.*\)$/.test(s))
    .map((s) => (s === '$' ? '*' : s.replace(/_$/, '').replace(/^\$(\w+)$/, ':$1')));
  return '/' + segs.join('/');
}
