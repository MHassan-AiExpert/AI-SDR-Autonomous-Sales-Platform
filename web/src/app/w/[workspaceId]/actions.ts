'use server';

import { revalidatePath } from 'next/cache';
import { friendlyDbError } from '@/lib/errors';
import type { FormState } from '@/lib/form-state';
import { requireUser } from '@/lib/session';
import { addMemberSchema, firstError, parseSettingsForm, roleSchema, uuidSchema } from '@/lib/validation';
import { parsePlaybook } from '@/lib/closer';
import { DECISIONS, DECISION_NOTICES, type Decision } from '@/lib/learning';
import { spendSchema } from '@/lib/analytics';
import { parseCrmForm } from '@/lib/crm';
import { parseNotifyForm } from '@/lib/notifications';
import { MAX_ROWS, describeImport } from '@/lib/csv';
import { LEAD_STAGES, STAGE_LABELS } from '@/lib/campaigns';

const NO_PERMISSION = 'You do not have permission to do that.';

// Every action is re-checked by row-level security in the database. An update
// or delete the caller is not allowed to make simply matches zero rows.

function workspaceIdFrom(form: FormData): string | null {
  const parsed = uuidSchema.safeParse(form.get('workspace_id'));
  return parsed.success ? parsed.data : null;
}

export async function updateSettings(_prev: FormState, form: FormData): Promise<FormState> {
  const workspaceId = workspaceIdFrom(form);
  if (!workspaceId) return { error: 'Workspace not found.' };
  const parsed = parseSettingsForm(form);
  if (!parsed.success) return { error: firstError(parsed.error) };

  const { supabase } = await requireUser();
  const { data, error } = await supabase.from('workspaces').update(parsed.data).eq('id', workspaceId).select('id');
  if (error) return { error: friendlyDbError(error) };
  if (!data?.length) return { error: NO_PERMISSION };
  revalidatePath(`/w/${workspaceId}`, 'layout');
  return { notice: 'Settings saved.' };
}

export async function setOutreachPaused(_prev: FormState, form: FormData): Promise<FormState> {
  const workspaceId = workspaceIdFrom(form);
  if (!workspaceId) return { error: 'Workspace not found.' };
  const paused = form.get('paused') === 'true';

  const { supabase } = await requireUser();
  const { data, error } = await supabase
    .from('workspaces')
    .update({ outreach_paused: paused })
    .eq('id', workspaceId)
    .select('id');
  if (error) return { error: friendlyDbError(error) };
  if (!data?.length) return { error: NO_PERMISSION };
  revalidatePath(`/w/${workspaceId}`, 'layout');
  return { notice: paused ? 'All outreach is paused.' : 'Outreach resumed.' };
}

export async function addMember(_prev: FormState, form: FormData): Promise<FormState> {
  const workspaceId = workspaceIdFrom(form);
  if (!workspaceId) return { error: 'Workspace not found.' };
  const parsed = addMemberSchema.safeParse({ email: form.get('email') ?? '', role: form.get('role') ?? '' });
  if (!parsed.success) return { error: firstError(parsed.error) };

  const { supabase } = await requireUser();
  const { error } = await supabase.rpc('workspace_member_add', {
    ws: workspaceId,
    member_email: parsed.data.email,
    member_role: parsed.data.role,
  });
  if (error) return { error: friendlyDbError(error) };
  revalidatePath(`/w/${workspaceId}/members`);
  return { notice: `${parsed.data.email} was added.` };
}

export async function changeMemberRole(_prev: FormState, form: FormData): Promise<FormState> {
  const workspaceId = workspaceIdFrom(form);
  const userId = uuidSchema.safeParse(form.get('user_id'));
  const role = roleSchema.safeParse(form.get('role'));
  if (!workspaceId || !userId.success) return { error: 'Member not found.' };
  if (!role.success) return { error: firstError(role.error) };

  const { supabase } = await requireUser();
  const { data, error } = await supabase
    .from('workspace_members')
    .update({ role: role.data })
    .eq('workspace_id', workspaceId)
    .eq('user_id', userId.data)
    .select('user_id');
  if (error) return { error: friendlyDbError(error, NO_PERMISSION) };
  if (!data?.length) return { error: NO_PERMISSION };
  revalidatePath(`/w/${workspaceId}/members`);
  return { notice: 'Role updated.' };
}

export async function removeMember(_prev: FormState, form: FormData): Promise<FormState> {
  const workspaceId = workspaceIdFrom(form);
  const userId = uuidSchema.safeParse(form.get('user_id'));
  if (!workspaceId || !userId.success) return { error: 'Member not found.' };

  const { supabase } = await requireUser();
  const { data, error } = await supabase
    .from('workspace_members')
    .delete()
    .eq('workspace_id', workspaceId)
    .eq('user_id', userId.data)
    .select('user_id');
  if (error) return { error: friendlyDbError(error, NO_PERMISSION) };
  if (!data?.length) return { error: NO_PERMISSION };
  revalidatePath(`/w/${workspaceId}/members`);
  return { notice: 'Member removed.' };
}

export async function rotateWebhookToken(_prev: FormState, form: FormData): Promise<FormState> {
  const workspaceId = workspaceIdFrom(form);
  if (!workspaceId) return { error: 'Workspace not found.' };
  const { supabase } = await requireUser();
  const { error } = await supabase.rpc('workspace_rotate_webhook_token', { ws: workspaceId });
  if (error) return { error: friendlyDbError(error, NO_PERMISSION) };
  revalidatePath(`/w/${workspaceId}/settings`);
  return { notice: 'New webhook address created. Update it in Instantly; the old one no longer works.' };
}

export async function markReplyHandled(_prev: FormState, form: FormData): Promise<FormState> {
  const workspaceId = workspaceIdFrom(form);
  const replyId = uuidSchema.safeParse(form.get('reply_id'));
  const reopen = form.get('reopen') === 'true';
  if (!workspaceId || !replyId.success) return { error: 'Reply not found.' };
  const { supabase } = await requireUser();
  const { data, error } = await supabase.from('replies')
    .update(reopen ? { handled_at: null, handled_by: null } : { handled_at: new Date().toISOString(), handled_by: 'human' })
    .eq('workspace_id', workspaceId).eq('id', replyId.data).select('id');
  if (error) return { error: friendlyDbError(error) };
  if (!data?.length) return { error: NO_PERMISSION };
  revalidatePath(`/w/${workspaceId}/inbox`);
  return { notice: reopen ? 'Moved back to the inbox.' : 'Marked as handled.' };
}

export async function saveAnswer(_prev: FormState, form: FormData): Promise<FormState> {
  const workspaceId = workspaceIdFrom(form);
  const replyId = uuidSchema.safeParse(form.get('reply_id'));
  const decision = form.get('decision');
  const answer = String(form.get('answer') ?? '').trim();
  if (!workspaceId || !replyId.success) return { error: 'Reply not found.' };
  if (decision !== 'send' && decision !== 'save') return { error: 'Unknown action.' };
  if (answer.length < 10) return { error: 'Write the answer first.' };
  if (answer.length > 3000) return { error: 'The answer is too long.' };
  if (/<[a-z!/]|\{\{|\}\}/i.test(answer)) return { error: 'Answers are plain text: remove HTML and {{ }} placeholders.' };
  const { supabase } = await requireUser();
  const { data, error } = await supabase.from('replies')
    .update({ answer, answer_status: decision === 'send' ? 'approved' : 'draft' })
    .eq('workspace_id', workspaceId).eq('id', replyId.data).select('id');
  if (error) return { error: error.code === '23514' && error.message ? error.message : friendlyDbError(error) };
  if (!data?.length) return { error: NO_PERMISSION };
  revalidatePath(`/w/${workspaceId}/inbox`);
  return { notice: decision === 'send' ? 'Approved. It is sent in the same email thread within a minute.' : 'Draft saved.' };
}

const CONSENT = ['prior_express_consent', 'existing_customer', 'inbound_request'];

export async function setCallConsent(_prev: FormState, form: FormData): Promise<FormState> {
  const workspaceId = workspaceIdFrom(form);
  const leadId = uuidSchema.safeParse(form.get('lead_id'));
  const basis = String(form.get('basis') ?? '');
  const channel = String(form.get('channel') ?? 'voice');
  if (!workspaceId || !leadId.success) return { error: 'Lead not found.' };
  if (channel !== 'voice' && channel !== 'sms' && channel !== 'whatsapp') return { error: 'Unknown channel.' };
  if (basis !== 'withdraw' && !CONSENT.includes(basis)) return { error: 'Choose the consent basis.' };
  const { supabase, user } = await requireUser();
  const { data: lead } = await supabase.from('leads').select('consent').eq('workspace_id', workspaceId).eq('id', leadId.data).maybeSingle();
  if (!lead) return { error: 'Lead not found.' };
  const consent = { ...((lead.consent as Record<string, unknown>) ?? {}) };
  if (basis === 'withdraw') {
    delete consent[channel];
    consent[`${channel}_withdrawn_at`] = new Date().toISOString();
    consent[`${channel}_withdrawn_by`] = user.id;
  } else {
    consent[channel] = basis;
    consent[`${channel}_recorded_at`] = new Date().toISOString();
    consent[`${channel}_recorded_by`] = user.id;
  }
  const { data, error } = await supabase.from('leads').update({ consent }).eq('workspace_id', workspaceId).eq('id', leadId.data).select('id');
  if (error) return { error: friendlyDbError(error) };
  if (!data?.length) return { error: NO_PERMISSION };
  revalidatePath(`/w/${workspaceId}/leads/${leadId.data}`);
  const what = channel === 'voice' ? 'called' : channel === 'sms' ? 'sent SMS follow-ups' : 'sent WhatsApp follow-ups';
  return { notice: basis === 'withdraw' ? `Consent removed. This lead will not be ${what}.` : `Consent recorded. This lead may be ${what}.` };
}

export async function savePlaybook(_prev: FormState, form: FormData): Promise<FormState> {
  const workspaceId = workspaceIdFrom(form);
  if (!workspaceId) return { error: 'Workspace not found.' };
  const parsed = parsePlaybook(form);
  if (!parsed.success) return { error: firstError(parsed.error) };
  const { supabase } = await requireUser();
  const { data, error } = await supabase.rpc('playbook_publish', { ws: workspaceId, p_content: parsed.data });
  if (error?.code === '42501') return { error: 'Only owners and admins can change the playbook.' };
  if (error) return { error: friendlyDbError(error) };
  revalidatePath(`/w/${workspaceId}/playbook`);
  return { notice: `Playbook version ${data} is live. The AI closer and copywriter use it from now on.` };
}

export async function setMeetingRunner(_prev: FormState, form: FormData): Promise<FormState> {
  const workspaceId = workspaceIdFrom(form);
  const meetingId = uuidSchema.safeParse(form.get('meeting_id'));
  const runner = form.get('run_by');
  if (!workspaceId || !meetingId.success) return { error: 'Meeting not found.' };
  if (runner !== 'human' && runner !== 'ai_closer') return { error: 'Choose who runs the meeting.' };
  const { supabase } = await requireUser();
  // Only meetings that have not started can change hands
  const { data, error } = await supabase.from('meetings')
    .update(runner === 'human' ? { run_by: 'human', closer_status: 'handed_off', closer_note: 'Taken by your team', updated_at: new Date().toISOString() }
      : { run_by: 'ai_closer', closer_status: 'pending', closer_note: null, updated_at: new Date().toISOString() })
    .eq('workspace_id', workspaceId).eq('id', meetingId.data).eq('status', 'scheduled').in('closer_status', ['pending', 'handed_off'])
    .gt('starts_at', new Date().toISOString())
    .select('id');
  if (error) return { error: friendlyDbError(error) };
  if (!data?.length) return { error: 'This meeting has already started or you cannot change it.' };
  revalidatePath(`/w/${workspaceId}/meetings`);
  return { notice: runner === 'human' ? 'Your team runs this meeting. It is on your task list.' : 'The AI closer will run this meeting.' };
}

export async function decideLesson(_prev: FormState, form: FormData): Promise<FormState> {
  const workspaceId = workspaceIdFrom(form);
  const id = uuidSchema.safeParse(form.get('suggestion_id'));
  const decision = String(form.get('decision') ?? '');
  if (!workspaceId || !id.success) return { error: 'Suggestion not found.' };
  if (!(DECISIONS as readonly string[]).includes(decision)) return { error: 'Unknown decision.' };
  const { supabase } = await requireUser();
  const { data, error } = await supabase.rpc('learning_decide', { p_suggestion: id.data, p_decision: decision as Decision });
  if (error?.code === '42501') return { error: 'Only owners and admins can change lessons.' };
  if (error) return { error: error.message.includes('already been decided') ? 'This suggestion has already been decided.' : friendlyDbError(error) };
  revalidatePath(`/w/${workspaceId}/learning`);
  return { notice: DECISION_NOTICES[String(data)] ?? 'Saved.' };
}

export async function setLearningAutoApply(_prev: FormState, form: FormData): Promise<FormState> {
  const workspaceId = workspaceIdFrom(form);
  const campaignId = uuidSchema.safeParse(form.get('campaign_id'));
  const on = form.get('enabled') === 'true';
  if (!workspaceId || !campaignId.success) return { error: 'Campaign not found.' };
  const { supabase } = await requireUser();
  const { data, error } = await supabase.from('campaigns').update({ learning_auto_apply: on, updated_at: new Date().toISOString() })
    .eq('workspace_id', workspaceId).eq('id', campaignId.data).select('id');
  if (error) return { error: friendlyDbError(error) };
  if (!data?.length) return { error: NO_PERMISSION };
  revalidatePath(`/w/${workspaceId}/learning`);
  return { notice: on ? 'New lessons for the copywriter are applied as they are found. Threshold changes still wait for you.' : 'New lessons wait for your approval.' };
}

export async function runLearningNow(_prev: FormState, form: FormData): Promise<FormState> {
  const workspaceId = workspaceIdFrom(form);
  const campaignId = uuidSchema.safeParse(form.get('campaign_id'));
  if (!workspaceId || !campaignId.success) return { error: 'Campaign not found.' };
  const { supabase, user } = await requireUser();
  const { error } = await supabase.from('agent_jobs').insert({ workspace_id: workspaceId, campaign_id: campaignId.data, type: 'learning', requested_by: user.id });
  if (error?.code === '23505') return { notice: 'A learning run is already waiting for this campaign.' };
  if (error) return { error: friendlyDbError(error) };
  revalidatePath(`/w/${workspaceId}/learning`);
  return { notice: 'The learning agent will look at the latest results within a minute.' };
}

export async function saveSpend(_prev: FormState, form: FormData): Promise<FormState> {
  const workspaceId = workspaceIdFrom(form);
  if (!workspaceId) return { error: 'Workspace not found.' };
  const parsed = spendSchema.safeParse({ monthly_spend: form.get('monthly_spend') ?? '', spend_currency: form.get('spend_currency') ?? '' });
  if (!parsed.success) return { error: firstError(parsed.error) };
  const { supabase } = await requireUser();
  const { data, error } = await supabase.from('workspaces')
    .update({ monthly_spend_cents: parsed.data.monthly_spend, spend_currency: parsed.data.spend_currency }).eq('id', workspaceId).select('id');
  if (error) return { error: friendlyDbError(error) };
  if (!data?.length) return { error: NO_PERMISSION };
  revalidatePath(`/w/${workspaceId}/analytics`);
  return { notice: parsed.data.monthly_spend === null ? 'Spend cleared.' : 'Spend saved. Cost per meeting now uses it.' };
}

export async function saveCrmSettings(_prev: FormState, form: FormData): Promise<FormState> {
  const workspaceId = workspaceIdFrom(form);
  if (!workspaceId) return { error: 'Workspace not found.' };
  const parsed = parseCrmForm(form);
  if (!parsed.success) return { error: firstError(parsed.error) };
  const { supabase } = await requireUser();
  if (parsed.data.crm_sync_enabled) {
    const { data: hub } = await supabase.from('integrations').select('status').eq('workspace_id', workspaceId).eq('tool', 'hubspot').maybeSingle();
    if (hub?.status !== 'connected') return { error: 'Connect HubSpot in Setup before switching sync on.' };
  }
  const { data, error } = await supabase.from('workspaces').update(parsed.data).eq('id', workspaceId).select('id');
  if (error) return { error: friendlyDbError(error) };
  if (!data?.length) return { error: NO_PERMISSION };
  revalidatePath(`/w/${workspaceId}/settings`);
  return { notice: parsed.data.crm_sync_enabled ? 'CRM sync is on. Leads, deals and activity go to HubSpot every hour.' : 'CRM sync saved and switched off.' };
}

export async function syncCrmNow(_prev: FormState, form: FormData): Promise<FormState> {
  const workspaceId = workspaceIdFrom(form);
  if (!workspaceId) return { error: 'Workspace not found.' };
  const { supabase, user } = await requireUser();
  const { data: ws } = await supabase.from('workspaces').select('crm_sync_enabled').eq('id', workspaceId).maybeSingle();
  if (!ws?.crm_sync_enabled) return { error: 'Switch CRM sync on first.' };
  const { data: campaigns } = await supabase.from('campaigns').select('id').eq('workspace_id', workspaceId).eq('status', 'active');
  if (!campaigns?.length) return { error: 'There are no active campaigns to sync.' };
  let queued = 0;
  for (const c of campaigns) {
    const { error } = await supabase.from('agent_jobs').insert({ workspace_id: workspaceId, campaign_id: c.id, type: 'crm_sync', requested_by: user.id });
    if (error?.code === '42501') return { error: NO_PERMISSION };
    if (error && error.code !== '23505') return { error: friendlyDbError(error) };
    if (!error) queued++;
  }
  revalidatePath(`/w/${workspaceId}/settings`);
  return { notice: queued ? 'HubSpot will be brought up to date within a minute.' : 'A sync is already waiting to run.' };
}

export async function saveNotifySettings(_prev: FormState, form: FormData): Promise<FormState> {
  const workspaceId = workspaceIdFrom(form);
  if (!workspaceId) return { error: 'Workspace not found.' };
  const parsed = parseNotifyForm(form);
  if (!parsed.success) return { error: firstError(parsed.error) };
  const { supabase } = await requireUser();
  const { data, error } = await supabase.from('workspaces').update(parsed.data).eq('id', workspaceId).select('id');
  if (error) return { error: friendlyDbError(error) };
  if (!data?.length) return { error: NO_PERMISSION };
  revalidatePath(`/w/${workspaceId}/settings`);
  return { notice: 'Notification and alert settings saved.' };
}

export async function acceptHandoff(_prev: FormState, form: FormData): Promise<FormState> {
  const workspaceId = workspaceIdFrom(form);
  const id = uuidSchema.safeParse(form.get('notification_id'));
  if (!workspaceId || !id.success) return { error: 'Notification not found.' };
  const { supabase, user } = await requireUser();
  const { data, error } = await supabase.from('notifications')
    .update({ accepted_by: user.id, accepted_at: new Date().toISOString() })
    .eq('workspace_id', workspaceId).eq('id', id.data).eq('event', 'handoff').is('accepted_at', null)
    .select('lead_id');
  if (error) return { error: friendlyDbError(error) };
  if (!data?.length) return { error: 'Someone has already taken this, or you cannot take handoffs.' };
  // The lead is assigned to the person who took it
  if (data[0].lead_id) await supabase.from('leads').update({ owner_id: user.id }).eq('workspace_id', workspaceId).eq('id', data[0].lead_id);
  revalidatePath(`/w/${workspaceId}/notifications`);
  return { notice: 'It is yours. The lead is now assigned to you.' };
}

// ---------------------------------------------------------------- CSV import

export async function importLeads(_prev: FormState, form: FormData): Promise<FormState> {
  const workspaceId = workspaceIdFrom(form);
  if (!workspaceId) return { error: 'Workspace not found.' };
  const campaign = uuidSchema.safeParse(form.get('campaign_id'));
  const filename = String(form.get('filename') ?? 'leads.csv').slice(0, 200);

  let rows: unknown;
  try {
    rows = JSON.parse(String(form.get('rows') ?? '[]'));
  } catch {
    return { error: 'That file could not be read. Save it as CSV and try again.' };
  }
  if (!Array.isArray(rows) || !rows.length) return { error: 'There are no rows to import.' };
  if (rows.length > MAX_ROWS) return { error: `Import up to ${MAX_ROWS.toLocaleString('en-US')} rows at a time.` };

  const { supabase } = await requireUser();
  const { data, error } = await supabase.rpc('leads_import', {
    ws: workspaceId, p_campaign: campaign.success ? campaign.data : null, p_filename: filename, p_rows: rows,
  });
  if (error?.code === '42501') return { error: 'You do not have permission to import leads here.' };
  if (error) return { error: friendlyDbError(error) };
  const r = data as { added: number; duplicates: number; suppressed: number; invalid: number } | null;
  if (!r) return { error: 'The import did not complete. Please try again.' };
  revalidatePath(`/w/${workspaceId}/leads`);
  return { notice: describeImport(r) };
}

export async function undoImport(_prev: FormState, form: FormData): Promise<FormState> {
  const workspaceId = workspaceIdFrom(form);
  const importId = uuidSchema.safeParse(form.get('import_id'));
  if (!workspaceId || !importId.success) return { error: 'Import not found.' };
  const { supabase } = await requireUser();
  const { data, error } = await supabase.rpc('lead_import_undo', { p_import: importId.data });
  if (error?.code === '42501' || /Only owners and admins/.test(error?.message ?? '')) {
    return { error: 'Only owners and admins can undo an import.' };
  }
  if (error) return { error: friendlyDbError(error) };
  revalidatePath(`/w/${workspaceId}/leads`);
  const n = Number(data ?? 0);
  return { notice: n ? `${n} ${n === 1 ? 'lead' : 'leads'} removed. Leads that had been worked were kept.` : 'Nothing to remove: every lead from that import had been worked.' };
}

// ---------------------------------------------------------------- bulk actions

const BULK_ACTIONS = ['stage', 'owner', 'campaign', 'suppress'] as const;

export async function bulkUpdateLeads(_prev: FormState, form: FormData): Promise<FormState> {
  const workspaceId = workspaceIdFrom(form);
  if (!workspaceId) return { error: 'Workspace not found.' };
  const action = String(form.get('bulk_action') ?? '');
  if (!(BULK_ACTIONS as readonly string[]).includes(action)) return { error: 'Choose what to do with the selected leads.' };

  const ids = form.getAll('lead_id').map((v) => uuidSchema.safeParse(v)).filter((p) => p.success).map((p) => p.data as string);
  if (!ids.length) return { error: 'Select at least one lead first.' };
  if (ids.length > 500) return { error: 'Select up to 500 leads at a time.' };

  const { supabase, user } = await requireUser();
  const now = new Date().toISOString();

  if (action === 'stage') {
    const stage = String(form.get('stage') ?? '');
    if (!(LEAD_STAGES as readonly string[]).includes(stage)) return { error: 'Choose a stage.' };
    const label = STAGE_LABELS[stage as (typeof LEAD_STAGES)[number]];
    const { data, error } = await supabase.from('leads')
      .update({ stage, stage_changed_at: now, updated_at: now })
      .eq('workspace_id', workspaceId).in('id', ids).select('id');
    if (error) return { error: friendlyDbError(error) };
    if (!data?.length) return { error: NO_PERMISSION };
    revalidatePath(`/w/${workspaceId}/leads`);
    return { notice: `${data.length} ${data.length === 1 ? 'lead' : 'leads'} moved to ${label}.` };
  }

  if (action === 'owner') {
    const raw = String(form.get('owner_id') ?? '');
    const owner = raw === 'me' ? user.id : raw === 'none' ? null : null;
    if (raw !== 'me' && raw !== 'none') return { error: 'Choose who should own these leads.' };
    const { data, error } = await supabase.from('leads')
      .update({ owner_id: owner, updated_at: now }).eq('workspace_id', workspaceId).in('id', ids).select('id');
    if (error) return { error: friendlyDbError(error) };
    if (!data?.length) return { error: NO_PERMISSION };
    revalidatePath(`/w/${workspaceId}/leads`);
    return { notice: owner ? `${data.length} assigned to you.` : `${data.length} unassigned.` };
  }

  if (action === 'campaign') {
    const campaign = uuidSchema.safeParse(form.get('campaign_id'));
    if (!campaign.success) return { error: 'Choose a campaign.' };
    const { data, error } = await supabase.from('leads')
      .update({ campaign_id: campaign.data, updated_at: now }).eq('workspace_id', workspaceId).in('id', ids).select('id');
    if (error) return { error: friendlyDbError(error) };
    if (!data?.length) return { error: NO_PERMISSION };
    revalidatePath(`/w/${workspaceId}/leads`);
    return { notice: `${data.length} ${data.length === 1 ? 'lead' : 'leads'} moved to that campaign.` };
  }

  // Suppress: stop all outreach, and keep the addresses out of future imports
  const { data: picked, error: readError } = await supabase.from('leads')
    .select('id, email, phone').eq('workspace_id', workspaceId).in('id', ids);
  if (readError) return { error: friendlyDbError(readError) };
  if (!picked?.length) return { error: 'Those leads were not found.' };

  const entries = picked.flatMap((l) => [
    ...(l.email ? [{ workspace_id: workspaceId, kind: 'email', value: String(l.email).toLowerCase().trim(), reason: 'manual' }] : []),
    ...(l.phone ? [{ workspace_id: workspaceId, kind: 'phone', value: String(l.phone).toLowerCase().trim(), reason: 'manual' }] : []),
  ]);
  if (entries.length) {
    const { error } = await supabase.from('suppressions').upsert(entries, { onConflict: 'workspace_id,kind,value', ignoreDuplicates: true });
    if (error?.code === '42501') return { error: NO_PERMISSION };
    if (error) return { error: friendlyDbError(error) };
  }
  const { data, error } = await supabase.from('leads')
    .update({ stage: 'do_not_contact', stage_changed_at: now, updated_at: now })
    .eq('workspace_id', workspaceId).in('id', ids).select('id');
  if (error) return { error: friendlyDbError(error) };
  if (!data?.length) return { error: NO_PERMISSION };
  revalidatePath(`/w/${workspaceId}/leads`);
  return { notice: `${data.length} ${data.length === 1 ? 'lead' : 'leads'} suppressed. They will not be contacted again, on any channel.` };
}
