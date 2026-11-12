// Meeting booking (SRS M8): booking links for interested prospects, and
// meetings recorded from Calendly notifications.

import { randomBytes } from 'node:crypto';
import type { Fetch } from './http.ts';
import { isObject, str } from './http.ts';
import { createBookingLink, createWebhook, getMe, pickEventType, trackedLink, verifyCalendlySignature } from './sources/calendly.ts';
import { postSlack, slackEscape } from './sources/slack.ts';
import type { Store } from './store.ts';
import { log } from './log.ts';

export type BookingDeps = { store: Store; fetchImpl?: Fetch; webhookBaseUrl?: string; appUrl?: string };

/**
 * A single-use booking link for one lead, or null when Calendly is not
 * connected. Sets up the Calendly webhook for the workspace on first use.
 */
export async function bookingLinkFor(deps: BookingDeps, workspaceId: string, campaignEventType: string | null, leadId: string): Promise<string | null> {
  const { store } = deps;
  if (!(await store.connectedTools(workspaceId)).has('calendly')) return null;
  const token = (await store.secret(workspaceId, 'calendly'))?.access_token;
  if (!token) return null;
  let sub = await store.calendlySubscription(workspaceId);
  if (!sub) {
    const me = await getMe(token, deps.fetchImpl);
    const hookToken = await store.webhookToken(workspaceId);
    if (deps.webhookBaseUrl && hookToken) {
      const signingKey = randomBytes(32).toString('hex');
      const uri = await createWebhook(token, `${deps.webhookBaseUrl}/webhook/calendly/${hookToken}`, me.organization, me.user, signingKey, deps.fetchImpl);
      await store.saveCalendlySubscription(workspaceId, uri, me.user, me.organization, signingKey);
      sub = { user_uri: me.user, signing_key: signingKey };
    } else {
      log('warn', 'calendly webhook not created: WEBHOOK_BASE_URL is not set', { workspace_id: workspaceId });
      sub = { user_uri: me.user, signing_key: '' };
    }
  }
  const eventType = await pickEventType(token, sub.user_uri, campaignEventType, deps.fetchImpl);
  return trackedLink(await createBookingLink(token, eventType, deps.fetchImpl), leadId);
}

export type CalendlyResult = { status: 'booked' | 'canceled' | 'duplicate' | 'ignored' | 'unknown_workspace' | 'bad_signature' };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** "+1 (512) 555-0101" to "+15125550101"; only numbers with a country code are kept. */
export function meetingPhone(v: string | undefined): string | null {
  if (!v) return null;
  const n = v.trim().replace(/[\s().-]/g, '').replace(/^00/, '+');
  return /^\+[1-9]\d{6,14}$/.test(n) ? n : null;
}
const calendlyUrl = (v: unknown) => { const s = str(v); return s && /^https:\/\/calendly\.com\//.test(s) ? s : null; };

/** Handles a Calendly invitee.created / invitee.canceled notification. */
export async function handleCalendlyEvent(deps: BookingDeps, token: unknown, raw: unknown, signature: unknown): Promise<CalendlyResult> {
  const { store } = deps;
  if (typeof token !== 'string' || !/^[0-9a-f]{64}$/.test(token) || typeof raw !== 'string') return { status: 'unknown_workspace' };
  const ws = await store.workspaceByToken(token);
  if (!ws) return { status: 'unknown_workspace' };
  const sub = await store.calendlySubscription(ws);
  if (!sub?.signing_key || !verifyCalendlySignature(typeof signature === 'string' ? signature : undefined, raw, sub.signing_key)) return { status: 'bad_signature' };

  let body: unknown;
  try { body = JSON.parse(raw); } catch { return { status: 'ignored' }; }
  if (!isObject(body) || !isObject(body.payload)) return { status: 'ignored' };
  const type = str(body.event);
  const p = body.payload;
  const inviteeUri = str(p.uri);
  if ((type !== 'invitee.created' && type !== 'invitee.canceled') || !inviteeUri) return { status: 'ignored' };

  const stored = await store.insertInboundEvent(ws, null, type, str(p.email)?.toLowerCase() ?? null, body as Record<string, unknown>, `${type}|${inviteeUri}`, 'received', 'calendly');
  if (!stored) return { status: 'duplicate' };

  const tracking = isObject(p.tracking) ? p.tracking : {};
  const trackedLead = str(tracking.utm_content);
  const lead = (trackedLead && UUID.test(trackedLead) ? await store.leadById(ws, trackedLead) : null)
    ?? (str(p.email) ? await store.leadByEmail(ws, str(p.email)!) : null);
  if (!lead) { await store.markEvent(stored, 'ignored', 'No matching lead'); return { status: 'ignored' }; }

  const ev = isObject(p.scheduled_event) ? p.scheduled_event : {};
  const loc = isObject(ev.location) ? ev.location : {};
  if (type === 'invitee.canceled') {
    await store.cancelMeeting(ws, inviteeUri, lead.id);
    await store.markEvent(stored, 'processed', null);
    return { status: 'canceled' };
  }

  const start = str(ev.start_time);
  if (!start || Number.isNaN(Date.parse(start))) { await store.markEvent(stored, 'failed', 'Missing start time'); return { status: 'ignored' }; }
  const joinUrl = str(loc.join_url);
  // The number the prospect gave for this meeting: Calendly's "we call you" location, or a phone question
  const answers = Array.isArray(p.questions_and_answers) ? p.questions_and_answers.filter(isObject) : [];
  const phone = meetingPhone(loc.type === 'outbound_call' ? str(loc.location) : undefined)
    ?? meetingPhone(str(answers.find((a) => /phone|mobile|number/i.test(str(a.question) ?? ''))?.answer));
  const meetingId = await store.saveMeeting(ws, lead.id, {
    externalId: inviteeUri, startsAt: start, endsAt: str(ev.end_time) ?? null, eventName: str(ev.name)?.slice(0, 200) ?? null,
    inviteeName: str(p.name)?.slice(0, 200) ?? null, inviteeEmail: str(p.email)?.toLowerCase() ?? null,
    joinUrl: joinUrl && /^https:\/\//.test(joinUrl) ? joinUrl.slice(0, 1000) : null,
    cancelUrl: calendlyUrl(p.cancel_url), rescheduleUrl: calendlyUrl(p.reschedule_url), phone,
  });
  await store.markEvent(stored, 'processed', null);

  // Tell the team; a Slack problem never loses the booking
  try {
    const channel = await store.slackChannel(ws);
    const slackToken = (await store.connectedTools(ws)).has('slack') ? (await store.secret(ws, 'slack'))?.bot_token : undefined;
    if (channel && slackToken && meetingId) {
      const when = new Date(start).toUTCString().replace(':00 GMT', ' UTC');
      const link = deps.appUrl ? ` <${deps.appUrl}/w/${ws}/leads/${lead.id}|Open lead>` : '';
      await postSlack(slackToken, channel, `:calendar: *Meeting booked*: ${slackEscape(lead.full_name ?? lead.email)}${lead.company_name ? ` (${slackEscape(lead.company_name)})` : ''}, ${when}${link}`, deps.fetchImpl);
    }
  } catch (err) {
    log('warn', 'meeting alert failed', { workspace_id: ws, error: err instanceof Error ? err.message : 'unknown' });
  }
  return { status: 'booked' };
}
