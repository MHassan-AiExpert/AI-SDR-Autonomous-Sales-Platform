'use server';

import { redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import { friendlyAuthError } from '@/lib/errors';
import type { FormState } from '@/lib/form-state';
import { firstError, safeNextPath, signInSchema, signUpSchema } from '@/lib/validation';

function siteUrl() {
  return (process.env.NEXT_PUBLIC_SITE_URL ?? 'http://localhost:3000').replace(/\/$/, '');
}

export async function signUp(_prev: FormState, form: FormData): Promise<FormState> {
  const parsed = signUpSchema.safeParse({ email: form.get('email') ?? '', password: form.get('password') ?? '' });
  if (!parsed.success) return { error: firstError(parsed.error) };

  const supabase = await createClient();
  const { data, error } = await supabase.auth.signUp({
    ...parsed.data,
    options: { emailRedirectTo: `${siteUrl()}/auth/callback` },
  });
  if (error) return { error: friendlyAuthError(error) };
  if (data.session) redirect('/workspaces');
  return { notice: 'Check your inbox and click the link to confirm your email address.' };
}

export async function signIn(_prev: FormState, form: FormData): Promise<FormState> {
  const parsed = signInSchema.safeParse({ email: form.get('email') ?? '', password: form.get('password') ?? '' });
  if (!parsed.success) return { error: firstError(parsed.error) };

  const supabase = await createClient();
  const { error } = await supabase.auth.signInWithPassword(parsed.data);
  if (error) return { error: friendlyAuthError(error) };
  redirect(safeNextPath(form.get('next')));
}
