-- =============================================================================
-- Website and marketing audits (SRS M16)
--
-- For each qualified lead the audit agent checks the company's website in
-- code (security, search basics, mobile, speed, contact and booking options,
-- tracking, structured data, social profiles, reviews) and writes three
-- recommendations tied to the offer. The audit is shared as a private page
-- behind an unguessable link; opening it is tracked, appears on the lead's
-- timeline and alerts the team. The first email links to it.
-- =============================================================================

alter table public.agent_jobs drop constraint agent_jobs_type_check;
alter table public.agent_jobs add constraint agent_jobs_type_check
  check (type in ('campaign_plan', 'lead_sourcing', 'enrichment', 'research', 'copywriting', 'email_outreach',
                  'reply_handling', 'reply_send', 'voice_outreach', 'sms_outreach', 'ai_closer', 'audit_reports'));

alter table public.campaigns
  add column audit_enabled boolean not null default false;

-- ---------------------------------------------------------------- assets
alter table public.assets
  add column campaign_id      uuid,
  add column status           text not null default 'ready' check (status in ('ready', 'no_website', 'failed')),
  add column title            text check (length(title) <= 200),
  add column score            smallint check (score between 0 and 100),
  add column content          jsonb not null default '{}'::jsonb check (pg_column_size(content) <= 64000),
  -- The private link: 48 random hex characters
  add column share_token      text check (share_token ~ '^[0-9a-f]{48}$'),
  add column expires_at       timestamptz not null default now() + interval '120 days',
  add column first_viewed_at  timestamptz,
  add column last_viewed_at   timestamptz,
  add column alerted_at       timestamptz,
  add column error            text check (length(error) <= 400),
  add constraint assets_web_url_https check (web_url ~ '^https?://'),
  add constraint assets_campaign_fk foreign key (workspace_id, campaign_id)
    references public.campaigns (workspace_id, id) on delete set null (campaign_id);
create unique index assets_share_token_key on public.assets (share_token) where share_token is not null;
-- One audit per lead per campaign
create unique index assets_one_audit_key on public.assets (workspace_id, campaign_id, lead_id) where type = 'audit';
create index assets_alert_idx on public.assets (workspace_id, campaign_id) where first_viewed_at is not null and alerted_at is null;

-- Audits are written by the platform; people read them, and may delete them
create function app.assets_client_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if current_user = 'authenticated' and new.type = 'audit' then
    raise exception 'Audits are created by the platform' using errcode = '42501';
  end if;
  return new;
end;
$$;
create trigger assets_client_guard before insert or update on public.assets
  for each row execute function app.assets_client_guard();

-- ---------------------------------------------------------------- the shared page
-- What a visitor with the link may see: the audit itself and whose it is, never
-- contact details. Expired or unfinished audits return nothing.
create function public.audit_public(p_token text)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'title', a.title, 'score', a.score, 'content', a.content, 'created_at', a.created_at,
    'company', c.name, 'first_name', nullif(split_part(coalesce(l.full_name, ''), ' ', 1), ''),
    'from_company', w.name, 'sender_name', k.sender_name)
  from public.assets a
  join public.leads l on l.workspace_id = a.workspace_id and l.id = a.lead_id
  join public.workspaces w on w.id = a.workspace_id
  left join public.companies c on c.workspace_id = l.workspace_id and c.id = l.company_id
  left join public.campaigns k on k.workspace_id = a.workspace_id and k.id = a.campaign_id
  where p_token ~ '^[0-9a-f]{48}$' and a.share_token = p_token and a.type = 'audit' and a.status = 'ready' and a.expires_at > now()
$$;

-- A visit to the shared page: the open is counted, time on the page is added
-- (capped), and the first open goes on the timeline and alerts the team
create function public.audit_view(p_token text, p_seconds integer default 0)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  a record;
begin
  if p_token !~ '^[0-9a-f]{48}$' or p_seconds is null or p_seconds < 0 then
    return;
  end if;
  update public.assets set
    views = views + case when p_seconds = 0 then 1 else 0 end,
    seconds_viewed = least(86400, seconds_viewed + least(p_seconds, 600)),
    first_viewed_at = coalesce(first_viewed_at, now()),
    last_viewed_at = now()
  where share_token = p_token and type = 'audit' and status = 'ready' and expires_at > now()
  returning id, workspace_id, lead_id, campaign_id, views into a;
  if a.id is null or not (p_seconds = 0 and a.views = 1) then
    return;
  end if;
  insert into public.activities (workspace_id, lead_id, type, channel, summary, actor, record_table, record_id)
  values (a.workspace_id, a.lead_id, 'asset_view', 'email', 'Opened the website audit', 'system', 'assets', a.id);
  update public.leads set stage = 'engaged', stage_changed_at = now(), updated_at = now()
  where workspace_id = a.workspace_id and id = a.lead_id and stage in ('new', 'contacted');
  if a.campaign_id is not null then
    insert into public.agent_jobs (workspace_id, campaign_id, type, requested_by)
    values (a.workspace_id, a.campaign_id, 'audit_reports', null)
    on conflict do nothing;
  end if;
end;
$$;

revoke execute on function public.audit_public(text) from public;
revoke execute on function public.audit_view(text, integer) from public;
grant execute on function public.audit_public(text) to anon, authenticated, service_role;
grant execute on function public.audit_view(text, integer) to anon, authenticated, service_role;
