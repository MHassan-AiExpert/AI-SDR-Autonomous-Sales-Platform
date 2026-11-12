// Database access for the agent service. Connects as the backend through the
// Supabase connection pooler, so prepared statements are switched off.
// Every query is scoped to one workspace_id.

import postgres from 'postgres';
import type { CampaignPlan } from './plan.ts';
import { nextStage } from './replies.ts';
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
  type: 'campaign_plan' | 'lead_sourcing' | 'enrichment' | 'research' | 'copywriting' | 'email_outreach' | 'reply_handling' | 'reply_send' | 'voice_outreach' | 'sms_outreach';
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
  score_threshold: number;
  icp: Record<string, unknown>;
  source_plan: Record<string, unknown>;
  status: string;
  mode: string;
  outreach_status: string;
  sender_name: string | null;
  email_footer: string | null;
  sending_accounts: unknown[];
  send_timezone: string;
  send_window_start: string;
  send_window_end: string;
  send_days: Record<string, boolean>;
  daily_send_limit: number;
  follow_up_count: number;
  follow_up_delay_days: number;
  instantly_campaign_id: string | null;
  instantly_state: 'active' | 'paused' | null;
  auto_answer: boolean;
  booking_event_type: string | null;
  voice_status: string;
  vapi_assistant_id: string | null;
  vapi_phone_number_id: string | null;
  call_timezone: string;
  call_window_start: string;
  call_window_end: string;
  call_days: Record<string, boolean>;
  call_daily_limit: number;
  call_max_attempts: number;
  call_rule: 'consent_only' | 'consent_or_business_landline';
  dnc_attested_at: string | Date | null;
  sms_status: string;
  sms_channel: 'sms' | 'whatsapp';
  sms_from: string | null;
  whatsapp_from: string | null;
  whatsapp_content_sid: string | null;
  sms_after_days: number;
  sms_daily_limit: number;
  sms_max_messages: number;
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
      select id, workspace_id, name, niche, offer, target_areas, daily_lead_limit, score_threshold, icp, source_plan,
             status, mode, outreach_status, sender_name, email_footer, sending_accounts, send_timezone, send_window_start,
             send_window_end, send_days, daily_send_limit, follow_up_count, follow_up_delay_days, instantly_campaign_id, instantly_state,
             auto_answer, booking_event_type, voice_status, vapi_assistant_id, vapi_phone_number_id, call_timezone, call_window_start,
             call_window_end, call_days, call_daily_limit, call_max_attempts, call_rule, dnc_attested_at, sms_status, sms_channel, sms_from,
             whatsapp_from, whatsapp_content_sid, sms_after_days, sms_daily_limit, sms_max_messages
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
        if (c.companyId) return c.companyId;
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
            insert into companies (workspace_id, domain, name, industry, size_band, location, google_rating, google_reviews, social,
                                   campaign_id, source_channel)
            values (${workspaceId}::uuid, ${c.company.domain}, ${values.name}, ${values.industry}, ${values.size_band},
                    ${values.location}, ${values.google_rating}, ${values.google_reviews}, ${values.social},
                    ${campaign.id}::uuid, ${c.source})
            on conflict (workspace_id, domain) where domain is not null do update set
              industry = coalesce(companies.industry, excluded.industry),
              size_band = coalesce(companies.size_band, excluded.size_band),
              location = coalesce(companies.location, excluded.location),
              google_rating = coalesce(excluded.google_rating, companies.google_rating),
              google_reviews = coalesce(excluded.google_reviews, companies.google_reviews),
              social = companies.social || excluded.social,
              campaign_id = coalesce(companies.campaign_id, excluded.campaign_id),
              source_channel = coalesce(companies.source_channel, excluded.source_channel),
              updated_at = now()
            returning id`;
        } else {
          rows = await tx`
            select id from companies where workspace_id = ${workspaceId}::uuid and domain is null
              and lower(name) = lower(${values.name}) and coalesce(location, '') = ${values.location ?? ''} limit 1`;
          if (!rows.length) {
            rows = await tx`
              insert into companies (workspace_id, name, industry, size_band, location, google_rating, google_reviews, social,
                                     campaign_id, source_channel)
              values (${workspaceId}::uuid, ${values.name}, ${values.industry}, ${values.size_band}, ${values.location},
                      ${values.google_rating}, ${values.google_reviews}, ${values.social}, ${campaign.id}::uuid, ${c.source})
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

  // ---------------------------------------------------------------- scheduling

  async enqueueDue(hours: number): Promise<number> {
    const rows = await this.sql`select agent_jobs_enqueue_due(${hours}::int) as n`;
    return Number(rows[0].n);
  }

  async enqueue(workspaceId: string, campaignId: string, type: 'enrichment' | 'lead_sourcing' | 'research' | 'copywriting' | 'email_outreach' | 'reply_handling' | 'reply_send' | 'voice_outreach' | 'sms_outreach'): Promise<boolean> {
    const rows = await this.sql`select agent_job_enqueue(${workspaceId}::uuid, ${campaignId}::uuid, ${type}) as ok`;
    return rows[0].ok === true;
  }

  async workspaceChannels(workspaceId: string): Promise<Record<string, boolean>> {
    const rows = await this.sql`select enabled_channels from workspaces where id = ${workspaceId}::uuid`;
    return (rows[0]?.enabled_channels ?? {}) as Record<string, boolean>;
  }

  // ---------------------------------------------------------------- enrichment

  /** Companies this campaign found that still have no lead. */
  async companiesWithoutLeads(workspaceId: string, campaignId: string, limit: number): Promise<PendingCompany[]> {
    return (await this.sql`
      select c.id, c.name, c.domain, c.location, c.industry, c.size_band, c.source_channel
      from companies c
      where c.workspace_id = ${workspaceId}::uuid and c.campaign_id = ${campaignId}::uuid
        and c.enrichment_status = 'pending'
        and not exists (select 1 from leads l where l.workspace_id = c.workspace_id and l.company_id = c.id)
      order by c.created_at, c.name, c.id
      limit ${limit}`) as unknown as PendingCompany[];
  }

  /** Companies with a domain that are missing firmographics. */
  async companiesMissingDetails(workspaceId: string, campaignId: string, limit: number): Promise<PendingCompany[]> {
    return (await this.sql`
      select id, name, domain, location, industry, size_band, source_channel
      from companies
      where workspace_id = ${workspaceId}::uuid and campaign_id = ${campaignId}::uuid
        and domain is not null and (industry is null or size_band is null) and enriched_at is null
      order by created_at
      limit ${limit}`) as unknown as PendingCompany[];
  }

  async updateCompany(workspaceId: string, id: string, status: 'enriched' | 'no_contact_found' | 'skipped' | null, details: { industry?: string; sizeBand?: string; location?: string; linkedin?: string } = {}) {
    await this.sql`
      update companies set
        enrichment_status = coalesce(${status}, enrichment_status),
        industry = coalesce(industry, ${details.industry ?? null}),
        size_band = coalesce(size_band, ${details.sizeBand ?? null}),
        location = coalesce(location, ${details.location ?? null}),
        social = case when ${details.linkedin ?? null}::text is null then social else social || jsonb_build_object('linkedin', ${details.linkedin ?? null}::text) end,
        enriched_at = now(), updated_at = now()
      where workspace_id = ${workspaceId}::uuid and id = ${id}::uuid`;
  }

  async leadsToVerify(workspaceId: string, campaignId: string, limit: number): Promise<{ id: string; email: string }[]> {
    return (await this.sql`
      select id, email from leads
      where workspace_id = ${workspaceId}::uuid and campaign_id = ${campaignId}::uuid
        and email is not null and verification_status = 'unverified' and email_checked_at is null
        and stage <> 'do_not_contact'
      order by created_at limit ${limit}`) as unknown as { id: string; email: string }[];
  }

  async setEmailVerdict(workspaceId: string, leadId: string, verdict: string, raw: string) {
    await this.sql.begin(async (tx) => {
      await tx`
        update leads set verification_status = ${verdict}, email_checked_at = now(), updated_at = now()
        where workspace_id = ${workspaceId}::uuid and id = ${leadId}::uuid`;
      await tx`
        insert into activities (workspace_id, lead_id, type, channel, summary, actor)
        values (${workspaceId}::uuid, ${leadId}::uuid, 'note', 'email', ${`Email checked: ${VERDICT_LABELS[verdict] ?? verdict} (${raw})`}, 'ai')`;
    });
  }

  async leadsToCheckPhone(workspaceId: string, campaignId: string, limit: number): Promise<{ id: string; phone: string }[]> {
    return (await this.sql`
      select id, phone from leads
      where workspace_id = ${workspaceId}::uuid and campaign_id = ${campaignId}::uuid
        and phone is not null and phone_checked_at is null and stage <> 'do_not_contact'
      order by created_at limit ${limit}`) as unknown as { id: string; phone: string }[];
  }

  async setPhoneCheck(workspaceId: string, leadId: string, check: { e164?: string; country?: string; lineType: string; valid: boolean }) {
    await this.sql.begin(async (tx) => {
      await tx`
        update leads set
          phone = coalesce(${check.valid ? check.e164 ?? null : null}, phone),
          phone_country = coalesce(${check.country ?? null}, phone_country),
          phone_line_type = ${check.valid ? check.lineType : 'unknown'},
          phone_checked_at = now(), updated_at = now()
        where workspace_id = ${workspaceId}::uuid and id = ${leadId}::uuid`;
      await tx`
        insert into activities (workspace_id, lead_id, type, channel, summary, actor)
        values (${workspaceId}::uuid, ${leadId}::uuid, 'note', 'voice',
                ${check.valid ? `Phone checked: ${check.lineType}${check.country ? `, ${check.country}` : ''}` : 'Phone checked: not a valid number'}, 'ai')`;
    });
  }

  // ---------------------------------------------------------------- research

  async leadsToResearch(workspaceId: string, campaignId: string, limit: number): Promise<ResearchLead[]> {
    return (await this.sql`
      select l.id, l.full_name, l.title, l.email, l.phone, l.verification_status, l.phone_line_type, l.social_handles,
             c.id as company_id, c.name as company_name, c.domain as company_domain, c.location as company_location,
             c.industry as company_industry, c.research as company_research, c.researched_at as company_researched_at
      from leads l
      join companies c on c.workspace_id = l.workspace_id and c.id = l.company_id
      where l.workspace_id = ${workspaceId}::uuid and l.campaign_id = ${campaignId}::uuid
        and l.researched_at is null and l.stage <> 'do_not_contact'
      order by l.created_at, l.id
      limit ${limit}`) as unknown as ResearchLead[];
  }

  async saveCompanyResearch(workspaceId: string, companyId: string, research: unknown & { company_summary: string }) {
    await this.sql`
      update companies set research = ${this.sql.json(research as postgres.JSONValue)}, research_brief = ${research.company_summary},
        researched_at = now(), updated_at = now()
      where workspace_id = ${workspaceId}::uuid and id = ${companyId}::uuid`;
  }

  async saveLeadScore(workspaceId: string, leadId: string, score: number, report: Record<string, unknown>, qualified: boolean) {
    await this.sql.begin(async (tx) => {
      await tx`
        update leads set score = ${score}, ai_report = ${tx.json(report as postgres.JSONValue)}, researched_at = now(), updated_at = now()
        where workspace_id = ${workspaceId}::uuid and id = ${leadId}::uuid`;
      await tx`
        insert into activities (workspace_id, lead_id, type, summary, actor)
        values (${workspaceId}::uuid, ${leadId}::uuid, 'note',
                ${`Researched and scored ${score}/100 (${qualified ? 'qualified for outreach' : 'below the threshold'})`}, 'ai')`;
    });
  }

  // ---------------------------------------------------------------- copywriting and outreach

  async workspaceMode(workspaceId: string): Promise<string> {
    const rows = await this.sql`select automation_mode from workspaces where id = ${workspaceId}::uuid`;
    return String(rows[0]?.automation_mode ?? 'autopilot');
  }

  async workspaceState(workspaceId: string): Promise<{ name: string; outreach_paused: boolean; enabled_channels: Record<string, boolean> }> {
    const rows = await this.sql`select name, outreach_paused, enabled_channels from workspaces where id = ${workspaceId}::uuid`;
    return { name: String(rows[0]?.name ?? ''), outreach_paused: rows[0]?.outreach_paused === true, enabled_channels: (rows[0]?.enabled_channels ?? {}) as Record<string, boolean> };
  }

  async activePlaybook(workspaceId: string): Promise<unknown> {
    const rows = await this.sql`select content from playbooks where workspace_id = ${workspaceId}::uuid and is_active limit 1`;
    return rows[0]?.content ?? null;
  }

  /** Qualified, verified, uncontacted leads that have no emails in this campaign yet. */
  async leadsToWrite(workspaceId: string, campaignId: string, threshold: number, limit: number) {
    return (await this.sql`
      select l.id, l.full_name, l.title, l.email, coalesce(c.name, 'your company') as company_name, l.ai_report
      from leads l
      left join companies c on c.workspace_id = l.workspace_id and c.id = l.company_id
      where l.workspace_id = ${workspaceId}::uuid and l.campaign_id = ${campaignId}::uuid
        and l.stage = 'new' and l.email is not null and l.verification_status = 'valid'
        and l.score >= ${threshold} and l.researched_at is not null
        and not app.is_suppressed(l.workspace_id, l.email, l.phone)
        and not exists (select 1 from emails e where e.workspace_id = l.workspace_id and e.lead_id = l.id and e.campaign_id = ${campaignId}::uuid)
      order by l.score desc, l.created_at
      limit ${limit}`) as unknown as { id: string; full_name: string | null; title: string | null; email: string; company_name: string; ai_report: Record<string, unknown> | null }[];
  }

  async saveDrafts(workspaceId: string, campaignId: string, leadId: string, drafts: { subject: string; body: string }[], status: 'draft' | 'approved'): Promise<boolean> {
    return this.sql.begin(async (tx) => {
      let inserted = 0;
      for (const [i, d] of drafts.entries()) {
        const rows = await tx`
          insert into emails (workspace_id, lead_id, campaign_id, step, subject, body, status, idempotency_key)
          values (${workspaceId}::uuid, ${leadId}::uuid, ${campaignId}::uuid, ${i + 1}, ${d.subject}, ${d.body}, ${status},
                  ${`${campaignId}:${leadId}:${i + 1}`})
          on conflict (workspace_id, idempotency_key) do nothing
          returning id`;
        inserted += rows.length;
      }
      if (inserted) {
        await tx`
          insert into activities (workspace_id, lead_id, type, channel, summary, actor)
          values (${workspaceId}::uuid, ${leadId}::uuid, 'email', 'email',
                  ${`AI wrote a ${drafts.length}-email sequence${status === 'draft' ? ', waiting for approval' : ''}`}, 'ai')`;
      }
      return inserted > 0;
    });
  }

  async setInstantlyState(workspaceId: string, campaignId: string, instantlyId: string, state: 'active' | 'paused' | null) {
    await this.sql`
      update campaigns set instantly_campaign_id = ${instantlyId}, instantly_state = ${state}, updated_at = now()
      where workspace_id = ${workspaceId}::uuid and id = ${campaignId}::uuid`;
  }

  async leadsQueuedToday(workspaceId: string, campaignId: string): Promise<number> {
    const rows = await this.sql`
      select count(distinct lead_id)::int as n from emails
      where workspace_id = ${workspaceId}::uuid and campaign_id = ${campaignId}::uuid and step = 1
        and queued_at >= date_trunc('day', now())`;
    return rows[0].n as number;
  }

  /** Leads whose whole sequence is approved and who are still safe to email. */
  async sequencesReady(workspaceId: string, campaignId: string, threshold: number, steps: number, limit: number): Promise<ReadySequence[]> {
    return (await this.sql`
      select l.id as lead_id, l.email, l.full_name, l.title, coalesce(c.name, '') as company_name, c.domain,
             json_agg(json_build_object('id', e.id, 'step', e.step, 'subject', e.subject, 'body', e.body) order by e.step) as emails
      from leads l
      join emails e on e.workspace_id = l.workspace_id and e.lead_id = l.id and e.campaign_id = ${campaignId}::uuid
      left join companies c on c.workspace_id = l.workspace_id and c.id = l.company_id
      where l.workspace_id = ${workspaceId}::uuid and l.campaign_id = ${campaignId}::uuid
        and l.stage = 'new' and l.email is not null and l.verification_status = 'valid' and l.score >= ${threshold}
        and not app.is_suppressed(l.workspace_id, l.email, l.phone)
      group by l.id, l.email, l.full_name, l.title, c.name, c.domain, l.score, l.created_at
      having count(*) filter (where e.status = 'approved' and e.step <= ${steps}) = ${steps}
         and count(*) filter (where e.status not in ('approved', 'rejected')) = 0
      order by l.score desc, l.created_at
      limit ${limit}`) as unknown as ReadySequence[];
  }

  async markQueued(workspaceId: string, leadId: string, emailIds: string[], providerId: string | null, count: number) {
    await this.sql.begin(async (tx) => {
      await tx`
        update emails set status = 'queued', provider_id = ${providerId}, queued_at = now()
        where workspace_id = ${workspaceId}::uuid and id = any(${emailIds}::uuid[])`;
      await tx`
        update leads set stage = 'contacted', stage_changed_at = now(), updated_at = now()
        where workspace_id = ${workspaceId}::uuid and id = ${leadId}::uuid and stage = 'new'`;
      await tx`
        insert into activities (workspace_id, lead_id, type, channel, summary, actor)
        values (${workspaceId}::uuid, ${leadId}::uuid, 'email', 'email', ${`Email sequence started in Instantly (${count} emails)`}, 'ai')`;
    });
  }

  // ---------------------------------------------------------------- inbound events and replies

  async workspaceByToken(token: string): Promise<string | null> {
    const rows = await this.sql`select id from workspaces where webhook_token = ${token}`;
    return rows[0]?.id ?? null;
  }

  async campaignByInstantlyId(workspaceId: string, instantlyId: string): Promise<string | null> {
    const rows = await this.sql`select id from campaigns where workspace_id = ${workspaceId}::uuid and instantly_campaign_id = ${instantlyId} limit 1`;
    return rows[0]?.id ?? null;
  }

  async insertInboundEvent(workspaceId: string, campaignId: string | null, type: string, leadEmail: string | null, payload: Record<string, unknown>, dedupe: string, status: 'received' | 'ignored', provider: 'instantly' | 'calendly' | 'vapi' | 'twilio' = 'instantly'): Promise<string | null> {
    const rows = await this.sql`
      insert into inbound_events (workspace_id, campaign_id, provider, event_type, lead_email, payload, dedupe_key, status, processed_at)
      values (${workspaceId}::uuid, ${campaignId}, ${provider}, ${type}, ${leadEmail}, ${this.sql.json(payload as postgres.JSONValue)}, ${dedupe}, ${status},
              ${status === 'ignored' ? new Date() : null})
      on conflict (workspace_id, provider, dedupe_key) do nothing
      returning id`;
    return rows[0]?.id ?? null;
  }

  async pendingEvents(workspaceId: string, campaignId: string, limit: number): Promise<InboundEvent[]> {
    return (await this.sql`
      select id, provider, event_type, lead_email, payload from inbound_events
      where workspace_id = ${workspaceId}::uuid and campaign_id = ${campaignId}::uuid and status = 'received' and provider in ('instantly', 'twilio')
      order by received_at, id limit ${limit}`) as unknown as InboundEvent[];
  }

  async markEvent(id: string, status: 'processed' | 'ignored' | 'failed', error: string | null) {
    await this.sql`update inbound_events set status = ${status}, error = ${error}, processed_at = now() where id = ${id}::uuid`;
  }

  async leadByEmail(workspaceId: string, email: string) {
    const rows = await this.sql`
      select l.id, l.email, l.full_name, l.stage, c.name as company_name
      from leads l left join companies c on c.workspace_id = l.workspace_id and c.id = l.company_id
      where l.workspace_id = ${workspaceId}::uuid and lower(l.email) = ${email.toLowerCase()} limit 1`;
    return (rows[0] ?? null) as { id: string; email: string; full_name: string | null; stage: string; company_name: string | null } | null;
  }

  async activity(workspaceId: string, leadId: string, type: string, channel: string | null, summary: string, actor: 'ai' | 'human' | 'system') {
    await this.sql`
      insert into activities (workspace_id, lead_id, type, channel, summary, actor)
      values (${workspaceId}::uuid, ${leadId}::uuid, ${type}, ${channel}, ${summary.slice(0, 500)}, ${actor})`;
  }

  /** Marks the earliest email still with the sending service as sent; returns its step. */
  async markNextSent(workspaceId: string, campaignId: string, leadId: string): Promise<number | null> {
    const rows = await this.sql`
      update emails set status = 'sent', sent_at = now()
      where id = (select id from emails where workspace_id = ${workspaceId}::uuid and campaign_id = ${campaignId}::uuid
                    and lead_id = ${leadId}::uuid and status = 'queued' order by step limit 1)
      returning step`;
    return rows[0]?.step ?? null;
  }

  async cancelRemaining(workspaceId: string, campaignId: string, leadId: string) {
    await this.sql`
      update emails set status = 'cancelled'
      where workspace_id = ${workspaceId}::uuid and campaign_id = ${campaignId}::uuid and lead_id = ${leadId}::uuid
        and status in ('queued', 'approved', 'draft')`;
  }

  async markBounced(workspaceId: string, campaignId: string, leadId: string, email: string) {
    await this.sql.begin(async (tx) => {
      await tx`
        update emails set status = 'bounced'
        where id = (select id from emails where workspace_id = ${workspaceId}::uuid and campaign_id = ${campaignId}::uuid
                      and lead_id = ${leadId}::uuid and status in ('sent', 'queued')
                    -- The latest email sent, or else the first one waiting to go out
                    order by status = 'sent' desc, case when status = 'sent' then step end desc nulls last, step limit 1)`;
      await tx`
        update emails set status = 'cancelled'
        where workspace_id = ${workspaceId}::uuid and lead_id = ${leadId}::uuid and status in ('queued', 'approved', 'draft')`;
      await tx`update leads set verification_status = 'invalid', updated_at = now() where workspace_id = ${workspaceId}::uuid and id = ${leadId}::uuid`;
      await tx`
        insert into suppressions (workspace_id, kind, value, reason, created_by)
        values (${workspaceId}::uuid, 'email', ${email.toLowerCase().trim()}, 'bounced', null)
        on conflict (workspace_id, kind, value) do nothing`;
      await tx`
        insert into activities (workspace_id, lead_id, type, channel, summary, actor)
        values (${workspaceId}::uuid, ${leadId}::uuid, 'email', 'email', 'Email bounced: address marked invalid and suppressed', 'system')`;
    });
  }

  async optOut(workspaceId: string, campaignId: string, leadId: string, email: string, why: string) {
    await this.sql.begin(async (tx) => {
      await tx`
        update emails set status = 'cancelled'
        where workspace_id = ${workspaceId}::uuid and lead_id = ${leadId}::uuid and status in ('queued', 'approved', 'draft')`;
      await tx`
        update leads set stage = 'do_not_contact', stage_changed_at = now(), updated_at = now()
        where workspace_id = ${workspaceId}::uuid and id = ${leadId}::uuid and stage <> 'do_not_contact'`;
      await tx`
        insert into suppressions (workspace_id, kind, value, reason, created_by)
        values (${workspaceId}::uuid, 'email', ${email.toLowerCase().trim()}, 'unsubscribed', null)
        on conflict (workspace_id, kind, value) do nothing`;
      await tx`
        insert into activities (workspace_id, lead_id, type, channel, summary, actor)
        values (${workspaceId}::uuid, ${leadId}::uuid, 'status_change', 'email', ${`${why}: suppressed on every channel`}, 'system')`;
    });
    void campaignId;
  }

  async setStage(workspaceId: string, leadId: string, stage: string) {
    await this.sql`
      update leads set stage = ${stage}, stage_changed_at = now(), updated_at = now()
      where workspace_id = ${workspaceId}::uuid and id = ${leadId}::uuid and stage <> ${stage}`;
  }

  async saveReply(workspaceId: string, campaignId: string, leadId: string, eventId: string, r: {
    body: string; subject: string | null; classification: string; confidence: number; summary: string;
    suggested: string | null; url: string | null; by: 'ai' | null;
    answer?: string | null; answerStatus?: 'none' | 'draft' | 'approved'; bookingUrl?: string | null; replyTo?: string | null; account?: string | null;
    channel?: 'email' | 'sms' | 'whatsapp';
  }) {
    const channel = r.channel ?? 'email';
    await this.sql.begin(async (tx) => {
      const rows = await tx`
        insert into replies (workspace_id, lead_id, campaign_id, inbound_event_id, channel, body, subject, classification, confidence, summary,
                             suggested_response, conversation_url, answer, answer_status, booking_url, provider_email_id, email_account)
        values (${workspaceId}::uuid, ${leadId}::uuid, ${campaignId}::uuid, ${eventId}::uuid, ${channel}, ${r.body}, ${r.subject}, ${r.classification},
                ${Math.round(r.confidence * 1000) / 1000}, ${r.summary}, ${r.suggested}, ${r.url}, ${r.answer ?? null}, ${r.answerStatus ?? 'none'},
                ${r.bookingUrl ?? null}, ${r.replyTo ?? null}, ${r.account ?? null})
        on conflict (inbound_event_id) where inbound_event_id is not null do nothing
        returning id`;
      if (!rows.length) return;
      await tx`
        insert into activities (workspace_id, lead_id, type, channel, summary, actor, record_table, record_id)
        values (${workspaceId}::uuid, ${leadId}::uuid, 'reply', ${channel}, ${`Replied${channel === 'email' ? '' : channel === 'sms' ? ' by text' : ' on WhatsApp'} (${r.classification.replace(/_/g, ' ')}): ${r.summary}`.slice(0, 500)}, 'ai', 'replies', ${rows[0].id}::uuid)`;
    });
  }

  async addFollowUp(workspaceId: string, leadId: string, days: number) {
    await this.sql`
      insert into follow_ups (workspace_id, lead_id, channel, due_at)
      values (${workspaceId}::uuid, ${leadId}::uuid, 'email', now() + make_interval(days => ${days}))`;
  }

  // ---------------------------------------------------------------- answers and meetings

  async approvedAnswers(workspaceId: string, campaignId: string, limit: number) {
    return (await this.sql`
      select r.id, r.lead_id, r.answer, r.subject, r.provider_email_id, r.email_account, l.stage, r.channel, l.phone, r.created_at,
             app.is_suppressed(l.workspace_id, l.email, l.phone) as suppressed,
             case when l.stage in ('new', 'contacted') then 'engaged' else l.stage end as lead_stage_after
      from replies r join leads l on l.workspace_id = r.workspace_id and l.id = r.lead_id
      where r.workspace_id = ${workspaceId}::uuid and r.campaign_id = ${campaignId}::uuid and r.answer_status = 'approved'
      order by r.created_at limit ${limit}`) as unknown as {
        id: string; lead_id: string; answer: string; subject: string | null; provider_email_id: string | null; email_account: string | null;
        stage: string; suppressed: boolean; lead_stage_after: string; channel: 'email' | 'sms' | 'whatsapp' | 'linkedin'; phone: string | null; created_at: Date | string;
      }[];
  }

  /** Moves an answer to "sending" only if nobody else did; protects against double sends. */
  async claimAnswer(workspaceId: string, id: string): Promise<boolean> {
    const rows = await this.sql`update replies set answer_status = 'sending' where workspace_id = ${workspaceId}::uuid and id = ${id}::uuid and answer_status = 'approved' returning id`;
    return rows.length === 1;
  }

  async setAnswerStatus(workspaceId: string, id: string, status: 'failed', error: string) {
    await this.sql`update replies set answer_status = ${status}, answer_error = ${error} where workspace_id = ${workspaceId}::uuid and id = ${id}::uuid`;
  }

  async answerSent(workspaceId: string, id: string, leadId: string, stage: string, channel: 'email' | 'sms' | 'whatsapp' = 'email') {
    await this.sql.begin(async (tx) => {
      await tx`update replies set answer_status = 'sent', answer_error = null, answered_at = now(), handled_at = coalesce(handled_at, now()), handled_by = coalesce(handled_by, 'ai') where workspace_id = ${workspaceId}::uuid and id = ${id}::uuid`;
      await tx`update leads set stage = ${stage}, stage_changed_at = now(), updated_at = now() where workspace_id = ${workspaceId}::uuid and id = ${leadId}::uuid and stage <> ${stage}`;
      await tx`insert into activities (workspace_id, lead_id, type, channel, summary, actor) values (${workspaceId}::uuid, ${leadId}::uuid, ${channel}, ${channel},
        ${channel === 'email' ? 'Answered the reply in the same email thread' : channel === 'sms' ? 'Answered the text by SMS' : 'Answered the message on WhatsApp'}, 'ai')`;
    });
  }

  async webhookToken(workspaceId: string): Promise<string | null> {
    const rows = await this.sql`select webhook_token from workspaces where id = ${workspaceId}::uuid`;
    return rows[0]?.webhook_token ?? null;
  }

  async calendlySubscription(workspaceId: string): Promise<{ user_uri: string; signing_key: string } | null> {
    const rows = await this.sql`select user_uri, signing_key from calendly_subscriptions where workspace_id = ${workspaceId}::uuid`;
    return (rows[0] ?? null) as { user_uri: string; signing_key: string } | null;
  }

  async saveCalendlySubscription(workspaceId: string, uri: string, user: string, org: string, key: string) {
    await this.sql`
      insert into calendly_subscriptions (workspace_id, subscription_uri, user_uri, organization_uri, signing_key)
      values (${workspaceId}::uuid, ${uri}, ${user}, ${org}, ${key})
      on conflict (workspace_id) do update set subscription_uri = excluded.subscription_uri, user_uri = excluded.user_uri,
        organization_uri = excluded.organization_uri, signing_key = excluded.signing_key`;
  }

  async leadById(workspaceId: string, id: string) {
    const rows = await this.sql`
      select l.id, l.email, l.full_name, l.stage, l.phone, c.name as company_name
      from leads l left join companies c on c.workspace_id = l.workspace_id and c.id = l.company_id
      where l.workspace_id = ${workspaceId}::uuid and l.id = ${id}::uuid`;
    return (rows[0] ?? null) as { id: string; email: string; full_name: string | null; stage: string; phone: string | null; company_name: string | null } | null;
  }

  /** Records a booking once; returns the meeting id when it is new. */
  async saveMeeting(workspaceId: string, leadId: string, m: {
    externalId: string; startsAt: string; endsAt: string | null; eventName: string | null; inviteeName: string | null;
    inviteeEmail: string | null; joinUrl: string | null; cancelUrl: string | null; rescheduleUrl: string | null;
  }): Promise<string | null> {
    return this.sql.begin(async (tx) => {
      const rows = await tx`
        insert into meetings (workspace_id, lead_id, campaign_id, starts_at, ends_at, zoom_url, booked_via, run_by, status, provider, external_id,
                              event_name, invitee_name, invitee_email, cancel_url, reschedule_url)
        select ${workspaceId}::uuid, l.id, l.campaign_id, ${m.startsAt}::timestamptz, ${m.endsAt}::timestamptz, ${m.joinUrl}, 'calendly',
               case when w.ai_closer_enabled then 'ai_closer' else 'human' end, 'scheduled', 'calendly', ${m.externalId},
               ${m.eventName}, ${m.inviteeName}, ${m.inviteeEmail}, ${m.cancelUrl}, ${m.rescheduleUrl}
        from leads l join workspaces w on w.id = l.workspace_id
        where l.workspace_id = ${workspaceId}::uuid and l.id = ${leadId}::uuid
        on conflict (workspace_id, provider, external_id) where external_id is not null do nothing
        returning id`;
      if (!rows.length) return null;
      await tx`
        update leads set stage = 'meeting_booked', stage_changed_at = now(), updated_at = now()
        where workspace_id = ${workspaceId}::uuid and id = ${leadId}::uuid and stage not in ('meeting_booked', 'won', 'do_not_contact')`;
      await tx`
        insert into activities (workspace_id, lead_id, type, channel, summary, actor, record_table, record_id)
        values (${workspaceId}::uuid, ${leadId}::uuid, 'meeting', 'email', ${`Meeting booked for ${new Date(m.startsAt).toUTCString()}`}, 'system', 'meetings', ${rows[0].id}::uuid)`;
      return rows[0].id as string;
    });
  }

  async cancelMeeting(workspaceId: string, externalId: string, leadId: string) {
    await this.sql.begin(async (tx) => {
      const rows = await tx`
        update meetings set status = 'canceled', updated_at = now()
        where workspace_id = ${workspaceId}::uuid and provider = 'calendly' and external_id = ${externalId} and status = 'scheduled' returning id`;
      if (!rows.length) return;
      // Back to interested unless another meeting is still booked
      await tx`
        update leads set stage = 'interested', stage_changed_at = now(), updated_at = now()
        where workspace_id = ${workspaceId}::uuid and id = ${leadId}::uuid and stage = 'meeting_booked'
          and not exists (select 1 from meetings m where m.workspace_id = ${workspaceId}::uuid and m.lead_id = ${leadId}::uuid and m.status = 'scheduled')`;
      await tx`
        insert into activities (workspace_id, lead_id, type, channel, summary, actor, record_table, record_id)
        values (${workspaceId}::uuid, ${leadId}::uuid, 'meeting', 'email', 'Meeting cancelled by the prospect', 'system', 'meetings', ${rows[0].id}::uuid)`;
    });
  }

  // ---------------------------------------------------------------- calls

  async callsToday(workspaceId: string, campaignId: string): Promise<number> {
    const rows = await this.sql`
      select count(*)::int n from calls where workspace_id = ${workspaceId}::uuid and campaign_id = ${campaignId}::uuid
        and direction = 'outbound' and created_at >= date_trunc('day', now())`;
    return rows[0].n as number;
  }

  /** Qualified leads not yet in a conversation, with their call attempts so far. */
  async callableLeads(workspaceId: string, campaignId: string, threshold: number, maxAttempts: number, limit: number) {
    return (await this.sql`
      select l.id, l.full_name, l.title, l.phone, l.phone_line_type, l.consent, c.name as company_name, l.ai_report,
             count(k.id)::int as attempts, max(k.created_at) as last_call_at,
             app.is_suppressed(l.workspace_id, l.email, l.phone) as suppressed
      from leads l
      left join companies c on c.workspace_id = l.workspace_id and c.id = l.company_id
      left join calls k on k.workspace_id = l.workspace_id and k.lead_id = l.id and k.direction = 'outbound'
      where l.workspace_id = ${workspaceId}::uuid and l.campaign_id = ${campaignId}::uuid
        and l.stage in ('new', 'contacted') and l.score >= ${threshold}
        and l.phone is not null and l.phone_checked_at is not null and coalesce(l.phone_line_type, 'unknown') <> 'unknown'
        and not exists (select 1 from calls d where d.workspace_id = l.workspace_id and d.lead_id = l.id
                          and d.outcome in ('interested', 'callback', 'not_interested', 'wrong_number', 'do_not_call', 'booked'))
        and not exists (select 1 from calls q where q.workspace_id = l.workspace_id and q.lead_id = l.id and q.status in ('queued', 'ringing', 'in_progress'))
      group by l.id, c.name
      having count(k.id) < ${maxAttempts}
      order by count(k.id), l.score desc, l.created_at
      limit ${limit}`) as unknown as import('./voice.ts').CallLead[];
  }

  async insertCall(workspaceId: string, campaignId: string, leadId: string, phone: string, attempt: number, basis: string): Promise<string | null> {
    const rows = await this.sql`
      insert into calls (workspace_id, lead_id, campaign_id, agent, direction, to_number, provider, status, attempt, idempotency_key, analysis)
      values (${workspaceId}::uuid, ${leadId}::uuid, ${campaignId}::uuid, 'caller', 'outbound', ${phone}, 'vapi', 'queued', ${attempt},
              ${`${campaignId}:${leadId}:call:${attempt}`}, ${this.sql.json({ consent_basis: basis })})
      on conflict (workspace_id, idempotency_key) do nothing
      returning id`;
    return rows[0]?.id ?? null;
  }

  async callStarted(workspaceId: string, id: string, providerId: string) {
    await this.sql`update calls set provider_call_id = ${providerId}, status = 'ringing', started_at = now() where workspace_id = ${workspaceId}::uuid and id = ${id}::uuid`;
  }

  async callFailed(workspaceId: string, id: string, error: string) {
    await this.sql`update calls set status = 'failed', outcome = 'failed', error = ${error}, ended_at = now() where workspace_id = ${workspaceId}::uuid and id = ${id}::uuid`;
  }

  async callByProviderId(workspaceId: string, providerId: string): Promise<{ id: string; lead_id: string; campaign_id: string | null } | null> {
    const rows = await this.sql`select id, lead_id, campaign_id from calls where workspace_id = ${workspaceId}::uuid and provider = 'vapi' and provider_call_id = ${providerId}`;
    return (rows[0] ?? null) as { id: string; lead_id: string; campaign_id: string | null } | null;
  }

  async callStatus(workspaceId: string, id: string, status: 'ringing' | 'in_progress') {
    await this.sql`update calls set status = ${status} where workspace_id = ${workspaceId}::uuid and id = ${id}::uuid and status in ('queued', 'ringing')`;
  }

  /** Stores the call result and applies it to the lead. Returns the lead for alerts. */
  async finishCall(workspaceId: string, callId: string, r: {
    outcome: string; meeting: boolean; summary: string | null; transcript: string | null; recordingUrl: string | null; duration: number | null;
    endedReason: string | null; endedAt: string | null; startedAt: string | null; analysis: Record<string, unknown>; callbackTime: string | null;
  }): Promise<{ id: string; name: string } | null> {
    return this.sql.begin(async (tx) => {
      const rows = await tx`
        update calls set status = 'ended', outcome = ${r.outcome}, summary = ${r.summary}, transcript = ${r.transcript}, recording_url = ${r.recordingUrl},
          duration_seconds = ${r.duration}, ended_reason = ${r.endedReason}, ended_at = coalesce(${r.endedAt}::timestamptz, now()),
          started_at = coalesce(${r.startedAt}::timestamptz, started_at),
          analysis = coalesce(analysis, '{}'::jsonb) || ${tx.json(r.analysis as postgres.JSONValue)}
        where workspace_id = ${workspaceId}::uuid and id = ${callId}::uuid
        returning lead_id`;
      if (!rows.length) return null;
      const leadId = rows[0].lead_id as string;
      const leads = await tx`select id, stage, phone, email, coalesce(full_name, email, phone) as name from leads where workspace_id = ${workspaceId}::uuid and id = ${leadId}::uuid`;
      const lead = leads[0];
      const label = r.outcome.replace(/_/g, ' ');
      await tx`
        insert into activities (workspace_id, lead_id, type, channel, summary, actor, record_table, record_id)
        values (${workspaceId}::uuid, ${leadId}::uuid, 'call', 'voice',
                ${`AI call: ${r.meeting ? 'wants a meeting' : label}${r.duration ? ` (${Math.round(r.duration / 60 * 10) / 10} min)` : ''}${r.summary ? `. ${r.summary}` : ''}`.slice(0, 500)},
                'ai', 'calls', ${callId}::uuid)`;
      const setStage = async (target: string) => {
        const next = nextStage(String(lead.stage), target);
        if (next !== lead.stage) await tx`update leads set stage = ${next}, stage_changed_at = now(), updated_at = now() where workspace_id = ${workspaceId}::uuid and id = ${leadId}::uuid`;
      };
      if (r.outcome === 'do_not_call') {
        if (lead.phone) {
          await tx`insert into suppressions (workspace_id, kind, value, reason, created_by) values (${workspaceId}::uuid, 'phone', ${String(lead.phone).toLowerCase().trim()}, 'do_not_call', null) on conflict (workspace_id, kind, value) do nothing`;
        }
        await tx`update emails set status = 'cancelled' where workspace_id = ${workspaceId}::uuid and lead_id = ${leadId}::uuid and status in ('queued', 'approved', 'draft')`;
        await setStage('do_not_contact');
      } else if (r.outcome === 'interested') {
        await setStage('interested');
        await tx`insert into follow_ups (workspace_id, lead_id, channel, due_at) values (${workspaceId}::uuid, ${leadId}::uuid, 'manual', now())`;
      } else if (r.outcome === 'callback') {
        await setStage('engaged');
        const t = r.callbackTime && !Number.isNaN(Date.parse(r.callbackTime)) ? new Date(r.callbackTime) : null;
        const due = t && t.getTime() > Date.now() && t.getTime() < Date.now() + 60 * 86_400_000 ? t : new Date(Date.now() + 86_400_000);
        await tx`insert into follow_ups (workspace_id, lead_id, channel, due_at) values (${workspaceId}::uuid, ${leadId}::uuid, 'voice', ${due})`;
      } else if (r.outcome === 'not_interested') {
        await setStage('not_interested');
      } else if (r.outcome === 'wrong_number') {
        await tx`update leads set phone_line_type = 'unknown', updated_at = now() where workspace_id = ${workspaceId}::uuid and id = ${leadId}::uuid`;
      }
      return { id: leadId, name: String(lead.name) };
    });
  }

  // ---------------------------------------------------------------- texts

  async messagesToday(workspaceId: string, campaignId: string): Promise<number> {
    const rows = await this.sql`
      select count(*)::int n from messages where workspace_id = ${workspaceId}::uuid and campaign_id = ${campaignId}::uuid
        and direction = 'outbound' and provider = 'twilio' and step is not null and created_at >= date_trunc('day', now())`;
    return rows[0].n as number;
  }

  /**
   * Leads who were emailed or called, have not answered on any channel, and are
   * due a text: the last touch was at least `afterDays` ago and fewer than
   * `maxMessages` follow-up texts went out.
   */
  async textableLeads(workspaceId: string, campaignId: string, channel: 'sms' | 'whatsapp', threshold: number, afterDays: number, maxMessages: number, limit: number) {
    return (await this.sql`
      with touches as (
        select l.id,
               (select max(e.sent_at) from emails e where e.workspace_id = l.workspace_id and e.lead_id = l.id and e.status = 'sent') as last_email,
               (select max(k.created_at) from calls k where k.workspace_id = l.workspace_id and k.lead_id = l.id and k.direction = 'outbound') as last_call,
               (select max(m.created_at) from messages m where m.workspace_id = l.workspace_id and m.lead_id = l.id and m.direction = 'outbound') as last_text,
               (select count(*)::int from messages m where m.workspace_id = l.workspace_id and m.lead_id = l.id and m.direction = 'outbound'
                  and m.campaign_id = ${campaignId}::uuid and m.channel = ${channel} and m.step is not null) as sent
        from leads l
        where l.workspace_id = ${workspaceId}::uuid and l.campaign_id = ${campaignId}::uuid
          and l.stage in ('new', 'contacted') and l.score >= ${threshold}
          and l.phone is not null and l.phone_checked_at is not null
      )
      select l.id, l.full_name, l.email, l.phone, l.phone_line_type, l.consent, c.name as company_name, l.ai_report, t.sent,
             greatest(t.last_email, t.last_call, t.last_text) as last_touch_at,
             app.is_suppressed(l.workspace_id, l.email, l.phone) as suppressed
      from touches t
      join leads l on l.workspace_id = ${workspaceId}::uuid and l.id = t.id
      left join companies c on c.workspace_id = l.workspace_id and c.id = l.company_id
      where coalesce(t.last_email, t.last_call) is not null
        and t.sent < ${maxMessages}
        and greatest(t.last_email, t.last_call, t.last_text) < now() - make_interval(days => ${afterDays})
        and not exists (select 1 from replies r where r.workspace_id = l.workspace_id and r.lead_id = l.id)
        and not exists (select 1 from messages i where i.workspace_id = l.workspace_id and i.lead_id = l.id and i.direction = 'inbound')
        and not exists (select 1 from calls d where d.workspace_id = l.workspace_id and d.lead_id = l.id
                          and (d.outcome in ('interested', 'callback', 'not_interested', 'wrong_number', 'do_not_call', 'booked')
                               or d.status in ('queued', 'ringing', 'in_progress')))
      order by t.sent, l.score desc, l.created_at
      limit ${limit}`) as unknown as import('./texting.ts').TextLead[];
  }

  async insertText(workspaceId: string, campaignId: string | null, leadId: string, m: {
    channel: 'sms' | 'whatsapp'; body: string; template: string | null; to: string; from: string; step: number | null; basis: string | null; key: string;
  }): Promise<string | null> {
    const rows = await this.sql`
      insert into messages (workspace_id, lead_id, campaign_id, channel, direction, body, template, delivery_status, provider, step,
                            to_number, from_number, consent_basis, idempotency_key)
      values (${workspaceId}::uuid, ${leadId}::uuid, ${campaignId}, ${m.channel}, 'outbound', ${m.body.slice(0, 2000)}, ${m.template}, 'queued', 'twilio',
              ${m.step}, ${m.to}, ${m.from}, ${m.basis}, ${m.key})
      on conflict (workspace_id, idempotency_key) do nothing
      returning id`;
    return rows[0]?.id ?? null;
  }

  async textSent(workspaceId: string, id: string, leadId: string, sid: string, summary: string, channel: 'sms' | 'whatsapp') {
    await this.sql.begin(async (tx) => {
      await tx`update messages set provider_message_id = ${sid}, sent_at = now() where workspace_id = ${workspaceId}::uuid and id = ${id}::uuid`;
      await tx`update leads set stage = 'contacted', stage_changed_at = now(), updated_at = now() where workspace_id = ${workspaceId}::uuid and id = ${leadId}::uuid and stage = 'new'`;
      await tx`
        insert into activities (workspace_id, lead_id, type, channel, summary, actor, record_table, record_id)
        values (${workspaceId}::uuid, ${leadId}::uuid, ${channel}, ${channel}, ${summary.slice(0, 500)}, 'ai', 'messages', ${id}::uuid)`;
    });
  }

  async textFailed(workspaceId: string, id: string, error: string, code: string | null) {
    await this.sql`update messages set delivery_status = 'failed', error = ${error.slice(0, 400)}, error_code = ${code} where workspace_id = ${workspaceId}::uuid and id = ${id}::uuid`;
  }

  async textByProviderId(workspaceId: string, sid: string): Promise<{ id: string; lead_id: string; campaign_id: string | null; delivery_status: string } | null> {
    const rows = await this.sql`select id, lead_id, campaign_id, delivery_status from messages where workspace_id = ${workspaceId}::uuid and provider = 'twilio' and provider_message_id = ${sid}`;
    return (rows[0] ?? null) as { id: string; lead_id: string; campaign_id: string | null; delivery_status: string } | null;
  }

  /** Delivery updates only move forward: queued, sent, delivered, read; failures are final. */
  async textStatus(workspaceId: string, id: string, status: 'sent' | 'delivered' | 'read' | 'failed', error: string | null, code: string | null) {
    await this.sql`
      update messages set delivery_status = ${status},
        delivered_at = case when ${status} in ('delivered', 'read') then coalesce(delivered_at, now()) else delivered_at end,
        error = case when ${status} = 'failed' then ${error} else error end,
        error_code = case when ${status} = 'failed' then ${code} else error_code end
      where workspace_id = ${workspaceId}::uuid and id = ${id}::uuid
        and delivery_status <> 'failed'
        and (array_position(array['queued', 'sent', 'delivered', 'read'], ${status}) is null
             or array_position(array['queued', 'sent', 'delivered', 'read'], ${status}) > array_position(array['queued', 'sent', 'delivered', 'read'], delivery_status))`;
  }

  /** The lead a text came from: the most recently contacted lead with that number. */
  async leadByPhone(workspaceId: string, phone: string) {
    const rows = await this.sql`
      select l.id, l.email, l.full_name, l.stage, l.phone, l.campaign_id, c.name as company_name,
             (select m.campaign_id from messages m where m.workspace_id = l.workspace_id and m.lead_id = l.id and m.direction = 'outbound'
                and m.campaign_id is not null order by m.created_at desc limit 1) as texted_campaign
      from leads l left join companies c on c.workspace_id = l.workspace_id and c.id = l.company_id
      where l.workspace_id = ${workspaceId}::uuid and l.phone = ${phone}
      order by (select max(m.created_at) from messages m where m.workspace_id = l.workspace_id and m.lead_id = l.id) desc nulls last, l.updated_at desc
      limit 1`;
    return (rows[0] ?? null) as {
      id: string; email: string | null; full_name: string | null; stage: string; phone: string; campaign_id: string | null;
      company_name: string | null; texted_campaign: string | null;
    } | null;
  }

  async recordInboundText(workspaceId: string, leadId: string, campaignId: string | null, channel: 'sms' | 'whatsapp', body: string, sid: string, from: string): Promise<boolean> {
    const rows = await this.sql`
      insert into messages (workspace_id, lead_id, campaign_id, channel, direction, body, delivery_status, provider, provider_message_id, from_number, idempotency_key, sent_at)
      values (${workspaceId}::uuid, ${leadId}::uuid, ${campaignId}, ${channel}, 'inbound', ${body.slice(0, 2000)}, 'received', 'twilio', ${sid}, ${from},
              ${`twilio:${sid}`}, now())
      on conflict (workspace_id, idempotency_key) do nothing
      returning id`;
    return rows.length === 1;
  }

  /** The prospect asked to stop by text: suppressed on every channel. */
  async textOptOut(workspaceId: string, leadId: string, phone: string | null, why: string, channel: 'sms' | 'whatsapp') {
    await this.sql.begin(async (tx) => {
      const leads = await tx`select email, phone from leads where workspace_id = ${workspaceId}::uuid and id = ${leadId}::uuid`;
      const email = leads[0]?.email as string | null | undefined;
      const number = phone ?? (leads[0]?.phone as string | null | undefined) ?? null;
      if (number) {
        await tx`insert into suppressions (workspace_id, kind, value, reason, created_by) values (${workspaceId}::uuid, 'phone', ${number.trim()}, 'unsubscribed', null) on conflict (workspace_id, kind, value) do nothing`;
      }
      if (email) {
        await tx`insert into suppressions (workspace_id, kind, value, reason, created_by) values (${workspaceId}::uuid, 'email', ${email.toLowerCase().trim()}, 'unsubscribed', null) on conflict (workspace_id, kind, value) do nothing`;
      }
      await tx`update emails set status = 'cancelled' where workspace_id = ${workspaceId}::uuid and lead_id = ${leadId}::uuid and status in ('queued', 'approved', 'draft')`;
      await tx`update replies set answer_status = 'failed', answer_error = 'The lead asked not to be contacted' where workspace_id = ${workspaceId}::uuid and lead_id = ${leadId}::uuid and answer_status in ('draft', 'approved')`;
      await tx`update leads set stage = 'do_not_contact', stage_changed_at = now(), updated_at = now() where workspace_id = ${workspaceId}::uuid and id = ${leadId}::uuid and stage <> 'do_not_contact'`;
      await tx`
        insert into activities (workspace_id, lead_id, type, channel, summary, actor)
        values (${workspaceId}::uuid, ${leadId}::uuid, 'status_change', ${channel}, ${`${why}: suppressed on every channel`.slice(0, 500)}, 'system')`;
    });
  }

  async slackChannel(workspaceId: string): Promise<string | null> {
    const rows = await this.sql`select slack_channel from workspaces where id = ${workspaceId}::uuid`;
    return rows[0]?.slack_channel ?? null;
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
  clay: 'Clay', facebook: 'Facebook', linkedin: 'LinkedIn', tiktok: 'TikTok', x: 'X', csv: 'CSV import',
  inbound_call: 'an inbound call', manual: 'manual entry',
};

export type InboundEvent = { id: string; provider?: string; event_type: string; lead_email: string | null; payload: Record<string, unknown> };

export type ReadySequence = {
  lead_id: string; email: string; full_name: string | null; title: string | null; company_name: string; domain: string | null;
  emails: { id: string; step: number; subject: string; body: string }[];
};

export type ResearchLead = {
  id: string; full_name: string | null; title: string | null; email: string | null; phone: string | null;
  verification_status: string; phone_line_type: string | null; social_handles: Record<string, string> | null;
  company_id: string; company_name: string; company_domain: string | null; company_location: string | null;
  company_industry: string | null; company_research: unknown; company_researched_at: string | Date | null;
};

export type PendingCompany = {
  id: string; name: string; domain: string | null; location: string | null; industry: string | null;
  size_band: string | null; source_channel: LeadCandidate['source'] | null;
};

const VERDICT_LABELS: Record<string, string> = { valid: 'valid', invalid: 'invalid', catch_all: 'catch-all', risky: 'risky' };

function uniq(values: (string | undefined)[]): string[] {
  return [...new Set(values.filter((v): v is string => Boolean(v)))];
}
