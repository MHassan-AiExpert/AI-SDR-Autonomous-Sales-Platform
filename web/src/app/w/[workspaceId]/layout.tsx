import Link from 'next/link';
import type { ReactNode } from 'react';
import { ROLE_LABELS } from '@/lib/roles';
import { requireWorkspace } from '@/lib/session';
import { BrandMark } from '@/components/brand-mark';
import { brandStyle, workspaceBrand } from '@/lib/brand';
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
  const { data: seen } = await supabase.from('notification_seen').select('seen_at').eq('workspace_id', workspace.id).eq('user_id', user.id).maybeSingle();
  let unreadQ = supabase.from('notifications').select('id', { count: 'exact', head: true }).eq('workspace_id', workspace.id);
  if (seen?.seen_at) unreadQ = unreadQ.gt('created_at', seen.seen_at);
  const { count: unread } = await unreadQ;

  return (
    <div className="shell" style={brandStyle(brand)}>
      <header className="topbar">
        <div className="row">
          <Link href="/workspaces" className="brand-link"><BrandMark brand={brand} /></Link>
          <span className="divider" aria-hidden="true">/</span>
          <span className="ws-name">{workspace.name}</span>
          <span className="badge">{ROLE_LABELS[workspace.role]}</span>
        </div>
        <div className="row">
          <span className="muted">{user.email}</span>
          <form action="/auth/signout" method="post"><button className="btn btn-ghost" type="submit">Sign out</button></form>
        </div>
      </header>
      <nav className="tabs" aria-label="Workspace">
        <Link href={base}>Overview</Link>
        <Link href={`${base}/notifications`}>Notifications{unread ? <span className="nav-count" aria-label={`${unread} new`}>{unread > 99 ? '99+' : unread}</span> : null}</Link>
        <Link href={`${base}/analytics`}>Analytics</Link>
        <Link href={`${base}/campaigns`}>Campaigns</Link>
        <Link href={`${base}/leads`}>Leads</Link>
        <Link href={`${base}/inbox`}>Inbox</Link>
        <Link href={`${base}/calls`}>Calls</Link>
        <Link href={`${base}/texts`}>Texts</Link>
        <Link href={`${base}/deals`}>Deals</Link>
        <Link href={`${base}/playbook`}>Playbook</Link>
        <Link href={`${base}/learning`}>Learning</Link>
        <Link href={`${base}/meetings`}>Meetings</Link>
        <Link href={`${base}/setup`}>Setup</Link>
        <Link href={`${base}/members`}>Team</Link>
        <Link href={`${base}/settings`}>Settings</Link>
      </nav>
      {workspace.outreach_paused ? (
        <p className="banner" role="status">All outreach is paused for this workspace. No emails, calls or messages are being sent.</p>
      ) : null}
      <main className="content stack-lg">{children}</main>
    </div>
  );
}
