import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import { createHmac } from 'node:crypto';
import { attempt, deliverWebhooks, sign, signatureHeader, type Delivery } from '../src/webhooksOut.ts';
import { runQueuedJobs, type Deps } from '../src/jobs.ts';
import { startTestDb, fakeFetch, asUser, USERS, type TestDb } from './harness.ts';

const publicDns = async () => ['93.184.216.34'];
const d = (over: Partial<Delivery> = {}): Delivery => ({
  id: 'del-1', workspace_id: 'w', endpoint_id: 'e', url: 'https://hooks.example.com/sdr', secret: 'whsec_' + 'a'.repeat(64),
  event: 'deal.won', payload: { id: 'evt-1', type: 'deal.won', data: { value_cents: 5000 } }, attempts: 1, ...over,
});

describe('signing and sending', () => {
  test('WHO-01 the signature is an HMAC of "<timestamp>.<body>" a receiver can recompute', () => {
    const body = '{"id":"evt-1"}';
    const expected = createHmac('sha256', 'whsec_x').update(`1763370000.${body}`).digest('hex');
    expect(sign('whsec_x', 1763370000, body)).toBe(expected);
    expect(signatureHeader('whsec_x', 1763370000, body)).toBe(`t=1763370000,v1=${expected}`);
  });

  test('WHO-02 a delivery is a signed POST of the stored event, with the event and delivery ids in headers', async () => {
    const f = fakeFetch([[/hooks\.example\.com/, () => new Response('ignored', { status: 202 })]]);
    const r = await attempt(d(), f.impl, publicDns, () => 1_763_370_000_000);
    expect(r).toEqual({ ok: true, status: 202, error: null });
    const [call] = f.calls;
    expect(call.init.method).toBe('POST');
    expect(call.init.redirect).toBe('manual');
    const body = String(call.init.body);
    expect(JSON.parse(body)).toEqual(d().payload);
    expect(call.init.headers).toMatchObject({
      'Content-Type': 'application/json', 'X-SDR-Event': 'deal.won', 'X-SDR-Delivery': 'del-1',
      'X-SDR-Signature': signatureHeader(d().secret, 1_763_370_000, body),
    });
    expect(JSON.stringify(call.init.headers)).not.toContain(d().secret);
  });

  test('WHO-03 private addresses, plain http, other ports and IP literals are refused before any request', async () => {
    const f = fakeFetch([[/./, () => ({})]]);
    expect((await attempt(d(), f.impl, async () => ['10.0.0.5'])).error).toMatch(/^Address refused/);
    expect((await attempt(d({ url: 'http://hooks.example.com/x' }), f.impl, publicDns)).error).toMatch(/https/);
    expect((await attempt(d({ url: 'https://hooks.example.com:8443/x' }), f.impl, publicDns)).error).toMatch(/Non-standard port/);
    expect((await attempt(d({ url: 'https://169.254.169.254/latest' }), f.impl, publicDns)).error).toMatch(/IP addresses/);
    expect((await attempt(d({ url: 'https://localhost/x' }), f.impl, async () => ['127.0.0.1'])).error).toMatch(/public address/);
    expect(f.calls).toHaveLength(0);
  });

  test('WHO-04 errors, redirects and timeouts are failures with a short reason', async () => {
    expect(await attempt(d(), fakeFetch([[/./, () => new Response('', { status: 500 })]]).impl, publicDns)).toEqual({ ok: false, status: 500, error: 'HTTP 500' });
    expect((await attempt(d(), fakeFetch([[/./, () => new Response('', { status: 302, headers: { Location: 'http://10.0.0.1' } })]]).impl, publicDns)).error).toMatch(/Redirected/);
    const hang = (async () => { throw Object.assign(new Error('t'), { name: 'TimeoutError' }); }) as unknown as typeof fetch;
    expect((await attempt(d(), hang, publicDns)).error).toBe('No answer within 10 seconds');
    const down = (async () => { throw new Error('ECONNREFUSED'); }) as unknown as typeof fetch;
    expect((await attempt(d(), down, publicDns)).error).toBe('Could not connect');
  });
});

describe('the delivery loop', () => {
  let t: TestDb;
  let ep = '';
  let status = 200;
  const apis = () => fakeFetch([
    [/hooks\.example\.com/, () => new Response('', { status })],
    [/slack\.com/, () => ({ ok: true })],
  ]);
  const deps = (f: ReturnType<typeof apis>): Deps & { resolve: typeof publicDns } => ({ store: t.store, models: { openai: 'o', anthropic: null, gemini: 'g' }, fetchImpl: f.impl, resolve: publicDns });
  const rows = async () => (await t.db.query(`select event, status, attempts, last_status, last_error from webhook_deliveries where workspace_id = $1 order by created_at`, [t.wsA])).rows;

  beforeAll(async () => {
    t = await startTestDb(55450);
    ep = (await asUser(t.db, USERS.ownerA, (tx: any) => tx.query(
      `insert into webhook_endpoints (workspace_id, url, events) values ($1, 'https://hooks.example.com/sdr', '{lead.stage_changed,deal.won}') returning id`, [t.wsA]))).rows[0].id;
  });
  afterAll(async () => t?.close());

  test('WHO-05 an event reaches the endpoint within one cycle of the job loop', async () => {
    const lead = (await t.db.query(`insert into leads (workspace_id, email, source_channel) values ($1, 'kim@bright.test', 'manual') returning id`, [t.wsA])).rows[0].id;
    await t.db.query(`update leads set stage = 'interested' where id = $1`, [lead]);
    const f = apis();
    await runQueuedJobs(deps(f), 1);
    expect(await rows()).toEqual([{ event: 'lead.stage_changed', status: 'delivered', attempts: 1, last_status: 200, last_error: null }]);
    const body = JSON.parse(String(f.calls[0].init.body));
    expect(body).toMatchObject({ type: 'lead.stage_changed', data: { email: 'kim@bright.test', stage: 'interested', previous_stage: 'new' } });
    // The receiver can verify it with the endpoint's secret
    const secret = (await asUser(t.db, USERS.ownerA, (tx: any) => tx.query('select webhook_endpoint_secret($1) as s', [ep]))).rows[0].s;
    const [, ts, v1] = /^t=(\d+),v1=([0-9a-f]{64})$/.exec(String((f.calls[0].init.headers as Record<string, string>)['X-SDR-Signature']))!;
    expect(sign(secret, Number(ts), String(f.calls[0].init.body))).toBe(v1);
  });

  test('WHO-06 a failure is retried later, not straight away, and succeeds on a later attempt', async () => {
    await t.db.query('delete from webhook_deliveries');
    await asUser(t.db, USERS.ownerA, (tx: any) => tx.query('select webhook_send_test($1)', [ep]));
    status = 503;
    expect(await deliverWebhooks(deps(apis()))).toEqual({ sent: 0, failed: 1, disabled: 0 });
    expect((await rows())[0]).toMatchObject({ status: 'pending', attempts: 1, last_status: 503, last_error: 'HTTP 503' });
    const again = apis();
    await deliverWebhooks(deps(again));
    expect(again.calls).toHaveLength(0);
    status = 200;
    await t.db.query(`update webhook_deliveries set next_attempt_at = now() - interval '1 second'`);
    expect(await deliverWebhooks(deps(apis()))).toEqual({ sent: 1, failed: 0, disabled: 0 });
    expect((await rows())[0]).toMatchObject({ status: 'delivered', attempts: 2, last_error: null });
  });

  test('WHO-07 an endpoint that keeps failing is switched off and the team is told once', async () => {
    await t.db.query(`update webhook_endpoints set consecutive_failures = 14 where id = $1`, [ep]);
    await asUser(t.db, USERS.ownerA, (tx: any) => tx.query('select webhook_send_test($1)', [ep]));
    status = 410;
    expect(await deliverWebhooks(deps(apis()))).toEqual({ sent: 0, failed: 1, disabled: 1 });
    status = 200;
    expect((await t.db.query('select active from webhook_endpoints where id = $1', [ep])).rows[0].active).toBe(false);
    const n = (await t.db.query(`select title, severity, link_path from notifications where workspace_id = $1 and title like 'Webhook switched off%'`, [t.wsA])).rows;
    expect(n).toEqual([{ title: 'Webhook switched off: hooks.example.com', severity: 'warning', link_path: `/w/${t.wsA}/developers` }]);
  });

  test('WHO-08 an address that resolves privately fails without a request and counts as a failure', async () => {
    await asUser(t.db, USERS.ownerA, (tx: any) => tx.query(`update webhook_endpoints set active = true where id = $1`, [ep]));
    await t.db.query('delete from webhook_deliveries');
    await asUser(t.db, USERS.ownerA, (tx: any) => tx.query('select webhook_send_test($1)', [ep]));
    const f = apis();
    const r = await deliverWebhooks({ ...deps(f), resolve: async () => ['192.168.1.10'] });
    expect(r).toEqual({ sent: 0, failed: 1, disabled: 0 });
    expect(f.calls).toHaveLength(0);
    expect((await rows())[0].last_error).toMatch(/^Address refused/);
  });
});
