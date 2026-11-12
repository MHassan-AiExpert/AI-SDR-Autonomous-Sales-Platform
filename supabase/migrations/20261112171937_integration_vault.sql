-- =============================================================================
-- Tool connections with encrypted credentials
--
-- Each company connects its own tool accounts. Credentials are stored
-- encrypted in Supabase Vault under a name derived from the workspace and
-- tool; the integrations table keeps only status and a reference.
--
--   integration_connect / integration_disconnect : owners and admins
--   integration_secret / integration_health_update : backend service role only
--
-- Clients can no longer write the integrations table directly, so a row can
-- never be pointed at another company's secret.
-- =============================================================================

alter table public.integrations
  add column last_error text,
  add constraint integrations_tool_check check (tool in (
    'openai', 'anthropic', 'gemini', 'apollo', 'apify', 'zerobounce', 'instantly', 'twilio',
    'vapi', 'whatsapp', 'zoom', 'calendly', 'hubspot', 'slack', 'pandadoc', 'stripe'));

-- Manual setup steps a company ticks off (sending domains, warm-up, A2P, WhatsApp templates)
alter table public.workspaces
  add column setup_checklist jsonb not null default '{}'::jsonb;

drop policy integrations_insert on public.integrations;
drop policy integrations_update on public.integrations;
drop policy integrations_delete on public.integrations;
revoke insert, update, delete on public.integrations from authenticated;

create function app.integration_secret_name(ws uuid, tool_id text)
returns text
language sql
immutable
set search_path = ''
as $$
  select 'integration:' || ws::text || ':' || tool_id;
$$;

-- Store credentials and record the result of the connection test
create function public.integration_connect(
  ws uuid,
  tool_id text,
  secret jsonb,
  tool_meta jsonb default '{}'::jsonb,
  check_status text default 'connected',
  check_error text default null,
  credits numeric default null
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  secret_name text := app.integration_secret_name(ws, tool_id);
  secret_id uuid;
  integration_id uuid;
begin
  if not app.has_role(ws, array['owner', 'admin']::public.workspace_role[]) then
    raise exception 'Only owners and admins can connect tools'
      using errcode = 'insufficient_privilege';
  end if;
  if check_status not in ('connected', 'error') then
    raise exception 'Invalid connection status' using errcode = 'check_violation';
  end if;
  if secret is null or jsonb_typeof(secret) <> 'object' or secret = '{}'::jsonb
     or length(secret::text) > 8000 or length(coalesce(tool_meta, '{}'::jsonb)::text) > 2000 then
    raise exception 'Invalid credentials' using errcode = 'check_violation';
  end if;

  select s.id into secret_id from vault.secrets s where s.name = secret_name;
  if secret_id is null then
    secret_id := vault.create_secret(secret::text, secret_name, 'Workspace tool credentials');
  else
    perform vault.update_secret(secret_id, secret::text, secret_name, 'Workspace tool credentials');
  end if;

  insert into public.integrations as i
    (workspace_id, tool, status, secret_ref, last_health_check_at, credits_remaining, meta, last_error)
  values
    (ws, tool_id, check_status, secret_id::text, now(), credits, coalesce(tool_meta, '{}'::jsonb), left(check_error, 300))
  on conflict (workspace_id, tool) do update set
    status = excluded.status,
    secret_ref = excluded.secret_ref,
    last_health_check_at = excluded.last_health_check_at,
    credits_remaining = excluded.credits_remaining,
    meta = excluded.meta,
    last_error = excluded.last_error
  returning i.id into integration_id;

  insert into public.audit_log (workspace_id, actor_id, action, entity, entity_id, detail)
  values (ws, auth.uid(), 'integration.connected', 'integration', tool_id,
          jsonb_build_object('status', check_status));

  return integration_id;
end;
$$;

-- Remove the credentials and mark the tool disconnected
create function public.integration_disconnect(ws uuid, tool_id text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not app.has_role(ws, array['owner', 'admin']::public.workspace_role[]) then
    raise exception 'Only owners and admins can disconnect tools'
      using errcode = 'insufficient_privilege';
  end if;

  delete from vault.secrets s where s.name = app.integration_secret_name(ws, tool_id);

  update public.integrations
  set status = 'disconnected', secret_ref = null, credits_remaining = null, last_error = null, meta = '{}'::jsonb
  where workspace_id = ws and tool = tool_id;

  if found then
    insert into public.audit_log (workspace_id, actor_id, action, entity, entity_id)
    values (ws, auth.uid(), 'integration.disconnected', 'integration', tool_id);
  end if;
end;
$$;

-- Decrypted credentials for a workspace's tool. Backend workers only.
create function public.integration_secret(ws uuid, tool_id text)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select d.decrypted_secret::jsonb
  from vault.decrypted_secrets d
  join public.integrations i
    on i.workspace_id = ws and i.tool = tool_id and i.status <> 'disconnected'
  where d.name = app.integration_secret_name(ws, tool_id);
$$;

-- Result of a scheduled health check. Backend workers only.
create function public.integration_health_update(
  ws uuid,
  tool_id text,
  new_status text,
  error_message text default null,
  credits numeric default null
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new_status not in ('connected', 'error', 'expired') then
    raise exception 'Invalid connection status' using errcode = 'check_violation';
  end if;
  update public.integrations
  set status = new_status,
      last_error = left(error_message, 300),
      credits_remaining = coalesce(credits, credits_remaining),
      last_health_check_at = now()
  where workspace_id = ws and tool = tool_id and status <> 'disconnected';
end;
$$;

-- When a workspace is deleted, its encrypted credentials go with it
create function app.purge_workspace_secrets()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  delete from vault.secrets s where s.name like 'integration:' || old.id::text || ':%';
  return old;
end;
$$;

create trigger workspaces_purge_secrets before delete on public.workspaces
  for each row execute function app.purge_workspace_secrets();

revoke execute on function public.integration_connect(uuid, text, jsonb, jsonb, text, text, numeric) from public, anon;
revoke execute on function public.integration_disconnect(uuid, text) from public, anon;
revoke execute on function public.integration_secret(uuid, text) from public, anon, authenticated;
revoke execute on function public.integration_health_update(uuid, text, text, text, numeric) from public, anon, authenticated;
grant execute on function public.integration_connect(uuid, text, jsonb, jsonb, text, text, numeric) to authenticated, service_role;
grant execute on function public.integration_disconnect(uuid, text) to authenticated, service_role;
grant execute on function public.integration_secret(uuid, text) to service_role;
grant execute on function public.integration_health_update(uuid, text, text, text, numeric) to service_role;
