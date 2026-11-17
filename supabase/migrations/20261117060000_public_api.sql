-- =============================================================================
-- Public API and outbound webhooks (F29)
--
-- Two ways for other systems to work with a workspace, without a person
-- signing in, and without Zapier or Make having to be built for:
--
--   API keys    : scoped, per workspace, shown once, stored only as a SHA-256
--                 hash. Every request goes through api_call(), which checks
--                 the key, its scope and a per-key rate limit, then does only
--                 what that action allows. No key reaches a table directly.
--   Webhooks    : endpoints the team registers; events (a lead created or
--                 changing stage, a reply, a meeting booked, a deal won or
--                 lost) are queued by triggers as deliveries, which the agent
--                 service signs and sends with retries.
-- =============================================================================

-- Leads can arrive through the API
alter table public.leads drop constraint leads_source_channel_check;
alter table public.leads add constraint leads_source_channel_check check (source_channel in (
  'apollo', 'clay', 'google_maps', 'instagram', 'facebook', 'linkedin',
  'tiktok', 'x', 'llm_search', 'csv', 'inbound_call', 'manual', 'api'));

-- ---------------------------------------------------------------- API keys

create table public.api_keys (
  id            uuid primary key default gen_random_uuid(),
  workspace_id  uuid not null references public.workspaces (id) on delete cascade,
  name          text not null check (length(trim(name)) between 1 and 80),
  -- The first characters of the key, so a person can tell keys apart
  prefix        text not null check (prefix ~ '^sdr_[0-9a-f]{8}$'),
  key_hash      text not null unique check (key_hash ~ '^[0-9a-f]{64}$'),
  scopes        text[] not null check (
                  cardinality(scopes) between 1 and 6
                  and scopes <@ array['leads:read', 'leads:write', 'deals:read', 'campaigns:read', 'meetings:read']::text[]),
  created_by    uuid references auth.users (id) on delete set null,
  created_at    timestamptz not null default now(),
  last_used_at  timestamptz,
  revoked_at    timestamptz,
  -- A fixed one-minute window per key
  window_start  timestamptz,
  window_count  integer not null default 0,
  unique (workspace_id, id)
);
create index api_keys_workspace_idx on public.api_keys (workspace_id) where revoked_at is null;

alter table public.api_keys enable row level security;
create policy api_keys_select on public.api_keys for select to authenticated
  using (app.has_role(workspace_id, array['owner', 'admin']::public.workspace_role[]));
revoke all on public.api_keys from anon, authenticated;
-- The hash and the rate-limit counters are never readable by a person
grant select (id, workspace_id, name, prefix, scopes, created_by, created_at, last_used_at, revoked_at) on public.api_keys to authenticated;
grant all on public.api_keys to service_role;

-- The key is returned once and never stored: only its hash is kept
create function public.api_key_create(ws uuid, p_name text, p_scopes text[])
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  k text := 'sdr_' || replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', '');
  new_id uuid;
begin
  if not app.has_role(ws, array['owner', 'admin']::public.workspace_role[]) then
    raise exception 'Only owners and admins can create API keys' using errcode = '42501';
  end if;
  if p_name is null or length(trim(p_name)) not between 1 and 80 then
    raise exception 'Give the key a name of 1 to 80 characters' using errcode = '22023';
  end if;
  if p_scopes is null or cardinality(p_scopes) = 0
     or not (p_scopes <@ array['leads:read', 'leads:write', 'deals:read', 'campaigns:read', 'meetings:read']::text[]) then
    raise exception 'Choose at least one scope: leads:read, leads:write, deals:read, campaigns:read or meetings:read' using errcode = '22023';
  end if;
  if (select count(*) from public.api_keys where workspace_id = ws and revoked_at is null) >= 20 then
    raise exception 'A workspace can have at most 20 active API keys. Revoke one first.' using errcode = '22023';
  end if;
  insert into public.api_keys (workspace_id, name, prefix, key_hash, scopes, created_by)
  values (ws, trim(p_name), left(k, 12), encode(sha256(convert_to(k, 'UTF8')), 'hex'),
          (select array_agg(distinct s order by s) from unnest(p_scopes) s), auth.uid())
  returning id into new_id;
  return jsonb_build_object('id', new_id, 'key', k);
end;
$$;

create function public.api_key_revoke(p_id uuid)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  ws uuid;
begin
  select workspace_id into ws from public.api_keys where id = p_id;
  if ws is null or not app.has_role(ws, array['owner', 'admin']::public.workspace_role[]) then
    raise exception 'API key not found' using errcode = 'P0002';
  end if;
  update public.api_keys set revoked_at = coalesce(revoked_at, now()) where id = p_id;
  return true;
end;
$$;

-- ---------------------------------------------------------------- API calls

create function app.api_lead(l public.leads)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'id', l.id, 'email', l.email, 'full_name', l.full_name, 'phone', l.phone, 'title', l.title,
    'linkedin_url', l.linkedin_url, 'stage', l.stage, 'score', l.score, 'campaign_id', l.campaign_id,
    'source', l.source_channel, 'company', (
      select jsonb_build_object('id', c.id, 'name', c.name, 'domain', c.domain)
      from public.companies c where c.workspace_id = l.workspace_id and c.id = l.company_id),
    'created_at', l.created_at, 'updated_at', l.updated_at);
$$;

/** Reads a page size: 1 to 100, 50 when absent. */
create function app.api_limit(p jsonb)
returns integer
language sql
immutable
set search_path = ''
as $$
  select case when coalesce(p->>'limit', '') ~ '^[0-9]{1,3}$' then greatest(1, least((p->>'limit')::int, 100)) else 50 end;
$$;

/** A cursor is "<timestamp>|<uuid>" from the previous page; anything else is refused. */
create function app.api_cursor(p jsonb, out at timestamptz, out id uuid)
language plpgsql
immutable
set search_path = ''
as $$
declare
  c text := p->>'cursor';
begin
  if c is null or c = '' then return; end if;
  if c !~ '^[0-9T:.+\- ]{10,40}\|[0-9a-f-]{36}$' then
    raise exception 'The cursor is not valid' using errcode = '22023';
  end if;
  at := split_part(c, '|', 1)::timestamptz;
  id := split_part(c, '|', 2)::uuid;
exception when invalid_datetime_format or invalid_text_representation or datetime_field_overflow then
  raise exception 'The cursor is not valid' using errcode = '22023';
end;
$$;

create function app.api_time(p jsonb, k text)
returns timestamptz
language plpgsql
immutable
set search_path = ''
as $$
begin
  if coalesce(p->>k, '') = '' then return null; end if;
  -- ISO 8601 only: Postgres would otherwise also accept words such as "yesterday"
  if p->>k !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}([T ][0-9]{2}:[0-9]{2}(:[0-9]{2}(\.[0-9]{1,6})?)?)?(Z|[+-][0-9]{2}(:?[0-9]{2})?)?$' then
    raise exception '% must be an ISO 8601 date and time', k using errcode = '22023';
  end if;
  return (p->>k)::timestamptz;
exception when invalid_datetime_format or datetime_field_overflow then
  raise exception '% must be an ISO 8601 date and time', k using errcode = '22023';
end;
$$;

create function app.api_uuid(p jsonb, k text)
returns uuid
language plpgsql
immutable
set search_path = ''
as $$
begin
  if coalesce(p->>k, '') = '' then return null; end if;
  if p->>k !~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' then
    raise exception '% must be an id', k using errcode = '22023';
  end if;
  return (p->>k)::uuid;
end;
$$;

/**
 * The single entry point for API keys. Checks the key, the scope the action
 * needs and a limit of 120 requests a minute per key, then performs the action
 * in that key's workspace only.
 */
create function public.api_call(p_key text, p_action text, p_args jsonb default '{}'::jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  key public.api_keys;
  ws uuid;
  args jsonb := coalesce(p_args, '{}'::jsonb);
  need text := case p_action
    when 'leads.list' then 'leads:read' when 'leads.get' then 'leads:read'
    when 'leads.create' then 'leads:write' when 'leads.update' then 'leads:write'
    when 'deals.list' then 'deals:read' when 'campaigns.list' then 'campaigns:read'
    when 'meetings.list' then 'meetings:read' end;
  lim integer := app.api_limit(coalesce(p_args, '{}'::jsonb));
  cur record;
  rows jsonb;
  cnt integer;
  l public.leads;
  v_email text; v_phone text; v_name text; v_title text; v_link text; v_company text; v_domain text; v_campaign uuid; v_stage text;
  co uuid;
begin
  if p_key is null or p_key !~ '^sdr_[0-9a-f]{64}$' then
    raise exception 'Invalid API key' using errcode = '28000';
  end if;
  select * into key from public.api_keys where key_hash = encode(sha256(convert_to(p_key, 'UTF8')), 'hex') and revoked_at is null;
  if key.id is null then
    raise exception 'Invalid API key' using errcode = '28000';
  end if;
  if need is null then
    raise exception 'Unknown action' using errcode = '22023';
  end if;
  if not (need = any (key.scopes)) then
    raise exception 'This key does not have the % scope', need using errcode = '42501';
  end if;
  if jsonb_typeof(args) <> 'object' or pg_column_size(args) > 16000 then
    raise exception 'The request body must be a JSON object of at most 16 KB' using errcode = '22023';
  end if;

  -- 120 requests a minute per key
  update public.api_keys set
    window_start = case when window_start is null or window_start < now() - interval '1 minute' then now() else window_start end,
    window_count = case when window_start is null or window_start < now() - interval '1 minute' then 1 else window_count + 1 end,
    last_used_at = now()
  where id = key.id
  returning window_count into cnt;
  if cnt > 120 then
    raise exception 'Rate limit reached: 120 requests a minute per key' using errcode = '53400';
  end if;
  ws := key.workspace_id;

  if p_action = 'leads.list' then
    select * into cur from app.api_cursor(args);
    select coalesce(jsonb_agg(app.api_lead(x) order by x.updated_at, x.id), '[]'::jsonb)
      into rows
      from public.leads x
      where x.workspace_id = ws and x.id in (
        select y.id from public.leads y
        where y.workspace_id = ws
          and (args->>'stage' is null or y.stage = args->>'stage')
          and (app.api_uuid(args, 'campaign_id') is null or y.campaign_id = app.api_uuid(args, 'campaign_id'))
          and (app.api_time(args, 'updated_after') is null or y.updated_at > app.api_time(args, 'updated_after'))
          and (cur.at is null or (y.updated_at, y.id) > (cur.at, cur.id))
        order by y.updated_at, y.id limit lim);
    return jsonb_build_object('data', rows, 'next_cursor', case when jsonb_array_length(rows) = lim
      then (rows->(lim - 1)->>'updated_at') || '|' || (rows->(lim - 1)->>'id') end);
  end if;

  if p_action = 'leads.get' then
    select * into l from public.leads where workspace_id = ws and id = app.api_uuid(args, 'id');
    if l.id is null then raise exception 'Not found' using errcode = 'P0002'; end if;
    return jsonb_build_object('data', app.api_lead(l));
  end if;

  if p_action = 'leads.create' then
    -- The same hygiene as a CSV import: a reachable lead, no suppressed
    -- address, one lead per email
    v_email := nullif(lower(trim(coalesce(args->>'email', ''))), '');
    if v_email is not null and v_email !~ '^[^\s@<>"]{1,64}@[^\s@<>"]{1,255}\.[A-Za-z]{2,}$' then
      raise exception 'email is not a valid address' using errcode = '22023';
    end if;
    v_phone := nullif(regexp_replace(coalesce(args->>'phone', ''), '[^0-9+]', '', 'g'), '');
    if v_phone is not null and v_phone !~ '^\+?[0-9]{7,15}$' then
      raise exception 'phone must have 7 to 15 digits' using errcode = '22023';
    end if;
    v_link := nullif(lower(trim(coalesce(args->>'linkedin_url', ''))), '');
    if v_link is not null and v_link !~ '^https://([a-z]{2,3}\.)?linkedin\.com/' then
      raise exception 'linkedin_url must be a linkedin.com address' using errcode = '22023';
    end if;
    if v_email is null and v_phone is null and v_link is null then
      raise exception 'A lead needs an email, a phone or a linkedin_url' using errcode = '22023';
    end if;
    v_name := nullif(left(trim(coalesce(args->>'full_name', '')), 200), '');
    v_title := nullif(left(trim(coalesce(args->>'title', '')), 200), '');
    v_company := nullif(left(trim(coalesce(args->>'company', '')), 200), '');
    v_domain := nullif(lower(regexp_replace(trim(coalesce(args->>'domain', '')), '^(https?://)?(www\.)?([^/]+).*$', '\3')), '');
    if v_domain is not null and v_domain !~ '^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$' then
      raise exception 'domain is not a valid domain' using errcode = '22023';
    end if;
    v_campaign := app.api_uuid(args, 'campaign_id');
    if v_campaign is not null and not exists (select 1 from public.campaigns where workspace_id = ws and id = v_campaign) then
      raise exception 'campaign_id is not a campaign in this workspace' using errcode = '22023';
    end if;
    if exists (select 1 from public.suppressions s where s.workspace_id = ws and (
         (s.kind = 'email' and s.value = v_email) or (s.kind = 'phone' and s.value = v_phone)
         or (s.kind = 'domain' and v_email is not null and s.value = split_part(v_email, '@', 2)))) then
      return jsonb_build_object('created', false, 'reason', 'suppressed');
    end if;
    if v_email is not null then
      select * into l from public.leads where workspace_id = ws and lower(email) = v_email;
      if l.id is not null then
        return jsonb_build_object('created', false, 'reason', 'duplicate', 'data', app.api_lead(l));
      end if;
    end if;
    if v_domain is not null then
      select id into co from public.companies where workspace_id = ws and domain = v_domain limit 1;
    end if;
    if co is null and v_company is not null then
      select id into co from public.companies where workspace_id = ws and lower(name) = lower(v_company) limit 1;
    end if;
    if co is null and (v_company is not null or v_domain is not null) then
      insert into public.companies (workspace_id, name, domain) values (ws, coalesce(v_company, v_domain), v_domain) returning id into co;
    end if;
    insert into public.leads (workspace_id, campaign_id, company_id, full_name, email, phone, title, linkedin_url, source_channel, source_query, stage)
    values (ws, v_campaign, co, v_name, v_email, v_phone, v_title, v_link, 'api', left('API key: ' || key.name, 200), 'new')
    returning * into l;
    return jsonb_build_object('created', true, 'data', app.api_lead(l));
  end if;

  if p_action = 'leads.update' then
    v_stage := args->>'stage';
    if v_stage is null or v_stage not in ('new', 'contacted', 'engaged', 'interested', 'meeting_booked', 'won', 'lost', 'not_interested', 'do_not_contact') then
      raise exception 'stage must be one of new, contacted, engaged, interested, meeting_booked, won, lost, not_interested, do_not_contact' using errcode = '22023';
    end if;
    select * into l from public.leads where workspace_id = ws and id = app.api_uuid(args, 'id') for update;
    if l.id is null then raise exception 'Not found' using errcode = 'P0002'; end if;
    -- Someone who asked not to be contacted is not reopened from outside
    if l.stage = 'do_not_contact' and v_stage <> 'do_not_contact' then
      raise exception 'This lead asked not to be contacted; change it in the app if that is right' using errcode = '22023';
    end if;
    if l.stage <> v_stage then
      update public.leads set stage = v_stage, stage_changed_at = now(), updated_at = now() where id = l.id returning * into l;
      insert into public.activities (workspace_id, lead_id, type, summary, actor)
      values (ws, l.id, 'status_change', left('Stage set to ' || v_stage || ' through the API (' || key.name || ')', 300), 'system');
      if v_stage = 'do_not_contact' and l.email is not null then
        insert into public.suppressions (workspace_id, kind, value, reason, created_by)
        values (ws, 'email', lower(l.email), 'manual', null) on conflict do nothing;
      end if;
    end if;
    return jsonb_build_object('data', app.api_lead(l));
  end if;

  if p_action = 'deals.list' then
    select * into cur from app.api_cursor(args);
    select coalesce(jsonb_agg(jsonb_build_object(
        'id', d.id, 'lead_id', d.lead_id, 'campaign_id', d.campaign_id, 'stage', d.stage, 'value_cents', d.value_cents,
        'currency', d.currency, 'plan_name', d.plan_name, 'closed_at', d.closed_at, 'created_at', d.created_at, 'updated_at', d.updated_at)
        order by d.updated_at, d.id), '[]'::jsonb)
      into rows
      from (select * from public.deals d where d.workspace_id = ws
              and (args->>'stage' is null or d.stage = args->>'stage')
              and (app.api_time(args, 'updated_after') is null or d.updated_at > app.api_time(args, 'updated_after'))
              and (cur.at is null or (d.updated_at, d.id) > (cur.at, cur.id))
            order by d.updated_at, d.id limit lim) d;
    return jsonb_build_object('data', rows, 'next_cursor', case when jsonb_array_length(rows) = lim
      then (rows->(lim - 1)->>'updated_at') || '|' || (rows->(lim - 1)->>'id') end);
  end if;

  if p_action = 'campaigns.list' then
    select coalesce(jsonb_agg(jsonb_build_object('id', c.id, 'name', c.name, 'status', c.status, 'niche', c.niche, 'created_at', c.created_at)
        order by c.created_at), '[]'::jsonb)
      into rows from public.campaigns c where c.workspace_id = ws and c.status <> 'archived';
    return jsonb_build_object('data', rows, 'next_cursor', null);
  end if;

  if p_action = 'meetings.list' then
    select * into cur from app.api_cursor(args);
    select coalesce(jsonb_agg(jsonb_build_object(
        'id', m.id, 'lead_id', m.lead_id, 'starts_at', m.starts_at, 'status', m.status, 'booked_via', m.booked_via,
        'run_by', m.run_by, 'created_at', m.created_at, 'updated_at', m.created_at)
        order by m.created_at, m.id), '[]'::jsonb)
      into rows
      from (select * from public.meetings m where m.workspace_id = ws
              and (app.api_time(args, 'starts_after') is null or m.starts_at > app.api_time(args, 'starts_after'))
              and (cur.at is null or (m.created_at, m.id) > (cur.at, cur.id))
            order by m.created_at, m.id limit lim) m;
    return jsonb_build_object('data', rows, 'next_cursor', case when jsonb_array_length(rows) = lim
      then (rows->(lim - 1)->>'created_at') || '|' || (rows->(lim - 1)->>'id') end);
  end if;

  raise exception 'Unknown action' using errcode = '22023';
end;
$$;

revoke execute on function public.api_key_create(uuid, text, text[]) from public, anon;
revoke execute on function public.api_key_revoke(uuid) from public, anon;
grant execute on function public.api_key_create(uuid, text, text[]) to authenticated, service_role;
grant execute on function public.api_key_revoke(uuid) to authenticated, service_role;
-- The key is the credential, as with the signal address
revoke execute on function public.api_call(text, text, jsonb) from public;
grant execute on function public.api_call(text, text, jsonb) to anon, authenticated, service_role;
revoke execute on function app.api_lead(public.leads), app.api_limit(jsonb), app.api_cursor(jsonb), app.api_time(jsonb, text), app.api_uuid(jsonb, text) from public;

-- ---------------------------------------------------------------- webhooks

create table public.webhook_endpoints (
  id                    uuid primary key default gen_random_uuid(),
  workspace_id          uuid not null references public.workspaces (id) on delete cascade,
  -- https on the standard port only: the sender refuses anything else
  url                   text not null check (url ~ '^https://[A-Za-z0-9.-]+(/[^\s]*)?$' and length(url) <= 500),
  description           text check (length(description) <= 200),
  events                text[] not null check (
                          cardinality(events) between 1 and 6
                          and events <@ array['lead.created', 'lead.stage_changed', 'reply.received', 'meeting.booked', 'deal.won', 'deal.lost']::text[]),
  -- Signs every delivery; shown to owners and admins on request
  secret                text not null default ('whsec_' || replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', ''))
                        check (secret ~ '^whsec_[0-9a-f]{64}$'),
  active                boolean not null default true,
  consecutive_failures  integer not null default 0,
  disabled_reason       text,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  unique (workspace_id, id)
);

create table public.webhook_deliveries (
  id               uuid primary key default gen_random_uuid(),
  workspace_id     uuid not null,
  endpoint_id      uuid not null,
  event            text not null,
  -- The event as sent: {"id", "type", "created_at", "data"}; the same id for every endpoint
  payload          jsonb not null check (jsonb_typeof(payload) = 'object'),
  status           text not null default 'pending' check (status in ('pending', 'sending', 'delivered', 'dead')),
  attempts         smallint not null default 0,
  next_attempt_at  timestamptz not null default now(),
  last_status      integer,
  last_error       text check (length(last_error) <= 300),
  delivered_at     timestamptz,
  created_at       timestamptz not null default now(),
  foreign key (workspace_id, endpoint_id) references public.webhook_endpoints (workspace_id, id) on delete cascade
);
create index webhook_deliveries_due_idx on public.webhook_deliveries (next_attempt_at) where status in ('pending', 'sending');
create index webhook_deliveries_endpoint_idx on public.webhook_deliveries (workspace_id, endpoint_id, created_at desc);

create trigger webhook_endpoints_touch before update on public.webhook_endpoints
  for each row execute function app.touch_updated_at();

-- At most ten endpoints per workspace
create function app.webhook_endpoints_limit()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if (select count(*) from public.webhook_endpoints where workspace_id = new.workspace_id) >= 10 then
    raise exception 'A workspace can have at most 10 webhook endpoints' using errcode = '22023';
  end if;
  return new;
end;
$$;
create trigger webhook_endpoints_limit before insert on public.webhook_endpoints
  for each row execute function app.webhook_endpoints_limit();

alter table public.webhook_endpoints enable row level security;
alter table public.webhook_deliveries enable row level security;
create policy webhook_endpoints_select on public.webhook_endpoints for select to authenticated
  using (app.has_role(workspace_id, array['owner', 'admin']::public.workspace_role[]));
create policy webhook_endpoints_insert on public.webhook_endpoints for insert to authenticated
  with check (app.has_role(workspace_id, array['owner', 'admin']::public.workspace_role[]));
create policy webhook_endpoints_update on public.webhook_endpoints for update to authenticated
  using (app.has_role(workspace_id, array['owner', 'admin']::public.workspace_role[]))
  with check (app.has_role(workspace_id, array['owner', 'admin']::public.workspace_role[]));
create policy webhook_endpoints_delete on public.webhook_endpoints for delete to authenticated
  using (app.has_role(workspace_id, array['owner', 'admin']::public.workspace_role[]));
create policy webhook_deliveries_select on public.webhook_deliveries for select to authenticated
  using (app.has_role(workspace_id, array['owner', 'admin']::public.workspace_role[]));

revoke all on public.webhook_endpoints, public.webhook_deliveries from anon, authenticated;
-- The signing secret is not a column a person can read; it comes from webhook_endpoint_secret()
grant select (id, workspace_id, url, description, events, active, consecutive_failures, disabled_reason, created_at, updated_at)
  on public.webhook_endpoints to authenticated;
grant insert (workspace_id, url, description, events) on public.webhook_endpoints to authenticated;
-- Turning an endpoint back on clears its failure count (see the trigger below)
grant update (url, description, events, active) on public.webhook_endpoints to authenticated;
grant delete on public.webhook_endpoints to authenticated;
grant select on public.webhook_deliveries to authenticated;
grant all on public.webhook_endpoints, public.webhook_deliveries to service_role;

create function app.webhook_endpoints_reenable()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.active and not old.active then
    new.consecutive_failures := 0;
    new.disabled_reason := null;
  end if;
  return new;
end;
$$;
create trigger webhook_endpoints_reenable before update on public.webhook_endpoints
  for each row execute function app.webhook_endpoints_reenable();

create function public.webhook_endpoint_secret(p_id uuid, p_rotate boolean default false)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  e public.webhook_endpoints;
begin
  select * into e from public.webhook_endpoints where id = p_id;
  if e.id is null or not app.has_role(e.workspace_id, array['owner', 'admin']::public.workspace_role[]) then
    raise exception 'Webhook endpoint not found' using errcode = 'P0002';
  end if;
  if p_rotate then
    update public.webhook_endpoints
      set secret = 'whsec_' || replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', '')
      where id = p_id returning * into e;
  end if;
  return e.secret;
end;
$$;

-- Queues one event for every active endpoint subscribed to it
create function app.webhook_emit(ws uuid, p_event text, p_data jsonb)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  ev jsonb := jsonb_build_object('id', gen_random_uuid(), 'type', p_event, 'created_at', now(), 'workspace_id', ws, 'data', p_data);
begin
  insert into public.webhook_deliveries (workspace_id, endpoint_id, event, payload)
  select ws, e.id, p_event, ev from public.webhook_endpoints e
  where e.workspace_id = ws and e.active and p_event = any (e.events);
end;
$$;

/** A test event to one endpoint, from the settings page. */
create function public.webhook_send_test(p_id uuid)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  e public.webhook_endpoints;
  new_id uuid;
begin
  select * into e from public.webhook_endpoints where id = p_id;
  if e.id is null or not app.has_role(e.workspace_id, array['owner', 'admin']::public.workspace_role[]) then
    raise exception 'Webhook endpoint not found' using errcode = 'P0002';
  end if;
  insert into public.webhook_deliveries (workspace_id, endpoint_id, event, payload)
  values (e.workspace_id, e.id, 'test', jsonb_build_object('id', gen_random_uuid(), 'type', 'test', 'created_at', now(),
          'workspace_id', e.workspace_id, 'data', jsonb_build_object('message', 'A test event from your AI SDR workspace')))
  returning id into new_id;
  return new_id;
end;
$$;

revoke execute on function public.webhook_endpoint_secret(uuid, boolean) from public, anon;
revoke execute on function public.webhook_send_test(uuid) from public, anon;
grant execute on function public.webhook_endpoint_secret(uuid, boolean) to authenticated, service_role;
grant execute on function public.webhook_send_test(uuid) to authenticated, service_role;
revoke execute on function app.webhook_emit(uuid, text, jsonb) from public;

-- ---------------------------------------------------------------- events

create function app.webhook_on_lead()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  -- Nothing to do in a workspace with no endpoints
  if not exists (select 1 from public.webhook_endpoints where workspace_id = new.workspace_id and active) then return null; end if;
  if tg_op = 'INSERT' then
    perform app.webhook_emit(new.workspace_id, 'lead.created', app.api_lead(new));
  elsif new.stage is distinct from old.stage then
    perform app.webhook_emit(new.workspace_id, 'lead.stage_changed', app.api_lead(new) || jsonb_build_object('previous_stage', old.stage));
  end if;
  return null;
end;
$$;
create trigger leads_webhooks after insert or update of stage on public.leads
  for each row execute function app.webhook_on_lead();

create function app.webhook_on_reply()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not exists (select 1 from public.webhook_endpoints where workspace_id = new.workspace_id and active) then return null; end if;
  perform app.webhook_emit(new.workspace_id, 'reply.received', jsonb_build_object(
    'id', new.id, 'lead_id', new.lead_id, 'channel', new.channel, 'classification', new.classification,
    'body', left(new.body, 2000), 'created_at', new.created_at));
  return null;
end;
$$;
create trigger replies_webhooks after insert on public.replies
  for each row execute function app.webhook_on_reply();

create function app.webhook_on_meeting()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not exists (select 1 from public.webhook_endpoints where workspace_id = new.workspace_id and active) then return null; end if;
  perform app.webhook_emit(new.workspace_id, 'meeting.booked', jsonb_build_object(
    'id', new.id, 'lead_id', new.lead_id, 'starts_at', new.starts_at, 'booked_via', new.booked_via, 'run_by', new.run_by));
  return null;
end;
$$;
create trigger meetings_webhooks after insert on public.meetings
  for each row execute function app.webhook_on_meeting();

create function app.webhook_on_deal()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.stage not in ('won', 'lost') or (tg_op = 'UPDATE' and old.stage = new.stage) then return null; end if;
  if not exists (select 1 from public.webhook_endpoints where workspace_id = new.workspace_id and active) then return null; end if;
  perform app.webhook_emit(new.workspace_id, 'deal.' || new.stage, jsonb_build_object(
    'id', new.id, 'lead_id', new.lead_id, 'campaign_id', new.campaign_id, 'stage', new.stage, 'value_cents', new.value_cents,
    'currency', new.currency, 'plan_name', new.plan_name, 'closed_at', new.closed_at));
  return null;
end;
$$;
create trigger deals_webhooks after insert or update of stage on public.deals
  for each row execute function app.webhook_on_deal();

revoke execute on function app.webhook_on_lead(), app.webhook_on_reply(), app.webhook_on_meeting(), app.webhook_on_deal() from public;

-- ---------------------------------------------------------------- delivery

/**
 * Claims deliveries that are due, for the agent service. A delivery left in
 * "sending" by a stopped worker is claimed again after ten minutes. Old
 * history is trimmed here too, 30 days after it was created.
 */
create function public.webhook_deliveries_claim(p_limit integer default 50)
returns table (id uuid, workspace_id uuid, endpoint_id uuid, url text, secret text, event text, payload jsonb, attempts smallint)
language plpgsql
security definer
set search_path = ''
as $$
begin
  delete from public.webhook_deliveries d
  where d.id in (select x.id from public.webhook_deliveries x where x.created_at < now() - interval '30 days' limit 1000);
  return query
  with due as (
    select d.id from public.webhook_deliveries d
    join public.webhook_endpoints e on e.workspace_id = d.workspace_id and e.id = d.endpoint_id
    where e.active and ((d.status = 'pending' and d.next_attempt_at <= now())
                        or (d.status = 'sending' and d.next_attempt_at <= now() - interval '10 minutes'))
    order by d.next_attempt_at
    limit greatest(1, least(coalesce(p_limit, 50), 200))
    for update of d skip locked
  ), claimed as (
    update public.webhook_deliveries d set status = 'sending', next_attempt_at = now(), attempts = d.attempts + 1
    from due where d.id = due.id
    returning d.id, d.workspace_id, d.endpoint_id, d.event, d.payload, d.attempts
  )
  select c.id, c.workspace_id, c.endpoint_id, e.url, e.secret, c.event, c.payload, c.attempts
  from claimed c join public.webhook_endpoints e on e.workspace_id = c.workspace_id and e.id = c.endpoint_id;
end;
$$;

/**
 * Records one attempt. Failures retry after 1 minute, 5 minutes, 30 minutes,
 * 2 hours and 12 hours; after the sixth the delivery is dead. An endpoint that
 * fails 15 times in a row is switched off. Returns true when that just happened.
 */
create function public.webhook_delivery_result(p_id uuid, p_ok boolean, p_status integer, p_error text)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  d public.webhook_deliveries;
  fails integer;
begin
  select * into d from public.webhook_deliveries where id = p_id for update;
  if d.id is null then return false; end if;
  if p_ok then
    update public.webhook_deliveries set status = 'delivered', delivered_at = now(), last_status = p_status, last_error = null where id = p_id;
    update public.webhook_endpoints set consecutive_failures = 0 where workspace_id = d.workspace_id and id = d.endpoint_id;
    return false;
  end if;
  update public.webhook_deliveries set
    status = case when d.attempts >= 6 then 'dead' else 'pending' end,
    next_attempt_at = now() + case d.attempts when 1 then interval '1 minute' when 2 then interval '5 minutes'
                                              when 3 then interval '30 minutes' when 4 then interval '2 hours' else interval '12 hours' end,
    last_status = p_status, last_error = left(p_error, 300)
  where id = p_id;
  update public.webhook_endpoints set consecutive_failures = consecutive_failures + 1
  where workspace_id = d.workspace_id and id = d.endpoint_id returning consecutive_failures into fails;
  if fails >= 15 then
    update public.webhook_endpoints set active = false, disabled_reason = left('Switched off after 15 failed deliveries in a row. Last error: ' || coalesce(p_error, 'HTTP ' || p_status), 300)
    where workspace_id = d.workspace_id and id = d.endpoint_id and active;
    return found;
  end if;
  return false;
end;
$$;

revoke execute on function public.webhook_deliveries_claim(integer) from public, anon, authenticated;
revoke execute on function public.webhook_delivery_result(uuid, boolean, integer, text) from public, anon, authenticated;
grant execute on function public.webhook_deliveries_claim(integer) to service_role;
grant execute on function public.webhook_delivery_result(uuid, boolean, integer, text) to service_role;
