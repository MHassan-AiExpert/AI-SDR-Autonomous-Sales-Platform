import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import {
  checkBlocklists, checkDkim, checkDmarc, checkDomain, checkMx, checkSpf, dkimSelectors, domainOf, mailboxFrom, mailboxProblems,
  newIssues, orgDomain, score, spfLookups, type Dns,
} from '../src/deliverability.ts';
import { listAccounts } from '../src/sources/instantly.ts';
import { runDeliverability } from '../src/deliverabilityRun.ts';
import { monitorWorkspace } from '../src/monitoring.ts';
import type { Deps } from '../src/jobs.ts';
import { startTestDb, fakeFetch, asUser, USERS, type TestDb } from './harness.ts';

/** DNS from a table: TXT and A as string lists, MX as exchanges. Names in `broken` throw like a timeout. */
function fakeDns(zone: Record<string, string[]>, broken: string[] = []): Dns & { asked: string[] } {
  const asked: string[] = [];
  const get = async (type: string, name: string) => {
    asked.push(`${type} ${name}`);
    if (broken.some((b) => name === b || name.endsWith(`.${b}`))) throw Object.assign(new Error('timeout'), { code: 'ETIMEOUT' });
    return zone[`${type} ${name}`] ?? [];
  };
  return {
    asked,
    txt: (n) => get('TXT', n),
    a: (n) => get('A', n),
    mx: async (n) => (await get('MX', n)).map((exchange, i) => ({ exchange, priority: 10 * (i + 1) })),
  };
}

const GOOD: Record<string, string[]> = {
  'TXT acme.com': ['v=spf1 include:_spf.google.com ~all', 'google-site-verification=abc'],
  'TXT _spf.google.com': ['v=spf1 include:_netblocks.google.com include:_netblocks2.google.com ~all'],
  'TXT _netblocks.google.com': ['v=spf1 ip4:35.190.247.0/24 ~all'],
  'TXT _netblocks2.google.com': ['v=spf1 ip6:2001:4860:4000::/36 ~all'],
  'TXT google._domainkey.acme.com': ['v=DKIM1; k=rsa; p=MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA'],
  'TXT _dmarc.acme.com': ['v=DMARC1; p=quarantine; rua=mailto:dmarc@acme.com'],
  'MX acme.com': ['aspmx.l.google.com'],
};

describe('domain checks', () => {
  test('DLV-01 a well set-up Google Workspace domain passes everything and scores 100', async () => {
    const r = await checkDomain(fakeDns(GOOD), 'acme.com', { providers: ['google'] });
    expect(r).toMatchObject({ spf_status: 'pass', spf_lookups: 3, dkim_status: 'pass', dkim_found: ['google'], dmarc_status: 'pass', dmarc_policy: 'quarantine', mx_status: 'pass', score: 100, issues: [] });
    expect(r.blocklists.map((b) => [b.list, b.status])).toEqual([['Spamhaus DBL', 'clear'], ['SURBL', 'clear'], ['URIBL', 'clear']]);
  });

  test('DLV-02 SPF: missing, two records, +all, ?all, no all, ptr', async () => {
    const one = (rec: string[]) => checkSpf(fakeDns({ 'TXT x.com': rec }), 'x.com', []);
    expect((await one([])).issues[0]).toMatchObject({ severity: 'fail', message: 'No SPF record' });
    expect(await one(['v=spf1 -all', 'v=spf1 ~all'])).toMatchObject({ status: 'fail', issues: [{ message: '2 SPF records' }] });
    expect((await one(['v=spf1 +all'])).issues[0]).toMatchObject({ severity: 'fail', message: 'SPF allows anyone to send (+all)' });
    expect((await one(['v=spf1 ip4:1.2.3.4 ?all'])).status).toBe('warn');
    expect((await one(['v=spf1 ip4:1.2.3.4'])).issues[0].message).toBe('SPF has no ~all or -all at the end');
    expect((await one(['v=spf1 ip4:1.2.3.4 redirect=_spf.x.com'])).issues.map((i) => i.message)).toEqual(['The included _spf.x.com has no single SPF record']);
    expect((await one(['v=spf1 ptr -all'])).issues[0].message).toBe('SPF uses ptr, which receivers may ignore');
    // Something that is not SPF is not counted as SPF
    expect((await one(['v=spf10 -all', 'spf1 -all'])).issues[0].message).toBe('No SPF record');
  });

  test('DLV-03 SPF over 10 lookups fails, counting nested includes, a, mx and exists', async () => {
    const zone: Record<string, string[]> = { 'TXT x.com': ['v=spf1 a mx include:a.net include:b.net include:c.net -all'] };
    zone['TXT a.net'] = ['v=spf1 include:d.net include:e.net ~all'];
    zone['TXT b.net'] = ['v=spf1 exists:%{i}.x.net a:mail.b.net ~all'];
    zone['TXT c.net'] = ['v=spf1 include:f.net ~all'];
    for (const d of ['d.net', 'e.net', 'f.net']) zone[`TXT ${d}`] = ['v=spf1 ip4:1.1.1.1 ~all'];
    const dns = fakeDns(zone);
    expect((await spfLookups(dns, zone['TXT x.com'][0])).lookups).toBe(10);
    zone['TXT f.net'] = ['v=spf1 include:g.net ~all'];
    zone['TXT g.net'] = ['v=spf1 ip4:2.2.2.2 ~all'];
    const r = await checkSpf(fakeDns(zone), 'x.com', []);
    expect(r).toMatchObject({ status: 'fail', lookups: 11 });
    expect(r.issues[0].message).toBe('SPF needs 11 DNS lookups; the limit is 10');
  });

  test('DLV-04 SPF include loops end, and a missing provider include fails', async () => {
    const zone = { 'TXT x.com': ['v=spf1 include:loop.net -all'], 'TXT loop.net': ['v=spf1 include:x.com ~all'] };
    const r = await checkSpf(fakeDns(zone), 'x.com', ['microsoft']);
    expect(r.lookups).toBe(3);
    expect(r.issues.map((i) => i.message)).toEqual(['SPF does not include Microsoft 365']);
    expect(r.issues[0].fix).toContain('include:spf.protection.outlook.com');
  });

  test('DLV-05 DKIM: provider selectors first; custom selector; revoked; nothing found', async () => {
    expect(dkimSelectors('mx2026', ['microsoft']).slice(0, 4)).toEqual(['mx2026', 'selector1', 'selector2', 'google']);
    const ms = { 'TXT selector2._domainkey.x.com': ['v=DKIM1; p=MIGfMA0'] };
    expect(await checkDkim(fakeDns(ms), 'x.com', null, ['microsoft'])).toMatchObject({ status: 'pass', found: ['selector2'] });
    // The team's own selector must exist when they gave one
    expect((await checkDkim(fakeDns(ms), 'x.com', 'mx2026', [])).issues[0]).toMatchObject({ severity: 'fail', message: 'No DKIM key at the selector mx2026' });
    expect((await checkDkim(fakeDns({ 'TXT s1._domainkey.x.com': ['v=DKIM1; p='] }), 'x.com', null, [])).issues[0]).toMatchObject({ severity: 'fail', message: 'The DKIM key at s1 is revoked' });
    // Not finding a key at guessed selectors is a warning, not proof there is none
    expect((await checkDkim(fakeDns({}), 'x.com', null, [])).issues[0]).toMatchObject({ severity: 'warn', message: 'No DKIM key at the common selectors' });
    expect((await checkDkim(fakeDns({}, ['x.com']), 'x.com', null, [])).status).toBe('unknown');
  });

  test('DLV-06 DMARC: missing, p=none, no reports, invalid policy, two records, subdomain fallback', async () => {
    const one = (rec: string[], d = 'x.com') => checkDmarc(fakeDns({ 'TXT _dmarc.x.com': rec }), d);
    expect(await one([])).toMatchObject({ status: 'fail', issues: [{ message: 'No DMARC record' }] });
    expect(await one(['v=DMARC1; p=none; rua=mailto:a@x.com'])).toMatchObject({ status: 'warn', policy: 'none', issues: [{ message: 'DMARC is in monitoring mode (p=none)' }] });
    expect((await one(['v=DMARC1; p=reject'])).issues.map((i) => i.message)).toEqual(['DMARC sends its reports nowhere']);
    expect((await one(['v=DMARC1; p=maybe'])).issues[0].message).toBe('DMARC has no valid policy (p=)');
    expect((await one(['v=DMARC1; p=reject', 'v=DMARC1; p=none'])).status).toBe('fail');
    // mail.x.com has no record of its own: the registered domain's applies
    expect(await one(['v=DMARC1; p=reject; rua=mailto:a@x.com'], 'mail.x.com')).toMatchObject({ status: 'pass', policy: 'reject' });
    expect(orgDomain('mail.acme.co.uk')).toBe('acme.co.uk');
    expect(orgDomain('go.acme.com')).toBe('acme.com');
  });

  test('DLV-07 MX: present, missing, null MX', async () => {
    expect((await checkMx(fakeDns({ 'MX x.com': ['mx.x.com'] }), 'x.com')).status).toBe('pass');
    expect((await checkMx(fakeDns({}), 'x.com')).issues[0].message).toBe('No MX record');
    expect((await checkMx(fakeDns({ 'MX x.com': ['.'] }), 'x.com')).issues[0].message).toBe('The domain says it accepts no mail (null MX)');
  });

  test('DLV-08 blocklists: listed, refused queries and grey listing read correctly', async () => {
    const listed = await checkBlocklists(fakeDns({ 'A x.com.dbl.spamhaus.org': ['127.0.1.2'], 'A x.com.multi.surbl.org': ['127.0.0.24'], 'A x.com.multi.uribl.com': ['127.0.0.4'] }), 'x.com');
    expect(listed.results).toEqual([
      { list: 'Spamhaus DBL', status: 'listed', detail: 'spam domain' },
      { list: 'SURBL', status: 'listed', detail: 'phishing, malware' },
      { list: 'URIBL', status: 'listed', detail: 'grey list (bulk sender, less severe)' },
    ]);
    expect(listed.issues.map((i) => i.severity)).toEqual(['fail', 'fail', 'warn']);
    // A refused query is never reported as a listing
    const refused = await checkBlocklists(fakeDns({ 'A x.com.dbl.spamhaus.org': ['127.255.255.254'], 'A x.com.multi.surbl.org': ['127.0.0.1'], 'A x.com.multi.uribl.com': ['127.0.0.255'] }), 'x.com');
    expect(refused.results.map((r) => r.status)).toEqual(['unknown', 'unknown', 'unknown']);
    expect(refused.results[0].detail).toContain('does not answer public DNS resolvers');
    expect(refused.issues).toEqual([]);
    const down = await checkBlocklists(fakeDns({}, ['uribl.com']), 'x.com');
    expect(down.results[2]).toEqual({ list: 'URIBL', status: 'unknown', detail: 'The list did not answer' });
  });

  test('DLV-09 a check whose lookups time out is unknown; the others still run; unknown costs no score', async () => {
    const r = await checkDomain(fakeDns(GOOD, ['_dmarc.acme.com']), 'acme.com', { providers: ['google'] });
    expect(r).toMatchObject({ dmarc_status: 'unknown', spf_status: 'pass', dkim_status: 'pass', mx_status: 'pass', score: 100 });
  });

  test('DLV-10 the score takes 25 per failure and 8 per warning, never below zero', () => {
    const i = (severity: 'fail' | 'warn') => ({ severity, check: 'spf' as const, message: 'm', fix: 'f' });
    expect(score([])).toBe(100);
    expect(score([i('fail'), i('warn')])).toBe(67);
    expect(score([i('fail'), i('fail'), i('fail'), i('fail'), i('warn')])).toBe(0);
  });

  test('DLV-11 only issues new since the last check count as new, ignoring changed numbers', () => {
    const a = { severity: 'fail' as const, check: 'spf' as const, message: 'SPF needs 11 DNS lookups; the limit is 10', fix: '' };
    const b = { severity: 'fail' as const, check: 'dmarc' as const, message: 'No DMARC record', fix: '' };
    expect(newIssues([a], [{ ...a, message: 'SPF needs 12 DNS lookups; the limit is 10' }, b])).toEqual([b]);
    expect(newIssues([], [a])).toEqual([a]);
  });

  test('DLV-12 mailbox addresses to domains', () => {
    expect(domainOf(' Kim@Acme.COM ')).toBe('acme.com');
    expect(domainOf('not an email')).toBeNull();
    expect(domainOf('a@localhost')).toBeNull();
  });
});

describe('mailbox health', () => {
  test('DLV-13 Instantly account fields are read with their documented codes', () => {
    expect(mailboxFrom({ email: 'Kim@Acme.com', status: -1, warmup_status: -1, stat_warmup_score: 61.4, daily_limit: 40, provider_code: 2, setup_pending: false })).toEqual({
      email: 'kim@acme.com', domain: 'acme.com', provider: 'google', status: 'connection_error', warmup_status: 'banned', warmup_score: 61, daily_limit: 40, setup_pending: false,
    });
    expect(mailboxFrom({ email: 'a@b.io', status: 99, provider_code: 7 })).toMatchObject({ status: 'unknown', warmup_status: 'unknown', provider: 'other', warmup_score: null });
    expect(mailboxFrom({ email: 'nope' })).toBeNull();
    expect(mailboxFrom({ email: 'a@host.123' })).toBeNull();
  });

  test('DLV-14 mailbox problems, worst first', () => {
    const m = mailboxFrom({ email: 'a@b.io', status: -2, warmup_status: -2, stat_warmup_score: 55, setup_pending: true })!;
    expect(mailboxProblems(m)).toEqual([
      { severity: 'fail', message: 'Instantly stopped it after soft bounces' },
      { severity: 'warn', message: 'Warm-up cannot find its spam folder' },
      { severity: 'warn', message: 'Warm-up health is 55 of 100' },
      { severity: 'warn', message: 'Its setup in Instantly is not finished' },
    ]);
    expect(mailboxProblems(mailboxFrom({ email: 'a@b.io', status: 1, warmup_status: 1, stat_warmup_score: 98 })!)).toEqual([]);
  });

  test('DLV-15 the account list is paged with starting_after, and a strange envelope is an error', async () => {
    const f = fakeFetch([[/api\.instantly\.ai\/api\/v2\/accounts/, (url) => (new URL(url).searchParams.get('starting_after')
      ? { items: [{ email: 'b@x.com' }] } : { items: [{ email: 'a@x.com' }], next_starting_after: 'cur-1' })]]);
    const r = await listAccounts('key', f.impl);
    expect(r).toEqual({ accounts: [{ email: 'a@x.com' }, { email: 'b@x.com' }], complete: true });
    expect(f.calls.map((c) => new URL(c.url).search)).toEqual(['?limit=100', '?limit=100&starting_after=cur-1']);
    expect((f.calls[0].init.headers as Record<string, string>).Authorization).toBe('Bearer key');
    await expect(listAccounts('key', fakeFetch([[/instantly/, () => ({ data: 'x' })]]).impl)).rejects.toThrow('shape that was not recognised');
    const endless = fakeFetch([[/instantly/, () => ({ items: [{ email: 'a@x.com' }], next_starting_after: 'again' })]]);
    expect((await listAccounts('key', endless.impl, 3)).complete).toBe(false);
  });
});

// ---------------------------------------------------------------- end to end

describe('the daily check', () => {
  let t: TestDb;
  let accounts: Record<string, unknown>[] = [];
  let instantlyStatus = 200;
  const zone: Record<string, string[]> = { ...GOOD };
  const apis = () => fakeFetch([
    [/api\.instantly\.ai\/api\/v2\/accounts/, () => (instantlyStatus === 200 ? { items: accounts } : new Response('{}', { status: instantlyStatus }))],
    [/slack\.com/, () => ({ ok: true })],
  ]);
  const deps = (f: ReturnType<typeof apis>): Deps => ({ store: t.store, models: { openai: "o", anthropic: null, gemini: "g" }, fetchImpl: f.impl, appUrl: 'https://app.example.com', dns: fakeDns(zone) });
  const domains = async () => (await t.db.query(`select domain, spf_status, dkim_status, dmarc_status, mx_status, score, issues from sending_domains where workspace_id = $1 order by domain`, [t.wsA])).rows;
  const notes = async () => (await t.db.query(`select title, severity, slack_status from notifications where workspace_id = $1 and event = 'system_alert' order by created_at`, [t.wsA])).rows;
  const due = () => t.db.query(`update workspaces set deliverability_checked_at = null where id = $1`, [t.wsA]);

  beforeAll(async () => {
    t = await startTestDb(55448);
    for (const [tool, secret] of [['instantly', { api_key: 'inst-A' }], ['slack', { bot_token: 'xoxb-D' }]] as const) {
      await asUser(t.db, USERS.ownerA, (tx: any) => tx.query('select integration_connect($1, $2, $3::jsonb)', [t.wsA, tool, JSON.stringify(secret)]));
    }
    await t.db.query(`update workspaces set slack_channel = '#sales' where id = $1`, [t.wsA]);
    await t.db.query(`insert into campaigns (workspace_id, name, niche, sending_accounts) values ($1, 'Austin', 'dentists', '["sam@acme.com", "Sam@ACME.com", "jo@outreach-acme.io"]'::jsonb)`, [t.wsA]);
    await t.db.query(`insert into campaigns (workspace_id, name, niche, sending_accounts, status) values ($1, 'Old', 'x', '["x@archived.io"]'::jsonb, 'archived')`, [t.wsA]);
  });
  afterAll(async () => t?.close());

  test('DLR-01 the first check stores mailboxes and domains and reports set-up failures', async () => {
    accounts = [
      { email: 'sam@acme.com', status: 1, warmup_status: 1, stat_warmup_score: 97, daily_limit: 30, provider_code: 2 },
      { email: 'lee@acme.com', status: -1, warmup_status: 1, stat_warmup_score: 90, provider_code: 2 },
    ];
    const f = apis();
    const s = await runDeliverability(deps(f), t.wsA, '2026-11-17');
    expect(s).toMatchObject({ ran: true, mailboxes: 2, domains: 2, skipped: [] });
    const rows = await domains();
    // The archived campaign's domain is not checked
    expect(rows.map((r: any) => r.domain)).toEqual(['acme.com', 'outreach-acme.io']);
    expect(rows[0]).toMatchObject({ spf_status: 'pass', dkim_status: 'pass', dmarc_status: 'pass', score: 100 });
    expect(rows[1]).toMatchObject({ spf_status: 'fail', dmarc_status: 'fail', mx_status: 'fail', dkim_status: 'warn' });
    expect((await t.db.query(`select email, status, provider from mailboxes where workspace_id = $1 order by email`, [t.wsA])).rows)
      .toEqual([{ email: 'lee@acme.com', status: 'connection_error', provider: 'google' }, { email: 'sam@acme.com', status: 'active', provider: 'google' }]);
    expect(await notes()).toEqual([
      { title: 'Mailbox needs attention: lee@acme.com', severity: 'critical', slack_status: 'sent' },
      { title: 'Domain set-up problem: outreach-acme.io', severity: 'warning', slack_status: 'sent' },
    ]);
    const slack = f.calls.filter((c) => /slack/.test(c.url)).map((c) => JSON.parse(String(c.init.body)).text as string);
    expect(slack[1]).toContain('No SPF record; No DMARC record; No MX record');
    expect(slack[1]).toContain('<https://app.example.com/w/');
  });

  test('DLR-02 within a day nothing runs again; the next day unchanged problems are not repeated', async () => {
    const f = apis();
    expect((await runDeliverability(deps(f), t.wsA, '2026-11-17')).ran).toBe(false);
    expect(f.calls).toHaveLength(0);
    await due();
    const s = await runDeliverability(deps(f), t.wsA, '2026-11-18');
    expect(s).toMatchObject({ ran: true, alerts: 0 });
    expect(await notes()).toHaveLength(2);
  });

  test('DLR-03 a new blocklisting is critical; a newly failing mailbox is reported once', async () => {
    zone['A acme.com.dbl.spamhaus.org'] = ['127.0.1.2'];
    accounts[0] = { ...accounts[0], warmup_status: -1 };
    await due();
    const s = await runDeliverability(deps(apis()), t.wsA, '2026-11-19');
    expect(s.alerts).toBe(2);
    const n = (await notes()).slice(2);
    expect(n).toEqual([
      { title: 'Mailbox needs attention: sam@acme.com', severity: 'critical', slack_status: 'sent' },
      { title: 'Domain blocklisted: acme.com', severity: 'critical', slack_status: 'sent' },
    ]);
    expect((await domains())[0].score).toBe(75);
    delete zone['A acme.com.dbl.spamhaus.org'];
  });

  test('DLR-04 the team\'s own DKIM selector is used, and a removed mailbox and domain disappear', async () => {
    await t.db.query(`update sending_domains set dkim_selector = 'mx2026' where workspace_id = $1 and domain = 'acme.com'`, [t.wsA]);
    zone['TXT mx2026._domainkey.acme.com'] = ['v=DKIM1; p=MIIB'];
    accounts = [accounts[0]];
    await t.db.query(`update campaigns set sending_accounts = '["sam@acme.com"]'::jsonb where workspace_id = $1 and name = 'Austin'`, [t.wsA]);
    await due();
    await runDeliverability(deps(apis()), t.wsA, '2026-11-20');
    const rows = await domains();
    expect(rows.map((r: any) => r.domain)).toEqual(['acme.com']);
    expect((await t.db.query(`select dkim_found from sending_domains where workspace_id = $1`, [t.wsA])).rows[0].dkim_found).toEqual(['mx2026', 'google']);
    expect((await t.db.query(`select email from mailboxes where workspace_id = $1`, [t.wsA])).rows).toEqual([{ email: 'sam@acme.com' }]);
  });

  test('DLR-05 Instantly rejecting the key flags it, keeps the stored mailboxes, and still checks domains', async () => {
    instantlyStatus = 401;
    await due();
    const s = await runDeliverability(deps(apis()), t.wsA, '2026-11-21');
    expect(s).toMatchObject({ ran: true, domains: 1, mailboxes: 0 });
    expect(s.skipped[0]).toMatch(/^Mailboxes not read: /);
    expect((await t.db.query(`select status from integrations where workspace_id = $1 and tool = 'instantly'`, [t.wsA])).rows[0].status).toBe('error');
    expect((await t.db.query(`select count(*)::int as n from mailboxes where workspace_id = $1`, [t.wsA])).rows[0].n).toBe(1);
    instantlyStatus = 200;
  });

  test('DLR-06 the monitoring sweep runs it, and a failure there never stops the sweep', async () => {
    await due();
    const f = apis();
    const broken: Deps = { ...deps(f), dns: { txt: () => { throw new Error('boom'); }, mx: () => { throw new Error('boom'); }, a: () => { throw new Error('boom'); } } as unknown as Dns };
    const s = await monitorWorkspace(broken, t.wsA, new Date('2026-11-22T03:00:00Z'));
    expect(s).toMatchObject({ deliverability_alerts: 0 });
    // Every lookup failed: the domain is "unknown" everywhere, and nothing was raised as a fail
    expect((await domains())[0]).toMatchObject({ spf_status: 'unknown', dmarc_status: 'unknown', mx_status: 'unknown', score: 100 });
  });

  test('DLR-07 per-mailbox statistics come from Instantly\'s own events', async () => {
    let k = 0;
    const ev = (type: string, account: string | null, days = 1) => t.db.query(
      `insert into inbound_events (workspace_id, provider, event_type, lead_email, payload, received_at, dedupe_key) values ($1, 'instantly', $2, 'l@x.com', $3::jsonb, now() - make_interval(days => $4), $5)`,
      [t.wsA, type, JSON.stringify(account ? { email_account: account } : {}), days, `dlr-${k++}`]);
    for (let i = 0; i < 4; i++) await ev('email_sent', 'Sam@acme.com');
    await ev('email_bounced', 'sam@acme.com');
    await ev('reply_received', 'sam@acme.com');
    await ev('email_sent', null);
    await ev('email_sent', 'sam@acme.com', 45);
    const rows = (await asUser(t.db, USERS.viewerA, (tx: any) => tx.query(`select * from mailbox_stats($1, 30)`, [t.wsA]))).rows;
    expect(rows.map((r: any) => [r.email_account, Number(r.sent), Number(r.bounced), Number(r.replied)])).toEqual([['sam@acme.com', 4, 1, 1], ['', 1, 0, 0]]);
  });
});
