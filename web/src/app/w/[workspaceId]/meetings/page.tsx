import type { Metadata } from 'next';
import Link from 'next/link';
import { requireWorkspace } from '@/lib/session';
import { safeMeetingUrl } from '@/lib/replies';

export const metadata: Metadata = { title: 'Meetings' };

type Row = {
  id: string; lead_id: string; starts_at: string; ends_at: string | null; status: string; zoom_url: string | null; event_name: string | null;
  run_by: string; invitee_name: string | null; invitee_email: string | null; reschedule_url: string | null;
  leads: { full_name: string | null; email: string | null; companies: { name: string } | null } | null;
};

const STATUS: Record<string, string> = { scheduled: 'Scheduled', canceled: 'Cancelled', completed: 'Completed', no_show: 'No show' };

export default async function MeetingsPage({ params, searchParams }: { params: Promise<{ workspaceId: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { workspaceId } = await params;
  const { supabase, workspace } = await requireWorkspace(workspaceId);
  const sp = await searchParams;
  const past = (Array.isArray(sp.view) ? sp.view[0] : sp.view) === 'past';
  const now = new Date().toISOString();
  let q = supabase.from('meetings')
    .select('id, lead_id, starts_at, ends_at, status, zoom_url, event_name, run_by, invitee_name, invitee_email, reschedule_url, leads(full_name, email, companies(name))')
    .eq('workspace_id', workspace.id);
  q = past ? q.lt('starts_at', now).order('starts_at', { ascending: false }) : q.gte('starts_at', now).order('starts_at', { ascending: true });
  const { data } = await q.limit(100);
  const rows = (data ?? []) as unknown as Row[];
  const base = `/w/${workspace.id}/meetings`;

  return (
    <>
      <h1>Meetings</h1>
      <p className="muted">Meetings prospects booked through their Calendly links. {workspace.ai_closer_enabled ? 'The AI closer runs them unless you hand one to your team.' : 'Your team runs them; the AI closer is switched off in Settings.'}</p>
      <nav className="chips" aria-label="When">
        <Link className={!past ? 'chip chip-on' : 'chip'} href={base}>Upcoming</Link>
        <Link className={past ? 'chip chip-on' : 'chip'} href={`${base}?view=past`}>Past</Link>
      </nav>
      {!rows.length ? <section className="card"><p className="muted">{past ? 'No past meetings.' : 'No upcoming meetings yet. Interested prospects get a booking link with their answer.'}</p></section> : (
        <div className="table-wrap">
          <table className="table">
            <thead><tr><th scope="col">When (UTC)</th><th scope="col">Prospect</th><th scope="col">Meeting</th><th scope="col">Run by</th><th scope="col">Status</th></tr></thead>
            <tbody>
              {rows.map((m) => {
                const join = safeMeetingUrl(m.zoom_url);
                return (
                  <tr key={m.id}>
                    <td><time dateTime={m.starts_at}>{new Date(m.starts_at).toUTCString().replace(':00 GMT', '')}</time></td>
                    <td><Link href={`/w/${workspace.id}/leads/${m.lead_id}`}>{m.leads?.full_name ?? m.invitee_name ?? m.leads?.email}</Link>{m.leads?.companies?.name ? <><br /><span className="muted">{m.leads.companies.name}</span></> : null}</td>
                    <td>{m.event_name ?? 'Meeting'}{join && m.status === 'scheduled' ? <><br /><a href={join} target="_blank" rel="noopener noreferrer">Join link</a></> : null}</td>
                    <td>{m.run_by === 'ai_closer' ? 'AI closer' : 'Your team'}</td>
                    <td><span className={m.status === 'scheduled' ? 'badge badge-ok' : m.status === 'canceled' ? 'badge badge-error' : 'badge'}>{STATUS[m.status] ?? m.status}</span></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
