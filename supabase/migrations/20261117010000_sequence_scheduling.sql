-- =============================================================================
-- Sequence scheduling (correction to F22)
--
-- Two defects in F22, found while building F26:
--
-- 1. The sequence agent was never scheduled. It ran only when someone pressed
--    "Run sequence steps", although the sequence screen said it ran on its own.
-- 2. With branching on, the fixed call and text jobs were still queued, and the
--    agent runners did not check for branching, so a lead would have been
--    contacted by both the old cadence and the new sequence.
--
-- The runners now stand down under branching (agent service). This migration
-- queues the sequence agent hourly where branching is on, and stops queuing
-- the fixed call and text jobs there. No campaign had branching turned on, so
-- nobody was contacted twice.
-- =============================================================================

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
                       ('voice_outreach'), ('sms_outreach'), ('learning'), ('crm_sync'), ('sequence')) as t(type)
    where c.status = 'active'
      and not w.outreach_paused
      and c.niche is not null
      and (t.type <> 'email_outreach' or c.outreach_status = 'live')
      and (t.type <> 'voice_outreach' or c.voice_status = 'live')
      and (t.type <> 'sms_outreach' or c.sms_status = 'live')
      and (t.type <> 'crm_sync' or w.crm_sync_enabled)
      -- The sequence agent runs only where branching is on, and there the
      -- fixed call and text jobs stand down so nobody is contacted twice. The
      -- email job still runs: it is what pauses the old Instantly campaign.
      and (t.type <> 'sequence' or c.branching_enabled)
      and (t.type not in ('voice_outreach', 'sms_outreach') or not c.branching_enabled)
      and not exists (
        select 1 from public.agent_jobs j
        where j.campaign_id = c.id and j.type = t.type
          and (j.status in ('queued', 'running')
               or j.created_at > now() - make_interval(hours => case
                    when t.type in ('voice_outreach', 'sms_outreach', 'crm_sync', 'sequence') then 1
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
