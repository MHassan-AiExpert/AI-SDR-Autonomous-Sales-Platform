// Agency console: access, forms and usage export.

import { cache } from 'react';
import { notFound } from 'next/navigation';
import { z } from 'zod';
import { requireUser } from './session';
import { uuidSchema } from './validation';
import { csvCell } from './analytics';

export type AgencyRole = 'owner' | 'admin' | 'staff';
export const AGENCY_ROLE_LABELS: Record<AgencyRole, string> = { owner: 'Owner', admin: 'Admin', staff: 'Staff' };
export const canManageAgency = (r: AgencyRole) => r === 'owner' || r === 'admin';

export type AgencyContext = { id: string; name: string; role: AgencyRole; campaign_defaults: Record<string, unknown>; has_default_playbook: boolean };

/** The agency and the caller's role in it; a 404 for anyone outside the agency. */
export const requireAgency = cache(async (agencyId: string) => {
  if (!uuidSchema.safeParse(agencyId).success) notFound();
  const { supabase, user } = await requireUser();
  const [{ data: agency }, { data: member }] = await Promise.all([
    supabase.from('agencies').select('id, name, owner_id, campaign_defaults, default_playbook').eq('id', agencyId).maybeSingle(),
    supabase.from('agency_members').select('role').eq('agency_id', agencyId).eq('user_id', user.id).maybeSingle(),
  ]);
  if (!agency) notFound();
  const role: AgencyRole | null = agency.owner_id === user.id ? 'owner' : member?.role === 'admin' || member?.role === 'staff' ? member.role : null;
  if (!role) notFound();
  return {
    supabase, user,
    agency: { id: agency.id, name: agency.name, role, campaign_defaults: (agency.campaign_defaults ?? {}) as Record<string, unknown>, has_default_playbook: agency.default_playbook !== null } as AgencyContext,
  };
});

export const agencyNameSchema = z.string().trim().min(2, 'Enter the agency name (at least 2 characters).').max(120, 'The agency name can be up to 120 characters.');

const limit = (label: string, max: number) => z.string().trim()
  .refine((v) => v === '' || (/^\d+$/.test(v) && Number(v) >= 1 && Number(v) <= max), `${label} must be a whole number from 1 to ${max.toLocaleString('en-US')}, or empty for no limit.`)
  .transform((v) => (v === '' ? null : Number(v)));

export const clientSchema = z.object({
  name: z.string().trim().min(2, 'Enter the client company name (at least 2 characters).').max(120, 'The client name can be up to 120 characters.'),
  plan: z.string().trim().min(1, 'Enter a plan name, like Starter or Growth.').max(40, 'Plan names can be up to 40 characters.'),
  monthly_lead_limit: limit('The monthly lead limit', 1_000_000),
  seat_limit: limit('The seat limit', 1000),
});
export const planSchema = clientSchema.omit({ name: true });

export function parseClientForm(form: FormData, withName = true) {
  const v = { name: String(form.get('name') ?? ''), plan: String(form.get('plan') ?? ''), monthly_lead_limit: String(form.get('monthly_lead_limit') ?? ''), seat_limit: String(form.get('seat_limit') ?? '') };
  return withName ? clientSchema.safeParse(v) : planSchema.safeParse(v);
}

const DOMAIN = /^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/;
export const brandFormSchema = z.object({
  app_name: z.string().trim().min(1, 'Enter the app name your clients will see.').max(60, 'The app name can be up to 60 characters.'),
  logo_url: z.string().trim().refine((v) => v === '' || (/^https:\/\/[^\s"<>]+$/.test(v) && v.length <= 500), 'The logo must be an https:// image address.').transform((v) => v || null),
  primary_color: z.string().trim().toLowerCase().regex(/^#[0-9a-f]{6}$/, 'Choose a colour like #2f5bea.'),
  support_email: z.string().trim().toLowerCase().refine((v) => v === '' || /^[^\s@<>"]{1,64}@[^\s@<>"]{1,200}\.[a-z]{2,}$/.test(v), 'Enter a valid support email, or leave it empty.').transform((v) => v || null),
  custom_domain: z.string().trim().toLowerCase().transform((v) => v.replace(/^https?:\/\//, '').replace(/\/.*$/, ''))
    .refine((v) => v === '' || (DOMAIN.test(v) && v.length <= 253), 'Enter a domain like app.youragency.com.').transform((v) => v || null),
});

export function parseBrandForm(form: FormData) {
  return brandFormSchema.safeParse({
    app_name: String(form.get('app_name') ?? ''), logo_url: String(form.get('logo_url') ?? ''), primary_color: String(form.get('primary_color') ?? ''),
    support_email: String(form.get('support_email') ?? ''), custom_domain: String(form.get('custom_domain') ?? ''),
  });
}

const TIME = /^([01][0-9]|2[0-3]):[0-5][0-9]$/;
const int = (label: string, min: number, max: number) => z.string().trim()
  .refine((v) => v === '' || (/^\d+$/.test(v) && Number(v) >= min && Number(v) <= max), `${label} must be from ${min} to ${max}.`)
  .transform((v) => (v === '' ? undefined : Number(v)));
const time = (label: string) => z.string().trim().refine((v) => v === '' || TIME.test(v), `${label} must be a time like 09:00.`).transform((v) => v || undefined);

/** Cadence defaults for new client campaigns; empty fields keep the platform defaults. */
export const defaultsSchema = z.object({
  follow_up_count: int('Follow-ups', 0, 4), follow_up_delay_days: int('Days between follow-ups', 1, 30), daily_send_limit: int('The daily email limit', 1, 5000),
  send_window_start: time('Sending start'), send_window_end: time('Sending end'),
  call_window_start: time('Calling start'), call_window_end: time('Calling end'), call_daily_limit: int('The daily call limit', 1, 2000), call_max_attempts: int('Call attempts', 1, 5),
  sms_after_days: int('Days before a text', 1, 30), sms_daily_limit: int('The daily text limit', 1, 5000), sms_max_messages: int('Texts per lead', 1, 3),
}).transform((v) => Object.fromEntries(Object.entries(v).filter(([, x]) => x !== undefined)));

export const DEFAULT_FIELDS: { key: keyof z.input<typeof defaultsSchema>; label: string; type: 'number' | 'time'; placeholder: string }[] = [
  { key: 'follow_up_count', label: 'Email follow-ups', type: 'number', placeholder: '2' },
  { key: 'follow_up_delay_days', label: 'Days between follow-ups', type: 'number', placeholder: '3' },
  { key: 'daily_send_limit', label: 'Emails per day', type: 'number', placeholder: '50' },
  { key: 'send_window_start', label: 'Send emails from', type: 'time', placeholder: '09:00' },
  { key: 'send_window_end', label: 'Send emails until', type: 'time', placeholder: '17:00' },
  { key: 'call_window_start', label: 'Call from', type: 'time', placeholder: '10:00' },
  { key: 'call_window_end', label: 'Call until', type: 'time', placeholder: '16:00' },
  { key: 'call_daily_limit', label: 'Calls per day', type: 'number', placeholder: '30' },
  { key: 'call_max_attempts', label: 'Call attempts per lead', type: 'number', placeholder: '2' },
  { key: 'sms_after_days', label: 'Days before a text follow-up', type: 'number', placeholder: '3' },
  { key: 'sms_daily_limit', label: 'Texts per day', type: 'number', placeholder: '100' },
  { key: 'sms_max_messages', label: 'Texts per lead', type: 'number', placeholder: '1' },
];

export function parseDefaultsForm(form: FormData) {
  return defaultsSchema.safeParse(Object.fromEntries(DEFAULT_FIELDS.map((f) => [f.key, String(form.get(f.key) ?? '')])));
}

const n = z.number().int().nonnegative();
export const usageRowSchema = z.object({
  id: z.string(), name: z.string(), plan: z.string(), monthly_lead_limit: n.nullable(), seat_limit: n.nullable(), outreach_paused: z.boolean(),
  members: n, leads_this_month: n, leads: n, emails: n, calls: n, call_minutes: n, texts: n, meetings: n, won: n,
  revenue: z.record(z.string().regex(/^[A-Z]{3}$/), n),
});
export type UsageRow = z.infer<typeof usageRowSchema>;

export function readUsage(raw: unknown): UsageRow[] | null {
  const r = z.array(usageRowSchema).safeParse(raw);
  return r.success ? r.data : null;
}

export const money = (cents: number, currency: string) =>
  new Intl.NumberFormat('en-US', { style: 'currency', currency, maximumFractionDigits: cents % 100 ? 2 : 0 }).format(cents / 100);

export function revenueText(rev: Record<string, number>): string {
  const parts = Object.entries(rev).filter(([, c]) => c > 0).map(([cur, c]) => money(c, cur));
  return parts.length ? parts.join(' + ') : '—';
}

export function usageCsv(rows: UsageRow[], from: Date, to: Date): string {
  const day = (d: Date) => d.toISOString().slice(0, 10);
  const head = ['Client', 'Plan', 'Period from', 'Period to', 'Team members', 'Seat limit', 'Leads added', 'Leads this month', 'Monthly lead limit',
    'Emails sent', 'Calls', 'Call minutes', 'Texts sent', 'Meetings booked', 'Deals won', 'Revenue'];
  const lines = rows.map((r) => [r.name, r.plan, day(from), day(to), r.members, r.seat_limit ?? '', r.leads, r.leads_this_month, r.monthly_lead_limit ?? '',
    r.emails, r.calls, r.call_minutes, r.texts, r.meetings, r.won, Object.entries(r.revenue).map(([c, v]) => `${c} ${(v / 100).toFixed(2)}`).join('; ')].map((v) => csvCell(v)).join(','));
  return [head.map(csvCell).join(','), ...lines].join('\r\n') + '\r\n';
}

export const usagePercent = (used: number, lim: number | null) => (lim ? Math.min(100, Math.round((used / lim) * 100)) : null);
