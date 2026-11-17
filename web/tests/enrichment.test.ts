import { describe, expect, test } from 'vitest';
import { describeOrder, matchRateLabel, parseOrderForm, savedOrder, toStats } from '../src/lib/enrichment';
import { PROBES, testConnection } from '../src/lib/connection-tests';
import { TOOLS, buildOnboardingPlan } from '../src/lib/integrations';

const form = (values: Record<string, string>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(values)) f.set(k, v);
  return f;
};

describe('contact finder order', () => {
  test('WFW-01 positions are read in order and empty positions are skipped', () => {
    expect(parseOrderForm(form({ order_1: 'hunter', order_2: '', order_3: 'apollo' }))).toEqual({ ok: true, order: ['hunter', 'apollo'] });
    expect(parseOrderForm(form({}))).toEqual({ ok: true, order: [] });
  });

  test('WFW-02 a provider chosen twice, or an unknown one, is refused with a reason', () => {
    expect(parseOrderForm(form({ order_1: 'pdl', order_2: 'pdl' }))).toEqual({ ok: false, error: 'People Data Labs is chosen twice. Pick each provider once, or leave a position empty.' });
    expect(parseOrderForm(form({ order_1: 'clearbit' }))).toEqual({ ok: false, error: 'Choose a provider from the list.' });
  });

  test('WFW-03 the saved order drops unknown values, and the sentence names only connected providers', () => {
    expect(savedOrder(['pdl', 'x', 'apollo'])).toEqual(['pdl', 'apollo']);
    expect(savedOrder(null)).toEqual(['apollo', 'hunter', 'pdl']);
    expect(describeOrder(['apollo', 'hunter', 'pdl'], new Set(['apollo', 'pdl'])))
      .toBe('The agent asks Apollo, then People Data Labs, then reads the company website, and stops at the first that finds someone.');
    expect(describeOrder(['hunter'], new Set(['apollo']))).toMatch(/company websites only/);
  });

  test('WFW-04 stats rows from Postgres become numbers, and a provider never asked says so', () => {
    expect(toStats([{ provider: 'hunter', attempts: '4', found: '1', errors: '0', match_rate: '25.0', leads: '1' }]))
      .toEqual([{ provider: 'hunter', attempts: 4, found: 1, errors: 0, match_rate: 25, leads: 1 }]);
    expect(matchRateLabel(33.3)).toBe('33.3%');
    expect(matchRateLabel(50)).toBe('50%');
    expect(matchRateLabel(null)).toBe('Not asked yet');
  });
});

describe('new tools', () => {
  test('WFW-05 Hunter and People Data Labs are optional onboarding steps', () => {
    const plan = buildOnboardingPlan({ enabledChannels: {}, aiCloserEnabled: false, statuses: { hunter: 'connected' }, checklist: {} });
    const step = plan.steps.find((s) => s.id === 'contact_data')!;
    expect(step).toMatchObject({ tools: ['hunter', 'pdl'], required: false, done: true });
    expect(TOOLS.pdl.fields[0]).toMatchObject({ name: 'api_key', secret: true });
  });

  test('WFW-06 the Hunter test sends the key as a header and reads the credits left', async () => {
    let seen: { url: string; init: RequestInit } | null = null;
    const res = await testConnection('hunter', { api_key: 'hunter-secret-123' }, (async (url: string, init: RequestInit) => {
      seen = { url, init };
      return new Response(JSON.stringify({ data: { requests: { searches: { used: 10, available: 50 } } } }), { status: 200 });
    }) as unknown as typeof fetch);
    expect(res).toEqual({ ok: true, credits: 40 });
    expect(seen!.url).toBe('https://api.hunter.io/v2/account');
    expect((seen!.init.headers as Record<string, string>)['X-API-KEY']).toBe('hunter-secret-123');
  });

  test('WFW-07 the People Data Labs test is a search that finds no one: 404 proves the key, 401 refuses it, 402 is out of credits', async () => {
    const answer = (status: number) => (async () => new Response('{}', { status })) as unknown as typeof fetch;
    expect(await testConnection('pdl', { api_key: 'pdl-secret-123' }, answer(404))).toEqual({ ok: true });
    expect(await testConnection('pdl', { api_key: 'pdl-secret-123' }, answer(401))).toEqual({ ok: false, error: 'People Data Labs rejected these credentials.' });
    expect(await testConnection('pdl', { api_key: 'pdl-secret-123' }, answer(402))).toEqual({ ok: false, error: 'People Data Labs accepted these credentials but the account has no credits left.' });
    const init = PROBES.pdl.init({ api_key: 'k' });
    expect(init.method).toBe('POST');
    expect(JSON.parse(String(init.body)).size).toBe(1);
  });
});
