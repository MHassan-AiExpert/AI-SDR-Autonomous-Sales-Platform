// End to end: waterfall enrichment (F25) on the real migrations, providers faked.

import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import { startTestDb, fakeFetch, asUser, USERS, type TestDb } from './harness.ts';
import { runQueuedJobs as runJobs, type Deps } from '../src/jobs.ts';
import { rankPerson } from '../src/sources/hunter.ts';
import { pdlQuery } from '../src/sources/pdl.ts';
import { MODEL_PLAN } from './fixtures.ts';

let t: TestDb;
const models = { openai: 'o', anthropic: null, gemini: 'g' };
const resolve = async () => ['93.184.216.34'];

const connect = (ws: string, tool: string, secret: object) =>
  asUser(t.db, USERS.ownerA, (tx: any) => tx.query('select integration_connect($1, $2, $3::jsonb)', [ws, tool, JSON.stringify(secret)]));

beforeAll(async () => {
  t = await startTestDb(55446);
  await connect(t.wsA, 'apollo', { api_key: 'apollo-key-A' });
  await connect(t.wsA, 'hunter', { api_key: 'hunter-key-A' });
  await connect(t.wsA, 'pdl', { api_key: 'pdl-key-A' });
});
afterAll(async () => t?.close());

async function campaign() {
  const { rows } = await t.db.query(
    `insert into campaigns (workspace_id, name, niche, target_areas, daily_lead_limit, status, icp, source_plan)
     values ($1, 'Dentists', 'dental clinics', '["Austin, Texas"]', 100, 'draft', $2::jsonb, $3::jsonb) returning id`,
    [t.wsA, JSON.stringify(MODEL_PLAN.icp), JSON.stringify(MODEL_PLAN.sources)]);
  return rows[0].id as string;
}
const company = async (c: string, name: string, domain: string) =>
  (await t.db.query(`insert into companies (workspace_id, name, domain, campaign_id, source_channel) values ($1,$2,$3,$4,'llm_search') returning id`, [t.wsA, name, domain, c])).rows[0].id as string;
const run = async (f: ReturnType<typeof fakeFetch>, c: string) => {
  await t.db.query(`insert into agent_jobs (workspace_id, campaign_id, type) values ($1, $2, 'enrichment')`, [t.wsA, c]);
  await runJobs({ store: t.store, models, fetchImpl: f.impl, resolve } as Deps, 5);
  await t.db.query(`delete from agent_jobs where type = 'research' and status = 'queued'`);
  return (await t.db.query(`select * from agent_jobs where campaign_id = $1 and type = 'enrichment' order by created_at desc limit 1`, [c])).rows[0];
};
const html = (body: string) => new Response(body, { headers: { 'content-type': 'text/html' } });
const empty = { data: { emails: [], organization: null } };

type Route = [RegExp, (url: string, init: RequestInit) => unknown | Response];
function providers(over: Route[] = []) {
  return fakeFetch([
    ...over,
    [/api_search/, () => ({ people: [{ id: 'pa' }] })],
    [/bulk_match/, () => ({ matches: [{ id: 'pa', name: 'Ana Alpha', title: 'Practice Owner', email: 'ana@alpha.com', organization: { name: 'Alpha', primary_domain: 'alpha.com' } }] })],
    [/organizations\/enrich/, () => ({})],
    [/api\.hunter\.io\/v2\/domain-search/, (u) => (new URL(u).searchParams.get('domain') === 'beta.com'
      ? { data: { organization: 'Beta Dental', emails: [
        { value: 'intern@beta.com', first_name: 'Ivy', last_name: 'Intern', position: 'Intern', confidence: 97, decision_maker: false },
        { value: 'bo@beta.com', first_name: 'Bo', last_name: 'Beta', position: 'Owner', confidence: 91, decision_maker: true },
      ] } }
      : empty)],
    [/api\.hunter\.io\/v2\/email-finder/, () => ({ data: { email: null, score: 0 } })],
    [/peopledatalabs/, (_u, init) => {
      const domains: string[] = JSON.parse(String(init.body)).query.bool.must[0].terms.job_company_website;
      return domains.includes('gamma.com')
        ? { status: 200, total: 1, data: [{ full_name: 'Gil Gamma', job_title: 'ceo', work_email: 'gil@gamma.com', job_company_website: 'gamma.com', job_company_name: 'gamma' }] }
        : new Response(JSON.stringify({ status: 404, error: { type: 'not_found' } }), { status: 404 });
    }],
    [/delta\.com\/contact$/, () => html('<a href="mailto:hello@delta.com">Mail us</a>')],
    [/\.com/, () => html('<h1>No contacts here</h1>')],
  ]);
}

describe('provider chain', () => {
  let c: string;
  let ids: Record<string, string>;
  let f: ReturnType<typeof providers>;
  let job: any;

  beforeAll(async () => {
    c = await campaign();
    ids = {
      alpha: await company(c, 'Alpha', 'alpha.com'),
      beta: await company(c, 'Beta', 'beta.com'),
      gamma: await company(c, 'Gamma', 'gamma.com'),
      delta: await company(c, 'Delta', 'delta.com'),
      omega: await company(c, 'Omega', 'omega.com'),
    };
    f = providers();
    job = await run(f, c);
  });

  test('WF-01 each company is found by the first provider that has someone, and the lead records which one', async () => {
    const { rows } = await t.db.query(
      `select c.domain, l.email, l.full_name, l.enrichment_provider, l.source_query from leads l join companies c on c.id = l.company_id
       where l.campaign_id = $1 order by c.domain`, [c]);
    expect(rows).toEqual([
      { domain: 'alpha.com', email: 'ana@alpha.com', full_name: 'Ana Alpha', enrichment_provider: 'apollo', source_query: 'Apollo decision maker at alpha.com' },
      { domain: 'beta.com', email: 'bo@beta.com', full_name: 'Bo Beta', enrichment_provider: 'hunter', source_query: 'Hunter decision maker at beta.com' },
      { domain: 'delta.com', email: 'hello@delta.com', full_name: null, enrichment_provider: 'website', source_query: 'Company website delta.com' },
      { domain: 'gamma.com', email: 'gil@gamma.com', full_name: 'Gil Gamma', enrichment_provider: 'pdl', source_query: 'People Data Labs decision maker at gamma.com' },
    ]);
    const status = (await t.db.query(`select enrichment_status from companies where id = $1`, [ids.omega])).rows[0];
    expect(status.enrichment_status).toBe('no_contact_found');
  });

  test('WF-02 the chain stops at the first hit: later providers are only asked about companies still missing', async () => {
    const hunterDomains = f.calls.filter((x) => /domain-search/.test(x.url)).map((x) => new URL(x.url).searchParams.get('domain')).sort();
    expect(hunterDomains).toEqual(['beta.com', 'delta.com', 'gamma.com', 'omega.com']);
    const pdl = f.calls.filter((x) => /peopledatalabs/.test(x.url)).map((x) => JSON.parse(String(x.init.body)).query.bool.must[0].terms.job_company_website.sort());
    expect(pdl).toEqual([['delta.com', 'gamma.com', 'omega.com']]);
  });

  test('WF-03 Hunter keeps only people the campaign wants to reach, not the most confident address', async () => {
    const { rows } = await t.db.query(`select email from leads where company_id = $1`, [ids.beta]);
    expect(rows).toEqual([{ email: 'bo@beta.com' }]);
  });

  test('WF-04 every attempt is recorded and the stats give a match rate per provider', async () => {
    const n = (await t.db.query(`select count(*)::int n from enrichment_attempts where campaign_id = $1`, [c])).rows[0].n;
    expect(n).toBe(5 + 4 + 3 + 2);
    const stats = await asUser(t.db, USERS.repA, (tx: any) => tx.query(`select * from enrichment_provider_stats($1, 30)`, [t.wsA]));
    const mine = stats.rows.map((r: any) => [r.provider, Number(r.attempts), Number(r.found), Number(r.match_rate), Number(r.leads)]);
    expect(mine).toEqual([['apollo', 5, 1, 20, 1], ['hunter', 4, 1, 25, 1], ['pdl', 3, 1, 33.3, 1], ['website', 2, 1, 50, 1]]);
  });

  test('WF-05 the job result reports each provider, with credits', () => {
    expect(job.status).toBe('succeeded');
    expect(job.result.providers).toMatchObject({
      apollo: { tried: 5, found: 1, credits_used: 1 },
      hunter: { tried: 4, found: 1, credits_used: 1 },
      pdl: { tried: 3, found: 1, credits_used: 1 },
      website: { tried: 2, found: 1 },
    });
    expect(job.result.companies).toMatchObject({ checked: 5, leads_added: 4, no_contact: 1 });
  });

  test('WF-06 keys travel in headers, never in a URL, a result or a log', async () => {
    const hunter = f.calls.filter((x) => /hunter\.io/.test(x.url));
    expect(hunter.every((x) => !/api_key|hunter-key/.test(x.url) && (x.init.headers as Record<string, string>)['X-API-KEY'] === 'hunter-key-A')).toBe(true);
    const pdl = f.calls.filter((x) => /peopledatalabs/.test(x.url));
    expect(pdl.every((x) => !/pdl-key/.test(x.url) && (x.init.headers as Record<string, string>)['X-Api-Key'] === 'pdl-key-A')).toBe(true);
    const dump = JSON.stringify((await t.db.query('select result, error from agent_jobs')).rows);
    expect(dump).not.toMatch(/apollo-key|hunter-key|pdl-key/);
  });
});

describe('waterfall edge cases', () => {
  test('WF-07 a named person found without an email gets their work address from Hunter', async () => {
    const c = await campaign();
    const id = await company(c, 'Zeta', 'zeta.com');
    const f = providers([
      [/bulk_match/, () => ({ matches: [{ id: 'pz', name: 'Zed Zeta', title: 'Practice Owner', linkedin_url: 'https://www.linkedin.com/in/zedzeta', organization: { name: 'Zeta', primary_domain: 'zeta.com' } }] })],
      [/email-finder/, (u) => (new URL(u).searchParams.get('full_name') === 'Zed Zeta' ? { data: { email: 'zed@zeta.com', score: 92, verification: { status: 'valid' } } } : { data: {} })],
    ]);
    const job = await run(f, c);
    const { rows } = await t.db.query(`select email, enrichment_provider, source_query from leads where company_id = $1`, [id]);
    expect(rows).toEqual([{ email: 'zed@zeta.com', enrichment_provider: 'apollo', source_query: 'Apollo decision maker at zeta.com (email from Hunter)' }]);
    expect(f.calls.filter((x) => /domain-search/.test(x.url))).toHaveLength(0);
    expect(job.result.providers.hunter).toMatchObject({ emails_found: 1 });
  });

  test('WF-08 the workspace order decides who is asked for contacts; providers left out are not asked', async () => {
    await t.db.query(`update workspaces set enrichment_order = '{pdl,hunter}' where id = $1`, [t.wsA]);
    const c = await campaign();
    const id = await company(c, 'Beta Two', 'beta2.com');
    const f = providers([[/domain-search/, (u) => (new URL(u).searchParams.get('domain') === 'beta2.com'
      ? { data: { organization: 'B2', emails: [{ value: 'kay@beta2.com', first_name: 'Kay', last_name: 'Two', position: 'Office Manager', confidence: 80 }] } }
      : empty)]]);
    await run(f, c);
    await t.db.query(`update workspaces set enrichment_order = '{apollo,hunter,pdl}' where id = $1`, [t.wsA]);
    // Apollo still fills in company details (a separate step); it is not asked for people
    expect(f.calls.filter((x) => /api_search|bulk_match/.test(x.url))).toHaveLength(0);
    const first = f.calls.findIndex((x) => /peopledatalabs/.test(x.url));
    const second = f.calls.findIndex((x) => /hunter\.io/.test(x.url));
    expect(first).toBeGreaterThanOrEqual(0);
    expect(first).toBeLessThan(second);
    expect((await t.db.query(`select enrichment_provider from leads where company_id = $1`, [id])).rows).toEqual([{ enrichment_provider: 'hunter' }]);
  });

  test('WF-09 one provider failing does not stop the chain, and companies it failed on are retried rather than written off', async () => {
    const c = await campaign();
    const found = await company(c, 'Gamma Three', 'gamma3.com');
    const lost = await company(c, 'Lost', 'lost.com');
    const f = providers([
      [/domain-search/, () => new Response('{}', { status: 500 })],
      [/peopledatalabs/, () => ({ status: 200, total: 1, data: [{ full_name: 'Gia Three', job_title: 'owner', work_email: 'gia@gamma3.com', job_company_website: 'gamma3.com' }] })],
      [/api_search/, () => ({ people: [] })],
    ]);
    const job = await run(f, c);
    const status = async (id: string) => (await t.db.query(`select enrichment_status from companies where id = $1`, [id])).rows[0].enrichment_status;
    expect(await status(found)).toBe('enriched');
    expect(await status(lost)).toBe('pending');
    expect(job.result.providers.hunter).toMatchObject({ errors: 2 });
    expect((await t.db.query(`select status from integrations where workspace_id = $1 and tool = 'hunter'`, [t.wsA])).rows[0].status).toBe('connected');
  });

  test('WF-10 a refused key flags that provider for the team and the next provider carries on', async () => {
    const c = await campaign();
    const id = await company(c, 'Delta Four', 'delta4.com');
    const f = providers([
      [/api_search/, () => new Response('{}', { status: 401 })],
      [/delta4\.com\/contact$/, () => html('<a href="mailto:hi@delta4.com">Mail</a>')],
    ]);
    const job = await run(f, c);
    expect((await t.db.query(`select status from integrations where workspace_id = $1 and tool = 'apollo'`, [t.wsA])).rows[0].status).toBe('error');
    expect(job.result.companies.error).toBe('Apollo: Apollo rejected the stored credentials');
    expect((await t.db.query(`select enrichment_provider from leads where company_id = $1`, [id])).rows).toEqual([{ enrichment_provider: 'website' }]);
    await t.db.query(`update integrations set status = 'connected', last_error = null where workspace_id = $1 and tool = 'apollo'`, [t.wsA]);
  });

  test('WF-11 People Data Labs on a free plan hides contact details: nothing is saved from it and the team is told why', async () => {
    const c = await campaign();
    await company(c, 'Hidden', 'hidden.com');
    const f = providers([
      [/api_search/, () => ({ people: [] })],
      [/peopledatalabs/, () => ({ status: 200, total: 1, data: [{ full_name: 'Hal Hidden', job_title: 'owner', work_email: true, mobile_phone: true, job_company_website: 'hidden.com' }] })],
    ]);
    const job = await run(f, c);
    expect(job.result.notes).toContain('People Data Labs is hiding contact details on this plan; a Pro plan is needed to receive emails and phones.');
    expect((await t.db.query(`select count(*)::int n from leads where campaign_id = $1`, [c])).rows[0].n).toBe(0);
  });
});

describe('provider helpers', () => {
  test('WF-12 Hunter ranks a requested title above a decision maker above an executive, and drops everyone else', () => {
    const titles = ['Practice Owner'];
    expect(rankPerson('Practice Owner & Dentist', false, undefined, titles)).toBe(0);
    expect(rankPerson('Founder', true, 'executive', titles)).toBe(1);
    expect(rankPerson('COO', false, 'executive', titles)).toBe(2);
    expect(rankPerson('Hygienist', false, 'junior', titles)).toBeNull();
  });

  test('WF-13 the PDL query filters by company website and needs a senior level or a requested title', () => {
    const q = pdlQuery(['a.com'], ['Office Manager']);
    expect(q.bool.must).toEqual([{ terms: { job_company_website: ['a.com'] } }]);
    expect(q.bool.minimum_should_match).toBe(1);
    expect(q.bool.should).toContainEqual({ match_phrase: { job_title: 'office manager' } });
  });
});
