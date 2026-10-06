import { useEffect, useRef, useState } from 'react';
import { api } from '../api';
import { useStore, type CodeLoc } from '../store';
import type { CodeLink, FileView, SymbolRef } from '../../../engine/types';
import { monaco, languageForPath } from '../lib/monaco';
import { loadFile } from '../lib/cache';
import { useHint } from '../lib/hints';
import { useTheme } from '../lib/theme';
import { CONFIDENCE, ROLES } from '../lib/roles';
import { RoleChip, RoleDot } from './Bits';
import { IconExternal, IconFlow } from './Icons';


const contains = (l: CodeLink, line: number, col: number) =>
  (line > l.range.sl || (line === l.range.sl && col >= l.range.sc)) && (line < l.range.el || (line === l.range.el && col < l.range.ec));

function targetLabel(t: SymbolRef) {
  return t.container ? `${t.container}.${t.name}` : t.name;
}

export function CodeView({ loc }: { loc: CodeLoc }) {
  const host = useRef<HTMLDivElement>(null);
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  const decoRef = useRef<monaco.editor.IEditorDecorationsCollection | null>(null);
  const linksRef = useRef<CodeLink[]>([]);
  const [file, setFile] = useState<FileView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; link: CodeLink } | null>(null);
  const [theme] = useTheme();
  const dive = useStore((s) => s.dive);
  const traceFrom = useStore((s) => s.traceFrom);
  const showFlow = useStore((s) => s.showFlow);
  const flowRoot = useStore((s) => s.flowRoot);
  const revision = useStore((s) => s.revision);
  useHint('code-view', !!file);

  // Create the editor once.
  useEffect(() => {
    const ed = monaco.editor.create(host.current!, {
      readOnly: true,
      domReadOnly: true,
      automaticLayout: true,
      fontFamily: "'JetBrains Mono', 'Cascadia Code', 'Fira Code', ui-monospace, Menlo, Consolas, monospace",
      fontSize: 13,
      lineHeight: 20,
      minimap: { enabled: true, scale: 1, renderCharacters: false },
      scrollBeyondLastLine: false,
      stickyScroll: { enabled: true },
      renderLineHighlight: 'line',
      smoothScrolling: true,
      padding: { top: 8, bottom: 24 },
      theme: theme === 'dark' ? 'ub-dark' : 'ub-light',
      contextmenu: true,
      links: false,
      occurrencesHighlight: 'singleFile',
      glyphMargin: false,
      folding: true,
      hover: { delay: 250 },
    });
    editorRef.current = ed;
    decoRef.current = ed.createDecorationsCollection();

    const down = ed.onMouseDown((e) => {
      const pos = e.target.position;
      if (!pos || e.event.rightButton || e.event.altKey) return;
      const link = linksRef.current.find((l) => contains(l, pos.lineNumber, pos.column));
      if (!link) return;
      e.event.preventDefault();
      if (link.targets.length === 1) {
        const t = link.targets[0];
        dive({ id: t.id, label: targetLabel(t), role: t.role, file: t.file, line: t.line });
      } else {
        setMenu({ x: e.event.posx, y: e.event.posy, link });
      }
    });
    return () => {
      down.dispose();
      ed.getModel()?.dispose();
      ed.dispose();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    monaco.editor.setTheme(theme === 'dark' ? 'ub-dark' : 'ub-light');
  }, [theme]);

  // Hover cards explaining where each link goes and how sure we are.
  useEffect(() => {
    const ids = ['javascript', 'typescript', 'java', 'python', 'cpp', 'go', 'rust', 'csharp'];
    const subs = ids.map((id) =>
      monaco.languages.registerHoverProvider(id, {
        provideHover(model, position) {
          if (model !== editorRef.current?.getModel()) return null;
          const link = linksRef.current.find((l) => contains(l, position.lineNumber, position.column));
          if (!link) return null;
          const lines = link.targets.map((t) => `**${targetLabel(t)}** — ${ROLES[t.role].label}  \n\`${t.file ?? ''}${t.line ? ':' + t.line : ''}\``);
          return {
            range: new monaco.Range(link.range.sl, link.range.sc, link.range.el, link.range.ec),
            contents: [
              { value: lines.join('\n\n') },
              { value: `_${CONFIDENCE[link.confidence].label}:_ ${link.reason}` },
              { value: link.targets.length > 1 ? 'Click to choose which one to follow.' : 'Click to follow this call. Hold Alt to place the cursor instead.' },
            ],
          };
        },
      }),
    );
    return () => subs.forEach((s) => s.dispose());
  }, []);

  // Load the file when the location changes.
  useEffect(() => {
    let cancelled = false;
    setError(null);
    setMenu(null);
    loadFile(loc.file)
      .then((f) => {
        if (cancelled) return;
        setFile(f);
        const ed = editorRef.current!;
        const uri = monaco.Uri.parse(`ub://project/${encodeURI(f.path)}`);
        let model = monaco.editor.getModel(uri);
        if (!model) model = monaco.editor.createModel(f.content, languageForPath(f.path, f.lang), uri);
        else if (model.getValue() !== f.content) model.setValue(f.content); // file changed on disk
        if (ed.getModel() !== model) {
          const old = ed.getModel();
          ed.setModel(model);
          if (old && old !== model) old.dispose();
        }
        linksRef.current = f.links;
        const focus = loc.symbolId ? f.symbols.find((s) => s.id === loc.symbolId) : undefined;
        const startLine = focus?.range.sl ?? loc.line ?? 1;
        const endLine = focus?.range.el ?? loc.endLine ?? startLine;
        const decos: monaco.editor.IModelDeltaDecoration[] = f.links.map((l) => ({
          range: new monaco.Range(l.range.sl, l.range.sc, l.range.el, l.range.ec),
          options: { inlineClassName: `ub-link ${l.confidence !== 'certain' ? 'ub-link-' + l.confidence : ''}`, stickiness: 1 },
        }));
        if (loc.line || focus) {
          decos.push({
            range: new monaco.Range(startLine, 1, endLine, 1),
            options: { isWholeLine: true, className: 'ub-focus-line', linesDecorationsClassName: 'ub-focus-gutter' },
          });
        }
        decoRef.current!.set(decos);
        if (loc.line || focus) {
          ed.revealLineNearTop(startLine, monaco.editor.ScrollType.Immediate);
          ed.setPosition({ lineNumber: startLine, column: 1 });
        } else ed.setScrollTop(0);
      })
      .catch((e) => !cancelled && setError(String(e.message ?? e)));
    return () => {
      cancelled = true;
    };
  }, [loc.file, loc.line, loc.endLine, loc.symbolId, revision]);

  const focus = file && loc.symbolId ? file.symbols.find((s) => s.id === loc.symbolId) : undefined;

  return (
    <div className="code-wrap" onClick={() => menu && setMenu(null)} data-hint="code">
      <div className="code-head">
        {focus?.role && <RoleChip role={focus.role} />}
        <span className="mono ellipsis grow" title={loc.file}>
          {focus && <b style={{ fontFamily: 'var(--font-ui)', fontSize: 13 }}>{focus.container ? `${focus.container}.${focus.name}` : focus.name}</b>}
          <span className="faint">
            {focus ? '  ·  ' : ''}
            {loc.file}
            {focus ? `:${focus.range.sl}` : loc.line ? `:${loc.line}` : ''}
          </span>
        </span>
        <span className="faint" style={{ fontSize: 11 }} title="Underlined names are calls we could link. Click one to follow it.">
          {file ? `${file.links.length} linked calls` : ''}
        </span>
        {loc.symbolId && (
          <button className="btn small" onClick={() => traceFrom(loc.symbolId!, focus ? (focus.container ? `${focus.container}.${focus.name}` : focus.name) : loc.file, focus?.role ?? 'other')} title="Draw the flow starting at this function">
            <IconFlow size={14} /> Trace from here
          </button>
        )}
        {flowRoot && (
          <button className="btn small" onClick={showFlow} title="Back to the flow diagram">
            Flow
          </button>
        )}
        {api.platform === 'electron' && (
          <button className="btn small ghost" onClick={() => api.openInEditor(loc.file, focus?.range.sl ?? loc.line)} title="Open this file in VS Code">
            <IconExternal size={14} /> Editor
          </button>
        )}
      </div>
      <div className="code-host" ref={host} />
      {error && (
        <div className="welcome" style={{ position: 'absolute', inset: 0 }}>
          <div className="error-banner">{error}</div>
        </div>
      )}
      {menu && (
        <div
          className="palette"
          style={{ position: 'fixed', left: menu.x, top: menu.y + 12, width: 340, maxHeight: 280, zIndex: 40, padding: 4 }}
          onClick={(e) => e.stopPropagation()}
          role="menu"
        >
          <div className="faint" style={{ padding: '6px 10px', fontSize: 11 }}>
            {menu.link.reason}
          </div>
          {menu.link.targets.map((t) => (
            <button
              key={t.id}
              className="palette-item"
              role="menuitem"
              onClick={() => {
                setMenu(null);
                dive({ id: t.id, label: targetLabel(t), role: t.role, file: t.file, line: t.line });
              }}
            >
              <RoleDot role={t.role} />
              <span className="grow col">
                <span>{targetLabel(t)}</span>
                <span className="faint mono" style={{ fontSize: 11 }}>
                  {t.file}:{t.line}
                </span>
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
