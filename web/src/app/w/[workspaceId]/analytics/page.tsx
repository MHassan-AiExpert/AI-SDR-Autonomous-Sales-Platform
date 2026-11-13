import type { Metadata } from 'next';
import Link from 'next/link';
import { ActionForm, SubmitButton } from '@/components/action-form';
import { canManageSettings } from '@/lib/roles';
import { requireWorkspace } from '@/lib/session';
import { FUNNEL_STEPS, RANGES, RANGE_LABELS, chartPoints, costPerMeeting, money, parseRange, period, rate, readSummary } from '@/lib/analytics';
import { saveSpend } from '../actions';

export const metadata: Metadata = { title: 'Analytics' };

const W = 640;
const H = 160;

export default async function AnalyticsPage({ params, searchParams }: { params: Promise<{ workspaceId: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { workspaceId } = await params;
  const { supabase, workspace } = await requireWorkspace(workspaceId);
  const sp = await searchParams;
  const range = parseRange(Array.isArray(sp.range) ? sp.range[0] : sp.range);
  const rawCampaign = Array.isArray(sp.campaign) ? sp.campaign[0] : sp.campaign;
  const { data: campaigns } = await supabase.from('campaigns').select('id, name').eq('workspace_id', workspace.id).neq('status', 'archived').order('created_at');
  const campaign = (campaigns ?? []).find((c) => c.id === rawCampaign)?.id ?? null;
  const { from, to, days } = period(range);
  const [{ data, error }, { data: spendRow }] = await Promise.all([
    supabase.rpc('analytics_summary', { ws: workspace.id, p_from: from.toISOString(), p_to: to.toISOString(), p_campaign: campaign }),
    supabase.from('workspaces').select('monthly_spend_cents, spend_currency').eq('id', workspace.id).maybeSingle(),
  ]);
  const s = readSummary(data);
  const manage = canManageSettings(workspace.role);
  const q = (r: string) => `?range=${r}${campaign ? `&campaign=${campaign}` : ''}`;

  if (!s || error) {
    return (<><h1>Analytics</h1><section className="card"><p className="muted">The figures could not be loaded right now. Try again in a moment.</p></section></>);
  }
  const f = s.funnel;
  const ch = s.channels;
  const max = Math.max(1, ...s.daily.map((d) => Math.max(d.emails, d.replies, d.meetings)));
  const spendCurrency = spendRow?.spend_currency ?? 'USD';
  const cpm = costPerMeeting(spendRow?.monthly_spend_cents ?? null, days, f.meetings_booked);
  const first = (k: keyof typeof f) => f[FUNNEL_STEPS[0].key] ? Math.max(2, Math.round((f[k] / Math.max(1, f[FUNNEL_STEPS[0].key])) * 100)) : 0;

  return (
    <>
      <h1>Analytics</h1>
      <form className="row" method="get" aria-label="Filters">
        <label className="field"><span>Period</span>
          <select name="range" defaultValue={range}>{(Object.keys(RANGES) as (keyof typeof RANGES)[]).map((r) => <option key={r} value={r}>{RANGE_LABELS[r]}</option>)}</select></label>
        <label className="field"><span>Campaign</span>
          <select name="campaign" defaultValue={campaign ?? ''}><option value="">All campaigns</option>{(campaigns ?? []).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></label>
        <button type="submit" className="button button-secondary">Show</button>
        <a className="button button-ghost" href={`/w/${workspace.id}/analytics/export${q(range)}`}>Download CSV</a>
      </form>
      <p className="muted">{RANGE_LABELS[range]} · {from.toUTCString().slice(5, 16)} to {to.toUTCString().slice(5, 16)} (UTC)</p>

      <dl className="stats">
        <div><dt>Leads sourced</dt><dd>{f.sourced}</dd></div>
        <div><dt>Reply rate</dt><dd>{rate(f.replied, f.emailed)}</dd></div>
        <div><dt>Meetings booked</dt><dd>{f.meetings_booked}</dd></div>
        <div><dt>Deals won</dt><dd>{f.won}{s.won_by_ai ? <span className="muted"> ({s.won_by_ai} by the AI)</span> : null}</dd></div>
        <div><dt>Revenue</dt><dd>{s.revenue.length ? s.revenue.map((r) => money(r.cents, r.currency)).join(' + ') : money(0, spendCurrency)}</dd></div>
        <div><dt>Cost per meeting</dt><dd>{cpm === null ? '—' : money(cpm, spendCurrency)}</dd></div>
      </dl>

      <section className="card stack" aria-labelledby="funnel">
        <h2 id="funnel">Funnel</h2>
        <ul className="funnel">
          {FUNNEL_STEPS.map((st, i) => (
            <li key={st.key}>
              <span className="funnel-label">{st.label}</span>
              <span className="funnel-bar" style={{ width: `${first(st.key)}%` }} aria-hidden="true" />
              <span className="funnel-value">{f[st.key]}{i > 0 ? <span className="muted"> · {rate(f[st.key], f[FUNNEL_STEPS[i - 1].key])} of the step before</span> : null}</span>
            </li>
          ))}
        </ul>
      </section>

      <section className="card stack" aria-labelledby="daily">
        <h2 id="daily">Day by day</h2>
        <svg viewBox={`0 0 ${W} ${H}`} className="chart" role="img" aria-label={`Emails sent, replies and meetings booked per day, highest ${max}`}>
          <polyline className="chart-emails" fill="none" points={chartPoints(s.daily, 'emails', W, H, max)} />
          <polyline className="chart-replies" fill="none" points={chartPoints(s.daily, 'replies', W, H, max)} />
          <polyline className="chart-meetings" fill="none" points={chartPoints(s.daily, 'meetings', W, H, max)} />
        </svg>
        <p className="muted"><span className="key key-emails" /> Emails sent <span className="key key-replies" /> Replies <span className="key key-meetings" /> Meetings booked · highest day {max}</p>
      </section>

      <section className="card stack" aria-labelledby="channels">
        <h2 id="channels">Channels</h2>
        <div className="table-wrap">
          <table className="table">
            <thead><tr><th scope="col">Channel</th><th scope="col">Activity</th><th scope="col">Result</th></tr></thead>
            <tbody>
              <tr><td>Email</td><td>{ch.email.sent} sent</td><td>{ch.email.replies} replies ({rate(ch.email.replies, ch.email.sent)}), {ch.email.interested} interested</td></tr>
              <tr><td>SMS</td><td>{ch.sms.sent} sent, {rate(ch.sms.delivered, ch.sms.sent)} delivered</td><td>{ch.sms.replies} replies</td></tr>
              <tr><td>WhatsApp</td><td>{ch.whatsapp.sent} sent, {rate(ch.whatsapp.delivered, ch.whatsapp.sent)} delivered</td><td>{ch.whatsapp.replies} replies</td></tr>
              <tr><td>AI calls</td><td>{ch.calls.made} calls, {rate(ch.calls.connected, ch.calls.made)} answered</td><td>{ch.calls.interested} interested or call back</td></tr>
              <tr><td>AI closer</td><td>{ch.closer.meetings} meeting calls, {ch.closer.held} held</td><td>{ch.closer.proposals} proposals sent, {ch.closer.won} won</td></tr>
              <tr><td>AI receptionist</td><td>{ch.receptionist.calls} inbound calls</td><td>{ch.receptionist.interested} interested, {ch.receptionist.transferred} put through</td></tr>
              <tr><td>Website audits</td><td>{ch.audits.ready} shared</td><td>{ch.audits.opened} opened ({rate(ch.audits.opened, ch.audits.ready)})</td></tr>
            </tbody>
          </table>
        </div>
      </section>

      <section className="card stack" aria-labelledby="by-campaign">
        <h2 id="by-campaign">By campaign</h2>
        {!s.campaigns.length ? <p className="muted">No campaigns yet.</p> : (
          <div className="table-wrap">
            <table className="table">
              <thead><tr><th scope="col">Campaign</th><th scope="col">Sourced</th><th scope="col">Emailed</th><th scope="col">Reply rate</th><th scope="col">Interested</th><th scope="col">Meetings</th><th scope="col">Won</th><th scope="col">Revenue</th></tr></thead>
              <tbody>
                {s.campaigns.map((c) => (
                  <tr key={c.id}>
                    <td><Link href={`/w/${workspace.id}/campaigns/${c.id}`}>{c.name}</Link></td>
                    <td>{c.sourced}</td><td>{c.emailed}</td><td>{rate(c.replied, c.emailed)}</td><td>{c.interested}</td><td>{c.meetings}</td><td>{c.won}</td>
                    <td>{money(c.revenue_cents, s.revenue[0]?.currency ?? spendCurrency)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="card stack" aria-labelledby="spend">
        <h2 id="spend">Tool spend</h2>
        <p className="muted">What you pay each month for the tools behind the platform (data, email, calling, AI). It is spread over the period to work out the cost per meeting booked.</p>
        {manage ? (
          <ActionForm action={saveSpend} className="row">
            <input type="hidden" name="workspace_id" value={workspace.id} />
            <label className="field"><span>Monthly spend</span><input name="monthly_spend" type="text" inputMode="decimal" defaultValue={spendRow?.monthly_spend_cents != null ? (spendRow.monthly_spend_cents / 100).toFixed(2) : ''} /></label>
            <label className="field"><span>Currency</span><input name="spend_currency" type="text" maxLength={3} defaultValue={spendCurrency} /></label>
            <SubmitButton variant="secondary">Save spend</SubmitButton>
          </ActionForm>
        ) : <p className="muted">{spendRow?.monthly_spend_cents != null ? `${money(spendRow.monthly_spend_cents, spendCurrency)} a month` : 'Not set.'}</p>}
      </section>
    </>
  );
}
