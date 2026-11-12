import type { Metadata } from 'next';
import Link from 'next/link';
import { requireWorkspace } from '@/lib/session';
import { LEAD_SOURCES, LEAD_STAGES, PAGE_SIZE, SOURCE_LABELS, STAGE_LABELS, filtersToQuery, parseLeadFilters, type LeadSource, type LeadStage } from '@/lib/campaigns';

export const metadata: Metadata = { title: 'Leads' };

type LeadRow = {
  id: string; full_name: string | null; title: string | null; email: string | null; phone: string | null;
  social_handles: Record<string, string> | null; source_channel: LeadSource; stage: LeadStage; created_at: string;
  companies: { name: string; domain: string | null; location: string | null; google_rating: number | null } | null;
};

export default async function LeadsPage({
  params,
  searchParams,
}: {
  params: Promise<{ workspaceId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { workspaceId } = await params;
  const { supabase, workspace } = await requireWorkspace(workspaceId);
  const f = parseLeadFilters(await searchParams);
  const base = `/w/${workspace.id}/leads`;

  let query = supabase
    .from('leads')
    .select('id, full_name, title, email, phone, social_handles, source_channel, stage, created_at, companies(name, domain, location, google_rating)', { count: 'exact' })
    .eq('workspace_id', workspace.id);
  if (f.source) query = query.eq('source_channel', f.source);
  if (f.stage) query = query.eq('stage', f.stage);
  if (f.campaign) query = query.eq('campaign_id', f.campaign);
  if (f.q) query = query.or(`full_name.ilike.*${f.q}*,email.ilike.*${f.q}*,phone.ilike.*${f.q}*,title.ilike.*${f.q}*`);
  const from = (f.page - 1) * PAGE_SIZE;
  const [{ data, count }, { data: bySource }] = await Promise.all([
    query.order('created_at', { ascending: false }).range(from, from + PAGE_SIZE - 1),
    supabase.from('leads').select('source_channel').eq('workspace_id', workspace.id).limit(5000),
  ]);
  const leads = (data ?? []) as unknown as LeadRow[];
  const total = count ?? 0;
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const tally = new Map<string, number>();
  for (const r of bySource ?? []) tally.set(r.source_channel, (tally.get(r.source_channel) ?? 0) + 1);

  return (
    <>
      <h1>Leads</h1>
      <ul className="chips" aria-label="Leads by source">
        <li className={!f.source ? 'chip chip-on' : 'chip'}><Link href={`${base}${filtersToQuery(f, { source: null, page: 1 })}`}>All sources</Link></li>
        {LEAD_SOURCES.filter((s) => tally.has(s)).map((s) => (
          <li key={s} className={f.source === s ? 'chip chip-on' : 'chip'}>
            <Link href={`${base}${filtersToQuery(f, { source: s, page: 1 })}`}>{SOURCE_LABELS[s]}: {tally.get(s)}</Link>
          </li>
        ))}
      </ul>

      <form className="row" method="get" action={base} role="search">
        {f.source ? <input type="hidden" name="source" value={f.source} /> : null}
        {f.campaign ? <input type="hidden" name="campaign" value={f.campaign} /> : null}
        <label className="field">
          <span className="sr-only">Search</span>
          <input type="search" name="q" defaultValue={f.q} placeholder="Name, email, phone or title" maxLength={80} />
        </label>
        <label className="field">
          <span className="sr-only">Stage</span>
          <select name="stage" defaultValue={f.stage ?? ''}>
            <option value="">All stages</option>
            {LEAD_STAGES.map((s) => <option key={s} value={s}>{STAGE_LABELS[s]}</option>)}
          </select>
        </label>
        <button className="btn btn-secondary" type="submit">Filter</button>
        {f.q || f.stage || f.source || f.campaign ? <Link href={base}>Clear</Link> : null}
      </form>

      <p className="muted" role="status">{total} {total === 1 ? 'lead' : 'leads'}{f.campaign ? ' in this campaign' : ''}</p>

      {!leads.length ? (
        <section className="card stack">
          <h2>No leads here yet</h2>
          <p className="muted">Create a campaign and the lead sourcing agent will add leads from every connected source.</p>
          <Link className="btn btn-primary" href={`/w/${workspace.id}/campaigns`}>Go to campaigns</Link>
        </section>
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr><th scope="col">Lead</th><th scope="col">Company</th><th scope="col">Contact</th><th scope="col">Source</th><th scope="col">Stage</th></tr>
            </thead>
            <tbody>
              {leads.map((l) => (
                <tr key={l.id}>
                  <td>{l.full_name ?? '—'}{l.title ? <><br /><span className="muted">{l.title}</span></> : null}</td>
                  <td>
                    {l.companies?.name ?? '—'}
                    {l.companies?.domain ? <><br /><span className="muted">{l.companies.domain}</span></> : null}
                    {l.companies?.google_rating ? <><br /><span className="muted">★ {l.companies.google_rating}</span></> : null}
                  </td>
                  <td>
                    {l.email ? <div>{l.email}</div> : null}
                    {l.phone ? <div>{l.phone}</div> : null}
                    {l.social_handles?.instagram ? <div>@{l.social_handles.instagram}</div> : null}
                  </td>
                  <td>{SOURCE_LABELS[l.source_channel] ?? l.source_channel}</td>
                  <td>{STAGE_LABELS[l.stage] ?? l.stage}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {pages > 1 ? (
        <nav className="row" aria-label="Pages">
          {f.page > 1 ? <Link href={`${base}${filtersToQuery(f, { page: f.page - 1 })}`}>Previous</Link> : null}
          <span className="muted">Page {f.page} of {pages}</span>
          {f.page < pages ? <Link href={`${base}${filtersToQuery(f, { page: f.page + 1 })}`}>Next</Link> : null}
        </nav>
      ) : null}
    </>
  );
}
