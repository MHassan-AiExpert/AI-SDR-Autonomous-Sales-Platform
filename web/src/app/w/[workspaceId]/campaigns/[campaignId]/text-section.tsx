import { ActionForm, SubmitButton } from '@/components/action-form';
import { OUTREACH_STATUS_LABELS } from '@/lib/outreach';
import { CHANNEL_LABELS, textReadiness, type TextChannel } from '@/lib/texting';
import { queueAgentJob, saveTextSettings, setTextStatus } from '../actions';

export type TextCampaign = {
  id: string; sms_status: string; sms_channel: TextChannel; sms_from: string | null; whatsapp_from: string | null;
  whatsapp_content_sid: string | null; sms_after_days: number; sms_daily_limit: number; sms_max_messages: number;
  call_timezone: string; call_window_start: string; call_window_end: string;
};

export function TextSection({ workspaceId, campaign, manage, twilioConnected, channelOn, textsToday }: {
  workspaceId: string; campaign: TextCampaign; manage: boolean; twilioConnected: boolean; channelOn: boolean; textsToday: number;
}) {
  const channel = campaign.sms_channel;
  const { items, ready } = textReadiness({ twilioConnected, channel, channelOn, smsFrom: campaign.sms_from, whatsappFrom: campaign.whatsapp_from, contentSid: campaign.whatsapp_content_sid });
  const hidden = <><input type="hidden" name="workspace_id" value={workspaceId} /><input type="hidden" name="campaign_id" value={campaign.id} /></>;
  return (
    <section className="card stack" aria-labelledby="texts">
      <div className="spread">
        <h2 id="texts">Text follow-ups</h2>
        <span className={campaign.sms_status === 'live' ? 'badge badge-ok' : campaign.sms_status === 'paused' ? 'badge badge-warn' : 'badge'}>{campaign.sms_status === 'live' ? `Texting by ${CHANNEL_LABELS[channel]}` : OUTREACH_STATUS_LABELS[campaign.sms_status]}</span>
      </div>
      <p className="muted">Leads who were emailed or called and have not answered get a short {CHANNEL_LABELS[channel]} follow-up {campaign.sms_after_days} {campaign.sms_after_days === 1 ? 'day' : 'days'} after the last touch, written by the AI from their research. Only leads with a recorded consent to receive {CHANNEL_LABELS[channel]} messages are texted. Every SMS names you and ends with &ldquo;Reply STOP to opt out&rdquo;, and STOP is honoured at once on every channel. Texts go out inside the contact hours set under AI calling ({campaign.call_window_start} to {campaign.call_window_end}, {campaign.call_timezone}).</p>
      <dl className="stats"><div><dt>Texts today</dt><dd>{textsToday} / {campaign.sms_daily_limit}</dd></div></dl>
      <ul className="list">
        {items.map((i) => <li key={i.id}><span className={i.done ? 'badge badge-ok' : 'badge badge-error'}>{i.done ? 'Done' : 'Required'}</span> {i.label}</li>)}
      </ul>
      {manage ? (
        <div className="row">
          {campaign.sms_status === 'live'
            ? <ActionForm action={setTextStatus}>{hidden}<input type="hidden" name="status" value="paused" /><SubmitButton variant="danger">Pause texts</SubmitButton></ActionForm>
            : <ActionForm action={setTextStatus}>{hidden}<input type="hidden" name="status" value="live" /><SubmitButton>{campaign.sms_status === 'paused' ? 'Resume texts' : 'Launch text follow-ups'}</SubmitButton></ActionForm>}
          {campaign.sms_status === 'live' ? <ActionForm action={queueAgentJob}>{hidden}<input type="hidden" name="type" value="sms_outreach" /><SubmitButton variant="secondary">Text now</SubmitButton></ActionForm> : null}
        </div>
      ) : null}
      {!ready && manage ? <p className="muted">Complete the required items to launch.</p> : null}
      {manage ? (
        <details>
          <summary>Text settings</summary>
          <ActionForm action={saveTextSettings} className="stack">
            {hidden}
            <fieldset className="row"><legend>Channel</legend>
              <label className="choice"><input type="radio" name="sms_channel" value="sms" defaultChecked={channel === 'sms'} /><span>SMS</span></label>
              <label className="choice"><input type="radio" name="sms_channel" value="whatsapp" defaultChecked={channel === 'whatsapp'} /><span>WhatsApp</span></label>
            </fieldset>
            <label className="field"><span>SMS sender: Twilio number (+15125550100) or Messaging Service SID (MG…)</span><input name="sms_from" type="text" defaultValue={campaign.sms_from ?? ''} /></label>
            <label className="field"><span>WhatsApp sender number (approved in Twilio)</span><input name="whatsapp_from" type="text" defaultValue={campaign.whatsapp_from ?? ''} /></label>
            <label className="field"><span>WhatsApp template Content SID (HX…), approved with {'{{1}}'} for the first name and {'{{2}}'} for the message</span><input name="whatsapp_content_sid" type="text" defaultValue={campaign.whatsapp_content_sid ?? ''} /></label>
            <div className="row">
              <label className="field"><span>Days after the last email or call</span><input name="sms_after_days" type="number" min={1} max={30} defaultValue={campaign.sms_after_days} required /></label>
              <label className="field"><span>Texts per day</span><input name="sms_daily_limit" type="number" min={1} max={5000} defaultValue={campaign.sms_daily_limit} required /></label>
              <label className="field"><span>Texts per lead</span><input name="sms_max_messages" type="number" min={1} max={3} defaultValue={campaign.sms_max_messages} required /></label>
            </div>
            <p className="muted">In the US, business SMS needs an A2P 10DLC registration for your number in Twilio before carriers deliver it.</p>
            <SubmitButton variant="secondary">Save text settings</SubmitButton>
          </ActionForm>
        </details>
      ) : null}
    </section>
  );
}
