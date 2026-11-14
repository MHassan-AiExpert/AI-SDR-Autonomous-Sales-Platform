-- =============================================================================
-- Shared template library (F23)
--
-- Sequences became data in F22, so a sequence worth keeping can now be saved
-- and stamped out again. This migration adds that library, together with
-- snippets: named blocks of copy the writer can reuse.
--
-- Both are named, reusable, scoped content, so they share one table with a
-- `kind`. That keeps the scope and permission rules in one place rather than
-- two, and a third kind later costs nothing.
--
-- Scope is either a workspace or an agency, never both. An agency template
-- marked as a default is copied into each new client workspace, next to the
-- default playbook and campaign settings the agency console already carries.
--
-- Objection answers are deliberately *not* here. They already exist, in
-- `playbooks.content.objections`, and the closer agent already uses them. The
-- real gap was that the reply agent never loaded the playbook at all, and that
-- is fixed in the agent service rather than by a second store for the same
-- thing.
--
-- A sequence template holds a snapshot, not a link. Editing the campaign it
-- came from must not silently change every campaign stamped from it.
-- =============================================================================

create table public.templates (
  id            uuid primary key default gen_random_uuid(),
  -- Exactly one owner: a workspace, or an agency
  workspace_id  uuid references public.workspaces (id) on delete cascade,
  agency_id     uuid references public.agencies (id) on delete cascade,
  kind          text not null check (kind in ('sequence', 'snippet')),
  name          text not null check (length(trim(name)) between 1 and 120),
  description   text check (description is null or length(description) <= 500),
  -- A sequence: {"steps": [{position, channel, wait_hours, condition, is_last,
  --                         variants: [{label, subject, body}]}, ...]}
  -- A snippet:  {"body": "..."}
  payload       jsonb not null default '{}'::jsonb
                check (jsonb_typeof(payload) = 'object' and pg_column_size(payload) <= 64000),
  -- Agency scope only: copied into each new client workspace
  is_default    boolean not null default false,
  created_by    uuid default auth.uid() references auth.users (id) on delete set null,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  constraint templates_one_owner check (
    (workspace_id is not null and agency_id is null)
    or (workspace_id is null and agency_id is not null)
  ),
  -- Only an agency template can be a default for new workspaces
  constraint templates_default_is_agency check (not is_default or agency_id is not null),
  unique (workspace_id, id)
);

-- One name per kind in each scope, matched without regard to case
create unique index templates_workspace_name_key on public.templates (workspace_id, kind, lower(name))
  where workspace_id is not null;
create unique index templates_agency_name_key on public.templates (agency_id, kind, lower(name))
  where agency_id is not null;
create index templates_workspace_kind_idx on public.templates (workspace_id, kind, name) where workspace_id is not null;
create index templates_agency_kind_idx on public.templates (agency_id, kind, name) where agency_id is not null;

create trigger templates_touch before update on public.templates
  for each row execute function app.touch_updated_at();

-- ---------------------------------------------------------------- row security
alter table public.templates enable row level security;

-- A member reads their workspace's templates, and the templates of the agency
-- that owns their workspace: an agency's library is meant for its clients.
create policy templates_select on public.templates for select to authenticated
  using (
    (workspace_id is not null and app.is_member(workspace_id))
    or (agency_id is not null and (
      app.agency_role(agency_id, array['admin', 'staff']::public.agency_role[])
      or exists (select 1 from public.workspaces w where w.agency_id = templates.agency_id and app.is_member(w.id))
    ))
  );

-- Writing is narrower: owners and admins in a workspace, agency admins for an
-- agency template. A client cannot change the library they inherited from.
create policy templates_write on public.templates for all to authenticated
  using (
    (workspace_id is not null and app.has_role(workspace_id, array['owner', 'admin']::public.workspace_role[]))
    or (agency_id is not null and app.agency_role(agency_id, array['admin']::public.agency_role[]))
  )
  with check (
    (workspace_id is not null and app.has_role(workspace_id, array['owner', 'admin']::public.workspace_role[]))
    or (agency_id is not null and app.agency_role(agency_id, array['admin']::public.agency_role[]))
  );

revoke all on public.templates from anon;
grant select, insert, update, delete on public.templates to authenticated;
grant all on public.templates to service_role;

-- ---------------------------------------------------------------- save
-- Saves a campaign's sequence as a workspace template. A snapshot, so later
-- edits to the campaign do not reach campaigns already stamped from it.
create function public.template_save_sequence(ws uuid, p_campaign uuid, p_name text, p_description text default null)
returns uuid
language plpgsql
security invoker
set search_path = ''
as $$
declare
  steps jsonb;
  new_id uuid;
begin
  select jsonb_agg(step order by step->>'position')
  into steps
  from (
    select jsonb_build_object(
             'position', s.position,
             'channel', s.channel,
             'wait_hours', s.wait_hours,
             'condition', s.condition,
             'is_last', s.is_last,
             'variants', coalesce((
               select jsonb_agg(jsonb_build_object('label', v.label, 'subject', v.subject, 'body', v.body)
                      order by v.label)
               from public.sequence_variants v
               where v.workspace_id = s.workspace_id and v.step_id = s.id and v.active
             ), '[]'::jsonb)
           ) as step
    from public.sequence_steps s
    where s.workspace_id = ws and s.campaign_id = p_campaign
  ) rows;

  if steps is null then
    raise exception 'That campaign has no sequence to save' using errcode = 'no_data_found';
  end if;

  -- The insert is subject to row-level security: a rep or viewer cannot save
  insert into public.templates (workspace_id, kind, name, description, payload)
  values (ws, 'sequence', trim(p_name), nullif(trim(p_description), ''), jsonb_build_object('steps', steps))
  returning id into new_id;
  return new_id;
end;
$$;

-- ---------------------------------------------------------------- apply
-- Replaces a campaign's sequence with a template's steps. Returns how many
-- steps were written.
--
-- The template may belong to the workspace or to the agency above it; row-level
-- security on the select decides whether the caller may see it at all.
-- Applying replaces the campaign's sequence. The old steps go, and because the
-- record of what was sent hangs off a step, that record goes with them. So a
-- campaign that has already sent something is refused unless the caller says
-- plainly to replace it anyway.
create function public.template_apply_sequence(ws uuid, p_template uuid, p_campaign uuid, p_replace_sent boolean default false)
returns integer
language plpgsql
security invoker
set search_path = ''
as $$
declare
  steps jsonb;
  step jsonb;
  variant jsonb;
  new_step uuid;
  written integer := 0;
  already_sent integer;
begin
  if not app.has_role(ws, array['owner', 'admin']::public.workspace_role[]) then
    raise exception 'Only owners and admins can apply a template' using errcode = 'insufficient_privilege';
  end if;
  if not exists (select 1 from public.campaigns c where c.workspace_id = ws and c.id = p_campaign) then
    raise exception 'That campaign was not found' using errcode = 'no_data_found';
  end if;

  select t.payload->'steps' into steps
  from public.templates t
  where t.id = p_template and t.kind = 'sequence';
  if steps is null or jsonb_typeof(steps) <> 'array' or jsonb_array_length(steps) = 0 then
    raise exception 'That template was not found, or it holds no steps' using errcode = 'no_data_found';
  end if;

  select count(*)::int into already_sent
  from public.lead_step_runs r
  join public.sequence_steps s on s.workspace_id = r.workspace_id and s.id = r.step_id
  where r.workspace_id = ws and s.campaign_id = p_campaign and r.outcome = 'sent';

  if already_sent > 0 and not coalesce(p_replace_sent, false) then
    raise exception 'This campaign has already sent % sequence %. Applying a template replaces the sequence and the record of what was sent.',
      already_sent, case when already_sent = 1 then 'step' else 'steps' end
      using errcode = 'raise_exception';
  end if;

  -- Replacing, not merging: a half-template, half-old sequence would behave in
  -- a way nobody chose.
  delete from public.sequence_steps s where s.workspace_id = ws and s.campaign_id = p_campaign;

  for step in select * from jsonb_array_elements(steps) loop
    insert into public.sequence_steps (workspace_id, campaign_id, position, channel, wait_hours, condition, is_last)
    values (
      ws, p_campaign,
      (step->>'position')::smallint,
      step->>'channel',
      coalesce((step->>'wait_hours')::smallint, 48),
      coalesce(step->'condition', '{}'::jsonb),
      coalesce((step->>'is_last')::boolean, false)
    )
    returning id into new_step;
    written := written + 1;

    for variant in select * from jsonb_array_elements(coalesce(step->'variants', '[]'::jsonb)) loop
      insert into public.sequence_variants (workspace_id, step_id, label, subject, body)
      values (ws, new_step, variant->>'label', nullif(variant->>'subject', ''), variant->>'body');
    end loop;
  end loop;

  return written;
end;
$$;

-- ---------------------------------------------------------------- agency defaults
-- Copies an agency's default templates into a new client workspace, so a new
-- client starts with the agency's library rather than an empty one.
create function app.copy_agency_default_templates()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.agency_id is null then
    return new;
  end if;
  insert into public.templates (workspace_id, kind, name, description, payload)
  select new.id, t.kind, t.name, t.description, t.payload
  from public.templates t
  where t.agency_id = new.agency_id and t.is_default
  on conflict do nothing;
  return new;
end;
$$;

create trigger workspaces_copy_agency_templates after insert on public.workspaces
  for each row execute function app.copy_agency_default_templates();

revoke execute on function public.template_save_sequence(uuid, uuid, text, text) from public, anon;
revoke execute on function public.template_apply_sequence(uuid, uuid, uuid, boolean) from public, anon;
grant execute on function public.template_save_sequence(uuid, uuid, text, text) to authenticated, service_role;
grant execute on function public.template_apply_sequence(uuid, uuid, uuid, boolean) to authenticated, service_role;
