import Link from 'next/link';
import type { ReactNode } from 'react';
import { cookies } from 'next/headers';
import { ROLE_LABELS } from '@/lib/roles';
import { requireWorkspace } from '@/lib/session';
import { BrandMark } from '@/components/brand-mark';
import { Icon } from '@/components/icons';
import { ThemeSwitch, WorkspaceNav } from '@/components/workspace-nav';
import { brandStyle, workspaceBrand } from '@/lib/brand';
import { THEME_COOKIE, readTheme } from '@/lib/theme';
import type { Metadata } from 'next';

export async function generateMetadata({ params }: { params: Promise<{ workspaceId: string }> }): Promise<Metadata> {
  const { workspaceId } = await params;
  const brand = await workspaceBrand(workspaceId);
  return { title: { default: brand.app_name, template: `%s · ${brand.app_name}` } };
}

export default async function WorkspaceLayout({
  children,
  params,
}: {
  children: ReactNode;
  params: Promise<{ workspaceId: string }>;
}) {
  const { workspaceId } = await params;
  const { supabase, workspace, user } = await requireWorkspace(workspaceId);
  const base = `/w/${workspace.id}`;
  const brand = await workspaceBrand(workspace.id);
  const theme = readTheme((await cookies()).get(THEME_COOKIE)?.value);
  const { data: seen } = await supabase.from('notification_seen').select('seen_at').eq('workspace_id', workspace.id).eq('user_id', user.id).maybeSingle();
  let unreadQ = supabase.from('notifications').select('id', { count: 'exact', head: true }).eq('workspace_id', workspace.id);
  if (seen?.seen_at) unreadQ = unreadQ.gt('created_at', seen.seen_at);
  const [{ count: unread }, { count: inbox }] = await Promise.all([
    unreadQ,
    supabase.from('replies').select('id', { count: 'exact', head: true }).eq('workspace_id', workspace.id).is('handled_at', null),
  ]);

  return (
    <div className="shell app" style={brandStyle(brand)}>
      <aside className="sidebar">
        <div className="side-brand">
          <Link href="/workspaces" className="brand-link" aria-label={`${brand.app_name}: all workspaces`}><BrandMark brand={brand} /></Link>
          <div className="side-ws">
            <strong>{workspace.name}</strong>
            <span className="badge">{ROLE_LABELS[workspace.role]}</span>
          </div>
        </div>
        <WorkspaceNav base={base} unread={unread ?? 0} inbox={inbox ?? 0} />
        <div className="side-foot">
          <ThemeSwitch theme={theme} />
        </div>
      </aside>
      <div className="main-col">
        <header className="topbar">
          <form className="search" action={`${base}/leads`} method="get" role="search">
            <Icon name="search" />
            <label htmlFor="global-search" className="sr-only">Search leads</label>
            <input id="global-search" type="search" name="q" placeholder="Search leads by name, company or email" maxLength={80} />
          </form>
          <Link href={`${base}/notifications`} className="icon-btn" aria-label={unread ? `Notifications, ${unread} new` : 'Notifications'}>
            <Icon name="bell" />
            {unread ? <span className="dot" aria-hidden="true" /> : null}
          </Link>
          <div className="user">
            <span className="user-email">{user.email}</span>
            <form action="/auth/signout" method="post"><button className="btn btn-ghost" type="submit">Sign out</button></form>
          </div>
        </header>
        {workspace.outreach_paused ? (
          <p className="banner" role="status">All outreach is paused for this workspace. No emails, calls or messages are being sent.</p>
        ) : null}
        <main className="content stack-lg">{children}</main>
      </div>
    </div>
  );
}
