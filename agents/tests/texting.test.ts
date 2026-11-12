import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import type { AddressInfo } from 'node:net';
import { createHmac } from 'node:crypto';
import { textBasis, isStopKeyword, isStartKeyword, smsBody, cleanLine, fallbackLine, type TextLead } from '../src/texting.ts';
import { messageForm, sendMessage, twilioSignature, verifyTwilioSignature, plainNumber, TwilioError } from '../src/sources/twilio.ts';
import { createAgentServer, sign } from '../src/server.ts';
import { runQueuedJobs, type Deps } from '../src/jobs.ts';
import { startTestDb, fakeFetch, asUser, USERS, type TestDb } from './harness.ts';

const lead = (over: Partial<TextLead> = {}): TextLead => ({
  id: 'l1', full_name: 'Kim Bright', email: 'kim@bright.com', phone: '+15125550101', phone_line_type: 'mobile', consent: { sms: 'prior_express_consent' },
  company_name: 'Bright Teeth', ai_report: null, sent: 0, last_touch_at: null, suppressed: false, ...over,
});

describe('texting rules', () => {
  test('TC-01 texts need a recorded consent for that channel, a checked number and, for SMS, a mobile', () => {
    expect(textBasis(lead(), 'sms')).toEqual({ ok: true, basis: 'prior_express_consent' });
    expect(textBasis(lead({ consent: { voice: 'prior_express_consent' } }), 'sms')).toEqual({ ok: false, reason: 'no recorded consent to receive texts' });
    expect(textBasis(lead(), 'whatsapp')).toEqual({ ok: false, reason: 'no recorded consent to receive WhatsApp messages' });
    expect(textBasis(lead({ phone_line_type: 'landline' }), 'sms')).toEqual({ ok: false, reason: 'the number cannot receive texts' });
    expect(textBasis(lead({ phone_line_type: 'landline', consent: { whatsapp: 'inbound_request' } }), 'whatsapp')).toEqual({ ok: true, basis: 'inbound_request' });
    expect(textBasis(lead({ suppressed: true }), 'sms')).toEqual({ ok: false, reason: 'on the do-not-contact list' });
    expect(textBasis(lead({ phone: '5125550101' }), 'sms')).toEqual({ ok: false, reason: 'no checked number with a country code' });
  });

  test('TC-02 opt-out keywords are recognised only when they are the whole message', () => {
    for (const s of ['STOP', 'stop.', ' Unsubscribe ', 'opt out', 'STOPALL', 'quit!', 'Cancel']) expect(isStopKeyword(s)).toBe(true);
    for (const s of ['please stop by on Friday', 'Can we cancel Tuesday and do Thursday?', 'yes']) expect(isStopKeyword(s)).toBe(false);
    expect(isStartKeyword('START')).toBe(true);
    expect(isStartKeyword('start next week?')).toBe(false);
  });

  test('TC-03 every SMS names the sender and ends with how to opt out; lines carry no links or line breaks', () => {
    expect(smsBody(lead(), { sender_name: 'Sam' }, 'Acme Growth', 'Worth 15 minutes this week?'))
      .toBe("Hi Kim, it's Sam from Acme Growth. Worth 15 minutes this week? Reply STOP to opt out.");
    expect(smsBody(lead({ full_name: null }), { sender_name: null }, 'Acme Growth', 'Quick question.')).toBe("Hi, it's Acme Growth. Quick question. Reply STOP to opt out.");
    expect(cleanLine('See https://evil.example/x now\nand www.x.com\tok')).toBe('See now and ok');
    expect(cleanLine('word '.repeat(80)).length).toBeLessThanOrEqual(220);
    expect(fallbackLine(lead(), 1)).toMatch(/Bright Teeth.*15-minute chat/);
  });

  test('TC-04 the Twilio request uses the right sender, the WhatsApp prefix and an approved template', () => {
    const sms = messageForm({ channel: 'sms', to: '+15125550101', from: '+15125550100', body: 'Hi', statusCallback: 'https://n8n.x/webhook/twilio/t' });
    expect(Object.fromEntries(sms)).toEqual({ To: '+15125550101', From: '+15125550100', Body: 'Hi', StatusCallback: 'https://n8n.x/webhook/twilio/t' });
    const svc = messageForm({ channel: 'sms', to: '+15125550101', from: 'MG' + 'a'.repeat(32), body: 'Hi' });
    expect(svc.get('MessagingServiceSid')).toBe('MG' + 'a'.repeat(32));
    expect(svc.get('From')).toBeNull();
    const wa = messageForm({ channel: 'whatsapp', to: '+447700900123', from: '+447700900100', contentSid: 'HX' + 'b'.repeat(32), contentVariables: { 1: 'Kim', 2: 'Line' } });
    expect(Object.fromEntries(wa)).toEqual({ To: 'whatsapp:+447700900123', From: 'whatsapp:+447700900100', ContentSid: 'HX' + 'b'.repeat(32), ContentVariables: '{"1":"Kim","2":"Line"}' });
    expect(plainNumber('whatsapp:+447700900123')).toBe('+447700900123');
    expect(plainNumber('07700900123')).toBeNull();
  });

  test('TC-05 Twilio webhooks are accepted only with a valid X-Twilio-Signature for this address', () => {
    const url = 'https://n8n.x/webhook/twilio/abc';
    const params = { MessageSid: 'SM1', Body: 'Hello', From: '+15125550101', AccountSid: 'AC1' };
    // Independent calculation of Twilio's documented algorithm
    const expected = createHmac('sha1', 'token123').update(url + 'AccountSidAC1BodyHelloFrom+15125550101MessageSidSM1').digest('base64');
    expect(twilioSignature('token123', url, params)).toBe(expected);
    expect(verifyTwilioSignature('token123', url, params, expected)).toBe(true);
    expect(verifyTwilioSignature('token123', url, { ...params, Body: 'Changed' }, expected)).toBe(false);
    expect(verifyTwilioSignature('token123', 'https://n8n.x/webhook/twilio/other', params, expected)).toBe(false);
    expect(verifyTwilioSignature('other', url, params, expected)).toBe(false);
    expect(verifyTwilioSignature('token123', url, params, '')).toBe(false);
  });

  test('TC-06 Twilio errors keep only the error code, worded for people', async () => {
    const creds = { accountSid: 'AC' + 'a'.repeat(32), authToken: 'x'.repeat(32) };
    const f = fakeFetch([[/twilio/, () => new Response(JSON.stringify({ code: 21610, message: 'internal detail +1512' }), { status: 400 })]]);
    const err = await sendMessage(creds, { channel: 'sms', to: '+15125550101', from: '+15125550100', body: 'Hi' }, f.impl).catch((e) => e);
    expect(err).toBeInstanceOf(TwilioError);
    expect(err.code).toBe('21610');
    expect(err.message).toBe('The recipient has replied STOP to this number');
    const g = fakeFetch([[/twilio/, () => new Response('{}', { status: 401 })]]);
    expect((await sendMessage(creds, { channel: 'sms', to: '+1', from: '+1', body: 'x' }, g.impl).catch((e) => e)).message).toBe('Twilio rejected the stored credentials');
  });
});

// ---------------------------------------------------------------- end to end

let t: TestDb;
let server: ReturnType<typeof createAgentServer>;
let base = '';
let token = '';
let c = '';
const SECRET = 't'.repeat(40);
const SID = 'AC' + '1'.repeat(32);
const AUTH = 'A'.repeat(32);
const HOOK = () => `https://n8n.example.com/webhook/twilio/${token}`;
const ids: Record<string, string> = {};
let n = 0;
const sidOf = (i: number) => `SM${i.toString(16).padStart(32, '0')}`;
const LINE = 'Saw the second clinic opening; want 15 minutes on keeping the new chairs full?';
const CLASSIFY = { classification: 'question', confidence: 0.92, summary: 'Asks about price before a call.', suggested_response: 'It starts at $400 a month. Happy to walk you through it on a quick call. Sam' };

function apis(twilio?: (url: string, init: RequestInit) => unknown) {
  return fakeFetch([
    [/api\.twilio\.com\/2010-04-01\/Accounts\/AC[0-9]+\/Messages\.json/, twilio ?? (() => ({ sid: sidOf(++n), status: 'queued' }))],
    [/api\.openai\.com/, (_u, init) => {
      const input = String(JSON.parse(String(init.body)).input);
      return { output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify(input.includes('<reply>') ? CLASSIFY : { text: LINE }) }] }] };
    }],
    [/slack\.com/, () => ({ ok: true })],
  ]);
}
const deps = (f: ReturnType<typeof apis>): Deps => ({ store: t.store, models: { openai: 'o', anthropic: null, gemini: 'g' }, fetchImpl: f.impl, appUrl: 'https://app.example.com', webhookBaseUrl: 'https://n8n.example.com' });
const runJob = async (f: ReturnType<typeof apis>, type = 'sms_outreach') => {
  await t.db.query(`delete from agent_jobs where campaign_id = $1 and status = 'queued'`, [c]);
  await t.db.query(`insert into agent_jobs (workspace_id, campaign_id, type) values ($1, $2, $3)`, [t.wsA, c, type]);
  await runQueuedJobs(deps(f), 1);
  return (await t.db.query(`select * from agent_jobs where campaign_id = $1 and type = $2 order by created_at desc limit 1`, [c, type])).rows[0];
};
const twilioCalls = (f: ReturnType<typeof apis>) => f.calls.filter((x) => /api\.twilio\.com/.test(x.url)).map((x) => Object.fromEntries(new URLSearchParams(String(x.init.body))));
async function hook(params: Record<string, string>, opts: { badTwilio?: boolean } = {}) {
  const raw = new URLSearchParams(params).toString();
  const signature = opts.badTwilio ? 'bm90LXZhbGlk' : twilioSignature(AUTH, HOOK(), params);
  const body = JSON.stringify({ token, raw, signature });
  const ts = String(Math.floor(Date.now() / 1000));
  return fetch(`${base}/webhooks/twilio`, { method: 'POST', headers: { 'x-timestamp': ts, 'x-signature': sign(SECRET, ts, body) }, body });
}
const inbound = (from: string, body: string, sid: string) => hook({ AccountSid: SID, MessageSid: sid, SmsSid: sid, From: from, To: '+15125550100', Body: body, NumMedia: '0', SmsStatus: 'received' });
const stage = async (id: string) => (await t.db.query(`select stage from leads where id = $1`, [id])).rows[0].stage;

describe('text follow-ups', () => {
  let f: ReturnType<typeof apis>;
  beforeAll(async () => {
    t = await startTestDb(55439);
    for (const [tool, secret] of [['twilio', { account_sid: SID, auth_token: AUTH }], ['openai', { api_key: 'sk-A' }], ['slack', { bot_token: 'xoxb-A' }]] as const) {
      await asUser(t.db, USERS.ownerA, (tx: any) => tx.query('select integration_connect($1, $2, $3::jsonb)', [t.wsA, tool, JSON.stringify(secret)]));
    }
    await t.db.query(`update workspaces set slack_channel = '#hot', name = 'Acme Growth' where id = $1`, [t.wsA]);
    token = (await t.db.query('select webhook_token from workspaces where id = $1', [t.wsA])).rows[0].webhook_token;
    c = (await t.db.query(`insert into campaigns (workspace_id, name, niche, offer, status, sms_status, sms_channel, sms_from, call_timezone, call_window_start, call_window_end, call_days,
                                                  sms_after_days, sms_max_messages, sender_name, score_threshold)
      values ($1, 'Austin', 'dentists', 'Booking automation', 'active', 'live', 'sms', '+15125550100', 'UTC', '00:00', '23:59',
              '{"0":true,"1":true,"2":true,"3":true,"4":true,"5":true,"6":true}', 3, 2, 'Sam', 60) returning id`, [t.wsA])).rows[0].id;
    const mk = async (name: string, phone: string, type: string, consent: object, emailedDaysAgo: number | null) => {
      const id = (await t.db.query(`insert into leads (workspace_id, campaign_id, email, full_name, phone, phone_line_type, phone_checked_at, consent, score, stage, source_channel)
        values ($1,$2,$3,$4,$5,$6,now(),$7::jsonb,80,'contacted','google_maps') returning id`,
        [t.wsA, c, `${name}@bright.com`, name === 'kim' ? 'Kim Bright' : null, phone, type, JSON.stringify(consent)])).rows[0].id;
      if (emailedDaysAgo !== null) {
        await t.db.query(`insert into emails (workspace_id, lead_id, campaign_id, subject, body, status, sent_at, idempotency_key) values ($1,$2,$3,'Hi','Hi','sent', now() - make_interval(days => $4), $5)`,
          [t.wsA, id, c, emailedDaysAgo, `${id}:1`]);
      }
      return id;
    };
    ids.kim = await mk('kim', '+15125550101', 'mobile', { sms: 'prior_express_consent' }, 4);
    ids.recent = await mk('recent', '+15125550102', 'mobile', { sms: 'prior_express_consent' }, 1);
    ids.nocon = await mk('nocon', '+15125550103', 'mobile', {}, 5);
    ids.land = await mk('land', '+15125550104', 'landline', { sms: 'existing_customer' }, 5);
    ids.never = await mk('never', '+15125550105', 'mobile', { sms: 'prior_express_consent' }, null);
    ids.replied = await mk('replied', '+15125550106', 'mobile', { sms: 'prior_express_consent' }, 5);
    await t.db.query(`insert into replies (workspace_id, lead_id, campaign_id, channel, body) values ($1,$2,$3,'email','Not now')`, [t.wsA, ids.replied, c]);
    server = createAgentServer(deps(apis()), { hmacSecret: SECRET, jobsPerRun: 5, healthCheck: async () => {} });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    f = apis();
  });
  afterAll(async () => { await new Promise<void>((r) => server.close(() => r())); await t?.close(); });

  test('TJ-01 only leads who were contacted, have not answered, are due and consented get a text', async () => {
    const j = await runJob(f);
    expect(j.status).toBe('succeeded');
    const sent = twilioCalls(f);
    expect(sent).toEqual([{ To: '+15125550101', From: '+15125550100', Body: `Hi Kim, it's Sam from Acme Growth. ${LINE} Reply STOP to opt out.`, StatusCallback: HOOK() }]);
    expect((f.calls.find((x) => /twilio/.test(x.url))!.init.headers as Record<string, string>).Authorization).toBe(`Basic ${Buffer.from(`${SID}:${AUTH}`).toString('base64')}`);
    expect(j.result).toMatchObject({ sent: 1, written_by_ai: 1, not_allowed: 2, reasons: { 'no recorded consent to receive texts': 1, 'the number cannot receive texts': 1 } });
    const m = (await t.db.query(`select step, consent_basis, provider_message_id, delivery_status, to_number, from_number from messages where lead_id = $1`, [ids.kim])).rows;
    expect(m).toEqual([{ step: 1, consent_basis: 'prior_express_consent', provider_message_id: sidOf(1), delivery_status: 'queued', to_number: '+15125550101', from_number: '+15125550100' }]);
    const act = (await t.db.query(`select summary from activities where lead_id = $1 and type = 'sms'`, [ids.kim])).rows;
    expect(act[0].summary).toMatch(/^SMS follow-up 1 sent: Saw the second clinic/);
  });

  test('TJ-02 a second run does not text anyone again before the follow-up gap', async () => {
    const g = apis();
    const j = await runJob(g);
    expect(j.status).toBe('succeeded');
    expect(twilioCalls(g)).toEqual([]);
  });

  test('TJ-03 delivery updates need a valid Twilio signature and only move forward', async () => {
    expect((await hook({ AccountSid: SID, MessageSid: sidOf(1), MessageStatus: 'delivered' }, { badTwilio: true })).status).toBe(401);
    expect((await hook({ AccountSid: SID, MessageSid: sidOf(1), MessageStatus: 'delivered' })).status).toBe(200);
    await hook({ AccountSid: SID, MessageSid: sidOf(1), MessageStatus: 'sent' });
    const m = (await t.db.query(`select delivery_status, delivered_at is not null as at from messages where provider_message_id = $1`, [sidOf(1)])).rows[0];
    expect(m).toEqual({ delivery_status: 'delivered', at: true });
    // Another account's events are ignored
    const other = await hook({ AccountSid: 'AC' + '9'.repeat(32), MessageSid: sidOf(1), MessageStatus: 'failed' });
    expect(await other.json()).toEqual({ status: 'ignored' });
  });

  test('TJ-04 a text reply is read by the reply agent and answered by SMS in autopilot', async () => {
    const r = await inbound('+15125550101', 'How much does it cost?', sidOf(900));
    expect(await r.json()).toEqual({ status: 'stored' });
    const inMsg = (await t.db.query(`select direction, delivery_status, body from messages where lead_id = $1 and direction = 'inbound'`, [ids.kim])).rows;
    expect(inMsg).toEqual([{ direction: 'inbound', delivery_status: 'received', body: 'How much does it cost?' }]);
    const g = apis();
    expect((await runJob(g, 'reply_handling')).status).toBe('succeeded');
    const reply = (await t.db.query(`select channel, classification, answer_status, answer from replies where lead_id = $1`, [ids.kim])).rows[0];
    expect(reply).toMatchObject({ channel: 'sms', classification: 'question', answer_status: 'approved' });
    expect(await stage(ids.kim)).toBe('engaged');
    expect((await runJob(g, 'reply_send')).status).toBe('succeeded');
    expect(twilioCalls(g)).toEqual([{ To: '+15125550101', From: '+15125550100', Body: CLASSIFY.suggested_response, StatusCallback: HOOK() }]);
    expect((await t.db.query(`select answer_status from replies where lead_id = $1`, [ids.kim])).rows[0].answer_status).toBe('sent');
    const slack = g.calls.filter((x) => /slack/.test(x.url)).map((x) => JSON.parse(String(x.init.body)).text);
    expect(slack.join('\n')).toMatch(/Question\* by text: Kim Bright/);
  });

  test('TJ-05 the same text twice is stored once; texts from unknown numbers are ignored', async () => {
    expect(await (await inbound('+15125550101', 'How much does it cost?', sidOf(900))).json()).toEqual({ status: 'duplicate' });
    expect(await (await inbound('+15125559999', 'Who is this?', sidOf(901))).json()).toEqual({ status: 'ignored' });
    expect((await t.db.query(`select count(*)::int n from messages where direction = 'inbound'`)).rows[0].n).toBe(1);
  });

  test('TJ-06 STOP suppresses the number and email at once and the lead is never texted again', async () => {
    expect(await (await inbound('+15125550102', 'STOP', sidOf(902))).json()).toEqual({ status: 'stored' });
    expect(await stage(ids.recent)).toBe('do_not_contact');
    const s = (await t.db.query(`select kind, value from suppressions where workspace_id = $1 order by kind`, [t.wsA])).rows;
    expect(s).toEqual(expect.arrayContaining([{ kind: 'phone', value: '+15125550102' }, { kind: 'email', value: 'recent@bright.com' }]));
    expect((await t.db.query(`select classification, channel from replies where lead_id = $1`, [ids.recent])).rows).toEqual([{ classification: 'unsubscribe', channel: 'sms' }]);
    await t.db.query(`update emails set sent_at = now() - interval '9 days' where lead_id = $1`, [ids.recent]);
    const g = apis();
    await runJob(g);
    expect(twilioCalls(g).map((x) => x.To)).not.toContain('+15125550102');
  });

  test('TJ-07 a number that opted out at Twilio is suppressed when Twilio refuses the text', async () => {
    const id = (await t.db.query(`insert into leads (workspace_id, campaign_id, email, phone, phone_line_type, phone_checked_at, consent, score, stage, source_channel)
      values ($1,$2,'opted@bright.com','+15125550107','mobile',now(),'{"sms":"prior_express_consent"}',80,'contacted','google_maps') returning id`, [t.wsA, c])).rows[0].id;
    await t.db.query(`insert into emails (workspace_id, lead_id, campaign_id, subject, body, status, sent_at, idempotency_key) values ($1,$2,$3,'Hi','Hi','sent', now() - interval '5 days', 'opted:1')`, [t.wsA, id, c]);
    const g = apis(() => new Response(JSON.stringify({ code: 21610, message: 'x' }), { status: 400 }));
    const j = await runJob(g);
    expect(j.result).toMatchObject({ sent: 0, failed: 1 });
    expect((await t.db.query(`select delivery_status, error, error_code from messages where lead_id = $1`, [id])).rows[0])
      .toEqual({ delivery_status: 'failed', error: 'The recipient has replied STOP to this number', error_code: '21610' });
    expect(await stage(id)).toBe('do_not_contact');
  });

  test('TJ-08 texts stop when the channel is off, the campaign is paused or it is outside contact hours', async () => {
    const g = apis();
    await t.db.query(`update workspaces set enabled_channels = enabled_channels || '{"sms": false}' where id = $1`, [t.wsA]);
    expect((await runJob(g)).result.note).toBe('SMS follow-ups are not live for this campaign.');
    await t.db.query(`update workspaces set enabled_channels = enabled_channels || '{"sms": true}' where id = $1`, [t.wsA]);
    await t.db.query(`update campaigns set call_days = '{"0":false,"1":false,"2":false,"3":false,"4":false,"5":false,"6":false}' where id = $1`, [c]);
    expect((await runJob(g)).result.note).toBe('Outside contact hours; texts continue in the next window.');
    await t.db.query(`update campaigns set call_days = '{"0":true,"1":true,"2":true,"3":true,"4":true,"5":true,"6":true}' where id = $1`, [c]);
    expect(twilioCalls(g)).toEqual([]);
  });

  test('TJ-09 WhatsApp follow-ups use the approved template with the name and the line', async () => {
    const id = (await t.db.query(`insert into leads (workspace_id, campaign_id, email, full_name, phone, phone_line_type, phone_checked_at, consent, score, stage, source_channel)
      values ($1,$2,'wanda@bright.com','Wanda Ng','+447700900123','landline',now(),'{"whatsapp":"inbound_request"}',80,'contacted','google_maps') returning id`, [t.wsA, c])).rows[0].id;
    await t.db.query(`insert into emails (workspace_id, lead_id, campaign_id, subject, body, status, sent_at, idempotency_key) values ($1,$2,$3,'Hi','Hi','sent', now() - interval '5 days', 'wanda:1')`, [t.wsA, id, c]);
    await t.db.query(`update campaigns set sms_channel = 'whatsapp', whatsapp_from = '+447700900100', whatsapp_content_sid = $2 where id = $1`, [c, 'HX' + 'c'.repeat(32)]);
    const g = apis();
    const j = await runJob(g);
    expect(j.status).toBe('succeeded');
    const wa = twilioCalls(g).find((x) => x.To === 'whatsapp:+447700900123');
    expect(wa).toEqual({ To: 'whatsapp:+447700900123', From: 'whatsapp:+447700900100', ContentSid: 'HX' + 'c'.repeat(32), ContentVariables: JSON.stringify({ 1: 'Wanda', 2: LINE }), StatusCallback: HOOK() });
    expect((await t.db.query(`select channel, template from messages where lead_id = $1`, [id])).rows).toEqual([{ channel: 'whatsapp', template: 'HX' + 'c'.repeat(32) }]);
    await t.db.query(`update campaigns set sms_channel = 'sms' where id = $1`, [c]);
  });

  test('TJ-10 Twilio rejecting the account stops the run and flags Twilio in Setup', async () => {
    const id = (await t.db.query(`insert into leads (workspace_id, campaign_id, email, phone, phone_line_type, phone_checked_at, consent, score, stage, source_channel)
      values ($1,$2,'auth@bright.com','+15125550108','mobile',now(),'{"sms":"prior_express_consent"}',80,'contacted','google_maps') returning id`, [t.wsA, c])).rows[0].id;
    await t.db.query(`insert into emails (workspace_id, lead_id, campaign_id, subject, body, status, sent_at, idempotency_key) values ($1,$2,$3,'Hi','Hi','sent', now() - interval '5 days', 'auth:1')`, [t.wsA, id, c]);
    const j = await runJob(apis(() => new Response(JSON.stringify({ code: 20003 }), { status: 401 })));
    expect(j.status).toBe('failed');
    expect(j.error).toBe('Twilio rejected the stored credentials');
    expect((await t.db.query(`select status from integrations where workspace_id = $1 and tool = 'twilio'`, [t.wsA])).rows[0].status).toBe('error');
  });

  test('TJ-11 no credential or webhook token is stored with texts, events or job results', async () => {
    const dump = JSON.stringify([
      (await t.db.query(`select * from messages`)).rows, (await t.db.query(`select * from inbound_events where provider = 'twilio'`)).rows,
      (await t.db.query(`select result, error from agent_jobs`)).rows,
    ]);
    expect(dump).not.toContain(AUTH);
    expect(dump).not.toContain(token);
  });
});
