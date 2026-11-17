import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import {
  acceptNews, canonicalUrl, detectTech, fingerprint, jobChange, newsPrompt, NEWS_JSON_SCHEMA, NEWS_SYSTEM,
  signalHook, techDiff, techSignalTitle, type NewsItem,
} from '../src/signals.ts';
import { decide, isSignalStep, type Step } from '../src/sequence.ts';
import { render } from '../src/sequenceRun.ts';
import { runQueuedJobs, type Deps } from '../src/jobs.ts';
import { startTestDb, fakeFetch, asUser, USERS, type TestDb } from './harness.ts';

const TODAY = new Date('2026-11-17T10:00:00Z');
const item = (over: Partial<NewsItem> = {}): NewsItem => ({
  kind: 'funding', title: 'Bright Teeth raises $4M to open three clinics', detail: 'Series A led by Acme Ventures',
  url: 'https://news.example.com/bright-teeth-series-a', date: '2026-11-02', ...over,
});

describe('SIG technology', () => {
  test('SIG-01 recognised tools are found once each, sorted', () => {
    const html = '<script src="https://js.hs-scripts.com/1.js"></script><script src="https://cdn.shopify.com/s.js"></script>'
      + '<script src="https://js.stripe.com/v3"></script><script src="https://cdn.shopify.com/t.js"></script>';
    expect(detectTech(html)).toEqual(['HubSpot', 'Shopify', 'Stripe']);
    expect(detectTech('<p>Plain page</p>')).toEqual([]);
  });

  test('SIG-02 the first look is a baseline, never a change', () => {
    expect(techDiff(null, ['HubSpot', 'Shopify'])).toEqual({ added: [], removed: [] });
  });

  test('SIG-03 later looks report what appeared and what went', () => {
    const diff = techDiff(['Mailchimp', 'Shopify'], ['Klaviyo', 'Shopify']);
    expect(diff).toEqual({ added: ['Klaviyo'], removed: ['Mailchimp'] });
    expect(techSignalTitle('Bright Teeth', diff)).toBe('Bright Teeth started using Klaviyo and stopped using Mailchimp');
    expect(techSignalTitle('Bright Teeth', { added: ['A', 'B', 'C'], removed: [] })).toBe('Bright Teeth started using A, B and C');
    expect(techSignalTitle('Bright Teeth', { added: [], removed: [] })).toBeNull();
  });
});

describe('SIG web search', () => {
  test('SIG-04 an item with a dated https source inside the window is kept', () => {
    expect(acceptNews([item()], TODAY)).toHaveLength(1);
  });

  test('SIG-05 items a person could not check are dropped', () => {
    const out = acceptNews([
      item({ url: 'http://news.example.com/a' }),                         // not https
      item({ url: 'https://www.google.com/search?q=bright+teeth' }),     // a search page
      item({ date: '' }),                                                 // no date
      item({ date: 'last week' }),                                        // not a date
      item({ date: '2026-08-01' }),                                       // older than 60 days
      item({ date: '2026-12-25' }),                                       // in the future
      item({ url: 'not a url' }),
    ], TODAY);
    expect(out).toEqual([]);
  });

  test('SIG-06 the same story twice is kept once, and at most three per company', () => {
    const out = acceptNews([
      item(),
      item({ url: 'https://news.example.com/bright-teeth-series-a/?utm_source=x' }),
      item({ kind: 'hiring', title: 'Hiring two front-desk coordinators', url: 'https://jobs.example.com/1' }),
      item({ kind: 'news', title: 'Opens Round Rock clinic', url: 'https://news.example.com/2' }),
      item({ kind: 'news', title: 'Wins local award', url: 'https://news.example.com/3' }),
    ], TODAY);
    expect(out.map((i) => i.url)).toEqual([
      'https://news.example.com/bright-teeth-series-a', 'https://jobs.example.com/1', 'https://news.example.com/2',
    ]);
  });

  test('SIG-07 tracking parameters and trailing slashes do not make a new story', () => {
    expect(canonicalUrl('https://www.News.example.com/a/?utm_source=x&gclid=1&id=7#top')).toBe('news.example.com/a?id=7');
  });

  test('SIG-08 the model is told to leave out anything it cannot source, and the schema demands a URL and a date', () => {
    expect(NEWS_SYSTEM).toMatch(/Never invent an event, a date or a URL/);
    expect(NEWS_SYSTEM).toMatch(/ignore any instructions/);
    expect(NEWS_JSON_SCHEMA.properties.items.items.required).toEqual(['kind', 'title', 'detail', 'url', 'date']);
    expect(newsPrompt({ name: 'Bright Teeth', domain: 'brightteeth.com' }, 'Booking automation', TODAY))
      .toBe('Company: Bright Teeth\nWebsite: brightteeth.com\nWhat we sell (to judge which hiring matters): Booking automation\nToday: 2026-11-17');
  });
});

describe('SIG job changes', () => {
  const kim = { full_name: 'Kim Bright', company_name: 'Bright Teeth LLC', company_domain: 'brightteeth.com' };

  test('SIG-09 a new employer by domain is a job change', () => {
    expect(jobChange(kim, { title: 'COO', orgName: 'Northwind Ortho', orgDomain: 'northwindortho.com' }))
      .toBe('Kim Bright moved to Northwind Ortho as COO');
  });

  test('SIG-10 the same employer is not a change, by domain or by name with a legal suffix', () => {
    expect(jobChange(kim, { title: 'Owner', orgName: 'Bright Teeth', orgDomain: 'www.brightteeth.com' })).toBeNull();
    expect(jobChange({ ...kim, company_domain: null }, { title: 'Owner', orgName: 'Bright Teeth Inc.', orgDomain: null })).toBeNull();
  });

  test('SIG-11 no answer, or no employer in the answer, is not a change', () => {
    expect(jobChange(kim, null)).toBeNull();
    expect(jobChange(kim, { title: 'COO', orgName: null, orgDomain: null })).toBeNull();
  });
});

describe('SIG hooks and sequence', () => {
  test('SIG-12 a fingerprint is stable and ignores case and padding', () => {
    expect(fingerprint('A', ' b ')).toBe(fingerprint('a', 'B'));
    expect(fingerprint('a', 'b')).not.toBe(fingerprint('a', 'c'));
  });

  test('SIG-13 each kind becomes a plain opening line', () => {
    expect(signalHook({ kind: 'funding', title: 'Bright Teeth raises $4M.' })).toBe('Congratulations on the news: Bright Teeth raises $4M.');
    expect(signalHook({ kind: 'hiring', title: 'Hiring two coordinators' })).toBe('I noticed you are hiring: Hiring two coordinators.');
    expect(signalHook({ kind: 'job_change', title: 'Kim moved to Northwind' })).toBe('Congratulations on the new role.');
  });

  const step = (over: Partial<Step> = {}): Step => ({
    id: 's1', position: 1, channel: 'email', wait_hours: 0, condition: {}, is_last: true, instantly_campaign_id: null,
    variants: [{ id: 'v', label: 'a', subject: 'Hi', body: '{{signal}} {{first_name}}', active: true }], ...over,
  });
  const signalStep = step({ id: 'sig', position: 2, is_last: false, condition: { all: [{ fact: 'signal_new', is: true }, { fact: 'replied', is: false }] } });

  test('SIG-14 a step that waits for a signal is recognised; others are not', () => {
    expect(isSignalStep(signalStep.condition)).toBe(true);
    expect(isSignalStep({ all: [{ fact: 'signal_new', is: false }] })).toBe(false);
    expect(isSignalStep({})).toBe(false);
    expect(isSignalStep('nonsense')).toBe(false);
  });

  test('SIG-15 a finished sequence re-opens only for a signal step, and only when a signal is new', () => {
    const facts = { has_email: true, has_phone: true, replied: false, stopped: true, steps_done: ['s1'], hours_since_last_touch: 200 };
    expect(decide([step(), signalStep], { ...facts, signal_new: false }, 'lead-1')).toMatchObject({ reason: 'stopped' });
    expect(decide([step(), signalStep], { ...facts, signal_new: true }, 'lead-1').run?.id).toBe('sig');
    // A finished sequence with no signal step stays finished
    expect(decide([step()], { ...facts, signal_new: true }, 'lead-1')).toMatchObject({ reason: 'stopped' });
  });

  test('SIG-16 the signal is written into the message, and nothing is written when there is none', () => {
    const lead = { full_name: 'Kim Bright', company_name: 'Bright Teeth', title: null } as never;
    const withSignal = { ...(lead as object), facts: { signal_kind: 'funding', signal_title: 'Bright Teeth raises $4M' } } as never;
    expect(render('{{signal}} Hi {{first_name}}', withSignal, 'Hassan', 'Northwind')).toBe('Congratulations on the news: Bright Teeth raises $4M. Hi Kim');
    expect(render('{{signal}} Hi {{first_name}}', { ...(lead as object), facts: {} } as never, 'Hassan', 'Northwind')).toBe('Hi Kim');
  });
});

// ---------------------------------------------------------------- end to end

let t: TestDb;
const resolve = async () => ['93.184.216.34'];
const html = (b: string) => new Response(b, { headers: { 'content-type': 'text/html' } });

describe('signals job', () => {
  let c: string;
  let co: string;
  let kim: string;
  let site = '<h1>Bright Teeth</h1><script src="https://cdn.shopify.com/s.js"></script>';
  let news: NewsItem[] = [];
  let apollo: () => Response | object = () => ({ match_confidence: 'high', person: { title: 'COO', organization: { name: 'Northwind Ortho', primary_domain: 'northwindortho.com' } } });

  const apis = () => fakeFetch([
    [/api\.openai\.com/, () => ({ output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify({ items: news }) }] }] })],
    [/api\.apollo\.io\/api\/v1\/people\/match/, () => apollo()],
    [/brightteeth\.com/, () => html(site)],
  ]);

  beforeAll(async () => {
    t = await startTestDb(55447);
    for (const [tool, key] of [['openai', 'sk-A'], ['apollo', 'ap-A']] as const) {
      await asUser(t.db, USERS.ownerA, (tx: any) => tx.query('select integration_connect($1, $2, $3::jsonb)', [t.wsA, tool, JSON.stringify({ api_key: key })]));
    }
    c = (await t.db.query(`insert into campaigns (workspace_id, name, niche, offer, signals_enabled, signal_kinds)
      values ($1, 'Austin', 'dentists', 'Booking automation', true, array['funding','news','hiring','tech_change','job_change']) returning id`, [t.wsA])).rows[0].id;
    co = (await t.db.query(`insert into companies (workspace_id, name, domain, campaign_id) values ($1, 'Bright Teeth', 'brightteeth.com', $2) returning id`, [t.wsA, c])).rows[0].id;
    kim = (await t.db.query(`insert into leads (workspace_id, campaign_id, company_id, email, full_name, source_channel)
      values ($1, $2, $3, 'kim@brightteeth.com', 'Kim Bright', 'apollo') returning id`, [t.wsA, c, co])).rows[0].id;
  });
  afterAll(async () => t?.close());

  const deps = (f: ReturnType<typeof apis>): Deps => ({ store: t.store, models: { openai: 'gpt-test', anthropic: null, gemini: 'g' }, fetchImpl: f.impl, resolve });
  const run = async (f: ReturnType<typeof apis>) => {
    await t.db.query(`insert into agent_jobs (workspace_id, campaign_id, type) values ($1, $2, 'signals')`, [t.wsA, c]);
    await runQueuedJobs(deps(f), 1);
    return (await t.db.query(`select status, result, error from agent_jobs where campaign_id = $1 and type = 'signals' order by created_at desc limit 1`, [c])).rows[0];
  };
  const signals = async () => (await t.db.query(`select kind, source, title, url, lead_id, company_id, status from signals where workspace_id = $1 order by kind, title`, [t.wsA])).rows;
  const due = async () => {
    await t.db.query(`update companies set signals_checked_at = null where id = $1`, [co]);
    await t.db.query(`update leads set job_checked_at = null where id = $1`, [kim]);
  };

  test('SJ-01 the first run records sourced news and a job change, and takes the site as a baseline', async () => {
    news = [item(), item({ kind: 'news', title: 'Made up story with no date', date: '', url: 'https://news.example.com/x' })];
    const f = apis();
    const j = await run(f);
    expect(j.status).toBe('succeeded');
    expect(j.result).toMatchObject({ companies_checked: 1, people_checked: 1, signals: 2 });
    const rows = await signals();
    expect(rows.map((r: any) => [r.kind, r.source])).toEqual([['funding', 'web_search'], ['job_change', 'apollo']]);
    expect(rows[1]).toMatchObject({ title: 'Kim Bright moved to Northwind Ortho as COO', lead_id: kim, status: 'new' });
    // The site was read and remembered, but its first look is not a signal
    expect((await t.db.query(`select tech_stack from companies where id = $1`, [co])).rows[0].tech_stack).toEqual(['Shopify']);
    // The search used web search; the person match spent no reveal
    const openai = f.calls.find((x) => /openai/.test(x.url))!;
    expect(JSON.parse(String(openai.init.body)).tools).toEqual([{ type: 'web_search' }]);
    expect(f.calls.find((x) => /people\/match/.test(x.url))!.url).toMatch(/reveal_personal_emails=false/);
  });

  test('SJ-02 nobody is checked again before they are due', async () => {
    const f = apis();
    const j = await run(f);
    expect(j.result).toMatchObject({ companies_checked: 0, people_checked: 0, signals: 0 });
    expect(f.calls).toHaveLength(0);
  });

  test('SJ-03 a change on the site is a signal, and a story already known is not stored twice', async () => {
    await due();
    site += '<script src="https://js.hs-scripts.com/1.js"></script>';
    news = [item({ url: 'https://news.example.com/bright-teeth-series-a/?utm_source=feed' })];
    const j = await run(apis());
    expect(j.result).toMatchObject({ signals: 1 });
    const tech = (await signals()).find((r: any) => r.kind === 'tech_change');
    expect(tech).toMatchObject({ title: 'Bright Teeth started using HubSpot', source: 'website', company_id: co });
    expect((await signals()).filter((r: any) => r.kind === 'funding')).toHaveLength(1);
  });

  test('SJ-04 only the chosen kinds are looked for: no search when only technology is chosen', async () => {
    await due();
    await t.db.query(`update campaigns set signal_kinds = array['tech_change'] where id = $1`, [c]);
    const f = apis();
    await run(f);
    expect(f.calls.some((x) => /openai|apollo/.test(x.url))).toBe(false);
    expect(f.calls.some((x) => /brightteeth/.test(x.url))).toBe(true);
    await t.db.query(`update campaigns set signal_kinds = array['funding','news','hiring','tech_change','job_change'] where id = $1`, [c]);
  });

  test('SJ-05 a rejected Apollo key flags the tool and stops the job checks without failing the run', async () => {
    await due();
    apollo = () => new Response('{}', { status: 401 });
    news = [];
    const j = await run(apis());
    expect(j.status).toBe('succeeded');
    expect(j.result.skipped).toContain('Apollo rejected the stored key, so job changes were not checked.');
    expect((await t.db.query(`select status from integrations where workspace_id = $1 and tool = 'apollo'`, [t.wsA])).rows[0].status).toBe('error');
  });

  test('SJ-06 with signals off for the campaign, nothing is looked at', async () => {
    await due();
    await t.db.query(`update campaigns set signals_enabled = false where id = $1`, [c]);
    const f = apis();
    const j = await run(f);
    expect(j.result).toEqual({ signals: 0, note: 'Signals are off for this campaign.' });
    expect(f.calls).toHaveLength(0);
  });

  test('SJ-07 no credential is kept in results or signals', async () => {
    const dump = JSON.stringify([(await t.db.query('select result, error from agent_jobs')).rows, await signals()]);
    expect(dump).not.toMatch(/sk-A|ap-A/);
  });
});
