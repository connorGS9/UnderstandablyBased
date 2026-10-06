import type { CSSProperties, ReactNode } from 'react';
import type { Role } from '../../../engine/types';
import { METHOD_COLORS, ROLES, roleColor } from '../lib/roles';

export function MethodBadge({ method }: { method?: string }) {
  const m = (method ?? 'ANY').toUpperCase();
  return (
    <span className="method" style={{ '--mc': METHOD_COLORS[m] ?? 'var(--m-any)' } as CSSProperties}>
      {m === 'DELETE' ? 'DEL' : m}
    </span>
  );
}

export function RoleChip({ role, title }: { role?: Role; title?: string }) {
  const r = role ?? 'other';
  return (
    <span className="role-chip" style={{ '--rc': roleColor(r) } as CSSProperties} title={title ?? ROLES[r].explain}>
      <span className="role-dot" />
      {ROLES[r].short}
    </span>
  );
}

export function RoleDot({ role }: { role?: Role }) {
  return <span className="role-dot" style={{ '--rc': roleColor(role) } as CSSProperties} title={ROLES[role ?? 'other'].label} />;
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="empty">{children}</div>;
}

export function shortFile(path: string, parts = 2): string {
  const segs = path.split('/');
  return segs.length <= parts ? path : '…/' + segs.slice(-parts).join('/');
}
