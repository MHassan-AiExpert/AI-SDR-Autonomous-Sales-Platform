// The daily deliverability check for one workspace (F27), run from the
// monitoring sweep. It reads the mailboxes from Instantly, works out which
// domains the workspace sends from, checks each domain's DNS, stores the
// results, and tells the team about problems that are new since yesterday.

import { checkDomain, defaultDns, domainOf, mailboxFrom, mailboxProblems, newIssues, type Dns, type MailboxHealth } from './deliverability.ts';
import { listAccounts } from './sources/instantly.ts';
import { ProviderError } from './http.ts';
import { notify } from './notify.ts';
import type { Deps } from './jobs.ts';

export const MAX_DOMAINS = 20;

export type DeliverabilityStats = { ran: boolean; domains: number; mailboxes: number; alerts: number; skipped: string[] };

const md = (s: string) => s.replace(/[*_~`<>&]/g, '');

export async function runDeliverability(deps: Deps & { dns?: Dns }, ws: string, day: string, now = new Date()): Promise<DeliverabilityStats> {
  const { store } = deps;
  const stats: DeliverabilityStats = { ran: false, domains: 0, mailboxes: 0, alerts: 0, skipped: [] };
  if (!(await store.claimDeliverability(ws))) return stats;
  stats.ran = true;
  const dns = deps.dns ?? defaultDns;
  const link = (label: string) => (deps.appUrl ? ` <${deps.appUrl}/w/${ws}/deliverability|${label}>` : '');

  // 1. Mailboxes, from Instantly when it is connected
  const before = new Map((await store.mailboxes(ws)).map((m) => [m.email, m]));
  let boxes: MailboxHealth[] = [];
  const connected = await store.connectedTools(ws);
  const key = connected.has('instantly') ? (await store.secret(ws, 'instantly'))?.api_key : undefined;
  if (key) {
    try {
      const { accounts, complete } = await listAccounts(key, deps.fetchImpl);
      boxes = accounts.map(mailboxFrom).filter((m): m is MailboxHealth => m !== null);
      await store.saveMailboxes(ws, boxes, complete);
      stats.mailboxes = boxes.length;
      if (!complete) stats.skipped.push('More than 1,000 mailboxes: the rest were not read');
    } catch (err) {
      if (err instanceof ProviderError && (err.status === 401 || err.status === 403)) await store.markToolError(ws, 'instantly', 'error', err.message);
      stats.skipped.push(`Mailboxes not read: ${err instanceof Error ? err.message : 'Instantly failed'}`);
      boxes = [...before.values()];
    }
  } else {
    stats.skipped.push('Instantly is not connected, so mailbox health was not read');
  }

  // 2. Mailbox problems that are new since the last check
  for (const m of boxes) {
    const had = new Set(before.get(m.email) ? mailboxProblems(before.get(m.email)!).map((p) => p.message) : []);
    const fresh = mailboxProblems(m).filter((p) => !had.has(p.message));
    if (!fresh.length) continue;
    const r = await notify(store, ws, {
      event: 'system_alert', severity: fresh.some((p) => p.severity === 'fail') ? 'critical' : 'warning', path: '/deliverability',
      title: `Mailbox needs attention: ${m.email}`.slice(0, 120), dedupe: `mailbox:${m.email}:${day}`,
      slack: `:email: *Mailbox needs attention* (${md(m.email)}): ${fresh.map((p) => md(p.message)).join('; ')}.${link('Open deliverability')}`,
    }, deps.fetchImpl, now);
    if (r.status !== 'duplicate') stats.alerts++;
  }

  // 3. Domains: those the campaigns send from, and those of the Instantly mailboxes
  const providersBy = new Map<string, Set<string>>();
  for (const m of boxes) {
    if (!providersBy.has(m.domain)) providersBy.set(m.domain, new Set());
    if (m.provider === 'google' || m.provider === 'microsoft') providersBy.get(m.domain)!.add(m.provider);
  }
  for (const e of await store.campaignSendingAccounts(ws)) {
    const d = domainOf(e);
    if (d && !providersBy.has(d)) providersBy.set(d, new Set());
  }
  const all = [...providersBy.keys()].sort();
  const domains = all.slice(0, MAX_DOMAINS);
  if (all.length > MAX_DOMAINS) stats.skipped.push(`${all.length - MAX_DOMAINS} domains over the limit of ${MAX_DOMAINS} were not checked`);
  const stored = new Map((await store.sendingDomains(ws)).map((d) => [d.domain, d]));

  for (const domain of domains) {
    const prev = stored.get(domain);
    const result = await checkDomain(dns, domain, { dkimSelector: prev?.dkim_selector ?? null, providers: [...providersBy.get(domain)!] });
    await store.saveDomainCheck(ws, result);
    stats.domains++;
    // The first check of a domain reports everything; later ones only what is new
    const fresh = newIssues(Array.isArray(prev?.issues) ? prev!.issues : [], result.issues).filter((i) => i.severity === 'fail');
    if (!fresh.length) continue;
    const listed = fresh.some((i) => i.check === 'blocklist');
    const r = await notify(store, ws, {
      event: 'system_alert', severity: listed ? 'critical' : 'warning', path: '/deliverability',
      title: `${listed ? 'Domain blocklisted' : 'Domain set-up problem'}: ${domain}`.slice(0, 120), dedupe: `domain:${domain}:${day}`,
      slack: `:mailbox_with_no_mail: *${listed ? 'Sending domain blocklisted' : 'Sending domain set-up problem'}* (${md(domain)}): ${fresh.map((i) => md(i.message)).join('; ')}.${link('See how to fix it')}`,
    }, deps.fetchImpl, now);
    if (r.status !== 'duplicate') stats.alerts++;
  }
  // Only drop domains when the full list was known
  if (all.length <= MAX_DOMAINS) await store.dropSendingDomains(ws, all);
  return stats;
}
