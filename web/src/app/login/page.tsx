import type { Metadata } from 'next';
import Link from 'next/link';
import { ActionForm, SubmitButton } from '@/components/action-form';
import { safeNextPath } from '@/lib/validation';
import { signIn } from '../auth/actions';

export const metadata: Metadata = { title: 'Sign in' };

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ next?: string; status?: string }> }) {
  const { next, status } = await searchParams;
  return (
    <main className="auth">
      <p className="brand">AI SDR Platform</p>
      <h1>Sign in</h1>
      {status === 'link-invalid' ? (
        <p className="form-message form-error" role="alert">That link is invalid or has expired. Sign in or request a new one.</p>
      ) : null}
      <ActionForm action={signIn} className="card stack">
        <input type="hidden" name="next" value={safeNextPath(next)} />
        <label className="field">
          <span>Email</span>
          <input name="email" type="email" autoComplete="email" required />
        </label>
        <label className="field">
          <span>Password</span>
          <input name="password" type="password" autoComplete="current-password" required />
        </label>
        <SubmitButton>Sign in</SubmitButton>
      </ActionForm>
      <p className="muted">New here? <Link href="/signup">Create an account</Link></p>
    </main>
  );
}
