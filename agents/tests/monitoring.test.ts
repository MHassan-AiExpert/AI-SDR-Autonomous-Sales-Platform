import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { inQuietHours, localDay, localHour, notify, plainText } from '../src/notify.ts';
import { checkRates, monitorWorkspace, runMonitoring, summaryText } from '../src/monitoring.ts';
import { isTransient, runQueuedJobs, type Deps } from '../src/jobs.ts';
import { ProviderError } from '../src/http.ts';
import { JobError } from '../src/jobs.ts';
import { startTestDb, fakeFetch, asUser, USERS, type TestDb } from './harness.ts';

describe('notification rules', () => {
  test('NT-01 Slack text becomes plain in-app text', () => {
    expect(plainText(':calendar: *Meeting booked*: Kim Lee (Bright &amp; Co), Tue, 01 Dec 2026 15:30 UTC <https://app.example.com/w/x/leads/y|Open lead>'))
      .toBe('Meeting booked: Kim Lee (Bright & Co), Tue, 01 Dec 2026 15:30 UTC');
    expect(plainText('*Austin*: a reply needs you\n• Kim: interested')).toBe('Austin: a reply needs you\n• Kim: interested');
  });

  test('NT-02 quiet hours work across midnight and in the workspace time zone', () => {
    expect(inQuietHours(20, 8, 22)).toBe(true);
    expect(inQuietHours(20, 8, 7)).toBe(true);
    expect(inQuietHours(20, 8, 8)).toBe(false);
    expect(inQuietHours(12, 14, 13)).toBe(true);
    expect(inQuietHours(null, null, 3)).toBe(false);
    const at = new Date('2026-11-13T20:30:00Z');
    expect(localHour('Asia/Karachi', at)).toBe(1);
    expect(localDay('Asia/Karachi', at)).toBe('2026-11-14');
    expect(localHour('Not/AZone', at)).toBe(20);
  });

  test('NT-03 only a high rate over at least 50 emails pauses a campaign', () => {
    expect(checkRates(40, 10, 0, 5, 3).pause).toBe(false);
    expect(checkRates(200, 9, 0, 5, 3).pause).toBe(false);
    expect(checkRates(200, 10, 0, 5, 3)).toMatchObject({ pause: true, reason: 'Bounce rate 5.0% over the last 7 days (10 of 200 emails) reached the 5% limit' });
    expect(checkRates(100, 0, 3, 5, 3)).toMatchObject({ pause: true, reason: 'Opt-out rate 3.0% over the last 7 days (3 of 100 emails) reached the 3% limit' });
  });

  test('NT-04 only outages, timeouts and rate limits are retried', () => {
    expect(isTransient(new ProviderError('X', null, 'Could not reach X'))).toBe(true);
    expect(isTransient(new ProviderError('X', 503, 'down'))).toBe(true);
    expect(isTransient(new ProviderError('X', 429, 'slow down'))).toBe(true);
    expect(isTransient(new ProviderError('X', 401, 'bad key'))).toBe(false);
    expect(isTransient(new ProviderError('X', 400, 'bad input'))).toBe(false);
    expect(isTransient(new JobError('Connect OpenAI'))).toBe(false);
  });

  test('NT-05 the daily summary lists the day and warns about failures', () => {
    const t = summaryText('Acme *Co*', { leads: 12, emails: 40, replies: 5, positive: 2, calls: 3, meetings: 1, won: 0, failed: 2 });
    expect(t).toBe(':sunrise: *Daily summary* (Acme Co), last 24 hours\n• 12 new leads, 40 emails sent, 3 calls\n• 5 replies, 2 positive\n• 1 meetings booked, 0 deals won\n• :warning: 2 agent tasks failed. See the campaign task history.');
  });
});

// ---------------------------------------------------------------- end to end

let t: TestDb;
let c = '';
let slackOk = true;
const apis = () => fakeFetch([
  [/slack\.com/, () => (slackOk ? { ok: true } : { ok: false, error: 'channel_not_found' })],
  [/api\.openai\.com/, () => new Response('{}', { status: 503 })],
]);
const deps = (f: ReturnType<typeof apis>): Deps => ({ store: t.store, models: { openai: 'o', anthropic: null, gemini: 'g' }, fetchImpl: f.impl, appUrl: 'https://app.example.com' });
const slackTexts = (f: ReturnType<typeof apis>) => f.calls.filter((x) => /slack/.test(x.url)).map((x) => JSON.parse(String(x.init.body)).text as string);
const notes = async () => (await t.db.query(`select event, severity, title, body, slack_status, link_path, dedupe_key from notifications where workspace_id = $1 order by created_at`, [t.wsA])).rows;

describe('notifications and monitoring', () => {
  beforeAll(async () => {
    t = await startTestDb(55445);
    for (const [tool, secret] of [['slack', { bot_token: 'xoxb-MON' }], ['openai', { api_key: 'sk-MON' }]] as const) {
      await asUser(t.db, USERS.ownerA, (tx: any) => tx.query('select integration_connect($1, $2, $3::jsonb)', [t.wsA, tool, JSON.stringify(secret)]));
    }
    await t.db.query(`update workspaces set slack_channel = '#sales' where id = $1`, [t.wsA]);
    c = (await t.db.query(`insert into campaigns (workspace_id, name, niche, status, outreach_status, instantly_campaign_id, instantly_state)
      values ($1, 'Austin', 'dentists', 'active', 'live', 'inst-1', 'active') returning id`, [t.wsA])).rows[0].id;
  });
  afterAll(async () => { await t?.close(); });
  beforeEach(async () => { slackOk = true; });

  test('MN-01 an alert is kept in the app and posted to Slack once', async () => {
    const f = apis();
    const n = { event: 'meeting_booked' as const, slack: ':calendar: *Meeting booked*: Kim', dedupe: 'meeting:1' };
    expect(await notify(t.store, t.wsA, n, f.impl)).toEqual({ status: 'sent' });
    expect(await notify(t.store, t.wsA, n, f.impl)).toEqual({ status: 'duplicate' });
    expect(slackTexts(f)).toEqual([':calendar: *Meeting booked*: Kim']);
    expect((await notes())[0]).toMatchObject({ event: 'meeting_booked', title: 'Meeting booked', body: 'Meeting booked: Kim', slack_status: 'sent', link_path: `/w/${t.wsA}/notifications` });
  });

  test('MN-02 events switched off for Slack stay in the app only', async () => {
    await t.db.query(`update workspaces set notify_slack_events = array['handoff'] where id = $1`, [t.wsA]);
    const f = apis();
    expect(await notify(t.store, t.wsA, { event: 'audit_opened', slack: 'x' }, f.impl)).toEqual({ status: 'off' });
    expect(f.calls).toHaveLength(0);
    await t.db.query(`update workspaces set notify_slack_events = default where id = $1`, [t.wsA]);
  });

  test('MN-03 quiet hours hold alerts until they end; critical alerts go straight through', async () => {
    await t.db.query(`update workspaces set notify_quiet_start = 20, notify_quiet_end = 8, notify_timezone = 'UTC' where id = $1`, [t.wsA]);
    const night = new Date('2026-11-13T23:00:00Z');
    const f = apis();
    expect(await notify(t.store, t.wsA, { event: 'hot_reply', slack: 'Night reply' }, f.impl, night)).toEqual({ status: 'held' });
    expect(await notify(t.store, t.wsA, { event: 'system_alert', severity: 'critical', slack: 'Emails paused' }, f.impl, night)).toEqual({ status: 'sent' });
    expect(slackTexts(f)).toEqual(['Emails paused']);
    // Still night: the monitor keeps holding
    await monitorWorkspace(deps(f), t.wsA, night);
    expect(slackTexts(f)).toEqual(['Emails paused']);
    const morning = new Date('2026-11-14T08:05:00Z');
    const s = await monitorWorkspace(deps(f), t.wsA, morning);
    expect(s.held_sent).toBe(1);
    expect(slackTexts(f)).toContain('Night reply _(held during quiet hours)_');
    await t.db.query(`update workspaces set notify_quiet_start = null, notify_quiet_end = null where id = $1`, [t.wsA]);
  });

  test('MN-04 a Slack failure is recorded and never stops the work', async () => {
    slackOk = false;
    const r = await notify(t.store, t.wsA, { event: 'deal_won', slack: 'Won' }, apis().impl);
    expect(r).toEqual({ status: 'failed', error: 'Add the Slack app to the alert channel, or check the channel name in Settings' });
    expect((await notes()).at(-1)).toMatchObject({ slack_status: 'failed' });
  });

  test('MN-05 a high bounce rate pauses the campaign emails, queues the Instantly pause and alerts once', async () => {
    await t.db.query(`
      with l as (insert into leads (workspace_id, campaign_id, email, source_channel, stage)
                 select $1, $2, 'b' || g || '@x.test', 'apollo', 'contacted' from generate_series(1, 60) g returning id, email)
      insert into emails (workspace_id, lead_id, campaign_id, step, subject, body, status, sent_at, idempotency_key)
      select $1, l.id, $2, 1, 'Hi', 'Hello', case when split_part(split_part(l.email, '@', 1), 'b', 2)::int <= 6 then 'bounced' else 'sent' end, now() - interval '2 hours', l.id || ':1'
      from l`, [t.wsA, c]);
    const f = apis();
    const s = await monitorWorkspace(deps(f), t.wsA);
    expect(s.paused).toBe(1);
    const camp = (await t.db.query(`select outreach_status, auto_paused_reason from campaigns where id = $1`, [c])).rows[0];
    expect(camp).toEqual({ outreach_status: 'paused', auto_paused_reason: 'Bounce rate 10.0% over the last 7 days (6 of 60 emails) reached the 5% limit' });
    expect((await t.db.query(`select count(*)::int n from agent_jobs where campaign_id = $1 and type = 'email_outreach' and status = 'queued'`, [c])).rows[0].n).toBe(1);
    expect(slackTexts(f).find((x) => x.includes('Emails paused'))).toMatch(/:octagonal_sign: \*Emails paused\* \(Austin\): Bounce rate 10\.0%.*<https:\/\/app\.example\.com\/w\/[0-9a-f-]+\/campaigns\/[0-9a-f-]+\|Open campaign>/);
    expect((await notes()).find((n: { dedupe_key: string | null }) => n.dedupe_key?.startsWith('autopause:'))).toMatchObject({ event: 'system_alert', severity: 'critical', title: 'Emails paused: Austin' });
    expect((await monitorWorkspace(deps(apis()), t.wsA)).paused).toBe(0);
  });

  test('MN-06 broken integrations and low credits are alerted once a day', async () => {
    await t.db.query(`update integrations set status = 'expired', last_error = 'Slack rejected the stored credentials' where workspace_id = $1 and tool = 'openai'`, [t.wsA]);
    await t.db.query(`update integrations set credits_remaining = 40 where workspace_id = $1 and tool = 'slack'`, [t.wsA]);
    const f = apis();
    const s = await monitorWorkspace(deps(f), t.wsA);
    expect(s).toMatchObject({ integration_alerts: 1, credit_alerts: 1 });
    const texts = slackTexts(f);
    expect(texts).toContain(`:warning: *OpenAI is not working*: Slack rejected the stored credentials. Reconnect it in Setup. <https://app.example.com/w/${t.wsA}/setup|Open Setup>`);
    expect(texts).toContain(`:battery: *Slack credits are low*: 40 left. Top up so the agents keep working. <https://app.example.com/w/${t.wsA}/setup|Open Setup>`);
    expect(await monitorWorkspace(deps(apis()), t.wsA)).toMatchObject({ integration_alerts: 0, credit_alerts: 0 });
    await t.db.query(`update integrations set status = 'connected', last_error = null, credits_remaining = null where workspace_id = $1`, [t.wsA]);
  });

  test('MN-07 tasks stuck in the queue raise an alert', async () => {
    await t.db.query(`update agent_jobs set created_at = now() - interval '20 minutes' where campaign_id = $1 and status = 'queued'`, [c]);
    const f = apis();
    expect((await monitorWorkspace(deps(f), t.wsA)).queue_alerts).toBe(1);
    expect(slackTexts(f)).toContain(':hourglass: *Agent tasks are waiting*: 1 task has waited more than 15 minutes. The agent service may be down.');
    await t.db.query(`delete from agent_jobs where campaign_id = $1`, [c]);
  });

  test('MN-08 the daily summary goes out once, from 8am in the workspace time zone', async () => {
    await t.db.query(`update workspaces set notify_timezone = 'Asia/Karachi' where id = $1`, [t.wsA]);
    const early = new Date('2026-11-14T01:00:00Z'); // 6am in Karachi
    expect((await monitorWorkspace(deps(apis()), t.wsA, early)).summary).toBe(false);
    const f = apis();
    const nine = new Date('2026-11-14T04:00:00Z'); // 9am in Karachi
    expect((await monitorWorkspace(deps(f), t.wsA, nine)).summary).toBe(true);
    expect(slackTexts(f).find((x) => x.startsWith(':sunrise:'))).toMatch(/^:sunrise: \*Daily summary\* \(Company A\), last 24 hours\n• 60 new leads, 60 emails sent/);
    expect((await monitorWorkspace(deps(apis()), t.wsA, new Date('2026-11-14T10:00:00Z'))).summary).toBe(false);
  });

  test('MN-11 the readiness numbers count only tasks that should have run', async () => {
    const q = await t.store.queueHealth();
    expect(q).toMatchObject({ stuck: 0 });
    await t.db.query(`insert into agent_jobs (workspace_id, campaign_id, type, created_at) values ($1, $2, 'research', now() - interval '30 minutes')`, [t.wsA, c]);
    expect(await t.store.queueHealth()).toMatchObject({ stuck: 1 });
    await t.db.query(`delete from agent_jobs where campaign_id = $1 and type = 'research'`, [c]);
  });

  test('MN-09 the sweep checks each workspace at most every 15 minutes', async () => {
    await t.db.query(`update workspaces set monitored_at = null`);
    expect(await runMonitoring(deps(apis()))).toBe(2);
    expect(await runMonitoring(deps(apis()))).toBe(0);
  });

  test('MN-10 a provider outage is retried with a wait; a final failure alerts the team', async () => {
    await t.db.query(`insert into agent_jobs (workspace_id, campaign_id, type) values ($1, $2, 'campaign_plan')`, [t.wsA, c]);
    const f = apis();
    const first = await runQueuedJobs(deps(f), 1);
    expect(first[0].status).toBe('retrying');
    let j = (await t.db.query(`select status, attempts, run_after > now() + interval '90 seconds' as waits, error from agent_jobs where campaign_id = $1 and type = 'campaign_plan'`, [c])).rows[0];
    expect(j).toMatchObject({ status: 'queued', attempts: 1, waits: true });
    // Not claimed before its wait is over
    expect(await runQueuedJobs(deps(f), 1)).toEqual([]);
    for (const attempt of [2, 3]) {
      await t.db.query(`update agent_jobs set run_after = now() - interval '1 second' where campaign_id = $1 and type = 'campaign_plan'`, [c]);
      const out = await runQueuedJobs(deps(f), 1);
      expect(out[0].status).toBe(attempt === 3 ? 'failed' : 'retrying');
    }
    j = (await t.db.query(`select status, attempts from agent_jobs where campaign_id = $1 and type = 'campaign_plan'`, [c])).rows[0];
    expect(j).toEqual({ status: 'failed', attempts: 3 });
    expect(slackTexts(f).filter((x) => x.startsWith(':x: *Campaign planning failed* (Austin)'))).toHaveLength(1);
    expect((await notes()).at(-1)).toMatchObject({ event: 'system_alert', title: 'Campaign planning failed', link_path: `/w/${t.wsA}/campaigns/${c}` });
  });
});
