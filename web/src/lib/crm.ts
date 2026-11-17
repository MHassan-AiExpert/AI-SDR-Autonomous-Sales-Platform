// CRM sync with HubSpot, Pipedrive or Salesforce: settings, stage mapping and
// safe reading of results.

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

export const CRM_PROVIDERS = ['hubspot', 'pipedrive', 'salesforce'] as const;
export type CrmProvider = (typeof CRM_PROVIDERS)[number];
export const PROVIDER_NAMES: Record<CrmProvider, string> = { hubspot: 'HubSpot', pipedrive: 'Pipedrive', salesforce: 'Salesforce' };

/** The same defaults and formats the agent uses (agents/src/crm.ts). */
export const DEFAULT_STAGES: Record<CrmProvider, Record<DealStage, string>> = {
  hubspot: DEFAULT_STAGE_MAP,
  pipedrive: { meeting_booked: '', meeting_held: '', proposal_sent: '', negotiation: '', won: '', lost: '' },
  salesforce: {
    meeting_booked: 'Qualification', meeting_held: 'Needs Analysis', proposal_sent: 'Proposal/Price Quote',
    negotiation: 'Negotiation/Review', won: 'Closed Won', lost: 'Closed Lost',
  },
};
export const STAGE_FORMAT: Record<CrmProvider, RegExp> = {
  hubspot: /^[A-Za-z0-9_-]{1,64}$/,
  pipedrive: /^[0-9]{1,15}$/,
  salesforce: /^[^\x00-\x1f"<>]{1,64}$/,
};
const FORMAT_HELP: Record<CrmProvider, string> = {
  hubspot: 'letters, numbers, dashes or underscores',
  pipedrive: 'a Pipedrive stage number',
  salesforce: 'a Salesforce stage name, without quotes or angle brackets',
};
/** What the pipeline field means per CRM; Salesforce has no pipeline id. */
export const PIPELINE_FORMAT: Record<CrmProvider, RegExp> = {
  hubspot: /^[A-Za-z0-9_-]{1,64}$/,
  pipedrive: /^(default|[0-9]{1,15})$/,
  salesforce: /^default$/,
};
/** Which stages a person maps per CRM. Pipedrive's won and lost are its deal status. */
export function mappedStages(p: CrmProvider): DealStage[] {
  return p === 'pipedrive' ? DEAL_STAGES.filter((s) => s !== 'won' && s !== 'lost') : [...DEAL_STAGES];
}

export const crmSettingsSchema = z.object({
  crm_sync_enabled: z.boolean(),
  crm_provider: z.enum(CRM_PROVIDERS, 'Choose a CRM.'),
  crm_sync_scope: z.enum(CRM_SCOPES, 'Choose which leads to send.'),
  crm_pipeline_id: z.string().trim(),
  crm_stage_map: z.record(z.string(), z.string().trim()),
}).superRefine((v, ctx) => {
  const p = v.crm_provider;
  const pipe = v.crm_pipeline_id || 'default';
  if (!PIPELINE_FORMAT[p].test(pipe)) {
    ctx.addIssue({ code: 'custom', path: ['crm_pipeline_id'], message: p === 'pipedrive' ? 'The Pipedrive pipeline must be its number, or blank for the default pipeline.' : 'The pipeline must be a HubSpot id: letters, numbers, dashes or underscores.' });
  }
  for (const s of mappedStages(p)) {
    const val = v.crm_stage_map[s] ?? '';
    if (val && !STAGE_FORMAT[p].test(val)) ctx.addIssue({ code: 'custom', message: `The ${PROVIDER_NAMES[p]} stage for ${DEAL_STAGE_LABELS[s]} must be ${FORMAT_HELP[p]}.` });
  }
  const ids = mappedStages(p).map((s) => v.crm_stage_map[s] || DEFAULT_STAGES[p][s]).filter(Boolean);
  if (new Set(ids).size !== ids.length) ctx.addIssue({ code: 'custom', message: `Each of your stages needs its own ${PROVIDER_NAMES[p]} stage.` });
}).transform((v) => ({
  crm_sync_enabled: v.crm_sync_enabled,
  crm_provider: v.crm_provider,
  crm_sync_scope: v.crm_sync_scope,
  crm_pipeline_id: v.crm_pipeline_id || 'default',
  // Only stages that differ from the CRM's defaults are stored
  crm_stage_map: Object.fromEntries(mappedStages(v.crm_provider)
    .filter((s) => v.crm_stage_map[s] && v.crm_stage_map[s] !== DEFAULT_STAGES[v.crm_provider][s]).map((s) => [s, v.crm_stage_map[s]])),
}));

/**
 * Reads the settings form. The pipeline and stage fields on the page belong to
 * the CRM that was saved; when another CRM is chosen they mean nothing to it,
 * so they reset to the new CRM's defaults instead of being checked against it.
 */
export function parseCrmForm(form: FormData) {
  const raw = form.get('crm_provider');
  // Older forms had no choice: HubSpot
  const provider = raw === null ? 'hubspot' : raw;
  const was = form.get('crm_provider_was');
  const switched = typeof was === 'string' && was !== provider;
  return crmSettingsSchema.safeParse({
    crm_sync_enabled: form.get('crm_sync_enabled') === 'on',
    crm_provider: provider,
    crm_sync_scope: form.get('crm_sync_scope') ?? '',
    crm_pipeline_id: switched ? '' : form.get('crm_pipeline_id') ?? '',
    crm_stage_map: switched ? {} : Object.fromEntries(DEAL_STAGES.map((s) => [s, String(form.get(`stage_${s}`) ?? '')])),
  });
}

/** Whether the form chose a different CRM from the saved one. */
export function crmSwitched(form: FormData): boolean {
  const was = form.get('crm_provider_was');
  return typeof was === 'string' && was !== (form.get('crm_provider') ?? 'hubspot');
}

/** Help shown under the pipeline field, per CRM. */
export const PIPELINE_HELP: Record<CrmProvider, string> = {
  hubspot: 'Leave as default for HubSpot\'s sales pipeline. For another pipeline, enter its id and the id of each stage below.',
  pipedrive: 'Leave as default for your default pipeline, or enter the pipeline\'s number. Stages are Pipedrive stage numbers; a blank stage puts the deal in the pipeline\'s first stage. Won and lost use Pipedrive\'s own deal status.',
  salesforce: 'Salesforce has no pipeline id. Stages are your opportunity stage names, as they appear in Salesforce. Won and lost are read from Salesforce\'s own Won and Closed settings.',
};

/** What a person sets up in each CRM before switching sync on. */
export const CONNECT_HELP: Record<CrmProvider, string> = {
  hubspot: 'Needs a HubSpot private app token with contacts, deals and notes access.',
  pipedrive: 'Needs a Pipedrive API token from a user who can see and edit people, deals and notes.',
  salesforce: 'Needs an external client app or connected app with the client credentials flow and a run-as user who can create contacts, opportunities, contact roles and tasks.',
};

export function savedStage(map: unknown, s: DealStage, p: CrmProvider = 'hubspot'): string {
  const v = map && typeof map === 'object' && !Array.isArray(map) ? (map as Record<string, unknown>)[s] : undefined;
  return typeof v === 'string' && STAGE_FORMAT[p].test(v) ? v : DEFAULT_STAGES[p][s];
}

export function asProvider(v: unknown): CrmProvider {
  return (CRM_PROVIDERS as readonly string[]).includes(String(v)) ? (v as CrmProvider) : 'hubspot';
}

const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.floor(v) : 0);
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`;

export function describeCrmSync(r: Record<string, unknown>): string {
  if (typeof r.skipped === 'string') return `${r.skipped}.`;
  const crm = typeof r.crm === 'string' && Object.values(PROVIDER_NAMES).includes(r.crm) ? r.crm : 'HubSpot';
  const parts: string[] = [];
  if (num(r.contacts_sent)) parts.push(`${plural(num(r.contacts_sent), 'contact')} sent`);
  if (num(r.deals_created)) parts.push(`${plural(num(r.deals_created), 'deal')} created`);
  if (num(r.deals_updated)) parts.push(`${plural(num(r.deals_updated), 'deal')} updated`);
  if (num(r.notes_created)) parts.push(`${plural(num(r.notes_created), 'activity note')} added`);
  if (num(r.closed_from_crm)) parts.push(`${plural(num(r.closed_from_crm), 'deal')} closed from ${crm}`);
  if (num(r.contacts_without_email)) parts.push(`${num(r.contacts_without_email)} without an email skipped`);
  const head = parts.length ? `${parts.join('; ')}.` : `${crm} is up to date.`;
  return r.rate_limited === true ? `${head} ${crm} asked to slow down; the rest syncs next hour.` : head;
}
