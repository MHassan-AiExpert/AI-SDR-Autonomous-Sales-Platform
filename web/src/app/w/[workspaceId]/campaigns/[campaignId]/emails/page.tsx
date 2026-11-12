import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ActionForm, SubmitButton } from '@/components/action-form';
import { requireWorkspace } from '@/lib/session';
import { uuidSchema } from '@/lib/validation';
import { EMAIL_STATUS_LABELS } from '@/lib/outreach';
import { approveAllDrafts, updateEmail } from '../../actions';

export const metadata: Metadata = { title: 'Emails' };

const STATUSES = ['draft', 'approved', 'rejected', 'queued'] as const;
type Row = { id: string; lead_id: string; step: number; subject: string; body: string; status: string; approved_at: string | null; leads: { full_name: string | null; email: string | null; score: number | null; companies: { name: string } | null } | null };

export default async function EmailsPage({
  params, searchParams,
}: {
  params: Promise<{ workspaceId: string; campaignId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { workspaceId, campaignId } = await params;
  if (!uuidSchema.safeParse(campaignId).success) notFound();
  const { supabase, workspace } = await requireWorkspace(workspaceId);
  const sp = await searchParams;
  const raw = Array.isArray(sp.status) ? sp.status[0] : sp.status;
  const status = (STATUSES as readonly string[]).includes(raw ?? '') ? (raw as (typeof STATUSES)[number]) : 'draft';
  const canEdit = workspace.role !== 'viewer';

  const { data: campaign } = await supabase.from('campaigns').select('id, name').eq('workspace_id', workspace.id).eq('id', campaignId).maybeSingle();
  if (!campaign) notFound();
  const { data } = await supabase
    .from('emails')
    .select('id, lead_id, step, subject, body, status, approved_at, leads(full_name, email, score, companies(name))')
    .eq('workspace_id', workspace.id).eq('campaign_id', campaign.id).eq('status', status)
    .order('lead_id').order('step').limit(150);
  const rows = (data ?? []) as unknown as Row[];
  const byLead = new Map<string, Row[]>();
  for (const r of rows) byLead.set(r.lead_id, [...(byLead.get(r.lead_id) ?? []), r]);
  const base = `/w/${workspace.id}/campaigns/${campaign.id}`;
  const editable = status === 'draft' || status === 'approved' || status === 'rejected';

  return (
    <>
      <p><Link href={base}>{campaign.name}</Link></p>
      <h1>Emails</h1>
      <nav className="chips" aria-label="Email status">
        {STATUSES.map((s) => <Link key={s} className={s === status ? 'chip chip-on' : 'chip'} href={`${base}/emails?status=${s}`}>{EMAIL_STATUS_LABELS[s]}</Link>)}
      </nav>
      {status === 'draft' && rows.length && canEdit ? (
        <ActionForm action={approveAllDrafts}>
          <input type="hidden" name="workspace_id" value={workspace.id} />
          <input type="hidden" name="campaign_id" value={campaign.id} />
          <SubmitButton>Approve all drafts</SubmitButton>
        </ActionForm>
      ) : null}
      {!rows.length ? <p className="muted">No emails here.</p> : null}
      {[...byLead.entries()].map(([leadId, emails]) => {
        const lead = emails[0].leads;
        return (
          <section key={leadId} className="card stack" aria-label={`Emails to ${lead?.full_name ?? lead?.email ?? 'lead'}`}>
            <div className="spread">
              <h2><Link href={`/w/${workspace.id}/leads/${leadId}`}>{lead?.full_name ?? lead?.email}</Link>{lead?.companies?.name ? <span className="muted"> · {lead.companies.name}</span> : null}</h2>
              {lead?.score !== null && lead?.score !== undefined ? <span className="badge">Score {lead.score}</span> : null}
            </div>
            <p className="muted">{lead?.email}</p>
            {emails.map((e) => (
              <ActionForm key={e.id} action={updateEmail} className="stack">
                <input type="hidden" name="workspace_id" value={workspace.id} />
                <input type="hidden" name="email_id" value={e.id} />
                <strong>{e.step === 1 ? 'First email' : `Follow-up ${e.step - 1}`}</strong>
                <label className="field"><span>Subject</span><input name="subject" type="text" maxLength={200} defaultValue={e.subject} disabled={!editable || !canEdit} /></label>
                <label className="field"><span>Email</span><textarea name="body" rows={8} maxLength={5000} defaultValue={e.body} disabled={!editable || !canEdit} /></label>
                {editable && canEdit ? (
                  <div className="row">
                    <button className="btn btn-primary" type="submit" name="decision" value="approve">Approve</button>
                    <button className="btn btn-secondary" type="submit" name="decision" value="save">Save changes</button>
                    <button className="btn btn-ghost" type="submit" name="decision" value="reject">Reject</button>
                  </div>
                ) : null}
              </ActionForm>
            ))}
          </section>
        );
      })}
    </>
  );
}
