// Public API (F29): request routing, key parsing and error mapping for the
// /api/v1 route. Every action is checked again in the database by api_call;
// this layer only turns HTTP into an action and the answer back into HTTP.

import { z } from 'zod';

export const API_KEY = /^sdr_[0-9a-f]{64}$/;
export const MAX_BODY = 16_000;

export const SCOPES = ['leads:read', 'leads:write', 'deals:read', 'campaigns:read', 'meetings:read'] as const;
export type Scope = (typeof SCOPES)[number];
export const SCOPE_LABELS: Record<Scope, string> = {
  'leads:read': 'Read leads',
  'leads:write': 'Add leads and change their stage',
  'deals:read': 'Read deals',
  'campaigns:read': 'Read campaigns',
  'meetings:read': 'Read meetings',
};

export const EVENTS = ['lead.created', 'lead.stage_changed', 'reply.received', 'meeting.booked', 'deal.won', 'deal.lost'] as const;
export type WebhookEvent = (typeof EVENTS)[number];
export const EVENT_LABELS: Record<WebhookEvent, string> = {
  'lead.created': 'A lead is added',
  'lead.stage_changed': 'A lead changes stage',
  'reply.received': 'A lead replies',
  'meeting.booked': 'A meeting is booked',
  'deal.won': 'A deal is won',
  'deal.lost': 'A deal is lost',
};

/** The key from "Authorization: Bearer sdr_..."; null when absent or malformed. */
export function bearerKey(header: string | null): string | null {
  const m = /^Bearer\s+(\S+)$/i.exec((header ?? '').trim());
  return m && API_KEY.test(m[1]) ? m[1] : null;
}

export type Route = { action: string; args: Record<string, unknown> } | { status: number; error: string };

const LIST_PARAMS: Record<string, string[]> = {
  leads: ['stage', 'campaign_id', 'updated_after', 'limit', 'cursor'],
  deals: ['stage', 'updated_after', 'limit', 'cursor'],
  campaigns: [],
  meetings: ['starts_after', 'limit', 'cursor'],
};
const ID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/** Maps a method, path and input to an api_call action. */
export function route(method: string, path: string[], query: URLSearchParams, body: Record<string, unknown> | null): Route {
  const [resource, id, ...rest] = path;
  if (!resource || !(resource in LIST_PARAMS) || rest.length) return { status: 404, error: 'Unknown endpoint' };
  if (id !== undefined && (resource !== 'leads' || !ID.test(id))) return { status: 404, error: 'Unknown endpoint' };
  if (method === 'GET') {
    if (id) return { action: 'leads.get', args: { id } };
    const args: Record<string, unknown> = {};
    for (const k of LIST_PARAMS[resource]) { const v = query.get(k); if (v !== null && v !== '') args[k] = v; }
    return { action: `${resource}.list`, args };
  }
  if (resource !== 'leads') return { status: 405, error: 'Method not allowed' };
  if (method === 'POST' && !id) return { action: 'leads.create', args: body ?? {} };
  if (method === 'PATCH' && id) return { action: 'leads.update', args: { ...(body ?? {}), id } };
  return { status: 405, error: 'Method not allowed' };
}

/** A JSON object body of at most 16 KB, or why not. */
export function readBody(raw: string): { body: Record<string, unknown> } | { error: string } {
  if (!raw.trim()) return { body: {} };
  if (raw.length > MAX_BODY) return { error: 'The request body must be at most 16 KB' };
  try {
    const v = JSON.parse(raw);
    if (!v || typeof v !== 'object' || Array.isArray(v)) return { error: 'The request body must be a JSON object' };
    return { body: v as Record<string, unknown> };
  } catch {
    return { error: 'The request body is not valid JSON' };
  }
}

/** A database error to an HTTP answer. Only messages written for callers are passed on. */
export function apiError(e: { code?: string; message?: string } | null): { status: number; error: string } {
  const msg = e?.message ?? '';
  switch (e?.code) {
    case '28000': return { status: 401, error: 'Invalid API key' };
    case '42501': return { status: 403, error: /^This key does not have the [a-z:]+ scope$/.test(msg) ? msg : 'This key cannot do that' };
    case '53400': return { status: 429, error: 'Rate limit reached: 120 requests a minute per key' };
    case 'P0002': return { status: 404, error: 'Not found' };
    case '22023': return { status: 422, error: msg.length <= 300 && !/[<>]/.test(msg) ? msg : 'The request is not valid' };
    default: return { status: 500, error: 'Something went wrong. Try again shortly.' };
  }
}

// ---------------------------------------------------------------- settings forms

export const keySchema = z.object({
  name: z.string().trim().min(1, 'Give the key a name.').max(80, 'Keep the name under 80 characters.'),
  scopes: z.array(z.enum(SCOPES)).min(1, 'Choose at least one permission.'),
});

export const endpointSchema = z.object({
  url: z.string().trim().max(500, 'Keep the address under 500 characters.')
    .refine((u) => /^https:\/\/[A-Za-z0-9.-]+(\/[^\s]*)?$/.test(u), 'Use an https address on the standard port, such as https://hooks.example.com/sdr.'),
  description: z.string().trim().max(200, 'Keep the description under 200 characters.').transform((v) => v || null),
  events: z.array(z.enum(EVENTS)).min(1, 'Choose at least one event.'),
});

export const DELIVERY_LABELS: Record<string, string> = { pending: 'Waiting to retry', sending: 'Sending', delivered: 'Delivered', dead: 'Gave up after 6 attempts' };

/** How a receiver checks a delivery; shown on the page and in the API guide. */
export const VERIFY_EXAMPLE = `// Node.js: check X-SDR-Signature before trusting a delivery
import { createHmac, timingSafeEqual } from 'node:crypto';

function verify(rawBody, header, secret) {
  const [, t, v1] = /^t=(\\d+),v1=([0-9a-f]{64})$/.exec(header ?? '') ?? [];
  if (!t || Math.abs(Date.now() / 1000 - Number(t)) > 300) return false; // older than 5 minutes
  const expected = createHmac('sha256', secret).update(\`\${t}.\${rawBody}\`).digest('hex');
  return timingSafeEqual(Buffer.from(expected), Buffer.from(v1));
}`;
