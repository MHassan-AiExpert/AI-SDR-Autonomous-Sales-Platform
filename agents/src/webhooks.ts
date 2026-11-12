// Receives events that Instantly posted to a workspace's webhook address
// (relayed and signed by n8n). Each event is stored once and handed to the
// reply agent for its campaign.

import { createHash } from 'node:crypto';
import type { Store } from './store.ts';
import { isObject, str } from './http.ts';

export type IngestResult = { status: 'stored' | 'duplicate' | 'ignored' | 'unknown_workspace'; eventId?: string };

const TOKEN = /^[0-9a-f]{64}$/;
// Large HTML copies are not needed; the text versions are kept
const DROP_FIELDS = ['email_html', 'reply_html'];

export function dedupeKey(e: Record<string, unknown>): string {
  const parts = [str(e.event_type), str(e.lead_email)?.toLowerCase(), str(e.email_id), str(e.timestamp), String(e.step ?? '')];
  return createHash('sha256').update(parts.join('|')).digest('hex');
}

export async function ingestInstantlyEvent(store: Store, token: unknown, event: unknown): Promise<IngestResult> {
  if (typeof token !== 'string' || !TOKEN.test(token) || !isObject(event)) return { status: 'unknown_workspace' };
  const workspaceId = await store.workspaceByToken(token);
  if (!workspaceId) return { status: 'unknown_workspace' };
  const type = str(event.event_type);
  if (!type || type.length > 80) return { status: 'ignored' };

  const payload: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(event)) {
    if (DROP_FIELDS.includes(k)) continue;
    payload[k] = typeof v === 'string' ? v.slice(0, 20_000) : v;
  }
  const instantlyCampaign = str(event.campaign_id);
  const campaignId = instantlyCampaign ? await store.campaignByInstantlyId(workspaceId, instantlyCampaign) : null;
  const inserted = await store.insertInboundEvent(workspaceId, campaignId, type, str(event.lead_email)?.toLowerCase() ?? null, payload, dedupeKey(event), campaignId ? 'received' : 'ignored');
  if (!inserted) return { status: 'duplicate' };
  if (!campaignId) return { status: 'ignored', eventId: inserted };
  await store.enqueue(workspaceId, campaignId, 'reply_handling').catch(() => false);
  return { status: 'stored', eventId: inserted };
}
