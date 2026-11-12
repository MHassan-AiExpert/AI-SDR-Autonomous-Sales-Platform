import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import type { AddressInfo } from 'node:net';
import { createHmac } from 'node:crypto';
import { verifyCalendlySignature, trackedLink } from '../src/sources/calendly.ts';
import { answerHtml, replySubject } from '../src/answers.ts';
import { createAgentServer, sign } from '../src/server.ts';
import { runQueuedJobs, type Deps } from '../src/jobs.ts';
import { startTestDb, fakeFetch, asUser, USERS, type TestDb } from './harness.ts';

const calSig = (key: string, raw: string, t = Math.floor(Date.now() / 1000)) => `t=${t},v1=${createHmac('sha256', key).update(`${t}.${raw}`).digest('hex')}`;

describe('booking helpers', () => {
  test('BKU-01 Calendly signatures are checked over the timestamp and raw body, within five minutes', () => {
    const raw = '{"event":"invitee.created"}';
    expect(verifyCalendlySignature(calSig('k', raw), raw, 'k')).toBe(true);
    expect(verifyCalendlySignature(calSig('k', raw), raw + ' ', 'k')).toBe(false);
    expect(verifyCalendlySignature(calSig('other', raw), raw, 'k')).toBe(false);
    expect(verifyCalendlySignature(calSig('k', raw, Math.floor(Date.now() / 1000) - 600), raw, 'k')).toBe(false);
    expect(verifyCalendlySignature('garbage', raw, 'k')).toBe(false);
    expect(verifyCalendlySignature(undefined, raw, 'k')).toBe(false);
  });

  test('BKU-02 booking links carry the lead id; answers become safe HTML with only booking links clickable', () => {
    expect(trackedLink('https://calendly.com/d/abc-123/15min', 'lead-1')).toBe('https://calendly.com/d/abc-123/15min?utm_source=ai-sdr&utm_content=lead-1');
    const html = answerHtml('Hi <Kim>,\n\nPick a time: https://calendly.com/d/x?utm_content=1 or https://evil.example', 'Acme, 1 Main St');
    expect(html).toContain('<a href="https://calendly.com/d/x?utm_content=1">');
    expect(html).not.toContain('<a href="https://evil.example');
    expect(html).toContain('Hi &lt;Kim&gt;,');
    expect(html).toContain('Acme, 1 Main St');
    expect([replySubject('RE: Re: idea'), replySubject(null), replySubject('Quick idea')]).toEqual(['Re: idea', 'Re: our conversation', 'Re: Quick idea']);
  });
});

// ---------------------------------------------------------------- end to end

let t: TestDb;
let server: ReturnType<typeof createAgentServer>;
let base = '';
let token = '';
let c = '';
const SECRET = 'b'.repeat(40);
const ids: Record<string, string> = {};
const AI: Record<string, object> = {
  'keen to talk': { classification: 'interested', confidence: 0.95, summary: 'Wants to talk.', suggested_response: 'Great to hear, Kim. Happy to walk you through it.\n\nSam' },
  'how much': { classification: 'question', confidence: 0.9, summary: 'Asks about price.', suggested_response: 'Good question, it depends on chairs.\n\nSam' },
  'too expensive': { classification: 'objection', confidence: 0.95, summary: 'Price concern.', suggested_response: 'Understood, most clinics recover it fast.\n\nSam' },
  'maybe interested': { classification: 'interested', confidence: 0.6, summary: 'Unsure.', suggested_response: 'Happy to share more.\n\nSam' },
};

function apis(over: { instantlyReply?: () => unknown } = {}) {
  return fakeFetch([
    [/api\.openai\.com/, (_u, init) => {
      const input = String(JSON.parse(String(init.body)).input);
      return { output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify(AI[Object.keys(AI).find((k) => input.includes(k))!]) }] }] };
    }],
    [/api\.calendly\.com\/users\/me/, () => ({ resource: { uri: 'https://api.calendly.com/users/U1', current_organization: 'https://api.calendly.com/organizations/O1' } })],
    [/api\.calendly\.com\/webhook_subscriptions/, () => ({ resource: { uri: 'https://api.calendly.com/webhook_subscriptions/W1' } })],
    [/api\.calendly\.com\/event_types/, () => ({ collection: [{ uri: 'https://api.calendly.com/event_types/E1', active: true }] })],
    [/api\.calendly\.com\/scheduling_links/, () => ({ resource: { booking_url: `https://calendly.com/d/${Math.random().toString(36).slice(2, 8)}/15min`, owner: 'x', owner_type: 'EventType' } })],
    [/api\.instantly\.ai\/api\/v2\/emails\/reply/, over.instantlyReply ?? (() => ({ id: 'sent-1' }))],
    [/slack\.com/, () => ({ ok: true })],
  ]);
}
const deps = (f: ReturnType<typeof apis>): Deps => ({ store: t.store, models: { openai: 'o', anthropic: null, gemini: 'g' }, fetchImpl: f.impl, appUrl: 'https://app.example.com', webhookBaseUrl: 'https://n8n.example.com' });
const deliver = async (path: string, payload: object) => {
  const body = JSON.stringify(payload);
  const ts = String(Math.floor(Date.now() / 1000));
  return fetch(`${base}${path}`, { method: 'POST', headers: { 'x-timestamp': ts, 'x-signature': sign(SECRET, ts, body) }, body });
};
const replyEvent = (email: string, text: string, extra: object = {}) => deliver('/webhooks/instantly', {
  token, event: { timestamp: new Date().toISOString() + Math.random(), event_type: 'reply_received', campaign_id: 'inst-1', lead_email: email, reply_text: text, reply_subject: 'Re: idea', email_id: `em-${email}`, email_account: 'sam@send.co', ...extra },
});
const answer = async (lead: string) => (await t.db.query(`select answer, answer_status, answer_error, booking_url from replies where lead_id = $1 order by created_at desc limit 1`, [lead])).rows[0];
const calendlyPost = (raw: string, sig: string, tok = token) => deliver('/webhooks/calendly', { token: tok, raw, signature: sig });

describe('answers and bookings', () => {
  let f: ReturnType<typeof apis>;
  beforeAll(async () => {
    t = await startTestDb(55437);
    for (const [tool, secret] of [['openai', { api_key: 'sk-A' }], ['instantly', { api_key: 'inst-A' }], ['calendly', { access_token: 'cal-A' }], ['slack', { bot_token: 'xoxb-A' }]] as const) {
      await asUser(t.db, USERS.ownerA, (tx: any) => tx.query('select integration_connect($1, $2, $3::jsonb)', [t.wsA, tool, JSON.stringify(secret)]));
    }
    await t.db.query(`update workspaces set slack_channel = '#hot' where id = $1`, [t.wsA]);
    token = (await t.db.query('select webhook_token from workspaces where id = $1', [t.wsA])).rows[0].webhook_token;
    c = (await t.db.query(`insert into campaigns (workspace_id, name, niche, offer, instantly_campaign_id, outreach_status, sender_name, email_footer) values ($1, 'Austin', 'dentists', 'Booking automation', 'inst-1', 'live', 'Sam', 'Acme, 1 Main St. Reply stop to opt out.') returning id`, [t.wsA])).rows[0].id;
    for (const n of ['kim', 'lou', 'obj', 'unsure', 'optout', 'paused', 'nocal', 'fail']) {
      ids[n] = (await t.db.query(`insert into leads (workspace_id, campaign_id, email, full_name, stage, verification_status, source_channel) values ($1,$2,$3,$4,'contacted','valid','apollo') returning id`, [t.wsA, c, `${n}@bright.com`, n === 'kim' ? 'Kim Bright' : null])).rows[0].id;
    }
    server = createAgentServer(deps(apis()), { hmacSecret: SECRET, jobsPerRun: 5, healthCheck: async () => {} });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    await replyEvent('kim@bright.com', 'Yes, keen to talk');
    f = apis();
    await runQueuedJobs(deps(f), 5);
    await runQueuedJobs(deps(f), 5);
  });
  afterAll(async () => { await new Promise<void>((r) => server.close(() => r())); await t?.close(); });

  test('BKJ-01 an interested reply in autopilot gets a booking link and is answered in the same thread', async () => {
    const a = await answer(ids.kim);
    expect(a.answer_status).toBe('sent');
    expect(a.booking_url).toMatch(new RegExp(`^https://calendly\\.com/d/\\w+/15min\\?utm_source=ai-sdr&utm_content=${ids.kim}$`));
    expect(a.answer).toContain(`Pick a time that suits you here: ${a.booking_url}`);
    const sent = f.calls.find((x) => /emails\/reply/.test(x.url))!;
    const body = JSON.parse(String(sent.init.body));
    expect(body).toMatchObject({ eaccount: 'sam@send.co', reply_to_uuid: 'em-kim@bright.com', subject: 'Re: idea' });
    // Inside HTML the & of the link is written as &amp;, which mail clients turn back into &
    expect(body.body.html).toContain(`<a href="${a.booking_url.replace(/&/g, "&amp;")}">`);
    expect(body.body.text).toContain('Acme, 1 Main St.');
    expect((await t.db.query(`select stage from leads where id = $1`, [ids.kim])).rows[0].stage).toBe('interested');
  });

  test('BKJ-02 the Calendly webhook is registered once per workspace, with a private signing key', async () => {
    const hook = f.calls.find((x) => /webhook_subscriptions/.test(x.url))!;
    const body = JSON.parse(String(hook.init.body));
    expect(body).toMatchObject({ url: `https://n8n.example.com/webhook/calendly/${token}`, events: ['invitee.created', 'invitee.canceled'], scope: 'user', organization: 'https://api.calendly.com/organizations/O1', user: 'https://api.calendly.com/users/U1' });
    expect(body.signing_key).toMatch(/^[0-9a-f]{64}$/);
    const g = apis();
    await replyEvent('lou@bright.com', 'how much does it cost?');
    await runQueuedJobs(deps(g), 5);
    await runQueuedJobs(deps(g), 5);
    expect(g.calls.filter((x) => /webhook_subscriptions/.test(x.url))).toHaveLength(0);
    expect((await answer(ids.lou)).answer_status).toBe('sent');
  });

  test('BKJ-03 objections and low-confidence replies wait for a person even in autopilot', async () => {
    await replyEvent('obj@bright.com', 'Looks too expensive');
    await replyEvent('unsure@bright.com', 'maybe interested, not sure');
    const g = apis();
    await runQueuedJobs(deps(g), 5);
    expect((await answer(ids.obj)).answer_status).toBe('draft');
    expect((await answer(ids.unsure)).answer_status).toBe('draft');
    expect(g.calls.some((x) => /emails\/reply/.test(x.url))).toBe(false);
  });

  test('BKJ-04 a person approves a draft and it is sent', async () => {
    const id = (await t.db.query(`select id from replies where lead_id = $1`, [ids.obj])).rows[0].id;
    await asUser(t.db, USERS.repA, (tx: any) => tx.query(`update replies set answer = 'Fair point. Most clinics recover the cost within a month.\n\nSam', answer_status = 'approved' where id = $1`, [id]));
    const g = apis();
    await runQueuedJobs(deps(g), 5);
    const sent = JSON.parse(String(g.calls.find((x) => /emails\/reply/.test(x.url))!.init.body));
    expect(sent.body.text).toContain('Most clinics recover the cost within a month.');
    expect((await answer(ids.obj)).answer_status).toBe('sent');
  });

  test('BKJ-05 an answer approved before the lead opted out is never sent', async () => {
    await t.db.query(`update workspaces set automation_mode = 'approval' where id = $1`, [t.wsA]);
    await replyEvent('optout@bright.com', 'keen to talk next week');
    await runQueuedJobs(deps(apis()), 5);
    const id = (await t.db.query(`select id from replies where lead_id = $1`, [ids.optout])).rows[0].id;
    await t.db.query(`insert into suppressions (workspace_id, kind, value, reason) values ($1, 'email', 'optout@bright.com', 'unsubscribed')`, [t.wsA]);
    await asUser(t.db, USERS.ownerA, (tx: any) => tx.query(`update replies set answer_status = 'approved' where id = $1`, [id]));
    const g = apis();
    await runQueuedJobs(deps(g), 5);
    expect(g.calls.some((x) => /emails\/reply/.test(x.url))).toBe(false);
    expect(await answer(ids.optout)).toMatchObject({ answer_status: 'failed', answer_error: 'The lead asked not to be contacted' });
  });

  test('BKJ-06 the kill switch holds approved answers until outreach resumes', async () => {
    await replyEvent('paused@bright.com', 'keen to talk');
    await runQueuedJobs(deps(apis()), 5);
    const id = (await t.db.query(`select id from replies where lead_id = $1`, [ids.paused])).rows[0].id;
    await t.db.query('update workspaces set outreach_paused = true where id = $1', [t.wsA]);
    await asUser(t.db, USERS.ownerA, (tx: any) => tx.query(`update replies set answer_status = 'approved' where id = $1`, [id]));
    const g = apis();
    await runQueuedJobs(deps(g), 5);
    expect(g.calls.some((x) => /emails\/reply/.test(x.url))).toBe(false);
    expect((await answer(ids.paused)).answer_status).toBe('approved');
    await t.db.query('update workspaces set outreach_paused = false where id = $1', [t.wsA]);
    await runQueuedJobs(deps(g), 5);
    expect((await answer(ids.paused)).answer_status).toBe('sent');
  });

  test('BKJ-07 a send failure is recorded and the answer can be approved again', async () => {
    await replyEvent('fail@bright.com', 'keen to talk');
    await runQueuedJobs(deps(apis()), 5);
    const id = (await t.db.query(`select id from replies where lead_id = $1`, [ids.fail])).rows[0].id;
    await asUser(t.db, USERS.ownerA, (tx: any) => tx.query(`update replies set answer_status = 'approved' where id = $1`, [id]));
    await runQueuedJobs(deps(apis({ instantlyReply: () => new Response('{}', { status: 500 }) })), 5);
    expect(await answer(ids.fail)).toMatchObject({ answer_status: 'failed', answer_error: 'Instantly returned an error (500)' });
    await asUser(t.db, USERS.ownerA, (tx: any) => tx.query(`update replies set answer_status = 'approved' where id = $1`, [id]));
    await runQueuedJobs(deps(apis()), 5);
    expect((await answer(ids.fail)).answer_status).toBe('sent');
  });

  test('BKJ-08 a booking from the tracked link is recorded, even with another email, and alerts Slack', async () => {
    const key = (await t.db.query('select signing_key from calendly_subscriptions where workspace_id = $1', [t.wsA])).rows[0].signing_key;
    const raw = JSON.stringify({ event: 'invitee.created', payload: {
      uri: 'https://api.calendly.com/scheduled_events/S1/invitees/I1', email: 'kim.personal@gmail.com', name: 'Kim Bright',
      cancel_url: 'https://calendly.com/cancellations/I1', reschedule_url: 'https://calendly.com/reschedulings/I1',
      tracking: { utm_source: 'ai-sdr', utm_content: ids.kim },
      scheduled_event: { name: '15 minute call', start_time: '2026-11-18T15:00:00.000000Z', end_time: '2026-11-18T15:15:00.000000Z', location: { type: 'zoom', join_url: 'https://zoom.us/j/123' } },
    } });
    const g = apis();
    const s = createAgentServer(deps(g), { hmacSecret: SECRET, jobsPerRun: 5, healthCheck: async () => {} });
    await new Promise<void>((r) => s.listen(0, '127.0.0.1', () => r()));
    const url = `http://127.0.0.1:${(s.address() as AddressInfo).port}`;
    const post = async (rawBody: string, sig: string) => {
      const body = JSON.stringify({ token, raw: rawBody, signature: sig });
      const ts = String(Math.floor(Date.now() / 1000));
      return fetch(`${url}/webhooks/calendly`, { method: 'POST', headers: { 'x-timestamp': ts, 'x-signature': sign(SECRET, ts, body) }, body });
    };
    expect(await (await post(raw, calSig(key, raw))).json()).toEqual({ status: 'booked' });
    expect(await (await post(raw, calSig(key, raw))).json()).toEqual({ status: 'duplicate' });
    const m = (await t.db.query(`select status, zoom_url, run_by, invitee_email, cancel_url, campaign_id, starts_at from meetings where lead_id = $1`, [ids.kim])).rows[0];
    expect(m).toMatchObject({ status: 'scheduled', zoom_url: 'https://zoom.us/j/123', run_by: 'ai_closer', invitee_email: 'kim.personal@gmail.com', cancel_url: 'https://calendly.com/cancellations/I1', campaign_id: c });
    expect(new Date(m.starts_at).toISOString()).toBe('2026-11-18T15:00:00.000Z');
    expect((await t.db.query(`select stage from leads where id = $1`, [ids.kim])).rows[0].stage).toBe('meeting_booked');
    const slack = JSON.parse(String(g.calls.find((x) => /slack/.test(x.url))!.init.body));
    expect(slack.text).toContain(':calendar: *Meeting booked*: Kim Bright');

    // Cancelled: back to interested
    const cancel = JSON.stringify({ event: 'invitee.canceled', payload: { uri: 'https://api.calendly.com/scheduled_events/S1/invitees/I1', email: 'kim.personal@gmail.com', tracking: { utm_content: ids.kim }, scheduled_event: {} } });
    expect(await (await post(cancel, calSig(key, cancel))).json()).toEqual({ status: 'canceled' });
    expect((await t.db.query(`select status from meetings where lead_id = $1`, [ids.kim])).rows[0].status).toBe('canceled');
    expect((await t.db.query(`select stage from leads where id = $1`, [ids.kim])).rows[0].stage).toBe('interested');
    await new Promise<void>((r) => s.close(() => r()));
  });

  test('BKJ-09 forged Calendly notifications are refused', async () => {
    const raw = JSON.stringify({ event: 'invitee.created', payload: { uri: 'x', email: 'kim@bright.com', scheduled_event: { start_time: '2026-11-20T10:00:00Z' } } });
    expect((await calendlyPost(raw, calSig('wrong-key', raw))).status).toBe(401);
    expect((await calendlyPost(raw, 't=1,v1=00')).status).toBe(401);
    expect((await calendlyPost(raw, calSig('k', raw), 'f'.repeat(64))).status).toBe(404);
    expect((await t.db.query(`select count(*)::int n from meetings where external_id = 'x'`)).rows[0].n).toBe(0);
  });

  test('BKJ-10 without Calendly the answer has no link but is still drafted', async () => {
    await t.db.query(`update integrations set status = 'disconnected' where workspace_id = $1 and tool = 'calendly'`, [t.wsA]);
    await replyEvent('nocal@bright.com', 'keen to talk');
    await runQueuedJobs(deps(apis()), 5);
    const a = await answer(ids.nocal);
    expect(a).toMatchObject({ answer_status: 'draft', booking_url: null });
    expect(a.answer).not.toContain('calendly');
  });

  test('BKJ-11 no credential or signing key is stored in results, replies, events or the timeline', async () => {
    const key = (await t.db.query('select signing_key from calendly_subscriptions where workspace_id = $1', [t.wsA])).rows[0].signing_key;
    const dump = JSON.stringify([(await t.db.query('select result, error from agent_jobs')).rows, (await t.db.query('select * from replies')).rows, (await t.db.query('select payload from inbound_events')).rows, (await t.db.query('select summary from activities')).rows, (await t.db.query('select * from meetings')).rows]);
    expect(dump).not.toMatch(/sk-A|inst-A|cal-A|xoxb-A/);
    expect(dump).not.toContain(key);
  });
});
