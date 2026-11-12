import Link from 'next/link';
import type { ReactNode } from 'react';
import { ROLE_LABELS } from '@/lib/roles';
import { requireWorkspace } from '@/lib/session';

export default async function WorkspaceLayout({
  children,
  params,
}: {
  children: ReactNode;
  params: Promise<{ workspaceId: string }>;
}) {
  const { workspaceId } = await params;
  const { workspace, user } = await requireWorkspace(workspaceId);
  const base = `/w/${workspace.id}`;

  return (
    <div className="shell">
      <header className="topbar">
        <div className="row">
          <Link href="/workspaces" className="brand">AI SDR Platform</Link>
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
        <Link href={`${base}/campaigns`}>Campaigns</Link>
        <Link href={`${base}/leads`}>Leads</Link>
        <Link href={`${base}/inbox`}>Inbox</Link>
        <Link href={`${base}/calls`}>Calls</Link>
        <Link href={`${base}/texts`}>Texts</Link>
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
