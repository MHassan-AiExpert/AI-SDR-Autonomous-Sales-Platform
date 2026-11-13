import type { Metadata } from 'next';
import { ActionForm, SubmitButton } from '@/components/action-form';
import { canManageSettings } from '@/lib/roles';
import { requireWorkspace } from '@/lib/session';
import { CHANNELS, CHANNEL_LABELS } from '@/lib/validation';
import { rotateWebhookToken, saveCrmSettings, saveNotifySettings, syncCrmNow, updateSettings } from '../actions';
import { EVENTS, EVENT_LABELS, hourLabel } from '@/lib/notifications';
import { CRM_SCOPES, CRM_SCOPE_LABELS, DEAL_STAGES, DEAL_STAGE_LABELS, savedStage } from '@/lib/crm';
import { inboundWebhookUrl } from '@/lib/texting';
import { vapiServerUrl } from '@/lib/receptionist';

export const metadata: Metadata = { title: 'Settings' };

export default async function SettingsPage({ params }: { params: Promise<{ workspaceId: string }> }) {
  const { workspaceId } = await params;
  const { supabase, workspace } = await requireWorkspace(workspaceId);
  const manage = canManageSettings(workspace.role);
  const { data: extra } = await supabase.from('workspaces')
    .select('slack_channel, notify_slack_events, notify_quiet_start, notify_quiet_end, notify_timezone, bounce_pause_pct, optout_pause_pct, low_credits_threshold, crm_sync_enabled, crm_sync_scope, crm_pipeline_id, crm_stage_map, crm_synced_at').eq('id', workspace.id).maybeSingle();
  const [{ data: hub }, { data: links }] = await Promise.all([
    supabase.from('integrations').select('status').eq('workspace_id', workspace.id).eq('tool', 'hubspot').maybeSingle(),
    supabase.from('crm_links').select('record_type').eq('workspace_id', workspace.id).limit(10000),
  ]);
  const linked = (t: string) => (links ?? []).filter((l) => l.record_type === t).length;
  const hubConnected = hub?.status === 'connected';
  // The webhook address is a secret; only owners and admins see it
  const { data: hook } = manage ? await supabase.from('workspaces').select('webhook_token').eq('id', workspace.id).maybeSingle() : { data: null };
  const hookBase = (process.env.NEXT_PUBLIC_WEBHOOK_BASE_URL ?? '').replace(/\/$/, '');
  const hookUrl = hook?.webhook_token && hookBase ? `${hookBase}/webhook/instantly/${hook.webhook_token}` : null;
  const twilioUrl = inboundWebhookUrl(hookBase, hook?.webhook_token ?? null);
  const vapiUrl = vapiServerUrl(hookBase, hook?.webhook_token ?? null);

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


      <section className="card stack" aria-labelledby="alerts">
        <h2 id="alerts">Notifications and alerts</h2>
        <p className="muted">Every alert is kept in Notifications. Choose which ones also go to the Slack channel above. During quiet hours Slack alerts are held and sent when quiet hours end; critical alerts, such as emails paused for a high bounce rate, always go straight through.</p>
        <ActionForm action={saveNotifySettings} className="stack">
          <input type="hidden" name="workspace_id" value={workspace.id} />
          <fieldset className="stack" disabled={!manage}>
            <legend>Send to Slack</legend>
            <div className="grid-2">
              {EVENTS.map((e) => (
                <label key={e} className="choice">
                  <input type="checkbox" name={`event_${e}`} defaultChecked={(extra?.notify_slack_events ?? EVENTS).includes(e)} />
                  <span>{EVENT_LABELS[e]}</span>
                </label>
              ))}
            </div>
          </fieldset>
          <fieldset className="stack" disabled={!manage}>
            <legend>Quiet hours</legend>
            <div className="grid-2">
              <label className="field">
                <span>From</span>
                <select name="notify_quiet_start" defaultValue={extra?.notify_quiet_start ?? ''}>
                  <option value="">No quiet hours</option>
                  {Array.from({ length: 24 }, (_, h) => <option key={h} value={h}>{hourLabel(h)}</option>)}
                </select>
              </label>
              <label className="field">
                <span>Until</span>
                <select name="notify_quiet_end" defaultValue={extra?.notify_quiet_end ?? ''}>
                  <option value="">No quiet hours</option>
                  {Array.from({ length: 24 }, (_, h) => <option key={h} value={h}>{hourLabel(h)}</option>)}
                </select>
              </label>
              <label className="field">
                <span>Time zone</span>
                <input name="notify_timezone" type="text" maxLength={64} defaultValue={extra?.notify_timezone ?? 'UTC'} placeholder="Europe/London" />
                <small className="muted">Also sets when the daily summary goes out (8am).</small>
              </label>
            </div>
          </fieldset>
          <fieldset className="stack" disabled={!manage}>
            <legend>Automatic safety limits</legend>
            <p className="muted">Checked every 15 minutes over the last 7 days, once a campaign has sent at least 50 emails. Crossing a limit pauses that campaign&apos;s emails, in Instantly too, and raises a critical alert.</p>
            <div className="grid-2">
              <label className="field">
                <span>Pause emails at a bounce rate of (%)</span>
                <input name="bounce_pause_pct" type="number" min={1} max={50} step={0.5} defaultValue={extra?.bounce_pause_pct ?? 5} required />
              </label>
              <label className="field">
                <span>Pause emails at an opt-out rate of (%)</span>
                <input name="optout_pause_pct" type="number" min={1} max={50} step={0.5} defaultValue={extra?.optout_pause_pct ?? 3} required />
              </label>
              <label className="field">
                <span>Warn when a tool has fewer credits than</span>
                <input name="low_credits_threshold" type="number" min={0} step={1} defaultValue={extra?.low_credits_threshold ?? 100} required />
              </label>
            </div>
          </fieldset>
          {manage ? <SubmitButton>Save notifications</SubmitButton> : null}
        </ActionForm>
      </section>

      <section className="card stack" aria-labelledby="crm">
        <div className="spread">
          <h2 id="crm">CRM sync</h2>
          <span className={extra?.crm_sync_enabled ? 'badge badge-ok' : 'badge'}>{extra?.crm_sync_enabled ? 'On' : 'Off'}</span>
        </div>
        <p className="muted">Optional. Sends leads to HubSpot contacts (matched by email), deals to the pipeline you choose, and replies, meetings and calls as notes on the contact. Runs every hour and sends only what changed. Deals marked won or lost in HubSpot are closed here too.</p>
        {!hubConnected ? <p><span className="badge badge-warn">Needs attention</span> HubSpot is {hub?.status === 'expired' || hub?.status === 'error' ? 'not working: reconnect it' : 'not connected yet'} in <a href={`/w/${workspace.id}/setup`}>Setup</a>.</p> : null}
        <dl className="stats">
          <div><dt>Contacts in HubSpot</dt><dd>{linked('lead')}</dd></div>
          <div><dt>Deals in HubSpot</dt><dd>{linked('deal')}</dd></div>
          <div><dt>Activity notes</dt><dd>{linked('activity')}</dd></div>
          <div><dt>Last sync</dt><dd>{extra?.crm_synced_at ? `${new Date(extra.crm_synced_at).toUTCString().slice(5, 22)} UTC` : 'Not yet'}</dd></div>
        </dl>
        <ActionForm action={saveCrmSettings} className="stack">
          <input type="hidden" name="workspace_id" value={workspace.id} />
          <fieldset className="stack" disabled={!manage}>
            <legend className="sr-only">CRM sync settings</legend>
            <label className="choice">
              <input type="checkbox" name="crm_sync_enabled" defaultChecked={Boolean(extra?.crm_sync_enabled)} />
              <span><strong>Sync with HubSpot</strong><br />Needs a HubSpot private app token with contacts, deals and notes access.</span>
            </label>
            {CRM_SCOPES.map((s) => (
              <label key={s} className="choice">
                <input type="radio" name="crm_sync_scope" value={s} defaultChecked={(extra?.crm_sync_scope ?? 'engaged') === s} />
                <span>{CRM_SCOPE_LABELS[s]}</span>
              </label>
            ))}
            <label className="field">
              <span>Pipeline id</span>
              <input name="crm_pipeline_id" type="text" maxLength={64} defaultValue={extra?.crm_pipeline_id ?? 'default'} />
              <small className="muted">Leave as default for HubSpot&apos;s sales pipeline. For another pipeline, enter its id and the id of each stage below.</small>
            </label>
            <div className="grid-2">
              {DEAL_STAGES.map((s) => (
                <label key={s} className="field">
                  <span>{DEAL_STAGE_LABELS[s]}</span>
                  <input name={`stage_${s}`} type="text" maxLength={64} defaultValue={savedStage(extra?.crm_stage_map, s)} />
                </label>
              ))}
            </div>
          </fieldset>
          {manage ? <SubmitButton>Save CRM sync</SubmitButton> : null}
        </ActionForm>
        {manage && extra?.crm_sync_enabled ? (
          <ActionForm action={syncCrmNow}>
            <input type="hidden" name="workspace_id" value={workspace.id} />
            <SubmitButton variant="secondary">Sync now</SubmitButton>
          </ActionForm>
        ) : null}
      </section>

      {manage ? (
        <section className="card stack" aria-labelledby="webhook">
          <h2 id="webhook">Webhook addresses</h2>
          <h3>Instantly</h3>
          <p className="muted">So replies, bounces and unsubscribes reach the AI reply agent, add a webhook in Instantly (Settings, Integrations, Webhooks) with this address and select all events. Keep it private: anyone with it can send events to this workspace.</p>
          {hookUrl ? <code className="pre">{hookUrl}</code> : <p className="muted">Set NEXT_PUBLIC_WEBHOOK_BASE_URL to the public address of your n8n instance to show the webhook address.</p>}
          <h3>Twilio texts</h3>
          <p className="muted">So text replies and STOP requests reach the reply agent, open each sending number (or Messaging Service) in Twilio and set &ldquo;A message comes in&rdquo; to this address, method HTTP POST. Delivery updates use it automatically.</p>
          {twilioUrl ? <code className="pre">{twilioUrl}</code> : null}
          <h3>Vapi receptionist number</h3>
          <p className="muted">For the AI receptionist, open your phone number in Vapi, leave its assistant empty and set its server URL to this address. Outbound call results use it automatically.</p>
          {vapiUrl ? <code className="pre">{vapiUrl}</code> : null}
          <ActionForm action={rotateWebhookToken}>
            <input type="hidden" name="workspace_id" value={workspace.id} />
            <SubmitButton variant="secondary">Create a new address</SubmitButton>
          </ActionForm>
        </section>
      ) : null}
    </>
  );
}
