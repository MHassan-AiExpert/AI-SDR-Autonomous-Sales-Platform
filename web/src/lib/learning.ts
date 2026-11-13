// Self-learning: labels and safe reading of weekly reports.

import { z } from 'zod';

export const findingSchema = z.object({
  id: z.string().max(80), label: z.string().max(80), direction: z.enum(['better', 'worse']), text: z.string().max(400),
  n: z.number().int(), rest_n: z.number().int(), p: z.number(),
});
export type ReportFinding = z.infer<typeof findingSchema>;

export function readFindings(raw: unknown): ReportFinding[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((f) => { const r = findingSchema.safeParse(f); return r.success ? [r.data] : []; });
}

export const DECISIONS = ['apply', 'dismiss', 'remove'] as const;
export type Decision = (typeof DECISIONS)[number];

export const SUGGESTION_STATUS_LABELS: Record<string, string> = { proposed: 'Waiting for you', applied: 'In use', dismissed: 'Dismissed', removed: 'Removed' };
export const KIND_LABELS: Record<string, string> = { copy_guidance: 'Lesson for the copywriter', score_threshold: 'Score threshold' };

export function confidenceLabel(p: number): string {
  return p < 0.01 ? 'very clear' : 'clear';
}

export function pct(v: unknown): string {
  return typeof v === 'number' && Number.isFinite(v) ? `${(Math.round(v * 1000) / 10).toFixed(1)}%` : '—';
}

export const DECISION_NOTICES: Record<string, string> = {
  applied: 'Applied. The copywriter and scoring use it from the next run.',
  dismissed: 'Dismissed. It will not be suggested again unless the results change.',
  removed: 'Removed. The copywriter no longer follows it.',
};
