-- =============================================================================
-- Self-learning (SRS M24)
--
-- Every week the learning agent measures, in code, which subject lines, email
-- lengths, lead sources, score bands, audits and follow-up channels won
-- positive replies and meetings, and keeps only differences that are large
-- enough to trust. It turns them into suggestions: lessons the copywriter
-- follows, or a new score threshold. Owners and admins apply or dismiss them;
-- with auto-apply on, lessons are applied as they are found.
-- =============================================================================

alter table public.agent_jobs drop constraint agent_jobs_type_check;
alter table public.agent_jobs add constraint agent_jobs_type_check
  check (type in ('campaign_plan', 'lead_sourcing', 'enrichment', 'research', 'copywriting', 'email_outreach',
                  'reply_handling', 'reply_send', 'voice_outreach', 'sms_outreach', 'ai_closer', 'audit_reports', 'learning'));

-- ---------------------------------------------------------------- campaigns
alter table public.campaigns
  -- Lessons the copywriter follows, from this campaign's own results
  add column learned_guidance    text[] not null default '{}'
                                 check (cardinality(learned_guidance) <= 8 and length(array_to_string(learned_guidance, '')) <= 1600),
  add column learning_auto_apply boolean not null default false;

-- ---------------------------------------------------------------- reports
create table public.learning_reports (
  id            uuid primary key default gen_random_uuid(),
  workspace_id  uuid not null references public.workspaces (id) on delete cascade,
  campaign_id   uuid not null,
  period_start  timestamptz not null,
  period_end    timestamptz not null,
  stats         jsonb not null default '{}'::jsonb check (pg_column_size(stats) <= 64000),
  findings      jsonb not null default '[]'::jsonb check (jsonb_typeof(findings) = 'array' and pg_column_size(findings) <= 64000),
  summary       text check (length(summary) <= 1200),
  created_at    timestamptz not null default now(),
  unique (workspace_id, id),
  constraint learning_reports_campaign_fk foreign key (workspace_id, campaign_id) references public.campaigns (workspace_id, id) on delete cascade
);
create index learning_reports_campaign_idx on public.learning_reports (workspace_id, campaign_id, created_at desc);

create table public.learning_suggestions (
  id            uuid primary key default gen_random_uuid(),
  workspace_id  uuid not null references public.workspaces (id) on delete cascade,
  campaign_id   uuid not null,
  report_id     uuid not null,
  kind          text not null check (kind in ('copy_guidance', 'score_threshold')),
  text          text not null check (length(text) between 5 and 200),
  value         smallint check (value between 0 and 100),
  evidence      text not null check (length(evidence) <= 400),
  finding_id    text not null check (finding_id ~ '^[a-z0-9_:.-]{1,80}$'),
  status        text not null default 'proposed' check (status in ('proposed', 'applied', 'dismissed', 'removed')),
  decided_by    uuid references auth.users (id) on delete set null,
  decided_at    timestamptz,
  created_at    timestamptz not null default now(),
  check ((kind = 'score_threshold') = (value is not null)),
  constraint learning_suggestions_campaign_fk foreign key (workspace_id, campaign_id) references public.campaigns (workspace_id, id) on delete cascade,
  constraint learning_suggestions_report_fk foreign key (workspace_id, report_id) references public.learning_reports (workspace_id, id) on delete cascade
);
-- The same lesson is not suggested twice while it is waiting or in use
create unique index learning_suggestions_open_key on public.learning_suggestions (workspace_id, campaign_id, kind, finding_id) where status in ('proposed', 'applied');
create index learning_suggestions_campaign_idx on public.learning_suggestions (workspace_id, campaign_id, status);

-- Members read; only the platform writes (decisions go through learning_decide)
alter table public.learning_reports enable row level security;
alter table public.learning_suggestions enable row level security;
create policy learning_reports_select on public.learning_reports for select to authenticated using (app.is_member(workspace_id));
create policy learning_suggestions_select on public.learning_suggestions for select to authenticated using (app.is_member(workspace_id));
revoke all on public.learning_reports, public.learning_suggestions from anon;
revoke insert, update, delete on public.learning_reports, public.learning_suggestions from authenticated;
grant select on public.learning_reports, public.learning_suggestions to authenticated;
grant all on public.learning_reports, public.learning_suggestions to service_role;

-- Apply, dismiss or remove a suggestion. Signed-in users cannot write these
-- tables directly, so this checks the caller is an owner or admin of the
-- suggestion's workspace before changing the suggestion and the campaign.
create function public.learning_decide(p_suggestion uuid, p_decision text)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  s public.learning_suggestions;
  uid uuid := auth.uid();
begin
  if p_decision not in ('apply', 'dismiss', 'remove') then
    raise exception 'Unknown decision' using errcode = 'check_violation';
  end if;
  select * into s from public.learning_suggestions where id = p_suggestion;
  if s.id is null or uid is null or not app.has_role(s.workspace_id, array['owner', 'admin']::public.workspace_role[]) then
    raise exception 'Only owners and admins can change lessons' using errcode = '42501';
  end if;
  if p_decision = 'apply' and s.status = 'proposed' then
    if s.kind = 'copy_guidance' then
      update public.campaigns set learned_guidance = (array_append(learned_guidance, s.text))[greatest(1, cardinality(learned_guidance) - 6):], updated_at = now()
      where workspace_id = s.workspace_id and id = s.campaign_id and not (s.text = any (learned_guidance));
    else
      update public.campaigns set score_threshold = s.value, updated_at = now() where workspace_id = s.workspace_id and id = s.campaign_id;
    end if;
    update public.learning_suggestions set status = 'applied', decided_by = uid, decided_at = now() where id = s.id;
    return 'applied';
  elsif p_decision = 'dismiss' and s.status = 'proposed' then
    update public.learning_suggestions set status = 'dismissed', decided_by = uid, decided_at = now() where id = s.id;
    return 'dismissed';
  elsif p_decision = 'remove' and s.status = 'applied' and s.kind = 'copy_guidance' then
    update public.campaigns set learned_guidance = array_remove(learned_guidance, s.text), updated_at = now()
    where workspace_id = s.workspace_id and id = s.campaign_id;
    update public.learning_suggestions set status = 'removed', decided_by = uid, decided_at = now() where id = s.id;
    return 'removed';
  end if;
  raise exception 'This lesson has already been decided' using errcode = 'check_violation';
end;
$$;
revoke execute on function public.learning_decide(uuid, text) from public, anon;
grant execute on function public.learning_decide(uuid, text) to authenticated, service_role;

-- Weekly learning runs for active campaigns
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
                       ('voice_outreach'), ('sms_outreach'), ('learning')) as t(type)
    where c.status = 'active'
      and not w.outreach_paused
      and c.niche is not null
      and (t.type <> 'email_outreach' or c.outreach_status = 'live')
      and (t.type <> 'voice_outreach' or c.voice_status = 'live')
      and (t.type <> 'sms_outreach' or c.sms_status = 'live')
      and not exists (
        select 1 from public.agent_jobs j
        where j.campaign_id = c.id and j.type = t.type
          and (j.status in ('queued', 'running')
               or j.created_at > now() - make_interval(hours => case
                    when t.type in ('voice_outreach', 'sms_outreach') then 1
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
