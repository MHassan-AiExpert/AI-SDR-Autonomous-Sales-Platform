// Reporting and analytics: periods, safe reading of the summary, rates, cost
// per meeting, the daily chart and CSV export.

import { z } from 'zod';

export const RANGES = { '7d': 7, '30d': 30, '90d': 90, '365d': 365 } as const;
export type RangeKey = keyof typeof RANGES;
export const RANGE_LABELS: Record<RangeKey, string> = { '7d': 'Last 7 days', '30d': 'Last 30 days', '90d': 'Last 90 days', '365d': 'Last 12 months' };

export function parseRange(v: unknown): RangeKey {
  return typeof v === 'string' && v in RANGES ? (v as RangeKey) : '30d';
}

export function period(range: RangeKey, now = new Date()): { from: Date; to: Date; days: number } {
  const days = RANGES[range];
  return { from: new Date(now.getTime() - days * 86_400_000), to: now, days };
}

const n = z.number().int().nonnegative();
const campaignRow = z.object({ id: z.string(), name: z.string(), status: z.string(), sourced: n, emailed: n, replied: n, interested: n, meetings: n, won: n, revenue_cents: n });
export const summarySchema = z.object({
  funnel: z.object({ sourced: n, verified: n, emailed: n, replied: n, interested: n, meetings_booked: n, meetings_held: n, won: n }),
  revenue: z.array(z.object({ currency: z.string().regex(/^[A-Z]{3}$/), cents: n })),
  won_by_ai: n,
  channels: z.object({
    email: z.object({ sent: n, replies: n, interested: n }),
    sms: z.object({ sent: n, delivered: n, replies: n }),
    whatsapp: z.object({ sent: n, delivered: n, replies: n }),
    calls: z.object({ made: n, connected: n, interested: n }),
    closer: z.object({ meetings: n, held: n, proposals: n, won: n }),
    receptionist: z.object({ calls: n, interested: n, transferred: n }),
    audits: z.object({ ready: n, opened: n }),
  }),
  daily: z.array(z.object({ day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), emails: n, replies: n, meetings: n })),
  campaigns: z.array(campaignRow),
});
export type Summary = z.infer<typeof summarySchema>;
export type CampaignRow = z.infer<typeof campaignRow>;

export function readSummary(raw: unknown): Summary | null {
  const r = summarySchema.safeParse(raw);
  return r.success ? r.data : null;
}

/** "12.5%" from a part and a whole; a dash when there is nothing to divide by. */
export function rate(part: number, whole: number): string {
  if (!whole) return '—';
  return `${(Math.round((part / whole) * 1000) / 10).toFixed(1)}%`;
}

export function money(cents: number, currency: string): string {
  try {
    return new Intl.NumberFormat('en-US', { style: 'currency', currency, maximumFractionDigits: cents % 100 ? 2 : 0 }).format(cents / 100);
  } catch {
    return `${(cents / 100).toFixed(2)} ${currency}`;
  }
}

/** Monthly tool spend spread over the period, divided by meetings booked. */
export function costPerMeeting(monthlyCents: number | null, days: number, meetings: number): number | null {
  if (monthlyCents === null || monthlyCents === undefined || !meetings) return null;
  return Math.round((monthlyCents * days) / 30 / meetings);
}

export const FUNNEL_STEPS: { key: keyof Summary['funnel']; label: string }[] = [
  { key: 'sourced', label: 'Leads sourced' }, { key: 'verified', label: 'Verified' }, { key: 'emailed', label: 'Emailed' },
  { key: 'replied', label: 'Replied' }, { key: 'interested', label: 'Interested' }, { key: 'meetings_booked', label: 'Meetings booked' },
  { key: 'meetings_held', label: 'Meetings held' }, { key: 'won', label: 'Deals won' },
];

/** SVG polyline points for one daily series, scaled to the chart box. */
export function chartPoints(daily: Summary['daily'], key: 'emails' | 'replies' | 'meetings', width: number, height: number, max: number): string {
  if (!daily.length) return '';
  const step = daily.length > 1 ? width / (daily.length - 1) : 0;
  const top = Math.max(1, max);
  return daily.map((d, i) => `${Math.round(i * step * 10) / 10},${Math.round((height - (d[key] / top) * height) * 10) / 10}`).join(' ');
}

/** A CSV cell: quoted, and never read by spreadsheets as a formula. */
export function csvCell(v: string | number): string {
  let s = String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return `"${s.replace(/"/g, '""')}"`;
}

export function campaignsCsv(rows: CampaignRow[], currency: string): string {
  const head = ['Campaign', 'Status', 'Leads sourced', 'Emailed', 'Replied', 'Reply rate', 'Interested', 'Meetings', 'Deals won', `Revenue (${currency})`];
  const lines = rows.map((r) => [r.name, r.status, r.sourced, r.emailed, r.replied, rate(r.replied, r.emailed), r.interested, r.meetings, r.won, (r.revenue_cents / 100).toFixed(2)].map(csvCell).join(','));
  return [head.map(csvCell).join(','), ...lines].join('\r\n') + '\r\n';
}

export const spendSchema = z.object({
  monthly_spend: z.string().trim()
    .refine((v) => v === '' || /^\d{1,7}(\.\d{1,2})?$/.test(v), 'Enter the monthly amount, like 1200 or 1200.50')
    .transform((v) => (v === '' ? null : Math.round(Number(v) * 100))),
  spend_currency: z.string().trim().toUpperCase().regex(/^[A-Z]{3}$/, 'Use a three-letter currency code, like USD'),
});
