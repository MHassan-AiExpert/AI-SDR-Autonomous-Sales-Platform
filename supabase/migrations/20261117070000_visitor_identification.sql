-- =============================================================================
-- Website visitor identification, company level (F30)
--
-- A small script on the team's own website reports page views. The agent
-- service looks up which organisation the visitor's network belongs to
-- (reverse IP, through ipapi.is), keeps only business networks, and records
-- the visiting COMPANY, never the person. A visit from a company already in
-- the pipeline becomes a website_visit signal (F26), which a sequence step
-- can act on.
--
-- Privacy by design:
--   * no cookies, no fingerprinting, nothing stored in the visitor's browser
--   * browsers sending Global Privacy Control or Do Not Track are not counted
--   * the raw IP is kept only until it is looked up (at most a day), then
--     erased; only a one-way hash remains, to count repeat visits
--   * home, mobile, VPN, proxy, Tor and data-centre networks are discarded:
--     only organisations' own networks identify a company
-- =============================================================================

alter table public.workspaces
  add column visitor_tracking_enabled boolean not null default false,
  -- Embedded in the public script, so it identifies the site but grants nothing else
  add column visitor_site_key text unique default ('site_' || replace(gen_random_uuid()::text, '-', '')),
  -- The website hosts the script may report from, such as "acme.com"
  add column visitor_allowed_hosts text[] not null default '{}'
    check (cardinality(visitor_allowed_hosts) <= 10);

update public.workspaces set visitor_site_key = 'site_' || replace(gen_random_uuid()::text, '-', '') where visitor_site_key is null;
alter table public.workspaces alter column visitor_site_key set not null;
alter table public.workspaces add constraint workspaces_visitor_site_key_check check (visitor_site_key ~ '^site_[0-9a-f]{32}$');

-- ipapi.is can be connected in Setup
alter table public.integrations drop constraint integrations_tool_check;
alter table public.integrations add constraint integrations_tool_check check (tool in (
  'openai', 'anthropic', 'gemini', 'apollo', 'apify', 'zerobounce', 'instantly', 'twilio',
  'vapi', 'whatsapp', 'zoom', 'calendly', 'hubspot', 'slack', 'pandadoc', 'stripe',
  'hunter', 'pdl', 'pipedrive', 'salesforce', 'ipapi'));

-- ---------------------------------------------------------------- page views

create table public.site_visits (
  id              uuid primary key default gen_random_uuid(),
  workspace_id    uuid not null references public.workspaces (id) on delete cascade,
  -- Erased as soon as it is looked up, and at the latest after a day
  ip              text check (ip is null or ip ~ '^[0-9a-fA-F:.]{3,45}$'),
  ip_hash         text not null check (ip_hash ~ '^[0-9a-f]{64}$'),
  host            text not null check (host ~ '^[a-z0-9.-]{1,253}$'),
  path            text not null check (length(path) between 1 and 500),
  referrer_host   text check (referrer_host is null or referrer_host ~ '^[a-z0-9.-]{1,253}$'),
  status          text not null default 'pending' check (status in ('pending', 'identified', 'skipped')),
  -- Why a visit was not identified: home or mobile network, VPN, not connected...
  skip_reason     text check (length(skip_reason) <= 60),
  company_domain  text,
  created_at      timestamptz not null default now(),
  resolved_at     timestamptz,
  unique (workspace_id, id)
);
create index site_visits_pending_idx on public.site_visits (created_at) where status = 'pending';
create index site_visits_company_idx on public.site_visits (workspace_id, company_domain, created_at desc);
create index site_visits_rate_idx on public.site_visits (workspace_id, ip_hash, created_at desc);

-- One row per identified company per workspace
create table public.site_visitors (
  id              uuid primary key default gen_random_uuid(),
  workspace_id    uuid not null references public.workspaces (id) on delete cascade,
  company_domain  text not null check (company_domain ~ '^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$'),
  company_name    text check (length(company_name) <= 200),
  country_code    text check (country_code is null or country_code ~ '^[A-Z]{2}$'),
  -- The matching company in the workspace, when there is one
  company_id      uuid,
  visits          integer not null default 0,
  first_seen_at   timestamptz not null default now(),
  last_seen_at    timestamptz not null default now(),
  -- The most visited paths, {"/pricing": 3}
  top_paths       jsonb not null default '{}'::jsonb check (jsonb_typeof(top_paths) = 'object'),
  last_signal_at  timestamptz,
  unique (workspace_id, company_domain),
  unique (workspace_id, id),
  foreign key (workspace_id, company_id) references public.companies (workspace_id, id) on delete set null (company_id)
);
create index site_visitors_recent_idx on public.site_visitors (workspace_id, last_seen_at desc);

-- What a network was found to be, shared across workspaces because it says
-- nothing about any workspace; looked up again after 30 days
create table public.ip_lookups (
  ip_hash         text primary key check (ip_hash ~ '^[0-9a-f]{64}$'),
  company_domain  text,
  company_name    text,
  country_code    text,
  skip_reason     text,
  looked_up_at    timestamptz not null default now()
);

alter table public.site_visits enable row level security;
alter table public.site_visitors enable row level security;
alter table public.ip_lookups enable row level security;

create policy site_visitors_select on public.site_visitors for select to authenticated
  using (app.is_member(workspace_id));
-- Raw page views and the shared lookup cache belong to the agent service alone
create policy site_visits_none on public.site_visits for select to authenticated using (false);
create policy ip_lookups_none on public.ip_lookups for select to authenticated using (false);

revoke all on public.site_visits, public.site_visitors, public.ip_lookups from anon, authenticated;
-- Raw page views (with the temporary IP) are not readable by anyone but the agent service
grant select on public.site_visitors to authenticated;
grant all on public.site_visits, public.site_visitors, public.ip_lookups to service_role;

-- ---------------------------------------------------------------- recording

/**
 * Records one page view from the tracking script. Called without signing in:
 * the site key identifies the workspace and grants nothing else. Views from a
 * host the team did not list, beyond 60 an hour from one network, or beyond
 * 20,000 a day per workspace are dropped quietly.
 */
create function public.visit_record(p_key text, p_ip text, p_host text, p_path text, p_referrer text)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  w record;
  h text := lower(regexp_replace(coalesce(p_host, ''), '^www\.', ''));
  ref text := lower(regexp_replace(coalesce(p_referrer, ''), '^www\.', ''));
  hash text;
begin
  if p_key is null or p_key !~ '^site_[0-9a-f]{32}$' or p_ip is null or p_ip !~ '^[0-9a-fA-F:.]{3,45}$' then return false; end if;
  select id, visitor_tracking_enabled, visitor_allowed_hosts into w from public.workspaces where visitor_site_key = p_key;
  if w.id is null or not w.visitor_tracking_enabled then return false; end if;
  if h !~ '^[a-z0-9.-]{1,253}$' or not exists (
       select 1 from unnest(w.visitor_allowed_hosts) a where h = a or right(h, length(a) + 1) = '.' || a) then
    return false;
  end if;
  hash := encode(sha256(convert_to(w.id::text || '|' || p_ip, 'UTF8')), 'hex');
  if (select count(*) from public.site_visits where workspace_id = w.id and ip_hash = hash and created_at > now() - interval '1 hour') >= 60
     or (select count(*) from public.site_visits where workspace_id = w.id and created_at > now() - interval '1 day') >= 20000 then
    return false;
  end if;
  insert into public.site_visits (workspace_id, ip, ip_hash, host, path, referrer_host)
  values (w.id, p_ip, hash, h,
          coalesce(nullif(left(regexp_replace(coalesce(p_path, ''), '[?#].*$', ''), 500), ''), '/'),
          case when ref ~ '^[a-z0-9.-]{1,253}$' and ref <> h then ref end);
  return true;
end;
$$;

revoke execute on function public.visit_record(text, text, text, text, text) from public;
grant execute on function public.visit_record(text, text, text, text, text) to anon, authenticated, service_role;

/** Replaces the public site key, for owners and admins. */
create function public.workspace_rotate_site_key(ws uuid)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  k text := 'site_' || replace(gen_random_uuid()::text, '-', '');
begin
  if not app.has_role(ws, array['owner', 'admin']::public.workspace_role[]) then
    raise exception 'Only owners and admins can replace the site key' using errcode = '42501';
  end if;
  update public.workspaces set visitor_site_key = k where id = ws;
  return k;
end;
$$;
revoke execute on function public.workspace_rotate_site_key(uuid) from public, anon;
grant execute on function public.workspace_rotate_site_key(uuid) to authenticated, service_role;

/**
 * Pending views for the agent service, with the workspace each belongs to.
 * Each claim holds the views for ten minutes, so two workers never look up
 * the same one. Erases raw IPs older than a day first, whether looked up or
 * not, and trims page views older than 90 days.
 */
create function public.site_visits_claim(p_limit integer default 200)
returns table (id uuid, workspace_id uuid, ip text, ip_hash text, path text, created_at timestamptz)
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.site_visits v set ip = null, status = 'skipped', skip_reason = 'not looked up within a day', resolved_at = now()
  where v.status = 'pending' and v.created_at < now() - interval '1 day';
  update public.site_visits v set ip = null where v.ip is not null and v.status <> 'pending';
  delete from public.site_visits v where v.id in (select x.id from public.site_visits x where x.created_at < now() - interval '90 days' limit 5000);
  return query
  with due as (
    select x.id from public.site_visits x
    where x.status = 'pending' and x.ip is not null and (x.resolved_at is null or x.resolved_at < now() - interval '10 minutes')
    order by x.created_at
    limit greatest(1, least(coalesce(p_limit, 200), 1000))
    for update skip locked
  )
  update public.site_visits v set resolved_at = now()
  from due where v.id = due.id
  returning v.id, v.workspace_id, v.ip, v.ip_hash, v.path, v.created_at;
end;
$$;
revoke execute on function public.site_visits_claim(integer) from public, anon, authenticated;
grant execute on function public.site_visits_claim(integer) to service_role;
