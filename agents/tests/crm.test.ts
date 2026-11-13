import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import { contactProperties, dealInput, noteBody, stageMap, fingerprint, DEFAULT_STAGE_MAP, type CrmLead, type CrmDeal } from '../src/crm.ts';
import { noteEscape } from '../src/sources/hubspot.ts';
import { runQueuedJobs, type Deps } from '../src/jobs.ts';
import { startTestDb, fakeFetch, asUser, USERS, type TestDb } from './harness.ts';

const lead = (over: Partial<CrmLead> = {}): CrmLead => ({
  id: 'l', email: 'kim@bright.test', full_name: 'Kim Lee Park', phone: '+15125550100', title: 'Owner', stage: 'interested',
  company: 'Bright Dental', domain: 'bright.test', score: 80, linkedin_url: null, ...over,
});

describe('CRM mapping', () => {
  test('CR-01 a lead becomes a contact with a lead status that follows its stage', () => {
    expect(contactProperties(lead())).toEqual({
      hs_lead_status: 'IN_PROGRESS', firstname: 'Kim', lastname: 'Lee Park', phone: '+15125550100', jobtitle: 'Owner', company: 'Bright Dental', website: 'bright.test',
    });
    expect(contactProperties(lead({ stage: 'won' }))).toMatchObject({ hs_lead_status: 'OPEN_DEAL', lifecyclestage: 'customer' });
    expect(contactProperties(lead({ stage: 'do_not_contact', full_name: null }))).toEqual(expect.objectContaining({ hs_lead_status: 'UNQUALIFIED' }));
    expect(contactProperties(lead({ full_name: null }))).not.toHaveProperty('firstname');
  });

  test('CR-02 the stage map keeps valid custom ids and falls back to the default pipeline', () => {
    expect(stageMap({})).toEqual(DEFAULT_STAGE_MAP);
    expect(stageMap({ won: ' 12345 ', lost: 'bad id!', extra: 'x' })).toEqual({ ...DEFAULT_STAGE_MAP, won: '12345' });
    expect(stageMap(null)).toEqual(DEFAULT_STAGE_MAP);
  });

  test('CR-03 a deal is named after the company and plan, with the amount in currency units', () => {
    const d: CrmDeal = { id: 'd', lead_id: 'l', stage: 'proposal_sent', value_cents: 149900, currency: 'USD', lead_name: 'Kim', company: 'Bright Dental', plan_name: 'Growth', closed_at: null };
    expect(dealInput(d, 'default', DEFAULT_STAGE_MAP)).toEqual({ name: 'Bright Dental: Growth', pipeline: 'default', stage: 'contractsent', amount: '1499.00', closeDate: null });
    expect(dealInput({ ...d, company: null, plan_name: null, value_cents: null }, 'p1', DEFAULT_STAGE_MAP)).toMatchObject({ name: 'Kim', amount: null, pipeline: 'p1' });
  });

  test('CR-04 notes escape what leads wrote and say where they came from', () => {
    expect(noteEscape('<b>"x" & y</b>')).toBe('&lt;b&gt;&quot;x&quot; &amp; y&lt;/b&gt;');
    const n = noteBody({ id: 'r', lead_id: 'l', kind: 'reply', at: new Date(), detail: { channel: 'email', classification: 'interested', body: 'Yes <script>alert(1)</script>' } });
    expect(n).toBe('<strong>Reply by email</strong> (interested)<br>Yes &lt;script&gt;alert(1)&lt;/script&gt;<br><em>Logged by the AI SDR platform</em>');
    expect(noteBody({ id: 'c', lead_id: 'l', kind: 'call', at: new Date(), detail: { direction: 'outbound', outcome: 'booked', duration_seconds: 185, summary: 'Booked a demo.' } }))
      .toBe('<strong>Outbound AI call</strong> (3 min): booked<br>Booked a demo.<br><em>Logged by the AI SDR platform</em>');
    expect(noteBody({ id: 'm', lead_id: 'l', kind: 'meeting', at: new Date('2026-12-01T15:30:00Z'), detail: { status: 'scheduled', run_by: 'ai_closer', outcome: null } }))
      .toBe('<strong>Meeting scheduled</strong> for 2026-12-01 15:30 UTC, run by the AI closer<br><em>Logged by the AI SDR platform</em>');
  });

  test('CR-05 the fingerprint changes only when what is sent changes', () => {
    expect(fingerprint({ a: 1 })).toBe(fingerprint({ a: 1 }));
    expect(fingerprint({ a: 1 })).not.toBe(fingerprint({ a: 2 }));
    expect(fingerprint({ a: 1 })).toMatch(/^[0-9a-f]{64}$/);
  });
});

// ---------------------------------------------------------------- end to end

let t: TestDb;
let c = '';
let kim = '';
let deal = '';
let hsStage = 'contractsent';
let mode: 'ok' | '429' | '401' = 'ok';
let nextId = 100;

function hubspot() {
  return fakeFetch([
    [/api\.hubapi\.com/, (url, init) => {
      if (mode === '429') return new Response('{}', { status: 429 });
      if (mode === '401') return new Response('{}', { status: 401 });
      const body = init.body ? JSON.parse(String(init.body)) : {};
      if (url.endsWith('/contacts/batch/upsert')) {
        return { results: body.inputs.map((x: { id: string }, i: number) => ({ id: String(500 + i + (x.id.startsWith('kim') ? 0 : 50)), properties: { email: x.id } })) };
      }
      if (url.endsWith('/deals/batch/read')) return { results: body.inputs.map((x: { id: string }) => ({ id: x.id, properties: { dealstage: hsStage } })) };
      if (url.endsWith('/objects/deals') || url.endsWith('/objects/notes')) return { id: String(nextId++) };
      if (/\/objects\/deals\/\d+$/.test(url)) return { id: url.split('/').pop() };
      return new Response('{}', { status: 404 });
    }],
  ]);
}
const deps = (f: ReturnType<typeof hubspot>): Deps => ({ store: t.store, models: { openai: 'o', anthropic: null, gemini: 'g' }, fetchImpl: f.impl });
const run = async (f: ReturnType<typeof hubspot>) => {
  await t.db.query(`delete from agent_jobs where campaign_id = $1 and status = 'queued'`, [c]);
  await t.db.query(`insert into agent_jobs (workspace_id, campaign_id, type) values ($1, $2, 'crm_sync')`, [t.wsA, c]);
  await runQueuedJobs(deps(f), 1);
  return (await t.db.query(`select * from agent_jobs where campaign_id = $1 and type = 'crm_sync' order by created_at desc limit 1`, [c])).rows[0];
};
const calls = (f: ReturnType<typeof hubspot>, re: RegExp) => f.calls.filter((x) => re.test(x.url));

describe('HubSpot sync', () => {
  beforeAll(async () => {
    t = await startTestDb(55444);
    c = (await t.db.query(`insert into campaigns (workspace_id, name, niche, status) values ($1, 'Austin', 'dentists', 'active') returning id`, [t.wsA])).rows[0].id;
    const co = (await t.db.query(`insert into companies (workspace_id, name, domain) values ($1, 'Bright Dental', 'bright.test') returning id`, [t.wsA])).rows[0].id;
    kim = (await t.db.query(`insert into leads (workspace_id, campaign_id, company_id, email, full_name, stage, source_channel)
      values ($1, $2, $3, 'kim@bright.test', 'Kim Lee', 'interested', 'apollo') returning id`, [t.wsA, c, co])).rows[0].id;
    // Not engaged yet: outside the default scope
    await t.db.query(`insert into leads (workspace_id, campaign_id, email, stage, source_channel) values ($1, $2, 'cold@x.test', 'contacted', 'apollo')`, [t.wsA, c]);
    // Engaged but only reachable by phone
    await t.db.query(`insert into leads (workspace_id, campaign_id, phone, stage, source_channel) values ($1, $2, '+15125550111', 'engaged', 'google_maps')`, [t.wsA, c]);
    deal = (await t.db.query(`insert into deals (workspace_id, lead_id, campaign_id, stage, value_cents, plan_name) values ($1, $2, $3, 'proposal_sent', 149900, 'Growth') returning id`, [t.wsA, kim, c])).rows[0].id;
    await t.db.query(`insert into replies (workspace_id, lead_id, channel, body, classification) values ($1, $2, 'email', 'Tell me more <b>please</b>', 'interested')`, [t.wsA, kim]);
  });
  afterAll(async () => { await t?.close(); });

  test('CJ-01 nothing is sent while sync is off or HubSpot is not connected', async () => {
    const f = hubspot();
    expect((await run(f)).result).toEqual({ skipped: 'CRM sync is switched off' });
    await t.db.query(`update workspaces set crm_sync_enabled = true where id = $1`, [t.wsA]);
    expect((await run(f)).result).toEqual({ skipped: 'HubSpot is not connected' });
    expect(f.calls).toHaveLength(0);
    await asUser(t.db, USERS.ownerA, (tx: any) => tx.query('select integration_connect($1, $2, $3::jsonb)', [t.wsA, 'hubspot', JSON.stringify({ access_token: 'pat-na1-CRM' })]));
  });

  test('CJ-02 engaged leads, their deal and their reply reach HubSpot, linked together', async () => {
    const f = hubspot();
    const j = await run(f);
    expect(j.status).toBe('succeeded');
    expect(j.result).toMatchObject({ contacts_sent: 1, contacts_without_email: 0, deals_created: 1, notes_created: 1, closed_from_crm: 0, rate_limited: false });
    const up = JSON.parse(String(calls(f, /batch\/upsert/)[0].init.body));
    expect(up.inputs).toEqual([{ idProperty: 'email', id: 'kim@bright.test', properties: expect.objectContaining({ email: 'kim@bright.test', hs_lead_status: 'IN_PROGRESS', company: 'Bright Dental' }) }]);
    expect(calls(f, /batch\/upsert/)[0].init.headers).toMatchObject({ Authorization: 'Bearer pat-na1-CRM' });
    const d = JSON.parse(String(calls(f, /\/objects\/deals$/)[0].init.body));
    expect(d.properties).toEqual({ dealname: 'Bright Dental: Growth', pipeline: 'default', dealstage: 'contractsent', amount: '1499.00' });
    expect(d.associations[0]).toEqual({ to: { id: '500' }, types: [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: 3 }] });
    const n = JSON.parse(String(calls(f, /\/objects\/notes$/)[0].init.body));
    expect(n.properties.hs_note_body).toContain('Tell me more &lt;b&gt;please&lt;/b&gt;');
    expect(n.associations[0].types[0].associationTypeId).toBe(202);
    const links = (await t.db.query(`select record_type, external_id from crm_links where workspace_id = $1 order by record_type`, [t.wsA])).rows;
    expect(links).toEqual([{ record_type: 'activity', external_id: '101' }, { record_type: 'deal', external_id: '100' }, { record_type: 'lead', external_id: '500' }]);
    expect((await t.db.query(`select crm_synced_at from workspaces where id = $1`, [t.wsA])).rows[0].crm_synced_at).not.toBeNull();
  });

  test('CJ-03 a second run sends nothing that has not changed', async () => {
    const f = hubspot();
    const j = await run(f);
    expect(j.result).toMatchObject({ contacts_sent: 0, deals_created: 0, deals_updated: 0, notes_created: 0 });
    expect(calls(f, /batch\/upsert|\/objects\/notes|\/objects\/deals$/)).toHaveLength(0);
    // Only the stage read-back
    expect(calls(f, /deals\/batch\/read/)).toHaveLength(1);
  });

  test('CJ-04 a changed deal is updated in place, not created again', async () => {
    await t.db.query(`update deals set stage = 'negotiation', updated_at = now() + interval '1 second' where id = $1`, [deal]);
    const f = hubspot();
    expect((await run(f)).result).toMatchObject({ deals_created: 0, deals_updated: 1 });
    const patch = calls(f, /\/objects\/deals\/100$/)[0];
    expect(patch.init.method).toBe('PATCH');
    expect(JSON.parse(String(patch.init.body)).properties.dealstage).toBe('decisionmakerboughtin');
  });

  test('CJ-05 a deal marked won in HubSpot is won here, and the contact becomes a customer', async () => {
    hsStage = 'closedwon';
    const f = hubspot();
    const j = await run(f);
    expect(j.result).toMatchObject({ closed_from_crm: 1 });
    const d = (await t.db.query(`select stage, closed_by, closed_at from deals where id = $1`, [deal])).rows[0];
    expect(d).toMatchObject({ stage: 'won', closed_by: 'human' });
    expect((await t.db.query(`select stage from leads where id = $1`, [kim])).rows[0].stage).toBe('won');
    expect((await t.db.query(`select summary from activities where record_id = $1`, [deal])).rows[0].summary).toBe('Marked won in HubSpot');
    const up = JSON.parse(String(calls(f, /batch\/upsert/)[0].init.body));
    expect(up.inputs[0].properties).toMatchObject({ lifecyclestage: 'customer' });
    // Closed deals are no longer read back
    const again = hubspot();
    await run(again);
    expect(calls(again, /deals\/batch\/read/)).toHaveLength(0);
  });

  test('CJ-06 the wider scope includes everyone contacted', async () => {
    await t.db.query(`update workspaces set crm_sync_scope = 'contacted' where id = $1`, [t.wsA]);
    const f = hubspot();
    expect((await run(f)).result).toMatchObject({ contacts_sent: 1 });
    expect(JSON.parse(String(calls(f, /batch\/upsert/)[0].init.body)).inputs[0].id).toBe('cold@x.test');
  });

  test('CJ-07 a rate limit keeps what was saved and leaves the rest for the next run', async () => {
    await t.db.query(`insert into replies (workspace_id, lead_id, channel, body, classification) values ($1, $2, 'sms', 'Call me', 'question')`, [t.wsA, kim]);
    mode = '429';
    const j = await run(hubspot());
    expect(j.status).toBe('succeeded');
    expect(j.result).toMatchObject({ rate_limited: true, notes_created: 0 });
    mode = 'ok';
    expect((await run(hubspot())).result).toMatchObject({ notes_created: 1 });
  });

  test('CJ-08 a rejected token fails the run and marks HubSpot for reconnection', async () => {
    await t.db.query(`update leads set full_name = 'Kim Lee-Park', updated_at = now() + interval '5 seconds' where id = $1`, [kim]);
    mode = '401';
    const j = await run(hubspot());
    mode = 'ok';
    expect(j.status).toBe('failed');
    expect(j.error).toBe('HubSpot rejected the access token. Reconnect HubSpot in Setup.');
    expect(JSON.stringify(j)).not.toContain('pat-na1-CRM');
    expect((await t.db.query(`select status from integrations where workspace_id = $1 and tool = 'hubspot'`, [t.wsA])).rows[0].status).toBe('expired');
  });

  test('CJ-09 the hourly schedule queues a sync only while it is on', async () => {
    await t.db.query(`delete from agent_jobs where campaign_id = $1`, [c]);
    await t.db.query(`select agent_jobs_enqueue_due(24)`);
    expect((await t.db.query(`select count(*)::int n from agent_jobs where campaign_id = $1 and type = 'crm_sync'`, [c])).rows[0].n).toBe(1);
    await t.db.query(`delete from agent_jobs where campaign_id = $1`, [c]);
    await t.db.query(`update workspaces set crm_sync_enabled = false where id = $1`, [t.wsA]);
    await t.db.query(`select agent_jobs_enqueue_due(24)`);
    expect((await t.db.query(`select count(*)::int n from agent_jobs where campaign_id = $1 and type = 'crm_sync'`, [c])).rows[0].n).toBe(0);
  });
});
