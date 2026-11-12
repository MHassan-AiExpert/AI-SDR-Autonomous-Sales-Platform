-- =============================================================================
-- Team management RPCs used by the web app
--
-- Member emails live in auth.users, which clients cannot read. These two
-- functions expose exactly what the team screen needs, with the same role
-- rules as the row-level security policies.
-- =============================================================================

-- List the members of a workspace with their email (members only)
create function public.workspace_members_list(ws uuid)
returns table (user_id uuid, email text, role public.workspace_role, joined_at timestamptz)
language sql
stable
security definer
set search_path = ''
as $$
  select m.user_id, u.email::text, m.role, m.created_at
  from public.workspace_members m
  join auth.users u on u.id = m.user_id
  where m.workspace_id = ws
    and app.is_member(ws)
  order by m.created_at, u.email;
$$;

-- Add an existing account to a workspace by email.
-- Owners can add any role; admins can add reps and viewers.
create function public.workspace_member_add(
  ws uuid,
  member_email text,
  member_role public.workspace_role default 'rep'
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  target uuid;
begin
  if not (
    app.has_role(ws, array['owner']::public.workspace_role[])
    or (app.has_role(ws, array['admin']::public.workspace_role[]) and member_role in ('rep', 'viewer'))
  ) then
    raise exception 'You are not allowed to add a member with this role'
      using errcode = 'insufficient_privilege';
  end if;

  select u.id into target
  from auth.users u
  where lower(u.email) = lower(trim(member_email));

  if target is null then
    raise exception 'No account found for this email. Ask them to sign up first.'
      using errcode = 'no_data_found';
  end if;

  if exists (
    select 1 from public.workspace_members m
    where m.workspace_id = ws and m.user_id = target
  ) then
    raise exception 'This person is already a member of the workspace'
      using errcode = 'unique_violation';
  end if;

  insert into public.workspace_members (workspace_id, user_id, role)
  values (ws, target, member_role);

  return target;
end;
$$;

revoke execute on function public.workspace_members_list(uuid) from public, anon;
revoke execute on function public.workspace_member_add(uuid, text, public.workspace_role) from public, anon;
grant execute on function public.workspace_members_list(uuid) to authenticated, service_role;
grant execute on function public.workspace_member_add(uuid, text, public.workspace_role) to authenticated, service_role;
