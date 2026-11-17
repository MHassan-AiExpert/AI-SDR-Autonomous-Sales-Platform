import type { Metadata } from 'next';
import Link from 'next/link';
import { headers } from 'next/headers';
import { ActionForm, SubmitButton } from '@/components/action-form';
import { requireWorkspace } from '@/lib/session';
import { canManageSettings } from '@/lib/roles';
import { INGEST_EXAMPLE, KIND_LABELS, SIGNAL_KINDS, SOURCE_LABELS, type SignalKind } from '@/lib/signals';
import { setSignalStatus } from './actions';

export const metadata: Metadata = { title: 'Signals' };

const STATUSES = ['new', 'used', 'dismissed', 'all'] as const;
type Status = (typeof STATUSES)[number];
const STATUS_LABELS: Record<Status, string> = { new: 'New', used: 'Used', dismissed: 'Dismissed', all: 'All' };

export default async function SignalsPage({
  params, searchParams,
}: { params: Promise<{ workspaceId: string }>; searchParams: Promise<{ kind?: string; status?: string }> }) {
  const { workspaceId } = await params;
  const sp = await searchParams;
  const { supabase, workspace } = await requireWorkspace(workspaceId);
  const manage = canManageSettings(workspace.role);
  const act = workspace.role !== 'viewer';
  const base = `/w/${workspace.id}`;

  const kind = (SIGNAL_KINDS as readonly string[]).includes(sp.kind ?? '') ? (sp.kind as SignalKind) : null;
  const status: Status = (STATUSES as readonly string[]).includes(sp.status ?? '') ? (sp.status as Status) : 'new';

  let query = supabase.from('signals')
    .select('id, kind, source, provider, title, detail, url, occurred_at, status, created_at, company_id, lead_id, companies (name, domain), leads (full_name, email)')
    .eq('workspace_id', workspace.id).order('created_at', { ascending: false }).limit(100);
  if (kind) query = query.eq('kind', kind);
  if (status !== 'all') query = query.eq('status', status);
  const { data: rows } = await query;

  const { data: hook } = manage
    ? await supabase.from('workspaces').select('webhook_token').eq('id', workspace.id).maybeSingle()
    : { data: null };
  const h = await headers();
  const host = h.get('x-forwarded-host') ?? h.get('host') ?? '';
  const proto = h.get('x-forwarded-proto') ?? 'https';
  const address = hook?.webhook_token ? `${proto}://${host}/api/signals/${hook.webhook_token}` : null;

  type Row = {
    id: string; kind: SignalKind; source: string; provider: string | null; title: string; detail: string | null;
    url: string | null; occurred_at: string | null; status: string; created_at: string;
    companies: { name: string; domain: string | null } | null; leads: { full_name: string | null; email: string | null } | null;
  };
  const signals = (rows ?? []) as unknown as Row[];
  const filterHref = (next: { kind?: string | null; status?: Status }) => {
    const q = new URLSearchParams();
    const k = next.kind === undefined ? kind : next.kind;
    if (k) q.set('kind', k);
    q.set('status', next.status ?? status);
    return `${base}/signals?${q}`;
  };

  return (
    <main className="stack-lg">
      <h1>Signals</h1>
      <p>
        Changes worth getting in touch about: a funding round, a hiring push, a new tool on their website, your
        contact moving job. A sequence step can wait for one and open with it, and the copywriter uses the newest one
        as an opening line. Turn them on per campaign from the campaign&apos;s{' '}
        <Link href={`${base}/campaigns`}>sequence screen</Link>.
      </p>

      <nav className="row" aria-label="Filter by status">
        {STATUSES.map((s) => (
          <Link key={s} href={filterHref({ status: s })} aria-current={s === status ? 'page' : undefined}
            className={s === status ? 'btn btn-secondary' : 'btn btn-ghost'}>{STATUS_LABELS[s]}</Link>
        ))}
      </nav>
      <nav className="row" aria-label="Filter by kind">
        <Link href={filterHref({ kind: null })} className={!kind ? 'btn btn-secondary' : 'btn btn-ghost'}>Every kind</Link>
        {SIGNAL_KINDS.map((k) => (
          <Link key={k} href={filterHref({ kind: k })} className={kind === k ? 'btn btn-secondary' : 'btn btn-ghost'}>{KIND_LABELS[k]}</Link>
        ))}
      </nav>

      {signals.length === 0 ? (
        <p className="muted">No {status === 'all' ? '' : `${STATUS_LABELS[status].toLowerCase()} `}signals{kind ? ` of this kind` : ''} yet.</p>
      ) : (
        <div className="table-wrap">
          <table className="table">
            <caption className="sr-only">Signals</caption>
            <thead>
              <tr>
                <th scope="col">What happened</th>
                <th scope="col">About</th>
                <th scope="col">Kind</th>
                <th scope="col">Found by</th>
                <th scope="col">When</th>
                {act ? <th scope="col"><span className="sr-only">Actions</span></th> : null}
              </tr>
            </thead>
            <tbody>
              {signals.map((s) => (
                <tr key={s.id}>
                  <th scope="row">
                    {s.url ? <a href={s.url} target="_blank" rel="noopener noreferrer nofollow">{s.title}</a> : s.title}
                    {s.detail ? <><br /><small className="muted">{s.detail}</small></> : null}
                  </th>
                  <td>{s.leads?.full_name ?? s.leads?.email ?? s.companies?.name ?? '—'}</td>
                  <td>{KIND_LABELS[s.kind] ?? s.kind}</td>
                  <td>{SOURCE_LABELS[s.source] ?? s.source}{s.provider ? ` (${s.provider})` : ''}</td>
                  <td>{new Date(s.occurred_at ?? s.created_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}</td>
                  {act ? (
                    <td>
                      {s.status === 'used' ? <span className="muted">Used</span> : (
                        <ActionForm action={setSignalStatus}>
                          <input type="hidden" name="workspace_id" value={workspace.id} />
                          <input type="hidden" name="signal_id" value={s.id} />
                          <input type="hidden" name="status" value={s.status === 'dismissed' ? 'new' : 'dismissed'} />
                          <SubmitButton variant="ghost">{s.status === 'dismissed' ? 'Restore' : 'Dismiss'}</SubmitButton>
                        </ActionForm>
                      )}
                    </td>
                  ) : null}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <section className="card stack">
        <h2>Signals from other tools</h2>
        <p>
          Buying intent from Bombora or 6sense, or posts found by a social listening tool, can be sent here. Point the
          tool — or Zapier or Make in front of it — at this workspace&apos;s address. Each signal is matched to a company
          by its domain, or to a person by email; anything that matches nobody in this workspace is not kept.
        </p>
        {manage ? (
          address ? (
            <>
              <label className="field">
                <span>Address (keep it private; anyone with it can send signals)</span>
                <input type="text" readOnly value={address} />
              </label>
              <p className="muted">Send a POST with a JSON body, one signal or <code>{'{"signals": [...]}'}</code> with up to 50:</p>
              <pre className="pre">{INGEST_EXAMPLE}</pre>
              <p className="muted">
                Kinds: intent_surge, social_post, funding, news, hiring, tech_change, job_change. If the address leaks,
                replace it in <Link href={`${base}/settings`}>Settings</Link>; the other webhooks move with it.
              </p>
            </>
          ) : <p className="muted">This workspace has no webhook address.</p>
        ) : <p className="muted">Owners and admins can see the address.</p>}
      </section>
    </main>
  );
}
