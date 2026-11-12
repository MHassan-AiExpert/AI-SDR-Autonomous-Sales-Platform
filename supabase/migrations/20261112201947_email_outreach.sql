-- =============================================================================
-- AI copywriting and email outreach (SRS M5, M6 email)
--
-- The copywriting agent writes a personal email sequence for each qualified
-- lead. In approval mode the drafts wait for a person; in autopilot they are
-- approved at once. The outreach agent hands approved sequences to the
-- company's Instantly account, and keeps Instantly paused whenever the
-- campaign, the email channel or the whole workspace is paused.
-- =============================================================================

alter table public.agent_jobs drop constraint agent_jobs_type_check;
alter table public.agent_jobs add constraint agent_jobs_type_check
  check (type in ('campaign_plan', 'lead_sourcing', 'enrichment', 'research', 'copywriting', 'email_outreach'));

-- ---------------------------------------------------------------- campaigns
alter table public.campaigns
  add column outreach_status     text not null default 'not_started'
                                 check (outreach_status in ('not_started', 'live', 'paused')),
  add column sender_name         text check (length(sender_name) <= 120),
  add column email_footer        text check (length(email_footer) <= 600),
  add column sending_accounts    jsonb not null default '[]'::jsonb check (jsonb_typeof(sending_accounts) = 'array'),
  add column send_timezone       text not null default 'America/Chicago',
  add column send_window_start   text not null default '09:00' check (send_window_start ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'),
  add column send_window_end     text not null default '17:00' check (send_window_end ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'),
  add column send_days           jsonb not null default '{"0":false,"1":true,"2":true,"3":true,"4":true,"5":true,"6":false}'::jsonb,
  add column daily_send_limit    integer not null default 50 check (daily_send_limit between 1 and 5000),
  add column follow_up_count     smallint not null default 2 check (follow_up_count between 0 and 4),
  add column follow_up_delay_days smallint not null default 3 check (follow_up_delay_days between 1 and 30),
  add column instantly_campaign_id text,
  add column instantly_state     text check (instantly_state in ('active', 'paused'));

-- ---------------------------------------------------------------- emails
alter table public.emails drop constraint emails_status_check;
alter table public.emails add constraint emails_status_check
  check (status in ('draft', 'approved', 'rejected', 'queued', 'sent', 'bounced', 'failed'));

alter table public.emails
  add column campaign_id  uuid,
  add column provider_id  text,
  add column approved_by  uuid references auth.users (id) on delete set null,
  add column approved_at  timestamptz,
  add column queued_at    timestamptz,
  add constraint emails_campaign_fk foreign key (workspace_id, campaign_id)
    references public.campaigns (workspace_id, id) on delete set null (campaign_id);

create index emails_campaign_status_idx on public.emails (workspace_id, campaign_id, status, step);

-- People may approve, reject and edit drafts, but only the backend moves an
-- email into the sending states, and sent emails can never be edited.
create function app.emails_client_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if current_user <> 'authenticated' then
    return new;
  end if;
  if old.status not in ('draft', 'approved', 'rejected') then
    raise exception 'This email is already with the sending service and cannot be changed'
      using errcode = 'check_violation';
  end if;
  if new.status not in ('draft', 'approved', 'rejected') then
    raise exception 'Only the outreach agent can send emails' using errcode = 'check_violation';
  end if;
  if new.lead_id <> old.lead_id or new.step <> old.step or new.idempotency_key <> old.idempotency_key
     or new.campaign_id is distinct from old.campaign_id or new.provider_id is distinct from old.provider_id
     or new.sent_at is distinct from old.sent_at or new.queued_at is distinct from old.queued_at then
    raise exception 'Only the subject, body and approval of an email can be changed' using errcode = 'check_violation';
  end if;
  if length(trim(new.subject)) = 0 or length(new.subject) > 200 or length(trim(new.body)) = 0 or length(new.body) > 5000 then
    raise exception 'Subject or body is empty or too long' using errcode = 'check_violation';
  end if;
  if new.status = 'approved' and old.status <> 'approved' then
    new.approved_by := auth.uid();
    new.approved_at := now();
  elsif new.status <> 'approved' then
    new.approved_by := null;
    new.approved_at := null;
  end if;
  return new;
end;
$$;

create trigger emails_client_guard before update on public.emails
  for each row execute function app.emails_client_guard();

-- ---------------------------------------------------------------- pausing
-- Pausing a campaign, its outreach, the email channel or the whole workspace
-- queues a sync job, so the sending service is paused within a minute.
create function app.queue_outreach_sync()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_table_name = 'workspaces' then
    if new.outreach_paused is distinct from old.outreach_paused
       or new.enabled_channels -> 'email' is distinct from old.enabled_channels -> 'email' then
      insert into public.agent_jobs (workspace_id, campaign_id, type, requested_by)
      select c.workspace_id, c.id, 'email_outreach', null
      from public.campaigns c
      where c.workspace_id = new.id and c.instantly_campaign_id is not null
      on conflict do nothing;
    end if;
  elsif new.instantly_campaign_id is not null
        and (new.status is distinct from old.status or new.outreach_status is distinct from old.outreach_status) then
    insert into public.agent_jobs (workspace_id, campaign_id, type, requested_by)
    values (new.workspace_id, new.id, 'email_outreach', null)
    on conflict do nothing;
  end if;
  return null;
end;
$$;

create trigger workspaces_outreach_sync after update on public.workspaces
  for each row execute function app.queue_outreach_sync();
create trigger campaigns_outreach_sync after update on public.campaigns
  for each row execute function app.queue_outreach_sync();

-- ---------------------------------------------------------------- scheduling
-- Outreach syncs must run even under the kill switch, because that is when the
-- sending service has to be paused. Every other rule is unchanged.
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
      -- The kill switch stops new sourcing and new writing
      and not (w.outreach_paused and q.type in ('lead_sourcing', 'copywriting'))
    order by q.created_at
    for update of q skip locked
    limit greatest(1, least(p_limit, 50))
  )
  returning j.*;
end;
$$;

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
    cross join (values ('lead_sourcing'), ('enrichment'), ('research'), ('copywriting'), ('email_outreach')) as t(type)
    where c.status = 'active'
      and not w.outreach_paused
      and c.niche is not null
      and (t.type <> 'email_outreach' or c.outreach_status = 'live')
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

revoke execute on function public.agent_jobs_claim(integer, integer) from public, anon, authenticated;
revoke execute on function public.agent_jobs_enqueue_due(integer) from public, anon, authenticated;
grant execute on function public.agent_jobs_claim(integer, integer) to service_role;
grant execute on function public.agent_jobs_enqueue_due(integer) to service_role;
