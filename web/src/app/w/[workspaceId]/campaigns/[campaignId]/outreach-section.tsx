import Link from 'next/link';
import { ActionForm, SubmitButton } from '@/components/action-form';
import { DAY_LABELS, OUTREACH_STATUS_LABELS, SEND_TIMEZONES, TIMEZONE_LABELS, outreachReadiness } from '@/lib/outreach';
import { queueAgentJob, saveEmailSettings, setOutreachStatus } from '../actions';

export type OutreachCampaign = {
  id: string; status: string; outreach_status: string; auto_paused_reason?: string | null; auto_paused_at?: string | null; sender_name: string | null; email_footer: string | null;
  sending_accounts: unknown; send_timezone: string; send_window_start: string; send_window_end: string;
  send_days: Record<string, boolean>; daily_send_limit: number; follow_up_count: number; follow_up_delay_days: number;
  instantly_campaign_id: string | null; instantly_state: string | null;
};

export function OutreachSection({
  workspaceId, campaign, manage, counts, instantlyConnected, emailChannelOn, domainsReady,
}: {
  workspaceId: string; campaign: OutreachCampaign; manage: boolean;
  counts: { draft: number; approved: number; queued: number };
  instantlyConnected: boolean; emailChannelOn: boolean; domainsReady: boolean;
}) {
  const { items, ready } = outreachReadiness({
    instantlyConnected, emailChannelOn, senderName: campaign.sender_name, footer: campaign.email_footer,
    accounts: campaign.sending_accounts, sendingDomainsChecked: domainsReady,
  });
  const accounts = Array.isArray(campaign.sending_accounts) ? campaign.sending_accounts.filter((a): a is string => typeof a === 'string') : [];
  const hidden = (
    <>
      <input type="hidden" name="workspace_id" value={workspaceId} />
      <input type="hidden" name="campaign_id" value={campaign.id} />
    </>
  );

  return (
    <section className="card stack" aria-labelledby="outreach">
      <div className="spread">
        <h2 id="outreach">Email outreach</h2>
        <span className={campaign.outreach_status === 'live' ? 'badge badge-ok' : campaign.outreach_status === 'paused' ? 'badge badge-warn' : 'badge'}>
          {OUTREACH_STATUS_LABELS[campaign.outreach_status] ?? campaign.outreach_status}
        </span>
      </div>
      <p className="muted">The copywriting agent writes a personal sequence for every qualified lead with a verified email. Approved sequences are sent through your Instantly mailboxes, within your daily limit and sending hours, and stop as soon as the lead replies.</p>
      {campaign.outreach_status === 'paused' && campaign.auto_paused_reason ? (
        <p role="status"><span className="badge badge-error">Paused automatically</span> {campaign.auto_paused_reason}{campaign.auto_paused_at ? ` (${new Date(campaign.auto_paused_at).toUTCString().slice(5, 22)} UTC)` : ''}. Check the lead list and mailboxes before resuming.</p>
      ) : null}
      <dl className="stats">
        <div><dt>Waiting for approval</dt><dd>{counts.draft}</dd></div>
        <div><dt>Approved, not sent yet</dt><dd>{counts.approved}</dd></div>
        <div><dt>With Instantly</dt><dd>{counts.queued}</dd></div>
      </dl>
      <p><Link className="btn btn-secondary" href={`/w/${workspaceId}/campaigns/${campaign.id}/emails`}>Review emails</Link></p>

      <h3>Before launch</h3>
      <ul className="list">
        {items.map((i) => (
          <li key={i.id}><span className={i.done ? 'badge badge-ok' : i.blocking ? 'badge badge-error' : 'badge badge-warn'}>{i.done ? 'Done' : i.blocking ? 'Required' : 'Recommended'}</span> {i.label}</li>
        ))}
      </ul>

      {manage ? (
        <div className="row">
          {campaign.outreach_status === 'live' ? (
            <ActionForm action={setOutreachStatus}>{hidden}<input type="hidden" name="status" value="paused" /><SubmitButton variant="danger">Pause email outreach</SubmitButton></ActionForm>
          ) : (
            <ActionForm action={setOutreachStatus}>{hidden}<input type="hidden" name="status" value="live" /><SubmitButton>{campaign.outreach_status === 'paused' ? 'Resume email outreach' : 'Launch email outreach'}</SubmitButton></ActionForm>
          )}
          <ActionForm action={queueAgentJob}>{hidden}<input type="hidden" name="type" value="copywriting" /><SubmitButton variant="secondary">Write emails now</SubmitButton></ActionForm>
          {campaign.outreach_status === 'live' ? (
            <ActionForm action={queueAgentJob}>{hidden}<input type="hidden" name="type" value="email_outreach" /><SubmitButton variant="secondary">Send approved now</SubmitButton></ActionForm>
          ) : null}
        </div>
      ) : null}
      {!ready && manage ? <p className="muted">Complete the required items to launch.</p> : null}

      {manage ? (
        <details>
          <summary>Email settings</summary>
          <ActionForm action={saveEmailSettings} className="stack">
            {hidden}
            <label className="field"><span>Sender name</span><input name="sender_name" type="text" maxLength={120} defaultValue={campaign.sender_name ?? ''} required /></label>
            <label className="field"><span>Sending mailboxes (connected in Instantly), one per line</span>
              <textarea name="sending_accounts" rows={3} defaultValue={accounts.join('\n')} required /></label>
            <label className="field"><span>Footer added to every email: company name, postal address and how to opt out</span>
              <textarea name="email_footer" rows={3} maxLength={600} defaultValue={campaign.email_footer ?? ''} placeholder={'Acme Growth Ltd, 1 Main Street, Austin TX 78701\nNot interested? Reply "stop" and we will not email you again.'} required /></label>
            <label className="field"><span>Time zone of the leads</span>
              <select name="send_timezone" defaultValue={campaign.send_timezone}>
                {SEND_TIMEZONES.map((tz) => <option key={tz} value={tz}>{TIMEZONE_LABELS[tz]} ({tz})</option>)}
              </select></label>
            <div className="row">
              <label className="field"><span>Send from</span><input name="send_window_start" type="time" defaultValue={campaign.send_window_start} required /></label>
              <label className="field"><span>Until</span><input name="send_window_end" type="time" defaultValue={campaign.send_window_end} required /></label>
            </div>
            <fieldset className="row">
              <legend>Sending days</legend>
              {DAY_LABELS.map((d, i) => (
                <label key={d} className="choice"><input type="checkbox" name={`day_${i}`} defaultChecked={campaign.send_days?.[String(i)] === true} /><span>{d}</span></label>
              ))}
            </fieldset>
            <div className="row">
              <label className="field"><span>New leads per day</span><input name="daily_send_limit" type="number" min={1} max={5000} defaultValue={campaign.daily_send_limit} required /></label>
              <label className="field"><span>Follow-ups</span><input name="follow_up_count" type="number" min={0} max={4} defaultValue={campaign.follow_up_count} required /></label>
              <label className="field"><span>Days between emails</span><input name="follow_up_delay_days" type="number" min={1} max={30} defaultValue={campaign.follow_up_delay_days} required /></label>
            </div>
            <SubmitButton variant="secondary">Save email settings</SubmitButton>
          </ActionForm>
        </details>
      ) : null}
    </section>
  );
}
