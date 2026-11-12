-- =============================================================================
-- AI voice calling (SRS M12)
--
-- The voice agent calls qualified leads through the company's own Vapi
-- assistant and number, only inside calling hours, only within daily and
-- per-lead limits, and only where calling is lawful: mobile numbers need a
-- recorded consent basis, and business landlines need the owner's attestation
-- that the numbers were screened against Do Not Call registries.
-- =============================================================================

alter table public.agent_jobs drop constraint agent_jobs_type_check;
alter table public.agent_jobs add constraint agent_jobs_type_check
  check (type in ('campaign_plan', 'lead_sourcing', 'enrichment', 'research', 'copywriting', 'email_outreach',
                  'reply_handling', 'reply_send', 'voice_outreach'));

alter table public.inbound_events drop constraint inbound_events_provider_check;
alter table public.inbound_events add constraint inbound_events_provider_check check (provider in ('instantly', 'calendly', 'vapi'));

-- ---------------------------------------------------------------- campaigns
alter table public.campaigns
  add column voice_status          text not null default 'not_started' check (voice_status in ('not_started', 'live', 'paused')),
  add column vapi_assistant_id     text check (vapi_assistant_id ~ '^[0-9a-f-]{36}$'),
  add column vapi_phone_number_id  text check (vapi_phone_number_id ~ '^[0-9a-f-]{36}$'),
  add column call_timezone         text not null default 'America/Chicago',
  add column call_window_start     text not null default '10:00' check (call_window_start ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'),
  add column call_window_end       text not null default '16:00' check (call_window_end ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'),
  add column call_days             jsonb not null default '{"0":false,"1":true,"2":true,"3":true,"4":true,"5":true,"6":false}'::jsonb,
  add column call_daily_limit      integer not null default 30 check (call_daily_limit between 1 and 2000),
  add column call_max_attempts     smallint not null default 2 check (call_max_attempts between 1 and 5),
  -- Who may be called: only leads with a recorded consent basis, or also business landlines
  add column call_rule             text not null default 'consent_only' check (call_rule in ('consent_only', 'consent_or_business_landline')),
  add column dnc_attested_at       timestamptz,
  add column dnc_attested_by       uuid references auth.users (id) on delete set null;

-- ---------------------------------------------------------------- calls
alter table public.calls
  add column campaign_id       uuid,
  add column provider          text check (provider in ('vapi')),
  add column provider_call_id  text,
  add column status            text not null default 'queued' check (status in ('queued', 'ringing', 'in_progress', 'ended', 'failed')),
  add column attempt           smallint not null default 1 check (attempt between 1 and 10),
  add column to_number         text,
  add column ended_reason      text,
  add column ended_at          timestamptz,
  add column analysis          jsonb,
  add column error             text,
  add constraint calls_campaign_fk foreign key (workspace_id, campaign_id)
    references public.campaigns (workspace_id, id) on delete set null (campaign_id),
  add constraint calls_recording_https check (recording_url ~ '^https://');
create unique index calls_provider_key on public.calls (workspace_id, provider, provider_call_id) where provider_call_id is not null;
create index calls_campaign_day_idx on public.calls (workspace_id, campaign_id, created_at desc);

-- Recording a consent basis, or attesting to registry screening, is recorded with who and when
create function app.voice_consent_stamp()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_table_name = 'campaigns' then
    if new.dnc_attested_at is distinct from old.dnc_attested_at then
      new.dnc_attested_by := case when new.dnc_attested_at is null then null else auth.uid() end;
      if new.dnc_attested_at is not null then new.dnc_attested_at := now(); end if;
    end if;
  end if;
  return new;
end;
$$;
create trigger campaigns_voice_consent_stamp before update on public.campaigns
  for each row execute function app.voice_consent_stamp();

-- Kill switch: no new calls while outreach is paused
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
      -- The kill switch stops new sourcing, writing, answers and calls
      and not (w.outreach_paused and q.type in ('lead_sourcing', 'copywriting', 'reply_send', 'voice_outreach'))
    order by q.created_at
    for update of q skip locked
    limit greatest(1, least(p_limit, 50))
  )
  returning j.*;
end;
$$;

-- Calls run every hour inside the window, not once a day, so live campaigns
-- get a voice job whenever none ran in the last hour
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
    cross join (values ('lead_sourcing'), ('enrichment'), ('research'), ('copywriting'), ('email_outreach'), ('voice_outreach')) as t(type)
    where c.status = 'active'
      and not w.outreach_paused
      and c.niche is not null
      and (t.type <> 'email_outreach' or c.outreach_status = 'live')
      and (t.type <> 'voice_outreach' or c.voice_status = 'live')
      and not exists (
        select 1 from public.agent_jobs j
        where j.campaign_id = c.id and j.type = t.type
          and (j.status in ('queued', 'running')
               or j.created_at > now() - make_interval(hours => case when t.type = 'voice_outreach' then 1 else greatest(1, p_hours) end))
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
