// End to end: enrichment job on the real migrations, third-party APIs faked.

import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import { startTestDb, fakeFetch, asUser, USERS, type TestDb } from './harness.ts';
import { runQueuedJobs as runJobs, type Deps } from '../src/jobs.ts';
import { MODEL_PLAN } from './fixtures.ts';

let t: TestDb;
const models = { openai: 'o', anthropic: null, gemini: 'g' };
const resolve = async () => ['93.184.216.34'];

const connect = (ws: string, user: string, tool: string, secret: object) =>
  asUser(t.db, user, (tx: any) => tx.query('select integration_connect($1, $2, $3::jsonb)', [ws, tool, JSON.stringify(secret)]));

beforeAll(async () => {
  t = await startTestDb(55433);
  await connect(t.wsA, USERS.ownerA, 'apollo', { api_key: 'apollo-A' });
  await connect(t.wsA, USERS.ownerA, 'zerobounce', { api_key: 'zb-A' });
  await connect(t.wsA, USERS.ownerA, 'twilio', { account_sid: 'AC-A', auth_token: 'tw-A' });
});
afterAll(async () => t?.close());

async function campaign(ws: string, over: { limit?: number; status?: string } = {}) {
  const { rows } = await t.db.query(
    `insert into campaigns (workspace_id, name, niche, target_areas, daily_lead_limit, status, icp, source_plan)
     values ($1, 'Austin dentists', 'dental clinics', '["Austin, Texas"]', $2, $3, $4::jsonb, $5::jsonb) returning id`,
    [ws, over.limit ?? 100, over.status ?? 'draft', JSON.stringify(MODEL_PLAN.icp), JSON.stringify(MODEL_PLAN.sources)]);
  return rows[0].id as string;
}
const company = async (ws: string, c: string, name: string, domain: string | null) =>
  (await t.db.query(`insert into companies (workspace_id, name, domain, campaign_id, source_channel) values ($1,$2,$3,$4,'llm_search') returning id`, [ws, name, domain, c])).rows[0].id as string;
const lead = async (ws: string, c: string, email: string | null, phone: string | null) =>
  (await t.db.query(`insert into leads (workspace_id, campaign_id, email, phone, source_channel) values ($1,$2,$3,$4,'google_maps') returning id`, [ws, c, email, phone])).rows[0].id as string;
const queue = (ws: string, c: string) => t.db.query(`insert into agent_jobs (workspace_id, campaign_id, type) values ($1, $2, 'enrichment')`, [ws, c]);
const lastJob = async (c: string) => (await t.db.query(`select * from agent_jobs where campaign_id = $1 and type = 'enrichment' order by created_at desc limit 1`, [c])).rows[0];

const html = (body: string) => new Response(body, { headers: { 'content-type': 'text/html' } });
const ZB: Record<string, string> = { 'ok@smile1.com': 'valid', 'bad@smile1.com': 'invalid', 'all@smile1.com': 'catch-all', 'kim@brightteeth.com': 'valid', 'hello@quietclinic.com': 'unknown' };

function apis(over: { zerobounce?: () => unknown } = {}) {
  return fakeFetch([
    // Verification first: their URLs contain the email being checked
    [/zerobounce/, over.zerobounce ?? ((u) => ({ status: ZB[new URL(u).searchParams.get('email')!] ?? 'unknown' }))],
    [/lookups\.twilio\.com/, (u) => (u.includes('%2B1512555') ? { valid: true, phone_number: decodeURIComponent(u.split('PhoneNumbers/')[1].split('?')[0]), country_code: 'US', line_type_intelligence: { type: u.includes('0177') ? 'landline' : 'mobile' } } : new Response('{}', { status: 404 }))],
    [/api_search/, () => ({ people: [{ id: 'p1' }] })],
    [/bulk_match/, () => ({ matches: [{ id: 'p1', name: 'KIM BRIGHT', title: 'Practice Owner', email: 'kim@brightteeth.com', organization: { name: 'Bright Teeth', primary_domain: 'brightteeth.com' } }] })],
    [/organizations\/enrich/, (u) => (u.includes('brightteeth') ? { organization: { industry: 'Dentistry', estimated_num_employees: 9, city: 'Austin' } } : {})],
    [/quietclinic\.com\/contact$/, () => html('<a href="mailto:hello@quietclinic.com">Email</a> <a href="tel:+15125550177">Call</a>')],
    [/quietclinic\.com/, () => html('<h1>Quiet Clinic</h1>')],
    [/nocontact\.com/, () => html('<h1>No contacts here</h1>')],
    [/(clinic\d+)\.com\/contact$/, (u) => html(`<a href="mailto:hello@${u.match(/(clinic\d+)\.com/)![1]}.com">Mail</a>`)],
    [/clinic\d+\.com/, () => html('<h1>Clinic</h1>')],
  ]);
}
// Enrichment hands over to research (tested in research.test.ts); drop that follow-up here
async function runQueuedJobs(d: Deps, limit: number) {
  const out = await runJobs(d, limit);
  await t.db.query(`delete from agent_jobs where type = 'research' and status = 'queued'`);
  return out;
}
const deps = (f = apis(), extra: Partial<Deps> = {}): Deps => ({ store: t.store, models, fetchImpl: f.impl, resolve, ...extra });

describe('enrichment job', () => {
  let c: string;
  let ids: Record<string, string>;
  let f: ReturnType<typeof apis>;

  beforeAll(async () => {
    c = await campaign(t.wsA);
    ids = {
      bright: await company(t.wsA, c, 'Bright Teeth', 'brightteeth.com'),
      quiet: await company(t.wsA, c, 'Quiet Clinic', 'quietclinic.com'),
      none: await company(t.wsA, c, 'No Contact Dental', 'nocontact.com'),
      nodomain: await company(t.wsA, c, 'Mystery Dental', null),
      ok: await lead(t.wsA, c, 'ok@smile1.com', '+15125550101'),
      bad: await lead(t.wsA, c, 'bad@smile1.com', '5125550102'),
      all: await lead(t.wsA, c, 'all@smile1.com', null),
    };
    await queue(t.wsA, c);
    f = apis();
    await runQueuedJobs(deps(f), 5);
  });

  test('EN-01 Apollo finds a named decision maker for a company found without contacts', async () => {
    const { rows } = await t.db.query(`select full_name, title, email, source_channel, source_query, company_id from leads where company_id = $1`, [ids.bright]);
    expect(rows).toEqual([{ full_name: 'Kim Bright', title: 'Practice Owner', email: 'kim@brightteeth.com', source_channel: 'llm_search', source_query: 'Apollo decision maker at brightteeth.com', company_id: ids.bright }]);
    const co = (await t.db.query(`select enrichment_status, industry, size_band from companies where id = $1`, [ids.bright])).rows[0];
    expect(co).toEqual({ enrichment_status: 'enriched', industry: 'Dentistry', size_band: '9' });
  });

  test('EN-02 the company website gives a contact when Apollo has no one', async () => {
    const { rows } = await t.db.query(`select email, phone, source_query from leads where company_id = $1`, [ids.quiet]);
    expect(rows).toEqual([{ email: 'hello@quietclinic.com', phone: '+15125550177', source_query: 'Company website quietclinic.com' }]);
  });

  test('EN-03 companies with nothing to find are marked so they are not retried', async () => {
    const { rows } = await t.db.query(`select id, enrichment_status from companies where campaign_id = $1`, [c]);
    const status = Object.fromEntries(rows.map((r: any) => [r.id, r.enrichment_status]));
    expect([status[ids.none], status[ids.nodomain], status[ids.quiet]]).toEqual(['no_contact_found', 'skipped', 'enriched']);
  });

  test('EN-04 every email is verified, including new ones, and logged on the timeline', async () => {
    const { rows } = await t.db.query(`select email, verification_status, email_checked_at is not null as checked from leads where campaign_id = $1 order by email`, [c]);
    expect(rows.map((r: any) => [r.email, r.verification_status, r.checked])).toEqual([
      ['all@smile1.com', 'catch_all', true], ['bad@smile1.com', 'invalid', true], ['hello@quietclinic.com', 'risky', true],
      ['kim@brightteeth.com', 'valid', true], ['ok@smile1.com', 'valid', true],
    ]);
    const note = (await t.db.query(`select summary from activities where lead_id = $1 and channel = 'email'`, [ids.bad])).rows;
    expect(note).toEqual([{ summary: 'Email checked: invalid (invalid)' }]);
  });

  test('EN-05 phones get their line type and country; numbers without a country code are marked unknown', async () => {
    const r = async (id: string) => (await t.db.query(`select phone, phone_line_type, phone_country, phone_checked_at is not null as checked from leads where id = $1`, [id])).rows[0];
    expect(await r(ids.ok)).toEqual({ phone: '+15125550101', phone_line_type: 'mobile', phone_country: 'US', checked: true });
    expect(await r(ids.bad)).toEqual({ phone: '5125550102', phone_line_type: 'unknown', phone_country: null, checked: true });
    const quietLead = (await t.db.query(`select phone_line_type from leads where company_id = $1`, [ids.quiet])).rows[0];
    expect(quietLead.phone_line_type).toBe('landline');
    expect(f.calls.filter((x) => /twilio/.test(x.url)).every((x) => (x.init.headers as Record<string, string>).Authorization === `Basic ${Buffer.from('AC-A:tw-A').toString('base64')}`)).toBe(true);
  });

  test('EN-06 the job result counts each step', async () => {
    const j = await lastJob(c);
    expect(j.status).toBe('succeeded');
    expect(j.result).toMatchObject({
      companies: { checked: 4, leads_added: 2, no_contact: 1 },
      emails: { checked: 5, valid: 2, invalid: 1, catch_all: 1, risky: 1 },
      phones: { checked: 3, mobile: 1, landline: 1, unknown: 1 },
      apollo_credits_used: 1,
    });
  });

  test('EN-07 a second run checks nothing twice', async () => {
    const again = apis();
    await queue(t.wsA, c);
    await runQueuedJobs(deps(again), 5);
    expect(again.calls.filter((x) => /zerobounce|twilio|bulk_match/.test(x.url))).toHaveLength(0);
    expect((await lastJob(c)).result).toMatchObject({ companies: { checked: 0 }, emails: { checked: 0 }, phones: { checked: 0 } });
  });
});

describe('enrichment edge cases', () => {
  test('EN-08 ZeroBounce out of credits stops verification and flags the tool, without failing the job', async () => {
    const c = await campaign(t.wsA);
    for (const e of ['a1@x1.com', 'a2@x1.com', 'a3@x1.com']) await lead(t.wsA, c, e, null);
    await queue(t.wsA, c);
    await runQueuedJobs(deps(apis({ zerobounce: () => ({ error: 'You have run out of credits' }) })), 5);
    const j = await lastJob(c);
    expect(j.status).toBe('succeeded');
    expect(j.result.emails).toMatchObject({ checked: 0, error: 'ZeroBounce reports the account is out of credits or needs a plan upgrade' });
    expect((await t.db.query(`select status from integrations where workspace_id = $1 and tool = 'zerobounce'`, [t.wsA])).rows[0].status).toBe('error');
    expect((await t.db.query(`select count(*)::int n from leads where campaign_id = $1 and verification_status = 'unverified'`, [c])).rows[0].n).toBe(3);
    await t.db.query(`update integrations set status = 'connected', last_error = null where workspace_id = $1 and tool = 'zerobounce'`, [t.wsA]);
  });

  test('EN-09 without the tools the agent explains what to connect and changes nothing', async () => {
    const c = await campaign(t.wsB);
    const co = await company(t.wsB, c, 'Lonely Dental', null);
    await lead(t.wsB, c, 'x@lonely.com', '+15125550111');
    await queue(t.wsB, c);
    const f = apis();
    await runQueuedJobs(deps(f), 5);
    const j = await lastJob(c);
    expect(j.status).toBe('succeeded');
    expect(j.result.notes).toEqual([
      'Connect Apollo to find named decision makers; the agent used company websites only.',
      'Connect ZeroBounce to verify emails before any email is sent.',
      'Connect Twilio to check phone line types before calls and SMS.',
    ]);
    expect(f.calls.filter((x) => /apollo|zerobounce|twilio/.test(x.url))).toHaveLength(0);
    expect((await t.db.query(`select enrichment_status from companies where id = $1`, [co])).rows[0].enrichment_status).toBe('skipped');
  });

  test('EN-10 switched-off channels are not verified', async () => {
    const c = await campaign(t.wsA);
    const id = await lead(t.wsA, c, 'off@x2.com', '+15125550112');
    await t.db.query(`update workspaces set enabled_channels = '{"email": false, "voice": false, "sms": false, "whatsapp": false, "linkedin": false}' where id = $1`, [t.wsA]);
    await queue(t.wsA, c);
    const f = apis();
    await runQueuedJobs(deps(f), 5);
    await t.db.query(`update workspaces set enabled_channels = '{"email": true, "voice": true, "sms": true, "whatsapp": true, "linkedin": false}' where id = $1`, [t.wsA]);
    expect(f.calls.filter((x) => /zerobounce|twilio/.test(x.url))).toHaveLength(0);
    expect((await t.db.query(`select email_checked_at, phone_checked_at from leads where id = $1`, [id])).rows[0]).toEqual({ email_checked_at: null, phone_checked_at: null });
    expect((await lastJob(c)).result.notes).toContain('Email is switched off, so emails were not verified.');
  });

  test('EN-11 suppressed contacts and the daily limit apply to enrichment leads too', async () => {
    const c = await campaign(t.wsA, { limit: 2 });
    for (const n of [1, 2, 3, 4]) await company(t.wsA, c, `Clinic ${n}`, `clinic${n}.com`);
    await t.db.query(`insert into suppressions (workspace_id, kind, value, reason) values ($1, 'email', 'hello@clinic1.com', 'customer')`, [t.wsA]);
    await queue(t.wsA, c);
    await runQueuedJobs(deps(), 5);
    const emails = (await t.db.query(`select email from leads where campaign_id = $1 order by email`, [c])).rows.map((r: any) => r.email);
    expect(emails).toEqual(['hello@clinic2.com', 'hello@clinic3.com']);
    const status = (await t.db.query(`select domain, enrichment_status from companies where campaign_id = $1 order by domain`, [c])).rows;
    // Suppressed: skipped. Over the limit: still pending for tomorrow.
    expect(status.map((r: any) => r.enrichment_status)).toEqual(['skipped', 'enriched', 'enriched', 'pending']);
    await t.db.query(`delete from suppressions where workspace_id = $1`, [t.wsA]);
  });

  test('EN-12 the daily schedule queues every stage for active campaigns', async () => {
    const c = await campaign(t.wsB, { status: 'active' });
    await runJobs(deps(apis(), { scheduleHours: 24 }), 1);
    const { rows } = await t.db.query(`select type from agent_jobs where campaign_id = $1 order by type`, [c]);
    expect(rows.map((r: any) => r.type)).toEqual(['copywriting', 'enrichment', 'lead_sourcing', 'research']);
    await t.db.query(`delete from agent_jobs where campaign_id = $1`, [c]);
    await t.db.query(`update campaigns set status = 'paused' where id = $1`, [c]);
  });

  test('EN-13 results, logs and timeline never contain a credential', async () => {
    const dump = JSON.stringify([
      (await t.db.query('select result, error from agent_jobs')).rows,
      (await t.db.query('select summary from activities')).rows,
      (await t.db.query('select last_error from integrations')).rows,
    ]);
    expect(dump).not.toMatch(/apollo-A|zb-A|tw-A|AC-A/);
  });
});
