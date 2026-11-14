import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ActionForm, SubmitButton } from '@/components/action-form';
import { requireWorkspace } from '@/lib/session';
import { canManageSettings } from '@/lib/roles';
import { uuidSchema } from '@/lib/validation';
import {
  CHANNEL_LABELS, STEP_CHANNELS, TRIGGERS, TRIGGER_KEYS, VARIANT_LABELS,
  describeStep, percentOf, problems, triggerOf, type StepRow,
} from '@/lib/sequence';
import {
  deleteSequenceStep, deleteSequenceVariant, queueAgentJob,
  saveSequenceSettings, saveSequenceStep, saveSequenceVariant,
} from '../../actions';

export const metadata: Metadata = { title: 'Sequence' };

const WAITS = [0, 1, 4, 12, 24, 48, 72, 96, 120, 168, 336, 720];
const waitLabel = (h: number) => (h === 0 ? 'No wait' : h < 24 ? `${h} hours` : `${h / 24} days`);

export default async function SequencePage({ params }: { params: Promise<{ workspaceId: string; campaignId: string }> }) {
  const { workspaceId, campaignId } = await params;
  if (!uuidSchema.safeParse(campaignId).success) notFound();
  const { supabase, workspace } = await requireWorkspace(workspaceId);
  const manage = canManageSettings(workspace.role);
  const base = `/w/${workspace.id}`;

  const { data: campaign } = await supabase
    .from('campaigns')
    .select('id, name, status, branching_enabled, open_tracking, daily_send_limit, follow_up_count, follow_up_delay_days')
    .eq('workspace_id', workspace.id).eq('id', campaignId).maybeSingle();
  if (!campaign) notFound();

  const [{ data: stepRows }, { data: runRows }] = await Promise.all([
    supabase.from('sequence_steps')
      .select('id, position, channel, wait_hours, condition, is_last, sequence_variants (id, label, subject, body, active)')
      .eq('workspace_id', workspace.id).eq('campaign_id', campaign.id).order('position'),
    supabase.from('lead_step_runs')
      .select('step_id, variant_label').eq('workspace_id', workspace.id).eq('outcome', 'sent').limit(5000),
  ]);

  const steps = ((stepRows ?? []) as unknown as StepRow[]).map((s) => ({
    ...s,
    sequence_variants: [...(s.sequence_variants ?? [])].sort((a, b) => a.label.localeCompare(b.label)),
  }));
  const issues = problems(steps, campaign.open_tracking);

  // Sends per message, taken from the record of what actually went out
  const sentBy = new Map<string, number>();
  for (const r of runRows ?? []) {
    if (!r.variant_label) continue;
    const key = `${r.step_id}:${r.variant_label}`;
    sentBy.set(key, (sentBy.get(key) ?? 0) + 1);
  }
  const nothingSent = steps.every((s) => s.sequence_variants.every((v) => !sentBy.get(`${s.id}:${v.label}`)));
  const nextPosition = Math.min(20, (steps.at(-1)?.position ?? 0) + 1);

  return (
    <main className="stack-lg">
      <p><Link href={`${base}/campaigns/${campaign.id}`}>&larr; {campaign.name}</Link></p>
      <h1>Sequence</h1>
      <p>
        Each step names a channel, how long to wait, and what must be true of the lead for it to run. The first step
        that fits is the one that runs, so a lead who went to voicemail can go straight to a text while someone who
        never answered carries on down the list.
      </p>

      <section className="card stack">
        <h2>How this campaign decides its follow-ups</h2>
        {campaign.branching_enabled ? (
          <p>The sequence below is in charge.</p>
        ) : (
          <p>
            The fixed email cadence is in charge: {campaign.follow_up_count} follow-up
            {campaign.follow_up_count === 1 ? '' : 's'} every {campaign.follow_up_delay_days} days, sent by Instantly
            whatever happens on the other channels. Turn branching on to use the sequence instead.
          </p>
        )}
        {manage ? (
          <ActionForm action={saveSequenceSettings} className="stack">
            <input type="hidden" name="workspace_id" value={workspace.id} />
            <input type="hidden" name="campaign_id" value={campaign.id} />
            <label className="choice">
              <input type="checkbox" name="branching_enabled" defaultChecked={campaign.branching_enabled} />
              <span>Use the sequence below instead of the fixed email cadence</span>
            </label>
            <label className="choice">
              <input type="checkbox" name="open_tracking" defaultChecked={campaign.open_tracking} />
              <span>Track email opens</span>
            </label>
            <p className="muted">
              Open tracking adds an invisible image to every email. It is what makes an &ldquo;opened an email&rdquo;
              condition possible, and it costs some deliverability, which is why it is off unless you ask for it.
            </p>
            <SubmitButton variant="secondary">Save</SubmitButton>
          </ActionForm>
        ) : (
          <p className="muted">Only owners and admins can change this.</p>
        )}
      </section>

      {issues.length > 0 && (
        <section className="card stack">
          <h2>Before this sequence will do anything</h2>
          <ul className="list">
            {issues.map((p) => <li key={p}>{p}</li>)}
          </ul>
        </section>
      )}

      <section className="stack-lg">
        <h2>Steps</h2>
        {steps.length === 0 && <p>No steps yet. Add the first one below.</p>}
        {steps.map((step) => {
          const trigger = triggerOf(step.condition);
          const total = step.sequence_variants.reduce((n, v) => n + (sentBy.get(`${step.id}:${v.label}`) ?? 0), 0);
          return (
            <article key={step.id} className="card stack">
              <h3>
                Step {step.position}: {CHANNEL_LABELS[step.channel]}
                {step.is_last && <> <span className="badge">last step</span></>}
              </h3>
              <p>{describeStep(step)}</p>

              <h4>Messages</h4>
              {step.sequence_variants.filter((v) => v.active).length > 1 && (
                <p className="muted">
                  Leads are split evenly between the active messages. Which one a lead was sent is recorded, so the
                  weekly learning report scores them against each other.
                </p>
              )}
              <div className="table-wrap">
                <table className="table">
                  <caption className="sr-only">Messages for step {step.position}</caption>
                  <thead>
                    <tr>
                      <th scope="col">Message</th>
                      <th scope="col">Subject</th>
                      <th scope="col">Sent</th>
                      <th scope="col">Share</th>
                      <th scope="col">State</th>
                    </tr>
                  </thead>
                  <tbody>
                    {step.sequence_variants.length === 0 && (
                      <tr><td colSpan={5}>No message yet, so this step cannot run.</td></tr>
                    )}
                    {step.sequence_variants.map((v) => {
                      const sent = sentBy.get(`${step.id}:${v.label}`) ?? 0;
                      return (
                        <tr key={v.id}>
                          <th scope="row">{v.label.toUpperCase()}</th>
                          <td>{v.subject ?? <span className="muted">none</span>}</td>
                          <td>{sent}</td>
                          <td>{percentOf(sent, total)}</td>
                          <td>{v.active ? 'Active' : 'Off'}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>

              {manage && (
                <>
                  {VARIANT_LABELS.map((label) => {
                    const existing = step.sequence_variants.find((v) => v.label === label);
                    return (
                      <details key={label}>
                        <summary>{existing ? `Edit message ${label.toUpperCase()}` : `Add message ${label.toUpperCase()}`}</summary>
                        <ActionForm action={saveSequenceVariant} className="stack">
                          <input type="hidden" name="workspace_id" value={workspace.id} />
                          <input type="hidden" name="campaign_id" value={campaign.id} />
                          <input type="hidden" name="step_id" value={step.id} />
                          <input type="hidden" name="label" value={label} />
                          {step.channel === 'email' && (
                            <label className="field">
                              <span>Subject</span>
                              <input type="text" name="subject" maxLength={300} defaultValue={existing?.subject ?? ''} />
                            </label>
                          )}
                          <label className="field">
                            <span>{step.channel === 'voice' ? 'Opening line' : 'Message'}</span>
                            <textarea name="body" rows={5} maxLength={5000} required defaultValue={existing?.body ?? ''} />
                          </label>
                          <p className="muted">
                            You can use {'{{first_name}}'}, {'{{full_name}}'}, {'{{company}}'}, {'{{title}}'},{' '}
                            {'{{sender_name}}'} and {'{{our_company}}'}. Anything else is left blank rather than printed.
                          </p>
                          <label className="choice">
                            <input type="checkbox" name="active" defaultChecked={existing?.active ?? true} />
                            <span>Send this message</span>
                          </label>
                          <SubmitButton variant="secondary">Save message {label.toUpperCase()}</SubmitButton>
                        </ActionForm>
                        {existing && (
                          <ActionForm action={deleteSequenceVariant}>
                            <input type="hidden" name="workspace_id" value={workspace.id} />
                            <input type="hidden" name="campaign_id" value={campaign.id} />
                            <input type="hidden" name="variant_id" value={existing.id} />
                            <SubmitButton variant="ghost">Remove message {label.toUpperCase()}</SubmitButton>
                          </ActionForm>
                        )}
                      </details>
                    );
                  })}

                  <details>
                    <summary>Change this step</summary>
                    <ActionForm action={saveSequenceStep} className="stack">
                      <input type="hidden" name="workspace_id" value={workspace.id} />
                      <input type="hidden" name="campaign_id" value={campaign.id} />
                      <input type="hidden" name="step_id" value={step.id} />
                      <div className="row">
                        <label className="field">
                          <span>Position</span>
                          <input type="number" name="position" min={1} max={20} defaultValue={step.position} required />
                        </label>
                        <label className="field">
                          <span>Channel</span>
                          <select name="channel" defaultValue={step.channel}>
                            {STEP_CHANNELS.map((c) => <option key={c} value={c}>{CHANNEL_LABELS[c]}</option>)}
                          </select>
                        </label>
                        <label className="field">
                          <span>Wait at least</span>
                          <select name="wait_hours" defaultValue={String(step.wait_hours)}>
                            {WAITS.map((h) => <option key={h} value={h}>{waitLabel(h)}</option>)}
                          </select>
                        </label>
                      </div>
                      <label className="field">
                        <span>Run when</span>
                        <select name="trigger" defaultValue={trigger === 'custom' ? 'always' : trigger}>
                          {TRIGGER_KEYS.map((k) => <option key={k} value={k}>{TRIGGERS[k].label}</option>)}
                        </select>
                      </label>
                      {trigger === 'custom' && (
                        <p className="muted">
                          This step has a condition that was not set on this screen. Saving here will replace it.
                        </p>
                      )}
                      <label className="choice">
                        <input type="checkbox" name="is_last" defaultChecked={step.is_last} />
                        <span>Stop the sequence after this step</span>
                      </label>
                      <SubmitButton variant="secondary">Save step</SubmitButton>
                    </ActionForm>
                    <ActionForm action={deleteSequenceStep}>
                      <input type="hidden" name="workspace_id" value={workspace.id} />
                      <input type="hidden" name="campaign_id" value={campaign.id} />
                      <input type="hidden" name="step_id" value={step.id} />
                      <SubmitButton variant="ghost">Remove step {step.position}</SubmitButton>
                    </ActionForm>
                  </details>
                </>
              )}
            </article>
          );
        })}
      </section>

      {manage && steps.length < 20 && (
        <section className="card stack">
          <h2>Add a step</h2>
          <ActionForm action={saveSequenceStep} className="stack">
            <input type="hidden" name="workspace_id" value={workspace.id} />
            <input type="hidden" name="campaign_id" value={campaign.id} />
            <div className="row">
              <label className="field">
                <span>Position</span>
                <input type="number" name="position" min={1} max={20} defaultValue={nextPosition} required />
              </label>
              <label className="field">
                <span>Channel</span>
                <select name="channel" defaultValue="email">
                  {STEP_CHANNELS.map((c) => <option key={c} value={c}>{CHANNEL_LABELS[c]}</option>)}
                </select>
              </label>
              <label className="field">
                <span>Wait at least</span>
                <select name="wait_hours" defaultValue="48">
                  {WAITS.map((h) => <option key={h} value={h}>{waitLabel(h)}</option>)}
                </select>
              </label>
            </div>
            <label className="field">
              <span>Run when</span>
              <select name="trigger" defaultValue="no_reply">
                {TRIGGER_KEYS.map((k) => <option key={k} value={k}>{TRIGGERS[k].label}</option>)}
              </select>
            </label>
            <label className="choice">
              <input type="checkbox" name="is_last" />
              <span>Stop the sequence after this step</span>
            </label>
            <SubmitButton>Add step</SubmitButton>
          </ActionForm>
        </section>
      )}

      {manage && campaign.branching_enabled && steps.length > 0 && (
        <section className="card stack">
          <h2>Run the sequence now</h2>
          <p>
            The sequence runs on its own schedule. This sends whatever is due right now, within the campaign&apos;s
            daily limit of {campaign.daily_send_limit}.
          </p>
          <ActionForm action={queueAgentJob}>
            <input type="hidden" name="workspace_id" value={workspace.id} />
            <input type="hidden" name="campaign_id" value={campaign.id} />
            <input type="hidden" name="type" value="sequence" />
            <SubmitButton variant="secondary">Run sequence steps</SubmitButton>
          </ActionForm>
        </section>
      )}

      <section className="card stack">
        <h2>How the messages compare</h2>
        <p>
          Sends come from the record of what actually went out.{' '}
          <Link href={`${base}/learning`}>The weekly learning report</Link> is what decides whether a difference
          between two messages is big enough to trust, using the same test it applies everywhere else.
        </p>
        {nothingSent && <p className="muted">Nothing has been sent from a sequence step yet.</p>}
      </section>
    </main>
  );
}
