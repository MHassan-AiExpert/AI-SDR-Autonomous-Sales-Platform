// Notifications and monitoring: event names, settings and safe display.

import { z } from 'zod';

export const EVENTS = [
  'hot_reply', 'meeting_booked', 'hot_call', 'handoff', 'proposal', 'deal_won', 'deal_lost',
  'audit_opened', 'weekly_learning', 'daily_summary', 'system_alert',
] as const;
export type NotifyEvent = (typeof EVENTS)[number];

export const EVENT_LABELS: Record<NotifyEvent, string> = {
  hot_reply: 'Hot and positive replies', meeting_booked: 'Meetings booked', hot_call: 'Interested callers', handoff: 'Handoffs to your team',
  proposal: 'Proposals', deal_won: 'Deals won', deal_lost: 'Deals lost', audit_opened: 'Website audits opened',
  weekly_learning: 'Weekly learning reports', daily_summary: 'Daily summary', system_alert: 'System alerts (failures, paused emails, broken tools)',
};

export const SEVERITY_LABELS: Record<string, string> = { info: 'Info', warning: 'Needs attention', critical: 'Critical' };
export const SLACK_STATUS_LABELS: Record<string, string> = {
  off: 'In app only', not_connected: 'Slack not connected', held: 'Held for quiet hours', sent: 'Sent to Slack', failed: 'Slack failed',
};

export function validTimezone(tz: string): boolean {
  if (!/^[A-Za-z_]+(\/[A-Za-z0-9_+-]+){0,2}$/.test(tz) || tz.length > 64) return false;
  try {
    new Intl.DateTimeFormat('en-GB', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

const hour = z.union([z.literal(''), z.coerce.number().int().min(0).max(23)]).transform((v) => (v === '' ? null : v));
const pct = (label: string) => z.coerce.number(`${label} must be a number.`).min(1, `${label} must be between 1 and 50.`).max(50, `${label} must be between 1 and 50.`);

export const notifySettingsSchema = z.object({
  notify_slack_events: z.array(z.enum(EVENTS)),
  notify_quiet_start: hour,
  notify_quiet_end: hour,
  notify_timezone: z.string().trim().refine(validTimezone, 'Choose a time zone such as Europe/London or Asia/Karachi.'),
  bounce_pause_pct: pct('The bounce limit'),
  optout_pause_pct: pct('The opt-out limit'),
  low_credits_threshold: z.coerce.number('The low credit level must be a number.').int('The low credit level must be a whole number.').min(0, 'The low credit level cannot be negative.').max(1_000_000, 'The low credit level is too high.'),
}).superRefine((v, ctx) => {
  if ((v.notify_quiet_start === null) !== (v.notify_quiet_end === null)) ctx.addIssue({ code: 'custom', message: 'Set both the start and the end of quiet hours, or neither.' });
  else if (v.notify_quiet_start !== null && v.notify_quiet_start === v.notify_quiet_end) ctx.addIssue({ code: 'custom', message: 'Quiet hours must start and end at different times.' });
});

export function parseNotifyForm(form: FormData) {
  return notifySettingsSchema.safeParse({
    notify_slack_events: EVENTS.filter((e) => form.get(`event_${e}`) === 'on'),
    notify_quiet_start: String(form.get('notify_quiet_start') ?? ''),
    notify_quiet_end: String(form.get('notify_quiet_end') ?? ''),
    notify_timezone: String(form.get('notify_timezone') ?? ''),
    bounce_pause_pct: String(form.get('bounce_pause_pct') ?? ''),
    optout_pause_pct: String(form.get('optout_pause_pct') ?? ''),
    low_credits_threshold: String(form.get('low_credits_threshold') ?? ''),
  });
}

export const hourLabel = (h: number) => `${String(h).padStart(2, '0')}:00`;

/** Only links inside this workspace are followed from a notification. */
export function safeLink(path: unknown, workspaceId: string): string | null {
  return typeof path === 'string' && path.startsWith(`/w/${workspaceId}`) && /^\/w\/[0-9a-f-]{36}(\/[A-Za-z0-9_/-]*)?$/.test(path) ? path : null;
}

export function safeJoinUrl(url: unknown): string | null {
  if (typeof url !== 'string') return null;
  try {
    const u = new URL(url);
    return u.protocol === 'https:' ? u.toString() : null;
  } catch {
    return null;
  }
}

export function unreadCount(rows: { created_at: string }[], seenAt: string | null): number {
  const seen = seenAt ? new Date(seenAt).getTime() : 0;
  return rows.filter((r) => new Date(r.created_at).getTime() > seen).length;
}
