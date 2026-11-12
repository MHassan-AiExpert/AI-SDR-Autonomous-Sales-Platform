'use server';

import { revalidatePath } from 'next/cache';
import { testConnection } from '@/lib/connection-tests';
import { friendlyDbError } from '@/lib/errors';
import type { FormState } from '@/lib/form-state';
import { CHECKLIST_IDS, TOOLS, isToolId, parseCredentials } from '@/lib/integrations';
import { requireUser } from '@/lib/session';
import { uuidSchema } from '@/lib/validation';

const NO_PERMISSION = 'Only owners and admins can change the setup.';

function workspaceIdFrom(form: FormData): string | null {
  const parsed = uuidSchema.safeParse(form.get('workspace_id'));
  return parsed.success ? parsed.data : null;
}

/**
 * Tests the credentials against the tool and saves them only if the test
 * passes. The secret goes straight to the encrypted vault through the
 * database function, which also re-checks that the caller is an owner or admin.
 */
export async function connectTool(_prev: FormState, form: FormData): Promise<FormState> {
  const workspaceId = workspaceIdFrom(form);
  const toolId = form.get('tool');
  if (!workspaceId || !isToolId(toolId)) return { error: 'Unknown tool.' };
  const tool = TOOLS[toolId];

  const parsed = parseCredentials(tool, form);
  if (!parsed.ok) return { error: parsed.error };

  const { supabase, user } = await requireUser();
  const { data: member } = await supabase
    .from('workspace_members')
    .select('role')
    .eq('workspace_id', workspaceId)
    .eq('user_id', user.id)
    .maybeSingle();
  // Check the role before calling the tool, so nobody can use this form to
  // probe keys against third-party services.
  if (!member || !['owner', 'admin'].includes(member.role)) return { error: NO_PERMISSION };

  const result = await testConnection(toolId, parsed.value.secret);
  if (!result.ok) return { error: result.error };

  const { error } = await supabase.rpc('integration_connect', {
    ws: workspaceId,
    tool_id: toolId,
    secret: parsed.value.secret,
    tool_meta: { ...parsed.value.meta, ...(result.detail ?? {}) },
    check_status: 'connected',
    check_error: null,
    credits: result.credits ?? null,
  });
  if (error) return { error: friendlyDbError(error, `We could not save the ${tool.name} connection. Please try again.`) };

  revalidatePath(`/w/${workspaceId}`, 'layout');
  return { notice: `${tool.name} is connected.` };
}

export async function disconnectTool(_prev: FormState, form: FormData): Promise<FormState> {
  const workspaceId = workspaceIdFrom(form);
  const toolId = form.get('tool');
  if (!workspaceId || !isToolId(toolId)) return { error: 'Unknown tool.' };

  const { supabase } = await requireUser();
  const { error } = await supabase.rpc('integration_disconnect', { ws: workspaceId, tool_id: toolId });
  if (error) return { error: friendlyDbError(error, NO_PERMISSION) };

  revalidatePath(`/w/${workspaceId}`, 'layout');
  return { notice: `${TOOLS[toolId].name} was disconnected and its credentials deleted.` };
}

export async function updateChecklist(_prev: FormState, form: FormData): Promise<FormState> {
  const workspaceId = workspaceIdFrom(form);
  if (!workspaceId) return { error: 'Workspace not found.' };
  const checklist = Object.fromEntries(CHECKLIST_IDS.map((id) => [id, form.get(`check_${id}`) === 'on']));

  const { supabase } = await requireUser();
  const { data, error } = await supabase
    .from('workspaces')
    .update({ setup_checklist: checklist })
    .eq('id', workspaceId)
    .select('id');
  if (error) return { error: friendlyDbError(error) };
  if (!data?.length) return { error: NO_PERMISSION };

  revalidatePath(`/w/${workspaceId}`, 'layout');
  return { notice: 'Checklist saved.' };
}
