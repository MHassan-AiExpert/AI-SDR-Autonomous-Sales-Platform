import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import type { AddressInfo } from 'node:net';
import { createHmac } from 'node:crypto';
import { PlaybookSchema, matchPlan, money, closerNumber, closerOutcome, closerFirstMessage, closerPrompt, closerAnalysisSchema, proposalTokens, type CloserMeeting, type Playbook, type DealToClose } from '../src/closer.ts';
import { stripeForm, verifyStripeSignature, createPaymentLink } from '../src/sources/stripe.ts';
import { documentBody, sendProposal } from '../src/sources/pandadoc.ts';
import { meetingPhone } from '../src/booking.ts';
import { createAgentServer, sign } from '../src/server.ts';
import { runQueuedJobs, type Deps } from '../src/jobs.ts';
import { startTestDb, fakeFetch, asUser, USERS, type TestDb } from './harness.ts';

const PLAYBOOK: Playbook = PlaybookSchema.parse({
  offer_summary: 'Done-for-you patient booking automation for dental clinics, live in two weeks.',
  plans: [
    { name: 'Starter', price_cents: 19900, currency: 'USD', interval: 'month', description: 'One clinic' },
    { name: 'Growth', price_cents: 49900, currency: 'USD', interval: 'month', description: 'Up to five clinics' },
  ],
  qualification_questions: ['How many new patients do you want a month?'],
  objections: [{ objection: 'too expensive', answer: 'Most clinics recover the fee with two new patients a month.' }],
  handoff_rules: ['They ask for a custom contract'],
  proposal_template_id: 'TplABCDEFGHIJ12345',
});
const meeting = (over: Partial<CloserMeeting> = {}): CloserMeeting => ({
  id: 'm1', lead_id: 'l1', starts_at: new Date(), meeting_phone: '+15125550101', event_name: 'Demo', invitee_name: 'Kim Bright', invitee_email: 'kim@bright.com',
  full_name: 'Kim Bright', email: 'kim@bright.com', phone: null, phone_checked_at: null, consent: null, stage: 'meeting_booked',
  ai_report: { company_summary: 'Two-site clinic' }, company_name: 'Bright Teeth', suppressed: false, ...over,
});

describe('closer rules', () => {
  test('CC-01 the plan comes from the playbook by name; the AI never sets a price', () => {
    expect(matchPlan(PLAYBOOK, 'Growth')?.price_cents).toBe(49900);
    expect(matchPlan(PLAYBOOK, 'growth plan')?.name).toBe('Growth');
    expect(matchPlan(PLAYBOOK, 'Enterprise')).toBeNull();
    expect(matchPlan(PLAYBOOK, '')).toBeNull();
    expect(matchPlan({ ...PLAYBOOK, plans: [PLAYBOOK.plans[0]] }, '')?.name).toBe('Starter');
    expect(money(49900, 'USD')).toBe('$499');
    expect(money(1999, 'EUR')).toBe('€19.99');
    expect(PlaybookSchema.safeParse({ ...PLAYBOOK, plans: [] }).success).toBe(false);
    expect(PlaybookSchema.safeParse({ ...PLAYBOOK, plans: [{ ...PLAYBOOK.plans[0], price_cents: 5 }] }).success).toBe(false);
  });

  test('CC-02 the closer calls the number given for the meeting, or a consented checked number; otherwise the team takes it', () => {
    expect(closerNumber(meeting())).toEqual({ ok: true, phone: '+15125550101', basis: 'gave_number_for_meeting' });
    expect(closerNumber(meeting({ meeting_phone: null, phone: '+15125550109', phone_checked_at: new Date(), consent: { voice: 'inbound_request' } })))
      .toEqual({ ok: true, phone: '+15125550109', basis: 'inbound_request' });
    expect(closerNumber(meeting({ meeting_phone: null, phone: '+15125550109', phone_checked_at: new Date() })))
      .toEqual({ ok: false, reason: 'The prospect did not give a phone number for this meeting' });
    expect(closerNumber(meeting({ suppressed: true }))).toEqual({ ok: false, reason: 'The prospect is on the do-not-contact list' });
  });

  test('CC-03 a request not to be called always wins; an unclear result is never treated as a sale', () => {
    expect(closerOutcome('customer-ended-call', { outcome: 'agreed' }, "User: don't call me again")).toBe('do_not_call');
    expect(closerOutcome('voicemail', {}, '')).toBe('voicemail');
    expect(closerOutcome('customer-did-not-answer', {}, '')).toBe('no_answer');
    expect(closerOutcome('customer-ended-call', { outcome: 'agreed' }, 'User: yes, Growth please')).toBe('agreed');
    expect(closerOutcome('customer-ended-call', { outcome: 'maybe' }, 'User: hmm')).toBe('needs_human');
    expect(closerOutcome('customer-ended-call', {}, '')).toBe('no_answer');
  });

  test('CC-04 the meeting opens with the AI disclosure and keeps to playbook prices and safety rules', () => {
    expect(closerFirstMessage(meeting(), 'Acme Growth')).toBe('Hi Kim, this is the AI assistant from Acme Growth, calling for the meeting you booked. Is now still a good time?');
    const p = closerPrompt(PLAYBOOK, meeting(), 'Acme Growth', 'Sam');
    expect(p).toContain('- Growth: $499 a month. Up to five clinics');
    expect(p).toMatch(/Never offer discounts, custom prices/);
    expect(p).toMatch(/Never take card or bank details on the call/);
    expect(p).toContain('If they say "too expensive": Most clinics recover');
    expect(p).toMatch(/<playbook>[\s\S]*<\/playbook>[\s\S]*<research>/);
    expect(closerAnalysisSchema(PLAYBOOK).properties.plan.enum).toEqual(['', 'Starter', 'Growth']);
    const tokens = proposalTokens({ full_name: 'Kim Ann Bright', company_name: 'Bright Teeth' } as DealToClose, PLAYBOOK.plans[1], 'Acme Growth', 'https://buy.stripe.com/x');
    expect(tokens).toMatchObject({ 'Client.FirstName': 'Kim', 'Client.LastName': 'Ann Bright', 'Plan.Price': '$499 a month', 'Payment.Link': 'https://buy.stripe.com/x' });
  });

  test('CC-05 Stripe requests, payment links and webhook signatures', async () => {
    expect(stripeForm({ a: 1, 'b[c]': 'x', list: ['e1', 'e2'], skip: undefined }).toString()).toBe('a=1&b%5Bc%5D=x&list%5B0%5D=e1&list%5B1%5D=e2');
    const secret = 'whsec_' + 'k'.repeat(24);
    const payload = '{"id":"evt_1"}';
    const t = Math.floor(Date.now() / 1000);
    const v1 = createHmac('sha256', secret).update(`${t}.${payload}`).digest('hex');
    expect(verifyStripeSignature(`t=${t},v1=${v1}`, payload, secret)).toBe(true);
    expect(verifyStripeSignature(`t=${t},v1=${v1}`, payload + ' ', secret)).toBe(false);
    expect(verifyStripeSignature(`t=${t - 600},v1=${createHmac('sha256', secret).update(`${t - 600}.${payload}`).digest('hex')}`, payload, secret)).toBe(false);
    expect(verifyStripeSignature(undefined, payload, secret)).toBe(false);
    const f = fakeFetch([
      [/\/v1\/prices/, () => ({ id: 'price_1' })],
      [/\/v1\/payment_links/, () => ({ id: 'plink_ABCDEFGH12', url: 'https://buy.stripe.com/test_abc' })],
    ]);
    expect(await createPaymentLink('sk_test_x', { productName: 'Growth', amountCents: 49900, currency: 'USD', interval: 'month', dealId: 'd1', workspaceId: 'w1' }, f.impl))
      .toEqual({ id: 'plink_ABCDEFGH12', url: 'https://buy.stripe.com/test_abc' });
    const price = Object.fromEntries(new URLSearchParams(String(f.calls[0].init.body)));
    expect(price).toMatchObject({ currency: 'usd', unit_amount: '49900', 'recurring[interval]': 'month', 'product_data[name]': 'Growth' });
    expect((f.calls[0].init.headers as Record<string, string>)['Idempotency-Key']).toBe('price-d1');
    const bad = fakeFetch([[/stripe/, () => new Response(JSON.stringify({ error: { message: 'card 4242 secret' } }), { status: 400 })]]);
    const err = await createPaymentLink('sk_test_x', { productName: 'G', amountCents: 100, currency: 'USD', interval: 'one_time', dealId: 'd', workspaceId: 'w' }, bad.impl).catch((e) => e);
    expect(err.message).not.toContain('4242');
  });

  test('CC-06 PandaDoc proposals are filled, prepared and sent; meeting numbers are normalised', async () => {
    const body = documentBody({ templateId: 'T1', name: 'P', recipient: { email: 'a@b.com', first_name: 'A', role: 'Client' }, tokens: { 'Plan.Name': 'Growth' }, message: 'm', subject: 's' });
    expect(body).toMatchObject({ template_uuid: 'T1', recipients: [{ email: 'a@b.com', first_name: 'A', last_name: '', role: 'Client' }], tokens: [{ name: 'Plan.Name', value: 'Growth' }] });
    let polls = 0;
    const f = fakeFetch([
      [/documents\/[A-Za-z0-9]+\/send/, () => ({ status: 'document.sent' })],
      [/documents\/[A-Za-z0-9]+$/, () => ({ status: ++polls < 2 ? 'document.uploaded' : 'document.draft' })],
      [/documents$/, () => ({ id: 'DocABCDEFGHIJ', status: 'document.uploaded' })],
    ]);
    expect(await sendProposal('k', { templateId: 'T1', name: 'P', recipient: { email: 'a@b.com', role: 'Client' }, tokens: {}, message: 'm', subject: 's' }, f.impl, 1)).toBe('DocABCDEFGHIJ');
    expect(f.calls.map((c) => `${c.init.method} ${c.url.replace('https://api.pandadoc.com/public/v1/', '')}`)).toEqual(['POST documents', 'GET documents/DocABCDEFGHIJ', 'GET documents/DocABCDEFGHIJ', 'POST documents/DocABCDEFGHIJ/send']);
    expect((f.calls[0].init.headers as Record<string, string>).Authorization).toBe('API-Key k');
    expect(meetingPhone('+1 (512) 555-0101')).toBe('+15125550101');
    expect(meetingPhone('0044 7700 900123')).toBe('+447700900123');
    expect(meetingPhone('512-555-0101')).toBeNull();
  });
});

// ---------------------------------------------------------------- end to end

let t: TestDb;
let server: ReturnType<typeof createAgentServer>;
let base = '';
let token = '';
let c = '';
const SECRET = 'c'.repeat(40);
const WHSEC = 'whsec_' + 'w'.repeat(24);
const STRIPE_KEY = 'sk_test_' + 's'.repeat(24);
const PD_KEY = 'pd' + 'p'.repeat(38);
let n = 0;
const ids: Record<string, string> = {};

type Over = { pandadoc?: () => unknown };
function apis(over: Over = {}) {
  return fakeFetch([
    [/api\.vapi\.ai\/call/, () => ({ id: `vapi-closer-${++n}` })],
    [/api\.stripe\.com\/v1\/prices/, () => ({ id: `price_${++n}` })],
    [/api\.stripe\.com\/v1\/payment_links/, () => ({ id: `plink_TEST${String(++n).padStart(6, '0')}`, url: `https://buy.stripe.com/test_${n}` })],
    [/api\.stripe\.com\/v1\/webhook_endpoints/, () => ({ id: 'we_TEST123456', secret: WHSEC })],
    [/api\.pandadoc\.com\/public\/v1\/documents\/[A-Za-z0-9]+\/send/, () => ({ status: 'document.sent' })],
    [/api\.pandadoc\.com\/public\/v1\/documents\/[A-Za-z0-9]+$/, () => ({ status: 'document.draft' })],
    [/api\.pandadoc\.com\/public\/v1\/documents$/, over.pandadoc ?? (() => ({ id: `Doc${String(++n).padStart(10, '0')}`, status: 'document.uploaded' }))],
    [/slack\.com/, () => ({ ok: true })],
  ]);
}
const deps = (f: ReturnType<typeof apis>): Deps => ({ store: t.store, models: { openai: 'o', anthropic: null, gemini: 'g' }, fetchImpl: f.impl, appUrl: 'https://app.example.com', webhookBaseUrl: 'https://n8n.example.com', voiceModel: 'gpt-4o-mini', pandadocPauseMs: 1 });
const runCloserJob = async (f: ReturnType<typeof apis>) => {
  await t.db.query(`delete from agent_jobs where campaign_id = $1 and status = 'queued'`, [c]);
  await t.db.query(`insert into agent_jobs (workspace_id, campaign_id, type) values ($1, $2, 'ai_closer')`, [t.wsA, c]);
  await runQueuedJobs(deps(f), 1);
  return (await t.db.query(`select * from agent_jobs where campaign_id = $1 and type = 'ai_closer' order by created_at desc limit 1`, [c])).rows[0];
};
const signed = (path: string, payload: object) => {
  const body = JSON.stringify(payload);
  const ts = String(Math.floor(Date.now() / 1000));
  return fetch(`${base}${path}`, { method: 'POST', headers: { 'x-timestamp': ts, 'x-signature': sign(SECRET, ts, body) }, body });
};
const report = (callId: string, structured: object, transcript = 'AI: Hi\nUser: Sounds good') => signed('/webhooks/vapi', {
  token, event: { message: { type: 'end-of-call-report', call: { id: callId }, endedReason: 'customer-ended-call', startedAt: '2026-11-18T15:00:00Z', endedAt: '2026-11-18T15:12:00Z',
    artifact: { transcript, recordingUrl: 'https://storage.vapi.ai/rec.wav' }, analysis: { summary: 'Discussed the Growth plan.', structuredData: structured } } },
});
const stripeEvent = (id: string, link: string, opts: { bad?: boolean } = {}) => {
  const raw = JSON.stringify({ id, type: 'checkout.session.completed', data: { object: { payment_link: link, payment_status: 'paid', amount_total: 49900, currency: 'usd' } } });
  const ts = Math.floor(Date.now() / 1000);
  const v1 = createHmac('sha256', opts.bad ? 'whsec_wrongwrongwrongwrongwr' : WHSEC).update(`${ts}.${raw}`).digest('hex');
  return signed('/webhooks/stripe', { token, raw, signature: `t=${ts},v1=${v1}` });
};
const providerIdOf = async (leadId: string) => (await t.db.query(`select provider_call_id from calls where lead_id = $1 and agent = 'closer' order by created_at desc limit 1`, [leadId])).rows[0]?.provider_call_id;
async function addLead(name: string, meetingIn: number | null, phone: string | null) {
  const id = (await t.db.query(`insert into leads (workspace_id, campaign_id, email, full_name, stage, score, source_channel) values ($1,$2,$3,$4,'meeting_booked',90,'apollo') returning id`,
    [t.wsA, c, `${name.toLowerCase()}@bright.com`, `${name} Bright`])).rows[0].id;
  if (meetingIn !== null) {
    await t.db.query(`insert into meetings (workspace_id, lead_id, campaign_id, starts_at, booked_via, run_by, phone, event_name) values ($1,$2,$3, now() + make_interval(secs => $4), 'calendly', 'ai_closer', $5, 'Demo')`,
      [t.wsA, id, c, meetingIn, phone]);
  }
  return id;
}

describe('AI closer', () => {
  let f: ReturnType<typeof apis>;
  beforeAll(async () => {
    t = await startTestDb(55440);
    for (const [tool, secret] of [['vapi', { api_key: 'vapi-A' }], ['stripe', { secret_key: STRIPE_KEY }], ['pandadoc', { api_key: PD_KEY }], ['slack', { bot_token: 'xoxb-A' }]] as const) {
      await asUser(t.db, USERS.ownerA, (tx: any) => tx.query('select integration_connect($1, $2, $3::jsonb)', [t.wsA, tool, JSON.stringify(secret)]));
    }
    await t.db.query(`update workspaces set slack_channel = '#hot', name = 'Acme Growth' where id = $1`, [t.wsA]);
    await t.db.query(`insert into playbooks (workspace_id, version, content, is_active) values ($1, 1, $2::jsonb, true)`, [t.wsA, JSON.stringify(PLAYBOOK)]);
    token = (await t.db.query('select webhook_token from workspaces where id = $1', [t.wsA])).rows[0].webhook_token;
    c = (await t.db.query(`insert into campaigns (workspace_id, name, niche, status, sender_name, vapi_closer_assistant_id, vapi_phone_number_id)
      values ($1, 'Austin', 'dentists', 'active', 'Sam', '33333333-3333-4333-8333-333333333333', '22222222-2222-4222-8222-222222222222') returning id`, [t.wsA])).rows[0].id;
    ids.kim = await addLead('Kim', 30, '+15125550101');
    ids.lee = await addLead('Lee', 30, null);
    ids.old = await addLead('Old', -12 * 60, '+15125550103');
    server = createAgentServer(deps(apis()), { hmacSecret: SECRET, jobsPerRun: 5, healthCheck: async () => {} });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    f = apis();
  });
  afterAll(async () => { await new Promise<void>((r) => server.close(() => r())); await t?.close(); });

  test('CJ-01 meetings starting now are run by the closer; ones without a number or too late go to the team', async () => {
    const j = await runCloserJob(f);
    expect(j.status).toBe('succeeded');
    const calls = f.calls.filter((x) => /vapi\.ai\/call/.test(x.url)).map((x) => JSON.parse(String(x.init.body)));
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ assistantId: '33333333-3333-4333-8333-333333333333', customer: { number: '+15125550101' } });
    expect(calls[0].assistantOverrides.firstMessage).toMatch(/^Hi Kim, this is the AI assistant from Acme Growth/);
    expect(calls[0].assistantOverrides.model.messages[0].content).toContain('Growth: $499 a month');
    expect(calls[0].assistantOverrides.analysisPlan.structuredDataPlan.schema.properties.plan.enum).toEqual(['', 'Starter', 'Growth']);
    expect(j.result).toMatchObject({ calls_started: 1, handed_off: 2 });
    const m = async (id: string) => (await t.db.query(`select closer_status, run_by, closer_note from meetings where lead_id = $1`, [id])).rows[0];
    expect(await m(ids.kim)).toMatchObject({ closer_status: 'calling', run_by: 'ai_closer' });
    expect(await m(ids.lee)).toEqual({ closer_status: 'handed_off', run_by: 'human', closer_note: 'The prospect did not give a phone number for this meeting' });
    expect((await m(ids.old)).closer_note).toBe('The meeting time passed before the closer could call');
    expect((await t.db.query(`select count(*)::int n from follow_ups where lead_id in ($1, $2)`, [ids.lee, ids.old])).rows[0].n).toBe(2);
    expect(f.calls.filter((x) => /slack/.test(x.url))).toHaveLength(2);
  });

  test('CJ-02 a second run does not call the same meeting again', async () => {
    const g = apis();
    await runCloserJob(g);
    expect(g.calls.filter((x) => /vapi/.test(x.url))).toEqual([]);
  });

  test('CJ-03 an agreement is recorded at the playbook price and queues the proposal', async () => {
    const r = await report(await providerIdOf(ids.kim), { outcome: 'agreed', plan: 'growth', notes: 'Wants Growth for both sites' });
    expect(r.status).toBe(200);
    const mt = (await t.db.query(`select status, closer_status, attended, summary, recording_url from meetings where lead_id = $1`, [ids.kim])).rows[0];
    expect(mt).toEqual({ status: 'completed', closer_status: 'held', attended: true, summary: 'Discussed the Growth plan.', recording_url: 'https://storage.vapi.ai/rec.wav' });
    const d = (await t.db.query(`select stage, plan_name, value_cents::int as value_cents, currency, billing_interval, close_status from deals where lead_id = $1`, [ids.kim])).rows[0];
    expect(d).toEqual({ stage: 'meeting_held', plan_name: 'Growth', value_cents: 49900, currency: 'USD', billing_interval: 'month', close_status: 'pending' });
    expect((await t.db.query(`select count(*)::int n from agent_jobs where type = 'ai_closer' and status = 'queued'`)).rows[0].n).toBe(1);
  });

  test('CJ-04 the payment link and the proposal that carries it are sent', async () => {
    const g = apis();
    const j = await runCloserJob(g);
    expect(j.result).toMatchObject({ payment_links: 1, proposals_sent: 1 });
    const stripe = g.calls.filter((x) => /stripe/.test(x.url));
    expect(stripe.map((x) => x.url.replace('https://api.stripe.com/v1/', ''))).toEqual(['webhook_endpoints', 'prices', 'payment_links']);
    expect(Object.fromEntries(new URLSearchParams(String(stripe[0].init.body)))).toMatchObject({ url: `https://n8n.example.com/webhook/stripe/${token}`, 'enabled_events[0]': 'checkout.session.completed' });
    expect(Object.fromEntries(new URLSearchParams(String(stripe[1].init.body)))).toMatchObject({ unit_amount: '49900', currency: 'usd', 'recurring[interval]': 'month' });
    expect((stripe[1].init.headers as Record<string, string>).Authorization).toBe(`Bearer ${STRIPE_KEY}`);
    const doc = JSON.parse(String(g.calls.find((x) => /pandadoc\.com\/public\/v1\/documents$/.test(x.url))!.init.body));
    expect(doc.template_uuid).toBe('TplABCDEFGHIJ12345');
    expect(doc.recipients[0]).toMatchObject({ email: 'kim@bright.com', first_name: 'Kim', role: 'Client' });
    const d = (await t.db.query(`select stage, close_status, payment_status, agreement_status, payment_url, quote_url, stripe_payment_link_id from deals where lead_id = $1`, [ids.kim])).rows[0];
    expect(doc.tokens).toEqual(expect.arrayContaining([{ name: 'Payment.Link', value: d.payment_url }, { name: 'Plan.Price', value: '$499 a month' }]));
    expect(d).toMatchObject({ stage: 'proposal_sent', close_status: 'sent', payment_status: 'link_sent', agreement_status: 'sent' });
    expect(d.quote_url).toMatch(/^https:\/\/app\.pandadoc\.com\/a\/#\/documents\/Doc/);
    ids.link = d.stripe_payment_link_id;
    expect((await t.db.query(`select endpoint_id from stripe_endpoints where workspace_id = $1`, [t.wsA])).rows[0].endpoint_id).toBe('we_TEST123456');
  });

  test('CJ-05 a completed payment wins the deal once; forged or unknown payments do nothing', async () => {
    expect((await stripeEvent('evt_bad', ids.link, { bad: true })).status).toBe(401);
    expect(await (await stripeEvent('evt_1', ids.link)).json()).toEqual({ status: 'won' });
    expect(await (await stripeEvent('evt_1', ids.link)).json()).toEqual({ status: 'duplicate' });
    expect(await (await stripeEvent('evt_2', 'plink_UNKNOWN0001')).json()).toEqual({ status: 'ignored' });
    const d = (await t.db.query(`select stage, payment_status, closed_by, paid_at is not null as paid from deals where lead_id = $1`, [ids.kim])).rows[0];
    expect(d).toEqual({ stage: 'won', payment_status: 'paid', closed_by: 'ai', paid: true });
    expect((await t.db.query(`select stage from leads where id = $1`, [ids.kim])).rows[0].stage).toBe('won');
  });

  test('CJ-06 a failing proposal is retried, then handed to the team, without a second payment link', async () => {
    const lead = await addLead('Ann', null, null);
    await t.db.query(`insert into deals (workspace_id, lead_id, campaign_id, stage, plan_name, value_cents, currency, billing_interval, close_status) values ($1,$2,$3,'meeting_held','Starter',19900,'USD','month','pending')`, [t.wsA, lead, c]);
    const g = apis({ pandadoc: () => new Response('{}', { status: 500 }) });
    const states: string[] = [];
    for (let i = 0; i < 3; i++) {
      await runCloserJob(g);
      states.push((await t.db.query(`select close_status from deals where lead_id = $1`, [lead])).rows[0].close_status);
    }
    expect(states).toEqual(['pending', 'pending', 'failed']);
    expect(g.calls.filter((x) => /v1\/payment_links/.test(x.url))).toHaveLength(1);
    expect((await t.db.query(`select count(*)::int n from follow_ups where lead_id = $1`, [lead])).rows[0].n).toBe(1);
  });

  test('CJ-07 "don\'t call me again" in a meeting suppresses the number and loses the deal', async () => {
    const lead = await addLead('Dan', 30, '+15125550104');
    await runCloserJob(apis());
    await report(await providerIdOf(lead), { outcome: 'agreed', plan: 'Growth' }, "AI: Hi\nUser: Please don't call me again");
    expect((await t.db.query(`select stage from leads where id = $1`, [lead])).rows[0].stage).toBe('do_not_contact');
    expect((await t.db.query(`select stage, close_status from deals where lead_id = $1`, [lead])).rows[0]).toEqual({ stage: 'lost', close_status: 'none' });
    expect((await t.db.query(`select 1 from suppressions where workspace_id = $1 and value = '+15125550104'`, [t.wsA])).rows).toHaveLength(1);
  });

  test('CJ-08 requests outside the playbook, or an unclear plan, go to the team', async () => {
    const lead = await addLead('Eve', 30, '+15125550105');
    const lead2 = await addLead('Fay', 30, '+15125550106');
    const g = apis();
    await runCloserJob(g);
    await report(await providerIdOf(lead), { outcome: 'needs_human', handoff_reason: 'Asked for 20% off' });
    await report(await providerIdOf(lead2), { outcome: 'agreed', plan: '' });
    const deal = async (id: string) => (await t.db.query(`select close_status, stage from deals where lead_id = $1`, [id])).rows[0];
    expect(await deal(lead)).toEqual({ close_status: 'needs_team', stage: 'meeting_held' });
    expect(await deal(lead2)).toEqual({ close_status: 'needs_team', stage: 'meeting_held' });
    expect((await t.db.query(`select handed_off from calls where lead_id = $1`, [lead])).rows[0].handed_off).toBe(true);
  });

  test('CJ-09 with the AI closer switched off, meetings go to the team with the reason', async () => {
    await t.db.query(`update workspaces set ai_closer_enabled = false where id = $1`, [t.wsA]);
    const lead = await addLead('Gus', 30, '+15125550107');
    const g = apis();
    await runCloserJob(g);
    expect(g.calls.filter((x) => /vapi/.test(x.url))).toEqual([]);
    expect((await t.db.query(`select closer_note from meetings where lead_id = $1`, [lead])).rows[0].closer_note).toBe('The AI closer could not run it: the AI closer is switched off in Settings');
    await t.db.query(`update workspaces set ai_closer_enabled = true where id = $1`, [t.wsA]);
  });

  test('CJ-10 no API key or signing secret is stored with deals, events or job results', async () => {
    const dump = JSON.stringify([
      (await t.db.query(`select * from deals`)).rows, (await t.db.query(`select * from inbound_events`)).rows,
      (await t.db.query(`select result, error from agent_jobs`)).rows, (await t.db.query(`select * from activities`)).rows,
    ]);
    for (const s of [STRIPE_KEY, PD_KEY, WHSEC, token, 'vapi-A']) expect(dump).not.toContain(s);
  });
});
