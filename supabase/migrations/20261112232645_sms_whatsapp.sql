-- =============================================================================
-- SMS and WhatsApp follow-ups (SRS M8)
--
-- Leads who were emailed or called and have not answered get a short text
-- follow-up from the company's own Twilio number or WhatsApp sender. Texts go
-- only to leads with a recorded consent basis for that channel, inside contact
-- hours, within daily and per-lead limits, and always identify the sender with
-- a way to opt out. Replies come back through n8n and are handled by the reply
-- agent like email replies; STOP is honoured at once.
-- =============================================================================

alter table public.agent_jobs drop constraint agent_jobs_type_check;
alter table public.agent_jobs add constraint agent_jobs_type_check
  check (type in ('campaign_plan', 'lead_sourcing', 'enrichment', 'research', 'copywriting', 'email_outreach',
                  'reply_handling', 'reply_send', 'voice_outreach', 'sms_outreach'));

alter table public.inbound_events drop constraint inbound_events_provider_check;
alter table public.inbound_events add constraint inbound_events_provider_check
  check (provider in ('instantly', 'calendly', 'vapi', 'twilio'));

-- ---------------------------------------------------------------- campaigns
alter table public.campaigns
  add column sms_status            text not null default 'not_started' check (sms_status in ('not_started', 'live', 'paused')),
  add column sms_channel           text not null default 'sms' check (sms_channel in ('sms', 'whatsapp')),
  -- A Twilio number in E.164 form, or a Messaging Service SID
  add column sms_from              text check (sms_from ~ '^(\+[1-9][0-9]{6,14}|MG[0-9a-f]{32})$'),
  add column whatsapp_from         text check (whatsapp_from ~ '^\+[1-9][0-9]{6,14}$'),
  -- An approved WhatsApp template with {{1}} (first name) and {{2}} (the message)
  add column whatsapp_content_sid  text check (whatsapp_content_sid ~ '^HX[0-9a-f]{32}$'),
  add column sms_after_days        smallint not null default 3 check (sms_after_days between 1 and 30),
  add column sms_daily_limit       integer not null default 100 check (sms_daily_limit between 1 and 5000),
  add column sms_max_messages      smallint not null default 1 check (sms_max_messages between 1 and 3);

-- ---------------------------------------------------------------- messages
alter table public.messages drop constraint messages_delivery_status_check;
alter table public.messages add constraint messages_delivery_status_check
  check (delivery_status in ('queued', 'sent', 'delivered', 'read', 'failed', 'received'));

alter table public.messages
  add column campaign_id          uuid,
  add column provider             text check (provider in ('twilio')),
  add column provider_message_id  text check (provider_message_id ~ '^(SM|MM)[0-9a-f]{32}$'),
  add column step                 smallint check (step between 1 and 10),
  add column to_number            text,
  add column from_number          text,
  add column consent_basis        text,
  add column error                text check (length(error) <= 400),
  add column error_code           text check (error_code ~ '^[0-9]{1,6}$'),
  add column delivered_at         timestamptz,
  add constraint messages_body_length check (length(body) <= 2000),
  add constraint messages_campaign_fk foreign key (workspace_id, campaign_id)
    references public.campaigns (workspace_id, id) on delete set null (campaign_id);
create unique index messages_provider_key on public.messages (workspace_id, provider, provider_message_id) where provider_message_id is not null;
create index messages_campaign_day_idx on public.messages (workspace_id, campaign_id, created_at desc);

-- Texts the platform sends or receives through Twilio are its records: people
-- can log a text they sent themselves, but cannot change a Twilio record or
-- make a manual note look like one
create function app.messages_client_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if current_user <> 'authenticated' then
    return new;
  end if;
  if new.provider is not null or new.provider_message_id is not null then
    if tg_op = 'INSERT' or old.provider is null then
      raise exception 'Only the platform records texts sent through Twilio' using errcode = '42501';
    end if;
  end if;
  if tg_op = 'UPDATE' and old.provider is not null then
    raise exception 'Texts sent through Twilio cannot be changed' using errcode = '42501';
  end if;
  return new;
end;
$$;
create trigger messages_client_guard before insert or update on public.messages
  for each row execute function app.messages_client_guard();

-- Kill switch: no new texts while outreach is paused
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
      -- The kill switch stops new sourcing, writing, answers, calls and texts
      and not (w.outreach_paused and q.type in ('lead_sourcing', 'copywriting', 'reply_send', 'voice_outreach', 'sms_outreach'))
    order by q.created_at
    for update of q skip locked
    limit greatest(1, least(p_limit, 50))
  )
  returning j.*;
end;
$$;

-- Calls and texts run every hour inside contact hours; the rest once a day
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
    cross join (values ('lead_sourcing'), ('enrichment'), ('research'), ('copywriting'), ('email_outreach'),
                       ('voice_outreach'), ('sms_outreach')) as t(type)
    where c.status = 'active'
      and not w.outreach_paused
      and c.niche is not null
      and (t.type <> 'email_outreach' or c.outreach_status = 'live')
      and (t.type <> 'voice_outreach' or c.voice_status = 'live')
      and (t.type <> 'sms_outreach' or c.sms_status = 'live')
      and not exists (
        select 1 from public.agent_jobs j
        where j.campaign_id = c.id and j.type = t.type
          and (j.status in ('queued', 'running')
               or j.created_at > now() - make_interval(hours => case when t.type in ('voice_outreach', 'sms_outreach') then 1 else greatest(1, p_hours) end))
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
