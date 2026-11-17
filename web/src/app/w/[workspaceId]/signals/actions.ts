'use server';

import { revalidatePath } from 'next/cache';
import { friendlyDbError } from '@/lib/errors';
import type { FormState } from '@/lib/form-state';
import { requireUser } from '@/lib/session';
import { firstError, uuidSchema } from '@/lib/validation';
import { BUILT_IN_KINDS, signalSettingsSchema } from '@/lib/signals';

/** Dismisses a signal, or brings a dismissed one back. */
export async function setSignalStatus(_prev: FormState, form: FormData): Promise<FormState> {
  const ws = uuidSchema.safeParse(form.get('workspace_id'));
  const id = uuidSchema.safeParse(form.get('signal_id'));
  const status = form.get('status');
  if (!ws.success || !id.success || (status !== 'dismissed' && status !== 'new')) return { error: 'Signal not found.' };

  const { supabase } = await requireUser();
  const { data, error } = await supabase.from('signals')
    .update({ status }).eq('workspace_id', ws.data).eq('id', id.data).select('id');
  if (error) return { error: friendlyDbError(error) };
  if (!data?.length) return { error: 'Only owners, admins and reps can change a signal.' };
  revalidatePath(`/w/${ws.data}/signals`);
  return { notice: status === 'dismissed' ? 'Signal dismissed. No step will use it.' : 'Signal restored.' };
}

/** Whether a campaign watches for signals, and which built-in kinds. */
export async function saveSignalSettings(_prev: FormState, form: FormData): Promise<FormState> {
  const ws = uuidSchema.safeParse(form.get('workspace_id'));
  const campaignId = uuidSchema.safeParse(form.get('campaign_id'));
  if (!ws.success || !campaignId.success) return { error: 'Campaign not found.' };
  const parsed = signalSettingsSchema.safeParse({
    signals_enabled: form.get('signals_enabled') === 'on',
    signal_kinds: BUILT_IN_KINDS.filter((k) => form.get(`kind_${k}`) === 'on'),
  });
  if (!parsed.success) return { error: firstError(parsed.error) };
  if (parsed.data.signals_enabled && !parsed.data.signal_kinds.length) {
    return { error: 'Choose at least one kind of signal to watch for, or turn signals off.' };
  }

  const { supabase } = await requireUser();
  const { data, error } = await supabase.from('campaigns')
    .update({ ...parsed.data, updated_at: new Date().toISOString() })
    .eq('workspace_id', ws.data).eq('id', campaignId.data).select('id');
  if (error) return { error: friendlyDbError(error) };
  if (!data?.length) return { error: 'Only owners and admins can change this.' };
  revalidatePath(`/w/${ws.data}/campaigns/${campaignId.data}/sequence`);
  return {
    notice: parsed.data.signals_enabled
      ? 'Signals are on. The agent looks at this campaign\'s companies once a day.'
      : 'Signals are off for this campaign.',
  };
}
