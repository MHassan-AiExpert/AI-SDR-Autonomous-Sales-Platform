-- =============================================================================
-- Agent job queue and campaign source plans
--
-- The web app asks for agent work (plan a campaign, find leads) by inserting a
-- queued job. The scheduler (n8n) wakes the agent service, which claims jobs
-- with SKIP LOCKED so several workers never take the same job, runs them with
-- the workspace's own tool accounts, and records the result.
-- =============================================================================

-- What the AI setup agent decided: which sources to search and how
alter table public.campaigns
  add column source_plan jsonb not null default '{}'::jsonb;

create table public.agent_jobs (
  id              uuid primary key default gen_random_uuid(),
  workspace_id    uuid not null references public.workspaces (id) on delete cascade,
  campaign_id     uuid not null,
  type            text not null check (type in ('campaign_plan', 'lead_sourcing')),
  status          text not null default 'queued'
                  check (status in ('queued', 'running', 'succeeded', 'failed')),
  attempts        smallint not null default 0 check (attempts between 0 and 10),
  result          jsonb not null default '{}'::jsonb,
  error           text,
  requested_by    uuid default auth.uid() references auth.users (id) on delete set null,
  -- Follows this job through every log line and run log
  correlation_id  uuid not null default gen_random_uuid(),
  created_at      timestamptz not null default now(),
  started_at      timestamptz,
  finished_at     timestamptz,
  foreign key (workspace_id, campaign_id) references public.campaigns (workspace_id, id) on delete cascade
);

-- Pressing the button twice never queues the same work twice
create unique index agent_jobs_one_active_key
  on public.agent_jobs (campaign_id, type) where status in ('queued', 'running');
create index agent_jobs_queue_idx on public.agent_jobs (status, created_at) where status in ('queued', 'running');
create index agent_jobs_campaign_idx on public.agent_jobs (workspace_id, campaign_id, created_at desc);

alter table public.agent_jobs enable row level security;

create policy agent_jobs_select on public.agent_jobs for select to authenticated
  using (app.is_member(workspace_id));

-- Owners and admins may only queue a fresh job; everything else is the backend's
create policy agent_jobs_insert on public.agent_jobs for insert to authenticated
  with check (
    app.has_role(workspace_id, array['owner', 'admin']::public.workspace_role[])
    and status = 'queued'
    and attempts = 0
    and result = '{}'::jsonb
    and error is null
    and started_at is null
    and finished_at is null
    and requested_by = auth.uid()
  );

revoke all on public.agent_jobs from anon, authenticated;
grant select, insert on public.agent_jobs to authenticated;
grant all on public.agent_jobs to service_role;

-- -----------------------------------------------------------------------------
-- Claim queued jobs for a worker. Jobs stuck in "running" longer than the
-- timeout (a crashed worker) are retried up to 3 attempts, then failed.
-- -----------------------------------------------------------------------------
create function public.agent_jobs_claim(p_limit integer default 5, p_timeout_minutes integer default 15)
returns setof public.agent_jobs
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.agent_jobs
  set status = case when attempts >= 3 then 'failed' else 'queued' end,
      error = case when attempts >= 3 then 'Stopped after 3 attempts that did not finish' else error end,
      finished_at = case when attempts >= 3 then now() else null end,
      started_at = case when attempts >= 3 then started_at else null end
  where status = 'running'
    and started_at < now() - make_interval(mins => p_timeout_minutes);

  return query
  update public.agent_jobs j
  set status = 'running', attempts = j.attempts + 1, started_at = now(), error = null
  where j.id in (
    select q.id
    from public.agent_jobs q
    join public.workspaces w on w.id = q.workspace_id
    where q.status = 'queued'
      -- The kill switch also stops new sourcing
      and not (w.outreach_paused and q.type = 'lead_sourcing')
    order by q.created_at
    for update of q skip locked
    limit greatest(1, least(p_limit, 50))
  )
  returning j.*;
end;
$$;

-- Record how a job ended
create function public.agent_job_finish(
  p_job_id uuid,
  p_status text,
  p_result jsonb default '{}'::jsonb,
  p_error text default null
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_status not in ('succeeded', 'failed') then
    raise exception 'Invalid job status' using errcode = 'check_violation';
  end if;
  update public.agent_jobs
  set status = p_status, result = coalesce(p_result, '{}'::jsonb), error = left(p_error, 500), finished_at = now()
  where id = p_job_id and status = 'running';
end;
$$;

revoke execute on function public.agent_jobs_claim(integer, integer) from public, anon, authenticated;
revoke execute on function public.agent_job_finish(uuid, text, jsonb, text) from public, anon, authenticated;
grant execute on function public.agent_jobs_claim(integer, integer) to service_role;
grant execute on function public.agent_job_finish(uuid, text, jsonb, text) to service_role;
