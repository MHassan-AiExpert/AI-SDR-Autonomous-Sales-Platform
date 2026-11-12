-- =============================================================================
-- Inbound events and AI reply handling (SRS M7, M11 alerts)
--
-- Instantly posts sends, replies, bounces and unsubscribes to a per-workspace
-- webhook address. Each event is stored once, then the reply agent classifies
-- replies, updates the lead, suppresses opt-outs and bounces, drafts a
-- suggested answer and alerts the team in Slack.
-- =============================================================================

alter table public.agent_jobs drop constraint agent_jobs_type_check;
alter table public.agent_jobs add constraint agent_jobs_type_check
  check (type in ('campaign_plan', 'lead_sourcing', 'enrichment', 'research', 'copywriting', 'email_outreach', 'reply_handling'));

-- A secret address per workspace for incoming webhooks, and where alerts go
alter table public.workspaces
  add column webhook_token text not null unique
    default replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', ''),
  add column slack_channel text check (slack_channel ~ '^(#[a-z0-9._-]{1,80}|[CGD][A-Z0-9]{8,12})$');

-- Emails a sequence will no longer send, because the lead replied, bounced or opted out
alter table public.emails drop constraint emails_status_check;
alter table public.emails add constraint emails_status_check
  check (status in ('draft', 'approved', 'rejected', 'queued', 'sent', 'bounced', 'failed', 'cancelled'));

create table public.inbound_events (
  id            uuid primary key default gen_random_uuid(),
  workspace_id  uuid not null references public.workspaces (id) on delete cascade,
  campaign_id   uuid,
  provider      text not null check (provider in ('instantly')),
  event_type    text not null check (length(event_type) between 1 and 80),
  lead_email    text,
  payload       jsonb not null default '{}'::jsonb,
  -- The same delivery retried by the provider is stored once
  dedupe_key    text not null,
  status        text not null default 'received' check (status in ('received', 'processed', 'ignored', 'failed')),
  error         text,
  received_at   timestamptz not null default now(),
  processed_at  timestamptz,
  unique (workspace_id, provider, dedupe_key),
  foreign key (workspace_id, campaign_id) references public.campaigns (workspace_id, id) on delete set null (campaign_id)
);
create index inbound_events_queue_idx on public.inbound_events (workspace_id, campaign_id, received_at) where status = 'received';

alter table public.inbound_events enable row level security;
create policy inbound_events_select on public.inbound_events for select to authenticated
  using (app.has_role(workspace_id, array['owner', 'admin']::public.workspace_role[]));
revoke all on public.inbound_events from anon, authenticated;
grant select on public.inbound_events to authenticated;
grant all on public.inbound_events to service_role;

alter table public.replies
  add column campaign_id         uuid,
  add column inbound_event_id    uuid references public.inbound_events (id) on delete set null,
  add column subject             text,
  add column summary             text check (length(summary) <= 400),
  add column suggested_response  text check (length(suggested_response) <= 3000),
  add column conversation_url    text check (conversation_url ~ '^https://([a-z0-9-]+\.)*instantly\.ai/'),
  add column handled_at          timestamptz,
  add constraint replies_campaign_fk foreign key (workspace_id, campaign_id)
    references public.campaigns (workspace_id, id) on delete set null (campaign_id);
create unique index replies_inbound_event_key on public.replies (inbound_event_id) where inbound_event_id is not null;
create index replies_inbox_idx on public.replies (workspace_id, handled_at, created_at desc);

-- Owners and admins can replace the webhook address if it leaks
create function public.workspace_rotate_webhook_token(ws uuid)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  token text := replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', '');
begin
  if not app.has_role(ws, array['owner', 'admin']::public.workspace_role[]) then
    raise exception 'Only owners and admins can change the webhook address' using errcode = '42501';
  end if;
  update public.workspaces set webhook_token = token where id = ws;
  return token;
end;
$$;
revoke execute on function public.workspace_rotate_webhook_token(uuid) from public, anon;
grant execute on function public.workspace_rotate_webhook_token(uuid) to authenticated, service_role;
