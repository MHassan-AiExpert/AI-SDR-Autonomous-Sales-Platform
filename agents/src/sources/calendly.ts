// Calendly API v2: single-use booking links and booking notifications.

import { createHmac, timingSafeEqual } from 'node:crypto';
import { requestJson, isObject, str, type Fetch } from '../http.ts';

const BASE = 'https://api.calendly.com';
const auth = (token: string) => ({ Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' });

export async function getMe(token: string, fetchImpl?: Fetch): Promise<{ user: string; organization: string }> {
  const body = await requestJson('Calendly', `${BASE}/users/me`, { method: 'GET', headers: auth(token) }, { fetchImpl });
  const r = isObject(body) && isObject(body.resource) ? body.resource : {};
  const user = str(r.uri);
  const organization = str(r.current_organization);
  if (!user || !organization) throw new Error('Calendly did not return the account details');
  return { user, organization };
}

/** The first active event type, or the one the campaign chose if it is active. */
export async function pickEventType(token: string, userUri: string, wanted: string | null, fetchImpl?: Fetch): Promise<string> {
  const body = await requestJson('Calendly', `${BASE}/event_types?user=${encodeURIComponent(userUri)}&active=true&count=50`, { method: 'GET', headers: auth(token) }, { fetchImpl });
  const items = isObject(body) && Array.isArray(body.collection) ? body.collection : [];
  const uris = items.map((e) => (isObject(e) && e.active !== false ? str(e.uri) : undefined)).filter((u): u is string => Boolean(u));
  if (wanted && uris.includes(wanted)) return wanted;
  if (!uris.length) throw new Error('Create an active event type in Calendly, for example a 15-minute call');
  return uris[0];
}

export async function createBookingLink(token: string, eventType: string, fetchImpl?: Fetch): Promise<string> {
  const body = await requestJson('Calendly', `${BASE}/scheduling_links`, {
    method: 'POST', headers: auth(token), body: JSON.stringify({ max_event_count: 1, owner: eventType, owner_type: 'EventType' }),
  }, { fetchImpl });
  const url = isObject(body) && isObject(body.resource) ? str(body.resource.booking_url) : undefined;
  if (!url || !/^https:\/\/calendly\.com\//.test(url)) throw new Error('Calendly did not return a booking link');
  return url;
}

/** Adds the lead id so the booking can be matched even if they book with another address. */
export function trackedLink(bookingUrl: string, leadId: string): string {
  const u = new URL(bookingUrl);
  u.searchParams.set('utm_source', 'ai-sdr');
  u.searchParams.set('utm_content', leadId);
  return u.toString();
}

export async function createWebhook(token: string, url: string, organization: string, user: string, signingKey: string, fetchImpl?: Fetch): Promise<string> {
  const body = await requestJson('Calendly', `${BASE}/webhook_subscriptions`, {
    method: 'POST', headers: auth(token),
    body: JSON.stringify({ url, events: ['invitee.created', 'invitee.canceled'], organization, user, scope: 'user', signing_key: signingKey }),
  }, { fetchImpl });
  const uri = isObject(body) && isObject(body.resource) ? str(body.resource.uri) : undefined;
  if (!uri) throw new Error('Calendly did not return the webhook subscription');
  return uri;
}

/** Checks the Calendly-Webhook-Signature header (t=...,v1=...) over "t.body", within 5 minutes. */
export function verifyCalendlySignature(header: string | undefined, raw: string, key: string, now = Date.now()): boolean {
  if (!header) return false;
  const parts = Object.fromEntries(header.split(',').map((p) => p.trim().split('=') as [string, string]));
  const t = parts.t;
  const v1 = parts.v1;
  if (!t || !/^\d{9,11}$/.test(t) || !v1 || !/^[0-9a-f]{64}$/.test(v1)) return false;
  if (Math.abs(now / 1000 - Number(t)) > 300) return false;
  const expected = createHmac('sha256', key).update(`${t}.${raw}`).digest();
  return timingSafeEqual(expected, Buffer.from(v1, 'hex'));
}
