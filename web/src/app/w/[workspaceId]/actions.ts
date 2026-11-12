'use server';

import { revalidatePath } from 'next/cache';
import { friendlyDbError } from '@/lib/errors';
import type { FormState } from '@/lib/form-state';
import { requireUser } from '@/lib/session';
import { addMemberSchema, firstError, parseSettingsForm, roleSchema, uuidSchema } from '@/lib/validation';

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
