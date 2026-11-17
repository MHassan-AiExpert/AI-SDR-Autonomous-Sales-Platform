import type { Metadata } from 'next';
import Link from 'next/link';
import { ActionForm, SubmitButton } from '@/components/action-form';
import { requireWorkspace } from '@/lib/session';
import { canManageSettings } from '@/lib/roles';
import {
  CHECK_HELP, CHECK_LABELS, MAILBOX_STATUS, PROVIDER_LABELS, STATUS_LABELS, WARMUP_STATUS,
  asStatus, blocklistStatus, mailboxTone, rate, readBlocklists, readIssues, scoreBand, type CheckStatus,
} from '@/lib/deliverability';
import { checkNow, saveSelector } from './actions';

export const metadata: Metadata = { title: 'Deliverability' };

const TONE: Record<CheckStatus, string> = { pass: 'badge badge-ok', warn: 'badge badge-warn', fail: 'badge badge-error', unknown: 'badge' };
const Badge = ({ s, label }: { s: CheckStatus; label?: string }) => <span className={TONE[s]}>{label ?? STATUS_LABELS[s]}</span>;
const when = (d: string | null) => (d ? new Date(d).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'UTC' }) + ' UTC' : 'never');

export default async function DeliverabilityPage({ params }: { params: Promise<{ workspaceId: string }> }) {
  const { workspaceId } = await params;
  const { supabase, workspace } = await requireWorkspace(workspaceId);
  const manage = canManageSettings(workspace.role);
  const base = `/w/${workspace.id}`;

  const [{ data: domainRows }, { data: boxRows }, { data: statRows }, { data: ws }] = await Promise.all([
    supabase.from('sending_domains')
      .select('id, domain, dkim_selector, spf_status, spf_record, spf_lookups, dkim_status, dkim_found, dmarc_status, dmarc_policy, dmarc_record, mx_status, blocklists, issues, score, checked_at')
      .eq('workspace_id', workspace.id).order('domain'),
    supabase.from('mailboxes')
      .select('email, domain, provider, status, warmup_status, warmup_score, daily_limit, setup_pending, checked_at')
      .eq('workspace_id', workspace.id).order('email').limit(500),
    supabase.rpc('mailbox_stats', { ws: workspace.id, p_days: 30 }),
    supabase.from('workspaces').select('deliverability_checked_at').eq('id', workspace.id).maybeSingle(),
  ]);

  type DomainRow = {
    id: string; domain: string; dkim_selector: string | null; spf_status: string | null; spf_record: string | null; spf_lookups: number | null;
    dkim_status: string | null; dkim_found: string[] | null; dmarc_status: string | null; dmarc_policy: string | null; dmarc_record: string | null;
    mx_status: string | null; blocklists: unknown; issues: unknown; score: number | null; checked_at: string | null;
  };
  type BoxRow = { email: string; domain: string; provider: string | null; status: string; warmup_status: string; warmup_score: number | null; daily_limit: number | null; setup_pending: boolean | null };
  type StatRow = { email_account: string; sent: number; bounced: number; replied: number; unsubscribed: number };
  const domains = (domainRows ?? []) as DomainRow[];
  const boxes = (boxRows ?? []) as BoxRow[];
  const stats = new Map(((statRows ?? []) as StatRow[]).map((r) => [r.email_account, { sent: Number(r.sent), bounced: Number(r.bounced), replied: Number(r.replied), unsubscribed: Number(r.unsubscribed) }]));
  const unattributed = stats.get('');
  const checkedAt = (ws as { deliverability_checked_at: string | null } | null)?.deliverability_checked_at ?? null;
  // Mailboxes that sent but are not (or no longer) in Instantly's list still get a row
  const listed = new Set(boxes.map((b) => b.email));
  const extra = [...stats.keys()].filter((e) => e && !listed.has(e)).sort();

  const failing = domains.filter((d) => readIssues(d.issues).some((i) => i.severity === 'fail')).length;
  const listedCount = domains.filter((d) => blocklistStatus(readBlocklists(d.blocklists)) === 'fail').length;
  const badBoxes = boxes.filter((b) => mailboxTone(b.status, b.warmup_status) === 'fail').length;

  return (
    <main className="stack-lg">
      <h1>Deliverability</h1>
      <p>
        Whether your sending domains are set up the way Gmail, Outlook and Yahoo require, whether any is on a
        blocklist, and how each mailbox is doing. The agent checks once a day and alerts you when something new goes
        wrong. Campaigns whose bounce or opt-out rate crosses your limit are still paused automatically
        (<Link href={`${base}/settings`}>Settings</Link>).
      </p>

      <section className="card stack" aria-labelledby="overview">
        <h2 id="overview">Overview</h2>
        <ul className="list">
          <li>{domains.length} sending {domains.length === 1 ? 'domain' : 'domains'}: {failing ? <strong>{failing} with set-up failures</strong> : 'none failing'}{listedCount ? <>, <strong>{listedCount} blocklisted</strong></> : null}</li>
          <li>{boxes.length} {boxes.length === 1 ? 'mailbox' : 'mailboxes'} in Instantly{badBoxes ? <>: <strong>{badBoxes} need attention</strong></> : null}</li>
          <li>Last checked {when(checkedAt)}</li>
        </ul>
        {manage ? (
          <ActionForm action={checkNow}>
            <input type="hidden" name="workspace_id" value={workspace.id} />
            <SubmitButton variant="secondary">Check now</SubmitButton>
          </ActionForm>
        ) : null}
      </section>

      <section className="stack" aria-labelledby="domains">
        <h2 id="domains">Sending domains</h2>
        {domains.length === 0 ? (
          <p className="muted">
            No domains yet. They come from the mailboxes in your campaigns&apos; email settings and from Instantly, once
            it is connected in <Link href={`${base}/setup`}>Setup</Link>. The first check runs within a day, or
            straight away with &ldquo;Check now&rdquo;.
          </p>
        ) : domains.map((d) => {
          const issues = readIssues(d.issues);
          const lists = readBlocklists(d.blocklists);
          const band = scoreBand(d.checked_at ? d.score : null);
          const checks: [string, CheckStatus, string][] = [
            ['spf', asStatus(d.spf_status), d.spf_lookups !== null ? `${d.spf_lookups} of 10 lookups` : ''],
            ['dkim', asStatus(d.dkim_status), d.dkim_found?.length ? `found at ${d.dkim_found.join(', ')}` : ''],
            ['dmarc', asStatus(d.dmarc_status), d.dmarc_policy ? `p=${d.dmarc_policy}` : ''],
            ['mx', asStatus(d.mx_status), ''],
            ['blocklist', blocklistStatus(lists), lists.filter((l) => l.status === 'listed').map((l) => l.list).join(', ')],
          ];
          return (
            <article key={d.id} className="card stack" aria-labelledby={`d-${d.id}`}>
              <div className="row">
                <h3 id={`d-${d.id}`}>{d.domain}</h3>
                <Badge s={band.tone} label={d.checked_at ? `${d.score} of 100, ${band.label.toLowerCase()}` : band.label} />
              </div>
              <div className="table-wrap">
                <table className="table">
                  <caption className="sr-only">Checks for {d.domain}</caption>
                  <thead><tr><th scope="col">Check</th><th scope="col">Result</th><th scope="col">Detail</th></tr></thead>
                  <tbody>
                    {checks.map(([k, s, detail]) => (
                      <tr key={k}>
                        <th scope="row">{CHECK_LABELS[k]}<br /><small className="muted">{CHECK_HELP[k]}</small></th>
                        <td><Badge s={s} /></td>
                        <td>{detail || <span className="muted">—</span>}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {issues.length ? (
                <ul className="list">
                  {issues.map((i, n) => (
                    <li key={n}><Badge s={i.severity} label={i.severity === 'fail' ? 'Fix' : 'Improve'} /> <strong>{i.message}.</strong> {i.fix}</li>
                  ))}
                </ul>
              ) : d.checked_at ? <p className="muted">Nothing to fix.</p> : null}
              {lists.some((l) => l.status === 'unknown') ? (
                <p className="muted">
                  {lists.filter((l) => l.status === 'unknown').map((l) => `${l.list}: ${l.detail}`).join('. ')}. An unanswered
                  list is shown as not checked, never as clear.
                </p>
              ) : null}
              <details>
                <summary>Records found</summary>
                <p className="muted">SPF</p>
                <pre className="pre">{d.spf_record ?? 'none'}</pre>
                <p className="muted">DMARC</p>
                <pre className="pre">{d.dmarc_record ?? 'none'}</pre>
              </details>
              {manage ? (
                <ActionForm action={saveSelector}>
                  <input type="hidden" name="workspace_id" value={workspace.id} />
                  <input type="hidden" name="domain_id" value={d.id} />
                  <label className="field">
                    <span>DKIM selector, if your provider uses an uncommon one (leave blank to try the common ones)</span>
                    <input type="text" name="dkim_selector" defaultValue={d.dkim_selector ?? ''} maxLength={63} placeholder="for example s1 or mx2026" />
                  </label>
                  <SubmitButton variant="ghost">Save selector</SubmitButton>
                </ActionForm>
              ) : null}
              <p className="muted">Checked {when(d.checked_at)}</p>
            </article>
          );
        })}
      </section>

      <section className="stack" aria-labelledby="mailboxes">
        <h2 id="mailboxes">Mailboxes</h2>
        <p className="muted">Status and warm-up come from Instantly. Sends, bounces and replies are the last 30 days of Instantly&apos;s own events; rates show once a mailbox has sent 20 emails.</p>
        {boxes.length === 0 && extra.length === 0 ? (
          <p className="muted">No mailboxes yet. Connect Instantly in <Link href={`${base}/setup`}>Setup</Link> to see them here.</p>
        ) : (
          <div className="table-wrap">
            <table className="table">
              <caption className="sr-only">Mailboxes</caption>
              <thead>
                <tr>
                  <th scope="col">Mailbox</th><th scope="col">Status</th><th scope="col">Warm-up</th><th scope="col">Daily limit</th>
                  <th scope="col">Sent</th><th scope="col">Bounce rate</th><th scope="col">Reply rate</th>
                </tr>
              </thead>
              <tbody>
                {boxes.map((b) => {
                  const s = stats.get(b.email) ?? { sent: 0, bounced: 0, replied: 0, unsubscribed: 0 };
                  return (
                    <tr key={b.email}>
                      <th scope="row">{b.email}<br /><small className="muted">{b.provider ? PROVIDER_LABELS[b.provider] ?? b.provider : 'Provider unknown'}{b.setup_pending ? ', setup not finished' : ''}</small></th>
                      <td><Badge s={mailboxTone(b.status, b.warmup_status)} label={MAILBOX_STATUS[b.status] ?? b.status} /></td>
                      <td>{WARMUP_STATUS[b.warmup_status] ?? b.warmup_status}{b.warmup_score !== null ? `, health ${b.warmup_score}` : ''}</td>
                      <td>{b.daily_limit ?? '—'}</td>
                      <td>{s.sent}</td>
                      <td>{rate(s.bounced, s.sent)}</td>
                      <td>{rate(s.replied, s.sent)}</td>
                    </tr>
                  );
                })}
                {extra.map((e) => {
                  const s = stats.get(e)!;
                  return (
                    <tr key={e}>
                      <th scope="row">{e}<br /><small className="muted">Not in Instantly&apos;s current list</small></th>
                      <td><Badge s="unknown" /></td><td>—</td><td>—</td>
                      <td>{s.sent}</td><td>{rate(s.bounced, s.sent)}</td><td>{rate(s.replied, s.sent)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        {unattributed?.sent ? (
          <p className="muted">{unattributed.sent} sends in the last 30 days did not say which mailbox sent them; Instantly does not always include it, so they are not counted against any mailbox.</p>
        ) : null}
      </section>
    </main>
  );
}
