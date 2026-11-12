// Database access for the agent service. Connects as the backend through the
// Supabase connection pooler, so prepared statements are switched off.
// Every query is scoped to one workspace_id.

import postgres from 'postgres';
import type { CampaignPlan } from './plan.ts';
import { identityKeys, type ExistingKeys, type LeadCandidate, type Suppressions } from './leads.ts';

export type Sql = postgres.Sql;

export function connect(databaseUrl: string, options: { max?: number } = {}): Sql {
  return postgres(databaseUrl, {
    max: options.max ?? 5,
    prepare: false,
    idle_timeout: 30,
    connect_timeout: 15,
    onnotice: () => {},
    connection: { application_name: 'ai-sdr-agents' },
  });
}

export type Job = {
  id: string;
  workspace_id: string;
  campaign_id: string;
  type: 'campaign_plan' | 'lead_sourcing';
  attempts: number;
  correlation_id: string;
};

export type Campaign = {
  id: string;
  workspace_id: string;
  name: string;
  niche: string | null;
  offer: string | null;
  target_areas: string[];
  daily_lead_limit: number;
  icp: Record<string, unknown>;
  source_plan: Record<string, unknown>;
};

export class Store {
  readonly sql: Sql;
  constructor(sql: Sql) {
    this.sql = sql;
  }

  async claimJobs(limit: number): Promise<Job[]> {
    return (await this.sql`select id, workspace_id, campaign_id, type, attempts, correlation_id from agent_jobs_claim(${limit}::int) order by created_at`) as unknown as Job[];
  }

  async finishJob(id: string, status: 'succeeded' | 'failed', result: unknown, error: string | null) {
    await this.sql`select agent_job_finish(${id}::uuid, ${status}, ${this.sql.json(result as postgres.JSONValue)}, ${error})`;
  }

  async campaign(workspaceId: string, campaignId: string): Promise<Campaign | null> {
    const rows = await this.sql`
      select id, workspace_id, name, niche, offer, target_areas, daily_lead_limit, icp, source_plan
      from campaigns where workspace_id = ${workspaceId}::uuid and id = ${campaignId}::uuid`;
    if (!rows.length) return null;
    const c = rows[0] as unknown as Campaign;
    return { ...c, target_areas: Array.isArray(c.target_areas) ? c.target_areas.filter((a) => typeof a === 'string') : [] };
  }

  async connectedTools(workspaceId: string): Promise<Set<string>> {
    const rows = await this.sql`select tool from integrations where workspace_id = ${workspaceId}::uuid and status = 'connected'`;
    return new Set(rows.map((r) => r.tool as string));
  }

  async secret(workspaceId: string, tool: string): Promise<Record<string, string> | null> {
    const rows = await this.sql`select integration_secret(${workspaceId}::uuid, ${tool}) as s`;
    const s = rows[0]?.s;
    return s && typeof s === 'object' ? (s as Record<string, string>) : null;
  }

  async markToolError(workspaceId: string, tool: string, status: 'error' | 'expired', message: string) {
    await this.sql`select integration_health_update(${workspaceId}::uuid, ${tool}, ${status}, ${message.slice(0, 300)})`;
  }

  async savePlan(workspaceId: string, campaignId: string, plan: CampaignPlan) {
    await this.sql`
      update campaigns set icp = ${this.sql.json(plan.icp as postgres.JSONValue)},
        source_plan = ${this.sql.json(plan.sources as unknown as postgres.JSONValue)}, updated_at = now()
      where workspace_id = ${workspaceId}::uuid and id = ${campaignId}::uuid`;
  }

  /** Identity keys of stored leads that match any candidate. */
  async existingKeys(workspaceId: string, candidates: LeadCandidate[]): Promise<ExistingKeys> {
    const emails = uniq(candidates.map((c) => c.email));
    const phones = uniq(candidates.map((c) => c.phone?.replace(/^\+/, '')));
    const linkedins = uniq(candidates.map((c) => c.linkedinUrl));
    const handles = uniq(candidates.map((c) => c.socialHandles?.instagram));
    const domains = uniq(candidates.map((c) => c.company.domain));
    if (![emails, phones, linkedins, handles, domains].some((a) => a.length)) return new Set();
    const rows = await this.sql`
      select lower(l.email) as email, l.phone, l.linkedin_url, l.full_name, l.social_handles ->> 'instagram' as instagram, c.domain
      from leads l
      left join companies c on c.workspace_id = l.workspace_id and c.id = l.company_id
      where l.workspace_id = ${workspaceId}::uuid
        and (lower(l.email) = any(${emails}::text[])
          or regexp_replace(coalesce(l.phone, ''), '\\D', '', 'g') = any(${phones}::text[])
          or l.linkedin_url = any(${linkedins}::text[])
          or l.social_handles ->> 'instagram' = any(${handles}::text[])
          or (l.full_name is null and c.domain = any(${domains}::text[])))`;
    const keys = new Set<string>();
    for (const r of rows) {
      identityKeys({
        source: 'apollo', sourceQuery: '',
        email: r.email ?? undefined,
        phone: r.phone ? String(r.phone).replace(/\D/g, '') : undefined,
        linkedinUrl: r.linkedin_url ?? undefined,
        fullName: r.full_name ?? undefined,
        socialHandles: r.instagram ? { instagram: r.instagram } : {},
        company: { name: '', domain: r.domain ?? undefined },
      }).forEach((k) => keys.add(k));
    }
    return keys;
  }

  async suppressions(workspaceId: string, candidates: LeadCandidate[]): Promise<Suppressions> {
    const emails = uniq(candidates.map((c) => c.email));
    const phones = uniq(candidates.flatMap((c) => (c.phone ? [c.phone, c.phone.replace(/^\+/, '')] : [])));
    const domains = uniq(candidates.flatMap((c) => [c.company.domain, c.email?.split('@')[1]]));
    const rows = await this.sql`
      select kind, value from suppressions
      where workspace_id = ${workspaceId}::uuid
        and ((kind = 'email' and value = any(${emails}::text[]))
          or (kind = 'phone' and value = any(${phones}::text[]))
          or (kind = 'domain' and value = any(${domains}::text[])))`;
    const s: Suppressions = { emails: new Set(), phones: new Set(), domains: new Set() };
    for (const r of rows) (r.kind === 'email' ? s.emails : r.kind === 'phone' ? s.phones : s.domains).add(r.value);
    return s;
  }

  /**
   * Saves companies and leads in one transaction. Companies are matched by
   * domain; candidates without any contact are kept as companies only.
   */
  async saveLeads(workspaceId: string, campaign: Campaign, withContact: LeadCandidate[], companiesOnly: LeadCandidate[]) {
    return this.sql.begin(async (tx) => {
      const companyIds = new Map<string, string>();
      const companyId = async (c: LeadCandidate): Promise<string> => {
        const key = c.company.domain ? `d:${c.company.domain}` : `n:${c.company.name.toLowerCase()}|${c.company.location ?? ''}`;
        const cached = companyIds.get(key);
        if (cached) return cached;
        const values = {
          name: c.company.name,
          industry: c.company.industry ?? null,
          size_band: c.company.sizeBand ?? null,
          location: c.company.location ?? null,
          google_rating: c.company.googleRating ?? null,
          google_reviews: c.company.googleReviews ?? null,
          social: tx.json((c.company.social ?? {}) as postgres.JSONValue),
        };
        let rows;
        if (c.company.domain) {
          rows = await tx`
            insert into companies (workspace_id, domain, name, industry, size_band, location, google_rating, google_reviews, social)
            values (${workspaceId}::uuid, ${c.company.domain}, ${values.name}, ${values.industry}, ${values.size_band},
                    ${values.location}, ${values.google_rating}, ${values.google_reviews}, ${values.social})
            on conflict (workspace_id, domain) where domain is not null do update set
              industry = coalesce(companies.industry, excluded.industry),
              size_band = coalesce(companies.size_band, excluded.size_band),
              location = coalesce(companies.location, excluded.location),
              google_rating = coalesce(excluded.google_rating, companies.google_rating),
              google_reviews = coalesce(excluded.google_reviews, companies.google_reviews),
              social = companies.social || excluded.social,
              updated_at = now()
            returning id`;
        } else {
          rows = await tx`
            select id from companies where workspace_id = ${workspaceId}::uuid and domain is null
              and lower(name) = lower(${values.name}) and coalesce(location, '') = ${values.location ?? ''} limit 1`;
          if (!rows.length) {
            rows = await tx`
              insert into companies (workspace_id, name, industry, size_band, location, google_rating, google_reviews, social)
              values (${workspaceId}::uuid, ${values.name}, ${values.industry}, ${values.size_band}, ${values.location},
                      ${values.google_rating}, ${values.google_reviews}, ${values.social})
              returning id`;
          }
        }
        const id = rows[0].id as string;
        companyIds.set(key, id);
        return id;
      };

      let added = 0;
      for (const c of companiesOnly) await companyId(c);
      for (const c of withContact) {
        const cid = await companyId(c);
        const rows = await tx`
          insert into leads (workspace_id, campaign_id, company_id, full_name, email, phone, title, linkedin_url,
                             social_handles, source_channel, source_query, niche)
          values (${workspaceId}::uuid, ${campaign.id}::uuid, ${cid}::uuid, ${c.fullName ?? null}, ${c.email ?? null},
                  ${c.phone ?? null}, ${c.title ?? null}, ${c.linkedinUrl ?? null},
                  ${tx.json((c.socialHandles ?? {}) as postgres.JSONValue)}, ${c.source}, ${c.sourceQuery || null}, ${campaign.niche})
          on conflict do nothing
          returning id`;
        if (!rows.length) continue;
        added++;
        await tx`
          insert into activities (workspace_id, lead_id, type, channel, summary, actor)
          values (${workspaceId}::uuid, ${rows[0].id}::uuid, 'note', ${c.source},
                  ${`Found by the lead sourcing agent on ${SOURCE_LABELS[c.source]}${c.sourceQuery ? ` (${c.sourceQuery.slice(0, 200)})` : ''}`}, 'ai')`;
      }
      return { added, conflicts: withContact.length - added, companies: companyIds.size };
    });
  }

  async runLogStart(workspaceId: string, workflow: string, correlationId: string): Promise<number> {
    const rows = await this.sql`
      insert into run_logs (workspace_id, workflow, status, correlation_id)
      values (${workspaceId}::uuid, ${workflow}, 'running', ${correlationId}::uuid) returning id`;
    return Number(rows[0].id);
  }

  async runLogFinish(id: number, status: 'success' | 'error', error: string | null) {
    await this.sql`update run_logs set status = ${status}, error = ${error ? error.slice(0, 500) : null}, finished_at = now() where id = ${id}`;
  }

  async addedToday(workspaceId: string, campaignId: string): Promise<number> {
    const rows = await this.sql`
      select count(*)::int as n from leads
      where workspace_id = ${workspaceId}::uuid and campaign_id = ${campaignId}::uuid and created_at >= date_trunc('day', now())`;
    return rows[0].n as number;
  }
}

export const SOURCE_LABELS: Record<LeadCandidate['source'], string> = {
  apollo: 'Apollo', google_maps: 'Google Maps', instagram: 'Instagram', llm_search: 'LLM search',
};

function uniq(values: (string | undefined)[]): string[] {
  return [...new Set(values.filter((v): v is string => Boolean(v)))];
}
