import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import {
  DEFAULT_STAGES, pipedriveDeal, pipedrivePerson, plainNote, salesforceContact, salesforceOpportunity, stageMap, noteBody,
  type CrmDeal, type CrmLead,
} from '../src/crm.ts';
import { findPerson, pipedriveTime, readDealStatuses, upsertPerson } from '../src/sources/pipedrive.ts';
import {
  createOpportunity, createRecords, defaultCloseDate, getToken, readOutcomes, salesforceHost, soqlString, upsertContacts, API_VERSION,
} from '../src/sources/salesforce.ts';
import { ProviderError } from '../src/http.ts';
import { runQueuedJobs, type Deps } from '../src/jobs.ts';
import { startTestDb, fakeFetch, asUser, USERS, type TestDb } from './harness.ts';

const lead = (over: Partial<CrmLead> = {}): CrmLead => ({
  id: 'l', email: 'kim@bright.test', full_name: 'Kim Lee Park', phone: '+15125550100', title: 'Owner', stage: 'interested',
  company: 'Bright Dental', domain: 'bright.test', score: 80, linkedin_url: null, ...over,
});
const deal = (over: Partial<CrmDeal> = {}): CrmDeal => ({
  id: 'd', lead_id: 'l', stage: 'proposal_sent', value_cents: 149900, currency: 'usd', lead_name: 'Kim Lee', company: 'Bright Dental',
  plan_name: 'Growth', closed_at: null, ...over,
});
const body = (init: RequestInit) => (init.body ? JSON.parse(String(init.body)) : undefined);

describe('mapping per CRM', () => {
  test('CRP-01 stage maps: Pipedrive takes stage numbers only; Salesforce takes stage names', () => {
    expect(stageMap({ meeting_booked: '7', negotiation: 'closedwon' }, 'pipedrive')).toMatchObject({ meeting_booked: '7', negotiation: '' });
    expect(stageMap({ proposal_sent: 'Proposal Sent (custom)', won: 'x"><script>' }, 'salesforce'))
      .toMatchObject({ proposal_sent: 'Proposal Sent (custom)', won: 'Closed Won' });
    expect(stageMap({}, 'salesforce')).toEqual(DEFAULT_STAGES.salesforce);
    expect(stageMap({ won: 'my won' }, 'hubspot').won).toBe('closedwon');
  });

  test('CRP-02 a Pipedrive person and deal: won and lost are the deal status, open deals use the mapped stage', () => {
    expect(pipedrivePerson(lead(), 'kim@bright.test')).toEqual({ name: 'Kim Lee Park', email: 'kim@bright.test', phone: '+15125550100', job_title: 'Owner' });
    expect(pipedrivePerson(lead({ full_name: null }), 'kim@bright.test').name).toBe('kim@bright.test');
    const s = { pipeline_id: '3', map: stageMap({ proposal_sent: '12' }, 'pipedrive') };
    expect(pipedriveDeal(deal(), s)).toEqual({ title: 'Bright Dental: Growth', value: 1499, currency: 'USD', status: 'open', pipeline_id: 3, stage_id: 12 });
    expect(pipedriveDeal(deal({ stage: 'won' }), s)).toMatchObject({ status: 'won', stage_id: null });
    expect(pipedriveDeal(deal({ stage: 'negotiation' }), { pipeline_id: 'default', map: s.map })).toMatchObject({ status: 'open', pipeline_id: null, stage_id: null });
  });

  test('CRP-03 a Salesforce contact always has a last name; an open opportunity has no close date to drift', () => {
    expect(salesforceContact(lead(), 'kim@bright.test')).toEqual({ FirstName: 'Kim', LastName: 'Lee Park', Email: 'kim@bright.test', Phone: '+15125550100', Title: 'Owner' });
    expect(salesforceContact(lead({ full_name: 'Cher', phone: null, title: null }), 'c@x.test')).toEqual({ LastName: 'Cher', Email: 'c@x.test' });
    expect(salesforceContact(lead({ full_name: null }), 'info@x.test').LastName).toBe('info');
    const s = { pipeline_id: 'default', map: stageMap({}, 'salesforce') };
    expect(salesforceOpportunity(deal(), s)).toEqual({ Name: 'Bright Dental: Growth', StageName: 'Proposal/Price Quote', Amount: 1499 });
    expect(salesforceOpportunity(deal({ stage: 'won', closed_at: new Date('2026-11-20T15:00:00Z') }), s)).toMatchObject({ StageName: 'Closed Won', CloseDate: '2026-11-20' });
    expect(defaultCloseDate(new Date('2026-11-17T00:00:00Z'))).toBe('2026-12-17');
  });

  test('CRP-04 Salesforce task text is plain, with what the lead wrote kept literally', () => {
    const html = noteBody({ id: 'a', lead_id: 'l', kind: 'reply', at: new Date(), detail: { channel: 'email', classification: 'interested', body: 'Use <b>&</b> me' } });
    expect(plainNote(html)).toBe('Reply by email (interested)\nUse <b>&</b> me\nLogged by the AI SDR platform');
  });

  test('CRP-05 SOQL literals cannot be broken out of', () => {
    expect(soqlString("o'brien@x.test")).toBe("'o\\'brien@x.test'");
    expect(soqlString('a\\b')).toBe("'a\\\\b'");
  });

  test('CRP-06 only Salesforce My Domain hosts are accepted', () => {
    expect(salesforceHost('https://Acme.my.salesforce.com/')).toBe('acme.my.salesforce.com');
    expect(salesforceHost('acme--uat.sandbox.my.salesforce.com')).toBe('acme--uat.sandbox.my.salesforce.com');
    expect(salesforceHost('acme.lightning.force.com')).toBeNull();
    expect(salesforceHost('evil.com/acme.my.salesforce.com')).toBeNull();
    expect(salesforceHost('acme.my.salesforce.com.evil.com')).toBeNull();
    expect(pipedriveTime(new Date('2026-11-17T09:05:03.120Z'))).toBe('2026-11-17 09:05:03');
  });
});

describe('Pipedrive client', () => {
  test('CRP-07 a person is found by exact email, updated without touching its emails, or created', async () => {
    const f = fakeFetch([
      [/\/persons\/search/, (url) => (new URL(url).searchParams.get('term') === 'kim@bright.test'
        ? { data: { items: [{ item: { id: 41, emails: ['Kim@Bright.test'] } }] } } : { data: { items: [{ item: { id: 9, emails: ['other@x.test'] } }] } })],
      [/\/persons\/41$/, () => ({ data: { id: 41 } })],
      [/\/api\/v2\/persons$/, () => ({ data: { id: 77 } })],
    ]);
    expect(await upsertPerson('tok', { name: 'Kim', email: 'kim@bright.test', phone: null, job_title: 'Owner' }, f.impl)).toBe('41');
    const patch = f.calls.find((c) => c.init.method === 'PATCH')!;
    expect(body(patch.init)).toEqual({ name: 'Kim', job_title: 'Owner' });
    expect(patch.init.headers).toMatchObject({ 'x-api-token': 'tok' });
    expect(f.calls[0].url).toBe('https://api.pipedrive.com/api/v2/persons/search?term=kim%40bright.test&fields=email&exact_match=true&limit=1');
    // A search hit with a different address is not trusted
    expect(await findPerson('tok', 'new@x.test', f.impl)).toBeNull();
    expect(await upsertPerson('tok', { name: 'New', email: 'new@x.test', phone: '+1', job_title: null }, f.impl)).toBe('77');
    expect(body(f.calls.at(-1)!.init)).toEqual({ name: 'New', emails: [{ value: 'new@x.test', primary: true, label: 'work' }], phones: [{ value: '+1', primary: true, label: 'work' }] });
    expect(f.calls.every((c) => !c.url.includes('tok'))).toBe(true);
  });

  test('CRP-08 deal statuses are read 100 at a time, ignoring bad ids', async () => {
    const f = fakeFetch([[/\/api\/v2\/deals\?/, (url) => ({ data: new URL(url).searchParams.get('ids')!.split(',').map((id) => ({ id: Number(id), status: id === '5' ? 'won' : 'open' })) })]]);
    const ids = [...Array.from({ length: 150 }, (_, i) => String(i + 1)), 'x1'];
    const r = await readDealStatuses('tok', ids, f.impl);
    expect(f.calls).toHaveLength(2);
    expect(r.size).toBe(150);
    expect(r.get('5')).toBe('won');
  });
});

describe('Salesforce client', () => {
  const auth = { host: 'acme.my.salesforce.com', token: 'sf-token' };

  test('CRP-09 sign-in uses the client credentials flow on the org\'s own host; bad credentials read as rejected', async () => {
    const f = fakeFetch([[/oauth2\/token/, () => ({ access_token: 'sf-token', instance_url: 'https://acme.my.salesforce.com', token_type: 'Bearer' })]]);
    expect(await getToken({ domain: 'acme.my.salesforce.com', client_id: 'cid', client_secret: 'sec' }, f.impl)).toEqual(auth);
    expect(f.calls[0].url).toBe('https://acme.my.salesforce.com/services/oauth2/token');
    expect(String(f.calls[0].init.body)).toBe('grant_type=client_credentials&client_id=cid&client_secret=sec');
    expect(f.calls[0].init.headers).toMatchObject({ 'Content-Type': 'application/x-www-form-urlencoded' });
    const bad = fakeFetch([[/oauth2/, () => new Response('{"error":"invalid_client"}', { status: 400 })]]);
    await expect(getToken({ domain: 'acme.my.salesforce.com', client_id: 'cid', client_secret: 'no' }, bad.impl)).rejects.toMatchObject({ status: 401 });
    const none = fakeFetch([]);
    await expect(getToken({ domain: 'https://evil.example', client_id: 'cid', client_secret: 'x' }, none.impl)).rejects.toBeInstanceOf(ProviderError);
    expect(none.calls).toHaveLength(0);
  });

  test('CRP-10 contacts: found by email with SOQL, existing ones updated, new ones created, failures left out', async () => {
    const f = fakeFetch([
      [/\/query\?q=/, () => ({ records: [{ Id: '003000000000001AAA', Email: 'Kim@Bright.test' }] })],
      [/\/composite\/sobjects$/, (_u, init) => (init.method === 'PATCH'
        ? [{ id: '003000000000001AAA', success: true, errors: [] }]
        : [{ id: '003000000000002AAA', success: true, errors: [] }, { success: false, errors: [{ statusCode: 'DUPLICATES_DETECTED', message: 'dup', fields: [] }] }])],
    ]);
    const r = await upsertContacts(auth, [
      { LastName: 'Lee', Email: 'kim@bright.test' }, { LastName: 'New', Email: 'new@x.test' }, { LastName: 'Dup', Email: 'dup@x.test' },
    ], f.impl);
    expect([...r.ids]).toEqual([['kim@bright.test', '003000000000001AAA'], ['new@x.test', '003000000000002AAA']]);
    expect(r.errors).toEqual(['DUPLICATES_DETECTED: dup']);
    const q = decodeURIComponent(new URL(f.calls[0].url).searchParams.get('q')!);
    expect(q).toBe("SELECT Id, Email FROM Contact WHERE Email IN ('kim@bright.test', 'new@x.test', 'dup@x.test') ORDER BY CreatedDate ASC");
    expect(f.calls[0].url.startsWith(`https://acme.my.salesforce.com/services/data/${API_VERSION}/query`)).toBe(true);
    const patch = body(f.calls.find((c) => c.init.method === 'PATCH')!.init);
    expect(patch).toEqual({ allOrNone: false, records: [{ attributes: { type: 'Contact' }, id: '003000000000001AAA', LastName: 'Lee' }] });
    const post = body(f.calls.find((c) => c.init.method === 'POST')!.init);
    expect(post.records[0]).toEqual({ attributes: { type: 'Contact' }, LastName: 'New', Email: 'new@x.test' });
    expect(f.calls[0].init.headers).toMatchObject({ Authorization: 'Bearer sf-token' });
  });

  test('CRP-11 a collection answer of the wrong length is an error, not a silent mismatch', async () => {
    const f = fakeFetch([[/composite/, () => [{ id: '003000000000002AAA', success: true }]]]);
    await expect(createRecords(auth, 'Contact', [{ LastName: 'a' }, { LastName: 'b' }], f.impl)).rejects.toThrow('unexpected response');
  });

  test('CRP-12 an opportunity gets a close date and a primary contact role; a failed role still returns the opportunity', async () => {
    const f = fakeFetch([
      [/\/sobjects\/Opportunity\/$/, () => ({ id: '006000000000001AAA', success: true })],
      [/\/sobjects\/OpportunityContactRole\/$/, () => new Response('[{"errorCode":"FIELD_INTEGRITY_EXCEPTION"}]', { status: 400 })],
    ]);
    const r = await createOpportunity(auth, { Name: 'X', StageName: 'Qualification' }, '003000000000001AAA', f.impl, new Date('2026-11-17T00:00:00Z'));
    expect(r.id).toBe('006000000000001AAA');
    expect(r.roleError).toBeTruthy();
    expect(body(f.calls[0].init)).toEqual({ Name: 'X', StageName: 'Qualification', CloseDate: '2026-12-17' });
    expect(body(f.calls[1].init)).toEqual({ OpportunityId: '006000000000001AAA', ContactId: '003000000000001AAA', IsPrimary: true });
  });

  test('CRP-13 outcomes come from IsWon and IsClosed, matched to 15- or 18-character ids', async () => {
    const f = fakeFetch([[/\/query/, () => ({ records: [
      { Id: '006000000000001AAA', IsWon: true, IsClosed: true }, { Id: '006000000000002AAA', IsWon: false, IsClosed: true },
      { Id: '006000000000003AAA', IsWon: false, IsClosed: false },
    ] })]]);
    const r = await readOutcomes(auth, ['006000000000001AAA', '006000000000002', '006000000000003AAA', "bad'id"], f.impl);
    expect([...r]).toEqual([['006000000000001AAA', 'won'], ['006000000000002', 'lost'], ['006000000000003AAA', 'open']]);
    expect(decodeURIComponent(f.calls[0].url)).not.toContain("bad'id");
  });
});

// ---------------------------------------------------------------- end to end

describe('sync with Pipedrive and Salesforce', () => {
  let t: TestDb;
  let c = '';
  let kim = '';
  let dealId = '';
  let pdStatus = 'open';
  let sfWon = false;
  let sfMode: 'ok' | 'badcreds' = 'ok';
  let n = 0;

  const apis = () => fakeFetch([
    [/api\.pipedrive\.com\/api\/v2\/persons\/search/, () => ({ data: { items: [] } })],
    [/api\.pipedrive\.com\/api\/v2\/persons$/, () => ({ data: { id: 300 } })],
    [/api\.pipedrive\.com\/api\/v2\/deals\?/, (url) => ({ data: new URL(url).searchParams.get('ids')!.split(',').map((id) => ({ id: Number(id), status: pdStatus })) })],
    [/api\.pipedrive\.com\/api\/v2\/deals(\/\d+)?$/, () => ({ data: { id: 400 } })],
    [/api\.pipedrive\.com\/v1\/notes$/, () => ({ data: { id: 500 + n++ } })],
    [/oauth2\/token/, () => (sfMode === 'ok' ? { access_token: 'sf-token' } : new Response('{"error":"invalid_client"}', { status: 400 }))],
    [/\/query\?q=SELECT%20Id%2C%20Email/, () => ({ records: [] })],
    [/\/query\?q=SELECT%20Id%2C%20IsWon/, () => ({ records: [{ Id: '006000000000001AAA', IsWon: sfWon, IsClosed: sfWon }] })],
    [/\/composite\/sobjects$/, (_u, init) => body(init).records.map(() => ({ id: '003000000000001AAA', success: true, errors: [] }))],
    [/\/sobjects\/Opportunity\/$/, () => ({ id: '006000000000001AAA', success: true })],
    [/\/sobjects\/Opportunity\/006/, () => new Response(null, { status: 204 })],
    [/\/sobjects\/OpportunityContactRole\/$/, () => ({ id: '00K000000000001AAA', success: true })],
    [/\/sobjects\/Task\/$/, () => ({ id: `00T00000000000${n++}AAA`.slice(0, 18), success: true })],
  ]);
  const deps = (f: ReturnType<typeof apis>): Deps => ({ store: t.store, models: { openai: 'o', anthropic: null, gemini: 'g' }, fetchImpl: f.impl });
  const run = async (f: ReturnType<typeof apis>) => {
    await t.db.query(`delete from agent_jobs where campaign_id = $1 and status = 'queued'`, [c]);
    await t.db.query(`insert into agent_jobs (workspace_id, campaign_id, type) values ($1, $2, 'crm_sync')`, [t.wsA, c]);
    await runQueuedJobs(deps(f), 1);
    return (await t.db.query(`select * from agent_jobs where campaign_id = $1 and type = 'crm_sync' order by created_at desc limit 1`, [c])).rows[0];
  };
  const links = async (provider: string) => (await t.db.query(
    `select record_type, external_id from crm_links where workspace_id = $1 and provider = $2 order by record_type, external_id`, [t.wsA, provider])).rows;
  const connect = (tool: string, secret: Record<string, string>) =>
    asUser(t.db, USERS.ownerA, (tx: any) => tx.query('select integration_connect($1, $2, $3::jsonb)', [t.wsA, tool, JSON.stringify(secret)]));

  beforeAll(async () => {
    t = await startTestDb(55449);
    c = (await t.db.query(`insert into campaigns (workspace_id, name, niche, status) values ($1, 'Austin', 'dentists', 'active') returning id`, [t.wsA])).rows[0].id;
    const co = (await t.db.query(`insert into companies (workspace_id, name, domain) values ($1, 'Bright Dental', 'bright.test') returning id`, [t.wsA])).rows[0].id;
    kim = (await t.db.query(`insert into leads (workspace_id, campaign_id, company_id, email, full_name, stage, source_channel)
      values ($1, $2, $3, 'kim@bright.test', 'Kim Lee', 'interested', 'apollo') returning id`, [t.wsA, c, co])).rows[0].id;
    dealId = (await t.db.query(`insert into deals (workspace_id, lead_id, campaign_id, stage, value_cents, plan_name) values ($1, $2, $3, 'proposal_sent', 149900, 'Growth') returning id`, [t.wsA, kim, c])).rows[0].id;
    await t.db.query(`insert into replies (workspace_id, lead_id, channel, body, classification) values ($1, $2, 'email', 'Tell me more', 'interested')`, [t.wsA, kim]);
    await t.db.query(`update workspaces set crm_sync_enabled = true, crm_provider = 'pipedrive', crm_pipeline_id = '2', crm_stage_map = '{"proposal_sent": "9"}' where id = $1`, [t.wsA]);
  });
  afterAll(async () => t?.close());

  test('CRPJ-01 Pipedrive not connected: nothing is sent, and the message names Pipedrive', async () => {
    const f = apis();
    expect((await run(f)).result).toEqual({ skipped: 'Pipedrive is not connected' });
    expect(f.calls).toHaveLength(0);
  });

  test('CRPJ-02 a person, a deal in the chosen pipeline and stage, and a note reach Pipedrive', async () => {
    await connect('pipedrive', { api_token: 'pd-token-0123456789' });
    const f = apis();
    const j = await run(f);
    expect(j.status).toBe('succeeded');
    expect(j.result).toMatchObject({ contacts_sent: 1, deals_created: 1, notes_created: 1 });
    const d = body(f.calls.find((x) => /\/api\/v2\/deals$/.test(x.url))!.init);
    expect(d).toEqual({ title: 'Bright Dental: Growth', status: 'open', currency: 'USD', value: 1499, pipeline_id: 2, stage_id: 9, person_id: 300 });
    const note = body(f.calls.find((x) => /\/v1\/notes$/.test(x.url))!.init);
    expect(note).toMatchObject({ person_id: 300 });
    expect(note.content).toContain('Tell me more');
    expect(await links('pipedrive')).toEqual([
      { record_type: 'activity', external_id: '500' }, { record_type: 'deal', external_id: '400' }, { record_type: 'lead', external_id: '300' },
    ]);
    expect(f.calls.every((x) => !x.url.includes('pd-token'))).toBe(true);
  });

  test('CRPJ-03 a second run sends nothing unchanged; a deal won in Pipedrive is won here', async () => {
    const f = apis();
    expect((await run(f)).result).toMatchObject({ contacts_sent: 0, deals_created: 0, deals_updated: 0, notes_created: 0, closed_from_crm: 0 });
    pdStatus = 'won';
    const j = await run(apis());
    expect(j.result).toMatchObject({ closed_from_crm: 1 });
    expect((await t.db.query(`select stage from deals where id = $1`, [dealId])).rows[0].stage).toBe('won');
    expect((await t.db.query(`select summary from activities where record_id = $1`, [dealId])).rows[0].summary).toBe('Marked won in Pipedrive');
    const n2 = (await t.db.query(`select title from notifications where workspace_id = $1 and event = 'deal_won'`, [t.wsA])).rows;
    expect(n2).toHaveLength(1);
  });

  test('CRPJ-04 switching to Salesforce starts clean and keeps the Pipedrive links', async () => {
    await t.db.query(`update deals set stage = 'negotiation', closed_at = null, updated_at = now() + interval '1 second' where id = $1`, [dealId]);
    await t.db.query(`update workspaces set crm_provider = 'salesforce', crm_pipeline_id = 'default', crm_stage_map = '{}' where id = $1`, [t.wsA]);
    await connect('salesforce', { domain: 'acme.my.salesforce.com', client_id: 'cid-0123456789', client_secret: 'sec-0123456789' });
    const f = apis();
    const j = await run(f);
    expect(j.status).toBe('succeeded');
    expect(j.result).toMatchObject({ contacts_sent: 1, deals_created: 1, notes_created: 1 });
    expect(f.calls.some((x) => /pipedrive/.test(x.url))).toBe(false);
    const opp = body(f.calls.find((x) => /\/sobjects\/Opportunity\/$/.test(x.url))!.init);
    expect(opp).toMatchObject({ Name: 'Bright Dental: Growth', StageName: 'Negotiation/Review', Amount: 1499 });
    expect(opp.CloseDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    const task = body(f.calls.find((x) => /\/sobjects\/Task\/$/.test(x.url))!.init);
    expect(task).toMatchObject({ WhoId: '003000000000001AAA', Status: 'Completed' });
    expect(task.Description).toContain('Tell me more');
    expect(task.Description).not.toContain('<');
    expect((await links('salesforce')).map((r: any) => r.record_type)).toEqual(['activity', 'deal', 'lead']);
    expect((await links('pipedrive'))).toHaveLength(3);
  });

  test('CRPJ-05 an opportunity won in Salesforce is won here; an update is sent as a PATCH', async () => {
    await t.db.query(`update deals set value_cents = 199900, updated_at = now() + interval '2 seconds' where id = $1`, [dealId]);
    const f = apis();
    expect((await run(f)).result).toMatchObject({ deals_updated: 1 });
    expect(f.calls.find((x) => x.init.method === 'PATCH' && /Opportunity\/006/.test(x.url))).toBeTruthy();
    sfWon = true;
    expect((await run(apis())).result).toMatchObject({ closed_from_crm: 1 });
    expect((await t.db.query(`select summary from activities where record_id = $1 order by created_at desc limit 1`, [dealId])).rows[0].summary).toBe('Marked won in Salesforce');
  });

  test('CRPJ-06 rejected Salesforce credentials fail the run and flag Salesforce for reconnection', async () => {
    sfMode = 'badcreds';
    const j = await run(apis());
    sfMode = 'ok';
    expect(j.status).toBe('failed');
    expect(j.error).toBe('Salesforce rejected the stored credentials. Reconnect Salesforce in Setup.');
    expect(JSON.stringify(j)).not.toContain('sec-0123456789');
    expect((await t.db.query(`select status from integrations where workspace_id = $1 and tool = 'salesforce'`, [t.wsA])).rows[0].status).toBe('expired');
  });
});
