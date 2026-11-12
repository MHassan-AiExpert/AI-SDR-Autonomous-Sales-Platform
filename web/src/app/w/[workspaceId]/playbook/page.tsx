import type { Metadata } from 'next';
import { ActionForm, SubmitButton } from '@/components/action-form';
import { canManageSettings } from '@/lib/roles';
import { requireWorkspace } from '@/lib/session';
import { INTERVALS, INTERVAL_LABELS, MAX_PLANS, money, readPlaybook } from '@/lib/closer';
import { savePlaybook } from '../actions';

export const metadata: Metadata = { title: 'Sales playbook' };

export default async function PlaybookPage({ params }: { params: Promise<{ workspaceId: string }> }) {
  const { workspaceId } = await params;
  const { supabase, workspace } = await requireWorkspace(workspaceId);
  const manage = canManageSettings(workspace.role);
  const { data: row } = await supabase.from('playbooks').select('version, content, created_at').eq('workspace_id', workspace.id).eq('is_active', true).maybeSingle();
  const pb = readPlaybook(row?.content);
  const plans = pb?.plans ?? [];

  return (
    <>
      <h1>Sales playbook</h1>
      <p className="muted">What the AI closer and the copywriter may say: your offer, your plans and prices, how to answer objections, and when to hand over to your team. The closer quotes only these prices, never offers discounts, and never takes payment details on a call; the payment link is created from the plan the prospect agrees to.</p>
      {row ? <p className="muted">Live version {row.version}, saved {new Date(row.created_at).toUTCString()}. Saving creates a new version.</p> : <p className="muted">No playbook yet. The AI closer needs one before it can run meetings.</p>}
      {pb ? (
        <section className="card stack" aria-labelledby="plans-now">
          <h2 id="plans-now">Plans the closer offers</h2>
          <ul className="list">{plans.map((p) => <li key={p.name}><strong>{p.name}</strong>: {money(p.price_cents, p.currency)} {INTERVAL_LABELS[p.interval].toLowerCase()}{p.description ? `. ${p.description}` : ''}</li>)}</ul>
        </section>
      ) : null}
      {manage ? (
        <ActionForm action={savePlaybook} className="card stack">
          <input type="hidden" name="workspace_id" value={workspace.id} />
          <label className="field"><span>Offer: what you sell, for whom, and the result</span><textarea name="offer_summary" rows={4} maxLength={1500} defaultValue={pb?.offer_summary ?? ''} required /></label>
          <fieldset className="stack"><legend>Plans and prices (up to {MAX_PLANS})</legend>
            {Array.from({ length: MAX_PLANS }, (_, i) => {
              const p = plans[i];
              return (
                <div key={i} className="row">
                  <label className="field"><span>Plan {i + 1} name</span><input name={`plan_${i}_name`} type="text" maxLength={80} defaultValue={p?.name ?? ''} /></label>
                  <label className="field"><span>Price</span><input name={`plan_${i}_price`} type="text" inputMode="decimal" defaultValue={p ? (p.price_cents / 100).toFixed(2) : ''} /></label>
                  <label className="field"><span>Currency</span><input name={`plan_${i}_currency`} type="text" maxLength={3} defaultValue={p?.currency ?? 'USD'} /></label>
                  <label className="field"><span>Billing</span>
                    <select name={`plan_${i}_interval`} defaultValue={p?.interval ?? 'month'}>{INTERVALS.map((v) => <option key={v} value={v}>{INTERVAL_LABELS[v]}</option>)}</select></label>
                  <label className="field"><span>What is included</span><input name={`plan_${i}_description`} type="text" maxLength={300} defaultValue={p?.description ?? ''} /></label>
                </div>
              );
            })}
          </fieldset>
          <label className="field"><span>Questions to ask (one per line)</span><textarea name="qualification_questions" rows={4} defaultValue={(pb?.qualification_questions ?? []).join('\n')} /></label>
          <label className="field"><span>Objections and answers (one per line: objection | answer)</span><textarea name="objections" rows={5} defaultValue={(pb?.objections ?? []).map((o) => `${o.objection} | ${o.answer}`).join('\n')} /></label>
          <label className="field"><span>Hand over to your team when (one per line)</span><textarea name="handoff_rules" rows={3} defaultValue={(pb?.handoff_rules ?? []).join('\n')} /></label>
          <div className="row">
            <label className="field"><span>PandaDoc proposal template ID</span><input name="proposal_template_id" type="text" defaultValue={pb?.proposal_template_id ?? ''} /></label>
            <label className="field"><span>Signer role in the template</span><input name="proposal_role" type="text" maxLength={60} defaultValue={pb?.proposal_role ?? 'Client'} /></label>
          </div>
          <p className="muted">The template can use these fields: [Client.FirstName], [Client.LastName], [Client.Company], [Plan.Name], [Plan.Price], [Payment.Link] and [Sender.Company].</p>
          <SubmitButton>Save and publish</SubmitButton>
        </ActionForm>
      ) : <p className="muted">Only owners and admins can change the playbook.</p>}
    </>
  );
}
