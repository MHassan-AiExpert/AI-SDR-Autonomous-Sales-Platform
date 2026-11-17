'use server';

import { revalidatePath } from 'next/cache';
import { friendlyDbError } from '@/lib/errors';
import type { FormState } from '@/lib/form-state';
import { requireUser } from '@/lib/session';
import { firstError, uuidSchema } from '@/lib/validation';
import { hostsSchema } from '@/lib/visitors';

const NO_PERMISSION = 'Only owners and admins can change visitor tracking.';

export async function saveVisitorSettings(_prev: FormState, form: FormData): Promise<FormState> {
  const ws = uuidSchema.safeParse(form.get('workspace_id'));
  if (!ws.success) return { error: 'Workspace not found.' };
  const hosts = hostsSchema.safeParse(String(form.get('hosts') ?? ''));
  if (!hosts.success) return { error: firstError(hosts.error) };
  const enabled = form.get('enabled') === 'on';
  if (enabled && !hosts.data.length) return { error: 'List the website the script runs on before switching tracking on.' };
  const { supabase } = await requireUser();
  const { data, error } = await supabase.from('workspaces')
    .update({ visitor_tracking_enabled: enabled, visitor_allowed_hosts: hosts.data }).eq('id', ws.data).select('id');
  if (error) return { error: friendlyDbError(error) };
  if (!data?.length) return { error: NO_PERMISSION };
  revalidatePath(`/w/${ws.data}/visitors`);
  return { notice: enabled ? `Tracking is on for ${hosts.data.join(', ')}. Visiting companies appear here within a few minutes of a visit.` : 'Tracking is off. Page views are not recorded.' };
}

export async function rotateSiteKey(_prev: FormState, form: FormData): Promise<FormState> {
  const ws = uuidSchema.safeParse(form.get('workspace_id'));
  if (!ws.success) return { error: 'Workspace not found.' };
  const { supabase } = await requireUser();
  const { error } = await supabase.rpc('workspace_rotate_site_key', { ws: ws.data });
  if (error) return { error: error.code === '42501' ? NO_PERMISSION : friendlyDbError(error) };
  revalidatePath(`/w/${ws.data}/visitors`);
  return { notice: 'Site key replaced. Update the script on your website; the old one no longer records visits.' };
}
