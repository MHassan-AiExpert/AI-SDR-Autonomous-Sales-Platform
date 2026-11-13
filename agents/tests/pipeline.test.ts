// End to end: queued job -> agent service -> stored leads, on the real
// migrations, with every third-party API faked.

import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import { startTestDb, fakeFetch, asUser, USERS, type TestDb } from './harness.ts';
import { runQueuedJobs, type Deps } from '../src/jobs.ts';
import { MODEL_PLAN } from './fixtures.ts';

let t: TestDb;
const models = { openai: 'gpt-test', anthropic: null, gemini: 'gemini-test' };

beforeAll(async () => {
  t = await startTestDb(55432);
  for (const [tool, secret] of [['openai', { api_key: 'sk-A' }], ['apollo', { api_key: 'apollo-A' }], ['apify', { api_token: 'apify-A' }]] as const) {
    await asUser(t.db, USERS.ownerA, (tx: any) => tx.query('select integration_connect($1, $2, $3::jsonb)', [t.wsA, tool, JSON.stringify(secret)]));
  }
  await asUser(t.db, USERS.ownerB, (tx: any) => tx.query('select integration_connect($1, $2, $3::jsonb)', [t.wsB, 'apify', JSON.stringify({ api_token: 'apify-B' })]));
  await asUser(t.db, USERS.ownerB, (tx: any) => tx.query('select integration_connect($1, $2, $3::jsonb)', [t.wsB, 'gemini', JSON.stringify({ api_key: 'gem-B' })]));
});
afterAll(async () => t?.close());

async function campaign(ws: string, over: Record<string, unknown> = {}) {
  const c = { name: 'Austin dentists', niche: 'dental clinics', target_areas: ['Austin, Texas, United States'], daily_lead_limit: 100, ...over };
  const { rows } = await t.db.query(
    `insert into campaigns (workspace_id, name, niche, target_areas, daily_lead_limit, offer) values ($1,$2,$3,$4::jsonb,$5,'Booking automation') returning id`,
    [ws, c.name, c.niche, JSON.stringify(c.target_areas), c.daily_lead_limit]);
  return rows[0].id as string;
}
async function queue(ws: string, campaignId: string, type: 'campaign_plan' | 'lead_sourcing', user = ws === t.wsA ? USERS.ownerA : USERS.ownerB) {
  const { rows } = await asUser(t.db, user, (tx: any) =>
    tx.query(`insert into agent_jobs (workspace_id, campaign_id, type) values ($1,$2,$3) returning id`, [ws, campaignId, type]));
  return rows[0].id as string;
}
const job = async (id: string) => (await t.db.query('select * from agent_jobs where id = $1', [id])).rows[0];
const leadsOf = async (campaignId: string) => (await t.db.query(
  `select l.*, c.name as company_name, c.domain, c.google_rating from leads l left join companies c on c.id = l.company_id where l.campaign_id = $1 order by l.created_at, l.email`, [campaignId])).rows;

const PLACES = [1, 2].map((i) => ({
  title: `Smile Dental ${i}`, totalScore: 4.6, reviewsCount: 40 + i, city: 'Austin', state: 'Texas', countryCode: 'US',
  website: `https://smile${i}.com`, phone: `+1 512 555 010${i}`, categoryName: 'Dentist', emails: [`hello@smile${i}.com`], searchString: 'dentist',
}));

type Overrides = { apify?: () => unknown; apollo?: () => unknown; openaiKey?: string };
function apis(o: Overrides = {}) {
  return fakeFetch([
    [/api\.openai\.com/, (_u, init) => {
      const body = JSON.parse(String(init.body));
      if (o.openaiKey) expect((init.headers as Record<string, string>).Authorization).toBe(`Bearer ${o.openaiKey}`);
      const answer = body.text.format.name === 'campaign_plan'
        ? MODEL_PLAN
        : { companies: [
          { name: 'Smile Dental 1', website: 'https://smile1.com', location: 'Austin', email: 'hello@smile1.com', phone: '', why_fit: 'x' },
          { name: 'Bright Teeth', website: 'https://brightteeth.com', location: 'Austin', email: '', phone: '', why_fit: 'x' },
        ] };
      return { output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify(answer) }] }] };
    }],
    [/generativelanguage/, () => ({ candidates: [{ content: { parts: [{ text: JSON.stringify(MODEL_PLAN) }] } }] })],
    [/api_search/, o.apollo ?? (() => ({ total_entries: 2, people: [{ id: 'a1' }, { id: 'a2' }] }))],
    [/bulk_match/, () => ({ matches: [
      { id: 'a1', name: 'Dr Ana Ruiz', title: 'Practice Owner', email: 'ana@ruizdental.com', organization: { name: 'Ruiz Dental', primary_domain: 'ruizdental.com' } },
      { id: 'a2', name: 'Sam Lee', title: 'Office Manager', email: 'sam@leeortho.com', organization: { name: 'Lee Ortho', primary_domain: 'leeortho.com' } },
    ] })],
    [/crawler-google-places/, o.apify ?? (() => PLACES)],
    [/instagram-hashtag-scraper/, o.apify ?? (() => [{ ownerUsername: 'glowsmile', hashtag: 'austindentist' }])],
    [/instagram-profile-scraper/, o.apify ?? (() => [{ username: 'glowsmile', fullName: 'Glow Smile Studio', biography: 'hi@glowsmile.com', businessCategoryName: 'Dentist' }])],
  ]);
}
// Sourcing hands over to enrichment; that is tested in enrichment.test.ts,
// so here each run clears the follow-up job to keep runs independent.
async function run(d: Deps, limit: number) {
  const out = await runQueuedJobs(d, limit);
  await t.db.query(`delete from agent_jobs where type = 'enrichment' and status = 'queued'`);
  return out;
}
const deps = (f = apis()): Deps => ({ store: t.store, models, fetchImpl: f.impl });

describe('campaign planning job', () => {
  test('PIPE-01 the plan is saved, checked against connected tools, and logged', async () => {
    const c = await campaign(t.wsA);
    const id = await queue(t.wsA, c, 'campaign_plan');
    const out = await run(deps(apis({ openaiKey: 'sk-A' })), 5);
    expect(out).toEqual([{ id, type: 'campaign_plan', status: 'succeeded' }]);
    const j = await job(id);
    expect(j.result).toEqual({ provider: 'openai', enabled_sources: ['apollo', 'google_maps', 'instagram', 'llm_search'], titles: 2 });
    const { rows } = await t.db.query('select icp, source_plan from campaigns where id = $1', [c]);
    expect(rows[0].icp.locations).toEqual(['Austin, Texas, United States']);
    expect(rows[0].source_plan.apollo.person_locations).toEqual(['Austin, Texas, United States']);
    const log = (await t.db.query('select * from run_logs where correlation_id = $1', [j.correlation_id])).rows[0];
    expect(log).toMatchObject({ workflow: 'agent.campaign_plan', status: 'success' });
    expect(log.finished_at).toBeTruthy();
  });

  test('PIPE-02 without a language model the job fails with a clear next step', async () => {
    const c = await campaign(t.wsB);
    await t.db.query(`update integrations set status = 'disconnected' where workspace_id = $1 and tool = 'gemini'`, [t.wsB]);
    const id = await queue(t.wsB, c, 'campaign_plan');
    await run(deps(), 5);
    await t.db.query(`update integrations set status = 'connected' where workspace_id = $1 and tool = 'gemini'`, [t.wsB]);
    const j = await job(id);
    expect(j.status).toBe('failed');
    expect(j.error).toMatch(/Connect OpenAI, Anthropic or Gemini in Setup/);
  });
});

describe('lead sourcing job', () => {
  let main: string;

  test('PIPE-03 leads from every source are stored with their channel, company and timeline', async () => {
    main = await campaign(t.wsA);
    const id = await queue(t.wsA, main, 'lead_sourcing');
    await run(deps(), 5);
    const j = await job(id);
    expect(j.status).toBe('succeeded');
    const leads = await leadsOf(main);
    expect(leads.map((l: any) => [l.source_channel, l.email]).sort()).toEqual([
      ['apollo', 'ana@ruizdental.com'], ['apollo', 'sam@leeortho.com'],
      ['google_maps', 'hello@smile1.com'], ['google_maps', 'hello@smile2.com'],
      ['instagram', 'hi@glowsmile.com'],
    ]);
    const maps = leads.find((l: any) => l.email === 'hello@smile1.com');
    expect(maps).toMatchObject({ phone: '+15125550101', domain: 'smile1.com', company_name: 'Smile Dental 1', niche: 'dental clinics', stage: 'new' });
    expect(Number(maps.google_rating)).toBe(4.6);
    const apollo = leads.find((l: any) => l.email === 'ana@ruizdental.com');
    expect(apollo).toMatchObject({ full_name: 'Dr Ana Ruiz', title: 'Practice Owner', source_query: 'Practice Owner, Office Manager in Austin, Texas, United States' });
    const ig = leads.find((l: any) => l.source_channel === 'instagram');
    expect(ig.social_handles).toEqual({ instagram: 'glowsmile' });
    const notes = (await t.db.query(`select summary, actor from activities where lead_id = $1`, [maps.id])).rows;
    expect(notes).toEqual([{ summary: 'Found by the lead sourcing agent on Google Maps (dentist in Austin, Texas, United States)', actor: 'ai' }]);
  });

  test('PIPE-04 the result reports found, added, duplicate and no-contact counts per source', async () => {
    const j = (await t.db.query(`select result from agent_jobs where campaign_id = $1`, [main])).rows[0];
    expect(j.result.added).toBe(5);
    expect(j.result.sources.apollo).toMatchObject({ found: 2, added: 2, duplicates: 0, credits_used: 2 });
    expect(j.result.sources.google_maps).toMatchObject({ found: 2, added: 2 });
    // LLM search found Smile Dental 1 again (a duplicate) and Bright Teeth, which has no contact yet
    expect(j.result.sources.llm_search).toMatchObject({ found: 2, added: 0, duplicates: 1, without_contact: 1 });
    const bright = (await t.db.query(`select * from companies where workspace_id = $1 and domain = 'brightteeth.com'`, [t.wsA])).rows;
    expect(bright).toHaveLength(1);
    expect((await t.db.query(`select count(*)::int n from leads where company_id = $1`, [bright[0].id])).rows[0].n).toBe(0);
  });

  test('PIPE-05 running again adds nothing new: everything is a duplicate', async () => {
    const id = await queue(t.wsA, main, 'lead_sourcing');
    await run(deps(), 5);
    const j = await job(id);
    expect(j.status).toBe('succeeded');
    expect(j.result.added).toBe(0);
    expect(j.result.sources.apollo.duplicates).toBe(2);
    expect(await leadsOf(main)).toHaveLength(5);
    expect((await t.db.query(`select count(*)::int n from companies where workspace_id = $1 and domain = 'smile1.com'`, [t.wsA])).rows[0].n).toBe(1);
  });

  test('PIPE-06 suppressed contacts are never stored', async () => {
    const c = await campaign(t.wsA, { name: 'Second', daily_lead_limit: 100 });
    await t.db.query(`delete from leads where workspace_id = $1`, [t.wsA]);
    await t.db.query(`insert into suppressions (workspace_id, kind, value, reason) values ($1,'email','ana@ruizdental.com','unsubscribed'), ($1,'domain','smile2.com','customer')`, [t.wsA]);
    const id = await queue(t.wsA, c, 'lead_sourcing');
    await run(deps(), 5);
    const emails = (await leadsOf(c)).map((l: any) => l.email);
    expect(emails).not.toContain('ana@ruizdental.com');
    expect(emails).not.toContain('hello@smile2.com');
    expect(emails).toContain('sam@leeortho.com');
    const j = await job(id);
    expect(j.result.sources.apollo.suppressed).toBe(1);
    expect(j.result.sources.google_maps.suppressed).toBe(1);
    await t.db.query(`delete from suppressions where workspace_id = $1`, [t.wsA]);
  });

  test('PIPE-07 the daily lead limit is respected across sources', async () => {
    await t.db.query(`delete from leads where workspace_id = $1`, [t.wsA]);
    const c = await campaign(t.wsA, { name: 'Small', daily_lead_limit: 3 });
    await queue(t.wsA, c, 'lead_sourcing');
    await run(deps(), 5);
    expect(await leadsOf(c)).toHaveLength(3);
    const id = await queue(t.wsA, c, 'lead_sourcing');
    await run(deps(), 5);
    expect((await job(id)).result).toMatchObject({ added: 0, note: 'The daily lead limit for this campaign is already reached' });
  });

  test('PIPE-15 a client plan caps the leads added each month across campaigns', async () => {
    await t.db.query(`delete from leads where workspace_id = $1`, [t.wsA]);
    await t.db.query(`update workspaces set monthly_lead_limit = 2 where id = $1`, [t.wsA]);
    const c = await campaign(t.wsA, { name: 'Plan capped', daily_lead_limit: 10 });
    await queue(t.wsA, c, 'lead_sourcing');
    await run(deps(), 5);
    expect(await leadsOf(c)).toHaveLength(2);
    const id = await queue(t.wsA, c, 'lead_sourcing');
    await run(deps(), 5);
    expect((await job(id)).result).toMatchObject({ added: 0, note: 'The monthly lead limit of your plan is reached. Ask your agency to raise it.' });
    await t.db.query(`update workspaces set monthly_lead_limit = null where id = $1`, [t.wsA]);
  });

  test('PIPE-08 one source failing keeps the others running and flags that tool', async () => {
    await t.db.query(`delete from leads where workspace_id = $1`, [t.wsA]);
    const c = await campaign(t.wsA, { name: 'Apify down' });
    const id = await queue(t.wsA, c, 'lead_sourcing');
    await run(deps(apis({ apify: () => new Response('{}', { status: 401 }) })), 5);
    const j = await job(id);
    expect(j.status).toBe('succeeded');
    expect(j.result.sources.google_maps.error).toBe('Apify rejected the stored credentials');
    expect(j.result.sources.apollo.added).toBe(2);
    const apify = (await t.db.query(`select status, last_error from integrations where workspace_id = $1 and tool = 'apify'`, [t.wsA])).rows[0];
    expect(apify).toEqual({ status: 'error', last_error: 'Apify rejected the stored credentials' });
    await t.db.query(`update integrations set status = 'connected', last_error = null where workspace_id = $1 and tool = 'apify'`, [t.wsA]);
  });

  test('PIPE-09 when every source fails the job fails and says why', async () => {
    const c = await campaign(t.wsA, { name: 'All down' });
    const down = () => new Response('{}', { status: 503 });
    const f = apis({ apify: down, apollo: down });
    const failing: Deps = { ...deps(f), fetchImpl: (async (u: any, i: any) => (/openai/.test(String(u)) && !String(i?.body).includes('campaign_plan') ? down() : f.impl(u, i))) as typeof fetch };
    const id = await queue(t.wsA, c, 'lead_sourcing');
    await run(failing, 5);
    const j = await job(id);
    expect(j.status).toBe('failed');
    expect(j.error).toMatch(/^Every lead source failed\. Apollo: Apollo returned an error \(503\); Google Maps:/);
    const log = (await t.db.query('select status, error from run_logs where correlation_id = $1', [j.correlation_id])).rows[0];
    expect(log.status).toBe('error');
  });

  test('PIPE-10 each company uses its own keys, and data never crosses workspaces', async () => {
    const c = await campaign(t.wsB, { name: 'B dentists' });
    const f = apis();
    const id = await queue(t.wsB, c, 'lead_sourcing');
    await run(deps(f), 5);
    expect((await job(id)).status).toBe('succeeded');
    const apifyCalls = f.calls.filter((x) => /apify\.com/.test(x.url));
    expect(apifyCalls.length).toBeGreaterThan(0);
    expect(apifyCalls.every((x) => (x.init.headers as Record<string, string>).Authorization === 'Bearer apify-B')).toBe(true);
    expect(f.calls.some((x) => /apollo|openai/.test(x.url))).toBe(false);
    // Workspace A already has smile1, but B gets its own copy
    expect((await leadsOf(c)).map((l: any) => l.email)).toContain('hello@smile1.com');
    const seenByA = await asUser(t.db, USERS.ownerA, (tx: any) => tx.query('select count(*)::int n from leads where campaign_id = $1', [c]));
    expect(seenByA.rows[0].n).toBe(0);
    const seenByB = await asUser(t.db, USERS.ownerB, (tx: any) => tx.query('select count(*)::int n from leads where campaign_id = $1', [c]));
    expect(seenByB.rows[0].n).toBeGreaterThan(0);
  });

  test('PIPE-11 the kill switch holds lead sourcing but not planning', async () => {
    const c = await campaign(t.wsA, { name: 'Paused' });
    await t.db.query('update workspaces set outreach_paused = true where id = $1', [t.wsA]);
    const sourcing = await queue(t.wsA, c, 'lead_sourcing');
    const planning = await queue(t.wsA, c, 'campaign_plan');
    const out = await run(deps(), 5);
    await t.db.query('update workspaces set outreach_paused = false where id = $1', [t.wsA]);
    expect(out.map((o) => o.id)).toEqual([planning]);
    expect((await job(sourcing)).status).toBe('queued');
    await run(deps(), 5);
    expect((await job(sourcing)).status).toBe('succeeded');
  });

  test('PIPE-12 a broken job does not stop the next one in the same run', async () => {
    const gone = await campaign(t.wsA, { name: 'No niche', niche: null });
    const good = await campaign(t.wsA, { name: 'Good' });
    const bad = await queue(t.wsA, gone, 'campaign_plan');
    const ok = await queue(t.wsA, good, 'campaign_plan');
    const out = await run(deps(), 5);
    expect(out).toEqual([{ id: bad, type: 'campaign_plan', status: 'failed' }, { id: ok, type: 'campaign_plan', status: 'succeeded' }]);
    expect((await job(bad)).error).toBe('The campaign has no niche to plan from');
  });

  test('PIPE-14 a finished sourcing job hands over to enrichment', async () => {
    const c = await campaign(t.wsA, { name: 'Handover' });
    await queue(t.wsA, c, 'lead_sourcing');
    await runQueuedJobs(deps(), 5);
    const { rows } = await t.db.query(`select type, status, requested_by from agent_jobs where campaign_id = $1 order by type`, [c]);
    expect(rows).toEqual([{ type: 'enrichment', status: 'queued', requested_by: null }, { type: 'lead_sourcing', status: 'succeeded', requested_by: USERS.ownerA }]);
    await t.db.query(`delete from agent_jobs where campaign_id = $1 and type = 'enrichment'`, [c]);
  });

  test('PIPE-13 stored results and logs never contain a credential', async () => {
    const dump = JSON.stringify([
      (await t.db.query('select result, error from agent_jobs')).rows,
      (await t.db.query('select error from run_logs')).rows,
      (await t.db.query('select summary from activities')).rows,
    ]);
    expect(dump).not.toMatch(/sk-A|apollo-A|apify-A|apify-B|gem-B/);
  });
});
