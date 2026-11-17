-- =============================================================================
-- Signals agent (F26, agent #17)
--
-- Watches leads already in the workspace and records what changes about them:
-- funding and news, hiring, technology changes, and people moving job. A
-- signal is the hook for a timely message, so it feeds the F22 sequence as a
-- fact a step can wait for, and the copywriter as an opening line.
--
-- Three tiers, each optional:
--   built in  : web search, the company website and Apollo; no extra vendor
--   paid      : Bombora, 6sense and the like
--   social    : listening tools that find posts describing the problem
-- The paid and social tiers arrive through the workspace's existing webhook
-- address (signal_ingest below), so any such tool can send signals without a
-- dedicated integration, and the agent has nothing to skip when none is used.
--
-- Job changes cost an Apollo credit per person, so they are opt-in per
-- campaign and checked at most once a month per lead.
-- =============================================================================

create table public.signals (
  id            uuid primary key default gen_random_uuid(),
  workspace_id  uuid not null references public.workspaces (id) on delete cascade,
  company_id    uuid,
  lead_id       uuid,
  campaign_id   uuid,
  kind          text not null check (kind in ('funding', 'news', 'hiring', 'tech_change', 'job_change',
                                              'intent_surge', 'social_post', 'website_visit')),
  -- Where it came from: the agent's own checks, or a tool sending it in
  source        text not null check (source in ('web_search', 'website', 'apollo', 'ingest', 'visitor')),
  -- The sending tool's name for ingested signals, e.g. "bombora"
  provider      text check (provider is null or provider ~ '^[a-z0-9][a-z0-9_.-]{0,59}$'),
  title         text not null check (length(trim(title)) between 1 and 300),
  detail        text check (detail is null or length(detail) <= 2000),
  url           text check (url is null or (url ~ '^https?://' and length(url) <= 1000)),
  occurred_at   timestamptz,
  -- The same event reported twice is one signal
  fingerprint   text not null check (length(fingerprint) between 8 and 200),
  status        text not null default 'new' check (status in ('new', 'used', 'dismissed')),
  used_at       timestamptz,
  created_at    timestamptz not null default now(),
  constraint signals_company_fk foreign key (workspace_id, company_id)
    references public.companies (workspace_id, id) on delete cascade,
  constraint signals_lead_fk foreign key (workspace_id, lead_id)
    references public.leads (workspace_id, id) on delete cascade,
  constraint signals_campaign_fk foreign key (workspace_id, campaign_id)
    references public.campaigns (workspace_id, id) on delete set null (campaign_id),
  -- A signal is about a company, a person, or both; never about nobody
  constraint signals_about_someone check (company_id is not null or lead_id is not null),
  unique (workspace_id, fingerprint),
  unique (workspace_id, id)
);
create index signals_recent_idx on public.signals (workspace_id, created_at desc);
create index signals_company_new_idx on public.signals (workspace_id, company_id, created_at desc) where status = 'new';
create index signals_lead_new_idx on public.signals (workspace_id, lead_id, created_at desc) where status = 'new';

alter table public.signals enable row level security;
create policy signals_select on public.signals for select to authenticated
  using (app.is_member(workspace_id));
-- People may dismiss a signal or mark it used; nothing else about it changes
create policy signals_update on public.signals for update to authenticated
  using (app.has_role(workspace_id, array['owner', 'admin', 'rep']::public.workspace_role[]))
  with check (app.has_role(workspace_id, array['owner', 'admin', 'rep']::public.workspace_role[]));
revoke all on public.signals from anon, authenticated;
grant select on public.signals to authenticated;
grant update (status, used_at) on public.signals to authenticated;
grant all on public.signals to service_role;

-- What the agent remembers between runs
alter table public.companies
  add column tech_stack text[],
  add column signals_checked_at timestamptz;
alter table public.leads
  add column job_checked_at timestamptz;

-- Per campaign: whether to watch, and for what
alter table public.campaigns
  add column signals_enabled boolean not null default false,
  add column signal_kinds text[] not null default array['funding', 'news', 'hiring', 'tech_change']::text[]
    check (signal_kinds <@ array['funding', 'news', 'hiring', 'tech_change', 'job_change']::text[]);

alter table public.agent_jobs drop constraint agent_jobs_type_check;
alter table public.agent_jobs add constraint agent_jobs_type_check
  check (type in ('campaign_plan', 'lead_sourcing', 'enrichment', 'research', 'copywriting', 'email_outreach',
                  'reply_handling', 'reply_send', 'voice_outreach', 'sms_outreach', 'ai_closer', 'audit_reports',
                  'learning', 'crm_sync', 'sequence', 'signals'));

-- ---------------------------------------------------------------- ingest
-- The paid and social tiers. Any tool may send a signal to the workspace's
-- webhook address; it is matched to a company by domain, or to a lead by
-- email. A signal about nobody in the workspace is refused rather than kept,
-- so the endpoint cannot be used to store arbitrary data.
create function public.signal_ingest(p_token text, p_signal jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  ws uuid;
  dom text;
  mail text;
  co uuid;
  ld uuid;
  k text := lower(trim(p_signal->>'kind'));
  t text := trim(p_signal->>'title');
  fp text;
  prov text := nullif(lower(regexp_replace(coalesce(p_signal->>'provider', ''), '[^A-Za-z0-9_.-]', '', 'g')), '');
  new_id uuid;
begin
  if p_token is null or length(p_token) <> 64 then
    raise exception 'Unknown webhook address' using errcode = '28000';
  end if;
  select id into ws from public.workspaces where webhook_token = p_token;
  if ws is null then
    raise exception 'Unknown webhook address' using errcode = '28000';
  end if;
  if jsonb_typeof(p_signal) <> 'object' or pg_column_size(p_signal) > 8000 then
    raise exception 'A signal is a JSON object of at most 8 KB' using errcode = '22023';
  end if;
  if k not in ('funding', 'news', 'hiring', 'tech_change', 'job_change', 'intent_surge', 'social_post') then
    raise exception 'Unknown kind; use funding, news, hiring, tech_change, job_change, intent_surge or social_post' using errcode = '22023';
  end if;
  if t is null or length(t) not between 1 and 300 then
    raise exception 'A signal needs a title of 1 to 300 characters' using errcode = '22023';
  end if;

  dom := nullif(lower(regexp_replace(trim(coalesce(p_signal->>'domain', '')), '^(https?://)?(www\.)?([^/]+).*$', '\3')), '');
  mail := nullif(lower(trim(coalesce(p_signal->>'email', ''))), '');
  if mail is not null then
    select l.id, l.company_id into ld, co from public.leads l where l.workspace_id = ws and lower(l.email) = mail limit 1;
  end if;
  if co is null and dom is not null then
    select c.id into co from public.companies c where c.workspace_id = ws and c.domain = dom limit 1;
  end if;
  if co is null and ld is null then
    return jsonb_build_object('stored', false, 'reason', 'No company or lead in this workspace matches that domain or email');
  end if;

  -- The sending tool's own event id when it gives one, otherwise the content.
  -- Always scoped by the tool, so two tools that both number their events
  -- from 1 cannot overwrite each other's signals.
  fp := md5(concat_ws('|', coalesce(prov, ''),
                      coalesce(nullif(trim(p_signal->>'id'), ''),
                               concat_ws('|', k, coalesce(co::text, ld::text), lower(t), coalesce(p_signal->>'url', '')))));

  insert into public.signals (workspace_id, company_id, lead_id, kind, source, provider, title, detail, url, occurred_at, fingerprint)
  values (
    ws, co, ld, k, 'ingest',
    left(prov, 60),
    t,
    nullif(left(trim(coalesce(p_signal->>'detail', '')), 2000), ''),
    case when coalesce(p_signal->>'url', '') ~ '^https?://' then left(p_signal->>'url', 1000) end,
    case when coalesce(p_signal->>'occurred_at', '') ~ '^\d{4}-\d{2}-\d{2}' then (p_signal->>'occurred_at')::timestamptz end,
    'ingest:' || fp
  )
  on conflict (workspace_id, fingerprint) do nothing
  returning id into new_id;

  return jsonb_build_object('stored', new_id is not null, 'duplicate', new_id is null);
end;
$$;

revoke execute on function public.signal_ingest(text, jsonb) from public;
-- The address itself is the credential, as it is for the other webhooks
grant execute on function public.signal_ingest(text, jsonb) to anon, authenticated, service_role;

create or replace function public.sequence_candidates(ws uuid, p_campaign uuid, p_limit integer default 200)
returns table (lead_id uuid, email text, phone text, full_name text, title text,
               company_name text, domain text, score smallint, stage text,
               phone_line_type text, consent jsonb, ai_report jsonb, facts jsonb)
language sql
stable
security invoker
set search_path = ''
as $$
  with touch as (
    select l.id as lead_id,
           greatest(
             coalesce((select max(e.sent_at) from public.emails e
                       where e.workspace_id = l.workspace_id and e.lead_id = l.id and e.status = 'sent'), 'epoch'::timestamptz),
             coalesce((select max(coalesce(c.ended_at, c.started_at)) from public.calls c
                       where c.workspace_id = l.workspace_id and c.lead_id = l.id and c.direction = 'outbound'), 'epoch'::timestamptz),
             coalesce((select max(m.sent_at) from public.messages m
                       where m.workspace_id = l.workspace_id and m.lead_id = l.id and m.direction = 'outbound'), 'epoch'::timestamptz)
           ) as last_touch
    from public.leads l
    where l.workspace_id = ws and l.campaign_id = p_campaign
  )
  select
    l.id, l.email, l.phone, l.full_name, l.title,
    coalesce(co.name, '') as company_name, co.domain, l.score, l.stage,
    l.phone_line_type, l.consent, l.ai_report,
    jsonb_build_object(
      'stage', l.stage,
      'score', coalesce(l.score, 0),
      'emails_sent', (select count(*) from public.emails e
                      where e.workspace_id = l.workspace_id and e.lead_id = l.id and e.status = 'sent'),
      'email_bounced', exists (select 1 from public.emails e
                      where e.workspace_id = l.workspace_id and e.lead_id = l.id and e.status = 'bounced'),
      'replied', exists (select 1 from public.replies r
                      where r.workspace_id = l.workspace_id and r.lead_id = l.id),
      'reply_type', (select r.classification from public.replies r
                      where r.workspace_id = l.workspace_id and r.lead_id = l.id
                      order by r.created_at desc limit 1),
      'calls_made', (select count(*) from public.calls c
                      where c.workspace_id = l.workspace_id and c.lead_id = l.id
                        and c.direction = 'outbound' and c.status = 'ended'),
      'call_outcome', (select c.outcome from public.calls c
                      where c.workspace_id = l.workspace_id and c.lead_id = l.id and c.direction = 'outbound'
                      order by coalesce(c.ended_at, c.started_at, c.created_at) desc limit 1),
      'texts_sent', (select count(*) from public.messages m
                      where m.workspace_id = l.workspace_id and m.lead_id = l.id and m.direction = 'outbound'),
      'meeting_booked', exists (select 1 from public.meetings mt
                      where mt.workspace_id = l.workspace_id and mt.lead_id = l.id),
      -- Null when the lead has never been contacted, which every condition
      -- treats as "long enough ago"
      'hours_since_last_touch', case when t.last_touch = 'epoch'::timestamptz then null
                      else floor(extract(epoch from (now() - t.last_touch)) / 3600)::int end,
      'has_email', l.email is not null and l.verification_status = 'valid',
      'has_phone', l.phone is not null,
      'steps_run', (select count(*) from public.lead_step_runs sr
                      where sr.workspace_id = l.workspace_id and sr.lead_id = l.id and sr.outcome = 'sent'),
      'steps_done', coalesce((select jsonb_agg(sr.step_id) from public.lead_step_runs sr
                      where sr.workspace_id = l.workspace_id and sr.lead_id = l.id), '[]'::jsonb),
      'stopped', exists (select 1 from public.lead_step_runs sr
                      join public.sequence_steps ss
                        on ss.workspace_id = sr.workspace_id and ss.id = sr.step_id
                      where sr.workspace_id = l.workspace_id and sr.lead_id = l.id
                        and sr.outcome = 'sent' and ss.is_last),
      -- F26: the newest unused signal about this lead or its company, from
      -- the last 30 days. A step conditioned on it uses it as the hook.
      'signal_new', sg.id is not null,
      'signal_kind', sg.kind,
      'signal_title', sg.title
    ) as facts
  from public.leads l
  join touch t on t.lead_id = l.id
  left join public.companies co on co.workspace_id = l.workspace_id and co.id = l.company_id
  left join lateral (
    select s.id, s.kind, s.title
    from public.signals s
    where s.workspace_id = l.workspace_id and s.status = 'new'
      and s.created_at > now() - interval '30 days'
      and (s.lead_id = l.id or (s.lead_id is null and s.company_id = l.company_id))
    order by s.created_at desc
    limit 1
  ) sg on true
  where l.workspace_id = ws and l.campaign_id = p_campaign
    and l.stage not in ('won', 'lost', 'not_interested', 'do_not_contact')
    and not app.is_suppressed(l.workspace_id, l.email, l.phone)
  order by l.score desc nulls last, l.created_at
  limit greatest(1, least(1000, coalesce(p_limit, 200)));
$$;

create or replace function public.agent_jobs_enqueue_due(p_hours integer default 24)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  queued integer;
  closers integer;
begin
  with due as (
    select c.workspace_id, c.id as campaign_id, t.type
    from public.campaigns c
    join public.workspaces w on w.id = c.workspace_id
    cross join (values ('lead_sourcing'), ('enrichment'), ('research'), ('copywriting'), ('email_outreach'),
                       ('voice_outreach'), ('sms_outreach'), ('learning'), ('crm_sync'), ('sequence'), ('signals')) as t(type)
    where c.status = 'active'
      and not w.outreach_paused
      and c.niche is not null
      and (t.type <> 'email_outreach' or c.outreach_status = 'live')
      and (t.type <> 'voice_outreach' or c.voice_status = 'live')
      and (t.type <> 'sms_outreach' or c.sms_status = 'live')
      and (t.type <> 'crm_sync' or w.crm_sync_enabled)
      -- The sequence agent runs only where branching is on, and there the
      -- fixed call and text jobs stand down so nobody is contacted twice. The
      -- email job still runs: it is what pauses the old Instantly campaign.
      and (t.type <> 'sequence' or c.branching_enabled)
      and (t.type not in ('voice_outreach', 'sms_outreach') or not c.branching_enabled)
      -- F26: the signals agent runs daily where a campaign watches for signals
      and (t.type <> 'signals' or c.signals_enabled)
      and not exists (
        select 1 from public.agent_jobs j
        where j.campaign_id = c.id and j.type = t.type
          and (j.status in ('queued', 'running')
               or j.created_at > now() - make_interval(hours => case
                    when t.type in ('voice_outreach', 'sms_outreach', 'crm_sync', 'sequence') then 1
                    when t.type = 'learning' then 168
                    else greatest(1, p_hours) end))
      )
  ), ins as (
    insert into public.agent_jobs (workspace_id, campaign_id, type, requested_by)
    select workspace_id, campaign_id, type, null from due
    on conflict do nothing
    returning 1
  )
  select count(*) into queued from ins;

  with work as (
    select m.workspace_id, m.campaign_id
    from public.meetings m
    join public.workspaces w on w.id = m.workspace_id
    where m.status = 'scheduled' and m.run_by = 'ai_closer' and m.closer_status = 'pending'
      and m.campaign_id is not null and w.ai_closer_enabled and not w.outreach_paused
      and m.starts_at <= now() + interval '1 minute' and m.starts_at > now() - interval '15 minutes'
    union
    select d.workspace_id, d.campaign_id
    from public.deals d
    join public.workspaces w on w.id = d.workspace_id
    where d.close_status = 'pending' and d.campaign_id is not null and not w.outreach_paused
  ), due as (
    select distinct k.workspace_id, k.campaign_id from work k
    where not exists (select 1 from public.agent_jobs j where j.campaign_id = k.campaign_id and j.type = 'ai_closer'
                        and (j.status in ('queued', 'running') or j.created_at > now() - interval '1 minute'))
  ), ins as (
    insert into public.agent_jobs (workspace_id, campaign_id, type, requested_by)
    select workspace_id, campaign_id, 'ai_closer', null from due
    on conflict do nothing
    returning 1
  )
  select count(*) into closers from ins;
  return queued + closers;
end;
$$;
revoke execute on function public.agent_jobs_enqueue_due(integer) from public, anon, authenticated;
grant execute on function public.agent_jobs_enqueue_due(integer) to service_role;
