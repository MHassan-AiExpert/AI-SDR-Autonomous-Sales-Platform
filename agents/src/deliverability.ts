// Deliverability checks (F27): is each sending domain set up the way
// receivers require, and is it on a domain blocklist?
//
// Every check here is a DNS lookup, through an injectable resolver so tests
// never touch the network. A lookup that fails for a reason other than "no
// such record" (a timeout, a refused query) is reported as "unknown", never
// as a pass or a fail: a red badge for a working domain sends a team chasing
// a problem that does not exist.

import { Resolver as DnsResolver } from 'node:dns/promises';

export type Status = 'pass' | 'warn' | 'fail' | 'unknown';
export type Severity = 'fail' | 'warn';
export type CheckName = 'spf' | 'dkim' | 'dmarc' | 'mx' | 'blocklist';
export type Issue = { severity: Severity; check: CheckName; message: string; fix: string };
export type BlocklistResult = { list: string; status: 'listed' | 'clear' | 'unknown'; detail: string };

/** Answers DNS queries. "No such record" returns an empty list; any other failure throws. */
export type Dns = {
  txt: (name: string) => Promise<string[]>;
  mx: (name: string) => Promise<{ exchange: string; priority: number }[]>;
  a: (name: string) => Promise<string[]>;
};

const EMPTY_CODES = new Set(['ENOTFOUND', 'ENODATA', 'NXDOMAIN', 'ENONAME']);

export function makeDns(servers?: string[]): Dns {
  const r = new DnsResolver({ timeout: 4000, tries: 2 });
  if (servers?.length) r.setServers(servers);
  const empty = <T>(fn: () => Promise<T[]>) => fn().catch((err: NodeJS.ErrnoException) => {
    if (err && EMPTY_CODES.has(String(err.code))) return [] as T[];
    throw err;
  });
  return {
    txt: (n) => empty(() => r.resolveTxt(n)).then((rows) => rows.map((parts) => parts.join(''))),
    mx: (n) => empty(() => r.resolveMx(n)),
    a: (n) => empty(() => r.resolve4(n)),
  };
}

export const defaultDns = makeDns();

const worst = (issues: Issue[], check: CheckName): Status => {
  const mine = issues.filter((i) => i.check === check);
  if (mine.some((i) => i.severity === 'fail')) return 'fail';
  if (mine.some((i) => i.severity === 'warn')) return 'warn';
  return 'pass';
};

export const DOMAIN = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/;

/** The domain part of a mailbox address, lower-cased; null when it is not one. */
export function domainOf(email: string): string | null {
  const m = /^[^@\s]+@([^@\s]+)$/.exec(email.trim().toLowerCase());
  const d = m?.[1].replace(/\.$/, '');
  return d && DOMAIN.test(d) ? d : null;
}

// Second-level public suffixes common enough to matter for the DMARC fallback
const TWO_LEVEL = new Set(['co.uk', 'org.uk', 'ac.uk', 'com.au', 'net.au', 'org.au', 'co.nz', 'co.za', 'com.br', 'com.mx', 'co.jp', 'co.in', 'com.pk', 'com.sg', 'com.tr', 'co.il', 'com.ar']);

/** The registered domain a subdomain belongs to, for DMARC's fallback. */
export function orgDomain(domain: string): string {
  const parts = domain.split('.');
  const n = TWO_LEVEL.has(parts.slice(-2).join('.')) ? 3 : 2;
  return parts.slice(-n).join('.');
}

// ---------------------------------------------------------------------- SPF

export const SPF_LOOKUP_LIMIT = 10;
export const PROVIDER_SPF: Record<string, { include: string; name: string }> = {
  google: { include: '_spf.google.com', name: 'Google Workspace' },
  microsoft: { include: 'spf.protection.outlook.com', name: 'Microsoft 365' },
};

const isSpf = (r: string) => /^v=spf1(\s|$)/i.test(r.trim());

/**
 * Counts the DNS lookups an SPF record causes (RFC 7208 4.6.4 allows 10),
 * following include and redirect, and collects every domain included on the way.
 */
export async function spfLookups(dns: Dns, record: string, depth = 0, seen = new Set<string>()): Promise<{ lookups: number; includes: Set<string>; broken: string[] }> {
  let lookups = 0;
  const includes = new Set<string>();
  const broken: string[] = [];
  for (const raw of record.trim().split(/\s+/).slice(1)) {
    const term = raw.replace(/^[+\-~?]/, '').toLowerCase();
    const [mech, arg] = term.includes(':') ? [term.slice(0, term.indexOf(':')), term.slice(term.indexOf(':') + 1)]
      : term.includes('=') ? [term.slice(0, term.indexOf('=')), term.slice(term.indexOf('=') + 1)] : [term.replace(/\/.*$/, ''), ''];
    if (['a', 'mx', 'ptr', 'exists'].includes(mech)) lookups++;
    if (mech !== 'include' && mech !== 'redirect') continue;
    lookups++;
    if (!arg || arg.includes('%')) continue; // macros cannot be followed without a message
    includes.add(arg);
    if (depth >= 10 || seen.has(arg)) continue;
    seen.add(arg);
    const child = (await dns.txt(arg)).filter(isSpf);
    if (child.length !== 1) { broken.push(arg); continue; }
    const sub = await spfLookups(dns, child[0], depth + 1, seen);
    lookups += sub.lookups;
    sub.includes.forEach((d) => includes.add(d));
    broken.push(...sub.broken);
  }
  return { lookups, includes, broken };
}

export async function checkSpf(dns: Dns, domain: string, providers: string[]) {
  const issues: Issue[] = [];
  const records = (await dns.txt(domain)).filter(isSpf);
  if (!records.length) {
    issues.push({ severity: 'fail', check: 'spf', message: 'No SPF record', fix: `Add a TXT record on ${domain} listing the services that send for it, ending in ~all or -all.` });
    return { status: 'fail' as Status, record: null, lookups: null, issues };
  }
  if (records.length > 1) {
    issues.push({ severity: 'fail', check: 'spf', message: `${records.length} SPF records`, fix: 'Receivers treat more than one SPF record as an error. Merge them into a single TXT record.' });
    return { status: 'fail' as Status, record: records.join(' | ').slice(0, 2000), lookups: null, issues };
  }
  const record = records[0].trim();
  const terms = record.toLowerCase().split(/\s+/);
  const all = terms.find((t) => /^[+\-~?]?all$/.test(t));
  if (all === '+all' || all === 'all') issues.push({ severity: 'fail', check: 'spf', message: 'SPF allows anyone to send (+all)', fix: 'Replace +all with ~all or -all, so only the listed services may send.' });
  else if (all === '?all') issues.push({ severity: 'warn', check: 'spf', message: 'SPF ends in ?all, which protects nothing', fix: 'Change ?all to ~all or -all.' });
  else if (!all && !terms.some((t) => t.startsWith('redirect='))) issues.push({ severity: 'warn', check: 'spf', message: 'SPF has no ~all or -all at the end', fix: 'End the record with ~all or -all.' });
  if (terms.some((t) => /^[+\-~?]?ptr(:|$)/.test(t))) issues.push({ severity: 'warn', check: 'spf', message: 'SPF uses ptr, which receivers may ignore', fix: 'Replace ptr with ip4, ip6 or include.' });

  const { lookups, includes, broken } = await spfLookups(dns, record);
  if (lookups > SPF_LOOKUP_LIMIT) issues.push({ severity: 'fail', check: 'spf', message: `SPF needs ${lookups} DNS lookups; the limit is ${SPF_LOOKUP_LIMIT}`, fix: 'Receivers stop at 10 and fail the check. Remove includes for services no longer used, or replace some with ip4 ranges.' });
  for (const b of broken) issues.push({ severity: 'warn', check: 'spf', message: `The included ${b} has no single SPF record`, fix: `Remove include:${b} or correct its record.` });
  for (const p of providers) {
    const want = PROVIDER_SPF[p];
    if (want && !includes.has(want.include)) issues.push({ severity: 'fail', check: 'spf', message: `SPF does not include ${want.name}`, fix: `Add include:${want.include} so mail sent through ${want.name} passes.` });
  }
  return { status: worst(issues, 'spf'), record: record.slice(0, 2000), lookups, issues };
}

// --------------------------------------------------------------------- DKIM

const PROVIDER_SELECTORS: Record<string, string[]> = { google: ['google'], microsoft: ['selector1', 'selector2'] };
export const COMMON_SELECTORS = ['google', 'selector1', 'selector2', 'default', 's1', 's2', 'k1', 'dkim', 'mail'];

/** The selectors to try: the team's own first, then the provider's, then common ones. */
export function dkimSelectors(custom: string | null, providers: string[]): string[] {
  return [...new Set([...(custom ? [custom] : []), ...providers.flatMap((p) => PROVIDER_SELECTORS[p] ?? []), ...COMMON_SELECTORS])];
}

export async function checkDkim(dns: Dns, domain: string, custom: string | null, providers: string[]) {
  const issues: Issue[] = [];
  const found: string[] = [];
  const revoked: string[] = [];
  let failed = 0;
  const selectors = dkimSelectors(custom, providers);
  for (const sel of selectors) {
    let recs: string[];
    try { recs = await dns.txt(`${sel}._domainkey.${domain}`); } catch { failed++; continue; }
    const key = recs.find((r) => /(^|;)\s*p=/i.test(r));
    if (!key) continue;
    if (/(^|;)\s*p=\s*(;|$)/i.test(key)) revoked.push(sel); else found.push(sel);
  }
  if (failed === selectors.length) return { status: 'unknown' as Status, found, issues };
  if (custom && !found.includes(custom)) {
    issues.push({ severity: 'fail', check: 'dkim', message: `No DKIM key at the selector ${custom}`, fix: `Publish the key your provider gives you at ${custom}._domainkey.${domain}, or correct the selector.` });
  } else if (!found.length) {
    issues.push({
      severity: revoked.length ? 'fail' : 'warn', check: 'dkim',
      message: revoked.length ? `The DKIM key at ${revoked.join(', ')} is revoked` : 'No DKIM key at the common selectors',
      fix: 'Turn on DKIM signing in your email provider and publish its key. If it uses a selector other than the common ones, enter it here so it can be checked.',
    });
  }
  return { status: worst(issues, 'dkim'), found, issues };
}

// -------------------------------------------------------------------- DMARC

export function dmarcTags(record: string): Record<string, string> {
  return Object.fromEntries(record.split(';').map((p) => p.trim()).filter(Boolean)
    .map((p) => [p.slice(0, p.indexOf('=')).trim().toLowerCase(), p.slice(p.indexOf('=') + 1).trim()]).filter(([k]) => k));
}

export async function checkDmarc(dns: Dns, domain: string) {
  const issues: Issue[] = [];
  const find = async (d: string) => (await dns.txt(`_dmarc.${d}`)).filter((r) => /^v=DMARC1\s*(;|$)/i.test(r.trim()));
  let records = await find(domain);
  const org = orgDomain(domain);
  if (!records.length && org !== domain) records = await find(org);
  if (!records.length) {
    issues.push({ severity: 'fail', check: 'dmarc', message: 'No DMARC record', fix: `Gmail and Yahoo require one from bulk senders. Add a TXT record at _dmarc.${org}, for example "v=DMARC1; p=none; rua=mailto:dmarc@${org}", then tighten it once reports look clean.` });
    return { status: 'fail' as Status, record: null, policy: null, issues };
  }
  if (records.length > 1) {
    issues.push({ severity: 'fail', check: 'dmarc', message: `${records.length} DMARC records`, fix: 'Receivers ignore DMARC when there is more than one record. Keep one.' });
    return { status: 'fail' as Status, record: records.join(' | ').slice(0, 2000), policy: null, issues };
  }
  const tags = dmarcTags(records[0]);
  const p = (tags.p ?? '').toLowerCase();
  const policy = p === 'none' || p === 'quarantine' || p === 'reject' ? p : null;
  if (!policy) issues.push({ severity: 'fail', check: 'dmarc', message: 'DMARC has no valid policy (p=)', fix: 'Set p=none, p=quarantine or p=reject.' });
  else if (policy === 'none') issues.push({ severity: 'warn', check: 'dmarc', message: 'DMARC is in monitoring mode (p=none)', fix: 'This meets the requirement but protects nothing. Move to p=quarantine once reports show only your own services sending.' });
  if (policy && !tags.rua) issues.push({ severity: 'warn', check: 'dmarc', message: 'DMARC sends its reports nowhere', fix: 'Add rua=mailto:... so you learn when someone sends as your domain, or when a service of yours fails.' });
  return { status: worst(issues, 'dmarc'), record: records[0].trim().slice(0, 2000), policy, issues };
}

// ----------------------------------------------------------------------- MX

export async function checkMx(dns: Dns, domain: string) {
  const issues: Issue[] = [];
  const mx = await dns.mx(domain);
  if (mx.some((m) => m.exchange === '' || m.exchange === '.')) issues.push({ severity: 'fail', check: 'mx', message: 'The domain says it accepts no mail (null MX)', fix: 'Replies and bounces cannot reach a domain that refuses mail. Point MX at your mail provider.' });
  else if (!mx.length) issues.push({ severity: 'fail', check: 'mx', message: 'No MX record', fix: 'Replies cannot reach this domain, and receivers distrust senders that cannot receive. Add your provider\'s MX records.' });
  return { status: worst(issues, 'mx'), issues };
}

// --------------------------------------------------------------- blocklists

/**
 * Domain blocklists, and how each answers. An answer that means "your query was
 * refused" (for example Spamhaus refusing public resolvers) is "unknown", not a listing.
 */
export const BLOCKLISTS: { name: string; zone: string; read: (ip: string) => { status: BlocklistResult['status']; detail: string; severity?: Severity } }[] = [
  {
    name: 'Spamhaus DBL', zone: 'dbl.spamhaus.org',
    read: (ip) => {
      const listed: Record<string, string> = {
        '127.0.1.2': 'spam domain', '127.0.1.4': 'phishing domain', '127.0.1.5': 'malware domain', '127.0.1.6': 'botnet control domain',
        '127.0.1.102': 'abused legitimate domain (spam)', '127.0.1.103': 'abused redirector', '127.0.1.104': 'abused legitimate domain (phishing)',
        '127.0.1.105': 'abused legitimate domain (malware)', '127.0.1.106': 'abused legitimate domain (botnet)',
      };
      if (listed[ip]) return { status: 'listed', detail: listed[ip], severity: 'fail' };
      return { status: 'unknown', detail: ip.startsWith('127.255.255.') || ip === '127.0.1.255' ? 'Spamhaus refused the query (it does not answer public DNS resolvers)' : `Unexpected answer ${ip}` };
    },
  },
  {
    name: 'SURBL', zone: 'multi.surbl.org',
    read: (ip) => {
      const last = Number(ip.split('.')[3]);
      if (!ip.startsWith('127.0.0.') || last === 1) return { status: 'unknown', detail: 'SURBL refused the query' };
      const bits: [number, string][] = [[8, 'phishing'], [16, 'malware'], [64, 'abuse'], [128, 'cracked site'], [4, 'disposable mail']];
      const why = bits.filter(([b]) => last & b).map(([, w]) => w);
      return why.length ? { status: 'listed', detail: why.join(', '), severity: 'fail' } : { status: 'unknown', detail: `Unexpected answer ${ip}` };
    },
  },
  {
    name: 'URIBL', zone: 'multi.uribl.com',
    read: (ip) => {
      const last = Number(ip.split('.')[3]);
      if (!ip.startsWith('127.0.0.') || last === 1 || last === 255) return { status: 'unknown', detail: 'URIBL refused the query' };
      if (last & 2) return { status: 'listed', detail: 'black list', severity: 'fail' };
      if (last & 8) return { status: 'listed', detail: 'red list', severity: 'fail' };
      if (last & 4) return { status: 'listed', detail: 'grey list (bulk sender, less severe)', severity: 'warn' };
      return { status: 'unknown', detail: `Unexpected answer ${ip}` };
    },
  },
];

export async function checkBlocklists(dns: Dns, domain: string) {
  const issues: Issue[] = [];
  const results: BlocklistResult[] = [];
  for (const bl of BLOCKLISTS) {
    let ips: string[];
    try { ips = await dns.a(`${domain}.${bl.zone}`); } catch {
      results.push({ list: bl.name, status: 'unknown', detail: 'The list did not answer' });
      continue;
    }
    if (!ips.length) { results.push({ list: bl.name, status: 'clear', detail: 'Not listed' }); continue; }
    const reads = ips.map(bl.read);
    const hit = reads.find((r) => r.status === 'listed' && r.severity === 'fail') ?? reads.find((r) => r.status === 'listed') ?? reads[0];
    results.push({ list: bl.name, status: hit.status, detail: hit.detail });
    if (hit.status === 'listed') {
      issues.push({ severity: hit.severity ?? 'fail', check: 'blocklist', message: `Listed on ${bl.name}: ${hit.detail}`, fix: `Stop sending from this domain, find the cause (a bought list, a compromised mailbox, a sudden volume jump), then request removal from ${bl.name}.` });
    }
  }
  return { results, issues };
}

// -------------------------------------------------------------------- score

export const WEIGHTS = { fail: 25, warn: 8 } as const;

/** 100 minus 25 per failure and 8 per warning, never below zero. Unknown checks cost nothing. */
export function score(issues: Issue[]): number {
  return Math.max(0, 100 - issues.reduce((s, i) => s + WEIGHTS[i.severity], 0));
}

export type DomainResult = {
  domain: string; spf_status: Status; spf_record: string | null; spf_lookups: number | null;
  dkim_status: Status; dkim_found: string[]; dmarc_status: Status; dmarc_policy: string | null; dmarc_record: string | null;
  mx_status: Status; blocklists: BlocklistResult[]; issues: Issue[]; score: number;
};

/** Runs every check for one domain. A check whose lookup fails is "unknown" and the rest still run. */
export async function checkDomain(dns: Dns, domain: string, opts: { dkimSelector?: string | null; providers?: string[] } = {}): Promise<DomainResult> {
  const providers = [...new Set(opts.providers ?? [])];
  const safe = async <T>(fn: () => Promise<T>): Promise<T | null> => { try { return await fn(); } catch { return null; } };
  const [spf, dkim, dmarc, mx, bl] = await Promise.all([
    safe(() => checkSpf(dns, domain, providers)), safe(() => checkDkim(dns, domain, opts.dkimSelector ?? null, providers)),
    safe(() => checkDmarc(dns, domain)), safe(() => checkMx(dns, domain)), checkBlocklists(dns, domain),
  ]);
  const issues = [...(spf?.issues ?? []), ...(dkim?.issues ?? []), ...(dmarc?.issues ?? []), ...(mx?.issues ?? []), ...bl.issues];
  return {
    domain, spf_status: spf?.status ?? 'unknown', spf_record: spf?.record ?? null, spf_lookups: spf?.lookups ?? null,
    dkim_status: dkim?.status ?? 'unknown', dkim_found: dkim?.found ?? [],
    dmarc_status: dmarc?.status ?? 'unknown', dmarc_policy: dmarc?.policy ?? null, dmarc_record: dmarc?.record ?? null,
    mx_status: mx?.status ?? 'unknown', blocklists: bl.results, issues, score: score(issues),
  };
}

/** Issues present now that were not present at the last check, by check and message. */
export function newIssues(before: Issue[], after: Issue[]): Issue[] {
  const key = (i: Issue) => `${i.check}|${i.severity}|${i.message.replace(/\d+/g, '#')}`;
  const had = new Set(before.map(key));
  return after.filter((i) => !had.has(key(i)));
}

// ---------------------------------------------------------------- mailboxes

export type MailboxHealth = {
  email: string; domain: string; provider: string | null; status: string; warmup_status: string;
  warmup_score: number | null; daily_limit: number | null; setup_pending: boolean | null;
};

const STATUS: Record<string, string> = { '1': 'active', '2': 'paused', '3': 'maintenance', '-1': 'connection_error', '-2': 'soft_bounce_error', '-3': 'sending_error' };
const WARMUP: Record<string, string> = { '0': 'paused', '1': 'active', '-1': 'banned', '-2': 'spam_folder_unknown', '-3': 'suspended' };
const PROVIDER: Record<string, string> = { '1': 'smtp', '2': 'google', '3': 'microsoft', '4': 'aws', '8': 'airmail', '11': 'airmail' };

/** One Instantly account object to what is stored; null when it has no usable address. */
export function mailboxFrom(a: Record<string, unknown>): MailboxHealth | null {
  const email = typeof a.email === 'string' ? a.email.trim().toLowerCase() : '';
  const domain = domainOf(email);
  // The same rule the table enforces, so one odd address cannot fail the whole save
  if (!domain || !/\.[a-z]{2,}$/.test(email)) return null;
  const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  const score = n(a.stat_warmup_score);
  const limit = n(a.daily_limit);
  return {
    email, domain,
    provider: a.provider_code === undefined || a.provider_code === null ? null : PROVIDER[String(a.provider_code)] ?? 'other',
    status: STATUS[String(a.status)] ?? 'unknown',
    warmup_status: WARMUP[String(a.warmup_status)] ?? 'unknown',
    warmup_score: score === null ? null : Math.max(0, Math.min(100, Math.round(score))),
    daily_limit: limit === null ? null : Math.max(0, Math.round(limit)),
    setup_pending: typeof a.setup_pending === 'boolean' ? a.setup_pending : null,
  };
}

/** Our own threshold, not Instantly's: below this a mailbox should send less until it recovers. */
export const LOW_WARMUP_SCORE = 70;

/** What is wrong with a mailbox, worst first; empty when nothing is. */
export function mailboxProblems(m: MailboxHealth): { severity: Severity; message: string }[] {
  const out: { severity: Severity; message: string }[] = [];
  const st: Record<string, string> = {
    connection_error: 'Instantly cannot connect to it; reconnect it in Instantly',
    soft_bounce_error: 'Instantly stopped it after soft bounces',
    sending_error: 'Instantly stopped it after sending errors',
  };
  if (st[m.status]) out.push({ severity: 'fail', message: st[m.status] });
  const wu: Record<string, [Severity, string]> = {
    banned: ['fail', 'Its warm-up was banned'],
    suspended: ['fail', 'Its warm-up was permanently suspended'],
    spam_folder_unknown: ['warn', 'Warm-up cannot find its spam folder'],
  };
  if (wu[m.warmup_status]) out.push({ severity: wu[m.warmup_status][0], message: wu[m.warmup_status][1] });
  if (m.warmup_score !== null && m.warmup_score < LOW_WARMUP_SCORE) out.push({ severity: 'warn', message: `Warm-up health is ${m.warmup_score} of 100` });
  if (m.setup_pending) out.push({ severity: 'warn', message: 'Its setup in Instantly is not finished' });
  return out;
}
