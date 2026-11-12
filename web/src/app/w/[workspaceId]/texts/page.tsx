import type { Metadata } from 'next';
import Link from 'next/link';
import { requireWorkspace } from '@/lib/session';
import { CHANNEL_LABELS, DELIVERY_LABELS, type TextChannel } from '@/lib/texting';

export const metadata: Metadata = { title: 'Texts' };

type Row = {
  id: string; lead_id: string; created_at: string; channel: TextChannel; direction: string; body: string; delivery_status: string;
  error: string | null; step: number | null; to_number: string | null; from_number: string | null;
  leads: { full_name: string | null; email: string | null; phone: string | null; companies: { name: string } | null } | null;
};

const VIEWS = ['all', 'received', 'sent', 'failed'] as const;
const VIEW_LABELS: Record<(typeof VIEWS)[number], string> = { all: 'All', received: 'Received', sent: 'Sent', failed: 'Not delivered' };

export default async function TextsPage({ params, searchParams }: { params: Promise<{ workspaceId: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { workspaceId } = await params;
  const { supabase, workspace } = await requireWorkspace(workspaceId);
  const sp = await searchParams;
  const raw = Array.isArray(sp.view) ? sp.view[0] : sp.view;
  const view = (VIEWS as readonly string[]).includes(raw ?? '') ? (raw as (typeof VIEWS)[number]) : 'all';
  let q = supabase.from('messages')
    .select('id, lead_id, created_at, channel, direction, body, delivery_status, error, step, to_number, from_number, leads(full_name, email, phone, companies(name))')
    .eq('workspace_id', workspace.id);
  if (view === 'received') q = q.eq('direction', 'inbound');
  if (view === 'sent') q = q.eq('direction', 'outbound').neq('delivery_status', 'failed');
  if (view === 'failed') q = q.eq('delivery_status', 'failed');
  const { data } = await q.order('created_at', { ascending: false }).limit(100);
  const rows = (data ?? []) as unknown as Row[];
  const base = `/w/${workspace.id}/texts`;

  return (
    <>
      <h1>Texts</h1>
      <p className="muted">SMS and WhatsApp follow-ups sent by the AI, answers, and texts your leads sent back. Replies are read by the reply agent and appear in the inbox; STOP requests are suppressed at once.</p>
      <nav className="chips" aria-label="View">
        {VIEWS.map((v) => <Link key={v} className={view === v ? 'chip chip-on' : 'chip'} href={v === 'all' ? base : `${base}?view=${v}`}>{VIEW_LABELS[v]}</Link>)}
      </nav>
      {!rows.length ? <section className="card"><p className="muted">No texts yet.</p></section> : (
        <div className="table-wrap">
          <table className="table">
            <thead><tr><th scope="col">When (UTC)</th><th scope="col">Lead</th><th scope="col">Channel</th><th scope="col">Message</th><th scope="col">Status</th></tr></thead>
            <tbody>
              {rows.map((m) => (
                <tr key={m.id}>
                  <td><time dateTime={m.created_at}>{new Date(m.created_at).toUTCString().replace(' GMT', '')}</time></td>
                  <td><Link href={`/w/${workspace.id}/leads/${m.lead_id}`}>{m.leads?.full_name ?? m.leads?.email ?? m.leads?.phone ?? 'Lead'}</Link>{m.leads?.companies?.name ? <><br /><span className="muted">{m.leads.companies.name}</span></> : null}</td>
                  <td>{CHANNEL_LABELS[m.channel] ?? m.channel}<br /><span className="muted">{m.direction === 'inbound' ? 'From the lead' : m.step ? `Follow-up ${m.step}` : 'Answer'}</span></td>
                  <td className="pre">{m.body}</td>
                  <td><span className={m.delivery_status === 'failed' ? 'badge badge-error' : 'badge'}>{DELIVERY_LABELS[m.delivery_status] ?? m.delivery_status}</span>{m.delivery_status === 'failed' && m.error ? <><br /><span className="muted">{m.error}</span></> : null}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
