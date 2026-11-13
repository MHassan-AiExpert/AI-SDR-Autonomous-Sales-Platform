import Link from 'next/link';
import { BrandMark } from '@/components/brand-mark';
import { hostBrand } from '@/lib/brand';

export default async function NotFound() {
  const brand = await hostBrand();
  return (
    <main className="auth">
      <BrandMark brand={brand} as="p" />
      <h1>Page not found</h1>
      <p className="muted">This page does not exist, or you do not have access to it.</p>
      <Link className="btn btn-primary" href="/workspaces">Go to your workspaces</Link>
    </main>
  );
}
