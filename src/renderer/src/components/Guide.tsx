import { useMemo, useState, type CSSProperties, type ReactNode } from 'react';
import { useStore } from '../store';
import type { EntryFamily, EntryKind, EntryPoint, EntryTrait, FileEntry, Role } from '../../../engine/types';
import { MethodBadge, RoleDot, Empty } from './Bits';
import { IconChevron, IconFile, IconFolder } from './Icons';
import { METHOD_COLORS } from '../lib/roles';

type Tab = EntryKind | 'files';

const TAB_LABEL: Record<Tab, string> = {
  custom: 'Pinned',
  'http-route': 'Routes',
  page: 'Pages',
  process: 'Processes',
  job: 'Jobs',
  channel: 'Channels',
  files: 'Files',
};

const TAB_HELP: Record<Tab, string> = {
  custom: 'Entry points you pinned yourself (Inspector → Pin as entry point, or Project settings).',
  'http-route': 'URLs this app answers. Pick one to see every function the request passes through.',
  page: 'Screens in the user interface and the component that renders each one.',
  process: 'Programs that can be started: main() functions and startup scripts.',
  job: 'Code the framework runs on a schedule or when a message arrives.',
  channel: 'Shared memory, sockets and message topics that connect processes. Pick one to see who writes and who reads.',
  files: 'Every source file, if you would rather browse by folder.',
};

const NOUN: Record<EntryKind, string> = { 'http-route': 'route', page: 'page', process: 'process', job: 'job', channel: 'channel', custom: 'entry point' };
const TRAIT_LABEL: Partial<Record<EntryTrait, { label: string; title: string }>> = {
  ai: { label: 'AI', title: 'Calls an AI model' },
  stream: { label: 'stream', title: 'Streams its response (server-sent events, chunked output)' },
  auth: { label: 'auth', title: 'Authentication, sessions or tokens' },
  realtime: { label: 'live', title: 'Keeps a live connection open (WebSocket)' },
};

/** A section of the importance view: key entry points, one family, or everything else. */
type Section = { id: string; title: string; explain?: string; items: EntryPoint[]; family?: EntryFamily; defaultOpen: boolean };

export const entryRole = (e: EntryPoint): Role => (e.kind === 'http-route' ? 'route' : e.kind === 'page' ? 'page' : e.kind === 'channel' ? 'channel' : 'entry');

export function Guide() {
  const summary = useStore((s) => s.summary)!;
  const trail = useStore((s) => s.trail);
  const openEntry = useStore((s) => s.openEntry);
  const openCode = useStore((s) => s.openCode);
  const code = useStore((s) => s.code);
  const counts = useMemo(() => {
    const c = new Map<Tab, number>();
    for (const e of summary.entries) c.set(e.kind, (c.get(e.kind) ?? 0) + 1);
    return c;
  }, [summary]);
  const tabs = (['custom', 'http-route', 'page', 'process', 'job', 'channel'] as Tab[]).filter((t) => counts.get(t)).concat('files');
  const [tabState, setTab] = useState<Tab>(() => tabs.find((t) => t !== 'custom') ?? tabs[0]);
  // Re-indexing can remove a tab (e.g. the last pinned entry); fall back to the first available one.
  const tab = tabs.includes(tabState) ? tabState : tabs[0];
  const [filter, setFilter] = useState('');
  const [methods, setMethods] = useState<Set<string>>(new Set());
  const [groupByState, setGroupBy] = useState<'importance' | 'source' | 'path' | null>(null);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [opened, setOpened] = useState<Set<string>>(new Set());
  const traceFrom = useStore((s) => s.traceFrom);
  const activeId = trail[0]?.id;

  const list = useMemo(() => summary.entries.filter((e) => e.kind === tab), [summary, tab]);
  // Long lists start with the most central entry points; short ones keep the familiar file grouping.
  const ranked = list.some((e) => e.insight?.tier === 'key' || e.insight?.family);
  const groupBy = groupByState ?? (ranked && list.length >= 15 ? 'importance' : 'source');
  const allMethods = useMemo(() => [...new Set(list.map((e) => e.method ?? 'ANY'))].sort(), [list]);

  const filtered = useMemo(() => {
    const q = filter.trim().toLowerCase();
    return list.filter((e) => {
      if (methods.size && !methods.has(e.method ?? 'ANY')) return false;
      if (!q) return true;
      return `${e.label} ${e.handlerName ?? ''} ${e.group} ${e.file} ${e.insight?.gist ?? ''}`.toLowerCase().includes(q);
    });
  }, [list, filter, methods]);

  const sections = useMemo((): Section[] | null => {
    if (groupBy !== 'importance' || tab === 'files') return null;
    const noun = NOUN[tab as EntryKind] ?? 'entry point';
    const byScore = (a: EntryPoint, b: EntryPoint) => (b.insight?.score ?? 0) - (a.insight?.score ?? 0) || a.label.localeCompare(b.label);
    const key = filtered.filter((e) => e.insight?.tier === 'key').sort(byScore);
    const out: Section[] = [];
    if (key.length) out.push({ id: 'key', title: `Key ${noun}s`, explain: `The ${noun}s that reach the most code and data, are used from the most places, or handle AI, streaming or sign-in. Hover a row for every reason.`, items: key, defaultOpen: true });
    for (const fam of summary.families.filter((f) => f.kind === tab)) {
      const members = new Set(fam.members);
      const items = filtered.filter((e) => members.has(e.id)).sort((a, b) => (a.path ?? a.label).localeCompare(b.path ?? b.label));
      if (items.length) out.push({ id: fam.id, title: fam.label, explain: fam.explain, items, family: fam, defaultOpen: !!filter.trim() });
    }
    const rest = filtered.filter((e) => e.insight?.tier !== 'key' && !e.insight?.family).sort(byScore);
    if (rest.length) out.push({ id: 'rest', title: out.length ? `Other ${noun}s` : `All ${noun}s`, explain: out.length ? 'Most central first.' : undefined, items: rest, defaultOpen: true });
    return out;
  }, [groupBy, tab, filtered, summary, filter]);

  const groups = useMemo(() => {
    const m = new Map<string, EntryPoint[]>();
    for (const e of filtered) {
      const key = groupBy === 'path' && e.path ? '/' + (e.path.split('/').filter(Boolean)[0] ?? '') : e.group;
      if (!m.has(key)) m.set(key, []);
      m.get(key)!.push(e);
    }
    return [...m.entries()];
  }, [filtered, groupBy]);

  const toggleGroup = (g: string) =>
    setCollapsed((c) => {
      const n = new Set(c);
      if (n.has(g)) n.delete(g);
      else n.add(g);
      return n;
    });

  return (
    <aside className="panel guide" aria-label="Guide" data-hint="guide">
      <div className="panel-head">
        <div className="seg" role="tablist">
          {tabs.map((t) => (
            <button key={t} role="tab" aria-selected={tab === t} className={tab === t ? 'active' : ''} onClick={() => setTab(t)} title={TAB_HELP[t]}>
              {TAB_LABEL[t]}
              {t !== 'files' && <span className="count">{counts.get(t)}</span>}
            </button>
          ))}
        </div>
        {tab !== 'files' && (
          <>
            <input className="input" placeholder={`Filter ${TAB_LABEL[tab].toLowerCase()}…`} value={filter} onChange={(e) => setFilter(e.target.value)} aria-label="Filter" />
            {tab !== 'http-route' && ranked && (
              <select className="select" value={groupBy === 'importance' ? 'importance' : 'source'} onChange={(e) => setGroupBy(e.target.value as 'importance' | 'source')} aria-label="Order">
                <option value="importance">By importance</option>
                <option value="source">By file</option>
              </select>
            )}
            {tab === 'http-route' && (
              <div className="row" style={{ justifyContent: 'space-between', alignItems: 'flex-start' }}>
                <div className="chips">
                  {allMethods.map((m) => (
                    <button
                      key={m}
                      className={`chip ${methods.has(m) ? 'on' : ''}`}
                      style={{ '--mc': METHOD_COLORS[m] } as CSSProperties}
                      onClick={() =>
                        setMethods((s) => {
                          const n = new Set(s);
                          if (n.has(m)) n.delete(m);
                          else n.add(m);
                          return n;
                        })
                      }
                    >
                      {m}
                    </button>
                  ))}
                </div>
                <select className="select" value={groupBy} onChange={(e) => setGroupBy(e.target.value as 'importance' | 'source' | 'path')} aria-label="Group routes by">
                  {ranked && <option value="importance">By importance</option>}
                  <option value="source">By file</option>
                  <option value="path">By path</option>
                </select>
              </div>
            )}
          </>
        )}
      </div>
      <div className="panel-body">
        {tab === 'files' ? (
          <FileTree files={summary.files} activeFile={code?.file} onOpen={(f) => openCode({ file: f }, f.split('/').pop(), 'other')} />
        ) : filtered.length === 0 ? (
          <Empty>Nothing matches.</Empty>
        ) : sections ? (
          sections.map((sec) => {
            const open = opened.has(sec.id) ? true : collapsed.has(sec.id) ? false : sec.defaultOpen;
            const toggle = () => {
              setOpened((s) => {
                const n = new Set(s);
                if (open) n.delete(sec.id);
                else n.add(sec.id);
                return n;
              });
              setCollapsed((s) => {
                const n = new Set(s);
                if (open) n.add(sec.id);
                else n.delete(sec.id);
                return n;
              });
            };
            return (
              <div key={sec.id} className={`guide-section ${sec.family ? 'family' : sec.id}`}>
                <button className="group-head" onClick={toggle} aria-expanded={open} title={sec.explain}>
                  <IconChevron size={12} open={open} />
                  <span className="ellipsis grow">{sec.title}</span>
                  <span>{sec.items.length}</span>
                </button>
                {open && sec.explain && (
                  <div className="section-explain">
                    {sec.explain}
                    {sec.family && sec.family.shared.length > 0 && (
                      <div className="row" style={{ flexWrap: 'wrap', gap: 4, marginTop: 4 }}>
                        <span>Shared code:</span>
                        {sec.family.shared.map((s) => (
                          <button key={s.id} className="link mono" onClick={() => traceFrom(s.id, s.name, 'service')} title="Draw the flow of the shared code">
                            {s.name}
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                )}
                {open && sec.items.map((e) => <EntryRow key={e.id} e={e} active={activeId === e.id} sub={sec.id === 'key' ? 'reasons' : 'gist'} onOpen={() => openEntry(e.id, e.label, entryRole(e), e.handlerId)} />)}
              </div>
            );
          })
        ) : (
          groups.map(([g, items]) => (
            <div key={g}>
              {groups.length > 1 && (
                <button className="group-head" onClick={() => toggleGroup(g)} aria-expanded={!collapsed.has(g)}>
                  <IconChevron size={12} open={!collapsed.has(g)} />
                  <span className="ellipsis grow">{g}</span>
                  <span>{items.length}</span>
                </button>
              )}
              {!collapsed.has(g) && items.map((e) => <EntryRow key={e.id} e={e} active={activeId === e.id} sub="handler" onOpen={() => openEntry(e.id, e.label, entryRole(e), e.handlerId)} />)}
            </div>
          ))
        )}
      </div>
    </aside>
  );
}

function EntryRow({ e, active, sub, onOpen }: { e: EntryPoint; active: boolean; sub: 'handler' | 'gist' | 'reasons'; onOpen: () => void }) {
  const ins = e.insight;
  const line = sub === 'reasons' ? ins?.reasons.slice(0, 2).join(' · ') : sub === 'gist' ? ins?.gist ?? e.handlerName : e.handlerName;
  const title = [e.label, e.handlerName, `${e.file}:${e.line}`, ...(ins?.reasons.length ? ['', 'Why:', ...ins.reasons.map((r) => `• ${r}`)] : []), ...(e.notes ?? [])].filter((x) => x !== undefined).join('\n');
  return (
    <button className={`entry-row ${active ? 'active' : ''}`} onClick={onOpen} title={title}>
      {e.kind === 'http-route' ? <MethodBadge method={e.method} /> : <RoleDot role={entryRole(e)} />}
      <span className="grow col" style={{ minWidth: 0 }}>
        <span className="row" style={{ gap: 4, minWidth: 0 }}>
          <span className="path ellipsis">{e.kind === 'http-route' || e.kind === 'page' ? e.path : e.label}</span>
          {ins?.traits.map((t) => TRAIT_LABEL[t] && <span key={t} className={`trait trait-${t}`} title={TRAIT_LABEL[t]!.title}>{TRAIT_LABEL[t]!.label}</span>)}
        </span>
        {line && <span className="handler ellipsis">{line}</span>}
      </span>
      {!e.handlerId && <span className="faint" title="Handler could not be resolved">?</span>}
    </button>
  );
}

interface TreeNode {
  name: string;
  path: string;
  children: Map<string, TreeNode>;
  file?: FileEntry;
}

function FileTree({ files, activeFile, onOpen }: { files: FileEntry[]; activeFile?: string; onOpen: (f: string) => void }) {
  const root = useMemo(() => {
    const r: TreeNode = { name: '', path: '', children: new Map() };
    for (const f of files) {
      const parts = f.path.split('/');
      let cur = r;
      parts.forEach((p, i) => {
        let n = cur.children.get(p);
        if (!n) {
          n = { name: p, path: parts.slice(0, i + 1).join('/'), children: new Map() };
          cur.children.set(p, n);
        }
        if (i === parts.length - 1) n.file = f;
        cur = n;
      });
    }
    return r;
  }, [files]);
  const [open, setOpen] = useState<Set<string>>(() => {
    // Open the path down to the first source folder so the tree is not a wall of collapsed rows.
    const s = new Set<string>();
    let cur = root;
    while (cur.children.size === 1) {
      const only = [...cur.children.values()][0];
      if (only.file) break;
      s.add(only.path);
      cur = only;
    }
    return s;
  });

  const render = (n: TreeNode, depth: number): ReactNode[] => {
    const kids = [...n.children.values()].sort((a, b) => Number(!!a.file) - Number(!!b.file) || a.name.localeCompare(b.name));
    const out: ReactNode[] = [];
    for (const k of kids) {
      if (k.file) {
        out.push(
          <button key={k.path} className={`tree-row ${activeFile === k.path ? 'active' : ''}`} style={{ paddingLeft: 10 + depth * 14 }} onClick={() => onOpen(k.path)}>
            <IconFile size={13} className="faint" />
            <span className="ellipsis grow">{k.name}</span>
            <span className="faint" style={{ fontSize: 10.5 }}>{k.file.lines}</span>
          </button>,
        );
      } else {
        const isOpen = open.has(k.path);
        out.push(
          <button
            key={k.path}
            className="tree-row"
            style={{ paddingLeft: 10 + depth * 14 }}
            onClick={() =>
              setOpen((s) => {
                const ns = new Set(s);
                if (ns.has(k.path)) ns.delete(k.path);
                else ns.add(k.path);
                return ns;
              })
            }
            aria-expanded={isOpen}
          >
            <IconChevron size={11} open={isOpen} />
            <IconFolder size={13} className="faint" />
            <span className="ellipsis">{k.name}</span>
          </button>,
        );
        if (isOpen) out.push(...render(k, depth + 1));
      }
    }
    return out;
  };
  return <div style={{ padding: '4px 0' }}>{render(root, 0)}</div>;
}
