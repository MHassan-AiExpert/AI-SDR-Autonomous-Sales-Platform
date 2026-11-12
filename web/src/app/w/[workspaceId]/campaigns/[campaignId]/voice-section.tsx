import { ActionForm, SubmitButton } from '@/components/action-form';
import { DAY_LABELS, OUTREACH_STATUS_LABELS, SEND_TIMEZONES, TIMEZONE_LABELS } from '@/lib/outreach';
import { voiceReadiness } from '@/lib/voice';
import { queueAgentJob, saveVoiceSettings, setVoiceStatus } from '../actions';

export type VoiceCampaign = {
  id: string; voice_status: string; vapi_assistant_id: string | null; vapi_phone_number_id: string | null; call_timezone: string;
  call_window_start: string; call_window_end: string; call_days: Record<string, boolean>; call_daily_limit: number;
  call_max_attempts: number; call_rule: string; dnc_attested_at: string | null;
};

export function VoiceSection({ workspaceId, campaign, manage, vapiConnected, voiceChannelOn, callsToday }: {
  workspaceId: string; campaign: VoiceCampaign; manage: boolean; vapiConnected: boolean; voiceChannelOn: boolean; callsToday: number;
}) {
  const { items, ready } = voiceReadiness({ vapiConnected, voiceChannelOn, assistantId: campaign.vapi_assistant_id, phoneNumberId: campaign.vapi_phone_number_id });
  const hidden = <><input type="hidden" name="workspace_id" value={workspaceId} /><input type="hidden" name="campaign_id" value={campaign.id} /></>;
  return (
    <section className="card stack" aria-labelledby="voice">
      <div className="spread">
        <h2 id="voice">AI calling</h2>
        <span className={campaign.voice_status === 'live' ? 'badge badge-ok' : campaign.voice_status === 'paused' ? 'badge badge-warn' : 'badge'}>{campaign.voice_status === 'live' ? 'Calling' : OUTREACH_STATUS_LABELS[campaign.voice_status]}</span>
      </div>
      <p className="muted">The AI caller rings qualified leads with checked numbers through your Vapi assistant and number. Every call starts by saying it is an AI assistant, asks to stop are honoured at once, and voicemails are not left. Mobile numbers are only called when a consent basis is recorded on the lead.</p>
      <dl className="stats"><div><dt>Calls today</dt><dd>{callsToday} / {campaign.call_daily_limit}</dd></div></dl>
      <ul className="list">
        {items.map((i) => <li key={i.id}><span className={i.done ? 'badge badge-ok' : 'badge badge-error'}>{i.done ? 'Done' : 'Required'}</span> {i.label}</li>)}
        <li><span className={campaign.call_rule === 'consent_only' || campaign.dnc_attested_at ? 'badge badge-ok' : 'badge badge-error'}>{campaign.call_rule === 'consent_only' ? 'Consent only' : campaign.dnc_attested_at ? 'Attested' : 'Required'}</span> {campaign.call_rule === 'consent_only' ? 'Only leads with a recorded consent basis are called' : `Business landlines screened against Do Not Call registries${campaign.dnc_attested_at ? ` (confirmed ${new Date(campaign.dnc_attested_at).toUTCString()})` : ''}`}</li>
      </ul>
      {manage ? (
        <div className="row">
          {campaign.voice_status === 'live'
            ? <ActionForm action={setVoiceStatus}>{hidden}<input type="hidden" name="status" value="paused" /><SubmitButton variant="danger">Pause calling</SubmitButton></ActionForm>
            : <ActionForm action={setVoiceStatus}>{hidden}<input type="hidden" name="status" value="live" /><SubmitButton>{campaign.voice_status === 'paused' ? 'Resume calling' : 'Launch AI calling'}</SubmitButton></ActionForm>}
          {campaign.voice_status === 'live' ? <ActionForm action={queueAgentJob}>{hidden}<input type="hidden" name="type" value="voice_outreach" /><SubmitButton variant="secondary">Call now</SubmitButton></ActionForm> : null}
        </div>
      ) : null}
      {!ready && manage ? <p className="muted">Complete the required items to launch.</p> : null}
      {manage ? (
        <details>
          <summary>Calling settings</summary>
          <ActionForm action={saveVoiceSettings} className="stack">
            {hidden}
            <label className="field"><span>Vapi assistant ID (choose its voice in Vapi)</span><input name="vapi_assistant_id" type="text" defaultValue={campaign.vapi_assistant_id ?? ''} required /></label>
            <label className="field"><span>Vapi phone number ID</span><input name="vapi_phone_number_id" type="text" defaultValue={campaign.vapi_phone_number_id ?? ''} required /></label>
            <label className="field"><span>Time zone of the leads</span>
              <select name="call_timezone" defaultValue={campaign.call_timezone}>{SEND_TIMEZONES.map((tz) => <option key={tz} value={tz}>{TIMEZONE_LABELS[tz]} ({tz})</option>)}</select></label>
            <div className="row">
              <label className="field"><span>Call from</span><input name="call_window_start" type="time" defaultValue={campaign.call_window_start} required /></label>
              <label className="field"><span>Until</span><input name="call_window_end" type="time" defaultValue={campaign.call_window_end} required /></label>
            </div>
            <fieldset className="row"><legend>Calling days</legend>
              {DAY_LABELS.map((d, i) => <label key={d} className="choice"><input type="checkbox" name={`call_day_${i}`} defaultChecked={campaign.call_days?.[String(i)] === true} /><span>{d}</span></label>)}
            </fieldset>
            <div className="row">
              <label className="field"><span>Calls per day</span><input name="call_daily_limit" type="number" min={1} max={2000} defaultValue={campaign.call_daily_limit} required /></label>
              <label className="field"><span>Attempts per lead</span><input name="call_max_attempts" type="number" min={1} max={5} defaultValue={campaign.call_max_attempts} required /></label>
            </div>
            <fieldset className="stack"><legend>Who may be called</legend>
              <label className="choice"><input type="radio" name="call_rule" value="consent_only" defaultChecked={campaign.call_rule === 'consent_only'} /><span><strong>Only leads with recorded consent</strong><br />Safest. Record consent on a lead&apos;s profile when they ask to be called or agree to it.</span></label>
              <label className="choice"><input type="radio" name="call_rule" value="consent_or_business_landline" defaultChecked={campaign.call_rule === 'consent_or_business_landline'} /><span><strong>Also business landlines</strong><br />Only where B2B calls to business landlines are lawful in the leads&apos; country. Mobiles still need consent.</span></label>
              <label className="choice"><input type="checkbox" name="attest" defaultChecked={Boolean(campaign.dnc_attested_at)} /><span>I confirm these numbers have been screened against the applicable Do Not Call registries and that we have a lawful basis to call them.</span></label>
            </fieldset>
            <SubmitButton variant="secondary">Save calling settings</SubmitButton>
          </ActionForm>
        </details>
      ) : null}
    </section>
  );
}
