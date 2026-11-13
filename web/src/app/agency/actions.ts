'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { friendlyDbError } from '@/lib/errors';
import type { FormState } from '@/lib/form-state';
import { requireUser } from '@/lib/session';
import { firstError, uuidSchema } from '@/lib/validation';
import { agencyNameSchema, parseBrandForm, parseClientForm, parseDefaultsForm } from '@/lib/agency';

const NO_PERMISSION = 'Only agency owners and admins can do that.';

// Every change is checked again in the database: row-level security on the
// agency tables, and a role check inside each console function.

function agencyIdFrom(form: FormData): string | null {
  const p = uuidSchema.safeParse(form.get('agency_id'));
  return p.success ? p.data : null;
}

export async function createAgency(_prev: FormState, form: FormData): Promise<FormState> {
  const name = agencyNameSchema.safeParse(form.get('name') ?? '');
  if (!name.success) return { error: firstError(name.error) };
  const { supabase, user } = await requireUser();
  const { data, error } = await supabase.from('agencies').insert({ name: name.data, owner_id: user.id }).select('id').single();
  if (error || !data) return { error: friendlyDbError(error, 'We could not create the agency. Please try again.') };
  // The brand starts as the agency's name; it can be changed in the console
  await supabase.from('agency_brands').insert({ agency_id: data.id, app_name: name.data.slice(0, 60) });
  redirect(`/agency/${data.id}`);
}

export async function createClientWorkspace(_prev: FormState, form: FormData): Promise<FormState> {
  const agencyId = agencyIdFrom(form);
  if (!agencyId) return { error: 'Agency not found.' };
  const parsed = parseClientForm(form);
  if (!parsed.success) return { error: firstError(parsed.error) };
  const d = parsed.data as { name: string; plan: string; monthly_lead_limit: number | null; seat_limit: number | null };
  const { supabase } = await requireUser();
  const { data, error } = await supabase.rpc('agency_create_workspace', { ag: agencyId, ws_name: d.name, ws_plan: d.plan, lead_limit: d.monthly_lead_limit, seats: d.seat_limit });
  if (error?.code === '42501') return { error: NO_PERMISSION };
  if (error || !data) return { error: friendlyDbError(error) };
  revalidatePath(`/agency/${agencyId}`);
  return { notice: `${d.name} is ready. You are its owner: open it and invite the client from Team.` };
}

export async function setClientPlan(_prev: FormState, form: FormData): Promise<FormState> {
  const agencyId = agencyIdFrom(form);
  const ws = uuidSchema.safeParse(form.get('workspace_id'));
  if (!agencyId || !ws.success) return { error: 'Client not found.' };
  const parsed = parseClientForm(form, false);
  if (!parsed.success) return { error: firstError(parsed.error) };
  const d = parsed.data as { plan: string; monthly_lead_limit: number | null; seat_limit: number | null };
  const { supabase } = await requireUser();
  const { error } = await supabase.rpc('agency_set_plan', { ws: ws.data, ws_plan: d.plan, lead_limit: d.monthly_lead_limit, seats: d.seat_limit });
  if (error?.code === '42501') return { error: NO_PERMISSION };
  if (error) return { error: friendlyDbError(error) };
  revalidatePath(`/agency/${agencyId}`);
  return { notice: 'Plan and limits saved.' };
}

export async function saveBrand(_prev: FormState, form: FormData): Promise<FormState> {
  const agencyId = agencyIdFrom(form);
  if (!agencyId) return { error: 'Agency not found.' };
  const parsed = parseBrandForm(form);
  if (!parsed.success) return { error: firstError(parsed.error) };
  const { supabase } = await requireUser();
  const { data, error } = await supabase.from('agency_brands').upsert({ agency_id: agencyId, ...parsed.data }).select('agency_id');
  if (error?.code === '23505') return { error: 'Another agency already uses that domain.' };
  if (error?.code === '42501') return { error: NO_PERMISSION };
  if (error) return { error: friendlyDbError(error) };
  if (!data?.length) return { error: NO_PERMISSION };
  revalidatePath('/', 'layout');
  return { notice: parsed.data.custom_domain ? `Brand saved. Point ${parsed.data.custom_domain} at the app to use it.` : 'Brand saved.' };
}

export async function saveDefaults(_prev: FormState, form: FormData): Promise<FormState> {
  const agencyId = agencyIdFrom(form);
  if (!agencyId) return { error: 'Agency not found.' };
  const parsed = parseDefaultsForm(form);
  if (!parsed.success) return { error: firstError(parsed.error) };
  const { supabase } = await requireUser();
  const update: Record<string, unknown> = { campaign_defaults: parsed.data };
  // The default playbook is copied from one of the agency's client workspaces
  const source = String(form.get('playbook_from') ?? '');
  if (source === 'none') update.default_playbook = null;
  else if (source) {
    const ws = uuidSchema.safeParse(source);
    if (!ws.success) return { error: 'Choose a client workspace to copy the playbook from.' };
    const { data: pb } = await supabase.from('playbooks').select('content').eq('workspace_id', ws.data).eq('is_active', true).maybeSingle();
    if (!pb) return { error: 'That workspace has no published playbook, or you are not a member of it.' };
    update.default_playbook = pb.content;
  }
  const { data, error } = await supabase.from('agencies').update(update).eq('id', agencyId).select('id');
  if (error) return { error: friendlyDbError(error) };
  if (!data?.length) return { error: NO_PERMISSION };
  revalidatePath(`/agency/${agencyId}`);
  return { notice: 'Defaults saved. New client workspaces and campaigns start from them.' };
}

export async function addAgencyMember(_prev: FormState, form: FormData): Promise<FormState> {
  const agencyId = agencyIdFrom(form);
  if (!agencyId) return { error: 'Agency not found.' };
  const email = String(form.get('email') ?? '').trim();
  const role = form.get('role');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) return { error: 'Enter a valid email address.' };
  if (role !== 'admin' && role !== 'staff') return { error: 'Choose admin or staff.' };
  const { supabase } = await requireUser();
  const { error } = await supabase.rpc('agency_member_add', { ag: agencyId, member_email: email, member_role: role });
  if (error?.code === '42501') return { error: NO_PERMISSION };
  if (error?.code === 'P0002') return { error: 'No account uses that email yet. Ask them to sign up first.' };
  if (error) return { error: friendlyDbError(error) };
  revalidatePath(`/agency/${agencyId}`);
  return { notice: `${email} is on the agency team.` };
}

export async function removeAgencyMember(_prev: FormState, form: FormData): Promise<FormState> {
  const agencyId = agencyIdFrom(form);
  const userId = uuidSchema.safeParse(form.get('user_id'));
  if (!agencyId || !userId.success) return { error: 'Member not found.' };
  const { supabase } = await requireUser();
  const { data, error } = await supabase.from('agency_members').delete().eq('agency_id', agencyId).eq('user_id', userId.data).select('user_id');
  if (error) return { error: friendlyDbError(error) };
  if (!data?.length) return { error: NO_PERMISSION };
  revalidatePath(`/agency/${agencyId}`);
  return { notice: 'Removed from the agency team. Their roles in client workspaces stay until a workspace owner removes them.' };
}
