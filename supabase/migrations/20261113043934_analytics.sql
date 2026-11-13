-- =============================================================================
-- Reporting and analytics (SRS M10)
--
-- One read-only function returns everything the dashboard shows for a period:
-- the funnel from sourced leads to won deals, results by channel, a daily
-- series and a row per campaign. It runs with the caller's own rights, so
-- row-level security limits it to workspaces the caller belongs to. Cost per
-- meeting uses the monthly tool spend an owner or admin enters.
-- =============================================================================

alter table public.workspaces
  add column monthly_spend_cents integer check (monthly_spend_cents between 0 and 100000000),
  add column spend_currency      text not null default 'USD' check (spend_currency ~ '^[A-Z]{3}$');

create index if not exists emails_sent_idx on public.emails (workspace_id, sent_at) where status = 'sent';
create index if not exists replies_created_idx on public.replies (workspace_id, created_at);
create index if not exists meetings_created_idx on public.meetings (workspace_id, created_at);

create function public.analytics_summary(ws uuid, p_from timestamptz, p_to timestamptz, p_campaign uuid default null)
returns jsonb
language plpgsql
stable
security invoker
set search_path = ''
as $$
declare
  result jsonb;
begin
  if p_to <= p_from or p_to - p_from > interval '367 days' then
    raise exception 'Choose a period of up to one year' using errcode = 'check_violation';
  end if;
  with
  hot as (select unnest(array['interested', 'question', 'referral']) as c),
  l as (select * from public.leads where workspace_id = ws and (p_campaign is null or campaign_id = p_campaign)),
  e as (select * from public.emails where workspace_id = ws and status = 'sent' and sent_at >= p_from and sent_at < p_to and (p_campaign is null or campaign_id = p_campaign)),
  r as (select * from public.replies where workspace_id = ws and created_at >= p_from and created_at < p_to and coalesce(classification, '') <> 'out_of_office'
          and (p_campaign is null or campaign_id = p_campaign)),
  m as (select * from public.meetings where workspace_id = ws and (p_campaign is null or campaign_id = p_campaign)),
  d as (select * from public.deals where workspace_id = ws and (p_campaign is null or campaign_id = p_campaign)),
  t as (select * from public.messages where workspace_id = ws and created_at >= p_from and created_at < p_to and (p_campaign is null or campaign_id = p_campaign)),
  k as (select * from public.calls where workspace_id = ws and created_at >= p_from and created_at < p_to and (p_campaign is null or campaign_id = p_campaign)),
  a as (select * from public.assets where workspace_id = ws and type = 'audit' and created_at >= p_from and created_at < p_to and (p_campaign is null or campaign_id = p_campaign)),
  won as (select * from d where stage = 'won' and closed_at >= p_from and closed_at < p_to),
  days as (select generate_series(date_trunc('day', p_from), date_trunc('day', p_to - interval '1 second'), interval '1 day') as day)
  select jsonb_build_object(
    'funnel', jsonb_build_object(
      'sourced', (select count(*) from l where created_at >= p_from and created_at < p_to),
      'verified', (select count(*) from l where created_at >= p_from and created_at < p_to and verification_status = 'valid'),
      'emailed', (select count(distinct lead_id) from e where step = 1),
      'replied', (select count(distinct lead_id) from r),
      'interested', (select count(distinct lead_id) from r where classification in (select c from hot)),
      'meetings_booked', (select count(*) from m where created_at >= p_from and created_at < p_to),
      'meetings_held', (select count(*) from m where status = 'completed' and starts_at >= p_from and starts_at < p_to),
      'won', (select count(*) from won)
    ),
    'revenue', coalesce((select jsonb_agg(jsonb_build_object('currency', currency, 'cents', cents) order by cents desc)
                          from (select currency, sum(coalesce(value_cents, 0))::bigint as cents from won group by currency) x), '[]'::jsonb),
    'won_by_ai', (select count(*) from won where closed_by = 'ai'),
    'channels', jsonb_build_object(
      'email', jsonb_build_object('sent', (select count(*) from e), 'replies', (select count(*) from r where channel = 'email'),
                                  'interested', (select count(*) from r where channel = 'email' and classification in (select c from hot))),
      'sms', jsonb_build_object('sent', (select count(*) from t where channel = 'sms' and direction = 'outbound'),
                                'delivered', (select count(*) from t where channel = 'sms' and direction = 'outbound' and delivery_status in ('delivered', 'read')),
                                'replies', (select count(*) from r where channel = 'sms')),
      'whatsapp', jsonb_build_object('sent', (select count(*) from t where channel = 'whatsapp' and direction = 'outbound'),
                                     'delivered', (select count(*) from t where channel = 'whatsapp' and direction = 'outbound' and delivery_status in ('delivered', 'read')),
                                     'replies', (select count(*) from r where channel = 'whatsapp')),
      'calls', jsonb_build_object('made', (select count(*) from k where agent = 'caller' and direction = 'outbound'),
                                  'connected', (select count(*) from k where agent = 'caller' and direction = 'outbound' and outcome is not null and outcome not in ('no_answer', 'voicemail', 'failed')),
                                  'interested', (select count(*) from k where agent = 'caller' and direction = 'outbound' and outcome in ('interested', 'booked', 'callback'))),
      'closer', jsonb_build_object('meetings', (select count(*) from k where agent = 'closer'),
                                   'held', (select count(*) from m where closer_status = 'held' and starts_at >= p_from and starts_at < p_to),
                                   'proposals', (select count(*) from d where close_status = 'sent' and updated_at >= p_from and updated_at < p_to),
                                   'won', (select count(*) from won where closed_by = 'ai')),
      'receptionist', jsonb_build_object('calls', (select count(*) from k where agent = 'receptionist'),
                                         'interested', (select count(*) from k where agent = 'receptionist' and outcome in ('interested', 'callback')),
                                         'transferred', (select count(*) from k where agent = 'receptionist' and outcome = 'transferred')),
      'audits', jsonb_build_object('ready', (select count(*) from a where status = 'ready'), 'opened', (select count(*) from a where first_viewed_at is not null))
    ),
    'daily', coalesce((select jsonb_agg(jsonb_build_object(
        'day', to_char(days.day, 'YYYY-MM-DD'),
        'emails', (select count(*) from e where date_trunc('day', e.sent_at) = days.day),
        'replies', (select count(*) from r where date_trunc('day', r.created_at) = days.day),
        'meetings', (select count(*) from m where date_trunc('day', m.created_at) = days.day)) order by days.day) from days), '[]'::jsonb),
    'campaigns', coalesce((select jsonb_agg(row order by (row->>'emailed')::int desc, row->>'name') from (
        select jsonb_build_object(
          'id', c.id, 'name', c.name, 'status', c.status,
          'sourced', (select count(*) from l where l.campaign_id = c.id and l.created_at >= p_from and l.created_at < p_to),
          'emailed', (select count(distinct e.lead_id) from e where e.campaign_id = c.id and e.step = 1),
          'replied', (select count(distinct r.lead_id) from r where r.campaign_id = c.id),
          'interested', (select count(distinct r.lead_id) from r where r.campaign_id = c.id and r.classification in (select hc.c from hot hc)),
          'meetings', (select count(*) from m where m.campaign_id = c.id and m.created_at >= p_from and m.created_at < p_to),
          'won', (select count(*) from won where won.campaign_id = c.id),
          'revenue_cents', (select coalesce(sum(value_cents), 0)::bigint from won where won.campaign_id = c.id)) as row
        from public.campaigns c where c.workspace_id = ws and (p_campaign is null or c.id = p_campaign) and c.status <> 'archived') x), '[]'::jsonb)
  ) into result;
  return result;
end;
$$;
revoke execute on function public.analytics_summary(uuid, timestamptz, timestamptz, uuid) from public, anon;
grant execute on function public.analytics_summary(uuid, timestamptz, timestamptz, uuid) to authenticated, service_role;
