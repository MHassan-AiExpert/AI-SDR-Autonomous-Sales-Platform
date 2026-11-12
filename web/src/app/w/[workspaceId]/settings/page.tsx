import type { Metadata } from 'next';
import { ActionForm, SubmitButton } from '@/components/action-form';
import { canManageSettings } from '@/lib/roles';
import { requireWorkspace } from '@/lib/session';
import { CHANNELS, CHANNEL_LABELS } from '@/lib/validation';
import { rotateWebhookToken, updateSettings } from '../actions';
import { inboundWebhookUrl } from '@/lib/texting';

export const metadata: Metadata = { title: 'Settings' };

export default async function SettingsPage({ params }: { params: Promise<{ workspaceId: string }> }) {
  const { workspaceId } = await params;
  const { supabase, workspace } = await requireWorkspace(workspaceId);
  const manage = canManageSettings(workspace.role);
  const { data: extra } = await supabase.from('workspaces').select('slack_channel').eq('id', workspace.id).maybeSingle();
  // The webhook address is a secret; only owners and admins see it
  const { data: hook } = manage ? await supabase.from('workspaces').select('webhook_token').eq('id', workspace.id).maybeSingle() : { data: null };
  const hookBase = (process.env.NEXT_PUBLIC_WEBHOOK_BASE_URL ?? '').replace(/\/$/, '');
  const hookUrl = hook?.webhook_token && hookBase ? `${hookBase}/webhook/instantly/${hook.webhook_token}` : null;
  const twilioUrl = inboundWebhookUrl(hookBase, hook?.webhook_token ?? null);

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

        <fieldset className="card stack" disabled={!manage}>
          <legend>Team alerts</legend>
          <p className="muted">Hot replies (interested, questions, referrals) and mailbox problems are posted to this Slack channel. Invite the Slack app to the channel first.</p>
          <label className="field">
            <span>Slack channel</span>
            <input name="slack_channel" type="text" maxLength={81} placeholder="#sales-alerts" defaultValue={extra?.slack_channel ?? ''} />
          </label>
        </fieldset>

        {manage ? <SubmitButton>Save settings</SubmitButton> : null}
      </ActionForm>

      {manage ? (
        <section className="card stack" aria-labelledby="webhook">
          <h2 id="webhook">Webhook addresses</h2>
          <h3>Instantly</h3>
          <p className="muted">So replies, bounces and unsubscribes reach the AI reply agent, add a webhook in Instantly (Settings, Integrations, Webhooks) with this address and select all events. Keep it private: anyone with it can send events to this workspace.</p>
          {hookUrl ? <code className="pre">{hookUrl}</code> : <p className="muted">Set NEXT_PUBLIC_WEBHOOK_BASE_URL to the public address of your n8n instance to show the webhook address.</p>}
          <h3>Twilio texts</h3>
          <p className="muted">So text replies and STOP requests reach the reply agent, open each sending number (or Messaging Service) in Twilio and set &ldquo;A message comes in&rdquo; to this address, method HTTP POST. Delivery updates use it automatically.</p>
          {twilioUrl ? <code className="pre">{twilioUrl}</code> : null}
          <ActionForm action={rotateWebhookToken}>
            <input type="hidden" name="workspace_id" value={workspace.id} />
            <SubmitButton variant="secondary">Create a new address</SubmitButton>
          </ActionForm>
        </section>
      ) : null}
    </>
  );
}
