import type { Metadata } from 'next';
import { ActionForm, SubmitButton } from '@/components/action-form';
import { canManageSettings } from '@/lib/roles';
import { requireWorkspace } from '@/lib/session';
import { CHANNELS, CHANNEL_LABELS } from '@/lib/validation';
import { buildOnboardingPlan, type IntegrationStatus } from '@/lib/integrations';
import Link from 'next/link';
import { setOutreachPaused } from './actions';
import { agentStatus, attentionItems, greeting, hourIn, safeTimeZone } from '@/lib/overview';

export const metadata: Metadata = { title: 'Overview' };

export default async function OverviewPage({ params }: { params: Promise<{ workspaceId: string }> }) {
  const { workspaceId } = await params;
  const { supabase, workspace, user } = await requireWorkspace(workspaceId);
  const base = `/w/${workspace.id}`;
  const manage = canManageSettings(workspace.role);

  const { data: seen } = await supabase.from('notification_seen').select('seen_at').eq('workspace_id', workspace.id).eq('user_id', user.id).maybeSingle();
  let warningsQ = supabase.from('notifications').select('id', { count: 'exact', head: true }).eq('workspace_id', workspace.id).in('severity', ['warning', 'critical']);
  if (seen?.seen_at) warningsQ = warningsQ.gt('created_at', seen.seen_at);
  const [{ count: leads }, { count: openDeals }, { data: members }, { data: integrations }, { count: handoffs }, { count: drafts }, { count: warnings }, { data: tz }] = await Promise.all([
    supabase.from('leads').select('id', { count: 'exact', head: true }).eq('workspace_id', workspace.id),
    supabase.from('deals').select('id', { count: 'exact', head: true }).eq('workspace_id', workspace.id).not('stage', 'in', '(won,lost)'),
    supabase.rpc('workspace_members_list', { ws: workspace.id }),
    supabase.from('integrations').select('tool, status').eq('workspace_id', workspace.id),
    supabase.from('notifications').select('id', { count: 'exact', head: true }).eq('workspace_id', workspace.id).eq('event', 'handoff').is('accepted_at', null),
    supabase.from('emails').select('id', { count: 'exact', head: true }).eq('workspace_id', workspace.id).eq('status', 'draft'),
    warningsQ,
    supabase.from('workspaces').select('notify_timezone').eq('id', workspace.id).maybeSingle(),
  ]);
  const attention = attentionItems({ handoffs: handoffs ?? 0, drafts: drafts ?? 0, warnings: warnings ?? 0 }, base);
  const meta = (user.user_metadata ?? {}) as { full_name?: unknown; name?: unknown };
  const rawName = typeof meta.full_name === 'string' ? meta.full_name : typeof meta.name === 'string' ? meta.name : '';
  const firstName = rawName.trim().split(/\s+/)[0]?.slice(0, 40) ?? '';
  const timeZone = (tz as { notify_timezone?: string | null } | null)?.notify_timezone ?? null;
  const today = new Intl.DateTimeFormat('en-GB', { weekday: 'long', day: 'numeric', month: 'long', timeZone: safeTimeZone(timeZone) }).format(new Date());
  const plan = buildOnboardingPlan({
    enabledChannels: workspace.enabled_channels,
    aiCloserEnabled: workspace.ai_closer_enabled,
    statuses: Object.fromEntries((integrations ?? []).map((r: { tool: string; status: IntegrationStatus }) => [r.tool, r.status])),
    checklist: workspace.setup_checklist ?? {},
  });

  return (
    <>
      <header className="greeting">
        <div className="greeting-text">
          <span className={workspace.outreach_paused ? 'status status-paused' : 'status'}>{agentStatus(workspace.outreach_paused)} · {today}</span>
          <h1>{greeting(hourIn(timeZone))}{firstName ? <>, <em>{firstName}</em></> : null}</h1>
          <p className="muted">Here is what is happening in {workspace.name}, and what needs you.</p>
        </div>
        <div className="row">
          <Link className="btn btn-secondary" href={`${base}/leads`}>View leads</Link>
          <Link className="btn btn-primary" href={`${base}/campaigns/new`}>Start a campaign</Link>
        </div>
      </header>

      <section className="stack" aria-labelledby="attention">
        <h2 id="attention" className="section-title">Needs your attention</h2>
        {attention.length ? (
          <ul className="attention">
            {attention.map((a) => (
              <li key={a.key}>
                <span className="num">{a.count > 999 ? '999+' : a.count}</span>
                <span className="attention-text"><strong>{a.title}</strong><span>{a.hint}</span></span>
                <Link className={a.key === 'handoffs' ? 'btn btn-primary' : 'btn btn-secondary'} href={a.href}>{a.action}</Link>
              </li>
            ))}
          </ul>
        ) : (
          <p className="all-clear">You are all caught up. Nothing is waiting for you right now.</p>
        )}
      </section>
      {!plan.ready ? (
        <section className="card stack" aria-labelledby="setup-prompt">
          <h2 id="setup-prompt">Finish setup: {plan.progress}% complete</h2>
          <p className="muted">Connect your tools so the agents can start finding leads and running outreach for your company.</p>
          <Link className="btn btn-primary" href={`/w/${workspace.id}/setup`}>Continue setup</Link>
        </section>
      ) : null}
      <dl className="stats">
        <div><dt>Leads found</dt><dd>{(leads ?? 0).toLocaleString('en-US')}</dd></div>
        <div><dt>Open deals</dt><dd>{(openDeals ?? 0).toLocaleString('en-US')}</dd></div>
        <div><dt>Team members</dt><dd>{members?.length ?? 0}</dd></div>
        <div><dt>Automation</dt><dd>{workspace.automation_mode === 'autopilot' ? 'Full autopilot' : 'Approval mode'}</dd></div>
      </dl>

      <section className="card stack" aria-labelledby="channels">
        <h2 id="channels">Outreach channels</h2>
        <ul className="chips">
          {CHANNELS.map((c) => (
            <li key={c} className={workspace.enabled_channels?.[c] ? 'chip chip-on' : 'chip chip-off'}>
              {CHANNEL_LABELS[c]}: {workspace.enabled_channels?.[c] ? 'On' : 'Off'}
            </li>
          ))}
          <li className={workspace.ai_closer_enabled ? 'chip chip-on' : 'chip chip-off'}>
            AI closer: {workspace.ai_closer_enabled ? 'On' : 'Off'}
          </li>
        </ul>
      </section>

      <section className="card stack" aria-labelledby="kill">
        <h2 id="kill">Kill switch</h2>
        <p className="muted">
          {workspace.outreach_paused
            ? 'Outreach is paused on every channel. Resume when you are ready.'
            : 'Pause all emails, calls and messages for this workspace instantly.'}
        </p>
        {manage ? (
          <ActionForm action={setOutreachPaused} className="stack">
            <input type="hidden" name="workspace_id" value={workspace.id} />
            <input type="hidden" name="paused" value={workspace.outreach_paused ? 'false' : 'true'} />
            <SubmitButton variant={workspace.outreach_paused ? 'primary' : 'danger'}>
              {workspace.outreach_paused ? 'Resume outreach' : 'Pause all outreach'}
            </SubmitButton>
          </ActionForm>
        ) : (
          <p className="muted">Only owners and admins can pause or resume outreach.</p>
        )}
      </section>
    </>
  );
}
