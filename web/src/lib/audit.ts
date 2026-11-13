// Shared website audits: what the public page may show, read defensively.

import { z } from 'zod';

export const AUDIT_TOKEN = /^[0-9a-f]{48}$/;

const checkSchema = z.object({
  id: z.string().max(40), label: z.string().max(120), status: z.enum(['pass', 'warn', 'fail', 'unknown']), detail: z.string().max(400),
});
const recSchema = z.object({ check_id: z.string().max(40), title: z.string().max(120), why: z.string().max(400), how: z.string().max(500) });

export const publicAuditSchema = z.object({
  title: z.string().max(200).nullable(),
  score: z.number().int().min(0).max(100).nullable(),
  company: z.string().max(200).nullable(),
  first_name: z.string().max(60).nullable(),
  from_company: z.string().max(200),
  sender_name: z.string().max(120).nullable(),
  created_at: z.string(),
  content: z.object({
    site: z.string().max(500).optional(),
    checks: z.array(checkSchema).max(30).default([]),
    summary: z.string().max(800).default(''),
    recommendations: z.array(recSchema).max(5).default([]),
  }),
});
export type PublicAudit = z.infer<typeof publicAuditSchema>;

export function readPublicAudit(raw: unknown): PublicAudit | null {
  const r = publicAuditSchema.safeParse(raw);
  return r.success ? r.data : null;
}

export const STATUS_LABELS: Record<string, string> = { pass: 'Good', warn: 'Could be better', fail: 'Needs work', unknown: 'Not checked' };

export function scoreBand(score: number | null): 'good' | 'fair' | 'poor' {
  if (score === null) return 'poor';
  return score >= 75 ? 'good' : score >= 50 ? 'fair' : 'poor';
}

/** Seconds to add for a visit ping: whole seconds from 1 to 600, or 0 for the open itself. */
export function viewSeconds(v: unknown): number | null {
  const n = typeof v === 'number' ? v : Number.NaN;
  return Number.isInteger(n) && n >= 0 && n <= 600 ? n : null;
}

/** Only the site's own https or http home address is shown as a link. */
export function siteLink(url: string | undefined): string | null {
  return url && /^https?:\/\/[a-z0-9.-]+(:\d+)?\/?$/i.test(url) ? url : null;
}
