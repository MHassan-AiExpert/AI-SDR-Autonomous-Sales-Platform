import type { Metadata } from 'next';
import Link from 'next/link';
import { ActionForm, SubmitButton } from '@/components/action-form';
import { requireWorkspace } from '@/lib/session';
import { EVENT_LABELS, SEVERITY_LABELS, SLACK_STATUS_LABELS, safeJoinUrl, safeLink, type NotifyEvent } from '@/lib/notifications';
import { acceptHandoff } from '../actions';

export const metadata: Metadata = { title: 'Notifications' };

type Row = {
  id: string; event: NotifyEvent; severity: string; title: string; body: string; lead_id: string | null; link_path: string | null;
  action_url: string | null; slack_status: string; accepted_by: string | null; accepted_at: string | null; created_at: string;
};

const VIEWS = ['all', 'attention', 'handoffs'] as const;
const VIEW_LABELS: Record<(typeof VIEWS)[number], string> = { all: 'All', attention: 'Needs attention', handoffs: 'Open handoffs' };

export default async function NotificationsPage({ params, searchParams }: { params: Promise<{ workspaceId: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { workspaceId } = await params;
  const { supabase, workspace, user } = await requireWorkspace(workspaceId);
  const sp = await searchParams;
  const raw = Array.isArray(sp.view) ? sp.view[0] : sp.view;
  const view = (VIEWS as readonly string[]).includes(raw ?? '') ? (raw as (typeof VIEWS)[number]) : 'all';

  let q = supabase.from('notifications')
    .select('id, event, severity, title, body, lead_id, link_path, action_url, slack_status, accepted_by, accepted_at, created_at')
    .eq('workspace_id', workspace.id);
  if (view === 'attention') q = q.in('severity', ['warning', 'critical']);
  if (view === 'handoffs') q = q.eq('event', 'handoff').is('accepted_at', null);
  const [{ data }, { data: seen }, { data: members }] = await Promise.all([
    q.order('created_at', { ascending: false }).limit(100),
    supabase.from('notification_seen').select('seen_at').eq('workspace_id', workspace.id).eq('user_id', user.id).maybeSingle(),
    supabase.rpc('workspace_members_list', { ws: workspace.id }),
  ]);
  const rows = (data ?? []) as Row[];
  const seenAt = seen?.seen_at ? new Date(seen.seen_at).getTime() : 0;
  // Opening the page marks everything up to now as seen for this person
  await supabase.from('notification_seen').upsert({ workspace_id: workspace.id, user_id: user.id, seen_at: new Date().toISOString() });
  const names = new Map(((members ?? []) as { user_id: string; email: string | null }[]).map((m) => [m.user_id, m.email ?? 'a teammate']));
  const canAccept = workspace.role !== 'viewer';

  return (
    <>
      <div className="spread">
        <h1>Notifications</h1>
        <nav className="row" aria-label="Filter notifications">
          {VIEWS.map((v) => (
            <Link key={v} href={`/w/${workspace.id}/notifications${v === 'all' ? '' : `?view=${v}`}`} className={v === view ? 'btn btn-secondary' : 'btn btn-ghost'} aria-current={v === view ? 'page' : undefined}>{VIEW_LABELS[v]}</Link>
          ))}
        </nav>
      </div>
      <p className="muted">Every alert the agents raise is kept here, whether or not it also went to Slack. Choose which events go to Slack, quiet hours and alert limits in <Link href={`/w/${workspace.id}/settings`}>Settings</Link>.</p>
      {!rows.length ? <section className="card"><p className="muted">{view === 'all' ? 'No notifications yet.' : 'Nothing here right now.'}</p></section> : null}
      <ul className="notify-list">
        {rows.map((n) => {
          const link = safeLink(n.link_path, workspace.id);
          const join = safeJoinUrl(n.action_url);
          const fresh = new Date(n.created_at).getTime() > seenAt;
          return (
            <li key={n.id} className={`card notify notify-${n.severity}${fresh ? ' notify-new' : ''}`}>
              <div className="spread">
                <strong>{fresh ? <span className="badge badge-ok">New</span> : null} {n.title}</strong>
                <span className="muted">{new Date(n.created_at).toUTCString().slice(5, 22)} UTC</span>
              </div>
              {n.body ? <p className="notify-body">{n.body}</p> : null}
              <div className="row">
                <span className="badge">{EVENT_LABELS[n.event] ?? n.event}</span>
                {n.severity !== 'info' ? <span className={n.severity === 'critical' ? 'badge badge-error' : 'badge badge-warn'}>{SEVERITY_LABELS[n.severity]}</span> : null}
                <span className="muted">{SLACK_STATUS_LABELS[n.slack_status] ?? n.slack_status}</span>
                {link ? <Link href={link}>{n.lead_id ? 'Open lead' : 'Open'}</Link> : null}
                {join ? <a href={join} target="_blank" rel="noopener noreferrer">Join meeting</a> : null}
                {n.event === 'handoff' && n.accepted_at ? <span className="muted">Taken by {n.accepted_by === user.id ? 'you' : names.get(n.accepted_by ?? '') ?? 'a teammate'}</span> : null}
                {n.event === 'handoff' && !n.accepted_at && canAccept ? (
                  <ActionForm action={acceptHandoff}>
                    <input type="hidden" name="workspace_id" value={workspace.id} />
                    <input type="hidden" name="notification_id" value={n.id} />
                    <SubmitButton variant="secondary">I&apos;ll take it</SubmitButton>
                  </ActionForm>
                ) : null}
              </div>
            </li>
          );
        })}
      </ul>
    </>
  );
}
