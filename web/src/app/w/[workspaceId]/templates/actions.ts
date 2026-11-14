'use server';

import { revalidatePath } from 'next/cache';
import { friendlyDbError } from '@/lib/errors';
import type { FormState } from '@/lib/form-state';
import { requireUser } from '@/lib/session';
import { firstError, uuidSchema } from '@/lib/validation';
import { saveSequenceSchema, snippetSchema } from '@/lib/templates';

const NO_PERMISSION = 'Only owners and admins can change the template library.';

/** Saves a campaign's sequence into the library as a named template. */
export async function saveSequenceTemplate(_prev: FormState, form: FormData): Promise<FormState> {
  const ws = uuidSchema.safeParse(form.get('workspace_id'));
  const campaignId = uuidSchema.safeParse(form.get('campaign_id'));
  if (!ws.success || !campaignId.success) return { error: 'Campaign not found.' };

  const parsed = saveSequenceSchema.safeParse({
    name: form.get('name') ?? '',
    description: form.get('description') ?? '',
  });
  if (!parsed.success) return { error: firstError(parsed.error) };

  const { supabase } = await requireUser();
  const { error } = await supabase.rpc('template_save_sequence', {
    ws: ws.data,
    p_campaign: campaignId.data,
    p_name: parsed.data.name,
    p_description: parsed.data.description?.trim() ? parsed.data.description.trim() : null,
  });
  if (error) {
    if (error.code === '42501') return { error: NO_PERMISSION };
    if (/no sequence to save/i.test(error.message)) {
      return { error: 'This campaign has no sequence yet, so there is nothing to save. Build the steps first.' };
    }
    if (error.code === '23505' || /duplicate key|unique/i.test(error.message)) {
      return { error: 'A sequence template already uses that name. Pick another.' };
    }
    return { error: friendlyDbError(error) };
  }
  revalidatePath(`/w/${ws.data}/templates`);
  revalidatePath(`/w/${ws.data}/campaigns/${campaignId.data}/sequence`);
  return { notice: `Saved as "${parsed.data.name}". Apply it to another campaign from the template library.` };
}

/** Replaces a campaign's sequence with a template's steps. */
export async function applySequenceTemplate(_prev: FormState, form: FormData): Promise<FormState> {
  const ws = uuidSchema.safeParse(form.get('workspace_id'));
  const templateId = uuidSchema.safeParse(form.get('template_id'));
  const campaignId = uuidSchema.safeParse(form.get('campaign_id'));
  if (!ws.success || !templateId.success) return { error: 'Template not found.' };
  if (!campaignId.success) return { error: 'Choose the campaign to apply it to.' };
  const replaceSent = form.get('replace_sent') === 'on';

  const { supabase } = await requireUser();
  const { data, error } = await supabase.rpc('template_apply_sequence', {
    ws: ws.data,
    p_template: templateId.data,
    p_campaign: campaignId.data,
    p_replace_sent: replaceSent,
  });
  if (error) {
    if (/Only owners and admins/i.test(error.message)) return { error: NO_PERMISSION };
    if (/already sent/i.test(error.message)) {
      return {
        error: 'That campaign has already sent sequence steps. Applying a template replaces the sequence and the record of what was sent — tick the box below to go ahead anyway.',
      };
    }
    if (/holds no steps|was not found/i.test(error.message)) {
      return { error: 'That template was not found, or it holds no steps.' };
    }
    return { error: friendlyDbError(error) };
  }
  revalidatePath(`/w/${ws.data}/campaigns/${campaignId.data}/sequence`);
  revalidatePath(`/w/${ws.data}/templates`);
  const n = typeof data === 'number' ? data : 0;
  return { notice: `${n} ${n === 1 ? 'step' : 'steps'} written to the campaign. Check them before turning branching on.` };
}

/** Writes a snippet, or changes one when template_id is given. */
export async function saveSnippet(_prev: FormState, form: FormData): Promise<FormState> {
  const ws = uuidSchema.safeParse(form.get('workspace_id'));
  if (!ws.success) return { error: 'Workspace not found.' };
  const templateId = form.get('template_id') ? uuidSchema.safeParse(form.get('template_id')) : null;
  if (templateId && !templateId.success) return { error: 'Snippet not found.' };

  const parsed = snippetSchema.safeParse({
    name: form.get('name') ?? '',
    description: form.get('description') ?? '',
    body: form.get('body') ?? '',
  });
  if (!parsed.success) return { error: firstError(parsed.error) };

  const { supabase } = await requireUser();
  const row = {
    workspace_id: ws.data,
    kind: 'snippet' as const,
    name: parsed.data.name,
    description: parsed.data.description?.trim() ? parsed.data.description.trim() : null,
    payload: { body: parsed.data.body },
  };
  const query = templateId
    ? supabase.from('templates').update(row).eq('workspace_id', ws.data).eq('id', templateId.data).select('id')
    : supabase.from('templates').insert(row).select('id');
  const { data, error } = await query;
  if (error) {
    if (error.code === '23505' || /duplicate key|unique/i.test(error.message)) {
      return { error: 'A snippet already uses that name. Pick another.' };
    }
    return { error: friendlyDbError(error) };
  }
  if (!data?.length) return { error: NO_PERMISSION };
  revalidatePath(`/w/${ws.data}/templates`);
  return { notice: `Snippet "${parsed.data.name}" saved. The copywriter will draw on it from the next run.` };
}

export async function deleteTemplate(_prev: FormState, form: FormData): Promise<FormState> {
  const ws = uuidSchema.safeParse(form.get('workspace_id'));
  const templateId = uuidSchema.safeParse(form.get('template_id'));
  if (!ws.success || !templateId.success) return { error: 'Template not found.' };

  const { supabase } = await requireUser();
  const { data, error } = await supabase.from('templates')
    .delete().eq('workspace_id', ws.data).eq('id', templateId.data).select('name, kind');
  if (error) return { error: friendlyDbError(error) };
  if (!data?.length) return { error: NO_PERMISSION };
  revalidatePath(`/w/${ws.data}/templates`);
  return { notice: `"${data[0].name}" removed from the library. Campaigns already built from it are untouched.` };
}
