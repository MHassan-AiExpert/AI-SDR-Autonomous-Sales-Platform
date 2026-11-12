-- =============================================================================
-- Enrichment and verification
--
-- Companies found without a contact (mostly from LLM search and Google Maps)
-- remember which campaign and source found them, so the enrichment agent can
-- find decision makers for them. Leads record when their email and phone were
-- checked. A daily scheduler queues sourcing and enrichment for every active
-- campaign.
-- =============================================================================

alter table public.agent_jobs drop constraint agent_jobs_type_check;
alter table public.agent_jobs add constraint agent_jobs_type_check
  check (type in ('campaign_plan', 'lead_sourcing', 'enrichment'));

alter table public.companies
  add column campaign_id        uuid,
  add column source_channel     text check (source_channel in (
                                  'apollo', 'clay', 'google_maps', 'instagram', 'facebook', 'linkedin',
                                  'tiktok', 'x', 'llm_search', 'csv', 'inbound_call', 'manual')),
  add column enrichment_status  text not null default 'pending'
                                check (enrichment_status in ('pending', 'enriched', 'no_contact_found', 'skipped')),
  add column enriched_at        timestamptz,
  add constraint companies_campaign_fk foreign key (workspace_id, campaign_id)
    references public.campaigns (workspace_id, id) on delete set null (campaign_id);

create index companies_enrichment_idx on public.companies (workspace_id, campaign_id, enrichment_status);

alter table public.leads
  add column phone_country     text check (phone_country ~ '^[A-Z]{2}$'),
  add column email_checked_at  timestamptz,
  add column phone_checked_at  timestamptz;

create index leads_verification_idx on public.leads (workspace_id, campaign_id, verification_status)
  where email is not null;

-- -----------------------------------------------------------------------------
-- Daily scheduling. Called by the agent service before it claims work.
-- For every active campaign in a workspace that is not paused, queues a lead
-- sourcing job when none was queued in the last p_hours, and an enrichment
-- job on the same rule. Returns how many jobs were queued.
-- -----------------------------------------------------------------------------
create function public.agent_jobs_enqueue_due(p_hours integer default 24)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  queued integer;
begin
  with due as (
    select c.workspace_id, c.id as campaign_id, t.type
    from public.campaigns c
    join public.workspaces w on w.id = c.workspace_id
    cross join (values ('lead_sourcing'), ('enrichment')) as t(type)
    where c.status = 'active'
      and not w.outreach_paused
      and c.niche is not null
      and not exists (
        select 1 from public.agent_jobs j
        where j.campaign_id = c.id and j.type = t.type
          and (j.status in ('queued', 'running')
               or j.created_at > now() - make_interval(hours => greatest(1, p_hours)))
      )
  ), ins as (
    insert into public.agent_jobs (workspace_id, campaign_id, type, requested_by)
    select workspace_id, campaign_id, type, null from due
    on conflict do nothing
    returning 1
  )
  select count(*) into queued from ins;
  return queued;
end;
$$;

-- Lets a finished sourcing job hand over to enrichment straight away
create function public.agent_job_enqueue(p_workspace_id uuid, p_campaign_id uuid, p_type text)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  added integer;
begin
  insert into public.agent_jobs (workspace_id, campaign_id, type, requested_by)
  values (p_workspace_id, p_campaign_id, p_type, null)
  on conflict do nothing;
  get diagnostics added = row_count;
  return added > 0;
end;
$$;

revoke execute on function public.agent_jobs_enqueue_due(integer) from public, anon, authenticated;
revoke execute on function public.agent_job_enqueue(uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.agent_jobs_enqueue_due(integer) to service_role;
grant execute on function public.agent_job_enqueue(uuid, uuid, text) to service_role;
