-- =============================================================================
-- Conditional branching and A/B testing (F22)
--
-- Until now a campaign's follow-ups were decided by elapsed days alone, and
-- for email the whole sequence was handed to Instantly, which sends step 2 on
-- day 3 whatever happened on a call: it only sees replies to its own emails.
--
-- This migration introduces the sequence itself as data. Each step names a
-- channel, a minimum wait, and a condition that must hold of the lead for the
-- step to run at all. Each step may carry up to three variants, and which
-- variant a lead was sent is recorded so the existing self-learning agent can
-- score them with the same significance test it already applies elsewhere.
--
-- Where the work is divided: this migration gathers the *facts* about a lead
-- in SQL, and the agent service evaluates conditions against them in code,
-- where they can be unit tested. Nothing here interprets a condition.
--
-- Existing campaigns are untouched. Branching applies only once a campaign
-- turns it on, so live campaigns keep the behaviour they have today.
-- =============================================================================

-- The sequence agent is a job like any other, so it is scheduled, retried,
-- rate limited and logged by the machinery that already exists.
alter table public.agent_jobs drop constraint agent_jobs_type_check;
alter table public.agent_jobs add constraint agent_jobs_type_check
  check (type in ('campaign_plan', 'lead_sourcing', 'enrichment', 'research', 'copywriting', 'email_outreach',
                  'reply_handling', 'reply_send', 'voice_outreach', 'sms_outreach', 'ai_closer', 'audit_reports',
                  'learning', 'crm_sync', 'sequence'));

alter table public.campaigns
  -- Opt in per campaign. Off means the current Instantly-sequenced behaviour.
  add column branching_enabled boolean not null default false,
  -- Open tracking is off by default because tracking pixels cost
  -- deliverability. The 'email_opened' condition is only offered when it is on.
  add column open_tracking boolean not null default false;

-- ---------------------------------------------------------------- steps
create table public.sequence_steps (
  id            uuid primary key default gen_random_uuid(),
  workspace_id  uuid not null references public.workspaces (id) on delete cascade,
  campaign_id   uuid not null,
  position      smallint not null check (position between 1 and 20),
  channel       text not null check (channel in ('email', 'voice', 'sms', 'whatsapp')),
  -- The least time that must pass since the lead was last contacted on any
  -- channel. Zero means the step may run as soon as its condition holds.
  wait_hours    smallint not null default 48 check (wait_hours between 0 and 720),
  -- Interpreted by the agent service, never here. Shape:
  --   {"all": [{"fact": "replied", "is": false},
  --            {"fact": "call_outcome", "is": "voicemail"},
  --            {"fact": "emails_sent", "at_least": 1}]}
  -- An empty object means no condition: the wait alone governs.
  condition     jsonb not null default '{}'::jsonb check (jsonb_typeof(condition) = 'object'),
  -- A step that stops the sequence for the lead once it has run
  is_last       boolean not null default false,
  -- For email steps: the one-step Instantly campaign that sends this step.
  -- Created on demand by the agent, so Instantly carries the mailboxes,
  -- sending window and daily limit while this system decides the sequence.
  instantly_campaign_id text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  constraint sequence_steps_campaign_fk foreign key (workspace_id, campaign_id)
    references public.campaigns (workspace_id, id) on delete cascade,
  unique (workspace_id, campaign_id, position),
  unique (workspace_id, id)
);
create index sequence_steps_campaign_idx on public.sequence_steps (workspace_id, campaign_id, position);

-- ---------------------------------------------------------------- variants
-- Up to three per step, enforced by the label check: a, b or c.
create table public.sequence_variants (
  id            uuid primary key default gen_random_uuid(),
  workspace_id  uuid not null references public.workspaces (id) on delete cascade,
  step_id       uuid not null,
  label         text not null check (label in ('a', 'b', 'c')),
  -- Email steps use subject and body; the other channels use body alone.
  subject       text check (length(subject) <= 300),
  body          text not null check (length(trim(body)) between 1 and 5000),
  -- Turning a losing variant off keeps its past results for comparison
  active        boolean not null default true,
  created_at    timestamptz not null default now(),
  constraint sequence_variants_step_fk foreign key (workspace_id, step_id)
    references public.sequence_steps (workspace_id, id) on delete cascade,
  unique (workspace_id, step_id, label),
  unique (workspace_id, id)
);
create index sequence_variants_step_idx on public.sequence_variants (workspace_id, step_id);

-- ---------------------------------------------------------------- what ran
-- One row per lead per step. The unique constraint is the idempotency: a step
-- cannot run twice for the same lead, however often the agent wakes up.
create table public.lead_step_runs (
  id            uuid primary key default gen_random_uuid(),
  workspace_id  uuid not null references public.workspaces (id) on delete cascade,
  lead_id       uuid not null,
  step_id       uuid not null,
  variant_label text check (variant_label in ('a', 'b', 'c')),
  ran_at        timestamptz not null default now(),
  -- 'sent' when the channel accepted it; 'skipped' with a reason otherwise
  outcome       text not null default 'sent' check (outcome in ('sent', 'skipped', 'failed')),
  detail        text check (length(detail) <= 500),
  constraint lead_step_runs_lead_fk foreign key (workspace_id, lead_id)
    references public.leads (workspace_id, id) on delete cascade,
  constraint lead_step_runs_step_fk foreign key (workspace_id, step_id)
    references public.sequence_steps (workspace_id, id) on delete cascade,
  unique (workspace_id, lead_id, step_id)
);
create index lead_step_runs_lead_idx on public.lead_step_runs (workspace_id, lead_id, ran_at desc);
create index lead_step_runs_step_idx on public.lead_step_runs (workspace_id, step_id, variant_label);

-- ---------------------------------------------------------------- row security
alter table public.sequence_steps enable row level security;
alter table public.sequence_variants enable row level security;
alter table public.lead_step_runs enable row level security;

-- Members read the sequence; owners and admins change it. A sequence decides
-- who gets contacted on which channel, so it is campaign settings rather than
-- day-to-day lead work, and it is held to the same bar as the rest of them.
create policy sequence_steps_select on public.sequence_steps for select to authenticated
  using (app.is_member(workspace_id));
create policy sequence_steps_write on public.sequence_steps for all to authenticated
  using (app.has_role(workspace_id, array['owner', 'admin']::public.workspace_role[]))
  with check (app.has_role(workspace_id, array['owner', 'admin']::public.workspace_role[]));

create policy sequence_variants_select on public.sequence_variants for select to authenticated
  using (app.is_member(workspace_id));
create policy sequence_variants_write on public.sequence_variants for all to authenticated
  using (app.has_role(workspace_id, array['owner', 'admin']::public.workspace_role[]))
  with check (app.has_role(workspace_id, array['owner', 'admin']::public.workspace_role[]));

-- What was sent is a record, not something a person edits
create policy lead_step_runs_select on public.lead_step_runs for select to authenticated
  using (app.is_member(workspace_id));

revoke all on public.sequence_steps, public.sequence_variants, public.lead_step_runs from anon;
grant select, insert, update, delete on public.sequence_steps, public.sequence_variants to authenticated;
-- What was sent is read-only to everyone but the backend. The revoke matters:
-- new tables in this schema come with full rights for signed-in users, so the
-- grant alone would leave update and delete in place, as it does on the audit
-- log and the run log.
revoke all on public.lead_step_runs from authenticated;
grant select on public.lead_step_runs to authenticated;
grant all on public.sequence_steps, public.sequence_variants, public.lead_step_runs to service_role;

-- ---------------------------------------------------------------- the facts
-- Everything a condition may ask about one lead, gathered in one pass. The
-- agent service evaluates conditions against this; no interpretation here.
--
-- Only leads that are still worth contacting are returned: a suppressed lead,
-- one that asked not to be contacted, or one already won or lost is never a
-- candidate for another step.
-- The consent fields come back too, so the agent reuses the existing consent
-- gates for texts and calls rather than reimplementing them: branching must
-- not become a way around them.
create function public.sequence_candidates(ws uuid, p_campaign uuid, p_limit integer default 200)
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
                        and sr.outcome = 'sent' and ss.is_last)
    ) as facts
  from public.leads l
  join touch t on t.lead_id = l.id
  left join public.companies co on co.workspace_id = l.workspace_id and co.id = l.company_id
  where l.workspace_id = ws and l.campaign_id = p_campaign
    and l.stage not in ('won', 'lost', 'not_interested', 'do_not_contact')
    and not app.is_suppressed(l.workspace_id, l.email, l.phone)
  order by l.score desc nulls last, l.created_at
  limit greatest(1, least(1000, coalesce(p_limit, 200)));
$$;

-- ---------------------------------------------------------------- recording
-- Records that a step ran for a lead. Returns false when the step had already
-- run, which is how the agent stays idempotent across retries.
create function public.lead_step_record(
  ws uuid, p_lead uuid, p_step uuid, p_variant text default null,
  p_outcome text default 'sent', p_detail text default null
)
returns boolean
language plpgsql
security invoker
set search_path = ''
as $$
begin
  insert into public.lead_step_runs (workspace_id, lead_id, step_id, variant_label, outcome, detail)
  values (ws, p_lead, p_step, p_variant, coalesce(p_outcome, 'sent'), left(p_detail, 500))
  on conflict (workspace_id, lead_id, step_id) do nothing;
  return found;
end;
$$;

revoke execute on function public.sequence_candidates(uuid, uuid, integer) from public, anon;
revoke execute on function public.lead_step_record(uuid, uuid, uuid, text, text, text) from public, anon, authenticated;
grant execute on function public.sequence_candidates(uuid, uuid, integer) to authenticated, service_role;
grant execute on function public.lead_step_record(uuid, uuid, uuid, text, text, text) to service_role;

-- Keeps updated_at honest on the steps a person edits
create trigger sequence_steps_touch before update on public.sequence_steps
  for each row execute function app.touch_updated_at();
