// Live connection tests. Each one makes a single read-only request to the
// tool with the credentials just entered, to prove they work before saving.
// Runs on the server only; credentials never appear in results or errors.

import { TOOLS, type ToolId } from './integrations';

export type TestResult =
  | { ok: true; credits?: number; detail?: Record<string, string> }
  | { ok: false; error: string };

type Fetch = typeof fetch;

const TIMEOUT_MS = 10_000;
const META_GRAPH_VERSION = 'v21.0';

type Probe = {
  url: (c: Record<string, string>) => string;
  init: (c: Record<string, string>) => RequestInit;
  /** Optional extra check of the response body. */
  read?: (body: unknown) => TestResult;
};

const bearer = (token: string): RequestInit => ({ headers: { Authorization: `Bearer ${token}` } });
const basic = (user: string, pass: string) => `Basic ${Buffer.from(`${user}:${pass}`).toString('base64')}`;

export const PROBES: Record<ToolId, Probe> = {
  openai: { url: () => 'https://api.openai.com/v1/models', init: (c) => bearer(c.api_key) },
  anthropic: {
    url: () => 'https://api.anthropic.com/v1/models',
    init: (c) => ({ headers: { 'x-api-key': c.api_key, 'anthropic-version': '2023-06-01' } }),
  },
  gemini: {
    url: () => 'https://generativelanguage.googleapis.com/v1beta/models?pageSize=1',
    init: (c) => ({ headers: { 'x-goog-api-key': c.api_key } }),
  },
  apollo: {
    url: () => 'https://api.apollo.io/api/v1/auth/health',
    init: (c) => ({ headers: { 'x-api-key': c.api_key } }),
    read: (b) => (isObj(b) && b.is_logged_in === false ? { ok: false, error: 'Apollo did not accept this API key.' } : { ok: true }),
  },
  apify: { url: () => 'https://api.apify.com/v2/users/me', init: (c) => bearer(c.api_token) },
  zerobounce: {
    // ZeroBounce only accepts the key as a query parameter.
    url: (c) => `https://api.zerobounce.net/v2/getcredits?api_key=${encodeURIComponent(c.api_key)}`,
    init: () => ({}),
    read: (b) => {
      const credits = isObj(b) ? Number(b.Credits) : NaN;
      if (!Number.isFinite(credits) || credits < 0) return { ok: false, error: 'ZeroBounce did not accept this API key.' };
      return { ok: true, credits };
    },
  },
  instantly: { url: () => 'https://api.instantly.ai/api/v2/accounts?limit=1', init: (c) => bearer(c.api_key) },
  twilio: {
    url: (c) => `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(c.account_sid)}.json`,
    init: (c) => ({ headers: { Authorization: basic(c.account_sid, c.auth_token) } }),
    read: (b) => (isObj(b) && b.status && b.status !== 'active'
      ? { ok: false, error: `This Twilio account is ${String(b.status)}.` }
      : { ok: true }),
  },
  vapi: { url: () => 'https://api.vapi.ai/assistant?limit=1', init: (c) => bearer(c.api_key) },
  whatsapp: {
    url: (c) => `https://graph.facebook.com/${META_GRAPH_VERSION}/${encodeURIComponent(c.phone_number_id)}?fields=display_phone_number,verified_name`,
    init: (c) => bearer(c.access_token),
    read: (b) => ({ ok: true, detail: isObj(b) && typeof b.display_phone_number === 'string' ? { phone: b.display_phone_number } : undefined }),
  },
  zoom: {
    url: (c) => `https://zoom.us/oauth/token?grant_type=account_credentials&account_id=${encodeURIComponent(c.account_id)}`,
    init: (c) => ({ method: 'POST', headers: { Authorization: basic(c.client_id, c.client_secret) } }),
  },
  calendly: { url: () => 'https://api.calendly.com/users/me', init: (c) => bearer(c.access_token) },
  hubspot: { url: () => 'https://api.hubapi.com/crm/v3/objects/contacts?limit=1', init: (c) => bearer(c.access_token) },
  slack: {
    url: () => 'https://slack.com/api/auth.test',
    init: (c) => ({ method: 'POST', ...bearer(c.bot_token) }),
    // Slack answers 200 with { ok: false } for a bad token.
    read: (b) => (isObj(b) && b.ok === true
      ? { ok: true, detail: typeof b.team === 'string' ? { team: b.team } : undefined }
      : { ok: false, error: 'Slack did not accept this bot token.' }),
  },
  pandadoc: {
    url: () => 'https://api.pandadoc.com/public/v1/documents?count=1',
    init: (c) => ({ headers: { Authorization: `API-Key ${c.api_key}` } }),
  },
  stripe: {
    url: () => 'https://api.stripe.com/v1/balance',
    init: (c) => bearer(c.secret_key),
  },
};

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

export async function testConnection(tool: ToolId, credentials: Record<string, string>, fetchImpl: Fetch = fetch): Promise<TestResult> {
  const name = TOOLS[tool].name;
  const probe = PROBES[tool];
  let response: Response;
  try {
    const init = probe.init(credentials);
    response = await fetchImpl(probe.url(credentials), {
      method: 'GET',
      ...init,
      headers: { Accept: 'application/json', ...(init.headers as Record<string, string> | undefined) },
      redirect: 'error',
      cache: 'no-store',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    return { ok: false, error: `Could not reach ${name}. Check your connection and try again.` };
  }

  if (response.status === 401 || response.status === 403) {
    return { ok: false, error: `${name} rejected these credentials.` };
  }
  if (response.status === 404) {
    return { ok: false, error: `${name} could not find this account. Check the identifiers.` };
  }
  if (response.status === 429) {
    return { ok: false, error: `${name} is rate limiting requests. Wait a minute and try again.` };
  }
  if (!response.ok) {
    return { ok: false, error: `${name} returned an error (${response.status}). Try again shortly.` };
  }

  if (!probe.read) return { ok: true };
  let body: unknown = null;
  try {
    body = await response.json();
  } catch {
    body = null;
  }
  return probe.read(body);
}
