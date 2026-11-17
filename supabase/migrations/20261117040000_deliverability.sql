-- =============================================================================
-- Deliverability dashboard (F27)
--
-- Automatic pausing on bounce and opt-out spikes already exists (F19). This
-- adds the view a team needs before things go wrong: whether each sending
-- domain is set up the way receivers now require, whether it is on a
-- blocklist, and how each mailbox is doing.
--
-- Two tables, both written only by the agent service:
--   sending_domains : SPF, DKIM, DMARC, MX and blocklist results per domain
--   mailboxes       : each Instantly mailbox's status and warm-up health
-- and one function reading what was already stored: per-mailbox sends,
-- bounces, replies and opt-outs, from Instantly's own webhook events.
--
-- Checks run once a day per workspace, inside the existing monitoring sweep,
-- so no new job type or workflow is needed.
-- =============================================================================

create table public.sending_domains (
  id               uuid primary key default gen_random_uuid(),
  workspace_id     uuid not null references public.workspaces (id) on delete cascade,
  domain           text not null check (domain ~ '^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$'),
  -- A DKIM selector the team gives when it is not one of the common ones
  dkim_selector    text check (dkim_selector is null or dkim_selector ~ '^[A-Za-z0-9._-]{1,63}$'),
  spf_status       text check (spf_status in ('pass', 'warn', 'fail', 'unknown')),
  spf_record       text check (length(spf_record) <= 2000),
  spf_lookups      smallint,
  dkim_status      text check (dkim_status in ('pass', 'warn', 'fail', 'unknown')),
  dkim_found       text[],
  dmarc_status     text check (dmarc_status in ('pass', 'warn', 'fail', 'unknown')),
  dmarc_policy     text check (dmarc_policy in ('none', 'quarantine', 'reject')),
  dmarc_record     text check (length(dmarc_record) <= 2000),
  mx_status        text check (mx_status in ('pass', 'warn', 'fail', 'unknown')),
  -- [{"list": "Spamhaus DBL", "status": "listed" | "clear" | "unknown", "detail": "..."}]
  blocklists       jsonb not null default '[]'::jsonb check (jsonb_typeof(blocklists) = 'array'),
  -- [{"severity": "fail" | "warn", "check": "spf", "message": "...", "fix": "..."}]
  issues           jsonb not null default '[]'::jsonb check (jsonb_typeof(issues) = 'array'),
  score            smallint check (score between 0 and 100),
  checked_at       timestamptz,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  unique (workspace_id, domain),
  unique (workspace_id, id)
);

create table public.mailboxes (
  id               uuid primary key default gen_random_uuid(),
  workspace_id     uuid not null references public.workspaces (id) on delete cascade,
  email            text not null check (email = lower(email) and email ~ '^[^@\s]+@[^@\s]+\.[a-z]{2,}$'),
  domain           text not null,
  provider         text check (provider in ('google', 'microsoft', 'smtp', 'aws', 'airmail', 'other')),
  status           text not null default 'unknown'
                   check (status in ('active', 'paused', 'maintenance', 'connection_error', 'soft_bounce_error', 'sending_error', 'unknown')),
  warmup_status    text not null default 'unknown'
                   check (warmup_status in ('active', 'paused', 'banned', 'spam_folder_unknown', 'suspended', 'unknown')),
  warmup_score     smallint check (warmup_score between 0 and 100),
  daily_limit      integer check (daily_limit >= 0),
  setup_pending    boolean,
  checked_at       timestamptz not null default now(),
  created_at       timestamptz not null default now(),
  unique (workspace_id, email),
  unique (workspace_id, id)
);
create index mailboxes_domain_idx on public.mailboxes (workspace_id, domain);

create trigger sending_domains_touch before update on public.sending_domains
  for each row execute function app.touch_updated_at();

alter table public.sending_domains enable row level security;
alter table public.mailboxes enable row level security;

create policy sending_domains_select on public.sending_domains for select to authenticated
  using (app.is_member(workspace_id));
-- The one thing a person sets: the DKIM selector, when it is not a common one
create policy sending_domains_update on public.sending_domains for update to authenticated
  using (app.has_role(workspace_id, array['owner', 'admin']::public.workspace_role[]))
  with check (app.has_role(workspace_id, array['owner', 'admin']::public.workspace_role[]));
create policy mailboxes_select on public.mailboxes for select to authenticated
  using (app.is_member(workspace_id));

-- New tables here arrive with full rights for signed-in users; take them back
revoke all on public.sending_domains, public.mailboxes from anon, authenticated;
grant select on public.sending_domains, public.mailboxes to authenticated;
grant update (dkim_selector) on public.sending_domains to authenticated;
grant all on public.sending_domains, public.mailboxes to service_role;

-- When the domains and mailboxes were last checked; null means "check soon"
alter table public.workspaces add column deliverability_checked_at timestamptz;

-- ---------------------------------------------------------------- per mailbox
-- Sends, bounces, replies and opt-outs per mailbox, from Instantly's own
-- webhook events. Instantly marks the mailbox field optional, so events that
-- do not name one are counted together under an empty address rather than
-- dropped or guessed.
--
-- The raw events are visible to owners and admins only, because they carry
-- lead addresses and message details. These are counts per mailbox, with no
-- lead data, so every member may see them: the function reads the events
-- itself and checks membership first, rather than inheriting the narrower
-- rule on the table.
create function public.mailbox_stats(ws uuid, p_days integer default 30)
returns table (email_account text, sent bigint, bounced bigint, replied bigint, unsubscribed bigint)
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(nullif(lower(trim(e.payload->>'email_account')), ''), '') as email_account,
         count(*) filter (where e.event_type = 'email_sent'),
         count(*) filter (where e.event_type = 'email_bounced'),
         count(*) filter (where e.event_type = 'reply_received'),
         count(*) filter (where e.event_type = 'lead_unsubscribed')
  from public.inbound_events e
  where app.is_member(ws) and e.workspace_id = ws and e.provider = 'instantly'
    and e.event_type in ('email_sent', 'email_bounced', 'reply_received', 'lead_unsubscribed')
    and e.received_at > now() - make_interval(days => greatest(1, least(coalesce(p_days, 30), 90)))
  group by 1
  order by 2 desc;
$$;

revoke execute on function public.mailbox_stats(uuid, integer) from public, anon;
grant execute on function public.mailbox_stats(uuid, integer) to authenticated, service_role;
