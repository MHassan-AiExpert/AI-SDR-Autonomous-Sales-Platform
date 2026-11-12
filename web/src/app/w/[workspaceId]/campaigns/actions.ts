'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { friendlyDbError } from '@/lib/errors';
import type { FormState } from '@/lib/form-state';
import { requireUser } from '@/lib/session';
import { JOB_TYPES, parseCampaignForm, type JobType } from '@/lib/campaigns';
import { firstError, uuidSchema } from '@/lib/validation';

const NO_PERMISSION = 'Only owners and admins can manage campaigns.';

// Row-level security re-checks every write: only owners and admins can create
// campaigns or queue agent work, and only inside their own workspace.

export async function createCampaign(_prev: FormState, form: FormData): Promise<FormState> {
  const ws = uuidSchema.safeParse(form.get('workspace_id'));
  if (!ws.success) return { error: 'Workspace not found.' };
  const parsed = parseCampaignForm(form);
  if (!parsed.success) return { error: firstError(parsed.error) };
  const { find_leads_now, ...fields } = parsed.data;

  const { supabase, user } = await requireUser();
  const { data: campaign, error } = await supabase
    .from('campaigns')
    .insert({ workspace_id: ws.data, ...fields, status: 'active', created_by: user.id })
    .select('id')
    .single();
  if (error || !campaign) return { error: error?.code === '42501' ? NO_PERMISSION : friendlyDbError(error) };

  // The setup agent plans first; lead sourcing then runs on the saved plan
  const jobs = [{ workspace_id: ws.data, campaign_id: campaign.id, type: 'campaign_plan', requested_by: user.id }];
  if (find_leads_now) jobs.push({ workspace_id: ws.data, campaign_id: campaign.id, type: 'lead_sourcing', requested_by: user.id });
  const { error: jobError } = await supabase.from('agent_jobs').insert(jobs);
  if (jobError) return { error: friendlyDbError(jobError) };

  revalidatePath(`/w/${ws.data}/campaigns`);
  redirect(`/w/${ws.data}/campaigns/${campaign.id}`);
}

export async function queueAgentJob(_prev: FormState, form: FormData): Promise<FormState> {
  const ws = uuidSchema.safeParse(form.get('workspace_id'));
  const campaignId = uuidSchema.safeParse(form.get('campaign_id'));
  const type = form.get('type') as JobType;
  if (!ws.success || !campaignId.success) return { error: 'Campaign not found.' };
  if (!(JOB_TYPES as readonly string[]).includes(type)) return { error: 'Unknown agent task.' };

  const { supabase, user } = await requireUser();
  const { error } = await supabase
    .from('agent_jobs')
    .insert({ workspace_id: ws.data, campaign_id: campaignId.data, type, requested_by: user.id });
  if (error?.code === '23505') return { error: 'The agent is already working on this. Wait for it to finish.' };
  if (error?.code === '42501') return { error: NO_PERMISSION };
  if (error?.code === '23503') return { error: 'Campaign not found.' };
  if (error) return { error: friendlyDbError(error) };

  revalidatePath(`/w/${ws.data}/campaigns/${campaignId.data}`);
  const notices: Record<JobType, string> = {
    campaign_plan: 'The setup agent will re-plan this campaign within a minute.',
    lead_sourcing: 'The lead sourcing agent will start within a minute.',
    enrichment: 'The enrichment agent will find contacts and verify emails and phones within a minute.',
  };
  return { notice: notices[type] };
}

export async function setCampaignStatus(_prev: FormState, form: FormData): Promise<FormState> {
  const ws = uuidSchema.safeParse(form.get('workspace_id'));
  const campaignId = uuidSchema.safeParse(form.get('campaign_id'));
  const status = form.get('status');
  if (!ws.success || !campaignId.success) return { error: 'Campaign not found.' };
  if (status !== 'active' && status !== 'paused' && status !== 'archived') return { error: 'Unknown status.' };

  const { supabase } = await requireUser();
  const { data, error } = await supabase
    .from('campaigns')
    .update({ status, updated_at: new Date().toISOString() })
    .eq('workspace_id', ws.data)
    .eq('id', campaignId.data)
    .select('id');
  if (error) return { error: friendlyDbError(error) };
  if (!data?.length) return { error: NO_PERMISSION };
  revalidatePath(`/w/${ws.data}/campaigns/${campaignId.data}`);
  return { notice: status === 'active' ? 'Campaign is active.' : status === 'paused' ? 'Campaign paused.' : 'Campaign archived.' };
}
