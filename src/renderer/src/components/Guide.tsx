import { useMemo, useState, type CSSProperties, type ReactNode } from 'react';
import { useStore } from '../store';
import type { EntryKind, EntryPoint, FileEntry, Role } from '../../../engine/types';
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
  const [groupBy, setGroupBy] = useState<'source' | 'path'>('source');
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const activeId = trail[0]?.id;

  const list = useMemo(() => summary.entries.filter((e) => e.kind === tab), [summary, tab]);
  const allMethods = useMemo(() => [...new Set(list.map((e) => e.method ?? 'ANY'))].sort(), [list]);

  const filtered = useMemo(() => {
    const q = filter.trim().toLowerCase();
    return list.filter((e) => {
      if (methods.size && !methods.has(e.method ?? 'ANY')) return false;
      if (!q) return true;
      return `${e.label} ${e.handlerName ?? ''} ${e.group} ${e.file}`.toLowerCase().includes(q);
    });
  }, [list, filter, methods]);

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
                <select className="select" value={groupBy} onChange={(e) => setGroupBy(e.target.value as 'source' | 'path')} aria-label="Group routes by">
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
              {!collapsed.has(g) &&
                items.map((e) => (
                  <button key={e.id} className={`entry-row ${activeId === e.id ? 'active' : ''}`} onClick={() => openEntry(e.id, e.label, entryRole(e), e.handlerId)} title={`${e.label}\n${e.handlerName ?? ''}\n${e.file}:${e.line}${e.notes ? '\n' + e.notes.join('\n') : ''}`}>
                    {e.kind === 'http-route' ? <MethodBadge method={e.method} /> : <RoleDot role={entryRole(e)} />}
                    <span className="grow col" style={{ minWidth: 0 }}>
                      <span className="path ellipsis">{e.kind === 'http-route' || e.kind === 'page' ? e.path : e.label}</span>
                      {e.handlerName && <span className="handler ellipsis">{e.handlerName}</span>}
                    </span>
                    {!e.handlerId && <span className="faint" title="Handler could not be resolved">?</span>}
                  </button>
                ))}
            </div>
          ))
        )}
      </div>
    </aside>
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
