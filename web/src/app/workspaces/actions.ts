'use server';

import { redirect } from 'next/navigation';
import { friendlyDbError } from '@/lib/errors';
import type { FormState } from '@/lib/form-state';
import { requireUser } from '@/lib/session';
import { firstError, workspaceNameSchema } from '@/lib/validation';

export async function createWorkspace(_prev: FormState, form: FormData): Promise<FormState> {
  const parsed = workspaceNameSchema.safeParse(form.get('name') ?? '');
  if (!parsed.success) return { error: firstError(parsed.error) };

  const { supabase } = await requireUser();
  // The database makes the creator the owner and applies the defaults:
  // full autopilot with email, voice, SMS and WhatsApp switched on.
  const { data, error } = await supabase.from('workspaces').insert({ name: parsed.data }).select('id').single();
  if (error || !data) return { error: friendlyDbError(error, 'We could not create the workspace. Please try again.') };
  redirect(`/w/${data.id}`);
}
