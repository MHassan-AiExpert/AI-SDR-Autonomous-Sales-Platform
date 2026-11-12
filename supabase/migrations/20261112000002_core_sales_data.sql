-- =============================================================================
-- Core sales data: campaigns, companies, leads and everything that happens to a
-- lead (assets, activity, follow-ups, emails, calls, messages, replies,
-- meetings, deals), plus suppression, integrations, playbooks and run logs.
--
-- Tenant integrity is enforced twice:
--   1. Row-level security: users only reach rows of workspaces they belong to.
--   2. Composite foreign keys (workspace_id, id): a row can only reference
--      parents from its own workspace, even for callers that bypass RLS.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Campaigns
-- -----------------------------------------------------------------------------
create table public.campaigns (
  id                uuid primary key default gen_random_uuid(),
  workspace_id      uuid not null references public.workspaces (id) on delete cascade,
  name              text not null check (length(trim(name)) between 1 and 160),
  niche             text,
  icp               jsonb not null default '{}'::jsonb,
  offer             text,
  target_areas      jsonb not null default '[]'::jsonb,
  channels          jsonb not null default '{}'::jsonb,
  mode              text not null default 'autopilot' check (mode in ('autopilot', 'approval')),
  status            text not null default 'draft'
                    check (status in ('draft', 'active', 'paused', 'archived')),
  daily_lead_limit  integer not null default 100 check (daily_lead_limit between 0 and 100000),
  created_by        uuid default auth.uid() references auth.users (id) on delete set null,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  unique (workspace_id, id)
);

create index campaigns_workspace_status_idx on public.campaigns (workspace_id, status);

-- -----------------------------------------------------------------------------
-- Companies (the business a lead works for)
-- -----------------------------------------------------------------------------
create table public.companies (
  id              uuid primary key default gen_random_uuid(),
  workspace_id    uuid not null references public.workspaces (id) on delete cascade,
  name            text not null check (length(trim(name)) > 0),
  domain          text check (domain = lower(domain)),
  industry        text,
  size_band       text,
  location        text,
  google_rating   numeric(2, 1) check (google_rating between 0 and 5),
  google_reviews  integer check (google_reviews >= 0),
  social          jsonb not null default '{}'::jsonb,
  research_brief  text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (workspace_id, id)
);

create unique index companies_workspace_domain_key
  on public.companies (workspace_id, domain) where domain is not null;

-- -----------------------------------------------------------------------------
-- Leads
-- -----------------------------------------------------------------------------
create table public.leads (
  id                   uuid primary key default gen_random_uuid(),
  workspace_id         uuid not null references public.workspaces (id) on delete cascade,
  campaign_id          uuid,
  company_id           uuid,
  full_name            text,
  email                text,
  phone                text,
  phone_line_type      text check (phone_line_type in ('mobile', 'landline', 'voip', 'unknown')),
  title                text,
  linkedin_url         text,
  social_handles       jsonb not null default '{}'::jsonb,
  source_channel       text not null check (source_channel in (
                         'apollo', 'clay', 'google_maps', 'instagram', 'facebook', 'linkedin',
                         'tiktok', 'x', 'llm_search', 'csv', 'inbound_call', 'manual')),
  source_query         text,
  niche                text,
  verification_status  text not null default 'unverified' check (verification_status in (
                         'unverified', 'valid', 'invalid', 'catch_all', 'risky')),
  -- Consent basis per channel, for audit: {"email": "...", "voice": "...", "sms": "...", "whatsapp": "..."}
  consent              jsonb not null default '{}'::jsonb,
  score                smallint check (score between 0 and 100),
  ai_report            jsonb,
  stage                text not null default 'new' check (stage in (
                         'new', 'contacted', 'engaged', 'interested', 'meeting_booked',
                         'won', 'lost', 'not_interested', 'do_not_contact')),
  stage_changed_at     timestamptz not null default now(),
  owner_id             uuid references auth.users (id) on delete set null,
  next_follow_up_at    timestamptz,
  inbound_campaign     text,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  unique (workspace_id, id),
  constraint leads_contact_present check (
    email is not null or phone is not null or linkedin_url is not null or social_handles <> '{}'::jsonb),
  constraint leads_campaign_fk foreign key (workspace_id, campaign_id)
    references public.campaigns (workspace_id, id) on delete set null (campaign_id),
  constraint leads_company_fk foreign key (workspace_id, company_id)
    references public.companies (workspace_id, id) on delete set null (company_id)
);

-- One lead per email address inside a workspace (case-insensitive)
create unique index leads_workspace_email_key
  on public.leads (workspace_id, lower(email)) where email is not null;
create index leads_workspace_stage_idx     on public.leads (workspace_id, stage);
create index leads_workspace_owner_idx     on public.leads (workspace_id, owner_id);
create index leads_workspace_source_idx    on public.leads (workspace_id, source_channel);
create index leads_workspace_followup_idx  on public.leads (workspace_id, next_follow_up_at)
  where next_follow_up_at is not null;
create index leads_workspace_campaign_idx  on public.leads (workspace_id, campaign_id);
create index leads_workspace_phone_idx     on public.leads (workspace_id, phone) where phone is not null;

create function app.track_lead_stage()
returns trigger
language plpgsql
as $$
begin
  if new.stage is distinct from old.stage then
    new.stage_changed_at := now();
  end if;
  return new;
end;
$$;

create trigger leads_stage_tracking before update on public.leads
  for each row execute function app.track_lead_stage();

-- -----------------------------------------------------------------------------
-- Per-lead records
-- -----------------------------------------------------------------------------
create table public.assets (
  id              uuid primary key default gen_random_uuid(),
  workspace_id    uuid not null references public.workspaces (id) on delete cascade,
  lead_id         uuid not null,
  type            text not null check (type in ('audit', 'proposal')),
  pdf_url         text,
  web_url         text,
  views           integer not null default 0 check (views >= 0),
  seconds_viewed  integer not null default 0 check (seconds_viewed >= 0),
  created_at      timestamptz not null default now(),
  foreign key (workspace_id, lead_id) references public.leads (workspace_id, id) on delete cascade
);
create index assets_lead_idx on public.assets (workspace_id, lead_id);

create table public.activities (
  id            uuid primary key default gen_random_uuid(),
  workspace_id  uuid not null references public.workspaces (id) on delete cascade,
  lead_id       uuid not null,
  type          text not null check (type in (
                  'email', 'sms', 'whatsapp', 'call', 'reply', 'note', 'status_change',
                  'meeting', 'asset_view', 'task')),
  channel       text,
  summary       text not null,
  record_table  text,
  record_id     uuid,
  actor         text not null check (actor in ('ai', 'human', 'system')),
  actor_id      uuid references auth.users (id) on delete set null,
  created_at    timestamptz not null default now(),
  foreign key (workspace_id, lead_id) references public.leads (workspace_id, id) on delete cascade
);
create index activities_timeline_idx on public.activities (workspace_id, lead_id, created_at desc);

create table public.follow_ups (
  id            uuid primary key default gen_random_uuid(),
  workspace_id  uuid not null references public.workspaces (id) on delete cascade,
  lead_id       uuid not null,
  channel       text not null check (channel in ('email', 'voice', 'sms', 'whatsapp', 'linkedin', 'manual')),
  due_at        timestamptz not null,
  cadence_step  integer check (cadence_step >= 1),
  -- "Overdue" is derived: status = 'pending' and due_at < now()
  status        text not null default 'pending' check (status in ('pending', 'done', 'skipped')),
  assigned_to   uuid references auth.users (id) on delete set null,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  foreign key (workspace_id, lead_id) references public.leads (workspace_id, id) on delete cascade
);
create index follow_ups_due_idx on public.follow_ups (workspace_id, status, due_at);

create table public.emails (
  id               uuid primary key default gen_random_uuid(),
  workspace_id     uuid not null references public.workspaces (id) on delete cascade,
  lead_id          uuid not null,
  step             integer not null default 1 check (step >= 1),
  subject          text not null,
  body             text not null,
  variant          text,
  status           text not null default 'draft'
                   check (status in ('draft', 'approved', 'sent', 'bounced', 'failed')),
  -- Retries reuse the same key, so a message can never be sent twice
  idempotency_key  text not null,
  sent_at          timestamptz,
  created_at       timestamptz not null default now(),
  unique (workspace_id, idempotency_key),
  foreign key (workspace_id, lead_id) references public.leads (workspace_id, id) on delete cascade
);
create index emails_lead_idx on public.emails (workspace_id, lead_id, created_at desc);

create table public.calls (
  id                uuid primary key default gen_random_uuid(),
  workspace_id      uuid not null references public.workspaces (id) on delete cascade,
  lead_id           uuid not null,
  agent             text not null check (agent in ('caller', 'closer', 'receptionist', 'human')),
  direction         text not null check (direction in ('outbound', 'inbound')),
  from_number       text,
  duration_seconds  integer check (duration_seconds >= 0),
  outcome           text check (outcome in (
                      'booked', 'interested', 'callback', 'not_interested', 'wrong_number',
                      'do_not_call', 'voicemail', 'no_answer', 'failed')),
  recording_url     text,
  transcript        text,
  summary           text,
  handed_off        boolean not null default false,
  playbook_version  integer,
  idempotency_key   text not null,
  started_at        timestamptz,
  created_at        timestamptz not null default now(),
  unique (workspace_id, idempotency_key),
  foreign key (workspace_id, lead_id) references public.leads (workspace_id, id) on delete cascade
);
create index calls_lead_idx on public.calls (workspace_id, lead_id, created_at desc);

create table public.messages (
  id               uuid primary key default gen_random_uuid(),
  workspace_id     uuid not null references public.workspaces (id) on delete cascade,
  lead_id          uuid not null,
  channel          text not null check (channel in ('sms', 'whatsapp')),
  direction        text not null check (direction in ('outbound', 'inbound')),
  body             text not null,
  template         text,
  delivery_status  text not null default 'queued'
                   check (delivery_status in ('queued', 'sent', 'delivered', 'failed', 'received')),
  classification   text,
  idempotency_key  text not null,
  sent_at          timestamptz,
  created_at       timestamptz not null default now(),
  unique (workspace_id, idempotency_key),
  foreign key (workspace_id, lead_id) references public.leads (workspace_id, id) on delete cascade
);
create index messages_lead_idx on public.messages (workspace_id, lead_id, created_at desc);

create table public.replies (
  id              uuid primary key default gen_random_uuid(),
  workspace_id    uuid not null references public.workspaces (id) on delete cascade,
  lead_id         uuid not null,
  channel         text not null check (channel in ('email', 'sms', 'whatsapp', 'linkedin')),
  body            text not null,
  classification  text check (classification in (
                    'interested', 'question', 'objection', 'not_now', 'referral',
                    'out_of_office', 'wrong_person', 'unsubscribe', 'negative')),
  confidence      numeric(4, 3) check (confidence between 0 and 1),
  action_taken    text,
  handled_by      text check (handled_by in ('ai', 'human')),
  created_at      timestamptz not null default now(),
  foreign key (workspace_id, lead_id) references public.leads (workspace_id, id) on delete cascade
);
create index replies_lead_idx on public.replies (workspace_id, lead_id, created_at desc);

create table public.meetings (
  id             uuid primary key default gen_random_uuid(),
  workspace_id   uuid not null references public.workspaces (id) on delete cascade,
  lead_id        uuid not null,
  starts_at      timestamptz not null,
  zoom_url       text,
  booked_via     text not null check (booked_via in ('email', 'sms', 'whatsapp', 'call', 'manual')),
  run_by         text not null default 'ai_closer' check (run_by in ('ai_closer', 'human')),
  attended       boolean,
  recording_url  text,
  transcript     text,
  outcome        text,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  foreign key (workspace_id, lead_id) references public.leads (workspace_id, id) on delete cascade
);
create index meetings_schedule_idx on public.meetings (workspace_id, starts_at);

create table public.deals (
  id                uuid primary key default gen_random_uuid(),
  workspace_id      uuid not null references public.workspaces (id) on delete cascade,
  lead_id           uuid not null,
  stage             text not null default 'meeting_booked' check (stage in (
                      'meeting_booked', 'meeting_held', 'proposal_sent', 'negotiation', 'won', 'lost')),
  value_cents       bigint check (value_cents >= 0),
  currency          char(3) not null default 'USD',
  services          jsonb not null default '[]'::jsonb,
  quote_url         text,
  agreement_status  text not null default 'none'
                    check (agreement_status in ('none', 'sent', 'signed', 'declined')),
  payment_status    text not null default 'none'
                    check (payment_status in ('none', 'link_sent', 'paid', 'refunded')),
  closed_by         text check (closed_by in ('ai', 'human')),
  source_channel    text,
  lost_reason       text,
  closed_at         timestamptz,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  -- One open sales record per lead
  unique (workspace_id, lead_id),
  foreign key (workspace_id, lead_id) references public.leads (workspace_id, id) on delete cascade
);
create index deals_pipeline_idx on public.deals (workspace_id, stage);

-- -----------------------------------------------------------------------------
-- Suppression list: contacts that must never be reached, on any channel
-- -----------------------------------------------------------------------------
create table public.suppressions (
  id            uuid primary key default gen_random_uuid(),
  workspace_id  uuid not null references public.workspaces (id) on delete cascade,
  kind          text not null check (kind in ('email', 'phone', 'domain')),
  value         text not null check (value = lower(trim(value)) and length(value) > 0),
  reason        text not null check (reason in (
                  'unsubscribed', 'do_not_call', 'bounced', 'customer', 'competitor',
                  'complaint', 'manual')),
  created_by    uuid default auth.uid() references auth.users (id) on delete set null,
  created_at    timestamptz not null default now(),
  unique (workspace_id, kind, value)
);

-- True when an email address, its domain, or a phone number is suppressed
create function app.is_suppressed(ws uuid, p_email text default null, p_phone text default null)
returns boolean
language sql
stable
set search_path = ''
as $$
  select exists (
    select 1
    from public.suppressions s
    where s.workspace_id = ws
      and (
        (s.kind = 'email'  and p_email is not null and s.value = lower(trim(p_email)))
        or (s.kind = 'domain' and p_email is not null
            and s.value = split_part(lower(trim(p_email)), '@', 2))
        or (s.kind = 'phone'  and p_phone is not null and s.value = lower(trim(p_phone)))
      )
  );
$$;

-- -----------------------------------------------------------------------------
-- Integrations, playbooks, run logs
-- -----------------------------------------------------------------------------
create table public.integrations (
  id                    uuid primary key default gen_random_uuid(),
  workspace_id          uuid not null references public.workspaces (id) on delete cascade,
  tool                  text not null,
  status                text not null default 'disconnected'
                        check (status in ('connected', 'error', 'expired', 'disconnected')),
  -- Reference to the encrypted secret in the vault; the secret itself is never stored here
  secret_ref            text,
  last_health_check_at  timestamptz,
  credits_remaining     numeric,
  meta                  jsonb not null default '{}'::jsonb,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  unique (workspace_id, tool)
);

create table public.playbooks (
  id            uuid primary key default gen_random_uuid(),
  workspace_id  uuid not null references public.workspaces (id) on delete cascade,
  version       integer not null check (version >= 1),
  content       jsonb not null default '{}'::jsonb,
  guardrails    jsonb not null default '{}'::jsonb,
  is_active     boolean not null default false,
  created_by    uuid default auth.uid() references auth.users (id) on delete set null,
  created_at    timestamptz not null default now(),
  unique (workspace_id, version)
);
-- Exactly one playbook version can be live per workspace
create unique index playbooks_one_active_key on public.playbooks (workspace_id) where is_active;

create table public.run_logs (
  id              bigint generated always as identity primary key,
  workspace_id    uuid not null references public.workspaces (id) on delete cascade,
  workflow        text not null,
  status          text not null check (status in ('running', 'success', 'error')),
  error           text,
  -- Follows one lead's journey across every workflow and log line
  correlation_id  uuid,
  started_at      timestamptz not null default now(),
  finished_at     timestamptz
);
create index run_logs_workspace_idx   on public.run_logs (workspace_id, started_at desc);
create index run_logs_correlation_idx on public.run_logs (correlation_id) where correlation_id is not null;

-- -----------------------------------------------------------------------------
-- updated_at triggers
-- -----------------------------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array['campaigns', 'companies', 'leads', 'follow_ups', 'meetings', 'deals', 'integrations']
  loop
    execute format(
      'create trigger %I before update on public.%I for each row execute function app.touch_updated_at()',
      t || '_touch', t);
  end loop;
end $$;

-- -----------------------------------------------------------------------------
-- Row-level security
--   read   : any member of the workspace
--   write  : owner, admin, rep        (viewers are read-only)
--   delete : owner, admin
-- Configuration tables (campaigns, integrations, playbooks) are written by
-- owners and admins only. Run logs are written only by the service role.
-- -----------------------------------------------------------------------------
do $$
declare
  t text;
  writers text;
  config_tables text[] := array['campaigns', 'integrations', 'playbooks'];
begin
  foreach t in array array[
    'campaigns', 'companies', 'leads', 'assets', 'activities', 'follow_ups', 'emails', 'calls',
    'messages', 'replies', 'meetings', 'deals', 'suppressions', 'integrations', 'playbooks']
  loop
    writers := case when t = any (config_tables)
      then $r$array['owner', 'admin']::public.workspace_role[]$r$
      else $r$array['owner', 'admin', 'rep']::public.workspace_role[]$r$ end;

    execute format('alter table public.%I enable row level security', t);
    execute format(
      'create policy %I on public.%I for select to authenticated using (app.is_member(workspace_id))',
      t || '_select', t);
    execute format(
      'create policy %I on public.%I for insert to authenticated with check (app.has_role(workspace_id, %s))',
      t || '_insert', t, writers);
    execute format(
      'create policy %I on public.%I for update to authenticated using (app.has_role(workspace_id, %s)) with check (app.has_role(workspace_id, %s))',
      t || '_update', t, writers, writers);
    execute format(
      $f$create policy %I on public.%I for delete to authenticated using (app.has_role(workspace_id, array['owner', 'admin']::public.workspace_role[]))$f$,
      t || '_delete', t);

    execute format('revoke all on public.%I from anon', t);
    execute format('grant select, insert, update, delete on public.%I to authenticated', t);
    execute format('grant all on public.%I to service_role', t);
  end loop;
end $$;

alter table public.run_logs enable row level security;
create policy run_logs_select on public.run_logs for select to authenticated
  using (app.has_role(workspace_id, array['owner', 'admin']::public.workspace_role[]));
revoke all on public.run_logs from anon;
grant select on public.run_logs to authenticated;
grant all on public.run_logs to service_role;

grant execute on function app.is_suppressed(uuid, text, text) to authenticated, service_role;
