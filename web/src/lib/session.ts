import { cache } from 'react';
import { notFound, redirect } from 'next/navigation';
import { createClient } from './supabase/server';
import { isRole, type Role } from './roles';
import { uuidSchema } from './validation';

/** The signed-in user, or a redirect to the sign-in page. */
export const requireUser = cache(async () => {
  const supabase = await createClient();
  const { data, error } = await supabase.auth.getUser();
  if (error || !data.user) redirect('/login');
  return { supabase, user: data.user };
});

export type WorkspaceContext = {
  id: string;
  name: string;
  plan: string;
  automation_mode: 'autopilot' | 'approval';
  ai_closer_enabled: boolean;
  outreach_paused: boolean;
  enabled_channels: Record<string, boolean>;
  setup_checklist: Record<string, unknown>;
  role: Role;
};

/**
 * Loads a workspace and the caller's role in it. Row-level security returns
 * nothing for workspaces the user does not belong to, which becomes a 404, so
 * the existence of other companies' workspaces is never revealed.
 */
export const requireWorkspace = cache(async (workspaceId: string) => {
  if (!uuidSchema.safeParse(workspaceId).success) notFound();
  const { supabase, user } = await requireUser();

  const [{ data: workspace }, { data: membership }] = await Promise.all([
    supabase
      .from('workspaces')
      .select('id, name, plan, automation_mode, ai_closer_enabled, outreach_paused, enabled_channels, setup_checklist')
      .eq('id', workspaceId)
      .maybeSingle(),
    supabase
      .from('workspace_members')
      .select('role')
      .eq('workspace_id', workspaceId)
      .eq('user_id', user.id)
      .maybeSingle(),
  ]);

  if (!workspace || !membership || !isRole(membership.role)) notFound();
  return { supabase, user, workspace: { ...workspace, role: membership.role } as WorkspaceContext };
});
