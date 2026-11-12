import type { Metadata } from 'next';
import Link from 'next/link';
import { ActionForm, SubmitButton } from '@/components/action-form';
import { signUp } from '../auth/actions';

export const metadata: Metadata = { title: 'Create account' };

export default function SignupPage() {
  return (
    <main className="auth">
      <p className="brand">AI SDR Platform</p>
      <h1>Create your account</h1>
      <ActionForm action={signUp} className="card stack">
        <label className="field">
          <span>Work email</span>
          <input name="email" type="email" autoComplete="email" required />
        </label>
        <label className="field">
          <span>Password</span>
          <input name="password" type="password" autoComplete="new-password" required minLength={10} aria-describedby="password-hint" />
          <small id="password-hint">At least 10 characters, with a letter and a number.</small>
        </label>
        <SubmitButton>Create account</SubmitButton>
      </ActionForm>
      <p className="muted">Already have an account? <Link href="/login">Sign in</Link></p>
    </main>
  );
}
