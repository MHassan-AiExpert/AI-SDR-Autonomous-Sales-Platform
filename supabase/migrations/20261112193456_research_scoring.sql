-- =============================================================================
-- AI research and lead scoring (SRS M4)
--
-- The research agent reads each company once, writes a brief, and scores
-- every lead for ICP fit and intent. Only leads at or above the campaign's
-- threshold go on to outreach.
-- =============================================================================

alter table public.agent_jobs drop constraint agent_jobs_type_check;
alter table public.agent_jobs add constraint agent_jobs_type_check
  check (type in ('campaign_plan', 'lead_sourcing', 'enrichment', 'research'));

alter table public.campaigns
  add column score_threshold smallint not null default 60 check (score_threshold between 0 and 100);

alter table public.companies
  add column research        jsonb,
  add column researched_at   timestamptz;

alter table public.leads
  add column researched_at   timestamptz;

create index leads_research_queue_idx on public.leads (workspace_id, campaign_id, created_at)
  where researched_at is null;
create index leads_score_idx on public.leads (workspace_id, campaign_id, score desc nulls last);

-- The daily schedule now also runs research for every active campaign
create or replace function public.agent_jobs_enqueue_due(p_hours integer default 24)
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
    cross join (values ('lead_sourcing'), ('enrichment'), ('research')) as t(type)
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

revoke execute on function public.agent_jobs_enqueue_due(integer) from public, anon, authenticated;
grant execute on function public.agent_jobs_enqueue_due(integer) to service_role;
