import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import type { AddressInfo } from 'node:net';
import { createAgentServer, sign, verifySignature } from '../src/server.ts';
import type { Deps } from '../src/jobs.ts';
import type { Store } from '../src/store.ts';

const SECRET = 'x'.repeat(40);
let claimed = 0;
let dbUp = true;
const store = { claimJobs: async () => { claimed++; await new Promise((r) => setTimeout(r, 50)); return []; } } as unknown as Store;
const server = createAgentServer({ store, models: { openai: 'o', anthropic: null, gemini: 'g' } } as Deps, {
  hmacSecret: SECRET, jobsPerRun: 3, healthCheck: async () => { if (!dbUp) throw new Error('down'); },
});
let base = '';
beforeAll(async () => {
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

const now = () => String(Math.floor(Date.now() / 1000));
const run = (headers: Record<string, string>, body = '{}') => fetch(`${base}/jobs/run`, { method: 'POST', headers, body });

describe('agent service HTTP', () => {
  test('SRV-01 signatures cover the timestamp and body and expire after five minutes', () => {
    const ts = now();
    const sig = sign(SECRET, ts, '{}');
    expect(verifySignature(SECRET, ts, sig, '{}')).toBe(true);
    expect(verifySignature(SECRET, ts, sig, '{"x":1}')).toBe(false);
    expect(verifySignature('y'.repeat(40), ts, sig, '{}')).toBe(false);
    expect(verifySignature(SECRET, ts, sig, '{}', Date.now() + 301_000)).toBe(false);
    expect(verifySignature(SECRET, undefined, sig, '{}')).toBe(false);
    expect(verifySignature(SECRET, ts, 'zz', '{}')).toBe(false);
  });

  test('SRV-02 an unsigned or badly signed run request is refused without running jobs', async () => {
    const before = claimed;
    expect((await run({})).status).toBe(401);
    expect((await run({ 'x-timestamp': now(), 'x-signature': 'a'.repeat(64) })).status).toBe(401);
    const old = String(Math.floor(Date.now() / 1000) - 600);
    expect((await run({ 'x-timestamp': old, 'x-signature': sign(SECRET, old, '{}') })).status).toBe(401);
    expect(claimed).toBe(before);
  });

  test('SRV-03 a signed request runs the queue', async () => {
    const ts = now();
    const res = await run({ 'x-timestamp': ts, 'x-signature': sign(SECRET, ts, '{}') });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'ok', jobs: [] });
  });

  test('SRV-04 overlapping runs in one process are turned away, not doubled', async () => {
    const ts = now();
    const h = { 'x-timestamp': ts, 'x-signature': sign(SECRET, ts, '{}') };
    const [a, b] = await Promise.all([run(h), run(h)]);
    expect([a.status, b.status].sort()).toEqual([200, 202]);
  });

  test('SRV-05 health reports the database and unknown paths are 404', async () => {
    expect((await fetch(`${base}/health`)).status).toBe(200);
    dbUp = false;
    const down = await fetch(`${base}/health`);
    dbUp = true;
    expect(down.status).toBe(503);
    expect((await fetch(`${base}/admin`)).status).toBe(404);
  });

  test('SRV-06 oversized bodies are rejected', async () => {
    expect((await run({}, 'x'.repeat(20_000))).status).toBe(413);
  });
});

describe('scheduler workflow', () => {
  test('SRV-07 the request the n8n workflow signs is accepted by the service', async () => {
    const { readFileSync } = await import('node:fs');
    const { createRequire } = await import('node:module');
    const wf = JSON.parse(readFileSync(new URL('../../infra/n8n/workflows/agent-scheduler.json', import.meta.url), 'utf8'));
    const code = wf.nodes.find((n: any) => n.type === 'n8n-nodes-base.code').parameters.jsCode;
    const [{ json }] = new Function('require', '$env', code)(createRequire(import.meta.url), { PLATFORM_HMAC_SECRET: SECRET });
    const res = await run({ 'x-timestamp': json.timestamp, 'x-signature': json.signature, 'content-type': 'application/json' }, json.body);
    expect(res.status).toBe(200);
  });
});
