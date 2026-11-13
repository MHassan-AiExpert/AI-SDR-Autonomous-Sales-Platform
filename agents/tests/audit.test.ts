import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import { auditChecks, auditScore, standardRecommendations, validateAudit, auditPrompt, auditLine, type Check } from '../src/audit.ts';
import { fetchHomePage } from '../src/sources/website.ts';
import { runQueuedJobs, type Deps } from '../src/jobs.ts';
import { startTestDb, fakeFetch, asUser, USERS, type TestDb } from './harness.ts';

const GOOD = `<!doctype html><html><head><title>Family Dentist in Austin | Bright Teeth</title>
<meta name="description" content="Gentle family dentistry in Austin with same-week appointments, evening hours and most insurance accepted.">
<meta name="viewport" content="width=device-width, initial-scale=1">
<script type="application/ld+json">{"@type":"Dentist"}</script><script async src="https://www.googletagmanager.com/gtag/js?id=G-1"></script></head>
<body><h1>Gentle dentistry for the whole family</h1><a href="tel:+15125550101">(512) 555-0101</a>
<a href="https://calendly.com/bright/visit">Book an appointment</a><form action="/contact"><input name="email"></form>
<a href="https://facebook.com/bright">Facebook</a><a href="https://instagram.com/bright">Instagram</a></body></html>`;
const POOR = `<html><head><title>Home</title></head><body><h1>Welcome</h1><h1>Services</h1><p>Call 512 555 0102 today</p></body></html>`;
const page = (html: string, over: Partial<{ url: string; ms: number; bytes: number }> = {}) => ({ html, url: 'https://bright.test/', ms: 400, bytes: Buffer.byteLength(html), ...over });
const byId = (checks: Check[]) => Object.fromEntries(checks.map((c) => [c.id, c.status]));

describe('audit checks', () => {
  test('AT-01 a well-built site passes every check and scores 100', () => {
    const checks = auditChecks(page(GOOD), { rating: 4.8, count: 120 });
    expect(checks.every((c) => c.status === 'pass')).toBe(true);
    expect(auditScore(checks)).toBe(100);
    expect(checks.map((c) => c.id)).toEqual(['https', 'title', 'description', 'mobile', 'heading', 'speed', 'call', 'contact', 'booking', 'tracking', 'schema', 'social', 'reviews']);
  });

  test('AT-02 a weak site is measured honestly; checks that cannot be measured do not count', () => {
    const checks = auditChecks(page(POOR, { url: 'http://slow.test/', ms: 3800 }), { rating: null, count: null });
    expect(byId(checks)).toEqual({
      https: 'fail', title: 'warn', description: 'fail', mobile: 'fail', heading: 'warn', speed: 'fail', call: 'warn',
      contact: 'fail', booking: 'fail', tracking: 'fail', schema: 'warn', social: 'fail', reviews: 'unknown',
    });
    expect(checks.find((c) => c.id === 'speed')!.detail).toBe(`The page answered in 3.8 s with 0 KB of HTML.`);
    expect(auditScore(checks)).toBe(Math.round((4 * 0.5 / 12) * 100));
    expect(auditChecks(page(GOOD), { rating: 3.6, count: 8 }).find((c) => c.id === 'reviews')).toMatchObject({ status: 'fail', detail: '3.6 stars from 8 reviews.' });
  });

  test('AT-03 recommendations cover only checks that did not pass and never contain links', () => {
    const checks = auditChecks(page(POOR, { url: 'http://slow.test/', ms: 3800 }), { rating: null, count: null });
    const std = standardRecommendations(checks);
    expect(std).toHaveLength(3);
    expect(std.map((r) => r.check_id)).toEqual(['https', 'description', 'mobile']);
    const rec = (check_id: string, how = 'Add a tappable number at the top of the page.') => ({ check_id, title: 'Make calling easy', why: 'Most visitors are on phones.', how });
    expect(validateAudit({ summary: 'The site is a good start but makes it hard for visitors to get in touch quickly.', recommendations: [rec('call'), rec('https'), rec('reviews')] }, checks).recommendations.map((r) => r.check_id)).toEqual(['call', 'https']);
    expect(() => validateAudit({ summary: 'The site is a good start but makes it hard for visitors to get in touch quickly.', recommendations: [rec('call', 'See https://evil.example for help with this.')] }, checks)).toThrow(/links/);
    expect(() => validateAudit({ summary: 'The site is a good start but makes it hard for visitors to get in touch quickly.', recommendations: [rec('reviews')] }, checks)).toThrow(/do not match/);
  });

  test('AT-04 the prompt passes measured results as data; the email line names the business', () => {
    const p = auditPrompt({ id: 'l', full_name: null, company_name: 'Bright Teeth', domain: 'bright.test', google_rating: null, google_reviews: null, ai_report: { company_summary: 'Clinic' } }, auditChecks(page(POOR), { rating: null, count: null }), 17, 'Booking automation');
    expect(p).toMatch(/<results>\nhttps \| pass \| Secure connection/);
    expect(p).toContain('</research>');
    expect(auditLine('Bright Teeth', 'https://app.example.com/a/x')).toBe("I put together a short, free audit of Bright Teeth's website and marketing: https://app.example.com/a/x");
    expect(auditLine('your company', 'https://x')).toBe('I put together a short, free audit of your website and marketing: https://x');
  });

  test('AT-05 the home page is fetched safely, falling back to http, with its time measured', async () => {
    let t = 0;
    const f = fakeFetch([
      [/^https:\/\/plain\.test/, () => { throw new Error('tls'); }],
      [/^http:\/\/plain\.test/, () => { t += 900; return new Response(POOR, { headers: { 'content-type': 'text/html' } }); }],
    ]);
    const p = await fetchHomePage('plain.test', f.impl, async () => ['93.184.216.34'], () => t);
    expect(p).toMatchObject({ url: 'http://plain.test/', ms: 900 });
    expect(await fetchHomePage('internal.test', f.impl, async () => ['10.0.0.5'])).toBeNull();
    expect(f.calls.some((c) => c.url.includes('internal.test'))).toBe(false);
  });
});

// ---------------------------------------------------------------- end to end

let t: TestDb;
let c = '';
const ids: Record<string, string> = {};
const AUDIT_AI = { summary: 'Slow Dental has a basic site, but it is hard to find, slow and gives visitors no easy way to book or call.', recommendations: [
  { check_id: 'booking', title: 'Let patients book online', why: 'Patients who cannot book online often choose another clinic.', how: 'Add a booking button at the top of the home page.' },
  { check_id: 'https', title: 'Secure the website', why: 'Browsers warn visitors that the site is not secure.', how: 'Turn on SSL in your hosting and redirect to https.' },
  { check_id: 'mobile', title: 'Fit the page to phones', why: 'Most visitors arrive on a phone.', how: 'Add a mobile viewport and test the page on a phone.' },
] };
const words = (n: number) => Array.from({ length: n }, (_, i) => ['clinics', 'patients', 'bookings', 'calls', 'week'][i % 5]).join(' ');
const SEQ = { emails: [{ subject: 'Quick idea for your clinic', body: `Hi there,\n\n${words(40)}.\n\nSam` }, { subject: 'Following up', body: `Hi again,\n\n${words(30)}.\n\nSam` }] };

function apis() {
  return fakeFetch([
    [/^https:\/\/bright\.test\//, () => new Response(GOOD, { headers: { 'content-type': 'text/html' } })],
    [/^https:\/\/slow\.test\//, () => new Response(POOR, { headers: { 'content-type': 'text/html' } })],
    [/api\.openai\.com/, (_u, init) => {
      const input = String(JSON.parse(String(init.body)).input);
      return { output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify(input.includes('<results>') ? AUDIT_AI : SEQ) }] }] };
    }],
    [/slack\.com/, () => ({ ok: true })],
  ]);
}
const deps = (f: ReturnType<typeof apis>): Deps => ({ store: t.store, models: { openai: 'o', anthropic: null, gemini: 'g' }, fetchImpl: f.impl, resolve: async () => ['93.184.216.34'], appUrl: 'https://app.example.com' });
const run = async (f: ReturnType<typeof apis>, type: string) => {
  await t.db.query(`delete from agent_jobs where campaign_id = $1 and status = 'queued'`, [c]);
  await t.db.query(`insert into agent_jobs (workspace_id, campaign_id, type) values ($1, $2, $3)`, [t.wsA, c, type]);
  await runQueuedJobs(deps(f), 1);
  return (await t.db.query(`select * from agent_jobs where campaign_id = $1 and type = $2 order by created_at desc limit 1`, [c, type])).rows[0];
};
const audits = async () => (await t.db.query(`select lead_id, status, score, share_token, web_url, content, error from assets where campaign_id = $1 and type = 'audit'`, [c])).rows;

describe('website audits', () => {
  beforeAll(async () => {
    t = await startTestDb(55442);
    for (const [tool, secret] of [['openai', { api_key: 'sk-AUD' }], ['slack', { bot_token: 'xoxb-AUD' }]] as const) {
      await asUser(t.db, USERS.ownerA, (tx: any) => tx.query('select integration_connect($1, $2, $3::jsonb)', [t.wsA, tool, JSON.stringify(secret)]));
    }
    await t.db.query(`update workspaces set slack_channel = '#hot' where id = $1`, [t.wsA]);
    c = (await t.db.query(`insert into campaigns (workspace_id, name, niche, offer, status, audit_enabled, follow_up_count, sender_name, score_threshold)
      values ($1, 'Austin', 'dentists', 'Booking automation', 'active', true, 1, 'Sam', 60) returning id`, [t.wsA])).rows[0].id;
    const mk = async (name: string, domain: string | null, score: number, rating: number | null = null) => {
      const company = (await t.db.query(`insert into companies (workspace_id, campaign_id, name, domain, google_rating, google_reviews) values ($1,$2,$3,$4,$5,$6) returning id`,
        [t.wsA, c, `${name} Dental`, domain, rating, rating === null ? null : 140])).rows[0].id;
      return (await t.db.query(`insert into leads (workspace_id, campaign_id, company_id, email, full_name, score, stage, source_channel, verification_status, researched_at)
        values ($1,$2,$3,$4,$5,$6,'new','google_maps','valid',now()) returning id`, [t.wsA, c, company, `${name.toLowerCase()}@dental.test`, `${name} Owner`, score])).rows[0].id;
    };
    ids.bright = await mk('Bright', 'bright.test', 90, 4.8);
    ids.slow = await mk('Slow', 'slow.test', 80);
    ids.none = await mk('None', null, 85);
    ids.low = await mk('Low', 'bright.test2', 30);
  });
  afterAll(async () => { await t?.close(); });

  test('AJ-01 qualified leads get an audit measured from their own site; leads without a site are noted', async () => {
    const f = apis();
    const j = await run(f, 'audit_reports');
    expect(j.result).toMatchObject({ audits: 2, without_website: 1, written_by_ai: 1, failed: 0 });
    const rows = await audits();
    expect(rows).toHaveLength(3);
    const bright = rows.find((r: any) => r.lead_id === ids.bright);
    expect(bright).toMatchObject({ status: 'ready', score: 100 });
    expect(bright.share_token).toMatch(/^[0-9a-f]{48}$/);
    expect(bright.web_url).toBe(`https://app.example.com/a/${bright.share_token}`);
    expect(bright.content.recommendations).toEqual([]);
    const slow = rows.find((r: any) => r.lead_id === ids.slow);
    expect(slow.content.recommendations.map((r: any) => r.check_id)).toEqual(['booking', 'mobile']); // https passed, so that recommendation is dropped
    expect(slow.content.checks.find((x: any) => x.id === 'reviews').status).toBe('unknown');
    expect(rows.find((r: any) => r.lead_id === ids.none)).toMatchObject({ status: 'no_website', share_token: null, error: 'No website is known for this business' });
    expect(rows.some((r: any) => r.lead_id === ids.low)).toBe(false);
    expect(f.calls.filter((x) => /openai/.test(x.url))).toHaveLength(1);
  });

  test('AJ-02 a second run makes no duplicate audits; the run is followed by email writing', async () => {
    const j = await run(apis(), 'audit_reports');
    expect(j.result).toMatchObject({ audits: 0 });
    expect(await audits()).toHaveLength(3);
    expect((await t.db.query(`select count(*)::int n from agent_jobs where campaign_id = $1 and type = 'copywriting' and status = 'queued'`, [c])).rows[0].n).toBe(1);
  });

  test('AJ-03 the first email links to the audit; later emails and leads without one do not', async () => {
    const j = await run(apis(), 'copywriting');
    expect(j.result).toMatchObject({ leads_written: 3 });
    const token = (await audits()).find((r: any) => r.lead_id === ids.bright).share_token;
    const emails = async (lead: string) => (await t.db.query(`select step, body from emails where lead_id = $1 order by step`, [lead])).rows;
    const b = await emails(ids.bright);
    expect(b[0].body.endsWith(`I put together a short, free audit of Bright Dental's website and marketing: https://app.example.com/a/${token}`)).toBe(true);
    expect(b[1].body).not.toContain('/a/');
    expect((await emails(ids.none))[0].body).not.toContain('/a/');
  });

  test('AJ-04 with audits on, emails wait for the audit to be tried', async () => {
    const lead = (await t.db.query(`insert into leads (workspace_id, campaign_id, email, full_name, score, stage, source_channel, verification_status, researched_at)
      values ($1,$2,'wait@dental.test','Wait Owner',88,'new','google_maps','valid',now()) returning id`, [t.wsA, c])).rows[0].id;
    await run(apis(), 'copywriting');
    expect((await t.db.query(`select count(*)::int n from emails where lead_id = $1`, [lead])).rows[0].n).toBe(0);
  });

  test('AJ-05 when a lead opens the audit, the team is alerted once', async () => {
    const token = (await audits()).find((r: any) => r.lead_id === ids.slow).share_token;
    await t.db.query(`select audit_view($1, 0)`, [token]);
    const f = apis();
    const j = await run(f, 'audit_reports');
    expect(j.result.opened).toBe(1);
    const slack = f.calls.filter((x) => /slack/.test(x.url)).map((x) => JSON.parse(String(x.init.body)).text).join('\n');
    expect(slack).toMatch(/:eyes: \*Audit opened\*[\s\S]*Slow Owner opened their website audit \(score \d+\/100\)/);
    const g = apis();
    await run(g, 'audit_reports');
    expect(g.calls.filter((x) => /slack/.test(x.url))).toEqual([]);
  });

  test('AJ-06 with audits off, no audits are made and writing does not wait', async () => {
    await t.db.query(`update campaigns set audit_enabled = false where id = $1`, [c]);
    const lead = (await t.db.query(`insert into leads (workspace_id, campaign_id, email, full_name, score, stage, source_channel, verification_status, researched_at)
      values ($1,$2,'off@dental.test','Off Owner',88,'new','google_maps','valid',now()) returning id`, [t.wsA, c])).rows[0].id;
    expect((await run(apis(), 'audit_reports')).result.note).toBe('Website audits are off for this campaign.');
    expect((await t.db.query(`select count(*)::int n from assets where lead_id = $1`, [lead])).rows[0].n).toBe(0);
    await run(apis(), 'copywriting');
    expect((await t.db.query(`select count(*)::int n from emails where lead_id = $1`, [lead])).rows[0].n).toBe(2);
  });

  test('AJ-07 no credential is stored with audits or job results', async () => {
    const dump = JSON.stringify([(await t.db.query('select * from assets')).rows, (await t.db.query('select result, error from agent_jobs')).rows]);
    for (const s of ['sk-AUD', 'xoxb-AUD']) expect(dump).not.toContain(s);
  });
});
