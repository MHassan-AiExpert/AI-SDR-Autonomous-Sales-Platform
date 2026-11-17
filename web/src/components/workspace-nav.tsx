'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Icon } from './icons';
import { NAV_GROUPS, isActive } from '@/lib/nav';
import type { Theme } from '@/lib/theme';

/** The grouped sidebar links, with the current page highlighted. */
export function WorkspaceNav({ base, unread, inbox }: { base: string; unread: number; inbox: number }) {
  const pathname = usePathname() ?? base;
  const counts: Record<string, number> = { '/notifications': unread, '/inbox': inbox };
  return (
    <nav className="nav" aria-label="Workspace">
      {NAV_GROUPS.map((group) => (
        <div className="nav-group" key={group.title ?? 'main'} role="group" aria-label={group.title ?? 'Main'}>
          {group.title ? <span className="nav-title" aria-hidden="true">{group.title}</span> : null}
          {group.items.map((item) => {
            const n = counts[item.href] ?? 0;
            return (
              <Link key={item.href} href={base + item.href} aria-current={isActive(pathname, base, item.href) ? 'page' : undefined}>
                <Icon name={item.icon} />
                <span className="nav-label">{item.label}</span>
                {n > 0 ? <span className="nav-count" aria-label={`${n} new`}>{n > 99 ? '99+' : n}</span> : null}
              </Link>
            );
          })}
        </div>
      ))}
    </nav>
  );
}

/** Dark / Light switch. A plain form, so it works before scripts load. */
export function ThemeSwitch({ theme }: { theme: Theme | null }) {
  const pathname = usePathname() ?? '/workspaces';
  return (
    <form method="post" action="/theme" className="theme-switch" aria-label="Appearance">
      <input type="hidden" name="back" value={pathname} />
      <button type="submit" name="theme" value="dark" aria-pressed={theme === 'dark'}>☾ Dark</button>
      <button type="submit" name="theme" value="light" aria-pressed={theme === 'light'}>☀ Light</button>
    </form>
  );
}
