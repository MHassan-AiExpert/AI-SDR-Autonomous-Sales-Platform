// Outbound webhooks (F29): sends the events the database queued (a lead
// created or changing stage, a reply, a meeting booked, a deal won or lost)
// to the endpoints a workspace registered.
//
// Every delivery is signed, so the receiver can prove it came from this
// workspace and was not replayed:
//
//   X-SDR-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256 of "<t>.<body>">
//
// with the endpoint's own signing secret. The body is the stored event as
// JSON; its `id` is the same for every endpoint and every retry, so a receiver
// can ignore a repeat.
//
// Addresses are checked before each attempt: https only, standard port, and a
// host that resolves to public addresses. A team member cannot point the
// sender at the platform's own network.

import { createHmac } from 'node:crypto';
import { assertPublicUrl, defaultResolver, type Resolver } from './sources/website.ts';
import { notify } from './notify.ts';
import type { Deps } from './jobs.ts';
import { log } from './log.ts';

export const TIMEOUT_MS = 10_000;
export const BATCH = 50;

export function sign(secret: string, timestamp: number, body: string): string {
  return createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');
}

export function signatureHeader(secret: string, timestamp: number, body: string): string {
  return `t=${timestamp},v1=${sign(secret, timestamp, body)}`;
}

export type Delivery = { id: string; workspace_id: string; endpoint_id: string; url: string; secret: string; event: string; payload: unknown; attempts: number };

/** One attempt. Never throws: the outcome is returned for the database to record. */
export async function attempt(d: Delivery, fetchImpl: typeof fetch = fetch, resolve: Resolver = defaultResolver, now = () => Date.now()): Promise<{ ok: boolean; status: number | null; error: string | null }> {
  let url: URL;
  try {
    url = new URL(d.url);
    if (url.protocol !== 'https:') throw new Error('Only https addresses are allowed');
    await assertPublicUrl(url, resolve);
  } catch (err) {
    return { ok: false, status: null, error: `Address refused: ${err instanceof Error ? err.message : 'not allowed'}` };
  }
  const body = JSON.stringify(d.payload);
  const t = Math.floor(now() / 1000);
  try {
    const res = await fetchImpl(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json', 'User-Agent': 'AI-SDR-Webhooks/1',
        'X-SDR-Event': d.event, 'X-SDR-Delivery': d.id, 'X-SDR-Signature': signatureHeader(d.secret, t, body),
      },
      body,
      // A redirect could lead anywhere; the receiver must answer at the address given
      redirect: 'manual',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    // The receiver's body is never read or stored
    await res.body?.cancel().catch(() => undefined);
    if (res.status >= 200 && res.status < 300) return { ok: true, status: res.status, error: null };
    return { ok: false, status: res.status, error: res.status >= 300 && res.status < 400 ? `Redirected (HTTP ${res.status}); give the final address` : `HTTP ${res.status}` };
  } catch (err) {
    const timedOut = err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError');
    return { ok: false, status: null, error: timedOut ? `No answer within ${TIMEOUT_MS / 1000} seconds` : 'Could not connect' };
  }
}

/** Sends what is due. Called every cycle; one endpoint's problem never stops the others. */
export async function deliverWebhooks(deps: Deps & { resolve?: Resolver }, limit = BATCH, now = () => Date.now()) {
  const due = await deps.store.claimWebhookDeliveries(limit);
  const stats = { sent: 0, failed: 0, disabled: 0 };
  for (const d of due) {
    const r = await attempt(d, deps.fetchImpl, deps.resolve ?? defaultResolver, now);
    const switchedOff = await deps.store.webhookDeliveryResult(d.id, r.ok, r.status, r.error);
    if (r.ok) stats.sent++; else stats.failed++;
    if (switchedOff) {
      stats.disabled++;
      const host = (() => { try { return new URL(d.url).host; } catch { return 'an endpoint'; } })();
      await notify(deps.store, d.workspace_id, {
        event: 'system_alert', severity: 'warning', path: '/developers', title: `Webhook switched off: ${host}`.slice(0, 120),
        dedupe: `webhook-off:${d.endpoint_id}:${new Date(now()).toISOString().slice(0, 10)}`,
        slack: `:electric_plug: *Webhook switched off* (${host.replace(/[*_~`<>&]/g, '')}): 15 deliveries in a row failed (last: ${(r.error ?? 'error').replace(/[*_~`<>&]/g, '')}). Fix the receiver, then switch it back on.`,
      }, deps.fetchImpl).catch(() => undefined);
    }
  }
  if (stats.failed || stats.disabled) log('warn', 'webhook deliveries failed', stats);
  return stats;
}
