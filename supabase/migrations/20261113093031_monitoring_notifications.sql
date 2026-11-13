-- =============================================================================
-- Monitoring, alerts and notifications (SRS M11, M22, section 10.6)
--
-- * Failed agent tasks caused by a provider outage, a timeout or a rate limit
--   are retried with growing waits (2, 4 minutes) before they count as failed.
-- * Every alert is recorded once in the in-app notification centre, and goes to
--   Slack for the events the workspace chose, outside its quiet hours
--   (critical alerts always go through). Held alerts are sent when quiet hours end.
-- * Every 15 minutes the monitor checks each workspace: bounce and opt-out
--   rates (and pauses a campaign's emails when they cross the limits), broken
--   or low-credit integrations, stuck queues, and sends the daily summary.
-- * Handoff alerts can be accepted with one click; the lead is assigned to the
--   person who accepted it.
-- =============================================================================

-- ---------------------------------------------------------------- retries
alter table public.agent_jobs add column run_after timestamptz;
create index agent_jobs_run_after_idx on public.agent_jobs (run_after) where status = 'queued' and run_after is not null;

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
  set status = 'running', attempts = j.attempts + 1, started_at = now(), error = null, run_after = null
  where j.id in (
    select q.id
    from public.agent_jobs q
    join public.workspaces w on w.id = q.workspace_id
    where q.status = 'queued'
      and (q.run_after is null or q.run_after <= now())
      -- The kill switch stops new sourcing, writing, answers, calls, texts and closing
      and not (w.outreach_paused and q.type in ('lead_sourcing', 'copywriting', 'reply_send', 'voice_outreach', 'sms_outreach', 'ai_closer'))
    order by q.created_at
    for update of q skip locked
    limit greatest(1, least(p_limit, 50))
  )
  returning j.*;
end;
$$;

-- A task that failed for a passing reason goes back in the queue after a wait.
-- Returns false once it has used its three attempts, so the caller fails it.
create function public.agent_job_retry(p_job_id uuid, p_error text, p_delay_minutes integer)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  n integer;
begin
  update public.agent_jobs
  set status = 'queued', error = left(p_error, 500), started_at = null,
      run_after = now() + make_interval(mins => greatest(1, least(p_delay_minutes, 60)))
  where id = p_job_id and status = 'running' and attempts < 3;
  get diagnostics n = row_count;
  return n > 0;
end;
$$;

revoke execute on function public.agent_jobs_claim(integer, integer) from public, anon, authenticated;
grant execute on function public.agent_jobs_claim(integer, integer) to service_role;
revoke execute on function public.agent_job_retry(uuid, text, integer) from public, anon, authenticated;
grant execute on function public.agent_job_retry(uuid, text, integer) to service_role;

-- ---------------------------------------------------------------- settings
alter table public.workspaces
  -- Events that go to Slack; everything is always kept in the app
  add column notify_slack_events text[] not null default array[
    'hot_reply', 'meeting_booked', 'hot_call', 'handoff', 'proposal', 'deal_won', 'deal_lost',
    'audit_opened', 'weekly_learning', 'daily_summary', 'system_alert']::text[]
    check (notify_slack_events <@ array[
      'hot_reply', 'meeting_booked', 'hot_call', 'handoff', 'proposal', 'deal_won', 'deal_lost',
      'audit_opened', 'weekly_learning', 'daily_summary', 'system_alert']::text[]),
  -- Quiet hours in the workspace's time zone, e.g. 20 to 8; none when both are empty
  add column notify_quiet_start smallint check (notify_quiet_start between 0 and 23),
  add column notify_quiet_end   smallint check (notify_quiet_end between 0 and 23),
  add column notify_timezone    text not null default 'UTC' check (notify_timezone ~ '^[A-Za-z_]+(/[A-Za-z0-9_+-]+){0,2}$' and length(notify_timezone) <= 64),
  add column bounce_pause_pct   numeric(4, 1) not null default 5 check (bounce_pause_pct between 1 and 50),
  add column optout_pause_pct   numeric(4, 1) not null default 3 check (optout_pause_pct between 1 and 50),
  add column low_credits_threshold numeric not null default 100 check (low_credits_threshold >= 0),
  add column monitored_at       timestamptz,
  add constraint workspaces_quiet_hours_pair check ((notify_quiet_start is null) = (notify_quiet_end is null)
                                                   and (notify_quiet_start is null or notify_quiet_start <> notify_quiet_end));

alter table public.campaigns
  add column auto_paused_reason text check (length(auto_paused_reason) <= 300),
  add column auto_paused_at     timestamptz;

-- ---------------------------------------------------------------- notifications
create table public.notifications (
  id            uuid primary key default gen_random_uuid(),
  workspace_id  uuid not null references public.workspaces (id) on delete cascade,
  event         text not null check (event in (
                  'hot_reply', 'meeting_booked', 'hot_call', 'handoff', 'proposal', 'deal_won', 'deal_lost',
                  'audit_opened', 'weekly_learning', 'daily_summary', 'system_alert')),
  severity      text not null default 'info' check (severity in ('info', 'warning', 'critical')),
  title         text not null check (length(title) between 1 and 120),
  body          text not null default '' check (length(body) <= 2000),
  lead_id       uuid,
  campaign_id   uuid,
  -- In-app link (always inside the workspace) and an optional join link for handoffs
  link_path     text check (link_path ~ '^/w/[0-9a-f-]{36}(/[A-Za-z0-9_/-]*)?$'),
  action_url    text check (action_url ~ '^https://' and length(action_url) <= 1000),
  -- One alert per key, so repeated checks do not repeat the same alert
  dedupe_key    text check (length(dedupe_key) between 1 and 200),
  slack_text    text check (length(slack_text) <= 3500),
  slack_status  text not null default 'off' check (slack_status in ('off', 'not_connected', 'held', 'sent', 'failed')),
  slack_error   text check (length(slack_error) <= 300),
  accepted_by   uuid references auth.users (id) on delete set null,
  accepted_at   timestamptz,
  created_at    timestamptz not null default now(),
  unique (workspace_id, dedupe_key),
  constraint notifications_lead_fk foreign key (workspace_id, lead_id) references public.leads (workspace_id, id) on delete set null (lead_id),
  constraint notifications_campaign_fk foreign key (workspace_id, campaign_id) references public.campaigns (workspace_id, id) on delete set null (campaign_id),
  constraint notifications_accept_pair check ((accepted_by is null) = (accepted_at is null) and (accepted_at is null or event = 'handoff'))
);
create index notifications_feed_idx on public.notifications (workspace_id, created_at desc);
create index notifications_held_idx on public.notifications (workspace_id) where slack_status = 'held';

alter table public.notifications enable row level security;
create policy notifications_select on public.notifications for select to authenticated using (app.is_member(workspace_id));
-- Owners, admins and reps accept a handoff for themselves, once
create policy notifications_accept on public.notifications for update to authenticated
  using (event = 'handoff' and accepted_at is null and app.has_role(workspace_id, array['owner', 'admin', 'rep']::public.workspace_role[]))
  with check (accepted_by = (select auth.uid()) and accepted_at is not null);
revoke all on public.notifications from anon, authenticated;
grant select on public.notifications to authenticated;
grant update (accepted_by, accepted_at) on public.notifications to authenticated;
grant all on public.notifications to service_role;

-- When each member last opened the notification centre
create table public.notification_seen (
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  user_id      uuid not null references auth.users (id) on delete cascade,
  seen_at      timestamptz not null default now(),
  primary key (workspace_id, user_id)
);
alter table public.notification_seen enable row level security;
create policy notification_seen_select on public.notification_seen for select to authenticated
  using (user_id = (select auth.uid()) and app.is_member(workspace_id));
create policy notification_seen_insert on public.notification_seen for insert to authenticated
  with check (user_id = (select auth.uid()) and app.is_member(workspace_id));
create policy notification_seen_update on public.notification_seen for update to authenticated
  using (user_id = (select auth.uid()) and app.is_member(workspace_id))
  with check (user_id = (select auth.uid()) and app.is_member(workspace_id));
revoke all on public.notification_seen from anon, authenticated;
grant select, insert, update on public.notification_seen to authenticated;
grant all on public.notification_seen to service_role;

-- ---------------------------------------------------------------- monitor
-- Hands out workspaces whose last check is at least 15 minutes old
create function public.monitoring_claim(p_limit integer default 10)
returns table (id uuid)
language plpgsql
security definer
set search_path = ''
as $$
begin
  return query
  update public.workspaces w set monitored_at = now()
  where w.id in (
    select x.id from public.workspaces x
    where x.monitored_at is null or x.monitored_at < now() - interval '15 minutes'
    order by x.monitored_at nulls first
    for update skip locked
    limit greatest(1, least(p_limit, 100))
  )
  returning w.id;
end;
$$;
revoke execute on function public.monitoring_claim(integer) from public, anon, authenticated;
grant execute on function public.monitoring_claim(integer) to service_role;
