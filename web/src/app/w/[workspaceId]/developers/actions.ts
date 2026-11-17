'use server';

import { revalidatePath } from 'next/cache';
import { friendlyDbError } from '@/lib/errors';
import type { FormState } from '@/lib/form-state';
import { requireUser } from '@/lib/session';
import { firstError, uuidSchema } from '@/lib/validation';
import { EVENTS, SCOPES, endpointSchema, keySchema } from '@/lib/api';

const NO_PERMISSION = 'Only owners and admins can manage API keys and webhooks.';
type DbError = { code?: string; message?: string } | null;
// Messages written for people in the database functions are shown as they are
const dbMessage = (e: DbError) => (e?.code === '22023' && e.message ? e.message : e?.code === '42501' ? NO_PERMISSION : friendlyDbError(e));
const ids = (form: FormData, field: string) => {
  const ws = uuidSchema.safeParse(form.get('workspace_id'));
  const id = uuidSchema.safeParse(form.get(field));
  return ws.success && id.success ? { ws: ws.data, id: id.data } : null;
};
const done = (ws: string) => revalidatePath(`/w/${ws}/developers`);

export async function createApiKey(_prev: FormState, form: FormData): Promise<FormState> {
  const ws = uuidSchema.safeParse(form.get('workspace_id'));
  if (!ws.success) return { error: 'Workspace not found.' };
  const parsed = keySchema.safeParse({ name: form.get('name') ?? '', scopes: SCOPES.filter((s) => form.get(`scope_${s}`) === 'on') });
  if (!parsed.success) return { error: firstError(parsed.error) };
  const { supabase } = await requireUser();
  const { data, error } = await supabase.rpc('api_key_create', { ws: ws.data, p_name: parsed.data.name, p_scopes: parsed.data.scopes });
  if (error) return { error: dbMessage(error) };
  done(ws.data);
  const key = (data as { key?: string } | null)?.key;
  return { notice: `Key created. Copy it now; it is not shown again: ${key}` };
}

export async function revokeApiKey(_prev: FormState, form: FormData): Promise<FormState> {
  const p = ids(form, 'key_id');
  if (!p) return { error: 'API key not found.' };
  const { supabase } = await requireUser();
  const { error } = await supabase.rpc('api_key_revoke', { p_id: p.id });
  if (error) return { error: error.code === 'P0002' ? 'API key not found.' : dbMessage(error) };
  done(p.ws);
  return { notice: 'Key revoked. Requests using it are refused from now on.' };
}

export async function addEndpoint(_prev: FormState, form: FormData): Promise<FormState> {
  const ws = uuidSchema.safeParse(form.get('workspace_id'));
  if (!ws.success) return { error: 'Workspace not found.' };
  const parsed = endpointSchema.safeParse({
    url: form.get('url') ?? '', description: form.get('description') ?? '', events: EVENTS.filter((e) => form.get(`event_${e}`) === 'on'),
  });
  if (!parsed.success) return { error: firstError(parsed.error) };
  const { supabase } = await requireUser();
  const { error } = await supabase.from('webhook_endpoints').insert({ workspace_id: ws.data, ...parsed.data });
  if (error) return { error: error.code === '42501' ? NO_PERMISSION : dbMessage(error) };
  done(ws.data);
  return { notice: 'Endpoint added. Use "Show signing secret" to verify deliveries, and "Send a test event" to try it.' };
}

export async function setEndpointActive(_prev: FormState, form: FormData): Promise<FormState> {
  const p = ids(form, 'endpoint_id');
  if (!p) return { error: 'Endpoint not found.' };
  const active = form.get('active') === 'true';
  const { supabase } = await requireUser();
  const { data, error } = await supabase.from('webhook_endpoints').update({ active }).eq('workspace_id', p.ws).eq('id', p.id).select('id');
  if (error) return { error: dbMessage(error) };
  if (!data?.length) return { error: NO_PERMISSION };
  done(p.ws);
  return { notice: active ? 'Endpoint switched on. New events are sent to it.' : 'Endpoint switched off. Events are not queued for it.' };
}

export async function deleteEndpoint(_prev: FormState, form: FormData): Promise<FormState> {
  const p = ids(form, 'endpoint_id');
  if (!p) return { error: 'Endpoint not found.' };
  const { supabase } = await requireUser();
  const { data, error } = await supabase.from('webhook_endpoints').delete().eq('workspace_id', p.ws).eq('id', p.id).select('id');
  if (error) return { error: dbMessage(error) };
  if (!data?.length) return { error: NO_PERMISSION };
  done(p.ws);
  return { notice: 'Endpoint deleted, with its delivery history.' };
}

export async function endpointSecret(_prev: FormState, form: FormData): Promise<FormState> {
  const p = ids(form, 'endpoint_id');
  if (!p) return { error: 'Endpoint not found.' };
  const rotate = form.get('rotate') === 'true';
  const { supabase } = await requireUser();
  const { data, error } = await supabase.rpc('webhook_endpoint_secret', { p_id: p.id, p_rotate: rotate });
  if (error) return { error: error.code === 'P0002' ? NO_PERMISSION : dbMessage(error) };
  return { notice: `${rotate ? 'New signing secret (the old one stops working now)' : 'Signing secret'}: ${String(data)}` };
}

export async function sendTestEvent(_prev: FormState, form: FormData): Promise<FormState> {
  const p = ids(form, 'endpoint_id');
  if (!p) return { error: 'Endpoint not found.' };
  const { supabase } = await requireUser();
  const { error } = await supabase.rpc('webhook_send_test', { p_id: p.id });
  if (error) return { error: error.code === 'P0002' ? NO_PERMISSION : dbMessage(error) };
  done(p.ws);
  return { notice: 'A test event is queued and is sent within a minute. Its result appears under Recent deliveries.' };
}
