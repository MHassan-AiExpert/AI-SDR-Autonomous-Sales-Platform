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
  type: 'campaign_plan' | 'lead_sourcing' | 'enrichment' | 'research' | 'copywriting' | 'email_outreach' | 'reply_handling' | 'reply_send' | 'voice_outreach' | 'sms_outreach' | 'ai_closer' | 'audit_reports' | 'learning' | 'crm_sync' | 'sequence';
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
  branching_enabled: boolean;
  open_tracking: boolean;
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
  vapi_closer_assistant_id: string | null;
  audit_enabled: boolean;
  learned_guidance: string[];
  learning_auto_apply: boolean;
};

export type ReceptionistCampaign = {
  id: string; name: string; status: string; receptionist_status: string; vapi_receptionist_assistant_id: string | null;
  vapi_inbound_number_id: string; receptionist_transfer_number: string | null; receptionist_notes: string | null;
  sms_from: string | null; booking_event_type: string | null; sender_name: string | null; offer: string | null;
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
             send_window_end, send_days, daily_send_limit, follow_up_count, follow_up_delay_days, branching_enabled, open_tracking, instantly_campaign_id, instantly_state,
             auto_answer, booking_event_type, voice_status, vapi_assistant_id, vapi_phone_number_id, call_timezone, call_window_start,
             call_window_end, call_days, call_daily_limit, call_max_attempts, call_rule, dnc_attested_at, sms_status, sms_channel, sms_from,
             whatsapp_from, whatsapp_content_sid, sms_after_days, sms_daily_limit, sms_max_messages, vapi_closer_assistant_id, audit_enabled, learned_guidance, learning_auto_apply
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

  async enqueue(workspaceId: string, campaignId: string, type: 'enrichment' | 'lead_sourcing' | 'research' | 'copywriting' | 'email_outreach' | 'reply_handling' | 'reply_send' | 'voice_outreach' | 'sms_outreach' | 'ai_closer' | 'audit_reports' | 'learning' | 'crm_sync' | 'sequence'): Promise<boolean> {
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

  async workspaceState(workspaceId: string): Promise<{ name: string; outreach_paused: boolean; enabled_channels: Record<string, boolean>; ai_closer_enabled: boolean }> {
    const rows = await this.sql`select name, outreach_paused, enabled_channels, ai_closer_enabled from workspaces where id = ${workspaceId}::uuid`;
    return {
      name: String(rows[0]?.name ?? ''), outreach_paused: rows[0]?.outreach_paused === true,
      enabled_channels: (rows[0]?.enabled_channels ?? {}) as Record<string, boolean>, ai_closer_enabled: rows[0]?.ai_closer_enabled === true,
    };
  }

  async activePlaybook(workspaceId: string): Promise<unknown> {
    const rows = await this.sql`select content from playbooks where workspace_id = ${workspaceId}::uuid and is_active limit 1`;
    return rows[0]?.content ?? null;
  }

  /** Qualified, verified, uncontacted leads that have no emails in this campaign yet. */
  async leadsToWrite(workspaceId: string, campaignId: string, threshold: number, limit: number, waitForAudit = false) {
    return (await this.sql`
      select l.id, l.full_name, l.title, l.email, coalesce(c.name, 'your company') as company_name, l.ai_report,
             (select a.share_token from assets a where a.workspace_id = l.workspace_id and a.lead_id = l.id and a.campaign_id = ${campaignId}::uuid
                and a.type = 'audit' and a.status = 'ready' and a.expires_at > now() + interval '30 days') as audit_token
      from leads l
      left join companies c on c.workspace_id = l.workspace_id and c.id = l.company_id
      where l.workspace_id = ${workspaceId}::uuid and l.campaign_id = ${campaignId}::uuid
        and l.stage = 'new' and l.email is not null and l.verification_status = 'valid'
        and l.score >= ${threshold} and l.researched_at is not null
        and not app.is_suppressed(l.workspace_id, l.email, l.phone)
        and not exists (select 1 from emails e where e.workspace_id = l.workspace_id and e.lead_id = l.id and e.campaign_id = ${campaignId}::uuid)
        -- With audits on, a lead is written to once its audit has been tried
        and (not ${waitForAudit} or exists (select 1 from assets a where a.workspace_id = l.workspace_id and a.lead_id = l.id
                                              and a.campaign_id = ${campaignId}::uuid and a.type = 'audit'))
      order by l.score desc, l.created_at
      limit ${limit}`) as unknown as { id: string; full_name: string | null; title: string | null; email: string; company_name: string; ai_report: Record<string, unknown> | null; audit_token: string | null }[];
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

  async insertInboundEvent(workspaceId: string, campaignId: string | null, type: string, leadEmail: string | null, payload: Record<string, unknown>, dedupe: string, status: 'received' | 'ignored', provider: 'instantly' | 'calendly' | 'vapi' | 'twilio' | 'stripe' = 'instantly'): Promise<string | null> {
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
    inviteeEmail: string | null; joinUrl: string | null; cancelUrl: string | null; rescheduleUrl: string | null; phone?: string | null;
  }): Promise<string | null> {
    return this.sql.begin(async (tx) => {
      const rows = await tx`
        insert into meetings (workspace_id, lead_id, campaign_id, starts_at, ends_at, zoom_url, booked_via, run_by, status, provider, external_id,
                              event_name, invitee_name, invitee_email, cancel_url, reschedule_url, phone)
        select ${workspaceId}::uuid, l.id, l.campaign_id, ${m.startsAt}::timestamptz, ${m.endsAt}::timestamptz, ${m.joinUrl}, 'calendly',
               case when w.ai_closer_enabled then 'ai_closer' else 'human' end, 'scheduled', 'calendly', ${m.externalId},
               ${m.eventName}, ${m.inviteeName}, ${m.inviteeEmail}, ${m.cancelUrl}, ${m.rescheduleUrl}, ${m.phone ?? null}
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

  async insertCall(workspaceId: string, campaignId: string, leadId: string, phone: string, attempt: number, basis: string, agent: 'caller' | 'closer' = 'caller', key?: string): Promise<string | null> {
    const rows = await this.sql`
      insert into calls (workspace_id, lead_id, campaign_id, agent, direction, to_number, provider, status, attempt, idempotency_key, analysis)
      values (${workspaceId}::uuid, ${leadId}::uuid, ${campaignId}::uuid, ${agent}, 'outbound', ${phone}, 'vapi', 'queued', ${attempt},
              ${key ?? `${campaignId}:${leadId}:call:${attempt}`}, ${this.sql.json({ consent_basis: basis })})
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

  async callByProviderId(workspaceId: string, providerId: string): Promise<{ id: string; lead_id: string; campaign_id: string | null; agent: string } | null> {
    const rows = await this.sql`select id, lead_id, campaign_id, agent from calls where workspace_id = ${workspaceId}::uuid and provider = 'vapi' and provider_call_id = ${providerId}`;
    return (rows[0] ?? null) as { id: string; lead_id: string; campaign_id: string | null; agent: string } | null;
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

  // ---------------------------------------------------------------- AI closer

  async activePlaybookRow(workspaceId: string): Promise<{ version: number; content: unknown } | null> {
    const rows = await this.sql`select version, content from playbooks where workspace_id = ${workspaceId}::uuid and is_active limit 1`;
    return (rows[0] ?? null) as { version: number; content: unknown } | null;
  }

  /** AI-run meetings that start within a minute or started in the last 15 minutes. */
  async closerMeetings(workspaceId: string, campaignId: string) {
    return (await this.sql`
      select m.id, m.lead_id, m.starts_at, m.zoom_url, m.phone as meeting_phone, m.event_name, m.invitee_name, m.invitee_email,
             l.full_name, l.email, l.phone, l.phone_checked_at, l.consent, l.stage, l.ai_report, c.name as company_name,
             app.is_suppressed(l.workspace_id, l.email, coalesce(m.phone, l.phone)) as suppressed
      from meetings m
      join leads l on l.workspace_id = m.workspace_id and l.id = m.lead_id
      left join companies c on c.workspace_id = l.workspace_id and c.id = l.company_id
      where m.workspace_id = ${workspaceId}::uuid and m.campaign_id = ${campaignId}::uuid
        and m.status = 'scheduled' and m.run_by = 'ai_closer' and m.closer_status = 'pending'
        and m.starts_at <= now() + interval '1 minute' and m.starts_at > now() - interval '15 minutes'
      order by m.starts_at`) as unknown as import('./closer.ts').CloserMeeting[];
  }

  async meetingCalling(workspaceId: string, meetingId: string, callId: string): Promise<boolean> {
    const rows = await this.sql`
      update meetings set closer_status = 'calling', call_id = ${callId}::uuid, updated_at = now()
      where workspace_id = ${workspaceId}::uuid and id = ${meetingId}::uuid and closer_status = 'pending' returning id`;
    return rows.length === 1;
  }

  /** The team takes over a meeting: a task due at the meeting time, and the reason on the timeline. */
  async handOffMeeting(workspaceId: string, meetingId: string, leadId: string, reason: string, status: 'handed_off' | 'failed' = 'handed_off') {
    await this.sql.begin(async (tx) => {
      const rows = await tx`
        update meetings set closer_status = ${status}, run_by = 'human', closer_note = ${reason.slice(0, 400)}, updated_at = now()
        where workspace_id = ${workspaceId}::uuid and id = ${meetingId}::uuid and closer_status in ('pending', 'calling') returning starts_at`;
      if (!rows.length) return;
      await tx`insert into follow_ups (workspace_id, lead_id, channel, due_at) values (${workspaceId}::uuid, ${leadId}::uuid, 'manual', ${rows[0].starts_at})`;
      await tx`
        insert into activities (workspace_id, lead_id, type, channel, summary, actor, record_table, record_id)
        values (${workspaceId}::uuid, ${leadId}::uuid, 'meeting', 'voice', ${`Meeting handed to the team: ${reason}`.slice(0, 500)}, 'system', 'meetings', ${meetingId}::uuid)`;
    });
  }

  /** Stores the closer call result on the call, the meeting, the deal and the lead. */
  async finishCloserCall(workspaceId: string, callId: string, r: {
    outcome: import('./closer.ts').CloserOutcome; plan: import('./closer.ts').Plan | null; summary: string | null; transcript: string | null;
    recordingUrl: string | null; duration: number | null; endedReason: string | null; endedAt: string | null; startedAt: string | null;
    analysis: Record<string, unknown>; followUpTime: string | null; handoffReason: string | null;
  }): Promise<{ leadId: string; name: string; dealId: string | null; closePending: boolean; campaignId: string | null } | null> {
    return this.sql.begin(async (tx) => {
      const callOutcome: Record<string, string> = {
        agreed: 'interested', proposal_requested: 'interested', follow_up: 'callback', needs_human: 'interested',
        not_interested: 'not_interested', do_not_call: 'do_not_call', no_answer: 'no_answer', voicemail: 'voicemail',
      };
      const calls = await tx`
        update calls set status = 'ended', outcome = ${callOutcome[r.outcome] ?? 'no_answer'}, summary = ${r.summary}, transcript = ${r.transcript},
          recording_url = ${r.recordingUrl}, duration_seconds = ${r.duration}, ended_reason = ${r.endedReason},
          ended_at = coalesce(${r.endedAt}::timestamptz, now()), started_at = coalesce(${r.startedAt}::timestamptz, started_at),
          handed_off = ${r.outcome === 'needs_human'},
          analysis = coalesce(analysis, '{}'::jsonb) || ${tx.json({ ...r.analysis, closer_outcome: r.outcome } as postgres.JSONValue)}
        where workspace_id = ${workspaceId}::uuid and id = ${callId}::uuid
        returning lead_id, campaign_id`;
      if (!calls.length) return null;
      const leadId = calls[0].lead_id as string;
      const campaignId = (calls[0].campaign_id ?? null) as string | null;
      const lead = (await tx`select stage, phone, coalesce(full_name, email, phone) as name, source_channel from leads where workspace_id = ${workspaceId}::uuid and id = ${leadId}::uuid`)[0];
      const meetings = await tx`select id, phone from meetings where workspace_id = ${workspaceId}::uuid and call_id = ${callId}::uuid`;
      const meetingId = (meetings[0]?.id ?? null) as string | null;
      const held = r.outcome !== 'no_answer' && r.outcome !== 'voicemail';
      if (meetingId) {
        await tx`
          update meetings set status = ${held ? 'completed' : 'no_show'}, attended = ${held}, closer_status = ${held ? 'held' : 'no_answer'},
            summary = ${r.summary?.slice(0, 1200) ?? null}, transcript = ${r.transcript}, recording_url = ${r.recordingUrl},
            outcome = ${r.outcome}, closer_note = ${r.handoffReason?.slice(0, 400) ?? null}, updated_at = now()
          where workspace_id = ${workspaceId}::uuid and id = ${meetingId}::uuid`;
      }
      const setStage = async (target: string) => {
        const next = nextStage(String(lead.stage), target);
        if (next !== lead.stage) await tx`update leads set stage = ${next}, stage_changed_at = now(), updated_at = now() where workspace_id = ${workspaceId}::uuid and id = ${leadId}::uuid`;
      };
      const task = async (due: Date) => { await tx`insert into follow_ups (workspace_id, lead_id, channel, due_at) values (${workspaceId}::uuid, ${leadId}::uuid, 'manual', ${due})`; };

      let dealId: string | null = null;
      let closePending = false;
      if (held) {
        const agreed = r.outcome === 'agreed' || r.outcome === 'proposal_requested';
        const closeStatus = agreed ? (r.plan ? 'pending' : 'needs_team') : r.outcome === 'needs_human' ? 'needs_team' : 'none';
        const stage = r.outcome === 'not_interested' || r.outcome === 'do_not_call' ? 'lost' : 'meeting_held';
        const rows = await tx`
          insert into deals (workspace_id, lead_id, campaign_id, meeting_id, stage, value_cents, currency, plan_name, billing_interval, close_status, source_channel, lost_reason, closed_at, closed_by)
          values (${workspaceId}::uuid, ${leadId}::uuid, ${campaignId}, ${meetingId}, ${stage}, ${r.plan?.price_cents ?? null}, ${r.plan?.currency ?? 'USD'},
                  ${r.plan?.name ?? null}, ${r.plan?.interval ?? null}, ${closeStatus}, ${lead.source_channel ?? null},
                  ${stage === 'lost' ? (r.outcome === 'do_not_call' ? 'Asked not to be called' : 'Not interested after the meeting') : null},
                  ${stage === 'lost' ? new Date() : null}, ${stage === 'lost' ? 'ai' : null})
          on conflict (workspace_id, lead_id) do update set
            campaign_id = coalesce(excluded.campaign_id, deals.campaign_id), meeting_id = excluded.meeting_id,
            stage = case when deals.stage in ('won') then deals.stage else excluded.stage end,
            value_cents = coalesce(excluded.value_cents, deals.value_cents), currency = excluded.currency,
            plan_name = coalesce(excluded.plan_name, deals.plan_name), billing_interval = coalesce(excluded.billing_interval, deals.billing_interval),
            close_status = case when deals.close_status in ('sent', 'sending') then deals.close_status else excluded.close_status end,
            lost_reason = excluded.lost_reason, closed_at = coalesce(deals.closed_at, excluded.closed_at), closed_by = coalesce(deals.closed_by, excluded.closed_by),
            updated_at = now()
          returning id, close_status`;
        dealId = rows[0].id as string;
        closePending = rows[0].close_status === 'pending';
      }
      const minutes = r.duration ? ` (${Math.round(r.duration / 6) / 10} min)` : '';
      const labels: Record<string, string> = {
        agreed: `agreed to go ahead${r.plan ? ` with ${r.plan.name}` : ''}`, proposal_requested: `asked for the proposal${r.plan ? ` for ${r.plan.name}` : ''}`,
        follow_up: 'wants to talk again later', needs_human: 'needs your team', not_interested: 'not interested',
        do_not_call: 'asked not to be called', no_answer: 'did not answer', voicemail: 'reached voicemail',
      };
      await tx`
        insert into activities (workspace_id, lead_id, type, channel, summary, actor, record_table, record_id)
        values (${workspaceId}::uuid, ${leadId}::uuid, 'meeting', 'voice', ${`AI closer meeting: ${labels[r.outcome]}${minutes}${r.summary ? `. ${r.summary}` : ''}`.slice(0, 500)}, 'ai', 'calls', ${callId}::uuid)`;

      switch (r.outcome) {
        case 'agreed': case 'proposal_requested':
          if (!r.plan) await task(new Date());
          break;
        case 'needs_human':
          await task(new Date());
          break;
        case 'follow_up': {
          const t = r.followUpTime && !Number.isNaN(Date.parse(r.followUpTime)) ? new Date(r.followUpTime) : null;
          await task(t && t.getTime() > Date.now() && t.getTime() < Date.now() + 90 * 86_400_000 ? t : new Date(Date.now() + 2 * 86_400_000));
          break;
        }
        case 'not_interested':
          await setStage('not_interested');
          break;
        case 'do_not_call': {
          const phone = (meetings[0]?.phone ?? lead.phone) as string | null;
          if (phone) await tx`insert into suppressions (workspace_id, kind, value, reason, created_by) values (${workspaceId}::uuid, 'phone', ${phone.trim()}, 'do_not_call', null) on conflict (workspace_id, kind, value) do nothing`;
          await tx`update emails set status = 'cancelled' where workspace_id = ${workspaceId}::uuid and lead_id = ${leadId}::uuid and status in ('queued', 'approved', 'draft')`;
          await setStage('do_not_contact');
          break;
        }
        default:
          // No answer: the team reschedules
          await task(new Date());
      }
      return { leadId, name: String(lead.name), dealId, closePending, campaignId };
    });
  }

  async dealsToClose(workspaceId: string, campaignId: string, limit: number) {
    return (await this.sql`
      select d.id, d.lead_id, d.plan_name, d.value_cents, d.currency, d.billing_interval, d.stripe_payment_link_id, d.payment_url, d.close_attempts,
             l.full_name, l.email, l.stage, c.name as company_name,
             app.is_suppressed(l.workspace_id, l.email, l.phone) as suppressed
      from deals d
      join leads l on l.workspace_id = d.workspace_id and l.id = d.lead_id
      left join companies c on c.workspace_id = l.workspace_id and c.id = l.company_id
      where d.workspace_id = ${workspaceId}::uuid and d.campaign_id = ${campaignId}::uuid and d.close_status = 'pending'
      order by d.updated_at limit ${limit}`) as unknown as import('./closer.ts').DealToClose[];
  }

  async claimDeal(workspaceId: string, id: string): Promise<boolean> {
    const rows = await this.sql`
      update deals set close_status = 'sending', close_attempts = close_attempts + 1, updated_at = now()
      where workspace_id = ${workspaceId}::uuid and id = ${id}::uuid and close_status = 'pending' returning id`;
    return rows.length === 1;
  }

  async savePaymentLink(workspaceId: string, id: string, linkId: string, url: string) {
    await this.sql`update deals set stripe_payment_link_id = ${linkId}, payment_url = ${url}, updated_at = now() where workspace_id = ${workspaceId}::uuid and id = ${id}::uuid`;
  }

  /** Records how far closing got: everything sent, or handed to the team, or to be retried. */
  async dealClosed(workspaceId: string, id: string, leadId: string, r: {
    status: 'sent' | 'needs_team' | 'pending' | 'failed'; error: string | null; documentId?: string | null; activity: string;
  }) {
    await this.sql.begin(async (tx) => {
      const sent = r.status === 'sent';
      await tx`
        update deals set close_status = ${r.status}, close_error = ${r.error?.slice(0, 400) ?? null},
          pandadoc_document_id = coalesce(${r.documentId ?? null}, pandadoc_document_id),
          quote_url = case when ${r.documentId ?? null}::text is not null then ${r.documentId ? `https://app.pandadoc.com/a/#/documents/${r.documentId}` : null} else quote_url end,
          agreement_status = case when ${sent} then 'sent' else agreement_status end,
          payment_status = case when ${sent} and payment_url is not null and payment_status = 'none' then 'link_sent' else payment_status end,
          stage = case when ${sent} and stage in ('meeting_booked', 'meeting_held') then 'proposal_sent' else stage end,
          updated_at = now()
        where workspace_id = ${workspaceId}::uuid and id = ${id}::uuid`;
      if (r.status === 'needs_team' || r.status === 'failed') {
        await tx`insert into follow_ups (workspace_id, lead_id, channel, due_at) values (${workspaceId}::uuid, ${leadId}::uuid, 'manual', now())`;
      }
      if (r.activity) {
        await tx`
          insert into activities (workspace_id, lead_id, type, channel, summary, actor, record_table, record_id)
          values (${workspaceId}::uuid, ${leadId}::uuid, 'status_change', 'email', ${r.activity.slice(0, 500)}, 'ai', 'deals', ${id}::uuid)`;
      }
    });
  }

  async stripeEndpoint(workspaceId: string): Promise<{ endpoint_id: string; signing_secret: string } | null> {
    const rows = await this.sql`select endpoint_id, signing_secret from stripe_endpoints where workspace_id = ${workspaceId}::uuid`;
    return (rows[0] ?? null) as { endpoint_id: string; signing_secret: string } | null;
  }

  async saveStripeEndpoint(workspaceId: string, id: string, secret: string) {
    await this.sql`
      insert into stripe_endpoints (workspace_id, endpoint_id, signing_secret) values (${workspaceId}::uuid, ${id}, ${secret})
      on conflict (workspace_id) do update set endpoint_id = excluded.endpoint_id, signing_secret = excluded.signing_secret`;
  }

  /** A completed payment wins the deal and the lead. Returns the lead for the alert, once. */
  async dealPaid(workspaceId: string, linkId: string, amountCents: number | null, currency: string | null): Promise<{ leadId: string; name: string; plan: string | null; value: number | null; currency: string } | null> {
    return this.sql.begin(async (tx) => {
      const rows = await tx`
        update deals set payment_status = 'paid', paid_at = now(), stage = 'won', closed_at = coalesce(closed_at, now()),
          closed_by = coalesce(closed_by, 'ai'), value_cents = coalesce(${amountCents}, value_cents),
          currency = coalesce(upper(${currency}), currency), updated_at = now()
        where workspace_id = ${workspaceId}::uuid and stripe_payment_link_id = ${linkId} and payment_status <> 'paid'
        returning id, lead_id, plan_name, value_cents, currency`;
      if (!rows.length) return null;
      const d = rows[0];
      await tx`update leads set stage = 'won', stage_changed_at = now(), updated_at = now() where workspace_id = ${workspaceId}::uuid and id = ${d.lead_id}::uuid and stage <> 'won'`;
      const lead = (await tx`select coalesce(full_name, email, phone) as name from leads where workspace_id = ${workspaceId}::uuid and id = ${d.lead_id}::uuid`)[0];
      await tx`
        insert into activities (workspace_id, lead_id, type, channel, summary, actor, record_table, record_id)
        values (${workspaceId}::uuid, ${d.lead_id}::uuid, 'status_change', null, ${`Paid${d.plan_name ? ` for ${d.plan_name}` : ''}: deal won`}, 'system', 'deals', ${d.id}::uuid)`;
      return { leadId: d.lead_id as string, name: String(lead?.name ?? ''), plan: (d.plan_name ?? null) as string | null, value: d.value_cents === null ? null : Number(d.value_cents), currency: String(d.currency) };
    });
  }

  // ---------------------------------------------------------------- receptionist

  async receptionistCampaign(workspaceId: string, phoneNumberId: string): Promise<ReceptionistCampaign | null> {
    const rows = await this.sql`
      select id, name, status, receptionist_status, vapi_receptionist_assistant_id, vapi_inbound_number_id, receptionist_transfer_number,
             receptionist_notes, sms_from, booking_event_type, sender_name, offer
      from campaigns where workspace_id = ${workspaceId}::uuid and vapi_inbound_number_id = ${phoneNumberId}`;
    return (rows[0] ?? null) as ReceptionistCampaign | null;
  }

  /** What the receptionist may know about a caller: first name and company only. */
  async callerContext(workspaceId: string, phone: string): Promise<{ first_name: string | null; company_name: string | null } | null> {
    const rows = await this.sql`
      select split_part(coalesce(l.full_name, ''), ' ', 1) as first_name, c.name as company_name
      from leads l left join companies c on c.workspace_id = l.workspace_id and c.id = l.company_id
      where l.workspace_id = ${workspaceId}::uuid and l.phone = ${phone}
      order by l.updated_at desc limit 1`;
    if (!rows.length) return null;
    return { first_name: (rows[0].first_name as string) || null, company_name: (rows[0].company_name ?? null) as string | null };
  }

  /**
   * Records an inbound call once: the caller is matched to a lead by number,
   * then email, or added as a new lead; the outcome is applied. Returns null
   * when the call was already recorded.
   */
  async saveInboundCall(workspaceId: string, campaignId: string, r: {
    providerId: string; from: string; outcome: import('./receptionist.ts').ReceptionOutcome; callerName: string | null; email: string | null;
    summary: string | null; transcript: string | null; recordingUrl: string | null; duration: number | null; startedAt: string | null;
    endedAt: string | null; endedReason: string | null; analysis: Record<string, unknown>; callbackTime: string | null; okToText: boolean;
  }): Promise<{ leadId: string; callId: string; name: string; created: boolean; stage: string } | null> {
    return this.sql.begin(async (tx) => {
      // Each Vapi call is recorded once
      if ((await tx`select 1 from calls where workspace_id = ${workspaceId}::uuid and provider = 'vapi' and provider_call_id = ${r.providerId}`).length) return null;
      let lead = (await tx`select id, stage, email, full_name, consent from leads where workspace_id = ${workspaceId}::uuid and phone = ${r.from} order by updated_at desc limit 1`)[0];
      if (!lead && r.email) lead = (await tx`select id, stage, email, full_name, consent from leads where workspace_id = ${workspaceId}::uuid and lower(email) = ${r.email} limit 1`)[0];
      let created = false;
      if (!lead) {
        lead = (await tx`
          insert into leads (workspace_id, campaign_id, full_name, email, phone, source_channel, source_query, stage)
          values (${workspaceId}::uuid, ${campaignId}::uuid, ${r.callerName}, ${r.email}, ${r.from}, 'inbound_call', 'Called the company number', 'new')
          returning id, stage, email, full_name, consent`)[0];
        created = true;
      } else {
        // An email the caller gave is added only if no other lead already has it
        const emailFree = r.email ? !(await tx`select 1 from leads where workspace_id = ${workspaceId}::uuid and lower(email) = ${r.email} and id <> ${lead.id}::uuid`).length : false;
        await tx`
          update leads set full_name = coalesce(full_name, ${r.callerName}), phone = coalesce(phone, ${r.from}),
            email = coalesce(email, ${emailFree ? r.email : null}), updated_at = now()
          where workspace_id = ${workspaceId}::uuid and id = ${lead.id}::uuid`;
      }
      const leadId = lead.id as string;
      const outcomeMap: Record<string, string> = {
        meeting_requested: 'interested', callback_requested: 'callback', question_answered: 'answered', existing_customer: 'answered',
        transferred: 'transferred', not_a_fit: 'not_interested', do_not_call: 'do_not_call', spam: 'spam', no_conversation: 'no_answer',
      };
      const calls = await tx`
        insert into calls (workspace_id, lead_id, campaign_id, agent, direction, from_number, provider, provider_call_id, status, outcome, summary,
                           transcript, recording_url, duration_seconds, started_at, ended_at, ended_reason, analysis, handed_off, idempotency_key)
        values (${workspaceId}::uuid, ${leadId}::uuid, ${campaignId}::uuid, 'receptionist', 'inbound', ${r.from}, 'vapi', ${r.providerId}, 'ended',
                ${outcomeMap[r.outcome] ?? 'answered'}, ${r.summary}, ${r.transcript}, ${r.recordingUrl}, ${r.duration}, ${r.startedAt}::timestamptz,
                coalesce(${r.endedAt}::timestamptz, now()), ${r.endedReason}, ${tx.json({ ...r.analysis, receptionist_outcome: r.outcome } as postgres.JSONValue)},
                ${r.outcome === 'transferred' || r.outcome === 'existing_customer'}, ${`vapi:${r.providerId}`})
        on conflict (workspace_id, idempotency_key) do nothing
        returning id`;
      if (!calls.length) return null;
      const callId = calls[0].id as string;
      // A caller who asks to be called back, or agrees to a text, has asked us to contact them
      const consent = { ...((lead.consent ?? {}) as Record<string, unknown>) };
      const stamp = { at: new Date().toISOString(), source: 'receptionist_call', call_id: callId };
      if (r.outcome === 'callback_requested' && !consent.voice) Object.assign(consent, { voice: 'inbound_request', voice_recorded_at: stamp.at, voice_source: stamp.source, voice_call_id: callId });
      if (r.outcome === 'meeting_requested' && r.okToText && !consent.sms) Object.assign(consent, { sms: 'inbound_request', sms_recorded_at: stamp.at, sms_source: stamp.source, sms_call_id: callId });
      const target = r.outcome === 'meeting_requested' || r.outcome === 'callback_requested' ? 'interested'
        : r.outcome === 'question_answered' || r.outcome === 'transferred' || r.outcome === 'existing_customer' ? 'engaged'
          : r.outcome === 'not_a_fit' ? 'not_interested' : r.outcome === 'do_not_call' ? 'do_not_contact' : String(lead.stage);
      const stage = nextStage(String(lead.stage), target);
      await tx`update leads set consent = ${tx.json(consent as postgres.JSONValue)}, stage = ${stage},
                 stage_changed_at = case when stage <> ${stage} then now() else stage_changed_at end, updated_at = now()
               where workspace_id = ${workspaceId}::uuid and id = ${leadId}::uuid`;
      const labels: Record<string, string> = {
        meeting_requested: 'wants a meeting', callback_requested: 'asked to be called back', question_answered: 'question answered',
        existing_customer: 'existing customer, passed to the team', transferred: 'put through to the team', not_a_fit: 'not a fit',
        do_not_call: 'asked not to be called', spam: 'spam', no_conversation: 'no conversation',
      };
      const minutes = r.duration ? ` (${Math.round(r.duration / 6) / 10} min)` : '';
      await tx`
        insert into activities (workspace_id, lead_id, type, channel, summary, actor, record_table, record_id)
        values (${workspaceId}::uuid, ${leadId}::uuid, 'call', 'voice', ${`Inbound call, AI receptionist: ${labels[r.outcome]}${minutes}${r.summary ? `. ${r.summary}` : ''}`.slice(0, 500)}, 'ai', 'calls', ${callId}::uuid)`;
      const task = async (channel: string, due: Date) => { await tx`insert into follow_ups (workspace_id, lead_id, channel, due_at) values (${workspaceId}::uuid, ${leadId}::uuid, ${channel}, ${due})`; };
      if (r.outcome === 'callback_requested') {
        const t = r.callbackTime && !Number.isNaN(Date.parse(r.callbackTime)) ? new Date(r.callbackTime) : null;
        await task('voice', t && t.getTime() > Date.now() && t.getTime() < Date.now() + 60 * 86_400_000 ? t : new Date());
      }
      if (r.outcome === 'existing_customer') await task('manual', new Date());
      if (r.outcome === 'do_not_call') {
        await tx`insert into suppressions (workspace_id, kind, value, reason, created_by) values (${workspaceId}::uuid, 'phone', ${r.from}, 'do_not_call', null) on conflict (workspace_id, kind, value) do nothing`;
        await tx`update emails set status = 'cancelled' where workspace_id = ${workspaceId}::uuid and lead_id = ${leadId}::uuid and status in ('queued', 'approved', 'draft')`;
      }
      const name = String(r.callerName ?? lead.full_name ?? lead.email ?? r.from);
      return { leadId, callId, name, created, stage };
    });
  }

  async addTask(workspaceId: string, leadId: string, channel: 'manual' | 'voice' | 'sms', summary: string) {
    await this.sql.begin(async (tx) => {
      await tx`insert into follow_ups (workspace_id, lead_id, channel, due_at) values (${workspaceId}::uuid, ${leadId}::uuid, ${channel}, now())`;
      await tx`insert into activities (workspace_id, lead_id, type, channel, summary, actor) values (${workspaceId}::uuid, ${leadId}::uuid, 'task', ${channel}, ${summary.slice(0, 500)}, 'system')`;
    });
  }

  // ---------------------------------------------------------------- audits

  /** Qualified, researched leads in this campaign with no audit yet. */
  async leadsToAudit(workspaceId: string, campaignId: string, threshold: number, limit: number) {
    return (await this.sql`
      select l.id, l.full_name, c.name as company_name, c.domain, c.google_rating, c.google_reviews, l.ai_report
      from leads l
      left join companies c on c.workspace_id = l.workspace_id and c.id = l.company_id
      where l.workspace_id = ${workspaceId}::uuid and l.campaign_id = ${campaignId}::uuid
        and l.stage in ('new', 'contacted') and l.score >= ${threshold} and l.researched_at is not null
        and not exists (select 1 from assets a where a.workspace_id = l.workspace_id and a.lead_id = l.id and a.campaign_id = ${campaignId}::uuid and a.type = 'audit')
      order by l.score desc, l.created_at
      limit ${limit}`) as unknown as import('./audit.ts').AuditLead[];
  }

  async saveAudit(workspaceId: string, campaignId: string, leadId: string, a: {
    status: 'ready' | 'no_website' | 'failed'; title: string; score: number | null; content: Record<string, unknown>; token: string | null; webUrl: string | null; error: string | null;
  }): Promise<string | null> {
    return this.sql.begin(async (tx) => {
      const rows = await tx`
        insert into assets (workspace_id, lead_id, campaign_id, type, status, title, score, content, share_token, web_url, error)
        values (${workspaceId}::uuid, ${leadId}::uuid, ${campaignId}::uuid, 'audit', ${a.status}, ${a.title.slice(0, 200)}, ${a.score},
                ${tx.json(a.content as postgres.JSONValue)}, ${a.token}, ${a.webUrl}, ${a.error?.slice(0, 400) ?? null})
        on conflict (workspace_id, campaign_id, lead_id) where type = 'audit' do nothing
        returning id`;
      if (!rows.length) return null;
      if (a.status === 'ready') {
        await tx`
          insert into activities (workspace_id, lead_id, type, channel, summary, actor, record_table, record_id)
          values (${workspaceId}::uuid, ${leadId}::uuid, 'note', null, ${`Website audit ready: score ${a.score}/100`}, 'ai', 'assets', ${rows[0].id}::uuid)`;
      }
      return rows[0].id as string;
    });
  }

  /** Audits opened since the last alert. */
  async auditsToAlert(workspaceId: string, campaignId: string) {
    return (await this.sql`
      update assets a set alerted_at = now()
      from leads l
      where a.workspace_id = ${workspaceId}::uuid and a.campaign_id = ${campaignId}::uuid and a.type = 'audit'
        and a.first_viewed_at is not null and a.alerted_at is null
        and l.workspace_id = a.workspace_id and l.id = a.lead_id
      returning a.lead_id, a.score, coalesce(l.full_name, l.email, l.phone, 'A lead') as name`) as unknown as { lead_id: string; score: number | null; name: string }[];
  }

  // ---------------------------------------------------------------- learning

  /** One row per lead whose first email went out in the period, with what happened next. */
  async learningRows(workspaceId: string, campaignId: string, since: Date) {
    return (await this.sql`
      select l.id, l.source_channel, l.score, e.subject, e.body,
        (select r.variant_label from lead_step_runs r
         where r.workspace_id = l.workspace_id and r.lead_id = l.id and r.outcome = 'sent'
         order by r.ran_at limit 1) as variant,
        exists (select 1 from replies r where r.workspace_id = l.workspace_id and r.lead_id = l.id and r.classification in ('interested', 'question', 'referral')) as positive,
        exists (select 1 from replies r where r.workspace_id = l.workspace_id and r.lead_id = l.id and coalesce(r.classification, '') <> 'out_of_office') as replied,
        exists (select 1 from meetings m where m.workspace_id = l.workspace_id and m.lead_id = l.id and m.status <> 'canceled') as meeting,
        exists (select 1 from deals d where d.workspace_id = l.workspace_id and d.lead_id = l.id and d.stage = 'won') as won,
        exists (select 1 from assets a where a.workspace_id = l.workspace_id and a.lead_id = l.id and a.type = 'audit' and a.status = 'ready') as had_audit,
        exists (select 1 from assets a where a.workspace_id = l.workspace_id and a.lead_id = l.id and a.type = 'audit' and a.first_viewed_at is not null) as audit_opened,
        exists (select 1 from messages m where m.workspace_id = l.workspace_id and m.lead_id = l.id and m.direction = 'outbound' and m.step is not null) as texted,
        exists (select 1 from calls k where k.workspace_id = l.workspace_id and k.lead_id = l.id and k.direction = 'outbound' and k.agent = 'caller') as called
      from leads l
      join emails e on e.workspace_id = l.workspace_id and e.lead_id = l.id and e.campaign_id = ${campaignId}::uuid and e.step = 1 and e.status = 'sent'
      where l.workspace_id = ${workspaceId}::uuid and l.campaign_id = ${campaignId}::uuid and e.sent_at >= ${since}
      limit 5000`) as unknown as import('./learning.ts').LearningRow[];
  }

  async saveLearningReport(workspaceId: string, campaignId: string, r: {
    start: Date; end: Date; stats: Record<string, unknown>; findings: unknown[]; summary: string;
    suggestions: { kind: 'copy_guidance' | 'score_threshold'; text: string; value: number | null; evidence: string; findingId: string }[];
    autoApply: boolean;
  }): Promise<{ reportId: string; created: number; applied: number }> {
    return this.sql.begin(async (tx) => {
      const report = (await tx`
        insert into learning_reports (workspace_id, campaign_id, period_start, period_end, stats, findings, summary)
        values (${workspaceId}::uuid, ${campaignId}::uuid, ${r.start}, ${r.end}, ${tx.json(r.stats as postgres.JSONValue)},
                ${tx.json(r.findings as postgres.JSONValue)}, ${r.summary.slice(0, 1200)})
        returning id`)[0].id as string;
      let created = 0;
      let applied = 0;
      for (const sg of r.suggestions) {
        const auto = r.autoApply && sg.kind === 'copy_guidance';
        const rows = await tx`
          insert into learning_suggestions (workspace_id, campaign_id, report_id, kind, text, value, evidence, finding_id, status, decided_at)
          values (${workspaceId}::uuid, ${campaignId}::uuid, ${report}::uuid, ${sg.kind}, ${sg.text}, ${sg.value}, ${sg.evidence.slice(0, 400)}, ${sg.findingId},
                  ${auto ? 'applied' : 'proposed'}, ${auto ? new Date() : null})
          on conflict (workspace_id, campaign_id, kind, finding_id) where status in ('proposed', 'applied') do nothing
          returning id`;
        if (!rows.length) continue;
        created++;
        if (auto) {
          await tx`
            update campaigns set learned_guidance = (array_append(learned_guidance, ${sg.text}::text))[greatest(1, cardinality(learned_guidance) - 6):], updated_at = now()
            where workspace_id = ${workspaceId}::uuid and id = ${campaignId}::uuid and not (${sg.text}::text = any (learned_guidance))`;
          applied++;
        }
      }
      return { reportId: report, created, applied };
    });
  }

  // ---------------------------------------------------------------- white label

  /** The agency's app name for a client workspace; null when the workspace has no agency brand. */
  async brandName(workspaceId: string): Promise<string | null> {
    const rows = await this.sql`
      select b.app_name from workspaces w join agency_brands b on b.agency_id = w.agency_id where w.id = ${workspaceId}::uuid`;
    return (rows[0]?.app_name ?? null) as string | null;
  }

  /** Leads the plan still allows this calendar month (UTC); null when the plan has no limit. */
  async monthlyLeadsLeft(workspaceId: string): Promise<number | null> {
    const rows = await this.sql`
      select w.monthly_lead_limit as lim,
        (select count(*)::int from leads l where l.workspace_id = w.id and l.created_at >= date_trunc('month', now())) as used
      from workspaces w where w.id = ${workspaceId}::uuid`;
    const r = rows[0];
    return r?.lim === null || r?.lim === undefined ? null : Math.max(0, Number(r.lim) - Number(r.used));
  }

  // ---------------------------------------------------------------- notifications

  async notifySettings(workspaceId: string): Promise<import('./notify.ts').NotifySettings | null> {
    const rows = await this.sql`
      select notify_slack_events, notify_quiet_start, notify_quiet_end, notify_timezone, slack_channel from workspaces where id = ${workspaceId}::uuid`;
    const r = rows[0];
    if (!r) return null;
    return {
      slack_events: (r.notify_slack_events ?? []) as string[], quiet_start: r.notify_quiet_start ?? null, quiet_end: r.notify_quiet_end ?? null,
      timezone: String(r.notify_timezone ?? 'UTC'), slack_channel: r.slack_channel ?? null,
    };
  }

  /** Records an alert; null when an alert with the same key already exists. */
  async addNotification(workspaceId: string, n: {
    event: string; severity: string; title: string; body: string; leadId: string | null; campaignId: string | null;
    linkPath: string; actionUrl: string | null; dedupe: string | null; slackText: string;
  }): Promise<string | null> {
    const rows = await this.sql`
      insert into notifications (workspace_id, event, severity, title, body, lead_id, campaign_id, link_path, action_url, dedupe_key, slack_text)
      select ${workspaceId}::uuid, ${n.event}, ${n.severity}, ${n.title}, ${n.body}, l.id, c.id, ${n.linkPath}, ${n.actionUrl}, ${n.dedupe}, ${n.slackText}
      from (select 1) x
      left join leads l on l.workspace_id = ${workspaceId}::uuid and l.id = ${n.leadId}::uuid
      left join campaigns c on c.workspace_id = ${workspaceId}::uuid and c.id = ${n.campaignId}::uuid
      on conflict (workspace_id, dedupe_key) do nothing
      returning id`;
    return (rows[0]?.id ?? null) as string | null;
  }

  async setNotificationSlack(id: string, status: 'not_connected' | 'held' | 'sent' | 'failed', error: string | null) {
    await this.sql`update notifications set slack_status = ${status}, slack_error = ${error ? error.slice(0, 300) : null} where id = ${id}::uuid`;
  }

  async heldNotifications(workspaceId: string, limit: number) {
    return (await this.sql`
      select id, slack_text from notifications where workspace_id = ${workspaceId}::uuid and slack_status = 'held'
      order by created_at limit ${limit}`) as unknown as { id: string; slack_text: string }[];
  }

  // ---------------------------------------------------------------- monitoring

  async monitoringClaim(limit: number): Promise<string[]> {
    return (await this.sql`select id from monitoring_claim(${limit}::int)`).map((r) => r.id as string);
  }

  async monitorSettings(workspaceId: string) {
    const rows = await this.sql`
      select name, bounce_pause_pct::float8 as bounce_pct, optout_pause_pct::float8 as optout_pct, low_credits_threshold::float8 as low_credits
      from workspaces where id = ${workspaceId}::uuid`;
    return (rows[0] ?? null) as { name: string; bounce_pct: number; optout_pct: number; low_credits: number } | null;
  }

  /** Emails sent, bounced and opted out over the last 7 days, per campaign whose emails are live. */
  async deliveryRates(workspaceId: string) {
    return (await this.sql`
      select c.id, c.name,
        count(e.id)::int as sent,
        count(e.id) filter (where e.status = 'bounced')::int as bounced,
        (select count(distinct r.lead_id)::int from replies r join leads l on l.workspace_id = r.workspace_id and l.id = r.lead_id
          where r.workspace_id = c.workspace_id and l.campaign_id = c.id and r.classification = 'unsubscribe' and r.created_at > now() - interval '7 days') as opted_out
      from campaigns c
      left join emails e on e.workspace_id = c.workspace_id and e.campaign_id = c.id and e.status in ('sent', 'bounced') and e.sent_at > now() - interval '7 days'
      where c.workspace_id = ${workspaceId}::uuid and c.outreach_status = 'live'
      group by c.id`) as unknown as { id: string; name: string; sent: number; bounced: number; opted_out: number }[];
  }

  /** Stops a campaign's emails; false when they were already stopped. */
  async autoPauseEmails(workspaceId: string, campaignId: string, reason: string): Promise<boolean> {
    return this.sql.begin(async (tx) => {
      const rows = await tx`
        update campaigns set outreach_status = 'paused', auto_paused_reason = ${reason.slice(0, 300)}, auto_paused_at = now(), updated_at = now()
        where workspace_id = ${workspaceId}::uuid and id = ${campaignId}::uuid and outreach_status = 'live'
        returning id`;
      if (!rows.length) return false;
      // The outreach agent pauses the campaign in Instantly
      await tx`insert into agent_jobs (workspace_id, campaign_id, type) values (${workspaceId}::uuid, ${campaignId}::uuid, 'email_outreach') on conflict do nothing`;
      return true;
    });
  }

  async integrationProblems(workspaceId: string) {
    return (await this.sql`
      select tool, status, last_error, credits_remaining::float8 as credits from integrations
      where workspace_id = ${workspaceId}::uuid and status in ('connected', 'error', 'expired')`) as unknown as
      { tool: string; status: string; last_error: string | null; credits: number | null }[];
  }

  /** Tasks waiting more than 15 minutes that nothing is holding back. */
  async stuckJobs(workspaceId: string) {
    const rows = await this.sql`
      select count(*)::int as n, min(j.created_at) as oldest from agent_jobs j join workspaces w on w.id = j.workspace_id
      where j.workspace_id = ${workspaceId}::uuid and j.status = 'queued' and coalesce(j.run_after, j.created_at) < now() - interval '15 minutes'
        and not (w.outreach_paused and j.type in ('lead_sourcing', 'copywriting', 'reply_send', 'voice_outreach', 'sms_outreach', 'ai_closer'))`;
    return { n: Number(rows[0]?.n ?? 0), oldest: rows[0]?.oldest ? new Date(rows[0].oldest as string) : null };
  }

  /** Yesterday's activity for the daily summary (a 24-hour window ending now). */
  async dailyActivity(workspaceId: string) {
    const rows = await this.sql`
      select
        (select count(*)::int from leads where workspace_id = ${workspaceId}::uuid and created_at > now() - interval '1 day') as leads,
        (select count(*)::int from emails where workspace_id = ${workspaceId}::uuid and status in ('sent', 'bounced') and sent_at > now() - interval '1 day') as emails,
        (select count(*)::int from replies where workspace_id = ${workspaceId}::uuid and created_at > now() - interval '1 day' and coalesce(classification, '') <> 'out_of_office') as replies,
        (select count(*)::int from replies where workspace_id = ${workspaceId}::uuid and created_at > now() - interval '1 day' and classification in ('interested', 'question', 'referral')) as positive,
        (select count(*)::int from calls where workspace_id = ${workspaceId}::uuid and created_at > now() - interval '1 day') as calls,
        (select count(*)::int from meetings where workspace_id = ${workspaceId}::uuid and created_at > now() - interval '1 day') as meetings,
        (select count(*)::int from deals where workspace_id = ${workspaceId}::uuid and stage = 'won' and closed_at > now() - interval '1 day') as won,
        (select count(*)::int from agent_jobs where workspace_id = ${workspaceId}::uuid and status = 'failed' and finished_at > now() - interval '1 day') as failed`;
    return rows[0] as unknown as { leads: number; emails: number; replies: number; positive: number; calls: number; meetings: number; won: number; failed: number };
  }

  /** Platform-wide queue depth for the readiness check; counts only. */
  async queueHealth() {
    const rows = await this.sql`
      select count(*)::int as queued,
        count(*) filter (where coalesce(j.run_after, j.created_at) < now() - interval '15 minutes'
                           and not (w.outreach_paused and j.type in ('lead_sourcing', 'copywriting', 'reply_send', 'voice_outreach', 'sms_outreach', 'ai_closer')))::int as stuck,
        coalesce(extract(epoch from now() - min(coalesce(j.run_after, j.created_at))) / 60, 0)::int as oldest
      from agent_jobs j join workspaces w on w.id = j.workspace_id where j.status = 'queued'`;
    return { queued: Number(rows[0].queued), stuck: Number(rows[0].stuck), oldestMinutes: Math.max(0, Number(rows[0].oldest)) };
  }

  async retryJob(id: string, error: string, delayMinutes: number): Promise<boolean> {
    const rows = await this.sql`select agent_job_retry(${id}::uuid, ${error}, ${delayMinutes}::int) as ok`;
    return rows[0]?.ok === true;
  }

  // ---------------------------------------------------------------- CRM sync

  async crmSettings(workspaceId: string) {
    const rows = await this.sql`
      select crm_sync_enabled as enabled, crm_sync_scope as scope, crm_pipeline_id as pipeline_id, crm_stage_map as stage_map
      from workspaces where id = ${workspaceId}::uuid`;
    return (rows[0] ?? null) as { enabled: boolean; scope: 'contacted' | 'engaged'; pipeline_id: string; stage_map: unknown } | null;
  }

  async crmLinks(workspaceId: string, type: 'lead' | 'deal' | 'activity', ids: string[]) {
    const out = new Map<string, { external_id: string; fingerprint: string | null }>();
    if (!ids.length) return out;
    const rows = await this.sql`
      select record_id, external_id, fingerprint from crm_links
      where workspace_id = ${workspaceId}::uuid and provider = 'hubspot' and record_type = ${type} and record_id = any (${ids}::uuid[])`;
    for (const r of rows) out.set(r.record_id as string, { external_id: r.external_id as string, fingerprint: (r.fingerprint ?? null) as string | null });
    return out;
  }

  async saveCrmLink(workspaceId: string, type: 'lead' | 'deal' | 'activity', recordId: string, externalId: string, fp: string | null) {
    await this.sql`
      insert into crm_links (workspace_id, provider, record_type, record_id, external_id, fingerprint, synced_at)
      values (${workspaceId}::uuid, 'hubspot', ${type}, ${recordId}::uuid, ${externalId}, ${fp}, now())
      on conflict (workspace_id, provider, record_type, record_id)
      do update set external_id = excluded.external_id, fingerprint = excluded.fingerprint, synced_at = now()`;
  }

  /** Leads in scope that are new to the CRM or changed since they were last sent. */
  async crmLeads(workspaceId: string, campaignId: string, scope: 'contacted' | 'engaged', limit: number) {
    const stages = scope === 'contacted'
      ? ['contacted', 'engaged', 'interested', 'meeting_booked', 'won', 'lost', 'not_interested', 'do_not_contact']
      : ['engaged', 'interested', 'meeting_booked', 'won', 'lost'];
    return (await this.sql`
      select l.id, l.email, l.full_name, l.phone, l.title, l.stage, l.score, l.linkedin_url, c.name as company, c.domain
      from leads l
      left join companies c on c.workspace_id = l.workspace_id and c.id = l.company_id
      left join crm_links k on k.workspace_id = l.workspace_id and k.provider = 'hubspot' and k.record_type = 'lead' and k.record_id = l.id
      where l.workspace_id = ${workspaceId}::uuid and l.campaign_id = ${campaignId}::uuid and l.email is not null
        and (l.stage = any (${stages}::text[]) or k.id is not null)
        and (k.id is null or l.updated_at > k.synced_at or c.updated_at > k.synced_at)
      order by l.updated_at
      limit ${limit}`) as unknown as import('./crm.ts').CrmLead[];
  }

  async crmDeals(workspaceId: string, campaignId: string, limit: number) {
    return (await this.sql`
      select d.id, d.lead_id, d.stage, d.value_cents, d.currency, d.plan_name, d.closed_at,
             coalesce(l.full_name, l.email) as lead_name, c.name as company
      from deals d
      join leads l on l.workspace_id = d.workspace_id and l.id = d.lead_id
      left join companies c on c.workspace_id = l.workspace_id and c.id = l.company_id
      left join crm_links k on k.workspace_id = d.workspace_id and k.provider = 'hubspot' and k.record_type = 'deal' and k.record_id = d.id
      where d.workspace_id = ${workspaceId}::uuid and coalesce(d.campaign_id, l.campaign_id) = ${campaignId}::uuid
        and (k.id is null or d.updated_at > k.synced_at)
      order by d.updated_at
      limit ${limit}`).map((r) => ({ ...r, value_cents: r.value_cents === null ? null : Number(r.value_cents) })) as unknown as import('./crm.ts').CrmDeal[];
  }

  /** Open deals already in HubSpot, to read their stage back. */
  async crmLinkedDeals(workspaceId: string, campaignId: string) {
    return (await this.sql`
      select k.record_id, k.external_id, d.stage
      from crm_links k
      join deals d on d.workspace_id = k.workspace_id and d.id = k.record_id
      join leads l on l.workspace_id = d.workspace_id and l.id = d.lead_id
      where k.workspace_id = ${workspaceId}::uuid and k.provider = 'hubspot' and k.record_type = 'deal'
        and coalesce(d.campaign_id, l.campaign_id) = ${campaignId}::uuid and d.stage not in ('won', 'lost')
      limit 500`) as unknown as { record_id: string; external_id: string; stage: string }[];
  }

  /** A win or loss recorded in the CRM. Deals already closed here are left alone. */
  async closeDealFromCrm(workspaceId: string, dealId: string, stage: 'won' | 'lost'): Promise<{ leadId: string; name: string } | null> {
    return this.sql.begin(async (tx) => {
      const rows = await tx`
        update deals set stage = ${stage}, closed_at = coalesce(closed_at, now()), closed_by = coalesce(closed_by, 'human'), updated_at = now()
        where workspace_id = ${workspaceId}::uuid and id = ${dealId}::uuid and stage not in ('won', 'lost')
        returning lead_id`;
      if (!rows.length) return null;
      const leadId = rows[0].lead_id as string;
      await tx`update leads set stage = ${stage}, stage_changed_at = now(), updated_at = now()
               where workspace_id = ${workspaceId}::uuid and id = ${leadId}::uuid and stage <> ${stage} and stage <> 'do_not_contact'`;
      await tx`
        insert into activities (workspace_id, lead_id, type, channel, summary, actor, record_table, record_id)
        values (${workspaceId}::uuid, ${leadId}::uuid, 'status_change', null, ${stage === 'won' ? 'Marked won in HubSpot' : 'Marked lost in HubSpot'}, 'system', 'deals', ${dealId}::uuid)`;
      const name = (await tx`select coalesce(full_name, email, phone, 'A lead') as name from leads where workspace_id = ${workspaceId}::uuid and id = ${leadId}::uuid`)[0]?.name;
      return { leadId, name: String(name ?? 'A lead') };
    });
  }

  /** Replies, meetings and finished calls not yet noted in HubSpot, for leads already there. */
  async crmActivities(workspaceId: string, campaignId: string, limit: number) {
    const rows = await this.sql`
      with lk as (
        select k.record_id as lead_id from crm_links k
        join leads l on l.workspace_id = k.workspace_id and l.id = k.record_id
        where k.workspace_id = ${workspaceId}::uuid and k.provider = 'hubspot' and k.record_type = 'lead' and l.campaign_id = ${campaignId}::uuid
      ), acts as (
        select r.id, r.lead_id, 'reply' as kind, r.created_at as at,
               jsonb_build_object('channel', r.channel, 'classification', r.classification, 'body', left(r.body, 1500)) as detail
        from replies r join lk on lk.lead_id = r.lead_id where r.workspace_id = ${workspaceId}::uuid
        union all
        select m.id, m.lead_id, 'meeting', m.starts_at, jsonb_build_object('status', m.status, 'run_by', m.run_by, 'outcome', left(m.outcome, 500))
        from meetings m join lk on lk.lead_id = m.lead_id where m.workspace_id = ${workspaceId}::uuid
        union all
        select k.id, k.lead_id, 'call', coalesce(k.ended_at, k.created_at),
               jsonb_build_object('direction', k.direction, 'outcome', k.outcome, 'duration_seconds', k.duration_seconds, 'summary', left(k.summary, 1500))
        from calls k join lk on lk.lead_id = k.lead_id where k.workspace_id = ${workspaceId}::uuid and k.status = 'ended'
      )
      select a.* from acts a
      where not exists (select 1 from crm_links x where x.workspace_id = ${workspaceId}::uuid and x.provider = 'hubspot'
                          and x.record_type = 'activity' and x.record_id = a.id)
      order by a.at
      limit ${limit}`;
    return rows.map((r) => ({ ...r, at: new Date(r.at as string) })) as unknown as import('./crm.ts').CrmActivity[];
  }

  async crmSynced(workspaceId: string) {
    await this.sql`update workspaces set crm_synced_at = now() where id = ${workspaceId}::uuid`;
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

  // ---------------------------------------------------------------- templates

  /** The workspace's reusable copy blocks, for the writer to draw on. */
  async snippets(workspaceId: string, limit = 20): Promise<{ name: string; body: string }[]> {
    const rows = await this.sql`
      select name, payload->>'body' as body
      from templates
      where workspace_id = ${workspaceId}::uuid and kind = 'snippet'
        and coalesce(payload->>'body', '') <> ''
      order by name
      limit ${limit}`;
    return rows.map((r) => ({ name: r.name as string, body: r.body as string }));
  }

  /**
   * The objection answers the team already wrote in the active playbook. They
   * were only reaching the closer agent; the reply agent needs them too.
   */
  async objectionAnswers(workspaceId: string, limit = 12): Promise<{ objection: string; answer: string }[]> {
    const rows = await this.sql`
      select content->'objections' as objections
      from playbooks
      where workspace_id = ${workspaceId}::uuid and is_active
      order by version desc limit 1`;
    const list = rows[0]?.objections;
    if (!Array.isArray(list)) return [];
    return list
      .filter((o): o is { objection: string; answer: string } =>
        Boolean(o) && typeof o === 'object'
        && typeof (o as Record<string, unknown>).objection === 'string'
        && typeof (o as Record<string, unknown>).answer === 'string')
      .slice(0, limit);
  }

  // ---------------------------------------------------------------- sequences

  /** A campaign's sequence, in order, each step with its variants. */
  async sequenceSteps(workspaceId: string, campaignId: string): Promise<SequenceStepRow[]> {
    return (await this.sql`
      select s.id, s.position, s.channel, s.wait_hours, s.condition, s.is_last, s.instantly_campaign_id,
             coalesce((
               select json_agg(json_build_object('id', v.id, 'label', v.label, 'subject', v.subject,
                                                 'body', v.body, 'active', v.active) order by v.label)
               from sequence_variants v
               where v.workspace_id = s.workspace_id and v.step_id = s.id
             ), '[]'::json) as variants
      from sequence_steps s
      where s.workspace_id = ${workspaceId}::uuid and s.campaign_id = ${campaignId}::uuid
      order by s.position`) as unknown as SequenceStepRow[];
  }

  /** Leads still worth another step, with every fact a condition may ask about. */
  async sequenceCandidates(workspaceId: string, campaignId: string, limit: number): Promise<SequenceCandidate[]> {
    return (await this.sql`
      select * from sequence_candidates(${workspaceId}::uuid, ${campaignId}::uuid, ${limit})`) as unknown as SequenceCandidate[];
  }

  /** False when the step had already run for this lead, which keeps retries safe. */
  async recordStepRun(
    workspaceId: string, leadId: string, stepId: string,
    variant: string | null, outcome: 'sent' | 'skipped' | 'failed', detail: string | null,
  ): Promise<boolean> {
    const rows = await this.sql`
      select lead_step_record(${workspaceId}::uuid, ${leadId}::uuid, ${stepId}::uuid,
                              ${variant}, ${outcome}, ${detail}) as recorded`;
    return rows[0].recorded === true;
  }

  /** Remembers the one-step Instantly campaign that sends an email step. */
  async setStepInstantlyCampaign(workspaceId: string, stepId: string, instantlyId: string) {
    await this.sql`
      update sequence_steps set instantly_campaign_id = ${instantlyId}
      where workspace_id = ${workspaceId}::uuid and id = ${stepId}::uuid`;
  }

  /** How many steps this campaign sent today, against the campaign's daily limit. */
  async stepsSentToday(workspaceId: string, campaignId: string): Promise<number> {
    const rows = await this.sql`
      select count(*)::int as n
      from lead_step_runs r
      join sequence_steps s on s.workspace_id = r.workspace_id and s.id = r.step_id
      where r.workspace_id = ${workspaceId}::uuid and s.campaign_id = ${campaignId}::uuid
        and r.outcome = 'sent' and r.ran_at >= date_trunc('day', now())`;
    return rows[0].n as number;
  }

  /** What each variant of each step achieved, for the A/B results table. */
  async variantResults(workspaceId: string, campaignId: string): Promise<VariantResult[]> {
    return (await this.sql`
      select s.position, s.channel, r.variant_label as label,
             count(*)::int as sent,
             count(*) filter (where exists (
               select 1 from replies rp where rp.workspace_id = r.workspace_id and rp.lead_id = r.lead_id
                 and rp.created_at > r.ran_at
             ))::int as replied,
             count(*) filter (where exists (
               select 1 from meetings m where m.workspace_id = r.workspace_id and m.lead_id = r.lead_id
                 and m.created_at > r.ran_at
             ))::int as meetings
      from lead_step_runs r
      join sequence_steps s on s.workspace_id = r.workspace_id and s.id = r.step_id
      where r.workspace_id = ${workspaceId}::uuid and s.campaign_id = ${campaignId}::uuid
        and r.outcome = 'sent' and r.variant_label is not null
      group by s.position, s.channel, r.variant_label
      order by s.position, r.variant_label`) as unknown as VariantResult[];
  }
}

export type SequenceStepRow = {
  id: string; position: number; channel: 'email' | 'voice' | 'sms' | 'whatsapp'; wait_hours: number;
  condition: unknown; is_last: boolean; instantly_campaign_id: string | null;
  variants: { id: string; label: 'a' | 'b' | 'c'; subject: string | null; body: string; active: boolean }[];
};

export type SequenceCandidate = {
  lead_id: string; email: string | null; phone: string | null; full_name: string | null; title: string | null;
  company_name: string; domain: string | null; score: number | null; stage: string;
  phone_line_type: string | null; consent: Record<string, unknown> | null; ai_report: Record<string, unknown> | null;
  facts: Record<string, unknown>;
};

export type VariantResult = {
  position: number; channel: string; label: 'a' | 'b' | 'c'; sent: number; replied: number; meetings: number;
};

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
