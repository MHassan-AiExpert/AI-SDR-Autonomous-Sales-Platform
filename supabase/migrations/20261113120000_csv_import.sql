-- =============================================================================
-- CSV import and bulk actions (F21)
--
-- A lead list uploaded as CSV goes through the same hygiene as a sourced lead:
-- normalized, checked for a usable contact, checked against the suppression
-- list, and deduplicated against existing leads and against the rest of the
-- file. The import is recorded so the team can see what happened and undo it.
--
-- The work is done in the database so there is one implementation of import
-- hygiene, callable from the web app and from the agent service. The function
-- is security invoker, so row-level security decides who may import.
-- =============================================================================

create table public.lead_imports (
  id            uuid primary key default gen_random_uuid(),
  workspace_id  uuid not null references public.workspaces (id) on delete cascade,
  campaign_id   uuid,
  filename      text not null check (length(trim(filename)) between 1 and 200),
  total_rows    integer not null default 0 check (total_rows >= 0),
  added         integer not null default 0 check (added >= 0),
  duplicates    integer not null default 0 check (duplicates >= 0),
  suppressed    integer not null default 0 check (suppressed >= 0),
  invalid       integer not null default 0 check (invalid >= 0),
  undone_at     timestamptz,
  created_by    uuid default auth.uid() references auth.users (id) on delete set null,
  created_at    timestamptz not null default now(),
  constraint lead_imports_campaign_fk foreign key (workspace_id, campaign_id)
    references public.campaigns (workspace_id, id) on delete set null (campaign_id),
  unique (workspace_id, id)
);
create index lead_imports_recent_idx on public.lead_imports (workspace_id, created_at desc);

-- Which import a lead came from, so an import can be undone
alter table public.leads
  add column import_id uuid,
  add constraint leads_import_fk foreign key (workspace_id, import_id)
    references public.lead_imports (workspace_id, id) on delete set null (import_id);
create index leads_workspace_import_idx on public.leads (workspace_id, import_id) where import_id is not null;

alter table public.lead_imports enable row level security;
create policy lead_imports_select on public.lead_imports for select to authenticated
  using (app.is_member(workspace_id));
create policy lead_imports_insert on public.lead_imports for insert to authenticated
  with check (app.has_role(workspace_id, array['owner', 'admin', 'rep']::public.workspace_role[]));
create policy lead_imports_update on public.lead_imports for update to authenticated
  using (app.has_role(workspace_id, array['owner', 'admin', 'rep']::public.workspace_role[]))
  with check (app.has_role(workspace_id, array['owner', 'admin', 'rep']::public.workspace_role[]));
revoke all on public.lead_imports from anon;
grant select, insert, update on public.lead_imports to authenticated;
grant all on public.lead_imports to service_role;

-- ---------------------------------------------------------------- import
-- p_rows: [{"email": "...", "phone": "...", "full_name": "...", "title": "...",
--           "linkedin_url": "...", "company": "..."}, ...]
-- Returns the counts, so the interface can say exactly what happened.
create function public.leads_import(ws uuid, p_campaign uuid, p_filename text, p_rows jsonb)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  import_id uuid;
  counts record;
begin
  if jsonb_typeof(p_rows) <> 'array' then
    raise exception 'The rows must be a list' using errcode = 'check_violation';
  end if;
  if jsonb_array_length(p_rows) > 5000 then
    raise exception 'Import up to 5000 rows at a time' using errcode = 'check_violation';
  end if;

  -- The insert is subject to row-level security: a viewer cannot import
  insert into public.lead_imports (workspace_id, campaign_id, filename, total_rows)
  values (ws, p_campaign, left(trim(p_filename), 200), jsonb_array_length(p_rows))
  returning id into import_id;

  -- Every cleaned row is kept, with a flag for each decision, so the counts
  -- are correct even when nothing survives.
  create temp table _import_rows on commit drop as
  with raw as (
    select
      row_number() over () as rn,
      nullif(lower(trim(r->>'email')), '') as email,
      nullif(trim(r->>'phone'), '') as phone,
      nullif(trim(r->>'full_name'), '') as full_name,
      nullif(trim(r->>'title'), '') as title,
      nullif(lower(trim(r->>'linkedin_url')), '') as linkedin_url,
      nullif(trim(r->>'company'), '') as company
    from jsonb_array_elements(p_rows) as r
  ), clean as (
    select rn,
      -- An address that is not shaped like one is treated as missing
      case when email ~ '^[^\s@<>"]{1,64}@[^\s@<>"]{1,255}\.[A-Za-z]{2,}$' then email end as email,
      -- Digits and a leading +, nothing else
      case when regexp_replace(coalesce(phone, ''), '[^0-9+]', '', 'g') ~ '^\+?[0-9]{7,15}$'
        then regexp_replace(phone, '[^0-9+]', '', 'g') end as phone,
      left(full_name, 200) as full_name,
      left(title, 200) as title,
      case when linkedin_url ~ '^https://([a-z]{2,3}\.)?linkedin\.com/' then left(linkedin_url, 300) end as linkedin_url,
      left(company, 200) as company
    from raw
  ), flagged as (
    -- A row needs at least one way to reach the lead
    select c.*, (c.email is not null or c.phone is not null or c.linkedin_url is not null) as is_usable
    from clean c
  ), supp as (
    select f.*,
      f.is_usable and not exists (
        select 1 from public.suppressions s
        where s.workspace_id = ws
          and ((s.kind = 'email' and f.email is not null and s.value = f.email)
            or (s.kind = 'phone' and f.phone is not null and s.value = f.phone)
            or (s.kind = 'domain' and f.email is not null and s.value = split_part(f.email, '@', 2)))
      ) as is_allowed
    from flagged f
  )
  select s.*,
    -- Not already a lead here, and the first occurrence within the file
    s.is_allowed
    and (s.email is null or not exists (
          select 1 from public.leads l where l.workspace_id = ws and lower(l.email) = s.email))
    and (s.email is null or s.rn = (select min(b.rn) from supp b where b.is_allowed and b.email = s.email)) as is_new
  from supp s;

  -- Companies named in the file that the workspace does not have yet
  -- One company per name, matched without regard to case; the first spelling wins
  insert into public.companies (workspace_id, name)
  select distinct on (lower(r.company)) ws, r.company
  from _import_rows r
  where r.is_new and r.company is not null
    and not exists (select 1 from public.companies c where c.workspace_id = ws and lower(c.name) = lower(r.company))
  order by lower(r.company), r.rn;

  with ins as (
    insert into public.leads (workspace_id, campaign_id, company_id, import_id, full_name, email, phone, title,
                              linkedin_url, source_channel, source_query, stage)
    select ws, p_campaign,
           (select c.id from public.companies c where c.workspace_id = ws and lower(c.name) = lower(r.company) limit 1),
           import_id, r.full_name, r.email, r.phone, r.title, r.linkedin_url,
           'csv', left(trim(p_filename), 200), 'new'
    from _import_rows r where r.is_new
    returning 1
  )
  select
    (select count(*) from ins)::int as added,
    (select count(*) from _import_rows where is_usable)::int as usable,
    (select count(*) from _import_rows where is_allowed)::int as allowed
  into counts;

  update public.lead_imports set
    added = counts.added,
    invalid = jsonb_array_length(p_rows) - counts.usable,
    suppressed = counts.usable - counts.allowed,
    duplicates = counts.allowed - counts.added
  where id = import_id;

  return (select to_jsonb(i) from public.lead_imports i where i.id = import_id);
end;
$$;

-- Removes the leads an import added, provided they have not been worked yet
create function public.lead_import_undo(p_import uuid)
returns integer
language plpgsql
security invoker
set search_path = ''
as $$
declare
  removed integer;
  ws uuid;
begin
  select workspace_id into ws from public.lead_imports where id = p_import and undone_at is null;
  if ws is null then
    raise exception 'That import was not found, or it has already been undone' using errcode = 'no_data_found';
  end if;
  -- Deleting leads is an owner and admin action, so undoing an import is too
  if not app.has_role(ws, array['owner', 'admin']::public.workspace_role[]) then
    raise exception 'Only owners and admins can undo an import' using errcode = 'insufficient_privilege';
  end if;
  -- Only untouched leads go: anything contacted, replied to or booked stays
  delete from public.leads l
  where l.workspace_id = ws and l.import_id = p_import and l.stage = 'new'
    and not exists (select 1 from public.activities a where a.workspace_id = ws and a.lead_id = l.id);
  get diagnostics removed = row_count;
  update public.lead_imports set undone_at = now() where id = p_import;
  return removed;
end;
$$;

revoke execute on function public.leads_import(uuid, uuid, text, jsonb) from public, anon;
revoke execute on function public.lead_import_undo(uuid) from public, anon;
grant execute on function public.leads_import(uuid, uuid, text, jsonb) to authenticated, service_role;
grant execute on function public.lead_import_undo(uuid) to authenticated, service_role;
