import { useEffect, useState } from 'react';

export type Theme = 'dark' | 'light';
const listeners = new Set<(t: Theme) => void>();

function systemTheme(): Theme {
  return window.matchMedia?.('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
}

function stored(): Theme | null {
  try {
    const v = localStorage.getItem('ub.theme');
    return v === 'light' || v === 'dark' ? v : null;
  } catch {
    return null;
  }
}

let current: Theme = 'dark';

export function initTheme() {
  current = stored() ?? systemTheme();
  document.documentElement.dataset.theme = current;
}

export function setTheme(t: Theme) {
  current = t;
  document.documentElement.dataset.theme = t;
  try {
    localStorage.setItem('ub.theme', t);
  } catch {
    /* ignore */
  }
  listeners.forEach((l) => l(t));
}

export function useTheme(): [Theme, (t: Theme) => void] {
  const [t, setT] = useState<Theme>(current);
  useEffect(() => {
    listeners.add(setT);
    return () => {
      listeners.delete(setT);
    };
  }, []);
  return [t, setTheme];
}
