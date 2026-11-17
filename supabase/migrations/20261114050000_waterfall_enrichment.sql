-- =============================================================================
-- Waterfall enrichment (F25)
--
-- The single Apollo lookup becomes a chain of contact providers, tried in the
-- order the workspace chooses. The chain stops at the first provider that
-- finds a contact for a company, and the company website is read last. Every
-- attempt is recorded, and every lead remembers which provider found it, so
-- match rates per provider can be compared on real results.
--
--   enrichment_order           : provider order per workspace (owners, admins)
--   enrichment_attempts        : one row per company per provider tried
--   leads.enrichment_provider  : the provider that found the lead
--   enrichment_provider_stats(): attempts, matches, match rate and leads
-- =============================================================================

alter table public.integrations drop constraint integrations_tool_check;
alter table public.integrations add constraint integrations_tool_check check (tool in (
  'openai', 'anthropic', 'gemini', 'apollo', 'apify', 'zerobounce', 'instantly', 'twilio',
  'vapi', 'whatsapp', 'zoom', 'calendly', 'hubspot', 'slack', 'pandadoc', 'stripe',
  'hunter', 'pdl'));

-- An order is a list of known providers, each at most once. A provider left
-- out of the list is not used, even when it is connected.
create function app.valid_enrichment_order(p_order text[])
returns boolean
language sql
immutable
set search_path = ''
as $$
  select p_order is not null
     and cardinality(p_order) <= 3
     and p_order <@ array['apollo', 'hunter', 'pdl']::text[]
     and cardinality(p_order) = (select count(distinct x) from unnest(p_order) as x);
$$;

alter table public.workspaces
  add column enrichment_order text[] not null default array['apollo', 'hunter', 'pdl']::text[],
  add constraint workspaces_enrichment_order_check check (app.valid_enrichment_order(enrichment_order));

alter table public.leads
  add column enrichment_provider text
    check (enrichment_provider in ('apollo', 'hunter', 'pdl', 'website'));

create index leads_enrichment_provider_idx on public.leads (workspace_id, enrichment_provider)
  where enrichment_provider is not null;

-- ---------------------------------------------------------------- attempts
create table public.enrichment_attempts (
  id            uuid primary key default gen_random_uuid(),
  workspace_id  uuid not null references public.workspaces (id) on delete cascade,
  campaign_id   uuid,
  company_id    uuid,
  provider      text not null check (provider in ('apollo', 'hunter', 'pdl', 'website')),
  outcome       text not null check (outcome in ('found', 'no_match', 'error')),
  contacts      smallint not null default 0 check (contacts between 0 and 20),
  created_at    timestamptz not null default now(),
  constraint enrichment_attempts_campaign_fk foreign key (workspace_id, campaign_id)
    references public.campaigns (workspace_id, id) on delete set null (campaign_id),
  constraint enrichment_attempts_company_fk foreign key (workspace_id, company_id)
    references public.companies (workspace_id, id) on delete set null (company_id),
  constraint enrichment_attempts_found_check check ((outcome = 'found') = (contacts > 0))
);
create index enrichment_attempts_stats_idx on public.enrichment_attempts (workspace_id, created_at desc, provider);

-- Members read; only the agent service writes, so the numbers cannot be edited
alter table public.enrichment_attempts enable row level security;
create policy enrichment_attempts_select on public.enrichment_attempts for select to authenticated
  using (app.is_member(workspace_id));
revoke all on public.enrichment_attempts from anon, authenticated;
grant select on public.enrichment_attempts to authenticated;
grant all on public.enrichment_attempts to service_role;

-- ---------------------------------------------------------------- stats
-- Per provider over the last p_days: how often it was asked, how often it
-- found someone, and how many of the leads in the workspace it found.
-- A provider only counts an attempt when it was actually asked, so a provider
-- placed second is judged on the companies the first one missed.
create function public.enrichment_provider_stats(ws uuid, p_days integer default 30)
returns table (provider text, attempts bigint, found bigint, errors bigint, match_rate numeric, leads bigint)
language sql
stable
security invoker
set search_path = ''
as $$
  with a as (
    select e.provider,
           count(*) filter (where e.outcome <> 'error') as attempts,
           count(*) filter (where e.outcome = 'found') as found,
           count(*) filter (where e.outcome = 'error') as errors
    from public.enrichment_attempts e
    where e.workspace_id = ws and e.created_at > now() - make_interval(days => greatest(1, least(p_days, 365)))
    group by e.provider
  ), l as (
    select x.enrichment_provider as provider, count(*) as leads
    from public.leads x
    where x.workspace_id = ws and x.enrichment_provider is not null
      and x.created_at > now() - make_interval(days => greatest(1, least(p_days, 365)))
    group by x.enrichment_provider
  )
  select p.provider,
         coalesce(a.attempts, 0),
         coalesce(a.found, 0),
         coalesce(a.errors, 0),
         case when coalesce(a.attempts, 0) = 0 then null else round(a.found::numeric * 100 / a.attempts, 1) end,
         coalesce(l.leads, 0)
  from (values ('apollo', 1), ('hunter', 2), ('pdl', 3), ('website', 4)) as p(provider, ord)
  left join a on a.provider = p.provider
  left join l on l.provider = p.provider
  where a.provider is not null or l.provider is not null
  order by p.ord;
$$;

revoke execute on function public.enrichment_provider_stats(uuid, integer) from public, anon;
grant execute on function public.enrichment_provider_stats(uuid, integer) to authenticated, service_role;
