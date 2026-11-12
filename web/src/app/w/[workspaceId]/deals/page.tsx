import type { Metadata } from 'next';
import Link from 'next/link';
import { requireWorkspace } from '@/lib/session';
import { CLOSE_STATUS_LABELS, DEAL_STAGE_LABELS, PAYMENT_HOSTS, PAYMENT_LABELS, PROPOSAL_HOSTS, money, safeLink } from '@/lib/closer';

export const metadata: Metadata = { title: 'Deals' };

type Row = {
  id: string; lead_id: string; stage: string; plan_name: string | null; value_cents: number | null; currency: string; close_status: string;
  close_error: string | null; payment_status: string; agreement_status: string; payment_url: string | null; quote_url: string | null;
  closed_by: string | null; paid_at: string | null; updated_at: string;
  leads: { full_name: string | null; email: string | null; companies: { name: string } | null } | null;
};

const VIEWS = ['open', 'won', 'lost', 'all'] as const;
const VIEW_LABELS: Record<(typeof VIEWS)[number], string> = { open: 'Open', won: 'Won', lost: 'Lost', all: 'All' };

export default async function DealsPage({ params, searchParams }: { params: Promise<{ workspaceId: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { workspaceId } = await params;
  const { supabase, workspace } = await requireWorkspace(workspaceId);
  const sp = await searchParams;
  const raw = Array.isArray(sp.view) ? sp.view[0] : sp.view;
  const view = (VIEWS as readonly string[]).includes(raw ?? '') ? (raw as (typeof VIEWS)[number]) : 'open';
  let q = supabase.from('deals')
    .select('id, lead_id, stage, plan_name, value_cents, currency, close_status, close_error, payment_status, agreement_status, payment_url, quote_url, closed_by, paid_at, updated_at, leads(full_name, email, companies(name))')
    .eq('workspace_id', workspace.id);
  if (view === 'open') q = q.not('stage', 'in', '(won,lost)');
  if (view === 'won' || view === 'lost') q = q.eq('stage', view);
  const { data } = await q.order('updated_at', { ascending: false }).limit(100);
  const rows = (data ?? []) as unknown as Row[];
  const won = rows.filter((d) => d.stage === 'won');
  const base = `/w/${workspace.id}/deals`;

  return (
    <>
      <h1>Deals</h1>
      <p className="muted">Every prospect who met with the AI closer or your team: the plan they chose, the proposal and payment link, and whether they paid. A completed Stripe payment marks the deal won.</p>
      <nav className="chips" aria-label="View">
        {VIEWS.map((v) => <Link key={v} className={view === v ? 'chip chip-on' : 'chip'} href={v === 'open' ? base : `${base}?view=${v}`}>{VIEW_LABELS[v]}</Link>)}
      </nav>
      {view === 'won' && won.length ? <dl className="stats"><div><dt>Won here</dt><dd>{won.length}</dd></div></dl> : null}
      {!rows.length ? <section className="card"><p className="muted">No deals here yet.</p></section> : (
        <div className="table-wrap">
          <table className="table">
            <thead><tr><th scope="col">Prospect</th><th scope="col">Stage</th><th scope="col">Plan</th><th scope="col">Proposal</th><th scope="col">Payment</th></tr></thead>
            <tbody>
              {rows.map((d) => {
                const pay = safeLink(d.payment_url, PAYMENT_HOSTS);
                const quote = safeLink(d.quote_url, PROPOSAL_HOSTS);
                return (
                  <tr key={d.id}>
                    <td><Link href={`/w/${workspace.id}/leads/${d.lead_id}`}>{d.leads?.full_name ?? d.leads?.email ?? 'Lead'}</Link>{d.leads?.companies?.name ? <><br /><span className="muted">{d.leads.companies.name}</span></> : null}</td>
                    <td><span className={d.stage === 'won' ? 'badge badge-ok' : d.stage === 'lost' ? 'badge badge-error' : 'badge'}>{DEAL_STAGE_LABELS[d.stage] ?? d.stage}</span>{d.closed_by ? <><br /><span className="muted">Closed by {d.closed_by === 'ai' ? 'the AI' : 'your team'}</span></> : null}</td>
                    <td>{d.plan_name ?? '—'}<br /><span className="muted">{money(d.value_cents === null ? null : Number(d.value_cents), d.currency)}</span></td>
                    <td>
                      <span className={d.close_status === 'needs_team' || d.close_status === 'failed' ? 'badge badge-warn' : 'badge'}>{CLOSE_STATUS_LABELS[d.close_status] ?? d.close_status}</span>
                      {d.close_error && (d.close_status === 'needs_team' || d.close_status === 'failed') ? <><br /><span className="muted">{d.close_error}</span></> : null}
                      {quote ? <><br /><a href={quote} target="_blank" rel="noopener noreferrer">Open in PandaDoc</a></> : null}
                    </td>
                    <td>
                      <span className={d.payment_status === 'paid' ? 'badge badge-ok' : 'badge'}>{PAYMENT_LABELS[d.payment_status] ?? d.payment_status}</span>
                      {pay && d.payment_status !== 'paid' ? <><br /><a href={pay} target="_blank" rel="noopener noreferrer">Payment link</a></> : null}
                      {d.paid_at ? <><br /><time className="muted" dateTime={d.paid_at}>{new Date(d.paid_at).toUTCString()}</time></> : null}
                    </td>
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
