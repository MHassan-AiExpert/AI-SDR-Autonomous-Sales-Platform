import Link from 'next/link';
import { ActionForm, SubmitButton } from '@/components/action-form';
import { closerReadiness, type CloserReadinessInput } from '@/lib/closer';
import { saveCloserSettings } from '../actions';

export function CloserSection({ workspaceId, campaignId, assistantId, manage, readiness }: {
  workspaceId: string; campaignId: string; assistantId: string | null; manage: boolean; readiness: CloserReadinessInput;
}) {
  const { required, optional, ready } = closerReadiness(readiness);
  return (
    <section className="card stack" aria-labelledby="closer">
      <div className="spread">
        <h2 id="closer">AI closer</h2>
        <span className={ready ? 'badge badge-ok' : 'badge badge-warn'}>{ready ? 'Runs booked meetings' : 'Not ready: meetings go to your team'}</span>
      </div>
      <p className="muted">At the booked time the AI closer calls the prospect on the number they gave for the meeting (choose &ldquo;Phone call: we will call you&rdquo; or ask for a phone number in your Calendly event). It opens by saying it is an AI assistant, runs the meeting from your <Link href={`/w/${workspaceId}/playbook`}>sales playbook</Link>, and when they agree, a payment link at the playbook price is created in Stripe and your PandaDoc proposal carrying it is sent for e-signature. Requests outside the playbook, and meetings it cannot run, go to your team with a task and a Slack alert.</p>
      <ul className="list">
        {required.map((i) => <li key={i.id}><span className={i.done ? 'badge badge-ok' : 'badge badge-error'}>{i.done ? 'Done' : 'Required'}</span> {i.label}</li>)}
        {optional.map((i) => <li key={i.id}><span className={i.done ? 'badge badge-ok' : 'badge'}>{i.done ? 'Done' : 'Optional'}</span> {i.label}</li>)}
      </ul>
      {manage ? (
        <ActionForm action={saveCloserSettings} className="row">
          <input type="hidden" name="workspace_id" value={workspaceId} />
          <input type="hidden" name="campaign_id" value={campaignId} />
          <label className="field"><span>Vapi closer assistant ID (its voice is used for meetings)</span><input name="vapi_closer_assistant_id" type="text" defaultValue={assistantId ?? ''} /></label>
          <SubmitButton variant="secondary">Save closer</SubmitButton>
        </ActionForm>
      ) : null}
    </section>
  );
}
