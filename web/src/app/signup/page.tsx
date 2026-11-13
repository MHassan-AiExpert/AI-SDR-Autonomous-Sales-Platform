import type { Metadata } from 'next';
import { BrandMark } from '@/components/brand-mark';
import { hostBrand } from '@/lib/brand';
import Link from 'next/link';
import { ActionForm, SubmitButton } from '@/components/action-form';
import { signUp } from '../auth/actions';

export const metadata: Metadata = { title: 'Create account' };

export default async function SignupPage() {
  const brand = await hostBrand();
  return (
    <main className="auth">
      <BrandMark brand={brand} as="p" />
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
