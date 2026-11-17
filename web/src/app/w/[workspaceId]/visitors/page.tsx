import type { Metadata } from 'next';
import Link from 'next/link';
import { headers } from 'next/headers';
import { ActionForm, SubmitButton } from '@/components/action-form';
import { requireWorkspace } from '@/lib/session';
import { canManageSettings } from '@/lib/roles';
import { snippet, topPaths } from '@/lib/visitors';
import { rotateSiteKey, saveVisitorSettings } from './actions';

export const metadata: Metadata = { title: 'Website visitors' };

const when = (d: string) => new Date(d).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'UTC' }) + ' UTC';

export default async function VisitorsPage({ params, searchParams }: { params: Promise<{ workspaceId: string }>; searchParams: Promise<{ show?: string }> }) {
  const { workspaceId } = await params;
  const { show } = await searchParams;
  const { supabase, workspace } = await requireWorkspace(workspaceId);
  const manage = canManageSettings(workspace.role);
  const known = show !== 'all';
  const h = await headers();
  const appUrl = `${h.get('x-forwarded-proto') ?? 'https'}://${h.get('x-forwarded-host') ?? h.get('host') ?? ''}`;

  let q = supabase.from('site_visitors')
    .select('id, company_domain, company_name, country_code, company_id, visits, first_seen_at, last_seen_at, top_paths')
    .eq('workspace_id', workspace.id).order('last_seen_at', { ascending: false }).limit(200);
  if (known) q = q.not('company_id', 'is', null);
  const [{ data: rows }, { data: ws }, { data: tool }] = await Promise.all([
    q,
    supabase.from('workspaces').select('visitor_tracking_enabled, visitor_site_key, visitor_allowed_hosts').eq('id', workspace.id).maybeSingle(),
    supabase.from('integrations').select('status').eq('workspace_id', workspace.id).eq('tool', 'ipapi').maybeSingle(),
  ]);
  type Row = { id: string; company_domain: string; company_name: string | null; country_code: string | null; company_id: string | null; visits: number; first_seen_at: string; last_seen_at: string; top_paths: unknown };
  const visitors = (rows ?? []) as Row[];
  const settings = ws as { visitor_tracking_enabled: boolean; visitor_site_key: string; visitor_allowed_hosts: string[] } | null;
  const connected = tool?.status === 'connected';
  const base = `/w/${workspace.id}`;

  return (
    <main className="stack-lg">
      <h1>Website visitors</h1>
      <p>
        Which <strong>companies</strong> visit your website. A visit from a company already in your pipeline becomes a
        signal, so a sequence step on &ldquo;a new signal arrived&rdquo; can follow up while the interest is fresh. People are
        never identified: only visits from a company&apos;s own network count, and home, mobile and VPN connections are discarded.
      </p>

      {!connected ? (
        <p><span className="badge badge-warn">Needs attention</span> Connect ipapi.is in <Link href={`${base}/setup`}>Setup</Link> to identify visiting companies (free for 1,000 lookups a day).</p>
      ) : null}

      {manage && settings ? (
        <section className="card stack" aria-labelledby="setup">
          <h2 id="setup">Set up</h2>
          <ActionForm action={saveVisitorSettings} className="stack">
            <input type="hidden" name="workspace_id" value={workspace.id} />
            <label className="choice">
              <input type="checkbox" name="enabled" defaultChecked={settings.visitor_tracking_enabled} />
              <span><strong>Record company visits</strong><br />Off by default. Your privacy policy should mention that company visits are analysed.</span>
            </label>
            <label className="field">
              <span>Your website (one per line, such as acme.com; its subdomains are included)</span>
              <textarea name="hosts" rows={3} defaultValue={settings.visitor_allowed_hosts.join('\n')} />
            </label>
            <SubmitButton>Save</SubmitButton>
          </ActionForm>
          <p className="muted">Add this to every page of your website, before <code>&lt;/body&gt;</code>:</p>
          <pre className="pre">{snippet(appUrl, settings.visitor_site_key)}</pre>
          <p className="muted">
            The script sets no cookies and stores nothing in the browser, and is skipped for visitors who send Global
            Privacy Control or Do Not Track. The visitor&apos;s address is kept only until it is looked up, and at most a day.
          </p>
          <ActionForm action={rotateSiteKey}>
            <input type="hidden" name="workspace_id" value={workspace.id} />
            <SubmitButton variant="ghost">Replace site key</SubmitButton>
          </ActionForm>
        </section>
      ) : null}

      <section className="stack" aria-labelledby="companies">
        <div className="row">
          <h2 id="companies">Visiting companies</h2>
          <nav aria-label="Filter" className="row">
            <Link href={`${base}/visitors`} aria-current={known ? 'page' : undefined}>In your pipeline</Link>
            <Link href={`${base}/visitors?show=all`} aria-current={!known ? 'page' : undefined}>All</Link>
          </nav>
        </div>
        {visitors.length === 0 ? (
          <p className="muted">{known ? 'No company from your pipeline has visited yet.' : 'No visiting companies yet.'}</p>
        ) : (
          <div className="table-wrap">
            <table className="table">
              <caption className="sr-only">Visiting companies</caption>
              <thead><tr><th scope="col">Company</th><th scope="col">Visits</th><th scope="col">Most viewed</th><th scope="col">Last visit</th></tr></thead>
              <tbody>
                {visitors.map((v) => (
                  <tr key={v.id}>
                    <th scope="row">
                      {v.company_name ?? v.company_domain}
                      <br /><small className="muted">{v.company_domain}{v.country_code ? `, ${v.country_code}` : ''}</small>
                      {v.company_id ? <> <span className="badge badge-ok">In pipeline</span></> : null}
                    </th>
                    <td>{v.visits}</td>
                    <td>{topPaths(v.top_paths).join(', ') || '—'}</td>
                    <td>{when(v.last_seen_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </main>
  );
}
