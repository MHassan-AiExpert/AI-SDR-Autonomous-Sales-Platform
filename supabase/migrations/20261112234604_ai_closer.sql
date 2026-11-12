-- =============================================================================
-- AI closer (SRS M18, M19, M20)
--
-- At the booked time the AI closer calls the prospect on the number they gave
-- for the meeting, runs the conversation from the company's playbook, and
-- records the result. When the prospect agrees, the platform creates a Stripe
-- payment link at the playbook price and sends the PandaDoc proposal that
-- carries it; a completed payment wins the deal. Anything outside the
-- playbook goes to the team.
-- =============================================================================

alter table public.agent_jobs drop constraint agent_jobs_type_check;
alter table public.agent_jobs add constraint agent_jobs_type_check
  check (type in ('campaign_plan', 'lead_sourcing', 'enrichment', 'research', 'copywriting', 'email_outreach',
                  'reply_handling', 'reply_send', 'voice_outreach', 'sms_outreach', 'ai_closer'));

alter table public.inbound_events drop constraint inbound_events_provider_check;
alter table public.inbound_events add constraint inbound_events_provider_check
  check (provider in ('instantly', 'calendly', 'vapi', 'twilio', 'stripe'));

-- ---------------------------------------------------------------- campaigns
alter table public.campaigns
  add column vapi_closer_assistant_id text check (vapi_closer_assistant_id ~ '^[0-9a-f-]{36}$');

-- ---------------------------------------------------------------- meetings
alter table public.meetings
  -- The number the prospect gave for this meeting (Calendly "we call you" or a phone question)
  add column phone          text check (phone ~ '^\+[1-9][0-9]{6,14}$'),
  add column closer_status  text not null default 'pending'
                            check (closer_status in ('pending', 'calling', 'held', 'no_answer', 'handed_off', 'failed')),
  add column closer_note    text check (length(closer_note) <= 400),
  add column call_id        uuid,
  add column summary        text check (length(summary) <= 1200),
  add constraint meetings_call_fk foreign key (call_id) references public.calls (id) on delete set null;
create index meetings_closer_due_idx on public.meetings (starts_at) where status = 'scheduled' and run_by = 'ai_closer' and closer_status = 'pending';

-- ---------------------------------------------------------------- deals
alter table public.deals
  add column campaign_id             uuid,
  add column meeting_id              uuid references public.meetings (id) on delete set null,
  add column plan_name               text check (length(plan_name) <= 120),
  add column billing_interval        text check (billing_interval in ('one_time', 'month', 'year')),
  add column close_status            text not null default 'none'
                                     check (close_status in ('none', 'pending', 'sending', 'sent', 'needs_team', 'failed')),
  add column close_error             text check (length(close_error) <= 400),
  add column close_attempts          smallint not null default 0 check (close_attempts between 0 and 10),
  add column payment_url             text check (payment_url ~ '^https://(buy\.stripe\.com|checkout\.stripe\.com)/'),
  add column stripe_payment_link_id  text check (stripe_payment_link_id ~ '^plink_[A-Za-z0-9]{8,100}$'),
  add column pandadoc_document_id    text check (pandadoc_document_id ~ '^[A-Za-z0-9]{10,40}$'),
  add column paid_at                 timestamptz,
  add constraint deals_quote_https check (quote_url ~ '^https://'),
  add constraint deals_campaign_fk foreign key (workspace_id, campaign_id)
    references public.campaigns (workspace_id, id) on delete set null (campaign_id);
create unique index deals_payment_link_key on public.deals (workspace_id, stripe_payment_link_id) where stripe_payment_link_id is not null;
create index deals_close_queue_idx on public.deals (workspace_id, campaign_id) where close_status = 'pending';

-- Proposal and payment links come from PandaDoc and Stripe; people can move a
-- deal through the pipeline and record an offline payment, but cannot change
-- those links or start the platform's sending steps themselves
create function app.deals_client_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if current_user <> 'authenticated' then
    return new;
  end if;
  if tg_op = 'INSERT' then
    if new.stripe_payment_link_id is not null or new.payment_url is not null or new.pandadoc_document_id is not null
       or new.close_status not in ('none', 'needs_team') then
      raise exception 'Proposal and payment links are set by the platform' using errcode = '42501';
    end if;
    return new;
  end if;
  if new.stripe_payment_link_id is distinct from old.stripe_payment_link_id
     or new.payment_url is distinct from old.payment_url
     or new.pandadoc_document_id is distinct from old.pandadoc_document_id
     or (new.close_status is distinct from old.close_status and new.close_status not in ('none', 'needs_team')) then
    raise exception 'Proposal and payment links are set by the platform' using errcode = '42501';
  end if;
  return new;
end;
$$;
create trigger deals_client_guard before insert or update on public.deals
  for each row execute function app.deals_client_guard();

-- ---------------------------------------------------------------- Stripe webhook endpoint per workspace
create table public.stripe_endpoints (
  workspace_id    uuid primary key references public.workspaces (id) on delete cascade,
  endpoint_id     text not null check (endpoint_id ~ '^we_[A-Za-z0-9]{8,100}$'),
  signing_secret  text not null check (signing_secret ~ '^whsec_[A-Za-z0-9]{16,200}$'),
  created_at      timestamptz not null default now()
);
alter table public.stripe_endpoints enable row level security;
-- Deliberately no access for signed-in users: the signing secret stays on the server
create policy stripe_endpoints_none on public.stripe_endpoints for select to authenticated using (false);
revoke all on public.stripe_endpoints from anon, authenticated;
grant all on public.stripe_endpoints to service_role;

-- Publishing a playbook makes a new version the live one in one step; the
-- caller's own permissions apply (owners and admins write playbooks)
create function public.playbook_publish(ws uuid, p_content jsonb)
returns integer
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v integer;
begin
  if jsonb_typeof(p_content) <> 'object' or pg_column_size(p_content) > 64000 then
    raise exception 'The playbook is not valid' using errcode = 'check_violation';
  end if;
  select coalesce(max(version), 0) + 1 into v from public.playbooks where workspace_id = ws;
  update public.playbooks set is_active = false where workspace_id = ws and is_active;
  insert into public.playbooks (workspace_id, version, content, is_active) values (ws, v, p_content, true);
  return v;
end;
$$;
revoke execute on function public.playbook_publish(uuid, jsonb) from public, anon;
grant execute on function public.playbook_publish(uuid, jsonb) to authenticated, service_role;

-- Kill switch: the closer also waits while outreach is paused
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
      -- The kill switch stops new sourcing, writing, answers, calls, texts and closing
      and not (w.outreach_paused and q.type in ('lead_sourcing', 'copywriting', 'reply_send', 'voice_outreach', 'sms_outreach', 'ai_closer'))
    order by q.created_at
    for update of q skip locked
    limit greatest(1, least(p_limit, 50))
  )
  returning j.*;
end;
$$;

-- Daily pipeline, hourly calls and texts, and a closer run as soon as an AI-run
-- meeting is about to start
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

  with work as (
    -- AI-run meetings about to start, or just started
    select m.workspace_id, m.campaign_id
    from public.meetings m
    join public.workspaces w on w.id = m.workspace_id
    where m.status = 'scheduled' and m.run_by = 'ai_closer' and m.closer_status = 'pending'
      and m.campaign_id is not null and w.ai_closer_enabled and not w.outreach_paused
      and m.starts_at <= now() + interval '1 minute' and m.starts_at > now() - interval '15 minutes'
    union
    -- Agreed deals whose proposal and payment link are still to be sent
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

revoke execute on function public.agent_jobs_claim(integer, integer) from public, anon, authenticated;
revoke execute on function public.agent_jobs_enqueue_due(integer) from public, anon, authenticated;
grant execute on function public.agent_jobs_claim(integer, integer) to service_role;
grant execute on function public.agent_jobs_enqueue_due(integer) to service_role;
