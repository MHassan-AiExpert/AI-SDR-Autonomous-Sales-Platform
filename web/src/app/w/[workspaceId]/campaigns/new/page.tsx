import type { Metadata } from 'next';
import Link from 'next/link';
import { ActionForm, SubmitButton } from '@/components/action-form';
import { canManageSettings } from '@/lib/roles';
import { requireWorkspace } from '@/lib/session';
import { createCampaign } from '../actions';

export const metadata: Metadata = { title: 'New campaign' };

export default async function NewCampaignPage({ params }: { params: Promise<{ workspaceId: string }> }) {
  const { workspaceId } = await params;
  const { workspace } = await requireWorkspace(workspaceId);

  if (!canManageSettings(workspace.role)) {
    return (
      <>
        <h1>New campaign</h1>
        <p className="muted">Only owners and admins can create campaigns.</p>
        <Link href={`/w/${workspace.id}/campaigns`}>Back to campaigns</Link>
      </>
    );
  }

  return (
    <>
      <h1>New campaign</h1>
      <p className="muted">Tell the setup agent who you sell to. It works out the ideal customer profile, picks the lead sources that fit and starts finding leads with your connected tools.</p>
      <ActionForm action={createCampaign} className="card stack">
        <input type="hidden" name="workspace_id" value={workspace.id} />
        <label className="field">
          <span>Campaign name</span>
          <input name="name" type="text" required maxLength={160} placeholder="Austin dental clinics" />
        </label>
        <label className="field">
          <span>Niche</span>
          <input name="niche" type="text" required minLength={2} maxLength={200} placeholder="Independent dental clinics" />
        </label>
        <label className="field">
          <span>Target areas, one per line</span>
          <textarea name="target_areas" rows={3} required placeholder={'Austin, Texas, United States\nUnited Kingdom'} />
        </label>
        <label className="field">
          <span>What you offer (optional)</span>
          <textarea name="offer" rows={2} maxLength={500} placeholder="Online booking that fills empty weekday appointments" />
        </label>
        <label className="field">
          <span>Leads per day</span>
          <input name="daily_lead_limit" type="number" min={1} max={1000} step={1} defaultValue={100} required />
        </label>
        <label className="field">
          <span>Minimum score for outreach (0 to 100)</span>
          <input name="score_threshold" type="number" min={0} max={100} step={1} defaultValue={60} required />
        </label>
        <label className="choice">
          <input type="checkbox" name="find_leads_now" defaultChecked />
          <span><strong>Find leads right away</strong><br />Start lead sourcing as soon as the plan is ready.</span>
        </label>
        <SubmitButton>Create campaign</SubmitButton>
      </ActionForm>
    </>
  );
}
