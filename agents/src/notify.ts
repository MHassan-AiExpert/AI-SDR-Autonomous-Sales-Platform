// One way to tell a company's team something (SRS M22): every alert is kept
// in the in-app notification centre, and is posted to Slack when the
// workspace chose that event, outside its quiet hours. Critical alerts ignore
// quiet hours. Alerts held during quiet hours are posted when they end.
// A Slack problem never stops the work that raised the alert.

import { ProviderError, type Fetch } from './http.ts';
import { postSlack } from './sources/slack.ts';
import type { Store } from './store.ts';
import { log } from './log.ts';

export const EVENTS = [
  'hot_reply', 'meeting_booked', 'hot_call', 'handoff', 'proposal', 'deal_won', 'deal_lost',
  'audit_opened', 'weekly_learning', 'daily_summary', 'system_alert',
] as const;
export type NotifyEvent = (typeof EVENTS)[number];
export type Severity = 'info' | 'warning' | 'critical';

export const EVENT_TITLES: Record<NotifyEvent, string> = {
  hot_reply: 'Reply needs you', meeting_booked: 'Meeting booked', hot_call: 'Interested caller', handoff: 'Handoff to your team',
  proposal: 'Proposal', deal_won: 'Deal won', deal_lost: 'Deal lost', audit_opened: 'Audit opened',
  weekly_learning: 'Weekly learning', daily_summary: 'Daily summary', system_alert: 'System alert',
};

export type Notice = {
  event: NotifyEvent;
  /** Slack mrkdwn; the in-app text is derived from it */
  slack: string;
  title?: string;
  severity?: Severity;
  leadId?: string | null;
  campaignId?: string | null;
  /** In-app path below /w/<workspace>; the lead's page when a lead is given */
  path?: string;
  /** Join link for a handoff (meeting or call) */
  actionUrl?: string | null;
  /** The same key is only ever alerted once */
  dedupe?: string;
};

export type NotifyResult = { status: 'duplicate' | 'off' | 'not_connected' | 'held' | 'sent' | 'failed'; error?: string };

/** Slack mrkdwn to plain text: links lose their address, bold and emoji go. */
export function plainText(mrkdwn: string): string {
  return mrkdwn
    .replace(/<(https?:\/\/[^|>]+)\|([^>]+)>/g, '')
    .replace(/<(https?:\/\/[^>]+)>/g, '$1')
    .replace(/:[a-z0-9_+-]+:\s*/g, '')
    .replace(/[*_~`]/g, '')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
    .replace(/[ \t]+/g, ' ')
    .replace(/\s+\./g, '.')
    .trim();
}

/** Hour of the day in a time zone; UTC when the zone is unknown. */
export function localHour(tz: string, at = new Date()): number {
  try {
    return Number(new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', hourCycle: 'h23' }).format(at));
  } catch {
    return at.getUTCHours();
  }
}

/** Local calendar day (YYYY-MM-DD) in a time zone; UTC when unknown. */
export function localDay(tz: string, at = new Date()): string {
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(at);
  } catch {
    return at.toISOString().slice(0, 10);
  }
}

/** Quiet hours may run over midnight (20 to 8). */
export function inQuietHours(start: number | null, end: number | null, hour: number): boolean {
  if (start === null || end === null || start === end) return false;
  return start < end ? hour >= start && hour < end : hour >= start || hour < end;
}

export type NotifySettings = { slack_events: string[]; quiet_start: number | null; quiet_end: number | null; timezone: string; slack_channel: string | null };

async function slackTarget(store: Store, ws: string) {
  const channel = await store.slackChannel(ws);
  const token = (await store.connectedTools(ws)).has('slack') ? (await store.secret(ws, 'slack'))?.bot_token : undefined;
  return channel && token ? { channel, token } : null;
}

async function send(store: Store, ws: string, id: string, text: string, fetchImpl?: Fetch): Promise<NotifyResult> {
  const target = await slackTarget(store, ws);
  if (!target) {
    await store.setNotificationSlack(id, 'not_connected', null);
    return { status: 'not_connected' };
  }
  try {
    await postSlack(target.token, target.channel, text, fetchImpl);
    await store.setNotificationSlack(id, 'sent', null);
    return { status: 'sent' };
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Slack alert failed';
    await store.setNotificationSlack(id, 'failed', message);
    if (err instanceof ProviderError && err.status === 401) await store.markToolError(ws, 'slack', 'error', message);
    return { status: 'failed', error: message };
  }
}

export async function notify(store: Store, ws: string, n: Notice, fetchImpl?: Fetch, now = new Date()): Promise<NotifyResult> {
  try {
    const settings = await store.notifySettings(ws);
    const path = n.path ?? (n.leadId ? `/leads/${n.leadId}` : '/notifications');
    const id = await store.addNotification(ws, {
      event: n.event, severity: n.severity ?? 'info', title: (n.title ?? EVENT_TITLES[n.event]).slice(0, 120),
      body: plainText(n.slack).slice(0, 2000), leadId: n.leadId ?? null, campaignId: n.campaignId ?? null,
      linkPath: `/w/${ws}${path}`, actionUrl: n.actionUrl && /^https:\/\//.test(n.actionUrl) ? n.actionUrl.slice(0, 1000) : null,
      dedupe: n.dedupe ?? null, slackText: n.slack.slice(0, 3500),
    });
    if (!id) return { status: 'duplicate' };
    if (!settings || !settings.slack_events.includes(n.event)) return { status: 'off' };
    if (n.severity !== 'critical' && inQuietHours(settings.quiet_start, settings.quiet_end, localHour(settings.timezone, now))) {
      await store.setNotificationSlack(id, 'held', null);
      return { status: 'held' };
    }
    return await send(store, ws, id, n.slack, fetchImpl);
  } catch (err) {
    log('warn', 'notification failed', { workspace_id: ws, event: n.event, error: err instanceof Error ? err.message : 'unknown' });
    return { status: 'failed', error: err instanceof Error ? err.message : 'Notification failed' };
  }
}

/** Posts alerts held during quiet hours, oldest first, as one message per alert. */
export async function flushHeld(store: Store, ws: string, settings: NotifySettings, fetchImpl?: Fetch, now = new Date()): Promise<number> {
  if (inQuietHours(settings.quiet_start, settings.quiet_end, localHour(settings.timezone, now))) return 0;
  const held = await store.heldNotifications(ws, 50);
  let sent = 0;
  for (const h of held) {
    const r = await send(store, ws, h.id, `${h.slack_text} _(held during quiet hours)_`, fetchImpl);
    if (r.status === 'sent') sent++;
    if (r.status === 'failed' || r.status === 'not_connected') break;
  }
  return sent;
}
