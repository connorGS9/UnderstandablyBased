import type { Annotation, Arg, CodeSymbol, DbColumn, DbIndex, DbTable, FieldFact } from './types';
import type { CodeGraph } from './graph';

export function snake(s: string): string {
  return s
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/([A-Z])([A-Z][a-z])/g, '$1_$2')
    .toLowerCase();
}

const norm = (s: string) => s.replace(/[`"'\[\]]/g, '').split('.').pop()!.trim();

// ---------------- SQL DDL ----------------

function stripSqlComments(sql: string): string {
  return sql.replace(/--[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
}

/** Splits on top-level commas inside a CREATE TABLE body. */
function splitDefs(body: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = '';
  let quote: string | null = null;
  for (const ch of body) {
    if (quote) {
      cur += ch;
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') quote = ch;
    if (ch === '(') depth++;
    if (ch === ')') depth--;
    if (ch === ',' && depth === 0) {
      out.push(cur.trim());
      cur = '';
    } else cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

const cols = (s: string) => s.split(',').map((c) => norm(c.replace(/\s+(asc|desc)\b/i, '').replace(/\(\d+\)/, '')));

export function parseSql(sql: string, file: string): { tables: DbTable[]; extraIndexes: { table: string; index: DbIndex }[]; fks: { table: string; column: string; ref: string; refCol?: string }[] } {
  const text = stripSqlComments(sql);
  const tables: DbTable[] = [];
  const extraIndexes: { table: string; index: DbIndex }[] = [];
  const fks: { table: string; column: string; ref: string; refCol?: string }[] = [];
  const lineAt = (idx: number) => text.slice(0, idx).split('\n').length;

  const createRe = /create\s+(?:(?:global\s+|local\s+)?(?:temporary|temp)\s+)?(?:unlogged\s+)?table\s+(?:if\s+not\s+exists\s+)?([`"\[]?[\w.]+[`"\]]?(?:\.[`"\[]?\w+[`"\]]?)?)\s*\(/gi;
  let m: RegExpExecArray | null;
  while ((m = createRe.exec(text))) {
    const name = norm(m[1]);
    // find matching paren
    let depth = 1;
    let i = createRe.lastIndex;
    for (; i < text.length && depth > 0; i++) {
      if (text[i] === '(') depth++;
      else if (text[i] === ')') depth--;
    }
    const body = text.slice(createRe.lastIndex, i - 1);
    const table: DbTable = { name, columns: [], indexes: [], source: { kind: 'SQL', file, line: lineAt(m.index) } };
    for (const def of splitDefs(body)) {
      const d = def.replace(/\s+/g, ' ').trim();
      let mm: RegExpExecArray | null;
      if ((mm = /^(?:constraint\s+\S+\s+)?primary\s+key\s*\(([^)]+)\)/i.exec(d))) {
        const pkCols = cols(mm[1]);
        table.indexes.push({ name: 'PRIMARY', columns: pkCols, primary: true, unique: true });
        for (const c of table.columns) if (pkCols.includes(c.name)) c.pk = true;
        continue;
      }
      if ((mm = /^(?:constraint\s+\S+\s+)?foreign\s+key\s*\(([^)]+)\)\s*references\s+([\w."`\[\]]+)\s*(?:\(([^)]+)\))?/i.exec(d))) {
        const from = cols(mm[1]);
        const to = mm[3] ? cols(mm[3]) : [];
        from.forEach((c, k) => fks.push({ table: name, column: c, ref: norm(mm![2]), refCol: to[k] }));
        continue;
      }
      if ((mm = /^(?:constraint\s+(\S+)\s+)?unique\s*(?:key|index)?\s*(\S+)?\s*\(([^)]+)\)/i.exec(d))) {
        table.indexes.push({ name: norm(mm[1] ?? mm[2] ?? `uniq_${cols(mm[3]).join('_')}`), columns: cols(mm[3]), unique: true });
        continue;
      }
      if ((mm = /^(?:fulltext\s+|spatial\s+)?(?:key|index)\s+(\S+)?\s*(?:using\s+\w+\s*)?\(([^)]+)\)/i.exec(d))) {
        table.indexes.push({ name: norm(mm[1] ?? `idx_${cols(mm[2]).join('_')}`), columns: cols(mm[2]) });
        continue;
      }
      if (/^(constraint|check|exclude|period)\b/i.test(d)) continue;
      const cm = /^([`"\[]?\w+[`"\]]?)\s+([\w]+(?:\s*\([^)]*\))?(?:\s+(?:varying|precision|unsigned|zone|with(?:out)?\s+time\s+zone))*(?:\[\])?)(.*)$/i.exec(d);
      if (!cm) continue;
      const rest = cm[3] ?? '';
      const col: DbColumn = { name: norm(cm[1]), type: cm[2].toUpperCase() };
      if (/primary\s+key/i.test(rest)) {
        col.pk = true;
        table.indexes.push({ name: 'PRIMARY', columns: [col.name], primary: true, unique: true });
      }
      if (/\bnot\s+null\b/i.test(rest) || col.pk) col.nullable = false;
      else col.nullable = true;
      if (/\bunique\b/i.test(rest)) col.unique = true;
      const ref = /references\s+([\w."`\[\]]+)\s*(?:\(([^)]+)\))?/i.exec(rest);
      if (ref) col.fk = { table: norm(ref[1]), column: ref[2] ? norm(ref[2]) : undefined };
      if (/serial|auto_increment|autoincrement|identity/i.test(cm[2] + rest)) col.type += /serial/i.test(cm[2]) ? '' : ' AUTO';
      table.columns.push(col);
    }
    tables.push(table);
    createRe.lastIndex = i;
  }

  const idxRe = /create\s+(unique\s+)?index\s+(?:concurrently\s+)?(?:if\s+not\s+exists\s+)?([\w."`\[\]]+)?\s*on\s+(?:only\s+)?([\w."`\[\]]+)\s*(?:using\s+\w+\s*)?\(([^;]+?)\)\s*(?:where[^;]*)?(?:;|$)/gim;
  while ((m = idxRe.exec(text))) {
    extraIndexes.push({ table: norm(m[3]), index: { name: m[2] ? norm(m[2]) : `idx_${norm(m[3])}`, columns: cols(m[4].replace(/\([^)]*\)/g, '')), unique: !!m[1] } });
  }
  const alterFk = /alter\s+table\s+(?:only\s+)?(?:if\s+exists\s+)?([\w."`\[\]]+)\s+add\s+(?:constraint\s+\S+\s+)?foreign\s+key\s*\(([^)]+)\)\s*references\s+([\w."`\[\]]+)\s*(?:\(([^)]+)\))?/gi;
  while ((m = alterFk.exec(text))) {
    const from = cols(m[2]);
    const to = m[4] ? cols(m[4]) : [];
    from.forEach((c, k) => fks.push({ table: norm(m![1]), column: c, ref: norm(m![3]), refCol: to[k] }));
  }
  const alterCol = /alter\s+table\s+(?:only\s+)?([\w."`\[\]]+)\s+add\s+(?:column\s+)?(?:if\s+not\s+exists\s+)?([`"]?\w+[`"]?)\s+(\w+(?:\([^)]*\))?)/gi;
  while ((m = alterCol.exec(text))) {
    if (/^(constraint|foreign|primary|unique|index|key)$/i.test(m[2])) continue;
    const t = tables.find((x) => x.name === norm(m![1]));
    if (t && !t.columns.some((c) => c.name === norm(m![2]))) t.columns.push({ name: norm(m[2]), type: m[3].toUpperCase(), nullable: true });
  }
  return { tables, extraIndexes, fks };
}

// ---------------- Prisma ----------------

export function parsePrisma(text: string, file: string): DbTable[] {
  const tables: DbTable[] = [];
  const modelRe = /^\s*model\s+(\w+)\s*\{([\s\S]*?)^\s*\}/gm;
  let m: RegExpExecArray | null;
  const modelNames = new Set<string>();
  for (const mm of text.matchAll(/^\s*model\s+(\w+)/gm)) modelNames.add(mm[1]);
  while ((m = modelRe.exec(text))) {
    const modelName = m[1];
    const body = m[2];
    const line = text.slice(0, m.index).split('\n').length;
    const mapName = /@@map\(\s*"([^"]+)"/.exec(body)?.[1];
    const table: DbTable = { name: mapName ?? modelName, modelName, columns: [], indexes: [], source: { kind: 'Prisma', file, line } };
    for (const raw of body.split('\n')) {
      const l = raw.replace(/\/\/.*$/, '').trim();
      if (!l) continue;
      let mm: RegExpExecArray | null;
      if ((mm = /^@@(id|unique|index)\(\s*(?:fields:\s*)?\[([^\]]+)\](?:.*?name:\s*"([^"]+)")?/.exec(l))) {
        const c = mm[2].split(',').map((x) => x.trim().replace(/\(.*\)$/, ''));
        table.indexes.push({ name: mm[3] ?? `${mm[1]}_${c.join('_')}`, columns: c, unique: mm[1] !== 'index', primary: mm[1] === 'id' });
        continue;
      }
      if (l.startsWith('@@')) continue;
      const fm = /^(\w+)\s+(\w+)(\[\])?(\?)?\s*(.*)$/.exec(l);
      if (!fm) continue;
      const [, fname, ftype, isList, optional, attrs] = fm;
      if (modelNames.has(ftype)) {
        // relation field: FK lives in the scalar referenced by `fields: [x]`
        const rel = /@relation\([^)]*fields:\s*\[([^\]]+)\][^)]*references:\s*\[([^\]]+)\]/.exec(attrs);
        if (rel) {
          const fields = rel[1].split(',').map((x) => x.trim());
          const refs = rel[2].split(',').map((x) => x.trim());
          fields.forEach((f, k) => {
            const col = table.columns.find((c) => c.name === f);
            const fk = { table: ftype, column: refs[k] };
            if (col) col.fk = fk;
            else (table as any)._pendingFk = [...((table as any)._pendingFk ?? []), { f, fk }];
          });
        }
        void isList;
        continue;
      }
      const colName = /@map\(\s*"([^"]+)"/.exec(attrs)?.[1] ?? fname;
      const col: DbColumn = { name: colName, type: ftype + (isList ? '[]' : ''), nullable: !!optional };
      if (/@id\b/.test(attrs)) {
        col.pk = true;
        table.indexes.push({ name: 'PRIMARY', columns: [colName], primary: true, unique: true });
      }
      if (/@unique\b/.test(attrs)) {
        col.unique = true;
        table.indexes.push({ name: `${colName}_key`, columns: [colName], unique: true });
      }
      table.columns.push(col);
    }
    for (const p of (table as any)._pendingFk ?? []) {
      const col = table.columns.find((c) => c.name === p.f);
      if (col) col.fk = p.fk;
    }
    delete (table as any)._pendingFk;
    tables.push(table);
  }
  // Prisma relations reference model names; map them to table names.
  const byModel = new Map(tables.map((t) => [t.modelName!, t.name]));
  for (const t of tables) for (const c of t.columns) if (c.fk && byModel.has(c.fk.table)) c.fk.table = byModel.get(c.fk.table)!;
  return tables;
}

// ---------------- ORM models from code ----------------

const ann = (anns: Annotation[], name: string) => anns.find((a) => a.name === name || a.name.endsWith('.' + name));
const argVal = (a: Annotation | undefined, key: string, positional = true): Arg | undefined =>
  a?.args.find((x) => x.key === key) ?? (positional ? a?.args.find((x) => !x.key) : undefined);
const strVal = (a?: Arg) => (a?.kind === 'string' ? a.value : undefined);

function javaJpa(cls: CodeSymbol, fields: FieldFact[]): DbTable | undefined {
  if (cls.lang !== 'java' || !ann(cls.annotations, 'Entity')) return undefined;
  const tableAnn = ann(cls.annotations, 'Table');
  const name = strVal(argVal(tableAnn, 'name', false)) ?? strVal(argVal(ann(cls.annotations, 'Entity'), 'name', false)) ?? snake(cls.name);
  const table: DbTable = { name, modelName: cls.name, columns: [], indexes: [], source: { kind: 'JPA @Entity', file: cls.file, line: cls.range.sl, symbolId: cls.id } };
  for (const f of fields) {
    const a = f.annotations;
    if (ann(a, 'Transient') || ann(a, 'OneToMany') || ann(a, 'ManyToMany')) continue;
    const column = ann(a, 'Column');
    const join = ann(a, 'JoinColumn');
    const rel = ann(a, 'ManyToOne') ?? ann(a, 'OneToOne');
    if (rel) {
      if (ann(a, 'OneToOne') && argVal(rel, 'mappedBy', false)) continue;
      const colName = strVal(argVal(join, 'name', false)) ?? `${snake(f.name)}_id`;
      table.columns.push({ name: colName, type: 'FK', nullable: true, fk: { table: f.type ?? '?' } });
      continue;
    }
    const colName = strVal(argVal(column, 'name', false)) ?? snake(f.name);
    const col: DbColumn = { name: colName, type: f.type ?? '?', nullable: argVal(column, 'nullable', false)?.text !== 'false' };
    if (ann(a, 'Id') || ann(a, 'EmbeddedId')) {
      col.pk = true;
      col.nullable = false;
      table.indexes.push({ name: 'PRIMARY', columns: [colName], primary: true, unique: true });
    }
    if (argVal(column, 'unique', false)?.text === 'true') col.unique = true;
    table.columns.push(col);
  }
  const idxArr = argVal(tableAnn, 'indexes', false);
  for (const it of idxArr?.items ?? (idxArr?.kind === 'call' ? [idxArr] : [])) {
    const kv = (k: string) => it.items?.find((x) => x.key === k);
    const list = kv('columnList')?.value;
    if (list) table.indexes.push({ name: kv('name')?.value ?? `idx_${list.replace(/[\s,]+/g, '_')}`, columns: list.split(',').map((s) => s.trim().split(/\s+/)[0]), unique: kv('unique')?.text === 'true' });
  }
  return table;
}

const DJANGO_FIELD = /Field$|^ForeignKey$|^OneToOneField$|^ManyToManyField$/;

function django(cls: CodeSymbol, fields: FieldFact[]): DbTable | undefined {
  if (!cls.supers?.some((s) => s === 'models.Model' || s === 'Model') || cls.lang !== 'python') return undefined;
  if (!fields.some((f) => f.valueCall && DJANGO_FIELD.test(f.valueCall.callee))) return undefined;
  const app = cls.file.split('/').slice(-2, -1)[0] ?? 'app';
  const table: DbTable = { name: `${app}_${cls.name.toLowerCase()}`, modelName: cls.name, columns: [], indexes: [], source: { kind: 'Django model', file: cls.file, line: cls.range.sl, symbolId: cls.id } };
  let hasPk = false;
  for (const f of fields) {
    const vc = f.valueCall;
    if (!vc || !DJANGO_FIELD.test(vc.callee)) continue;
    if (vc.callee === 'ManyToManyField') continue;
    const kw = (k: string) => vc.args.find((a) => a.key === k);
    const isFk = vc.callee === 'ForeignKey' || vc.callee === 'OneToOneField';
    const colName = strVal(kw('db_column')) ?? (isFk ? `${f.name}_id` : f.name);
    const col: DbColumn = { name: colName, type: vc.callee.replace(/Field$/, ''), nullable: kw('null')?.text === 'True' };
    if (isFk) {
      const target = vc.args.find((a) => !a.key);
      const tn = target?.kind === 'string' ? target.value : target?.text;
      col.fk = { table: (tn ?? '?').split('.').pop()! };
      col.indexed = true;
    }
    if (kw('primary_key')?.text === 'True') {
      col.pk = true;
      hasPk = true;
    }
    if (kw('unique')?.text === 'True') col.unique = true;
    if (kw('db_index')?.text === 'True') col.indexed = true;
    table.columns.push(col);
  }
  if (!hasPk) table.columns.unshift({ name: 'id', type: 'AutoField', pk: true, nullable: false });
  table.indexes.push({ name: 'PRIMARY', columns: [table.columns.find((c) => c.pk)!.name], primary: true, unique: true });
  for (const c of table.columns) if (c.indexed && !c.pk) table.indexes.push({ name: `${table.name}_${c.name}_idx`, columns: [c.name], unique: c.unique });
  return table;
}

function sqlalchemy(cls: CodeSymbol, ownFields: FieldFact[], graph: CodeGraph): DbTable | undefined {
  if (cls.lang !== 'python') return undefined;
  const tn = ownFields.find((f) => f.name === '__tablename__');
  const isSqlModel = /table\s*=\s*True/.test(cls.signature);
  // SQLModel tables usually inherit their columns from a shared *Base model.
  const fields = [...ownFields];
  if (isSqlModel) {
    const seen = new Set(fields.map((f) => f.name));
    const queue = [...(cls.supers ?? [])];
    for (let i = 0; i < queue.length && i < 10; i++) {
      const base = graph.classesByName.get(queue[i])?.[0];
      if (!base || base.lang !== 'python') continue;
      for (const f of graph.facts.get(base.file)?.fields.filter((x) => x.ownerId === base.id) ?? []) if (!seen.has(f.name)) (seen.add(f.name), fields.push(f));
      queue.push(...(base.supers ?? []));
    }
  }
  if (!tn && !isSqlModel) return undefined;
  const name = tn?.value?.replace(/^['"]|['"]$/g, '') ?? cls.name.toLowerCase();
  if (isSqlModel && !fields.length) return undefined;
  const table: DbTable = { name, modelName: cls.name, columns: [], indexes: [], source: { kind: isSqlModel ? 'SQLModel' : 'SQLAlchemy model', file: cls.file, line: cls.range.sl, symbolId: cls.id } };
  for (const f of fields) {
    if (f.name.startsWith('__')) continue;
    const vc = f.valueCall;
    const isCol = vc && /^(Column|mapped_column|Field)$/.test(vc.callee);
    if (!isCol && !(isSqlModel && f.type)) continue;
    if (vc && /^(relationship|Relationship)$/.test(vc.callee)) continue;
    const args = vc?.args ?? [];
    const kw = (k: string) => args.find((a) => a.key === k);
    const typeArg = args.find((a) => !a.key && (a.kind === 'ident' || a.kind === 'call' || a.kind === 'member'));
    const fkArg = args.find((a) => a.kind === 'call' && a.callee === 'ForeignKey') ?? kw('foreign_key');
    const col: DbColumn = {
      name: strVal(args.find((a) => !a.key && a.kind === 'string' && args.indexOf(a) === 0)) ?? f.name,
      type: typeArg && typeArg.callee !== 'ForeignKey' ? (typeArg.callee ?? typeArg.text) : (f.typeArgs?.[0] ?? f.type ?? '?'),
      nullable: kw('nullable')?.text !== 'False',
    };
    if (kw('primary_key')?.text === 'True') {
      col.pk = true;
      col.nullable = false;
      table.indexes.push({ name: 'PRIMARY', columns: [col.name], primary: true, unique: true });
    }
    if (kw('unique')?.text === 'True') col.unique = true;
    if (kw('index')?.text === 'True') {
      col.indexed = true;
      table.indexes.push({ name: `ix_${name}_${col.name}`, columns: [col.name], unique: col.unique });
    }
    if (fkArg) {
      const target = fkArg.kind === 'call' ? fkArg.items?.[0] : fkArg;
      const ref = target?.value ?? target?.text ?? '?';
      const [t, c] = ref.replace(/['"]/g, '').split('.');
      col.fk = { table: t, column: c };
    }
    table.columns.push(col);
  }
  return table.columns.length ? table : undefined;
}

function typeorm(cls: CodeSymbol, fields: FieldFact[]): DbTable | undefined {
  if (cls.lang !== 'typescript' && cls.lang !== 'tsx' && cls.lang !== 'javascript') return undefined;
  const ent = ann(cls.annotations, 'Entity');
  if (!ent) return undefined;
  const nameArg = ent.args[0];
  const name = strVal(nameArg) ?? nameArg?.items?.find((i) => i.key === 'name')?.value ?? snake(cls.name);
  const table: DbTable = { name, modelName: cls.name, columns: [], indexes: [], source: { kind: 'TypeORM @Entity', file: cls.file, line: cls.range.sl, symbolId: cls.id } };
  for (const f of fields) {
    const a = f.annotations;
    const pk = ann(a, 'PrimaryGeneratedColumn') ?? ann(a, 'PrimaryColumn');
    const column = ann(a, 'Column') ?? ann(a, 'CreateDateColumn') ?? ann(a, 'UpdateDateColumn');
    const rel = ann(a, 'ManyToOne') ?? (ann(a, 'OneToOne') && ann(a, 'JoinColumn') ? ann(a, 'OneToOne') : undefined);
    if (rel) {
      const target = rel.args[0]?.text.replace(/^\(\)\s*=>\s*/, '') ?? f.type ?? '?';
      table.columns.push({ name: `${f.name}Id`, type: 'FK', nullable: true, fk: { table: target } });
      continue;
    }
    if (!pk && !column) continue;
    const opts = (pk ?? column)!.args.find((x) => x.kind === 'object');
    const col: DbColumn = { name: opts?.items?.find((i) => i.key === 'name')?.value ?? f.name, type: strVal((pk ?? column)!.args.find((x) => x.kind === 'string')) ?? f.type ?? '?', nullable: opts?.items?.find((i) => i.key === 'nullable')?.text === 'true' };
    if (pk) {
      col.pk = true;
      table.indexes.push({ name: 'PRIMARY', columns: [col.name], primary: true, unique: true });
    }
    if (opts?.items?.find((i) => i.key === 'unique')?.text === 'true') col.unique = true;
    if (ann(a, 'Index')) {
      col.indexed = true;
      table.indexes.push({ name: `IDX_${name}_${col.name}`, columns: [col.name] });
    }
    table.columns.push(col);
  }
  return table;
}

export function extractOrmTables(graph: CodeGraph): DbTable[] {
  const out: DbTable[] = [];
  for (const s of graph.symbols.values()) {
    if (s.kind !== 'class' || s.role === 'test') continue;
    const fields = graph.facts.get(s.file)?.fields.filter((f) => f.ownerId === s.id) ?? [];
    const t = javaJpa(s, fields) ?? django(s, fields) ?? sqlalchemy(s, fields, graph) ?? typeorm(s, fields);
    if (t) out.push(t);
  }
  // Relations point at model class names; map them to table names where we know them.
  const byModel = new Map(out.map((t) => [t.modelName!, t.name]));
  for (const t of out) for (const c of t.columns) if (c.fk && byModel.has(c.fk.table)) c.fk.table = byModel.get(c.fk.table)!;
  return out;
}

/** Merge tables from all sources (SQL migrations + ORM models), de-duplicating by name. */
export function mergeTables(lists: DbTable[][], extraIndexes: { table: string; index: DbIndex }[], fks: { table: string; column: string; ref: string; refCol?: string }[]): DbTable[] {
  const byName = new Map<string, DbTable>();
  for (const list of lists) {
    for (const t of list) {
      const key = t.name.toLowerCase();
      const existing = byName.get(key);
      if (!existing) {
        byName.set(key, { ...t, columns: [...t.columns], indexes: [...t.indexes] });
        continue;
      }
      // Later migrations may re-create a table; keep the richer definition but remember the model.
      if (t.columns.length > existing.columns.length) {
        byName.set(key, { ...t, columns: [...t.columns], indexes: [...t.indexes], modelName: t.modelName ?? existing.modelName });
      } else if (t.modelName && !existing.modelName) existing.modelName = t.modelName;
    }
  }
  for (const { table, index } of extraIndexes) {
    const t = byName.get(table.toLowerCase());
    if (t && !t.indexes.some((i) => i.name === index.name)) t.indexes.push(index);
  }
  for (const fk of fks) {
    const t = byName.get(fk.table.toLowerCase());
    const c = t?.columns.find((x) => x.name.toLowerCase() === fk.column.toLowerCase());
    if (c) c.fk = { table: fk.ref, column: fk.refCol };
  }
  for (const t of byName.values()) {
    for (const idx of t.indexes) for (const c of t.columns) if (idx.columns.includes(c.name) && !idx.primary) c.indexed = true;
    // de-dup PRIMARY entries
    const seen = new Set<string>();
    t.indexes = t.indexes.filter((i) => {
      const k = `${i.name}:${i.columns.join(',')}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}
