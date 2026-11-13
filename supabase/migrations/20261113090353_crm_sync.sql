-- =============================================================================
-- CRM sync with HubSpot (SRS M9)
--
-- When switched on, the CRM agent mirrors leads to HubSpot contacts (upserted
-- by email) with a lead status that follows their stage (opt-outs included),
-- deals to the chosen pipeline, and replies, meetings and calls as notes. Only changed
-- records are sent again. Deals marked won or lost in HubSpot come back.
-- The platform stays the source of truth for everything else.
-- =============================================================================

alter table public.agent_jobs drop constraint agent_jobs_type_check;
alter table public.agent_jobs add constraint agent_jobs_type_check
  check (type in ('campaign_plan', 'lead_sourcing', 'enrichment', 'research', 'copywriting', 'email_outreach',
                  'reply_handling', 'reply_send', 'voice_outreach', 'sms_outreach', 'ai_closer', 'audit_reports', 'learning', 'crm_sync'));

-- ---------------------------------------------------------------- settings
alter table public.workspaces
  add column crm_sync_enabled boolean not null default false,
  -- Which leads go to the CRM: everyone contacted, or only those who engaged
  add column crm_sync_scope   text not null default 'engaged' check (crm_sync_scope in ('contacted', 'engaged')),
  add column crm_pipeline_id  text not null default 'default' check (crm_pipeline_id ~ '^[A-Za-z0-9_-]{1,64}$'),
  -- Our deal stage to the HubSpot stage id; missing stages use HubSpot's default pipeline
  add column crm_stage_map    jsonb not null default '{}'::jsonb
                              check (jsonb_typeof(crm_stage_map) = 'object' and pg_column_size(crm_stage_map) <= 2000),
  add column crm_synced_at    timestamptz;

-- ---------------------------------------------------------------- links
create table public.crm_links (
  id            bigint generated always as identity primary key,
  workspace_id  uuid not null references public.workspaces (id) on delete cascade,
  provider      text not null default 'hubspot' check (provider in ('hubspot')),
  record_type   text not null check (record_type in ('lead', 'deal', 'activity')),
  record_id     uuid not null,
  external_id   text not null check (external_id ~ '^[0-9]{1,30}$'),
  -- Fingerprint of what was last sent, so unchanged records are skipped
  fingerprint   text check (fingerprint ~ '^[0-9a-f]{64}$'),
  synced_at     timestamptz not null default now(),
  unique (workspace_id, provider, record_type, record_id)
);
create index crm_links_external_idx on public.crm_links (workspace_id, provider, record_type, external_id);
alter table public.crm_links enable row level security;
create policy crm_links_select on public.crm_links for select to authenticated using (app.is_member(workspace_id));
revoke all on public.crm_links from anon;
revoke insert, update, delete on public.crm_links from authenticated;
grant select on public.crm_links to authenticated;
grant all on public.crm_links to service_role;

-- Hourly sync for active campaigns while CRM sync is on
create or replace function public.agent_jobs_enqueue_due(p_hours integer default 24)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  queued integer;
  closers integer;
begin
  with due as (
    select c.workspace_id, c.id as campaign_id, t.type
    from public.campaigns c
    join public.workspaces w on w.id = c.workspace_id
    cross join (values ('lead_sourcing'), ('enrichment'), ('research'), ('copywriting'), ('email_outreach'),
                       ('voice_outreach'), ('sms_outreach'), ('learning'), ('crm_sync')) as t(type)
    where c.status = 'active'
      and not w.outreach_paused
      and c.niche is not null
      and (t.type <> 'email_outreach' or c.outreach_status = 'live')
      and (t.type <> 'voice_outreach' or c.voice_status = 'live')
      and (t.type <> 'sms_outreach' or c.sms_status = 'live')
      and (t.type <> 'crm_sync' or w.crm_sync_enabled)
      and not exists (
        select 1 from public.agent_jobs j
        where j.campaign_id = c.id and j.type = t.type
          and (j.status in ('queued', 'running')
               or j.created_at > now() - make_interval(hours => case
                    when t.type in ('voice_outreach', 'sms_outreach', 'crm_sync') then 1
                    when t.type = 'learning' then 168
                    else greatest(1, p_hours) end))
      )
  ), ins as (
    insert into public.agent_jobs (workspace_id, campaign_id, type, requested_by)
    select workspace_id, campaign_id, type, null from due
    on conflict do nothing
    returning 1
  )
  select count(*) into queued from ins;

  with work as (
    select m.workspace_id, m.campaign_id
    from public.meetings m
    join public.workspaces w on w.id = m.workspace_id
    where m.status = 'scheduled' and m.run_by = 'ai_closer' and m.closer_status = 'pending'
      and m.campaign_id is not null and w.ai_closer_enabled and not w.outreach_paused
      and m.starts_at <= now() + interval '1 minute' and m.starts_at > now() - interval '15 minutes'
    union
    select d.workspace_id, d.campaign_id
    from public.deals d
    join public.workspaces w on w.id = d.workspace_id
    where d.close_status = 'pending' and d.campaign_id is not null and not w.outreach_paused
  ), due as (
    select distinct k.workspace_id, k.campaign_id from work k
    where not exists (select 1 from public.agent_jobs j where j.campaign_id = k.campaign_id and j.type = 'ai_closer'
                        and (j.status in ('queued', 'running') or j.created_at > now() - interval '1 minute'))
  ), ins as (
    insert into public.agent_jobs (workspace_id, campaign_id, type, requested_by)
    select workspace_id, campaign_id, 'ai_closer', null from due
    on conflict do nothing
    returning 1
  )
  select count(*) into closers from ins;
  return queued + closers;
end;
$$;
revoke execute on function public.agent_jobs_enqueue_due(integer) from public, anon, authenticated;
grant execute on function public.agent_jobs_enqueue_due(integer) to service_role;
