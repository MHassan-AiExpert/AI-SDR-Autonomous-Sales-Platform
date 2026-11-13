import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import type { AddressInfo } from 'node:net';
import { receptionFirstMessage, receptionPrompt, receptionOutcome } from '../src/receptionist.ts';
import { PlaybookSchema } from '../src/closer.ts';
import { createAgentServer, sign } from '../src/server.ts';
import type { Deps } from '../src/jobs.ts';
import type { ReceptionistCampaign } from '../src/store.ts';
import { startTestDb, fakeFetch, asUser, USERS, type TestDb } from './harness.ts';

const NUM = '44444444-4444-4444-8444-444444444444';
const ASSISTANT = '55555555-5555-4555-8555-555555555555';
const PLAYBOOK = PlaybookSchema.parse({
  offer_summary: 'Done-for-you patient booking automation for dental clinics.',
  plans: [{ name: 'Starter', price_cents: 19900, currency: 'USD', interval: 'month' }],
  qualification_questions: ['How many clinics do you run?'],
});
const camp = (over: Partial<ReceptionistCampaign> = {}): ReceptionistCampaign => ({
  id: 'c1', name: 'Inbound', status: 'active', receptionist_status: 'live', vapi_receptionist_assistant_id: ASSISTANT, vapi_inbound_number_id: NUM,
  receptionist_transfer_number: '+15125550199', receptionist_notes: 'Open Monday to Friday, 9 to 5. 1 Main St, Austin.',
  sms_from: '+15125550100', booking_event_type: null, sender_name: 'Sam', offer: null, ...over,
});

describe('receptionist rules', () => {
  test('RR-01 the receptionist says it is an AI, answers only from company information and never shares contact details', () => {
    expect(receptionFirstMessage('Acme Growth', null)).toBe('Thanks for calling Acme Growth. This is the AI assistant. How can I help you today?');
    expect(receptionFirstMessage('Acme Growth', { first_name: 'Kim' })).toBe('Thanks for calling Acme Growth. This is the AI assistant. Am I speaking with Kim?');
    const p = receptionPrompt(camp(), PLAYBOOK, 'Acme Growth', { first_name: 'Kim', company_name: 'Bright Teeth' });
    expect(p).toContain('Notes (hours, address, common questions): Open Monday to Friday');
    expect(p).toContain('- Starter: $199 a month');
    expect(p).toMatch(/<company_information>[\s\S]*<\/company_information>/);
    expect(p).toMatch(/never share anything about the contact with the caller/);
    expect(p).toMatch(/put them through to the team with the transfer tool/);
    expect(p).toMatch(/Only say a link is coming if they agree/);
    expect(p).toMatch(/Never take card or bank details/);
    expect(receptionPrompt(camp({ receptionist_transfer_number: null }), null, 'Acme', null)).toMatch(/take a message and say the team will call back today/);
  });

  test('RR-02 "don\'t call me" always wins; transfers and empty calls are recognised', () => {
    expect(receptionOutcome('customer-ended-call', { outcome: 'meeting_requested' }, "User: please don't call me again")).toBe('do_not_call');
    expect(receptionOutcome('assistant-forwarded-call', {}, 'User: can I speak to someone')).toBe('transferred');
    expect(receptionOutcome('customer-ended-call', { outcome: 'callback_requested' }, 'User: call me tomorrow')).toBe('callback_requested');
    expect(receptionOutcome('customer-ended-call', { outcome: 'anything' }, 'User: what time do you open')).toBe('question_answered');
    expect(receptionOutcome('silence-timed-out', {}, '')).toBe('no_conversation');
  });
});

// ---------------------------------------------------------------- end to end

let t: TestDb;
let server: ReturnType<typeof createAgentServer>;
let base = '';
let token = '';
let c = '';
const SECRET = 'r'.repeat(40);
const SID = 'AC' + '2'.repeat(32);
const AUTH = 'B'.repeat(32);
let n = 0;
const vapiCalls: Record<string, object> = {};
const callId = (i: number) => `66666666-6666-4666-8666-${String(i).padStart(12, '0')}`;

function apis() {
  return fakeFetch([
    [/api\.vapi\.ai\/call\/[0-9a-f-]+$/, (url) => {
      const id = url.split('/').pop()!;
      return vapiCalls[id] ? vapiCalls[id] : new Response('{}', { status: 404 });
    }],
    [/api\.twilio\.com/, () => ({ sid: `SM${(++n).toString(16).padStart(32, '0')}`, status: 'queued' })],
    [/api\.calendly\.com\/users\/me/, () => ({ resource: { uri: 'https://api.calendly.com/users/U1', current_organization: 'https://api.calendly.com/organizations/O1' } })],
    [/api\.calendly\.com\/webhook_subscriptions/, () => ({ resource: { uri: 'https://api.calendly.com/webhook_subscriptions/W1' } })],
    [/api\.calendly\.com\/event_types/, () => ({ collection: [{ uri: 'https://api.calendly.com/event_types/E1', active: true }] })],
    [/api\.calendly\.com\/scheduling_links/, () => ({ resource: { booking_url: `https://calendly.com/d/link${++n}/15min`, owner: 'x', owner_type: 'EventType' } })],
    [/slack\.com/, () => ({ ok: true })],
  ]);
}
let f: ReturnType<typeof apis>;
const deps = (): Deps => ({ store: t.store, models: { openai: 'o', anthropic: null, gemini: 'g' }, fetchImpl: f.impl, appUrl: 'https://app.example.com', webhookBaseUrl: 'https://n8n.example.com', voiceModel: 'gpt-4o-mini' });
const deliver = async (message: object) => {
  const body = JSON.stringify({ token, event: { message } });
  const ts = String(Math.floor(Date.now() / 1000));
  const r = await fetch(`${base}/webhooks/vapi`, { method: 'POST', headers: { 'x-timestamp': ts, 'x-signature': sign(SECRET, ts, body) }, body });
  return r.json();
};
/** Vapi keeps the real call; the webhook only says it ended. */
function inboundCall(i: number, from: string, structured: object, transcript = 'AI: Thanks for calling\nUser: Hi there', over: object = {}) {
  vapiCalls[callId(i)] = {
    id: callId(i), type: 'inboundPhoneCall', phoneNumberId: NUM, customer: { number: from }, endedReason: 'customer-ended-call',
    startedAt: '2026-11-18T15:00:00Z', endedAt: '2026-11-18T15:03:00Z', artifact: { transcript, recordingUrl: 'https://storage.vapi.ai/in.wav' },
    analysis: { summary: 'Caller asked about booking automation.', structuredData: structured }, ...over,
  };
  return deliver({ type: 'end-of-call-report', call: { id: callId(i), type: 'inboundPhoneCall', phoneNumberId: NUM } });
}
const leadByPhone = async (phone: string) => (await t.db.query(`select id, full_name, email, stage, source_channel, campaign_id, consent from leads where phone = $1`, [phone])).rows;
const texts = () => f.calls.filter((x) => /twilio/.test(x.url)).map((x) => Object.fromEntries(new URLSearchParams(String(x.init.body))));

describe('inbound receptionist', () => {
  beforeAll(async () => {
    t = await startTestDb(55441);
    for (const [tool, secret] of [['vapi', { api_key: 'vapi-R' }], ['twilio', { account_sid: SID, auth_token: AUTH }], ['calendly', { access_token: 'cal-R' }], ['slack', { bot_token: 'xoxb-R' }]] as const) {
      await asUser(t.db, USERS.ownerA, (tx: any) => tx.query('select integration_connect($1, $2, $3::jsonb)', [t.wsA, tool, JSON.stringify(secret)]));
    }
    await t.db.query(`update workspaces set slack_channel = '#hot', name = 'Acme Growth' where id = $1`, [t.wsA]);
    await t.db.query(`insert into playbooks (workspace_id, version, content, is_active) values ($1, 1, $2::jsonb, true)`, [t.wsA, JSON.stringify(PLAYBOOK)]);
    token = (await t.db.query('select webhook_token from workspaces where id = $1', [t.wsA])).rows[0].webhook_token;
    c = (await t.db.query(`insert into campaigns (workspace_id, name, niche, status, receptionist_status, vapi_receptionist_assistant_id, vapi_inbound_number_id,
                                                  receptionist_transfer_number, receptionist_notes, sms_from)
      values ($1, 'Inbound', 'dentists', 'active', 'live', $2, $3, '+15125550199', 'Open 9 to 5', '+15125550100') returning id`, [t.wsA, ASSISTANT, NUM])).rows[0].id;
    await t.db.query(`insert into leads (workspace_id, campaign_id, email, full_name, phone, stage, source_channel) values ($1,$2,'kim@bright.com','Kim Bright','+15125550101','contacted','apollo')`, [t.wsA, c]);
    f = apis();
    server = createAgentServer(deps(), { hmacSecret: SECRET, jobsPerRun: 5, healthCheck: async () => {} });
    // The server's deps read `f` when created, so requests share the same fake services
    server.close();
    server = createAgentServer({ ...deps(), fetchImpl: ((...a: Parameters<typeof fetch>) => f.impl(...a)) as typeof fetch }, { hmacSecret: SECRET, jobsPerRun: 5, healthCheck: async () => {} });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(async () => { await new Promise<void>((r) => server.close(() => r())); await t?.close(); });

  test('RJ-01 each inbound call gets the receptionist set up for it, or goes to the team when it is off', async () => {
    const r = await deliver({ type: 'assistant-request', call: { id: callId(1), type: 'inboundPhoneCall', phoneNumberId: NUM, customer: { number: '+15125550101' } } });
    expect(r.assistantId).toBe(ASSISTANT);
    expect(r.assistantOverrides.firstMessage).toBe('Thanks for calling Acme Growth. This is the AI assistant. Am I speaking with Kim?');
    expect(r.assistantOverrides.model.messages[0].content).toContain('Notes (hours, address, common questions): Open 9 to 5');
    expect(r.assistantOverrides.model.tools).toEqual([{ type: 'transferCall', destinations: [{ type: 'number', number: '+15125550199', message: 'Of course, I am putting you through to the team now.' }] }]);
    expect(r.assistantOverrides.server.url).toBe(`https://n8n.example.com/webhook/vapi/${token}`);
    expect(r.assistantOverrides.serverMessages).toEqual(['end-of-call-report']);
    expect(await deliver({ type: 'assistant-request', call: { phoneNumberId: '99999999-9999-4999-8999-999999999999' } })).toEqual({ error: 'This number is not set up to answer calls.' });
    await t.db.query(`update campaigns set receptionist_status = 'off' where id = $1`, [c]);
    expect((await deliver({ type: 'assistant-request', call: { phoneNumberId: NUM } })).destination).toMatchObject({ type: 'number', number: '+15125550199' });
    await t.db.query(`update campaigns set receptionist_transfer_number = null where id = $1`, [c]);
    expect(await deliver({ type: 'assistant-request', call: { phoneNumberId: NUM } })).toEqual({ error: 'The receptionist is switched off.' });
    await t.db.query(`update campaigns set receptionist_status = 'live', receptionist_transfer_number = '+15125550199' where id = $1`, [c]);
  });

  test('RJ-02 a new caller who wants a meeting becomes a lead and gets a booking link by text', async () => {
    const r = await inboundCall(2, '+15125550120', { outcome: 'meeting_requested', caller_name: 'Lee Park', email: 'LEE@Park-Dental.com ', ok_to_text: true, reason: 'Wants online booking' });
    expect(r).toEqual({ status: 'stored' });
    expect((f.calls.find((x) => /vapi\.ai\/call\//.test(x.url))!.init.headers as Record<string, string>).Authorization).toBe('Bearer vapi-R');
    const [lead] = await leadByPhone('+15125550120');
    expect(lead).toMatchObject({ full_name: 'Lee Park', email: 'lee@park-dental.com', stage: 'interested', source_channel: 'inbound_call', campaign_id: c });
    expect(lead.consent).toMatchObject({ sms: 'inbound_request', sms_source: 'receptionist_call' });
    const call = (await t.db.query(`select agent, direction, outcome, from_number, duration_seconds, recording_url from calls where lead_id = $1`, [lead.id])).rows[0];
    expect(call).toEqual({ agent: 'receptionist', direction: 'inbound', outcome: 'interested', from_number: '+15125550120', duration_seconds: 180, recording_url: 'https://storage.vapi.ai/in.wav' });
    const [sms] = texts();
    expect(sms).toMatchObject({ To: '+15125550120', From: '+15125550100' });
    expect(sms.Body).toMatch(/^Hi Lee, thanks for calling Acme Growth\. Pick a time that suits you here: https:\/\/calendly\.com\/d\/link\d+\/15min\?utm_source=ai-sdr&utm_content=[0-9a-f-]+ Reply STOP to opt out\.$/);
    const slack = f.calls.filter((x) => /slack/.test(x.url)).map((x) => JSON.parse(String(x.init.body)).text).join('\n');
    expect(slack).toMatch(/Inbound call\*: Lee Park wants a meeting: Wants online booking\. Booking link sent by text\./);
  });

  test('RJ-03 the same call reported twice is stored once and texted once', async () => {
    const before = texts().length;
    expect(await deliver({ type: 'end-of-call-report', call: { id: callId(2), type: 'inboundPhoneCall', phoneNumberId: NUM } })).toEqual({ status: 'duplicate' });
    expect(texts().length).toBe(before);
    expect((await t.db.query(`select count(*)::int n from calls where provider_call_id = $1`, [callId(2)])).rows[0].n).toBe(1);
  });

  test('RJ-04 forged reports are ignored: unknown to Vapi, another number, or not inbound', async () => {
    expect(await deliver({ type: 'end-of-call-report', call: { id: callId(40), type: 'inboundPhoneCall', phoneNumberId: NUM, customer: { number: '+15125550140' } } })).toEqual({ status: 'ignored' });
    expect(await inboundCall(41, '+15125550141', { outcome: 'meeting_requested' }, 'User: hi', { phoneNumberId: '99999999-9999-4999-8999-999999999999' })).toEqual({ status: 'ignored' });
    expect(await inboundCall(42, '+15125550142', { outcome: 'meeting_requested' }, 'User: hi', { type: 'outboundPhoneCall' })).toEqual({ status: 'ignored' });
    for (const p of ['+15125550140', '+15125550141', '+15125550142']) expect(await leadByPhone(p)).toEqual([]);
  });

  test('RJ-05 a known caller asking for a call back gets a task at that time; no duplicate lead', async () => {
    const at = new Date(Date.now() + 2 * 86_400_000).toISOString();
    await inboundCall(5, '+15125550101', { outcome: 'callback_requested', callback_time: at, reason: 'Busy now' });
    const leads = await leadByPhone('+15125550101');
    expect(leads).toHaveLength(1);
    expect(leads[0]).toMatchObject({ full_name: 'Kim Bright', stage: 'interested' });
    expect(leads[0].consent).toMatchObject({ voice: 'inbound_request', voice_source: 'receptionist_call' });
    const fu = (await t.db.query(`select channel, due_at from follow_ups where lead_id = $1`, [leads[0].id])).rows;
    expect(fu).toHaveLength(1);
    expect(fu[0].channel).toBe('voice');
    expect(new Date(fu[0].due_at).toISOString()).toBe(at);
  });

  test('RJ-06 no text is sent without the caller\'s agreement; the team gets a task instead', async () => {
    const before = texts().length;
    await inboundCall(6, '+15125550160', { outcome: 'meeting_requested', caller_name: 'Mo Ali', ok_to_text: false });
    expect(texts().length).toBe(before);
    const [lead] = await leadByPhone('+15125550160');
    expect(lead.consent.sms).toBeUndefined();
    expect((await t.db.query(`select summary from activities where lead_id = $1 and type = 'task'`, [lead.id])).rows[0].summary).toBe('Send a booking link: they did not agree to a text');
  });

  test('RJ-07 spam and empty calls from unknown numbers do not become leads', async () => {
    expect(await inboundCall(7, '+15125550170', { outcome: 'spam' }, 'User: you have won a prize')).toEqual({ status: 'ignored' });
    expect(await inboundCall(8, '+15125550180', {}, '')).toEqual({ status: 'ignored' });
    expect(await leadByPhone('+15125550170')).toEqual([]);
    expect(await leadByPhone('+15125550180')).toEqual([]);
  });

  test('RJ-08 "don\'t call me" suppresses the number', async () => {
    await inboundCall(9, '+15125550190', { outcome: 'question_answered', caller_name: 'Ned' }, "User: stop calling me, don't call me again");
    expect((await leadByPhone('+15125550190'))[0].stage).toBe('do_not_contact');
    expect((await t.db.query(`select 1 from suppressions where workspace_id = $1 and value = '+15125550190'`, [t.wsA])).rows).toHaveLength(1);
  });

  test('RJ-09 while outreach is paused the receptionist still answers, but no text goes out', async () => {
    await t.db.query(`update workspaces set outreach_paused = true where id = $1`, [t.wsA]);
    const before = texts().length;
    expect(await inboundCall(10, '+15125550200', { outcome: 'meeting_requested', ok_to_text: true })).toEqual({ status: 'stored' });
    expect(texts().length).toBe(before);
    const [lead] = await leadByPhone('+15125550200');
    expect((await t.db.query(`select summary from activities where lead_id = $1 and type = 'task'`, [lead.id])).rows[0].summary).toBe('Send a booking link: outreach is paused');
    expect((await deliver({ type: 'assistant-request', call: { phoneNumberId: NUM } })).assistantId).toBe(ASSISTANT);
    await t.db.query(`update workspaces set outreach_paused = false where id = $1`, [t.wsA]);
  });

  test('RJ-10 no credential or webhook token is stored with calls, leads or events', async () => {
    const dump = JSON.stringify([(await t.db.query('select * from calls')).rows, (await t.db.query('select * from leads')).rows, (await t.db.query('select * from inbound_events')).rows, (await t.db.query('select * from messages')).rows]);
    for (const s of ['vapi-R', AUTH, 'cal-R', token]) expect(dump).not.toContain(s);
  });
});
