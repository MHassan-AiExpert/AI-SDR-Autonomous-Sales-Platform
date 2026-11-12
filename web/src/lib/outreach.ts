// Email outreach settings, readiness and labels for the campaign screens.

import { z } from 'zod';

/** Time zones the sending service accepts, by region. */
export const SEND_TIMEZONES = [
  'America/Anchorage', 'America/Boise', 'America/Chicago', 'America/Detroit', 'America/Bogota', 'America/Sao_Paulo',
  'America/Santiago', 'America/St_Johns', 'Europe/Isle_of_Man', 'Europe/Belgrade', 'Europe/Helsinki', 'Europe/Istanbul',
  'Africa/Cairo', 'Asia/Dubai', 'Asia/Karachi', 'Asia/Kolkata', 'Asia/Dhaka', 'Asia/Hong_Kong', 'Australia/Perth',
  'Asia/Taipei', 'Australia/Brisbane', 'Australia/Melbourne', 'Pacific/Auckland',
] as const;

export const TIMEZONE_LABELS: Record<(typeof SEND_TIMEZONES)[number], string> = {
  'America/Anchorage': 'Alaska', 'America/Boise': 'US Mountain', 'America/Chicago': 'US Central', 'America/Detroit': 'US Eastern',
  'America/Bogota': 'Colombia, Peru', 'America/Sao_Paulo': 'Brazil', 'America/Santiago': 'Chile', 'America/St_Johns': 'Newfoundland',
  'Europe/Isle_of_Man': 'UK, Ireland', 'Europe/Belgrade': 'Central Europe', 'Europe/Helsinki': 'Eastern Europe', 'Europe/Istanbul': 'Turkey',
  'Africa/Cairo': 'Egypt', 'Asia/Dubai': 'UAE', 'Asia/Karachi': 'Pakistan', 'Asia/Kolkata': 'India', 'Asia/Dhaka': 'Bangladesh',
  'Asia/Hong_Kong': 'Hong Kong, China', 'Australia/Perth': 'Western Australia', 'Asia/Taipei': 'Taiwan, Singapore',
  'Australia/Brisbane': 'Queensland', 'Australia/Melbourne': 'Sydney, Melbourne', 'Pacific/Auckland': 'New Zealand',
};

export const DAY_LABELS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'] as const;

const time = z.string().regex(/^([01][0-9]|2[0-3]):[0-5][0-9]$/, 'Use a time like 09:00');
const mailbox = z.string().trim().toLowerCase().pipe(z.email('Each sending mailbox must be a valid email address'));

export const emailSettingsSchema = z.object({
  sender_name: z.string().trim().min(2, 'Add the sender name').max(120, 'Sender name is too long'),
  email_footer: z.string().trim().min(20, 'Add a footer with your company name, postal address and how to opt out').max(600, 'Footer is too long'),
  sending_accounts: z.string().max(4000)
    .transform((s) => [...new Set(s.split(/[\s,;]+/).map((a) => a.trim().toLowerCase()).filter(Boolean))])
    .pipe(z.array(mailbox).min(1, 'Add at least one sending mailbox').max(50, 'Use at most 50 mailboxes')),
  send_timezone: z.enum(SEND_TIMEZONES, 'Choose a time zone'),
  send_window_start: time,
  send_window_end: time,
  send_days: z.record(z.string(), z.boolean()),
  daily_send_limit: z.coerce.number().int('Use a whole number').min(1, 'Daily new leads must be at least 1').max(5000, 'Daily new leads must be at most 5000'),
  follow_up_count: z.coerce.number().int().min(0, 'Follow-ups must be 0 to 4').max(4, 'Follow-ups must be 0 to 4'),
  follow_up_delay_days: z.coerce.number().int().min(1, 'Days between emails must be 1 to 30').max(30, 'Days between emails must be 1 to 30'),
}).refine((v) => v.send_window_start < v.send_window_end, { message: 'The sending window must end after it starts', path: ['send_window_end'] })
  .refine((v) => Object.values(v.send_days).some(Boolean), { message: 'Choose at least one sending day', path: ['send_days'] })
  .refine((v) => !/(\{\{|\}\}|<)/.test(v.email_footer), { message: 'The footer cannot contain HTML or {{ }} placeholders', path: ['email_footer'] });

export type EmailSettings = z.infer<typeof emailSettingsSchema>;

export function parseEmailSettings(form: FormData) {
  return emailSettingsSchema.safeParse({
    sender_name: form.get('sender_name') ?? '',
    email_footer: form.get('email_footer') ?? '',
    sending_accounts: form.get('sending_accounts') ?? '',
    send_timezone: form.get('send_timezone') ?? '',
    send_window_start: form.get('send_window_start') ?? '',
    send_window_end: form.get('send_window_end') ?? '',
    send_days: Object.fromEntries(DAY_LABELS.map((_, i) => [String(i), form.get(`day_${i}`) === 'on'])),
    daily_send_limit: form.get('daily_send_limit') ?? '',
    follow_up_count: form.get('follow_up_count') ?? '',
    follow_up_delay_days: form.get('follow_up_delay_days') ?? '',
  });
}

export type ReadinessInput = {
  instantlyConnected: boolean; emailChannelOn: boolean; senderName: string | null; footer: string | null;
  accounts: unknown; sendingDomainsChecked: boolean;
};

export type ReadinessItem = { id: string; label: string; done: boolean; blocking: boolean };

/** What must be true before email outreach can go live. */
export function outreachReadiness(i: ReadinessInput): { items: ReadinessItem[]; ready: boolean } {
  const accounts = Array.isArray(i.accounts) ? i.accounts.filter((a) => typeof a === 'string' && a.includes('@')) : [];
  const items: ReadinessItem[] = [
    { id: 'instantly', label: 'Instantly connected in Setup', done: i.instantlyConnected, blocking: true },
    { id: 'channel', label: 'Email channel switched on in Settings', done: i.emailChannelOn, blocking: true },
    { id: 'accounts', label: 'At least one sending mailbox added', done: accounts.length > 0, blocking: true },
    { id: 'sender', label: 'Sender name added', done: Boolean(i.senderName?.trim()), blocking: true },
    { id: 'footer', label: 'Footer with company name, postal address and opt-out', done: Boolean(i.footer?.trim()), blocking: true },
    { id: 'domains', label: 'Sending domains authenticated and warmed up (Setup checklist)', done: i.sendingDomainsChecked, blocking: false },
  ];
  return { items, ready: items.every((x) => x.done || !x.blocking) };
}

export const OUTREACH_STATUS_LABELS: Record<string, string> = { not_started: 'Not started', live: 'Sending', paused: 'Paused' };
export const EMAIL_STATUS_LABELS: Record<string, string> = {
  draft: 'Waiting for approval', approved: 'Approved', rejected: 'Rejected', queued: 'With Instantly', sent: 'Sent', bounced: 'Bounced', failed: 'Failed',
};
