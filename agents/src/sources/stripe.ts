// Stripe: a payment link at the playbook price for each won-over prospect, and
// a webhook endpoint per workspace so completed payments close the deal.

import { createHmac, timingSafeEqual } from 'node:crypto';
import { ProviderError, describeStatus, isObject, str, type Fetch } from '../http.ts';

export type Interval = 'one_time' | 'month' | 'year';

/** Stripe's form encoding: nested keys in brackets. */
export function stripeForm(fields: Record<string, string | number | boolean | undefined | null | string[]>): URLSearchParams {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(fields)) {
    if (v === undefined || v === null) continue;
    if (Array.isArray(v)) v.forEach((x, i) => p.append(`${k}[${i}]`, x));
    else p.append(k, String(v));
  }
  return p;
}

async function stripe(key: string, path: string, form: URLSearchParams, idempotencyKey: string | null, fetchImpl: Fetch = fetch): Promise<Record<string, unknown>> {
  let res: Response;
  try {
    res = await fetchImpl(`https://api.stripe.com/v1/${path}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${key}`, 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json',
        'Stripe-Version': '2024-06-20', ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}),
      },
      body: form.toString(),
      redirect: 'error',
      signal: AbortSignal.timeout(30_000),
    });
  } catch (err) {
    const timedOut = err instanceof Error && err.name === 'TimeoutError';
    throw new ProviderError('Stripe', null, timedOut ? 'Stripe did not respond in time' : 'Could not reach Stripe');
  }
  let body: unknown = null;
  try { body = await res.json(); } catch { /* handled below */ }
  // Stripe's error text can echo request data, so only the status is reported
  if (!res.ok) throw new ProviderError('Stripe', res.status, describeStatus('Stripe', res.status));
  if (!isObject(body)) throw new ProviderError('Stripe', res.status, 'Stripe returned a response that is not JSON');
  return body;
}

export async function createPaymentLink(key: string, p: {
  productName: string; amountCents: number; currency: string; interval: Interval; dealId: string; workspaceId: string;
}, fetchImpl?: Fetch): Promise<{ id: string; url: string }> {
  const price = await stripe(key, 'prices', stripeForm({
    currency: p.currency.toLowerCase(), unit_amount: p.amountCents, 'product_data[name]': p.productName.slice(0, 250),
    'recurring[interval]': p.interval === 'one_time' ? undefined : p.interval,
    'metadata[deal_id]': p.dealId, 'metadata[workspace_id]': p.workspaceId,
  }), `price-${p.dealId}`, fetchImpl);
  const priceId = str(price.id);
  if (!priceId) throw new ProviderError('Stripe', null, 'Stripe did not return a price');
  const link = await stripe(key, 'payment_links', stripeForm({
    'line_items[0][price]': priceId, 'line_items[0][quantity]': 1,
    'metadata[deal_id]': p.dealId, 'metadata[workspace_id]': p.workspaceId,
  }), `plink-${p.dealId}`, fetchImpl);
  const id = str(link.id);
  const url = str(link.url);
  if (!id || !/^plink_[A-Za-z0-9]{8,100}$/.test(id) || !url || !/^https:\/\/(buy|checkout)\.stripe\.com\//.test(url)) throw new ProviderError('Stripe', null, 'Stripe did not return a payment link');
  return { id, url };
}

export const STRIPE_EVENTS = ['checkout.session.completed', 'checkout.session.async_payment_succeeded'];

export async function createWebhookEndpoint(key: string, url: string, fetchImpl?: Fetch): Promise<{ id: string; secret: string }> {
  const ep = await stripe(key, 'webhook_endpoints', stripeForm({ url, enabled_events: STRIPE_EVENTS, description: 'AI SDR platform: payments for won deals' }), null, fetchImpl);
  const id = str(ep.id);
  const secret = str(ep.secret);
  if (!id || !/^we_/.test(id) || !secret || !/^whsec_/.test(secret)) throw new ProviderError('Stripe', null, 'Stripe did not return a webhook endpoint');
  return { id, secret };
}

/** Stripe-Signature: "t=…,v1=…", HMAC-SHA256 of "t.payload" with the endpoint secret, within five minutes. */
export function verifyStripeSignature(header: string | undefined, payload: string, secret: string, now = Date.now()): boolean {
  if (!header || header.length > 2000) return false;
  const parts = header.split(',').map((x) => x.trim().split('='));
  const t = parts.find(([k]) => k === 't')?.[1];
  const sigs = parts.filter(([k]) => k === 'v1').map(([, v]) => v);
  if (!t || !/^\d{10}$/.test(t) || !sigs.length || Math.abs(now / 1000 - Number(t)) > 300) return false;
  const expected = Buffer.from(createHmac('sha256', secret).update(`${t}.${payload}`).digest('hex'));
  return sigs.some((s) => s && s.length === expected.length && timingSafeEqual(expected, Buffer.from(s)));
}
