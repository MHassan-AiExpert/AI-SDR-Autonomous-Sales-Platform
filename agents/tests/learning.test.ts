import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import { twoProportionP, findings, suggestions, validateSummary, allowedFigures, summaryStats, standardSummary, type LearningRow } from '../src/learning.ts';
import { copyPrompt } from '../src/copywriting.ts';
import { runQueuedJobs, type Deps } from '../src/jobs.ts';
import type { Campaign } from '../src/store.ts';
import { startTestDb, fakeFetch, asUser, USERS, type TestDb } from './harness.ts';

const row = (over: Partial<LearningRow> = {}): LearningRow => ({
  id: 'l', source_channel: 'apollo', score: 80, subject: 'Quick idea', body: 'word '.repeat(50), variant: null, positive: false, replied: false, meeting: false, won: false,
  had_audit: false, audit_opened: false, texted: false, called: false, ...over,
});
const many = (n: number, wonCount: number, over: Partial<LearningRow>) => Array.from({ length: n }, (_, i) => row({ ...over, positive: i < wonCount, replied: i < wonCount }));

describe('learning rules', () => {
  test('LL-01 the two-proportion test gives small p-values only for real differences', () => {
    expect(twoProportionP(20, 100, 5, 100)).toBeLessThan(0.005);
    expect(twoProportionP(10, 100, 10, 100)).toBe(1);
    expect(twoProportionP(0, 0, 5, 10)).toBe(1);
    expect(twoProportionP(6, 50, 4, 50)).toBeGreaterThan(0.3);
  });

  test('LL-02 only clear differences with at least 30 leads on each side become findings', () => {
    const rows = [...many(60, 15, { subject: 'Worth a look?' }), ...many(60, 3, { subject: 'Quick idea' })];
    const fs = findings(rows);
    const style = fs.filter((f) => f.dimension === 'subject_style');
    expect(style).toHaveLength(1);
    expect(style[0]).toMatchObject({ id: 'subject_style:question', direction: 'better', n: 60, rest_n: 60 });
    expect(style[0].text).toBe('Subject lines written as a question won interest 25.0% of the time (15 of 60), against 5.0% for the rest (3 of 60).');
    expect(findings([...many(20, 8, { subject: 'Worth a look?' }), ...many(20, 1, { subject: 'Quick idea' })])).toEqual([]);
    expect(findings([...many(200, 20, { subject: 'Worth a look?' }), ...many(200, 18, { subject: 'Quick idea' })])).toEqual([]);
  });

  test('LRN-26 an A/B message that clearly wins is reported, and a close one is not', () => {
    const clear = findings([...many(60, 15, { variant: 'b' }), ...many(60, 3, { variant: 'a' })])
      .filter((f) => f.dimension === 'variant');
    expect(clear).toHaveLength(1);
    expect(clear[0]).toMatchObject({ id: 'variant:b', direction: 'better', n: 60, rest_n: 60 });
    // Too few on each side, and too small a difference, are both left alone
    expect(findings([...many(20, 8, { variant: 'b' }), ...many(20, 1, { variant: 'a' })])
      .filter((f) => f.dimension === 'variant')).toEqual([]);
    expect(findings([...many(200, 20, { variant: 'b' }), ...many(200, 18, { variant: 'a' })])
      .filter((f) => f.dimension === 'variant')).toEqual([]);
    // Leads that were never in an A/B step are not counted as a group of their own
    expect(findings([...many(60, 15, { variant: null }), ...many(60, 3, { variant: null })])
      .filter((f) => f.dimension === 'variant')).toEqual([]);
  });

  test('LL-03 lessons come only from better copy findings; a weak lowest band suggests a higher threshold', () => {
    const rows = [
      ...many(60, 15, { subject: 'Worth a look?', source_channel: 'apollo', score: 85 }),
      ...many(60, 3, { subject: 'Quick idea', source_channel: 'google_maps', score: 62 }),
    ];
    const s = suggestions(findings(rows), 60);
    expect(s.map((x) => [x.kind, x.findingId, x.value])).toEqual(expect.arrayContaining([
      ['copy_guidance', 'subject_style:question', null],
      ['score_threshold', 'score_band:60', 70],
    ]));
    expect(s.some((x) => x.findingId.startsWith('source:'))).toBe(false);
    expect(s.find((x) => x.kind === 'copy_guidance')!.text).toBe('Write the first subject line as a short question.');
  });

  test('LL-04 the AI summary may use only measured figures and no links', () => {
    const rows = [...many(60, 15, { subject: 'Worth a look?' }), ...many(60, 3, { subject: 'Quick idea' })];
    const stats = summaryStats(rows);
    const allowed = allowedFigures(stats, findings(rows));
    expect(validateSummary({ summary: '120 leads were emailed and 15.0% showed interest. Question subject lines won interest 25.0% of the time against 5.0% for the rest.' }, allowed)).toMatch(/^120 leads/);
    expect(() => validateSummary({ summary: '120 leads were emailed and replies will double to 30.5% next week with this change.' }, allowed)).toThrow(/not measured: 30.5%/);
    expect(() => validateSummary({ summary: 'Read the full report at https://evil.example for every detail you need.' }, allowed)).toThrow(/links/);
    expect(standardSummary(summaryStats([]), [])).toBe('No first emails were sent in the last 90 days, so there is nothing to learn from yet.');
  });

  test('LL-05 the copywriter is given the campaign\'s lessons, and nothing when there are none', () => {
    const c = { sender_name: 'Sam', offer: 'Booking', niche: 'dentists', icp: null, learned_guidance: ['Keep the first email under 60 words.'] } as unknown as Campaign;
    const lead = { id: 'l', full_name: 'Kim', title: null, email: 'k@x.test', company_name: 'Bright', ai_report: {}, audit_token: null };
    expect(copyPrompt(c, lead, null, 2, 3)).toContain("Lessons from this campaign's own results (follow them unless they conflict with your rules):\n- Keep the first email under 60 words.");
    expect(copyPrompt({ ...c, learned_guidance: [] } as Campaign, lead, null, 2, 3)).not.toContain('Lessons');
  });
});

// ---------------------------------------------------------------- end to end

let t: TestDb;
let c = '';
let summaryText = '';
const words = (n: number) => Array.from({ length: n }, (_, i) => ['clinics', 'patients', 'bookings', 'calls', 'week'][i % 5]).join(' ');
const SEQ = { emails: [{ subject: 'Quick idea for your clinic', body: `Hi there,\n\n${words(40)}.\n\nSam` }, { subject: 'Following up', body: `Hi again,\n\n${words(30)}.\n\nSam` }] };

function apis() {
  return fakeFetch([
    [/api\.openai\.com/, (_u, init) => {
      const input = String(JSON.parse(String(init.body)).input);
      return { output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify(input.includes('<figures>') ? { summary: summaryText } : SEQ) }] }] };
    }],
    [/slack\.com/, () => ({ ok: true })],
  ]);
}
const deps = (f: ReturnType<typeof apis>): Deps => ({ store: t.store, models: { openai: 'o', anthropic: null, gemini: 'g' }, fetchImpl: f.impl, appUrl: 'https://app.example.com' });
const run = async (f: ReturnType<typeof apis>, type = 'learning') => {
  await t.db.query(`delete from agent_jobs where campaign_id = $1 and status = 'queued'`, [c]);
  await t.db.query(`insert into agent_jobs (workspace_id, campaign_id, type) values ($1, $2, $3)`, [t.wsA, c, type]);
  await runQueuedJobs(deps(f), 1);
  return (await t.db.query(`select * from agent_jobs where campaign_id = $1 and type = $2 order by created_at desc limit 1`, [c, type])).rows[0];
};
const slackText = (f: ReturnType<typeof apis>) => f.calls.filter((x) => /slack/.test(x.url)).map((x) => JSON.parse(String(x.init.body)).text).join('\n');

describe('weekly learning', () => {
  beforeAll(async () => {
    t = await startTestDb(55443);
    for (const [tool, secret] of [['openai', { api_key: 'sk-LRN' }], ['slack', { bot_token: 'xoxb-LRN' }]] as const) {
      await asUser(t.db, USERS.ownerA, (tx: any) => tx.query('select integration_connect($1, $2, $3::jsonb)', [t.wsA, tool, JSON.stringify(secret)]));
    }
    await t.db.query(`update workspaces set slack_channel = '#hot' where id = $1`, [t.wsA]);
    c = (await t.db.query(`insert into campaigns (workspace_id, name, niche, offer, status, follow_up_count, sender_name, score_threshold)
      values ($1, 'Austin', 'dentists', 'Booking automation', 'active', 1, 'Sam', 60) returning id`, [t.wsA])).rows[0].id;
    // 60 leads got a question subject (15 positive replies), 60 a statement (3 positive)
    await t.db.query(`
      with l as (
        insert into leads (workspace_id, campaign_id, email, score, stage, source_channel)
        select $1, $2, 'lead' || g || '@dental.test', 80, 'contacted', 'apollo' from generate_series(1, 120) g
        returning id, email
      ), e as (
        insert into emails (workspace_id, lead_id, campaign_id, step, subject, body, status, sent_at, idempotency_key)
        select $1, l.id, $2, 1, case when split_part(split_part(l.email, '@', 1), 'lead', 2)::int <= 60 then 'Worth a look?' else 'Quick idea' end,
               'Hi there, a short note about bookings.', 'sent', now() - interval '20 days', l.id || ':1'
        from l returning lead_id, subject
      )
      insert into replies (workspace_id, lead_id, campaign_id, channel, body, classification)
      select $1, e.lead_id, $2, 'email', 'Tell me more', 'interested' from e
      join l on l.id = e.lead_id
      where (e.subject = 'Worth a look?' and split_part(split_part(l.email, '@', 1), 'lead', 2)::int <= 15)
         or (e.subject = 'Quick idea' and split_part(split_part(l.email, '@', 1), 'lead', 2)::int between 61 and 63)`, [t.wsA, c]);
  });
  afterAll(async () => { await t?.close(); });

  test('LJ-01 the weekly run measures what worked, proposes a lesson and tells the team', async () => {
    summaryText = '120 leads were emailed and 15.0% showed interest. Subject lines written as a question won interest 25.0% of the time, against 5.0% for the rest.';
    const f = apis();
    const j = await run(f);
    expect(j.result).toMatchObject({ leads: 120, findings: 1, suggestions: 1, applied: 0, summary_by_ai: true });
    const r = (await t.db.query(`select summary, findings, stats from learning_reports where campaign_id = $1`, [c])).rows[0];
    expect(r.summary).toBe(summaryText);
    expect(r.findings[0]).toMatchObject({ id: 'subject_style:question', direction: 'better', n: 60, rest_n: 60 });
    expect(r.stats).toMatchObject({ leads_emailed: 120, positive: 18, min_group: 30 });
    const s = (await t.db.query(`select kind, text, status, evidence from learning_suggestions where campaign_id = $1`, [c])).rows;
    expect(s).toEqual([{ kind: 'copy_guidance', text: 'Write the first subject line as a short question.', status: 'proposed', evidence: r.findings[0].text }]);
    expect(slackText(f)).toMatch(/:brain: \*Weekly learning\* \(Austin\)[\s\S]*1 suggestion is waiting for you: <https:\/\/app\.example\.com\/w\/[0-9a-f-]+\/learning\|Review>/);
    expect((await t.db.query('select learned_guidance from campaigns where id = $1', [c])).rows[0].learned_guidance).toEqual([]);
  });

  test('LJ-02 a waiting lesson is not suggested again', async () => {
    const j = await run(apis());
    expect(j.result).toMatchObject({ suggestions: 0 });
    expect((await t.db.query(`select count(*)::int n from learning_suggestions where campaign_id = $1`, [c])).rows[0].n).toBe(1);
  });

  test('LJ-03 an AI summary with a figure that was not measured is replaced by the standard one', async () => {
    summaryText = 'Results will double to 40.0% next month if you follow this advice closely.';
    const j = await run(apis());
    expect(j.result.summary_by_ai).toBe(false);
    const r = (await t.db.query(`select summary from learning_reports where campaign_id = $1 order by created_at desc limit 1`, [c])).rows[0];
    expect(r.summary).toMatch(/^120 leads were emailed in the last 90 days: 15\.0% replied and 15\.0% showed interest or booked a meeting\. One clear pattern stood out: Subject lines written as a question/);
  });

  test('LJ-04 with auto-apply on, lessons go straight to the copywriter', async () => {
    await t.db.query(`update learning_suggestions set status = 'dismissed' where campaign_id = $1`, [c]);
    await t.db.query(`update campaigns set learning_auto_apply = true where id = $1`, [c]);
    const f = apis();
    const j = await run(f);
    expect(j.result).toMatchObject({ suggestions: 1, applied: 1 });
    expect((await t.db.query('select learned_guidance from campaigns where id = $1', [c])).rows[0].learned_guidance).toEqual(['Write the first subject line as a short question.']);
    expect(slackText(f)).toMatch(/1 new lesson was applied to the copywriter\./);
  });

  test('LJ-05 the copywriter writes with the lessons', async () => {
    await t.db.query(`insert into leads (workspace_id, campaign_id, email, full_name, score, stage, source_channel, verification_status, researched_at) values ($1,$2,'new@dental.test','New Owner',88,'new','google_maps','valid',now())`, [t.wsA, c]);
    const f = apis();
    expect((await run(f, 'copywriting')).status).toBe('succeeded');
    const input = String(JSON.parse(String(f.calls.find((x) => /openai/.test(x.url))!.init.body)).input);
    expect(input).toContain("Lessons from this campaign's own results");
    expect(input).toContain('- Write the first subject line as a short question.');
  });

  test('LJ-06 a campaign with no emails yet gets a plain report and no alert', async () => {
    const other = (await t.db.query(`insert into campaigns (workspace_id, name, niche, status) values ($1, 'Empty', 'dentists', 'active') returning id`, [t.wsA])).rows[0].id;
    await t.db.query(`insert into agent_jobs (workspace_id, campaign_id, type) values ($1, $2, 'learning')`, [t.wsA, other]);
    const f = apis();
    await runQueuedJobs(deps(f), 1);
    expect((await t.db.query(`select summary from learning_reports where campaign_id = $1`, [other])).rows[0].summary).toBe('No first emails were sent in the last 90 days, so there is nothing to learn from yet.');
    expect(f.calls).toEqual([]);
  });
});
