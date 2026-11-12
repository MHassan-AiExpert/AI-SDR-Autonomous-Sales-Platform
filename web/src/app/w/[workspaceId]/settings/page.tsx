import type { Metadata } from 'next';
import { ActionForm, SubmitButton } from '@/components/action-form';
import { canManageSettings } from '@/lib/roles';
import { requireWorkspace } from '@/lib/session';
import { CHANNELS, CHANNEL_LABELS } from '@/lib/validation';
import { updateSettings } from '../actions';

export const metadata: Metadata = { title: 'Settings' };

export default async function SettingsPage({ params }: { params: Promise<{ workspaceId: string }> }) {
  const { workspaceId } = await params;
  const { workspace } = await requireWorkspace(workspaceId);
  const manage = canManageSettings(workspace.role);

  return (
    <>
      <h1>Settings</h1>
      {!manage ? <p className="muted">You can view these settings. Only owners and admins can change them.</p> : null}
      <ActionForm action={updateSettings} className="stack-lg">
        <input type="hidden" name="workspace_id" value={workspace.id} />
        <fieldset className="card stack" disabled={!manage}>
          <legend>Workspace</legend>
          <label className="field">
            <span>Company name</span>
            <input name="name" type="text" defaultValue={workspace.name} required minLength={2} maxLength={120} />
          </label>
        </fieldset>

        <fieldset className="card stack" disabled={!manage}>
          <legend>Automation</legend>
          <label className="choice">
            <input type="radio" name="automation_mode" value="autopilot" defaultChecked={workspace.automation_mode === 'autopilot'} />
            <span><strong>Full autopilot</strong><br />Agents source leads, run outreach, book meetings and close without waiting.</span>
          </label>
          <label className="choice">
            <input type="radio" name="automation_mode" value="approval" defaultChecked={workspace.automation_mode === 'approval'} />
            <span><strong>Approval mode</strong><br />Drafts, call lists and deals wait for a person to approve them.</span>
          </label>
          <label className="choice">
            <input type="checkbox" name="ai_closer_enabled" defaultChecked={workspace.ai_closer_enabled} />
            <span><strong>AI closer</strong><br />Let the AI closer run booked sales meetings. Switch off to send meetings to your reps.</span>
          </label>
        </fieldset>

        <fieldset className="card stack" disabled={!manage}>
          <legend>Outreach channels</legend>
          <p className="muted">Switch off any channel you do not want to use, for example to run cold email only.</p>
          {CHANNELS.map((c) => (
            <label key={c} className="choice">
              <input type="checkbox" name={`channel_${c}`} defaultChecked={Boolean(workspace.enabled_channels?.[c])} />
              <span>{CHANNEL_LABELS[c]}</span>
            </label>
          ))}
        </fieldset>

        {manage ? <SubmitButton>Save settings</SubmitButton> : null}
      </ActionForm>
    </>
  );
}
