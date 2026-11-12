// Campaign and lead helpers shared by the campaign and lead screens.

import { z } from 'zod';

export const LEAD_SOURCES = ['apollo', 'google_maps', 'instagram', 'llm_search', 'facebook', 'linkedin', 'tiktok', 'x', 'clay', 'csv', 'inbound_call', 'manual'] as const;
export type LeadSource = (typeof LEAD_SOURCES)[number];

export const SOURCE_LABELS: Record<LeadSource, string> = {
  apollo: 'Apollo', google_maps: 'Google Maps', instagram: 'Instagram', llm_search: 'LLM search',
  facebook: 'Facebook', linkedin: 'LinkedIn', tiktok: 'TikTok', x: 'X', clay: 'Clay', csv: 'CSV import',
  inbound_call: 'Inbound call', manual: 'Added by hand',
};

export const LEAD_STAGES = ['new', 'contacted', 'engaged', 'interested', 'meeting_booked', 'won', 'lost', 'not_interested', 'do_not_contact'] as const;
export type LeadStage = (typeof LEAD_STAGES)[number];

export const STAGE_LABELS: Record<LeadStage, string> = {
  new: 'New', contacted: 'Contacted', engaged: 'Engaged', interested: 'Interested', meeting_booked: 'Meeting booked',
  won: 'Won', lost: 'Lost', not_interested: 'Not interested', do_not_contact: 'Do not contact',
};

/** The sources the lead sourcing agent can search, in plan order. */
export const PLAN_SOURCES = ['apollo', 'google_maps', 'instagram', 'llm_search'] as const;
export type PlanSource = (typeof PLAN_SOURCES)[number];

export const PLAN_SOURCE_TOOLS: Record<PlanSource, string> = {
  apollo: 'Apollo', google_maps: 'Apify', instagram: 'Apify', llm_search: 'OpenAI, Anthropic or Gemini',
};

const areaList = z
  .string()
  .max(2000, 'Target areas are too long')
  .transform((s) => [...new Set(s.split(/[\n;]+/).map((a) => a.trim()).filter(Boolean))])
  .pipe(z.array(z.string().max(120, 'Each target area must be at most 120 characters')).min(1, 'Add at least one target area, for example a country or city').max(10, 'Use at most 10 target areas'));

export const scoreThreshold = z.coerce.number('Enter a score from 0 to 100').int('Use a whole number').min(0, 'The score threshold must be from 0 to 100').max(100, 'The score threshold must be from 0 to 100');

export const campaignSchema = z.object({
  name: z.string().trim().min(1, 'Give the campaign a name').max(160, 'Campaign name must be at most 160 characters'),
  niche: z.string().trim().min(2, 'Describe the niche you sell to').max(200, 'Niche must be at most 200 characters'),
  target_areas: areaList,
  offer: z.string().trim().max(500, 'Offer must be at most 500 characters').transform((s) => s || null),
  daily_lead_limit: z.coerce.number('Enter a daily lead limit').int('Use a whole number').min(1, 'Daily lead limit must be at least 1').max(1000, 'Daily lead limit must be at most 1000'),
  score_threshold: scoreThreshold,
  find_leads_now: z.boolean(),
});
export type CampaignInput = z.infer<typeof campaignSchema>;

export function parseCampaignForm(form: FormData) {
  return campaignSchema.safeParse({
    name: form.get('name') ?? '',
    niche: form.get('niche') ?? '',
    target_areas: form.get('target_areas') ?? '',
    offer: form.get('offer') ?? '',
    daily_lead_limit: form.get('daily_lead_limit') ?? '',
    score_threshold: form.get('score_threshold') ?? '60',
    find_leads_now: form.get('find_leads_now') === 'on',
  });
}

export const PAGE_SIZE = 50;

export type LeadSort = 'newest' | 'score';
export type LeadFilters = { source: LeadSource | null; stage: LeadStage | null; verification: VerificationStatus | null; campaign: string | null; q: string; minScore: number | null; sort: LeadSort; page: number };

const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? '';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Reads lead list filters from the URL; anything unknown is ignored. */
export function parseLeadFilters(params: Record<string, string | string[] | undefined>): LeadFilters {
  const source = one(params.source);
  const stage = one(params.stage);
  const campaign = one(params.campaign);
  const verification = one(params.verification);
  const minScore = one(params.min_score) === '' ? NaN : Number(one(params.min_score));
  const page = Number.parseInt(one(params.page), 10);
  return {
    source: (LEAD_SOURCES as readonly string[]).includes(source) ? (source as LeadSource) : null,
    stage: (LEAD_STAGES as readonly string[]).includes(stage) ? (stage as LeadStage) : null,
    verification: (VERIFICATION_STATUSES as readonly string[]).includes(verification) ? (verification as VerificationStatus) : null,
    campaign: UUID.test(campaign) ? campaign.toLowerCase() : null,
    q: searchTerm(one(params.q)),
    minScore: Number.isInteger(minScore) && minScore >= 0 && minScore <= 100 ? minScore : null,
    sort: one(params.sort) === 'score' ? 'score' : 'newest',
    page: Number.isFinite(page) && page > 0 ? Math.min(page, 1000) : 1,
  };
}

/**
 * Makes a search term safe to place inside a PostgREST `or` filter:
 * characters with meaning there (commas, parentheses, wildcards, quotes,
 * backslashes) are replaced with spaces.
 */
export function searchTerm(raw: string): string {
  return raw.replace(/[,()%*_\\"'.:]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80);
}

export function filtersToQuery(f: LeadFilters, overrides: Partial<LeadFilters> = {}): string {
  const merged = { ...f, ...overrides };
  const q = new URLSearchParams();
  if (merged.source) q.set('source', merged.source);
  if (merged.stage) q.set('stage', merged.stage);
  if (merged.verification) q.set('verification', merged.verification);
  if (merged.campaign) q.set('campaign', merged.campaign);
  if (merged.q) q.set('q', merged.q);
  if (merged.minScore !== null) q.set('min_score', String(merged.minScore));
  if (merged.sort === 'score') q.set('sort', 'score');
  if (merged.page > 1) q.set('page', String(merged.page));
  const s = q.toString();
  return s ? `?${s}` : '';
}

export const JOB_LABELS: Record<string, string> = { campaign_plan: 'Plan campaign', lead_sourcing: 'Find leads', enrichment: 'Enrich and verify', research: 'Research and score', copywriting: 'Write emails', email_outreach: 'Send emails', reply_handling: 'Read replies', reply_send: 'Send answers' };

export const JOB_TYPES = ['campaign_plan', 'lead_sourcing', 'enrichment', 'research', 'copywriting', 'email_outreach'] as const;
export type JobType = (typeof JOB_TYPES)[number];
export const JOB_STATUS_LABELS: Record<string, string> = { queued: 'Queued', running: 'Running', succeeded: 'Done', failed: 'Failed' };

type SourceStats = { found?: number; added?: number; duplicates?: number; suppressed?: number; without_contact?: number; error?: string };

/** One line per job for the history list, built only from known fields. */
export function describeJobResult(type: string, status: string, result: unknown, error: string | null): string {
  if (status === 'failed') return error || 'The job failed.';
  if (status === 'queued') return 'Waiting for the next agent run (about a minute).';
  if (status === 'running') return 'The agent is working on it.';
  const r = (result && typeof result === 'object' ? result : {}) as Record<string, unknown>;
  if (type === 'campaign_plan') {
    const sources = Array.isArray(r.enabled_sources) ? r.enabled_sources.filter((s): s is PlanSource => (PLAN_SOURCES as readonly string[]).includes(s)) : [];
    return sources.length ? `Plan ready. Searching ${sources.map((s) => SOURCE_LABELS[s]).join(', ')}.` : 'Plan ready, but no lead source is connected yet.';
  }
  if (type === 'enrichment') return describeEnrichment(r);
  if (type === 'research') return describeResearch(r);
  if (type === 'copywriting') {
    if (typeof r.note === 'string') return r.note;
    const n = num(r.leads_written);
    if (!n && !num(r.failed)) return 'No new qualified leads to write to.';
    return `${plural(n, 'email sequence')} written${r.waiting_for_approval === true ? ', waiting for approval' : ' and approved'}${num(r.failed) ? `; ${num(r.failed)} could not be written and will be retried` : ''}.`;
  }
  if (type === 'reply_send') {
    if (typeof r.note === 'string') return r.note;
    const parts = [`${plural(num(r.sent), 'answer')} sent`];
    if (num(r.failed)) parts.push(`${num(r.failed)} could not be sent`);
    if (num(r.skipped)) parts.push(`${num(r.skipped)} skipped because the lead opted out or the thread is unknown`);
    return `${parts.join('; ')}.${typeof r.error === 'string' ? ` ${r.error}` : ''}`;
  }
  if (type === 'reply_handling') {
    const parts: string[] = [];
    if (num(r.auto_answers)) parts.push(`${plural(num(r.auto_answers), 'answer')} approved automatically`);
    if (num(r.replies)) parts.push(`${plural(num(r.replies), 'reply', 'replies')} read: ${num(r.hot)} need${num(r.hot) === 1 ? 's' : ''} you, ${num(r.unsubscribed)} unsubscribed`);
    if (num(r.bounced)) parts.push(plural(num(r.bounced), 'bounce'));
    if (num(r.sent)) parts.push(`${plural(num(r.sent), 'email')} sent`);
    const line = parts.length ? `${parts.join('; ')}.` : 'No new replies.';
    return typeof r.alert_error === 'string' ? `${line} Slack alert failed: ${r.alert_error}` : line;
  }
  if (type === 'email_outreach') {
    if (r.action === 'sending') return `${plural(num(r.leads_added), 'lead')} added to Instantly today (daily limit ${num(r.daily_limit)}).`;
    if (r.action === 'paused') return `Instantly campaign paused. ${typeof r.reason === 'string' ? r.reason : ''}`.trim();
    return typeof r.reason === 'string' ? r.reason : 'Nothing to send.';
  }
  if (typeof r.note === 'string') return r.note;
  const added = typeof r.added === 'number' ? r.added : 0;
  const parts: string[] = [];
  const sources = r.sources && typeof r.sources === 'object' ? (r.sources as Record<string, SourceStats>) : {};
  for (const s of PLAN_SOURCES) {
    const st = sources[s];
    if (!st) continue;
    parts.push(st.error ? `${SOURCE_LABELS[s]} failed: ${st.error}` : `${SOURCE_LABELS[s]} ${st.added ?? 0}`);
  }
  return `${added} new ${added === 1 ? 'lead' : 'leads'}${parts.length ? ` (${parts.join(', ')})` : ''}.`;
}

const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
const obj = (v: unknown) => (v && typeof v === 'object' ? (v as Record<string, unknown>) : {});
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

function describeResearch(r: Record<string, unknown>): string {
  const scored = num(r.leads_scored);
  if (!scored && !num(r.companies_failed)) return 'No new leads to research.';
  const parts = [`${plural(scored, 'lead')} scored: ${num(r.qualified)} qualified for outreach (score ${num(r.threshold)} or more), ${num(r.below_threshold)} below`];
  if (num(r.companies_researched)) parts.push(`${plural(num(r.companies_researched), 'company', 'companies')} researched`);
  if (num(r.companies_failed)) parts.push(`${plural(num(r.companies_failed), 'company', 'companies')} could not be researched and will be retried`);
  return `${parts.join('; ')}.`;
}

function describeEnrichment(r: Record<string, unknown>): string {
  const companies = obj(r.companies);
  const emails = obj(r.emails);
  const phones = obj(r.phones);
  const parts: string[] = [];
  if (num(companies.checked)) parts.push(`${plural(num(companies.leads_added), 'new contact')} from ${plural(num(companies.checked), 'company', 'companies')}`);
  if (num(emails.checked)) parts.push(`${plural(num(emails.checked), 'email')} checked (${num(emails.valid)} valid, ${num(emails.invalid)} invalid, ${num(emails.catch_all) + num(emails.risky)} uncertain)`);
  if (num(phones.checked)) parts.push(`${plural(num(phones.checked), 'phone')} checked (${num(phones.mobile)} mobile, ${num(phones.landline)} landline, ${num(phones.voip)} VoIP)`);
  for (const e of [companies.error, emails.error, phones.error]) if (typeof e === 'string') parts.push(e);
  const notes = Array.isArray(r.notes) ? r.notes.filter((n): n is string => typeof n === 'string') : [];
  if (!parts.length && !notes.length) return 'Nothing new to enrich or verify.';
  return [parts.join('; '), ...notes].filter(Boolean).join(' ');
}

export const VERIFICATION_STATUSES = ['unverified', 'valid', 'invalid', 'catch_all', 'risky'] as const;
export type VerificationStatus = (typeof VERIFICATION_STATUSES)[number];
export const VERIFICATION_LABELS: Record<VerificationStatus, string> = {
  unverified: 'Not checked', valid: 'Verified', invalid: 'Invalid', catch_all: 'Catch-all', risky: 'Risky',
};
export const LINE_TYPE_LABELS: Record<string, string> = { mobile: 'Mobile', landline: 'Landline', voip: 'VoIP', unknown: 'Unknown type' };

export type SourceRow = { source: PlanSource; enabled: boolean; detail: string };

/** What the saved plan will search, for the campaign page. */
export function describeSourcePlan(plan: unknown): SourceRow[] {
  const p = (plan && typeof plan === 'object' ? plan : {}) as Record<string, Record<string, unknown> | undefined>;
  const list = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
  return PLAN_SOURCES.map((source) => {
    const s = p[source] ?? {};
    const enabled = s.enabled === true;
    let detail = '';
    if (source === 'apollo') detail = list(s.person_titles).join(', ');
    if (source === 'google_maps') detail = `${list(s.search_terms).join(', ')}${list(s.locations).length ? ` in ${list(s.locations).join('; ')}` : ''}`;
    if (source === 'instagram') detail = list(s.hashtags).map((h) => `#${h}`).join(' ');
    if (source === 'llm_search') detail = list(s.queries).join(' · ');
    return { source, enabled, detail: detail || '—' };
  });
}

/** Colour band for a score badge. */
export function scoreBand(score: number | null, threshold = 60): 'ok' | 'warn' | 'none' | 'low' {
  if (score === null) return 'none';
  if (score >= threshold) return 'ok';
  if (score >= threshold - 20) return 'warn';
  return 'low';
}

export type LeadReport = {
  company_summary?: string; services?: string[]; pain_points?: string[]; trigger_events?: string[];
  personalization_hooks?: string[]; fit_score?: number; intent_score?: number; score?: number;
  score_reasons?: string[]; model_reasons?: string[]; disqualifiers?: string[]; qualified?: boolean; threshold?: number; generated_at?: string;
};

/** Reads the stored AI report defensively: only expected fields, right types. */
export function readLeadReport(raw: unknown): LeadReport | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const strs = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string').slice(0, 10) : undefined);
  const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
  return {
    company_summary: typeof r.company_summary === 'string' ? r.company_summary : undefined,
    services: strs(r.services), pain_points: strs(r.pain_points), trigger_events: strs(r.trigger_events),
    personalization_hooks: strs(r.personalization_hooks), fit_score: n(r.fit_score), intent_score: n(r.intent_score), score: n(r.score),
    score_reasons: strs(r.score_reasons), model_reasons: strs(r.model_reasons), disqualifiers: strs(r.disqualifiers),
    qualified: typeof r.qualified === 'boolean' ? r.qualified : undefined, threshold: n(r.threshold),
    generated_at: typeof r.generated_at === 'string' ? r.generated_at : undefined,
  };
}
