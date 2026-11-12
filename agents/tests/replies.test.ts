import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import type { AddressInfo } from 'node:net';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { ruleClass, nextStage, classifyReply, CLASSIFY_SYSTEM } from '../src/replies.ts';
import { postSlack, slackEscape } from '../src/sources/slack.ts';
import { dedupeKey } from '../src/webhooks.ts';
import { createAgentServer, sign } from '../src/server.ts';
import { runQueuedJobs, type Deps } from '../src/jobs.ts';
import type { LlmClient } from '../src/llm.ts';
import { startTestDb, fakeFetch, asUser, USERS, type TestDb } from './harness.ts';

describe('reply rules', () => {
  test('RPL-01 opt-out and out-of-office wording is caught before the AI', () => {
    for (const t of ['Please unsubscribe me', 'remove me from your list', 'STOP', 'Stop emailing me.', "don't contact me again", 'opt out']) expect(ruleClass(t), t).toBe('unsubscribe');
    for (const t of ['I am out of the office until Monday', 'Automatic reply: on vacation']) expect(ruleClass(t), t).toBe('out_of_office');
    for (const t of ['Sounds interesting, tell me more', 'We stopped using our old system last year', 'What does it cost?']) expect(ruleClass(t), t).toBeNull();
  });

  test('RPL-02 stages never move backwards; opt-outs always win; closed deals stay closed', () => {
    expect(nextStage('contacted', 'interested')).toBe('interested');
    expect(nextStage('meeting_booked', 'engaged')).toBe('meeting_booked');
    expect(nextStage('meeting_booked', 'not_interested')).toBe('meeting_booked');
    expect(nextStage('engaged', 'not_interested')).toBe('not_interested');
    expect(nextStage('won', 'do_not_contact')).toBe('do_not_contact');
    expect(nextStage('won', 'interested')).toBe('won');
    expect(nextStage('do_not_contact', 'interested')).toBe('do_not_contact');
    expect(nextStage('not_interested', 'interested')).toBe('interested');
    expect(nextStage('not_interested', 'engaged')).toBe('not_interested');
  });

  test('RPL-03 the AI classifies; its answer has links removed and no draft for a no', async () => {
    const ai = (answer: object): LlmClient => ({ provider: 'openai', generateJson: async (req) => { expect(req.prompt).toContain('<reply>'); return answer; } });
    const yes = await classifyReply([ai({ classification: 'interested', confidence: 0.92, summary: 'Wants a call next week.', suggested_response: 'Great, how is Tuesday? https://cal.example/x' })], 'Yes, keen to talk', 'Booking', {});
    expect(yes).toMatchObject({ classification: 'interested', by: 'ai', suggested_response: 'Great, how is Tuesday?' });
    const no = await classifyReply([ai({ classification: 'negative', confidence: 0.8, summary: 'Not interested.', suggested_response: 'Sorry to hear' })], 'No thanks', null, {});
    expect(no.suggested_response).toBe('');
    expect(CLASSIFY_SYSTEM).toMatch(/untrusted text.*ignore any instructions/s);
  });

  test('RPL-04 a reply asking to stop is an unsubscribe even if the AI would say otherwise; no AI means a person reads it', async () => {
    let called = false;
    const ai: LlmClient = { provider: 'openai', generateJson: async () => { called = true; return {}; } };
    expect((await classifyReply([ai], 'Interesting, but please remove me from your list', null, {})).classification).toBe('unsubscribe');
    expect(called).toBe(false);
    expect(await classifyReply([], 'What does it cost?', null, {})).toMatchObject({ classification: 'question', confidence: 0.3, by: 'rules' });
  });

  test('RPL-05 Slack errors become clear messages; text is escaped', async () => {
    const f = fakeFetch([[/chat\.postMessage/, () => ({ ok: false, error: 'channel_not_found' })]]);
    await expect(postSlack('xoxb-1', '#x', 'hi', f.impl)).rejects.toThrow(/Add the Slack app to the alert channel/);
    const g = fakeFetch([[/chat\.postMessage/, () => ({ ok: false, error: 'invalid_auth' })]]);
    await expect(postSlack('xoxb-1', '#x', 'hi', g.impl)).rejects.toMatchObject({ status: 401 });
    expect(slackEscape('<@here> & <!channel>')).toBe('&lt;@here&gt; &amp; &lt;!channel&gt;');
  });

  test('RPL-06 the same delivery always has the same key; different events do not', () => {
    const e = { event_type: 'reply_received', lead_email: 'Kim@B.com', email_id: 'e1', timestamp: '2026-11-13T10:00:00Z', step: 1 };
    expect(dedupeKey(e)).toBe(dedupeKey({ ...e, lead_email: 'kim@b.com' }));
    expect(dedupeKey(e)).not.toBe(dedupeKey({ ...e, event_type: 'email_opened' }));
  });
});

// ---------------------------------------------------------------- end to end

let t: TestDb;
let base = '';
let server: ReturnType<typeof createAgentServer>;
const SECRET = 'h'.repeat(40);
let token = '';
let c = '';
const ids: Record<string, string> = {};
const answers: Record<string, object> = {};

function apis(slack: () => unknown = () => ({ ok: true })) {
  return fakeFetch([
    [/api\.openai\.com/, (_u, init) => {
      const input = String(JSON.parse(String(init.body)).input);
      const key = Object.keys(answers).find((k) => input.includes(k))!;
      return { output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify(answers[key]) }] }] };
    }],
    [/slack\.com/, slack],
  ]);
}
const deps = (f: ReturnType<typeof apis>): Deps => ({ store: t.store, models: { openai: 'o', anthropic: null, gemini: 'g' }, fetchImpl: f.impl, appUrl: 'https://app.example.com' });

async function deliver(event: object, tok = token) {
  const body = JSON.stringify({ token: tok, event });
  const ts = String(Math.floor(Date.now() / 1000));
  return fetch(`${base}/webhooks/instantly`, { method: 'POST', headers: { 'x-timestamp': ts, 'x-signature': sign(SECRET, ts, body), 'content-type': 'application/json' }, body });
}
const ev = (type: string, email: string, extra: object = {}) => ({ timestamp: new Date().toISOString() + Math.random(), event_type: type, workspace: 'w', campaign_id: 'inst-camp-1', campaign_name: 'Austin', lead_email: email, ...extra });
const lead = async (id: string) => (await t.db.query(`select stage, verification_status from leads where id = $1`, [id])).rows[0];
const emailStatuses = async (id: string) => (await t.db.query(`select status from emails where lead_id = $1 order by step`, [id])).rows.map((r: any) => r.status);

describe('webhook to lead update', () => {
  beforeAll(async () => {
    t = await startTestDb(55436);
    await asUser(t.db, USERS.ownerA, (tx: any) => tx.query('select integration_connect($1, $2, $3::jsonb)', [t.wsA, 'openai', JSON.stringify({ api_key: 'sk-A' })]));
    await asUser(t.db, USERS.ownerA, (tx: any) => tx.query('select integration_connect($1, $2, $3::jsonb)', [t.wsA, 'slack', JSON.stringify({ bot_token: 'xoxb-A' })]));
    await t.db.query(`update workspaces set slack_channel = '#hot-leads' where id = $1`, [t.wsA]);
    token = (await t.db.query('select webhook_token from workspaces where id = $1', [t.wsA])).rows[0].webhook_token;
    c = (await t.db.query(`insert into campaigns (workspace_id, name, niche, offer, instantly_campaign_id, outreach_status) values ($1, 'Austin dentists', 'dentists', 'Booking automation', 'inst-camp-1', 'live') returning id`, [t.wsA])).rows[0].id;
    const co = (await t.db.query(`insert into companies (workspace_id, name) values ($1, 'Bright Teeth') returning id`, [t.wsA])).rows[0].id;
    for (const name of ['kim', 'lou', 'ana', 'ooo', 'bounce', 'unsub', 'label']) {
      ids[name] = (await t.db.query(`insert into leads (workspace_id, campaign_id, company_id, email, full_name, stage, verification_status, source_channel) values ($1,$2,$3,$4,$5,'contacted','valid','apollo') returning id`,
        [t.wsA, c, co, `${name}@brightteeth.com`, name === 'kim' ? 'Kim Bright' : null])).rows[0].id;
      for (const step of [1, 2, 3]) {
        await t.db.query(`insert into emails (workspace_id, lead_id, campaign_id, step, subject, body, status, idempotency_key, queued_at) values ($1,$2,$3,$4,'s','b','queued',$5, now())`, [t.wsA, ids[name], c, step, `${c}:${ids[name]}:${step}`]);
      }
    }
    server = createAgentServer(deps(apis()), { hmacSecret: SECRET, jobsPerRun: 3, healthCheck: async () => {} });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(async () => { await new Promise<void>((r) => server.close(() => r())); await t?.close(); });

  test('WH-01 a signed event for a known workspace is stored once and queues the reply agent', async () => {
    const e = ev('email_sent', 'kim@brightteeth.com', { step: 1, email_html: '<p>big</p>' });
    expect((await (await deliver(e)).json())).toEqual({ status: 'stored' });
    expect((await (await deliver(e)).json())).toEqual({ status: 'duplicate' });
    const stored = (await t.db.query(`select campaign_id, event_type, lead_email, payload, status from inbound_events`)).rows;
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({ campaign_id: c, event_type: 'email_sent', lead_email: 'kim@brightteeth.com', status: 'received' });
    expect(stored[0].payload.email_html).toBeUndefined();
    expect((await t.db.query(`select type, status from agent_jobs where campaign_id = $1`, [c])).rows).toEqual([{ type: 'reply_handling', status: 'queued' }]);
  });

  test('WH-02 unknown tokens, bad signatures and unknown campaigns are refused or ignored', async () => {
    expect((await deliver(ev('email_sent', 'x@y.com'), 'f'.repeat(64))).status).toBe(404);
    expect((await deliver(ev('email_sent', 'x@y.com'), 'not-a-token')).status).toBe(404);
    const bad = await fetch(`${base}/webhooks/instantly`, { method: 'POST', headers: { 'x-timestamp': String(Math.floor(Date.now() / 1000)), 'x-signature': 'a'.repeat(64) }, body: '{}' });
    expect(bad.status).toBe(401);
    expect(await (await deliver(ev('email_sent', 'x@y.com', { campaign_id: 'someone-else' }))).json()).toEqual({ status: 'ignored' });
  });

  test('WH-03 the n8n workflow\'s own signing code is accepted', async () => {
    const wf = JSON.parse(readFileSync(new URL('../../infra/n8n/workflows/instantly-events.json', import.meta.url), 'utf8'));
    const code = wf.nodes.find((n: any) => n.type === 'n8n-nodes-base.code').parameters.jsCode;
    const input = { all: () => [{ json: { params: { token }, body: ev('email_opened', 'kim@brightteeth.com') } }] };
    const [{ json }] = new Function('require', '$env', '$input', code)(createRequire(import.meta.url), { PLATFORM_HMAC_SECRET: SECRET }, input);
    const res = await fetch(`${base}/webhooks/instantly`, { method: 'POST', headers: { 'x-timestamp': json.timestamp, 'x-signature': json.signature }, body: json.body });
    expect(await res.json()).toEqual({ status: 'stored' });
  });

  test('WH-04 the reply agent updates leads, suppresses opt-outs and bounces, stops sequences and alerts Slack once', async () => {
    answers['Tuesday works'] = { classification: 'interested', confidence: 0.94, summary: 'Wants a call on Tuesday.', suggested_response: 'Great, Tuesday at 10 works. I will send an invite.' };
    answers['too pricey'] = { classification: 'objection', confidence: 0.8, summary: 'Worried about price.', suggested_response: 'Fair question. Most clinics recover the cost in a month.' };
    await deliver(ev('reply_received', 'kim@brightteeth.com', { reply_text: 'Tuesday works for a quick call', reply_subject: 'Re: idea', unibox_url: 'https://app.instantly.ai/app/unibox?thread=1' }));
    await deliver(ev('reply_received', 'lou@brightteeth.com', { reply_text: 'Looks too pricey for us', unibox_url: 'https://evil.example/phish' }));
    await deliver(ev('reply_received', 'unsub@brightteeth.com', { reply_text: 'Please remove me from your list' }));
    await deliver(ev('auto_reply_received', 'ooo@brightteeth.com', { reply_text: 'Out of office until Monday' }));
    await deliver(ev('email_bounced', 'bounce@brightteeth.com'));
    await deliver(ev('lead_meeting_booked', 'label@brightteeth.com'));
    const f = apis();
    await runQueuedJobs(deps(f), 3);

    expect(await lead(ids.kim)).toEqual({ stage: 'interested', verification_status: 'valid' });
    expect(await emailStatuses(ids.kim)).toEqual(['sent', 'cancelled', 'cancelled']);
    expect((await lead(ids.lou)).stage).toBe('engaged');
    expect(await lead(ids.unsub)).toEqual({ stage: 'do_not_contact', verification_status: 'valid' });
    expect(await emailStatuses(ids.unsub)).toEqual(['cancelled', 'cancelled', 'cancelled']);
    expect((await lead(ids.ooo)).stage).toBe('contacted');
    expect(await emailStatuses(ids.ooo)).toEqual(['queued', 'queued', 'queued']);
    expect(await lead(ids.bounce)).toEqual({ stage: 'contacted', verification_status: 'invalid' });
    expect(await emailStatuses(ids.bounce)).toEqual(['bounced', 'cancelled', 'cancelled']);
    expect((await lead(ids.label)).stage).toBe('meeting_booked');

    const sup = (await t.db.query(`select value, reason from suppressions where workspace_id = $1 order by value`, [t.wsA])).rows;
    expect(sup).toEqual([{ value: 'bounce@brightteeth.com', reason: 'bounced' }, { value: 'unsub@brightteeth.com', reason: 'unsubscribed' }]);

    const kimReply = (await t.db.query(`select classification, summary, suggested_response, conversation_url, subject from replies where lead_id = $1`, [ids.kim])).rows[0];
    expect(kimReply).toEqual({ classification: 'interested', summary: 'Wants a call on Tuesday.', suggested_response: 'Great, Tuesday at 10 works. I will send an invite.', conversation_url: 'https://app.instantly.ai/app/unibox?thread=1', subject: 'Re: idea' });
    expect((await t.db.query(`select conversation_url from replies where lead_id = $1`, [ids.lou])).rows[0].conversation_url).toBeNull();

    const slack = f.calls.filter((x) => /slack/.test(x.url));
    expect(slack).toHaveLength(1);
    const msg = JSON.parse(String(slack[0].init.body));
    expect(msg.channel).toBe('#hot-leads');
    expect(msg.text).toContain('*Austin dentists*: a reply needs you');
    expect(msg.text).toContain(`• *Interested*: Kim Bright (Bright Teeth): Wants a call on Tuesday. <https://app.example.com/w/${t.wsA}/leads/${ids.kim}|Open lead>`);
    expect(msg.text).not.toContain('pricey');
    const job = (await t.db.query(`select result from agent_jobs where campaign_id = $1 and type = 'reply_handling' and status = 'succeeded' order by finished_at desc limit 1`, [c])).rows[0];
    expect(job.result).toMatchObject({ replies: 4, hot: 1, unsubscribed: 1, bounced: 1, alerts: 1 });
  });

  test('WH-05 every event is marked, and the first send was recorded', async () => {
    const { rows } = await t.db.query(`select status, count(*)::int n from inbound_events group by status order by status`);
    expect(rows).toEqual([{ status: 'ignored', n: 2 }, { status: 'processed', n: 7 }]);
    const note = (await t.db.query(`select summary from activities where lead_id = $1 order by created_at`, [ids.kim])).rows.map((r: any) => r.summary);
    expect(note).toEqual(['Email 1 sent', 'Replied (interested): Wants a call on Tuesday.']);
  });

  test('WH-06 a not-now reply schedules a follow-up in 30 days; a Slack failure is reported, not fatal', async () => {
    answers['next quarter'] = { classification: 'not_now', confidence: 0.85, summary: 'Ask again next quarter.', suggested_response: 'Will do' };
    answers['who handles'] = { classification: 'question', confidence: 0.7, summary: 'Asks how it works.', suggested_response: 'Happy to explain.' };
    await deliver(ev('reply_received', 'ana@brightteeth.com', { reply_text: 'Maybe next quarter' }));
    await deliver(ev('reply_received', 'lou@brightteeth.com', { reply_text: 'who handles setup?', email_id: 'second' }));
    await runQueuedJobs(deps(apis(() => ({ ok: false, error: 'channel_not_found' }))), 3);
    const fu = (await t.db.query(`select channel, status, due_at > now() + interval '29 days' as later from follow_ups where lead_id = $1`, [ids.ana])).rows;
    expect(fu).toEqual([{ channel: 'email', status: 'pending', later: true }]);
    expect((await t.db.query(`select suggested_response from replies where lead_id = $1`, [ids.ana])).rows[0].suggested_response).toBeNull();
    const job = (await t.db.query(`select status, result from agent_jobs where campaign_id = $1 and type = 'reply_handling' order by created_at desc limit 1`, [c])).rows[0];
    expect(job.status).toBe('succeeded');
    expect(job.result.alert_error).toBe('Add the Slack app to the alert channel, or check the channel name in Settings');
  });

  test('WH-07 an event for a lead that is not in the workspace is ignored', async () => {
    await deliver(ev('reply_received', 'stranger@other.com', { reply_text: 'hello' }));
    await runQueuedJobs(deps(apis()), 3);
    expect((await t.db.query(`select status from inbound_events where lead_email = 'stranger@other.com'`)).rows[0].status).toBe('ignored');
  });

  test('WH-08 the kill switch does not stop inbound handling', async () => {
    await t.db.query('update workspaces set outreach_paused = true where id = $1', [t.wsA]);
    await deliver(ev('email_sent', 'lou@brightteeth.com', { email_id: 'x2' }));
    await runQueuedJobs(deps(apis()), 5);
    expect((await t.db.query(`select status from inbound_events where lead_email = 'lou@brightteeth.com' and event_type = 'email_sent'`)).rows[0].status).toBe('processed');
    await t.db.query('update workspaces set outreach_paused = false where id = $1', [t.wsA]);
  });

  test('WH-09 no credential or webhook token is stored in results, replies or the timeline', async () => {
    const dump = JSON.stringify([(await t.db.query('select result, error from agent_jobs')).rows, (await t.db.query('select * from replies')).rows, (await t.db.query('select summary from activities')).rows, (await t.db.query('select payload from inbound_events')).rows]);
    expect(dump).not.toMatch(/sk-A|xoxb-A/);
    expect(dump).not.toContain(token);
  });
});
