-- =============================================================================
-- White-label mode for agencies (SRS M26)
--
-- * An agency has its own brand (app name, logo, colours, support email and
--   custom domain), used on the sign-in pages, in the app and in everything
--   the agents send, with no mention of the underlying platform.
-- * Agency owners and admins run an agency console: they create client
--   workspaces, set each client's plan and limits, and see usage per client.
-- * New client workspaces start from the agency's default playbook and
--   campaign cadence.
-- * Client data stays in each workspace. Agency staff see client workspaces
--   only where they hold a workspace role; the console shows counts only.
-- =============================================================================

-- ---------------------------------------------------------------- agency staff
create type public.agency_role as enum ('admin', 'staff');

create table public.agency_members (
  agency_id   uuid not null references public.agencies (id) on delete cascade,
  user_id     uuid not null references auth.users (id) on delete cascade,
  role        public.agency_role not null default 'staff',
  created_at  timestamptz not null default now(),
  primary key (agency_id, user_id)
);

-- The owner, or a member holding one of the roles
create function app.agency_role(ag uuid, roles public.agency_role[])
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (select 1 from public.agencies a where a.id = ag and a.owner_id = auth.uid())
      or exists (select 1 from public.agency_members m where m.agency_id = ag and m.user_id = auth.uid() and m.role = any (roles));
$$;

-- ---------------------------------------------------------------- agency settings
-- The brand moves to its own table (readable by client members); the rest stays private to the agency
alter table public.agencies drop column branding;
alter table public.agencies drop column custom_domain;
alter table public.agencies
  add column default_playbook  jsonb check (default_playbook is null or (jsonb_typeof(default_playbook) = 'object' and pg_column_size(default_playbook) <= 64000)),
  add column campaign_defaults jsonb not null default '{}'::jsonb
    check (jsonb_typeof(campaign_defaults) = 'object' and pg_column_size(campaign_defaults) <= 2000
           and campaign_defaults - array['follow_up_count', 'follow_up_delay_days', 'daily_send_limit', 'send_window_start', 'send_window_end',
                                         'call_window_start', 'call_window_end', 'call_daily_limit', 'call_max_attempts',
                                         'sms_after_days', 'sms_daily_limit', 'sms_max_messages'] = '{}'::jsonb);

create table public.agency_brands (
  agency_id      uuid primary key references public.agencies (id) on delete cascade,
  app_name       text not null check (length(trim(app_name)) between 1 and 60),
  logo_url       text check (logo_url ~ '^https://[^\s"<>]+$' and length(logo_url) <= 500),
  primary_color  text not null default '#2f5bea' check (primary_color ~ '^#[0-9a-f]{6}$'),
  support_email  text check (support_email ~ '^[^\s@<>"]{1,64}@[^\s@<>"]{1,200}\.[a-z]{2,}$'),
  -- e.g. app.agency.com; the domain is pointed at the web app by the agency
  custom_domain  text unique check (custom_domain ~ '^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$' and length(custom_domain) <= 253),
  updated_at     timestamptz not null default now()
);
create trigger agency_brands_touch before update on public.agency_brands
  for each row execute function app.touch_updated_at();

-- ---------------------------------------------------------------- client workspaces
alter table public.workspaces
  add column monthly_lead_limit integer check (monthly_lead_limit between 1 and 1000000),
  add column seat_limit         integer check (seat_limit between 1 and 1000),
  add column campaign_defaults  jsonb not null default '{}'::jsonb check (jsonb_typeof(campaign_defaults) = 'object' and pg_column_size(campaign_defaults) <= 2000),
  add constraint workspaces_plan_check check (length(trim(plan)) between 1 and 40);

-- Only the agency sets a client's agency, plan and limits (through the console functions)
create function app.guard_workspace_plan()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if current_user <> 'authenticated' then
    return new;
  end if;
  if tg_op = 'INSERT' then
    if new.agency_id is not null or new.plan <> 'starter' or new.monthly_lead_limit is not null or new.seat_limit is not null
       or new.campaign_defaults <> '{}'::jsonb then
      raise exception 'Client workspaces are created from the agency console' using errcode = 'insufficient_privilege';
    end if;
  elsif new.agency_id is distinct from old.agency_id or new.plan is distinct from old.plan
        or new.monthly_lead_limit is distinct from old.monthly_lead_limit or new.seat_limit is distinct from old.seat_limit
        or new.campaign_defaults is distinct from old.campaign_defaults then
    raise exception 'The plan and limits are managed by your agency' using errcode = 'insufficient_privilege';
  end if;
  return new;
end;
$$;
create trigger workspaces_guard_plan before insert or update on public.workspaces
  for each row execute function app.guard_workspace_plan();

-- Seat limit for client plans
create function app.enforce_seat_limit()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  lim integer;
  n integer;
begin
  select seat_limit into lim from public.workspaces where id = new.workspace_id;
  if lim is not null then
    select count(*) into n from public.workspace_members where workspace_id = new.workspace_id;
    if n >= lim then
      raise exception 'This plan allows % team members. Ask your agency for more seats.', lim using errcode = 'check_violation';
    end if;
  end if;
  return new;
end;
$$;
create trigger workspace_members_seat_limit before insert on public.workspace_members
  for each row execute function app.enforce_seat_limit();

-- New campaigns start from the workspace's cadence defaults (keys the create form never sets)
create function app.apply_campaign_defaults()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  d jsonb;
begin
  select w.campaign_defaults into d from public.workspaces w where w.id = new.workspace_id;
  if d is not null and d <> '{}'::jsonb then
    new := jsonb_populate_record(new, d);
  end if;
  return new;
end;
$$;
create trigger campaigns_apply_defaults before insert on public.campaigns
  for each row execute function app.apply_campaign_defaults();

-- ---------------------------------------------------------------- access
alter table public.agency_members enable row level security;
alter table public.agency_brands enable row level security;

drop policy agencies_select on public.agencies;
drop policy agencies_update on public.agencies;
-- The owner check is inline so a new agency is visible to its creator straight away
create policy agencies_select on public.agencies for select to authenticated
  using (owner_id = (select auth.uid()) or app.agency_role(id, array['admin', 'staff']::public.agency_role[]));
create policy agencies_update on public.agencies for update to authenticated
  using (owner_id = (select auth.uid()) or app.agency_role(id, array['admin']::public.agency_role[]))
  with check (owner_id = (select auth.uid()) or app.agency_role(id, array['admin']::public.agency_role[]));

create policy agency_members_select on public.agency_members for select to authenticated
  using (app.agency_role(agency_id, array['admin', 'staff']::public.agency_role[]));
create policy agency_members_update on public.agency_members for update to authenticated
  using (app.agency_role(agency_id, array['admin']::public.agency_role[]))
  with check (app.agency_role(agency_id, array['admin']::public.agency_role[]));
create policy agency_members_delete on public.agency_members for delete to authenticated
  using (app.agency_role(agency_id, array['admin']::public.agency_role[]));

-- The brand is public to the agency's team and to members of its client workspaces
create policy agency_brands_select on public.agency_brands for select to authenticated
  using (app.agency_role(agency_id, array['admin', 'staff']::public.agency_role[])
         or exists (select 1 from public.workspaces w where w.agency_id = agency_brands.agency_id and app.is_member(w.id)));
create policy agency_brands_insert on public.agency_brands for insert to authenticated
  with check (app.agency_role(agency_id, array['admin']::public.agency_role[]));
create policy agency_brands_update on public.agency_brands for update to authenticated
  using (app.agency_role(agency_id, array['admin']::public.agency_role[]))
  with check (app.agency_role(agency_id, array['admin']::public.agency_role[]));

revoke all on public.agency_members, public.agency_brands from anon;
grant select, update, delete on public.agency_members to authenticated;
grant select, insert, update on public.agency_brands to authenticated;
grant all on public.agency_members, public.agency_brands to service_role;

-- ---------------------------------------------------------------- console functions
-- Each checks the caller's agency role itself, because agency staff are not
-- members of client workspaces and row-level security would hide them.

-- Adds or changes an agency team member by email
create function public.agency_member_add(ag uuid, member_email text, member_role public.agency_role)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  uid uuid;
begin
  if not app.agency_role(ag, array['admin']::public.agency_role[]) then
    raise exception 'Only agency owners and admins can manage the agency team' using errcode = 'insufficient_privilege';
  end if;
  select id into uid from auth.users where lower(email) = lower(trim(member_email));
  if uid is null then
    raise exception 'No account uses that email yet. Ask them to sign up first.' using errcode = 'no_data_found';
  end if;
  if exists (select 1 from public.agencies where id = ag and owner_id = uid) then
    raise exception 'That person already owns the agency' using errcode = 'check_violation';
  end if;
  insert into public.agency_members (agency_id, user_id, role) values (ag, uid, member_role)
  on conflict (agency_id, user_id) do update set role = excluded.role;
end;
$$;

create function public.agency_members_list(ag uuid)
returns table (user_id uuid, email text, role text, joined_at timestamptz)
language sql
stable
security definer
set search_path = ''
as $$
  select a.owner_id, u.email::text, 'owner', a.created_at
  from public.agencies a join auth.users u on u.id = a.owner_id
  where a.id = ag and app.agency_role(ag, array['admin', 'staff']::public.agency_role[])
  union all
  select m.user_id, u.email::text, m.role::text, m.created_at
  from public.agency_members m join auth.users u on u.id = m.user_id
  where m.agency_id = ag and app.agency_role(ag, array['admin', 'staff']::public.agency_role[])
  order by 4;
$$;

-- Creates a client workspace; the caller becomes its first owner and invites the client from Team
create function public.agency_create_workspace(ag uuid, ws_name text, ws_plan text, lead_limit integer, seats integer)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  a public.agencies;
  ws uuid;
begin
  if not app.agency_role(ag, array['admin']::public.agency_role[]) then
    raise exception 'Only agency owners and admins can create client workspaces' using errcode = 'insufficient_privilege';
  end if;
  select * into a from public.agencies where id = ag;
  insert into public.workspaces (name, plan, agency_id, monthly_lead_limit, seat_limit, campaign_defaults, created_by)
  values (trim(ws_name), coalesce(nullif(trim(ws_plan), ''), 'starter'), ag, lead_limit, seats, a.campaign_defaults, auth.uid())
  returning id into ws;
  if a.default_playbook is not null then
    insert into public.playbooks (workspace_id, version, content, is_active) values (ws, 1, a.default_playbook, true);
  end if;
  return ws;
end;
$$;

-- Changes a client's plan and limits
create function public.agency_set_plan(ws uuid, ws_plan text, lead_limit integer, seats integer)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  ag uuid;
begin
  select agency_id into ag from public.workspaces where id = ws;
  if ag is null or not app.agency_role(ag, array['admin']::public.agency_role[]) then
    raise exception 'Only the agency that manages this workspace can change its plan' using errcode = 'insufficient_privilege';
  end if;
  update public.workspaces set plan = coalesce(nullif(trim(ws_plan), ''), 'starter'), monthly_lead_limit = lead_limit, seat_limit = seats
  where id = ws;
end;
$$;

-- Usage per client for a period: counts and revenue only, never client records
create function public.agency_usage(ag uuid, p_from timestamptz, p_to timestamptz)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not app.agency_role(ag, array['admin', 'staff']::public.agency_role[]) then
    raise exception 'Only the agency team can see client usage' using errcode = 'insufficient_privilege';
  end if;
  if p_to <= p_from or p_to - p_from > interval '366 days' then
    raise exception 'Choose a period of up to one year' using errcode = 'check_violation';
  end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'id', w.id, 'name', w.name, 'plan', w.plan, 'monthly_lead_limit', w.monthly_lead_limit, 'seat_limit', w.seat_limit,
      'outreach_paused', w.outreach_paused, 'created_at', w.created_at,
      'members', (select count(*) from public.workspace_members m where m.workspace_id = w.id),
      'leads_this_month', (select count(*) from public.leads l where l.workspace_id = w.id and l.created_at >= date_trunc('month', now())),
      'leads', (select count(*) from public.leads l where l.workspace_id = w.id and l.created_at >= p_from and l.created_at < p_to),
      'emails', (select count(*) from public.emails e where e.workspace_id = w.id and e.status in ('sent', 'bounced') and e.sent_at >= p_from and e.sent_at < p_to),
      'calls', (select count(*) from public.calls k where k.workspace_id = w.id and k.created_at >= p_from and k.created_at < p_to),
      'call_minutes', (select coalesce(ceil(sum(k.duration_seconds) / 60.0), 0) from public.calls k where k.workspace_id = w.id and k.created_at >= p_from and k.created_at < p_to),
      'texts', (select count(*) from public.messages x where x.workspace_id = w.id and x.direction = 'outbound' and x.created_at >= p_from and x.created_at < p_to),
      'meetings', (select count(*) from public.meetings g where g.workspace_id = w.id and g.created_at >= p_from and g.created_at < p_to),
      'won', (select count(*) from public.deals d where d.workspace_id = w.id and d.stage = 'won' and d.closed_at >= p_from and d.closed_at < p_to),
      'revenue', coalesce((select jsonb_object_agg(r.currency, r.cents) from (
                   select d.currency, sum(d.value_cents) as cents from public.deals d
                   where d.workspace_id = w.id and d.stage = 'won' and d.value_cents is not null and d.closed_at >= p_from and d.closed_at < p_to
                   group by d.currency) r), '{}'::jsonb)
    ) order by w.name)
    from public.workspaces w where w.agency_id = ag), '[]'::jsonb);
end;
$$;

-- The brand for a custom domain, for the sign-in pages before anyone signs in
create function public.brand_for_host(p_host text)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object('app_name', b.app_name, 'logo_url', b.logo_url, 'primary_color', b.primary_color, 'support_email', b.support_email)
  from public.agency_brands b
  where p_host ~ '^[a-z0-9.-]{1,253}$' and b.custom_domain = p_host;
$$;

revoke execute on function public.agency_member_add(uuid, text, public.agency_role) from public, anon;
revoke execute on function public.agency_members_list(uuid) from public, anon;
revoke execute on function public.agency_create_workspace(uuid, text, text, integer, integer) from public, anon;
revoke execute on function public.agency_set_plan(uuid, text, integer, integer) from public, anon;
revoke execute on function public.agency_usage(uuid, timestamptz, timestamptz) from public, anon;
revoke execute on function public.brand_for_host(text) from public;
grant execute on function public.agency_member_add(uuid, text, public.agency_role) to authenticated, service_role;
grant execute on function public.agency_members_list(uuid) to authenticated, service_role;
grant execute on function public.agency_create_workspace(uuid, text, text, integer, integer) to authenticated, service_role;
grant execute on function public.agency_set_plan(uuid, text, integer, integer) to authenticated, service_role;
grant execute on function public.agency_usage(uuid, timestamptz, timestamptz) to authenticated, service_role;
grant execute on function public.brand_for_host(text) to anon, authenticated, service_role;
