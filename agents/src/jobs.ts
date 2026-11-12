// Runs agent jobs: planning a campaign and sourcing leads for it.

import { buildClients, withFailover, type LlmKeys, type ModelConfig } from './llm.ts';
import { ProviderError, type Fetch } from './http.ts';
import { CAMPAIGN_PLAN_JSON_SCHEMA, PLAN_SYSTEM, SourcePlanSchema, parsePlan, planPrompt, sanitizePlan, IcpSchema, type CampaignPlan } from './plan.ts';
import { dedupe, hasContact, isSuppressed, normalizeCandidate, type LeadCandidate, type SourceChannel, type SourceResult } from './leads.ts';
import { sourceApollo } from './sources/apollo.ts';
import { sourceGoogleMaps } from './sources/googleMaps.ts';
import { sourceInstagram } from './sources/instagram.ts';
import { sourceLlmSearch } from './sources/llmSearch.ts';
import { SOURCE_LABELS, type Campaign, type Job, type Store } from './store.ts';
import { log } from './log.ts';
import { runEnrichment as enrich, type EnrichmentDeps } from './enrichment.ts';
import { runResearch as research, ResearchError } from './research.ts';
import type { Resolver } from './sources/website.ts';

export type Deps = { store: Store; models: ModelConfig; fetchImpl?: Fetch; resolve?: Resolver; scheduleHours?: number };

export class JobError extends Error {}

async function llmKeys(deps: Deps, workspaceId: string, connected: Set<string>): Promise<LlmKeys> {
  const keys: LlmKeys = {};
  for (const p of ['openai', 'anthropic', 'gemini'] as const) {
    if (!connected.has(p)) continue;
    const s = await deps.store.secret(workspaceId, p);
    if (s?.api_key) keys[p] = s.api_key;
  }
  return keys;
}

async function loadCampaign(deps: Deps, job: Job): Promise<Campaign> {
  const campaign = await deps.store.campaign(job.workspace_id, job.campaign_id);
  if (!campaign) throw new JobError('The campaign no longer exists');
  if (!campaign.niche?.trim()) throw new JobError('The campaign has no niche to plan from');
  return campaign;
}

async function planCampaign(deps: Deps, job: Job, campaign: Campaign, connected: Set<string>) {
  const clients = buildClients(await llmKeys(deps, job.workspace_id, connected), deps.models, deps.fetchImpl);
  if (!clients.length) throw new JobError('Connect OpenAI, Anthropic or Gemini in Setup so the agent can plan the campaign');
  const input = { niche: campaign.niche!, targetAreas: campaign.target_areas, offer: campaign.offer, connected };
  const { value, provider } = await withFailover(
    clients,
    (client) => client.generateJson({
      system: PLAN_SYSTEM, prompt: planPrompt(input), schemaName: 'campaign_plan', schema: CAMPAIGN_PLAN_JSON_SCHEMA, webSearch: false,
    }),
    (raw) => sanitizePlan(parsePlan(raw), input),
    { job: job.id, correlation_id: job.correlation_id },
  );
  await deps.store.savePlan(job.workspace_id, campaign.id, value);
  return { plan: value, provider };
}

export async function runCampaignPlan(deps: Deps, job: Job) {
  const campaign = await loadCampaign(deps, job);
  const connected = await deps.store.connectedTools(job.workspace_id);
  const { plan, provider } = await planCampaign(deps, job, campaign, connected);
  return {
    provider,
    enabled_sources: Object.entries(plan.sources).filter(([, s]) => s.enabled).map(([k]) => k),
    titles: plan.icp.decision_maker_titles.length,
  };
}

type SourceStats = { found: number; added: number; duplicates: number; suppressed: number; without_contact: number; error?: string; credits_used?: number };

export async function runLeadSourcing(deps: Deps, job: Job) {
  const campaign = await loadCampaign(deps, job);
  const connected = await deps.store.connectedTools(job.workspace_id);

  let plan: CampaignPlan;
  const savedSources = SourcePlanSchema.safeParse(campaign.source_plan);
  const savedIcp = IcpSchema.safeParse(campaign.icp);
  if (savedSources.success && savedIcp.success) {
    // Re-check the saved plan against the tools connected now
    plan = sanitizePlan({ icp: savedIcp.data, sources: savedSources.data },
      { niche: campaign.niche!, targetAreas: campaign.target_areas, offer: campaign.offer, connected });
  } else {
    plan = (await planCampaign(deps, job, campaign, connected)).plan;
  }

  const remaining = campaign.daily_lead_limit - (await deps.store.addedToday(job.workspace_id, campaign.id));
  const enabled = (Object.keys(plan.sources) as SourceChannel[]).filter((k) => plan.sources[k].enabled);
  if (remaining <= 0) return { added: 0, note: 'The daily lead limit for this campaign is already reached', sources: {} };
  if (!enabled.length) {
    throw new JobError('No lead source can run. Connect Apollo, Apify or a language model in Setup, then plan the campaign again.');
  }
  const perSource = Math.max(1, Math.ceil(remaining / enabled.length));

  const results = new Map<SourceChannel, SourceResult>();
  const stats: Partial<Record<SourceChannel, SourceStats>> = {};
  // Every source runs at the same time; one failing never stops the others
  const settled = await Promise.allSettled(enabled.map((source) => runSource(deps, job, source, plan, connected, perSource)));
  for (const [i, outcome] of settled.entries()) {
    const source = enabled[i];
    if (outcome.status === 'fulfilled') {
      results.set(source, outcome.value);
      continue;
    }
    const err = outcome.reason;
    const message = err instanceof Error ? err.message : 'unknown error';
    stats[source] = { found: 0, added: 0, duplicates: 0, suppressed: 0, without_contact: 0, error: message };
    log('warn', 'lead source failed', { job: job.id, correlation_id: job.correlation_id, source, error: message });
    if (err instanceof ProviderError && (err.status === 401 || err.status === 403)) {
      const tool = source === 'apollo' ? 'apollo' : source === 'llm_search' ? null : 'apify';
      if (tool) await deps.store.markToolError(job.workspace_id, tool, 'error', message);
    }
  }

  // Normalise, then drop suppressed and duplicate records, source by source
  const all = [...results.entries()].flatMap(([, r]) => r.leads.map(normalizeCandidate));
  const suppressions = await deps.store.suppressions(job.workspace_id, all);
  const existing = await deps.store.existingKeys(job.workspace_id, all);
  const seen = new Set(existing);
  const withContact: LeadCandidate[] = [];
  const companiesOnly: LeadCandidate[] = [];
  let budget = remaining;

  for (const [source, result] of results) {
    const s: SourceStats = { found: result.found, added: 0, duplicates: 0, suppressed: 0, without_contact: 0 };
    if (result.creditsUsed !== undefined) s.credits_used = result.creditsUsed;
    const normalized = result.leads.map(normalizeCandidate);
    const allowed = normalized.filter((c) => !isSuppressed(c, suppressions));
    s.suppressed = normalized.length - allowed.length;
    const contactable = allowed.filter(hasContact);
    const noContact = allowed.filter((c) => !hasContact(c));
    s.without_contact = noContact.length;
    companiesOnly.push(...noContact);
    const { fresh, duplicates } = dedupe(contactable, seen);
    s.duplicates = duplicates;
    for (const c of fresh) {
      if (budget <= 0) break;
      withContact.push(c);
      budget--;
      s.added++;
    }
    stats[source] = s;
  }

  const saved = await deps.store.saveLeads(job.workspace_id, campaign, withContact, companiesOnly);
  // A unique-email race with another job counts as a duplicate, not an addition
  if (saved.conflicts > 0) {
    let left = saved.conflicts;
    for (const s of Object.values(stats).reverse()) {
      if (!s || left <= 0) continue;
      const take = Math.min(s.added, left);
      s.added -= take;
      s.duplicates += take;
      left -= take;
    }
  }

  const failed = Object.entries(stats).filter(([, s]) => s?.error);
  if (failed.length === enabled.length) {
    throw new JobError(`Every lead source failed. ${failed.map(([k, s]) => `${SOURCE_LABELS[k as SourceChannel]}: ${s!.error}`).join('; ')}`);
  }
  return { added: saved.added, companies: saved.companies, sources: stats };
}

async function runSource(deps: Deps, job: Job, source: SourceChannel, plan: CampaignPlan, connected: Set<string>, limit: number): Promise<SourceResult> {
  const ws = job.workspace_id;
  switch (source) {
    case 'apollo': {
      const s = await deps.store.secret(ws, 'apollo');
      if (!s?.api_key) throw new JobError('Apollo is not connected');
      return sourceApollo(plan.sources.apollo, s.api_key, limit, deps.fetchImpl);
    }
    case 'google_maps': {
      const s = await deps.store.secret(ws, 'apify');
      if (!s?.api_token) throw new JobError('Apify is not connected');
      return sourceGoogleMaps(plan.sources.google_maps, s.api_token, limit, deps.fetchImpl);
    }
    case 'instagram': {
      const s = await deps.store.secret(ws, 'apify');
      if (!s?.api_token) throw new JobError('Apify is not connected');
      return sourceInstagram(plan.sources.instagram, s.api_token, limit, deps.fetchImpl);
    }
    case 'llm_search': {
      const clients = buildClients(await llmKeys(deps, ws, connected), deps.models, deps.fetchImpl);
      return sourceLlmSearch(plan.sources.llm_search, plan.icp, clients, limit);
    }
  }
}

export async function runEnrichment(deps: Deps, job: Job) {
  const campaign = await deps.store.campaign(job.workspace_id, job.campaign_id);
  if (!campaign) throw new JobError('The campaign no longer exists');
  return enrich(deps as EnrichmentDeps, job, campaign);
}

export async function runResearch(deps: Deps, job: Job) {
  const campaign = await deps.store.campaign(job.workspace_id, job.campaign_id);
  if (!campaign) throw new JobError('The campaign no longer exists');
  try {
    return await research(deps, job, campaign);
  } catch (err) {
    if (err instanceof ResearchError) throw new JobError(err.message);
    throw err;
  }
}

const HANDLERS = { campaign_plan: runCampaignPlan, lead_sourcing: runLeadSourcing, enrichment: runEnrichment, research: runResearch } as const;

// After a job succeeds, the next stage of the pipeline starts by itself
const NEXT_STAGE: Partial<Record<Job['type'], 'enrichment' | 'research'>> = { lead_sourcing: 'enrichment', enrichment: 'research' };

/** Claims and runs up to `limit` jobs. Each job's failure is recorded on that job only. */
export async function runQueuedJobs(deps: Deps, limit: number) {
  // Daily runs for every active campaign (SRS FR-2.6); 0 switches it off
  const hours = deps.scheduleHours ?? 0;
  if (hours > 0) {
    const queued = await deps.store.enqueueDue(hours);
    if (queued) log('info', 'scheduled daily jobs', { queued });
  }
  const jobs = await deps.store.claimJobs(limit);
  const outcomes: { id: string; type: string; status: 'succeeded' | 'failed' }[] = [];
  for (const job of jobs) {
    const started = Date.now();
    const runLog = await deps.store.runLogStart(job.workspace_id, `agent.${job.type}`, job.correlation_id);
    try {
      const result = await HANDLERS[job.type](deps, job);
      await deps.store.finishJob(job.id, 'succeeded', result, null);
      await deps.store.runLogFinish(runLog, 'success', null);
      const next = NEXT_STAGE[job.type];
      if (next) await deps.store.enqueue(job.workspace_id, job.campaign_id, next).catch(() => false);
      outcomes.push({ id: job.id, type: job.type, status: 'succeeded' });
      log('info', 'job succeeded', { job: job.id, type: job.type, workspace_id: job.workspace_id, correlation_id: job.correlation_id, ms: Date.now() - started });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'The job failed';
      await deps.store.finishJob(job.id, 'failed', {}, message);
      await deps.store.runLogFinish(runLog, 'error', message);
      outcomes.push({ id: job.id, type: job.type, status: 'failed' });
      log('error', 'job failed', { job: job.id, type: job.type, workspace_id: job.workspace_id, correlation_id: job.correlation_id, error: message });
    }
  }
  return outcomes;
}
