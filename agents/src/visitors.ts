// Website visitor identification, company level (F30). Runs every cycle of
// the job loop: takes page views the tracking script recorded, looks up each
// network once (cached for 30 days across workspaces), keeps only company
// networks, and turns a visit from a company already in the pipeline into a
// website_visit signal, at most once a week per company.
//
// Raw IPs are erased by the database as soon as a view is resolved.

import { createHash } from 'node:crypto';
import { identify, lookupIp, type Identified } from './sources/ipapi.ts';
import { ProviderError } from './http.ts';
import type { Deps } from './jobs.ts';
import { log } from './log.ts';

export const BATCH = 200;
export const CACHE_DAYS = 30;
export const SIGNAL_EVERY_DAYS = 7;

export const ipKey = (ip: string) => createHash('sha256').update(ip.trim().toLowerCase()).digest('hex');

/** ISO week, so one company makes at most one signal per week */
export function isoWeek(d: Date): string {
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const day = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - day);
  const year = t.getUTCFullYear();
  const week = Math.ceil(((t.getTime() - Date.UTC(year, 0, 1)) / 86_400_000 + 1) / 7);
  return `${year}-W${String(week).padStart(2, '0')}`;
}

/** The team's own website hosts belong to the team: a visit from them is not a prospect */
export function isOwn(domain: string, hosts: string[]): boolean {
  return hosts.some((h) => domain === h || h.endsWith(`.${domain}`) || domain.endsWith(`.${h}`));
}

export async function identifyVisits(deps: Deps, limit = BATCH, now = new Date()) {
  const { store } = deps;
  const visits = await store.claimSiteVisits(limit);
  const stats = { looked_up: 0, cached: 0, identified: 0, skipped: 0, signals: 0, waiting: 0 };
  if (!visits.length) return stats;
  const keys = new Map<string, string | null>();
  const hosts = new Map<string, string[]>();
  const blocked = new Set<string>();
  const seen = new Map<string, Identified>();

  for (const v of visits) {
    const ws = v.workspace_id;
    if (!keys.has(ws)) {
      const connected = await store.connectedTools(ws);
      keys.set(ws, connected.has('ipapi') ? (await store.secret(ws, 'ipapi'))?.api_key ?? null : null);
      hosts.set(ws, await store.visitorHosts(ws));
    }
    const key = keys.get(ws);
    if (!key) { await store.markVisit(v.id, 'skipped', 'ipapi.is not connected', null); stats.skipped++; continue; }
    if (blocked.has(ws)) { stats.waiting++; continue; }

    const h = ipKey(v.ip);
    let result = seen.get(h) ?? (await store.ipLookup(h, CACHE_DAYS));
    if (result) stats.cached++;
    else {
      try {
        result = identify(await lookupIp(key, v.ip, deps.fetchImpl));
        stats.looked_up++;
        await store.saveIpLookup(h, result);
      } catch (err) {
        if (err instanceof ProviderError && (err.status === 401 || err.status === 403)) {
          await store.markToolError(ws, 'ipapi', 'expired', 'ipapi.is rejected the API key. Reconnect it in Setup.');
        }
        // Quota, outage or key problem: leave this workspace's views for a later run (erased after a day if never resolved)
        blocked.add(ws);
        stats.waiting++;
        log('warn', 'visitor lookup paused', { workspace_id: ws, error: err instanceof Error ? err.message : 'unknown' });
        continue;
      }
    }
    seen.set(h, result);

    if ('skip' in result) { await store.markVisit(v.id, 'skipped', result.skip, null); stats.skipped++; continue; }
    const c = result.company;
    if (isOwn(c.domain, hosts.get(ws) ?? [])) { await store.markVisit(v.id, 'skipped', 'your own team', null); stats.skipped++; continue; }
    await store.markVisit(v.id, 'identified', null, c.domain);
    stats.identified++;
    const visitor = await store.recordSiteVisitor(ws, c, v.path, v.created_at);
    // A known company, not told about this week: a signal for the sequence and the copywriter
    const due = !visitor.last_signal_at || now.getTime() - new Date(visitor.last_signal_at).getTime() > SIGNAL_EVERY_DAYS * 86_400_000;
    if (visitor.company_id && due) {
      const pages = Object.entries(visitor.top_paths).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([p]) => p);
      const made = await store.saveSignals(ws, [{
        company_id: visitor.company_id, lead_id: null, campaign_id: null, kind: 'website_visit', source: 'visitor',
        title: `${visitor.company_name ?? c.name ?? c.domain} visited your website`.slice(0, 300),
        detail: `Pages: ${pages.join(', ')}. Identified from the company's own network; the person is not known.`.slice(0, 2000),
        url: null, occurred_at: new Date(v.created_at).toISOString(), fingerprint: `visit:${c.domain}:${isoWeek(now)}`,
      }]);
      await store.setVisitorSignaled(ws, c.domain);
      stats.signals += made;
    }
  }
  return stats;
}
