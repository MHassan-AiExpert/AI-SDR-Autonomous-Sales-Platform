-- =============================================================================
-- The kill switch also holds answers waiting to be sent. They stay queued and
-- go out once outreach is resumed.
-- =============================================================================

create or replace function public.agent_jobs_claim(p_limit integer default 5, p_timeout_minutes integer default 15)
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
      -- The kill switch stops new sourcing, new writing and outgoing answers
      and not (w.outreach_paused and q.type in ('lead_sourcing', 'copywriting', 'reply_send'))
    order by q.created_at
    for update of q skip locked
    limit greatest(1, least(p_limit, 50))
  )
  returning j.*;
end;
$$;

revoke execute on function public.agent_jobs_claim(integer, integer) from public, anon, authenticated;
grant execute on function public.agent_jobs_claim(integer, integer) to service_role;
