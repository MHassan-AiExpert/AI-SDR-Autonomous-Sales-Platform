-- =============================================================================
-- Answers and meeting booking (SRS M7 answering, M8 meeting booking)
--
-- Suggested answers can be edited and approved in the inbox (or approved by
-- the agent in autopilot) and are then sent as replies in the same Instantly
-- thread. Interested prospects get a single-use Calendly link; Calendly tells
-- the platform when a meeting is booked or cancelled.
-- =============================================================================

alter table public.agent_jobs drop constraint agent_jobs_type_check;
alter table public.agent_jobs add constraint agent_jobs_type_check
  check (type in ('campaign_plan', 'lead_sourcing', 'enrichment', 'research', 'copywriting', 'email_outreach',
                  'reply_handling', 'reply_send'));

alter table public.inbound_events drop constraint inbound_events_provider_check;
alter table public.inbound_events add constraint inbound_events_provider_check check (provider in ('instantly', 'calendly'));

-- ---------------------------------------------------------------- answers
alter table public.replies
  add column provider_email_id  text,
  add column email_account      text,
  add column answer             text check (length(answer) <= 3000),
  add column answer_status      text not null default 'none'
                                check (answer_status in ('none', 'draft', 'approved', 'sending', 'sent', 'failed')),
  add column answer_error       text,
  add column answered_at        timestamptz,
  add column answer_approved_by uuid references auth.users (id) on delete set null,
  add column booking_url        text check (booking_url ~ '^https://calendly\.com/');
create index replies_answer_queue_idx on public.replies (workspace_id, campaign_id) where answer_status = 'approved';

-- People write and approve answers; only the backend sends them
create function app.replies_client_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if current_user <> 'authenticated' then
    return new;
  end if;
  if old.answer_status in ('sending', 'sent') and (new.answer is distinct from old.answer or new.answer_status <> old.answer_status) then
    raise exception 'This answer has already been sent' using errcode = 'check_violation';
  end if;
  if new.answer_status not in ('none', 'draft', 'approved') and new.answer_status <> old.answer_status then
    raise exception 'Only the reply agent can send answers' using errcode = 'check_violation';
  end if;
  if new.body <> old.body or new.lead_id <> old.lead_id or new.classification is distinct from old.classification
     or new.provider_email_id is distinct from old.provider_email_id or new.email_account is distinct from old.email_account
     or new.booking_url is distinct from old.booking_url or new.answered_at is distinct from old.answered_at then
    raise exception 'Only the answer, its approval and the handled state can be changed' using errcode = 'check_violation';
  end if;
  if new.answer_status = 'approved' and old.answer_status <> 'approved' then
    if coalesce(length(trim(new.answer)), 0) < 10 then
      raise exception 'Write the answer before approving it' using errcode = 'check_violation';
    end if;
    new.answer_approved_by := auth.uid();
  elsif new.answer_status <> 'approved' then
    new.answer_approved_by := null;
  end if;
  return new;
end;
$$;
create trigger replies_client_guard before update on public.replies
  for each row execute function app.replies_client_guard();

-- Approving an answer starts the sender straight away
create function app.queue_reply_send()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.answer_status = 'approved' and old.answer_status is distinct from 'approved' and new.campaign_id is not null then
    insert into public.agent_jobs (workspace_id, campaign_id, type, requested_by)
    values (new.workspace_id, new.campaign_id, 'reply_send', null)
    on conflict do nothing;
  end if;
  return null;
end;
$$;
create trigger replies_queue_send after update on public.replies
  for each row execute function app.queue_reply_send();

-- ---------------------------------------------------------------- booking
alter table public.campaigns
  add column auto_answer        boolean not null default true,
  -- Calendly event type used for booking links; the first active one when empty
  add column booking_event_type text check (booking_event_type ~ '^https://api\.calendly\.com/event_types/[A-Za-z0-9-]+$');

-- Calendly webhook subscription per workspace; the signing key never leaves the backend
create table public.calendly_subscriptions (
  workspace_id      uuid primary key references public.workspaces (id) on delete cascade,
  subscription_uri  text not null,
  user_uri          text not null,
  organization_uri  text not null,
  signing_key       text not null,
  created_at        timestamptz not null default now()
);
alter table public.calendly_subscriptions enable row level security;
-- Deliberately no access for signed-in users
create policy calendly_subscriptions_none on public.calendly_subscriptions for select to authenticated using (false);
revoke all on public.calendly_subscriptions from anon, authenticated;
grant all on public.calendly_subscriptions to service_role;

alter table public.meetings drop constraint meetings_booked_via_check;
alter table public.meetings add constraint meetings_booked_via_check
  check (booked_via in ('email', 'sms', 'whatsapp', 'call', 'manual', 'calendly'));
alter table public.meetings
  add column campaign_id     uuid,
  add column ends_at         timestamptz,
  add column status          text not null default 'scheduled' check (status in ('scheduled', 'canceled', 'completed', 'no_show')),
  add column provider        text check (provider in ('calendly')),
  add column external_id     text,
  add column event_name      text,
  add column invitee_name    text,
  add column invitee_email   text,
  add column cancel_url      text check (cancel_url ~ '^https://calendly\.com/'),
  add column reschedule_url  text check (reschedule_url ~ '^https://calendly\.com/'),
  add constraint meetings_campaign_fk foreign key (workspace_id, campaign_id)
    references public.campaigns (workspace_id, id) on delete set null (campaign_id);
create unique index meetings_external_key on public.meetings (workspace_id, provider, external_id) where external_id is not null;
