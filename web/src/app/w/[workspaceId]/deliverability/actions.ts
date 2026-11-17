'use server';

import { revalidatePath } from 'next/cache';
import { friendlyDbError } from '@/lib/errors';
import type { FormState } from '@/lib/form-state';
import { requireUser } from '@/lib/session';
import { firstError, uuidSchema } from '@/lib/validation';
import { selectorSchema } from '@/lib/deliverability';

/** Asks for the domains and mailboxes to be checked at the next monitoring sweep. */
export async function checkNow(_prev: FormState, form: FormData): Promise<FormState> {
  const ws = uuidSchema.safeParse(form.get('workspace_id'));
  if (!ws.success) return { error: 'Workspace not found.' };
  const { supabase } = await requireUser();
  const { data, error } = await supabase.from('workspaces')
    .update({ deliverability_checked_at: null }).eq('id', ws.data).select('id');
  if (error) return { error: friendlyDbError(error) };
  if (!data?.length) return { error: 'Only owners and admins can ask for a check.' };
  revalidatePath(`/w/${ws.data}/deliverability`);
  return { notice: 'A check is queued. Results appear here within about 15 minutes.' };
}

/** The DKIM selector for a domain whose provider uses an uncommon one; blank goes back to the common ones. */
export async function saveSelector(_prev: FormState, form: FormData): Promise<FormState> {
  const ws = uuidSchema.safeParse(form.get('workspace_id'));
  const id = uuidSchema.safeParse(form.get('domain_id'));
  if (!ws.success || !id.success) return { error: 'Domain not found.' };
  const parsed = selectorSchema.safeParse(form.get('dkim_selector') ?? '');
  if (!parsed.success) return { error: firstError(parsed.error) };

  const { supabase } = await requireUser();
  const { data, error } = await supabase.from('sending_domains')
    .update({ dkim_selector: parsed.data || null }).eq('workspace_id', ws.data).eq('id', id.data).select('id');
  if (error) return { error: friendlyDbError(error) };
  if (!data?.length) return { error: 'Only owners and admins can change this.' };
  // Check again soon, so the new selector shows a result
  await supabase.from('workspaces').update({ deliverability_checked_at: null }).eq('id', ws.data);
  revalidatePath(`/w/${ws.data}/deliverability`);
  return { notice: parsed.data ? `Saved. The selector ${parsed.data} is checked within about 15 minutes.` : 'Saved. The common selectors are checked again.' };
}
