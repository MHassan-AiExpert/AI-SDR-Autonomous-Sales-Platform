import { ActionForm, SubmitButton } from '@/components/action-form';
import { receptionistReadiness, type ReceptionistReadinessInput } from '@/lib/receptionist';
import { saveReceptionistSettings, setReceptionistStatus } from '../actions';

export type ReceptionistCampaign = {
  id: string; receptionist_status: string; vapi_receptionist_assistant_id: string | null; vapi_inbound_number_id: string | null;
  receptionist_transfer_number: string | null; receptionist_notes: string | null;
};

export function ReceptionistSection({ workspaceId, campaign, manage, readiness, serverUrl }: {
  workspaceId: string; campaign: ReceptionistCampaign; manage: boolean; readiness: ReceptionistReadinessInput; serverUrl: string | null;
}) {
  const { required, optional, ready } = receptionistReadiness(readiness);
  const live = campaign.receptionist_status === 'live';
  const hidden = <><input type="hidden" name="workspace_id" value={workspaceId} /><input type="hidden" name="campaign_id" value={campaign.id} /></>;
  return (
    <section className="card stack" aria-labelledby="receptionist">
      <div className="spread">
        <h2 id="receptionist">AI receptionist</h2>
        <span className={live ? 'badge badge-ok' : 'badge'}>{live ? 'Answering calls' : 'Off'}</span>
      </div>
      <p className="muted">Answers calls to your number: it says it is an AI assistant, answers from your notes and playbook, takes call-back requests, puts callers through to your team when they ask, and offers a meeting, texting a booking link only when the caller agrees. Every caller becomes a lead in this campaign with the call, summary and recording. While it is off, calls go straight to your team number.</p>
      <ul className="list">
        {required.map((i) => <li key={i.id}><span className={i.done ? 'badge badge-ok' : 'badge badge-error'}>{i.done ? 'Done' : 'Required'}</span> {i.label}</li>)}
        {optional.map((i) => <li key={i.id}><span className={i.done ? 'badge badge-ok' : 'badge'}>{i.done ? 'Done' : 'Optional'}</span> {i.label}</li>)}
      </ul>
      {manage && serverUrl ? <><p className="muted">Vapi server URL for the phone number (keep it private):</p><code className="pre">{serverUrl}</code></> : null}
      {manage ? (
        <div className="row">
          <ActionForm action={setReceptionistStatus}>{hidden}<input type="hidden" name="status" value={live ? 'off' : 'live'} />
            <SubmitButton variant={live ? 'danger' : 'primary'}>{live ? 'Switch off the receptionist' : 'Switch on the receptionist'}</SubmitButton></ActionForm>
        </div>
      ) : null}
      {!ready && manage && !live ? <p className="muted">Complete the required items to switch it on.</p> : null}
      {manage ? (
        <details>
          <summary>Receptionist settings</summary>
          <ActionForm action={saveReceptionistSettings} className="stack">
            {hidden}
            <label className="field"><span>Vapi receptionist assistant ID</span><input name="vapi_receptionist_assistant_id" type="text" defaultValue={campaign.vapi_receptionist_assistant_id ?? ''} required /></label>
            <label className="field"><span>Vapi phone number ID callers dial</span><input name="vapi_inbound_number_id" type="text" defaultValue={campaign.vapi_inbound_number_id ?? ''} required /></label>
            <label className="field"><span>Team number for transfers (optional)</span><input name="receptionist_transfer_number" type="tel" defaultValue={campaign.receptionist_transfer_number ?? ''} /></label>
            <label className="field"><span>What the receptionist may tell callers: opening hours, address, common questions</span><textarea name="receptionist_notes" rows={5} maxLength={2000} defaultValue={campaign.receptionist_notes ?? ''} /></label>
            <SubmitButton variant="secondary">Save receptionist settings</SubmitButton>
          </ActionForm>
        </details>
      ) : null}
    </section>
  );
}
