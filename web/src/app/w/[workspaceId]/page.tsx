import type { Metadata } from 'next';
import { ActionForm, SubmitButton } from '@/components/action-form';
import { canManageSettings } from '@/lib/roles';
import { requireWorkspace } from '@/lib/session';
import { CHANNELS, CHANNEL_LABELS } from '@/lib/validation';
import { buildOnboardingPlan, type IntegrationStatus } from '@/lib/integrations';
import Link from 'next/link';
import { setOutreachPaused } from './actions';

export const metadata: Metadata = { title: 'Overview' };

export default async function OverviewPage({ params }: { params: Promise<{ workspaceId: string }> }) {
  const { workspaceId } = await params;
  const { supabase, workspace } = await requireWorkspace(workspaceId);
  const manage = canManageSettings(workspace.role);

  const [{ count: leads }, { count: openDeals }, { data: members }, { data: integrations }] = await Promise.all([
    supabase.from('leads').select('id', { count: 'exact', head: true }).eq('workspace_id', workspace.id),
    supabase.from('deals').select('id', { count: 'exact', head: true }).eq('workspace_id', workspace.id).not('stage', 'in', '(won,lost)'),
    supabase.rpc('workspace_members_list', { ws: workspace.id }),
    supabase.from('integrations').select('tool, status').eq('workspace_id', workspace.id),
  ]);
  const plan = buildOnboardingPlan({
    enabledChannels: workspace.enabled_channels,
    aiCloserEnabled: workspace.ai_closer_enabled,
    statuses: Object.fromEntries((integrations ?? []).map((r: { tool: string; status: IntegrationStatus }) => [r.tool, r.status])),
    checklist: workspace.setup_checklist ?? {},
  });

  return (
    <>
      <h1>Overview</h1>
      {!plan.ready ? (
        <section className="card stack" aria-labelledby="setup-prompt">
          <h2 id="setup-prompt">Finish setup: {plan.progress}% complete</h2>
          <p className="muted">Connect your tools so the agents can start finding leads and running outreach for your company.</p>
          <Link className="btn btn-primary" href={`/w/${workspace.id}/setup`}>Continue setup</Link>
        </section>
      ) : null}
      <dl className="stats">
        <div><dt>Leads</dt><dd>{leads ?? 0}</dd></div>
        <div><dt>Open deals</dt><dd>{openDeals ?? 0}</dd></div>
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
