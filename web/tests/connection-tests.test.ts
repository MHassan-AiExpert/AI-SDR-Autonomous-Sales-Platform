import { describe, expect, it, vi } from 'vitest';
import { PROBES, testConnection } from '@/lib/connection-tests';
import { TOOL_IDS, type ToolId } from '@/lib/integrations';

const CREDS: Record<ToolId, Record<string, string>> = {
  openai: { api_key: 'sk-SECRET-openai' },
  anthropic: { api_key: 'sk-ant-SECRET' },
  gemini: { api_key: 'AIza-SECRET' },
  apollo: { api_key: 'apollo-SECRET' },
  apify: { api_token: 'apify_api_SECRET' },
  zerobounce: { api_key: 'zb-SECRET' },
  instantly: { api_key: 'inst-SECRET' },
  twilio: { account_sid: 'AC' + '1'.repeat(32), auth_token: 'SECRETtwilioTOKEN000000000000000' },
  vapi: { api_key: 'vapi-SECRET' },
  whatsapp: { phone_number_id: '1234567890', access_token: 'EAAG-SECRET' },
  zoom: { account_id: 'acct_123456', client_id: 'client_12345', client_secret: 'zoom-SECRET' },
  calendly: { access_token: 'cal-SECRET' },
  hubspot: { access_token: 'pat-na1-SECRET' },
  slack: { bot_token: 'xoxb-SECRET-12345' },
  pandadoc: { api_key: 'pd-SECRET' },
  stripe: { secret_key: 'sk_test_SECRETstripe' },
};

const GOOD_BODY: Partial<Record<ToolId, unknown>> = {
  apollo: { is_logged_in: true },
  zerobounce: { Credits: '2500' },
  twilio: { status: 'active' },
  whatsapp: { display_phone_number: '+1 555 0100' },
  slack: { ok: true, team: 'Acme' },
};

function mockFetch(status: number, body: unknown = {}) {
  return vi.fn(async (_url: string | URL | Request, _init?: RequestInit) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }));
}

describe('connection tests', () => {
  it('CT-01 every tool passes when the service accepts the credentials', async () => {
    for (const tool of TOOL_IDS) {
      const r = await testConnection(tool, CREDS[tool], mockFetch(200, GOOD_BODY[tool] ?? {}) as typeof fetch);
      expect(r, tool).toMatchObject({ ok: true });
    }
  });

  it('CT-02 every request goes over HTTPS to the tool\'s own domain, with no redirects followed', async () => {
    const domains: Record<ToolId, string> = {
      openai: 'api.openai.com', anthropic: 'api.anthropic.com', gemini: 'generativelanguage.googleapis.com',
      apollo: 'api.apollo.io', apify: 'api.apify.com', zerobounce: 'api.zerobounce.net', instantly: 'api.instantly.ai',
      twilio: 'api.twilio.com', vapi: 'api.vapi.ai', whatsapp: 'graph.facebook.com', zoom: 'zoom.us',
      calendly: 'api.calendly.com', hubspot: 'api.hubapi.com', slack: 'slack.com', pandadoc: 'api.pandadoc.com', stripe: 'api.stripe.com',
    };
    for (const tool of TOOL_IDS) {
      const f = mockFetch(200, GOOD_BODY[tool] ?? {});
      await testConnection(tool, CREDS[tool], f as typeof fetch);
      const [url, init] = f.mock.calls[0];
      const u = new URL(String(url));
      expect(u.protocol, tool).toBe('https:');
      expect(u.hostname, tool).toBe(domains[tool]);
      expect(init?.redirect, tool).toBe('error');
      expect(init?.signal, tool).toBeInstanceOf(AbortSignal);
    }
  });

  it('CT-03 secrets travel in headers, never in the address (except ZeroBounce, which requires it)', async () => {
    for (const tool of TOOL_IDS) {
      const f = mockFetch(200, GOOD_BODY[tool] ?? {});
      await testConnection(tool, CREDS[tool], f as typeof fetch);
      const url = String(f.mock.calls[0][0]);
      const secretValues = Object.entries(CREDS[tool]).filter(([k]) => !['account_sid', 'phone_number_id', 'account_id'].includes(k)).map(([, v]) => v);
      for (const s of secretValues) {
        if (tool === 'zerobounce') expect(url).toContain(encodeURIComponent(s));
        else expect(url, tool).not.toContain(s);
      }
    }
  });

  it('CT-04 tools that need it use POST and Basic authentication', async () => {
    const zoom = mockFetch(200);
    await testConnection('zoom', CREDS.zoom, zoom as typeof fetch);
    expect(zoom.mock.calls[0][1]?.method).toBe('POST');
    expect((zoom.mock.calls[0][1]?.headers as Record<string, string>).Authorization)
      .toBe('Basic ' + Buffer.from('client_12345:zoom-SECRET').toString('base64'));
    const twilio = mockFetch(200, { status: 'active' });
    await testConnection('twilio', CREDS.twilio, twilio as typeof fetch);
    expect(twilio.mock.calls[0][1]?.method).toBe('GET');
    expect((twilio.mock.calls[0][1]?.headers as Record<string, string>).Authorization).toMatch(/^Basic /);
  });

  it('CT-05 rejected credentials give a clear message that never contains the secret', async () => {
    for (const status of [401, 403]) {
      for (const tool of TOOL_IDS) {
        const r = await testConnection(tool, CREDS[tool], mockFetch(status) as typeof fetch);
        expect(r.ok).toBe(false);
        if (!r.ok) {
          expect(r.error).toMatch(/rejected these credentials/);
          expect(r.error).not.toMatch(/SECRET/);
        }
      }
    }
  });

  it('CT-06 not found, rate limits and server errors are explained', async () => {
    const r404 = await testConnection('twilio', CREDS.twilio, mockFetch(404) as typeof fetch);
    const r429 = await testConnection('openai', CREDS.openai, mockFetch(429) as typeof fetch);
    const r500 = await testConnection('stripe', CREDS.stripe, mockFetch(503) as typeof fetch);
    expect(!r404.ok && r404.error).toMatch(/could not find this account/);
    expect(!r429.ok && r429.error).toMatch(/rate limiting/);
    expect(!r500.ok && r500.error).toMatch(/returned an error \(503\)/);
  });

  it('CT-07 network failures and timeouts are reported without crashing', async () => {
    const failing = vi.fn(async () => { throw new TypeError('fetch failed'); });
    const r = await testConnection('vapi', CREDS.vapi, failing as unknown as typeof fetch);
    expect(r).toEqual({ ok: false, error: 'Could not reach Vapi. Check your connection and try again.' });
    const timeout = vi.fn(async () => { throw new DOMException('timed out', 'TimeoutError'); });
    const t = await testConnection('openai', CREDS.openai, timeout as unknown as typeof fetch);
    expect(t.ok).toBe(false);
  });

  it('CT-08 services that report failure inside a successful response are caught', async () => {
    const slack = await testConnection('slack', CREDS.slack, mockFetch(200, { ok: false, error: 'invalid_auth' }) as typeof fetch);
    expect(!slack.ok && slack.error).toMatch(/Slack did not accept/);
    const zb = await testConnection('zerobounce', CREDS.zerobounce, mockFetch(200, { Credits: '-1' }) as typeof fetch);
    expect(!zb.ok && zb.error).toMatch(/ZeroBounce did not accept/);
    const apollo = await testConnection('apollo', CREDS.apollo, mockFetch(200, { is_logged_in: false }) as typeof fetch);
    expect(apollo.ok).toBe(false);
    const twilio = await testConnection('twilio', CREDS.twilio, mockFetch(200, { status: 'suspended' }) as typeof fetch);
    expect(!twilio.ok && twilio.error).toMatch(/suspended/);
    const slackHtml = await testConnection('slack', CREDS.slack, vi.fn(async () => new Response('<html>', { status: 200 })) as unknown as typeof fetch);
    expect(slackHtml.ok).toBe(false);
  });

  it('CT-09 useful details are returned: credits, Slack team, WhatsApp number', async () => {
    expect(await testConnection('zerobounce', CREDS.zerobounce, mockFetch(200, { Credits: '2500' }) as typeof fetch)).toEqual({ ok: true, credits: 2500 });
    expect(await testConnection('slack', CREDS.slack, mockFetch(200, { ok: true, team: 'Acme' }) as typeof fetch)).toEqual({ ok: true, detail: { team: 'Acme' } });
    expect(await testConnection('whatsapp', CREDS.whatsapp, mockFetch(200, { display_phone_number: '+1 555 0100' }) as typeof fetch))
      .toEqual({ ok: true, detail: { phone: '+1 555 0100' } });
  });

  it('CT-10 every tool has a probe', () => {
    expect(Object.keys(PROBES).sort()).toEqual([...TOOL_IDS].sort());
  });
});
