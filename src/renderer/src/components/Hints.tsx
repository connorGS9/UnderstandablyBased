import { useEffect, useRef, useState } from 'react';
import { useHints } from '../lib/hints';
import { useStore } from '../store';
import { IconBulb, IconX } from './Icons';

const isMac = navigator.platform.toLowerCase().includes('mac');
const keycap = (k: string) => (isMac ? k.replace('Ctrl+', '⌘').replace('Alt+', '⌥') : k);

/** The tip toast (one at a time) plus the "tips turned off — Undo" toast. */
export function HintToasts() {
  const enabled = useHints((s) => s.enabled);
  const queue = useHints((s) => s.queue);
  const undoVisible = useHints((s) => s.undoVisible);
  const { dismiss, disable, undoDisable, hideUndo } = useHints.getState();
  const cur = enabled ? queue[0] : undefined;
  const more = enabled ? queue.length - 1 : 0;

  // Gently highlight what the tip is talking about.
  useEffect(() => {
    if (!cur?.content.target) return;
    const el = document.querySelector(cur.content.target);
    el?.classList.add('hint-target');
    return () => el?.classList.remove('hint-target');
  }, [cur]);

  // Escape closes the tip, unless a dialog is open (it handles Escape itself).
  useEffect(() => {
    if (!cur) return;
    const onKey = (e: KeyboardEvent) => {
      const s = useStore.getState();
      // Dialogs and the tips menu handle Escape themselves.
      if (e.key === 'Escape' && !s.paletteOpen && !s.settingsOpen && !document.querySelector('.menu')) dismiss();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [cur, dismiss]);

  // The undo offer disappears on its own after a while.
  useEffect(() => {
    if (!undoVisible) return;
    const t = setTimeout(hideUndo, 10000);
    return () => clearTimeout(t);
  }, [undoVisible, hideUndo]);

  return (
    <div className="toasts" aria-live="polite">
      {cur && (
        <div className="toast" role="status" key={cur.id}>
          <div className="toast-head">
            <span className="toast-badge">
              <IconBulb size={14} /> Tip
            </span>
            {more > 0 && <span className="faint">{more} more after this</span>}
            <span className="grow" />
            <button className="icon-btn small" onClick={dismiss} aria-label="Close tip" title="Close (Esc)">
              <IconX size={14} />
            </button>
          </div>
          <div className="toast-title">{cur.content.title}</div>
          <p className="toast-body">{cur.content.body}</p>
          {cur.content.keys && (
            <div className="row" style={{ gap: 4, flexWrap: 'wrap', marginBottom: 10 }}>
              {cur.content.keys.map((k) => (
                <span key={k} className="kbd">
                  {keycap(k)}
                </span>
              ))}
            </div>
          )}
          <div className="toast-foot">
            <button className="link toast-off" onClick={disable}>
              Turn off tips
            </button>
            <button className="btn small primary" onClick={dismiss} autoFocus={false}>
              {more > 0 ? 'Next tip' : 'Got it'}
            </button>
          </div>
        </div>
      )}
      {undoVisible && (
        <div className="toast toast-undo" role="status">
          <span className="grow">
            Tips are off. Turn them back on any time with the <IconBulb size={13} style={{ verticalAlign: '-2px' }} /> button in the top bar.
          </span>
          <button className="btn small" onClick={undoDisable}>
            Undo
          </button>
        </div>
      )}
    </div>
  );
}

/** Top-bar control: tips on/off and "show all tips again". */
export function HintsMenu() {
  const enabled = useHints((s) => s.enabled);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const { enable, disable, replayAll } = useHints.getState();

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <div className="menu-anchor" ref={ref}>
      <button
        className={`icon-btn ${enabled ? 'bulb-on' : ''}`}
        onClick={() => setOpen((o) => !o)}
        title={enabled ? 'Tips are on' : 'Tips are off'}
        aria-label={enabled ? 'Tips are on — open tip settings' : 'Tips are off — open tip settings'}
        aria-expanded={open}
      >
        <IconBulb off={!enabled} />
      </button>
      {open && (
        <div className="menu" role="menu">
          <label className="menu-row toggle">
            <span className="grow">
              <b style={{ color: 'var(--text)' }}>Show tips</b>
              <span className="faint" style={{ display: 'block', fontSize: 11.5 }}>
                Short explanations the first time you see each screen.
              </span>
            </span>
            <span className={`switch ${enabled ? 'on' : ''}`}>
              <input type="checkbox" role="switch" checked={enabled} onChange={(e) => (e.target.checked ? enable() : disable())} aria-label="Show tips" />
            </span>
          </label>
          <button
            className="menu-row menu-item"
            onClick={() => {
              replayAll();
              setOpen(false);
            }}
          >
            Show all tips again
            <span className="faint" style={{ display: 'block', fontSize: 11.5 }}>
              Tips reappear as you visit each screen.
            </span>
          </button>
        </div>
      )}
    </div>
  );
}
