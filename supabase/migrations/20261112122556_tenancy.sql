-- =============================================================================
-- Tenancy foundation: agencies, workspaces, members, roles, audit log
--
-- Every company works inside one workspace. All other tables carry a
-- workspace_id and are protected by row-level security (RLS) built on the two
-- helpers defined here: app.is_member() and app.has_role().
-- =============================================================================

create schema if not exists app;

create type public.workspace_role as enum ('owner', 'admin', 'rep', 'viewer');

-- -----------------------------------------------------------------------------
-- Shared trigger: keep updated_at current
-- -----------------------------------------------------------------------------
create function app.touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

-- -----------------------------------------------------------------------------
-- Agencies (white-label resellers that own client workspaces)
-- -----------------------------------------------------------------------------
create table public.agencies (
  id             uuid primary key default gen_random_uuid(),
  name           text not null check (length(trim(name)) between 1 and 120),
  custom_domain  text unique,
  branding       jsonb not null default '{}'::jsonb,
  owner_id       uuid not null default auth.uid() references auth.users (id),
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

create trigger agencies_touch before update on public.agencies
  for each row execute function app.touch_updated_at();

-- -----------------------------------------------------------------------------
-- Workspaces (one per subscriber company)
-- -----------------------------------------------------------------------------
create table public.workspaces (
  id                uuid primary key default gen_random_uuid(),
  name              text not null check (length(trim(name)) between 1 and 120),
  plan              text not null default 'starter',
  -- Full autopilot is the default; any stage can be moved to approval mode.
  automation_mode   text not null default 'autopilot'
                    check (automation_mode in ('autopilot', 'approval')),
  -- Per-channel switches. LinkedIn is an optional add-on and starts off.
  enabled_channels  jsonb not null default
                    '{"email": true, "voice": true, "sms": true, "whatsapp": true, "linkedin": false}'::jsonb,
  ai_closer_enabled boolean not null default true,
  -- Global kill switch: pauses all outreach for the workspace instantly.
  outreach_paused   boolean not null default false,
  target_areas      jsonb not null default '[]'::jsonb,
  branding          jsonb not null default '{}'::jsonb,
  agency_id         uuid references public.agencies (id) on delete set null,
  created_by        uuid not null default auth.uid() references auth.users (id),
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

create index workspaces_agency_idx on public.workspaces (agency_id) where agency_id is not null;

create trigger workspaces_touch before update on public.workspaces
  for each row execute function app.touch_updated_at();

-- -----------------------------------------------------------------------------
-- Workspace members and roles
-- -----------------------------------------------------------------------------
create table public.workspace_members (
  workspace_id  uuid not null references public.workspaces (id) on delete cascade,
  user_id       uuid not null references auth.users (id) on delete cascade,
  role          public.workspace_role not null default 'rep',
  created_at    timestamptz not null default now(),
  primary key (workspace_id, user_id)
);

create index workspace_members_user_idx on public.workspace_members (user_id);

-- -----------------------------------------------------------------------------
-- RLS helpers. SECURITY DEFINER so policies on workspace_members can call them
-- without recursing into their own policies.
-- -----------------------------------------------------------------------------
create function app.is_member(ws uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.workspace_members m
    where m.workspace_id = ws
      and m.user_id = auth.uid()
  );
$$;

create function app.has_role(ws uuid, roles public.workspace_role[])
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.workspace_members m
    where m.workspace_id = ws
      and m.user_id = auth.uid()
      and m.role = any (roles)
  );
$$;

-- -----------------------------------------------------------------------------
-- The creator of a workspace becomes its first owner
-- -----------------------------------------------------------------------------
create function app.add_workspace_owner()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.workspace_members (workspace_id, user_id, role)
  values (new.id, new.created_by, 'owner');
  return new;
end;
$$;

create trigger workspaces_add_owner after insert on public.workspaces
  for each row execute function app.add_workspace_owner();

-- -----------------------------------------------------------------------------
-- A workspace must always keep at least one owner
-- (when the workspace itself is deleted, the cascade is let through)
-- -----------------------------------------------------------------------------
create function app.protect_last_owner()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if old.role <> 'owner' then
    return coalesce(new, old);
  end if;
  if tg_op = 'UPDATE' and new.role = 'owner' then
    return new;
  end if;
  if not exists (select 1 from public.workspaces w where w.id = old.workspace_id) then
    return coalesce(new, old);
  end if;
  if not exists (
    select 1
    from public.workspace_members m
    where m.workspace_id = old.workspace_id
      and m.role = 'owner'
      and m.user_id <> old.user_id
  ) then
    raise exception 'A workspace must keep at least one owner'
      using errcode = 'check_violation';
  end if;
  return coalesce(new, old);
end;
$$;

create trigger workspace_members_last_owner before update or delete on public.workspace_members
  for each row execute function app.protect_last_owner();

-- -----------------------------------------------------------------------------
-- Audit log: who changed access or outreach settings, and when
-- -----------------------------------------------------------------------------
create table public.audit_log (
  id            bigint generated always as identity primary key,
  workspace_id  uuid not null references public.workspaces (id) on delete cascade,
  actor_id      uuid,
  action        text not null,
  entity        text not null,
  entity_id     text,
  detail        jsonb not null default '{}'::jsonb,
  created_at    timestamptz not null default now()
);

create index audit_log_workspace_idx on public.audit_log (workspace_id, created_at desc);

create function app.audit_member_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'DELETE' then
    if exists (select 1 from public.workspaces w where w.id = old.workspace_id) then
      insert into public.audit_log (workspace_id, actor_id, action, entity, entity_id, detail)
      values (old.workspace_id, auth.uid(), 'member.removed', 'workspace_member', old.user_id::text,
              jsonb_build_object('role', old.role));
    end if;
    return old;
  elsif tg_op = 'INSERT' then
    insert into public.audit_log (workspace_id, actor_id, action, entity, entity_id, detail)
    values (new.workspace_id, auth.uid(), 'member.added', 'workspace_member', new.user_id::text,
            jsonb_build_object('role', new.role));
  elsif new.role is distinct from old.role then
    insert into public.audit_log (workspace_id, actor_id, action, entity, entity_id, detail)
    values (new.workspace_id, auth.uid(), 'member.role_changed', 'workspace_member', new.user_id::text,
            jsonb_build_object('from', old.role, 'to', new.role));
  end if;
  return new;
end;
$$;

create trigger workspace_members_audit after insert or update or delete on public.workspace_members
  for each row execute function app.audit_member_change();

create function app.audit_workspace_settings()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.outreach_paused is distinct from old.outreach_paused then
    insert into public.audit_log (workspace_id, actor_id, action, entity, entity_id, detail)
    values (new.id, auth.uid(),
            case when new.outreach_paused then 'outreach.paused' else 'outreach.resumed' end,
            'workspace', new.id::text, '{}'::jsonb);
  end if;
  if new.enabled_channels is distinct from old.enabled_channels then
    insert into public.audit_log (workspace_id, actor_id, action, entity, entity_id, detail)
    values (new.id, auth.uid(), 'channels.changed', 'workspace', new.id::text,
            jsonb_build_object('from', old.enabled_channels, 'to', new.enabled_channels));
  end if;
  if new.automation_mode is distinct from old.automation_mode
     or new.ai_closer_enabled is distinct from old.ai_closer_enabled then
    insert into public.audit_log (workspace_id, actor_id, action, entity, entity_id, detail)
    values (new.id, auth.uid(), 'automation.changed', 'workspace', new.id::text,
            jsonb_build_object('automation_mode', new.automation_mode,
                               'ai_closer_enabled', new.ai_closer_enabled));
  end if;
  return new;
end;
$$;

create trigger workspaces_audit after update on public.workspaces
  for each row execute function app.audit_workspace_settings();

-- -----------------------------------------------------------------------------
-- Row-level security
-- -----------------------------------------------------------------------------
alter table public.agencies          enable row level security;
alter table public.workspaces        enable row level security;
alter table public.workspace_members enable row level security;
alter table public.audit_log         enable row level security;

-- Agencies: managed by their owner
create policy agencies_select on public.agencies for select to authenticated
  using (owner_id = auth.uid());
create policy agencies_insert on public.agencies for insert to authenticated
  with check (owner_id = auth.uid());
create policy agencies_update on public.agencies for update to authenticated
  using (owner_id = auth.uid()) with check (owner_id = auth.uid());
create policy agencies_delete on public.agencies for delete to authenticated
  using (owner_id = auth.uid());

-- Workspaces: visible to members; settings managed by owners and admins
create policy workspaces_select on public.workspaces for select to authenticated
  using (created_by = auth.uid() or app.is_member(id));
create policy workspaces_insert on public.workspaces for insert to authenticated
  with check (created_by = auth.uid());
create policy workspaces_update on public.workspaces for update to authenticated
  using (app.has_role(id, array['owner', 'admin']::public.workspace_role[]))
  with check (app.has_role(id, array['owner', 'admin']::public.workspace_role[]));
create policy workspaces_delete on public.workspaces for delete to authenticated
  using (app.has_role(id, array['owner']::public.workspace_role[]));

-- Members: owners manage everyone; admins manage reps and viewers only
create policy workspace_members_select on public.workspace_members for select to authenticated
  using (app.is_member(workspace_id));
create policy workspace_members_insert on public.workspace_members for insert to authenticated
  with check (
    app.has_role(workspace_id, array['owner']::public.workspace_role[])
    or (app.has_role(workspace_id, array['admin']::public.workspace_role[]) and role in ('rep', 'viewer'))
  );
create policy workspace_members_update on public.workspace_members for update to authenticated
  using (
    app.has_role(workspace_id, array['owner']::public.workspace_role[])
    or (app.has_role(workspace_id, array['admin']::public.workspace_role[]) and role in ('rep', 'viewer'))
  )
  with check (
    app.has_role(workspace_id, array['owner']::public.workspace_role[])
    or (app.has_role(workspace_id, array['admin']::public.workspace_role[]) and role in ('rep', 'viewer'))
  );
create policy workspace_members_delete on public.workspace_members for delete to authenticated
  using (
    user_id = auth.uid()
    or app.has_role(workspace_id, array['owner']::public.workspace_role[])
    or (app.has_role(workspace_id, array['admin']::public.workspace_role[]) and role in ('rep', 'viewer'))
  );

-- Audit log: read-only for owners and admins; written only by triggers
create policy audit_log_select on public.audit_log for select to authenticated
  using (app.has_role(workspace_id, array['owner', 'admin']::public.workspace_role[]));

-- -----------------------------------------------------------------------------
-- Privileges
-- -----------------------------------------------------------------------------
grant usage on schema app to authenticated, service_role;
grant execute on function app.is_member(uuid) to authenticated, service_role;
grant execute on function app.has_role(uuid, public.workspace_role[]) to authenticated, service_role;

revoke all on public.agencies, public.workspaces, public.workspace_members, public.audit_log from anon;
grant select, insert, update, delete on public.agencies, public.workspaces, public.workspace_members to authenticated;
revoke all on public.audit_log from authenticated;
grant select on public.audit_log to authenticated;
grant all on public.agencies, public.workspaces, public.workspace_members, public.audit_log to service_role;
