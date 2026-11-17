import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import { identify, lookupIp } from '../src/sources/ipapi.ts';
import { identifyVisits, ipKey, isOwn, isoWeek } from '../src/visitors.ts';
import type { Deps } from '../src/jobs.ts';
import { startTestDb, fakeFetch, asUser, USERS, type TestDb } from './harness.ts';

const biz = (over: Record<string, unknown> = {}) => ({
  ip: '203.0.113.7', is_bogon: false, is_mobile: false, is_satellite: false, is_crawler: false, is_datacenter: false, is_tor: false,
  is_proxy: false, is_vpn: false, company: { name: 'Bright Dental LLC', domain: 'www.Bright.test', type: 'business' },
  asn: { type: 'isp' }, location: { country_code: 'us' }, ...over,
});

describe('which networks name a company', () => {
  test('VID-01 a business network names the company, its domain and country', () => {
    expect(identify(biz())).toEqual({ company: { domain: 'bright.test', name: 'Bright Dental LLC', country: 'US' } });
    expect(identify(biz({ company: { name: 'State Uni', domain: 'uni.edu', type: 'education' } }))).toMatchObject({ company: { domain: 'uni.edu' } });
  });

  test('VID-02 anything that could be a person at home, on a phone, behind a VPN, or a bot is discarded', () => {
    expect(identify(biz({ is_vpn: true }))).toEqual({ skip: 'VPN or proxy' });
    expect(identify(biz({ is_tor: true }))).toEqual({ skip: 'VPN or proxy' });
    expect(identify(biz({ is_mobile: true }))).toEqual({ skip: 'mobile network' });
    expect(identify(biz({ is_datacenter: true }))).toEqual({ skip: 'data centre' });
    expect(identify(biz({ is_crawler: true }))).toEqual({ skip: 'crawler' });
    expect(identify(biz({ is_bogon: true }))).toEqual({ skip: 'private network' });
    expect(identify(biz({ company: { name: 'Comcast', domain: 'comcast.net', type: 'isp' } }))).toEqual({ skip: 'home or office internet provider' });
    expect(identify(biz({ company: { name: 'AWS', domain: 'amazon.com', type: 'hosting' } }))).toEqual({ skip: 'data centre' });
    expect(identify(biz({ company: { name: 'X', type: 'business' } }))).toEqual({ skip: 'no company domain' });
    expect(identify(biz({ company: { name: 'X', domain: 'not a domain', type: 'business' } }))).toEqual({ skip: 'no company domain' });
    expect(identify({})).toEqual({ skip: 'no organisation' });
  });

  test('VID-03 the lookup is the documented POST with the key in the body, and a bad key or used-up quota is an error', async () => {
    const f = fakeFetch([[/api\.ipapi\.is/, () => biz()]]);
    await lookupIp('k-123', '203.0.113.7', f.impl);
    expect(f.calls[0].url).toBe('https://api.ipapi.is');
    expect(f.calls[0].init.method).toBe('POST');
    expect(JSON.parse(String(f.calls[0].init.body))).toEqual({ q: '203.0.113.7', key: 'k-123' });
    await expect(lookupIp('bad', '1.1.1.1', fakeFetch([[/ipapi/, () => new Response('{"error_code":"ERR_FORBIDDEN_INVALID_API_KEY"}', { status: 403 })]]).impl)).rejects.toMatchObject({ status: 403 });
    await expect(lookupIp('k', '1.1.1.1', fakeFetch([[/ipapi/, () => new Response('{"error_code":"ERR_QUOTA_EXCEEDED"}', { status: 429 })]]).impl)).rejects.toMatchObject({ status: 429 });
  });

  test('VID-04 helpers: the cache key, the week, the team\'s own domain', () => {
    expect(ipKey(' 203.0.113.7 ')).toBe(ipKey('203.0.113.7'));
    expect(ipKey('203.0.113.7')).toMatch(/^[0-9a-f]{64}$/);
    expect(isoWeek(new Date('2026-11-17T12:00:00Z'))).toBe('2026-W47');
    expect(isoWeek(new Date('2027-01-01T00:00:00Z'))).toBe('2026-W53');
    expect(isOwn('acme.com', ['acme.com'])).toBe(true);
    expect(isOwn('acme.com', ['www.acme.com'])).toBe(true);
    expect(isOwn('bright.test', ['acme.com'])).toBe(false);
  });
});

describe('identifying visits', () => {
  let t: TestDb;
  let keyA = '';
  let lookups = 0;
  let mode: 'ok' | 'quota' | 'badkey' = 'ok';
  const answers: Record<string, unknown> = {
    '203.0.113.7': biz(),
    '198.51.100.20': biz({ company: { name: 'Comcast', domain: 'comcast.net', type: 'isp' } }),
    '192.0.2.50': biz({ company: { name: 'Acme', domain: 'acme.com', type: 'business' } }),
    '192.0.2.99': biz({ company: { name: 'Northwind', domain: 'northwind.test', type: 'business' } }),
  };
  const apis = () => fakeFetch([[/api\.ipapi\.is/, (_url, init) => {
    lookups++;
    if (mode === 'quota') return new Response('{"error_code":"ERR_QUOTA_EXCEEDED"}', { status: 429 });
    if (mode === 'badkey') return new Response('{"error_code":"ERR_FORBIDDEN_INVALID_API_KEY"}', { status: 403 });
    return answers[JSON.parse(String(init.body)).q] ?? {};
  }]]);
  const deps = (f: ReturnType<typeof apis>): Deps => ({ store: t.store, models: { openai: 'o', anthropic: null, gemini: 'g' }, fetchImpl: f.impl });
  const view = (ip: string, path = '/pricing') => t.db.query('select visit_record($1, $2, $3, $4, $5)', [keyA, ip, 'acme.com', path, null]);
  const signals = async () => (await t.db.query(`select kind, source, title, company_id from signals where workspace_id = $1`, [t.wsA])).rows;

  beforeAll(async () => {
    t = await startTestDb(55451);
    keyA = (await t.db.query(`update workspaces set visitor_tracking_enabled = true, visitor_allowed_hosts = '{acme.com}' where id = $1 returning visitor_site_key`, [t.wsA])).rows[0].visitor_site_key;
    await t.db.query(`insert into companies (workspace_id, name, domain) values ($1, 'Bright Dental', 'bright.test')`, [t.wsA]);
  });
  afterAll(async () => t?.close());

  test('VIDJ-01 without ipapi.is connected, views are skipped and their IPs erased', async () => {
    await view('203.0.113.7');
    const f = apis();
    expect(await identifyVisits(deps(f))).toMatchObject({ skipped: 1, identified: 0 });
    expect(f.calls).toHaveLength(0);
    expect((await t.db.query(`select ip, skip_reason from site_visits where workspace_id = $1`, [t.wsA])).rows).toEqual([{ ip: null, skip_reason: 'ipapi.is not connected' }]);
  });

  test('VIDJ-02 a known company visiting becomes one signal; an ISP and the team\'s own network are skipped', async () => {
    await asUser(t.db, USERS.ownerA, (tx: any) => tx.query('select integration_connect($1, $2, $3::jsonb)', [t.wsA, 'ipapi', JSON.stringify({ api_key: 'ipapi-key-123' })]));
    await view('203.0.113.7', '/pricing');
    await view('203.0.113.7', '/pricing');
    await view('203.0.113.7', '/case-studies');
    await view('198.51.100.20');
    await view('192.0.2.50');
    lookups = 0;
    const s = await identifyVisits(deps(apis()), 200, new Date('2026-11-17T12:00:00Z'));
    expect(s).toMatchObject({ identified: 3, skipped: 2, signals: 1 });
    // Three distinct networks, each looked up once
    expect(lookups).toBe(3);
    const v = (await t.db.query(`select company_domain, company_name, country_code, visits, top_paths, company_id is not null as matched from site_visitors where workspace_id = $1`, [t.wsA])).rows;
    expect(v).toEqual([{ company_domain: 'bright.test', company_name: 'Bright Dental', country_code: 'US', visits: 3, top_paths: { '/pricing': 2, '/case-studies': 1 }, matched: true }]);
    expect(await signals()).toEqual([expect.objectContaining({ kind: 'website_visit', source: 'visitor', title: 'Bright Dental visited your website' })]);
    const reasons = (await t.db.query(`select skip_reason from site_visits where workspace_id = $1 and status = 'skipped' order by skip_reason`, [t.wsA])).rows.map((r: any) => r.skip_reason);
    expect(reasons).toEqual(['home or office internet provider', 'ipapi.is not connected', 'your own team']);
    expect((await t.db.query(`select count(*)::int n from site_visits where ip is not null`)).rows[0].n).toBe(0);
  });

  test('VIDJ-03 the same network later is answered from the cache; one signal a week per company', async () => {
    await view('203.0.113.7', '/demo');
    lookups = 0;
    const s = await identifyVisits(deps(apis()), 200, new Date('2026-11-18T12:00:00Z'));
    expect(s).toMatchObject({ cached: 1, looked_up: 0, signals: 0 });
    expect(lookups).toBe(0);
    await t.db.query(`update site_visitors set last_signal_at = now() - interval '8 days' where workspace_id = $1`, [t.wsA]);
    await view('203.0.113.7', '/demo');
    expect((await identifyVisits(deps(apis()), 200, new Date('2026-11-25T12:00:00Z'))).signals).toBe(1);
    expect(await signals()).toHaveLength(2);
  });

  test('VIDJ-04 an unknown company is listed but raises no signal', async () => {
    await view('192.0.2.99');
    expect(await identifyVisits(deps(apis()))).toMatchObject({ identified: 1, signals: 0 });
    expect((await t.db.query(`select company_id from site_visitors where workspace_id = $1 and company_domain = 'northwind.test'`, [t.wsA])).rows).toEqual([{ company_id: null }]);
  });

  test('VIDJ-05 a used-up quota pauses lookups and keeps the views for later; a rejected key flags ipapi.is', async () => {
    await t.db.query('delete from ip_lookups');
    await view('203.0.113.7'); await view('192.0.2.99');
    mode = 'quota';
    expect(await identifyVisits(deps(apis()))).toMatchObject({ waiting: 2, identified: 0 });
    expect((await t.db.query(`select count(*)::int n from site_visits where status = 'pending' and ip is not null`)).rows[0].n).toBe(2);
    await t.db.query(`update site_visits set resolved_at = now() - interval '11 minutes' where status = 'pending'`);
    mode = 'badkey';
    await identifyVisits(deps(apis()));
    expect((await t.db.query(`select status from integrations where workspace_id = $1 and tool = 'ipapi'`, [t.wsA])).rows[0].status).toBe('expired');
    mode = 'ok';
  });
});
