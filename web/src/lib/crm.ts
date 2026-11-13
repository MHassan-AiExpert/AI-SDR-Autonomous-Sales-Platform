// CRM sync with HubSpot: settings, stage mapping and safe reading of results.

import { z } from 'zod';

export const CRM_SCOPES = ['engaged', 'contacted'] as const;
export const CRM_SCOPE_LABELS: Record<(typeof CRM_SCOPES)[number], string> = {
  engaged: 'Leads who engaged (replied, picked up or booked)',
  contacted: 'Everyone the agents contacted',
};

export const DEAL_STAGES = ['meeting_booked', 'meeting_held', 'proposal_sent', 'negotiation', 'won', 'lost'] as const;
export type DealStage = (typeof DEAL_STAGES)[number];
export const DEAL_STAGE_LABELS: Record<DealStage, string> = {
  meeting_booked: 'Meeting booked', meeting_held: 'Meeting held', proposal_sent: 'Proposal sent', negotiation: 'Negotiation', won: 'Won', lost: 'Lost',
};
/** Stage ids of HubSpot's default sales pipeline. */
export const DEFAULT_STAGE_MAP: Record<DealStage, string> = {
  meeting_booked: 'appointmentscheduled', meeting_held: 'presentationscheduled', proposal_sent: 'contractsent',
  negotiation: 'decisionmakerboughtin', won: 'closedwon', lost: 'closedlost',
};

const hsId = (label: string) => z.string().trim().regex(/^[A-Za-z0-9_-]{1,64}$/, `${label} must be a HubSpot id: letters, numbers, dashes or underscores.`);

export const crmSettingsSchema = z.object({
  crm_sync_enabled: z.boolean(),
  crm_sync_scope: z.enum(CRM_SCOPES, 'Choose which leads to send.'),
  crm_pipeline_id: z.string().trim().transform((v) => v || 'default').pipe(hsId('The pipeline')),
  crm_stage_map: z.object(Object.fromEntries(DEAL_STAGES.map((s) => [s, z.string().trim()])) as Record<DealStage, z.ZodString>)
    .superRefine((m, ctx) => {
      for (const s of DEAL_STAGES) {
        if (m[s] && !/^[A-Za-z0-9_-]{1,64}$/.test(m[s])) ctx.addIssue({ code: 'custom', message: `The HubSpot stage for ${DEAL_STAGE_LABELS[s]} must be letters, numbers, dashes or underscores.` });
      }
      const ids = DEAL_STAGES.map((s) => m[s] || DEFAULT_STAGE_MAP[s]);
      if (new Set(ids).size !== ids.length) ctx.addIssue({ code: 'custom', message: 'Each of your stages needs its own HubSpot stage.' });
    })
    // Only stages that differ from HubSpot's default pipeline are stored
    .transform((m) => Object.fromEntries(DEAL_STAGES.filter((s) => m[s] && m[s] !== DEFAULT_STAGE_MAP[s]).map((s) => [s, m[s]]))),
});

export function parseCrmForm(form: FormData) {
  return crmSettingsSchema.safeParse({
    crm_sync_enabled: form.get('crm_sync_enabled') === 'on',
    crm_sync_scope: form.get('crm_sync_scope') ?? '',
    crm_pipeline_id: form.get('crm_pipeline_id') ?? '',
    crm_stage_map: Object.fromEntries(DEAL_STAGES.map((s) => [s, String(form.get(`stage_${s}`) ?? '')])),
  });
}

export function savedStage(map: unknown, s: DealStage): string {
  const v = map && typeof map === 'object' && !Array.isArray(map) ? (map as Record<string, unknown>)[s] : undefined;
  return typeof v === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(v) ? v : DEFAULT_STAGE_MAP[s];
}

const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.floor(v) : 0);
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`;

export function describeCrmSync(r: Record<string, unknown>): string {
  if (typeof r.skipped === 'string') return `${r.skipped}.`;
  const parts: string[] = [];
  if (num(r.contacts_sent)) parts.push(`${plural(num(r.contacts_sent), 'contact')} sent`);
  if (num(r.deals_created)) parts.push(`${plural(num(r.deals_created), 'deal')} created`);
  if (num(r.deals_updated)) parts.push(`${plural(num(r.deals_updated), 'deal')} updated`);
  if (num(r.notes_created)) parts.push(`${plural(num(r.notes_created), 'activity note')} added`);
  if (num(r.closed_from_crm)) parts.push(`${plural(num(r.closed_from_crm), 'deal')} closed from HubSpot`);
  if (num(r.contacts_without_email)) parts.push(`${num(r.contacts_without_email)} without an email skipped`);
  const head = parts.length ? `${parts.join('; ')}.` : 'HubSpot is up to date.';
  return r.rate_limited === true ? `${head} HubSpot asked to slow down; the rest syncs next hour.` : head;
}
