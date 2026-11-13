import Link from 'next/link';
import { BrandMark } from '@/components/brand-mark';
import { hostBrand } from '@/lib/brand';
import { redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';

export default async function HomePage() {
  const brand = await hostBrand();
  const supabase = await createClient();
  const { data } = await supabase.auth.getUser();
  if (data.user) redirect('/workspaces');

  return (
    <main className="landing">
      <BrandMark brand={brand} as="p" />
      <h1>Your AI sales team, working every channel</h1>
      <p className="lead">
        Type your niche. AI agents find leads, research them, run email, voice, SMS and WhatsApp outreach,
        book meetings and close deals from your playbook.
      </p>
      <div className="row">
        <Link className="btn btn-primary" href="/signup">Create your account</Link>
        <Link className="btn btn-secondary" href="/login">Sign in</Link>
      </div>
    </main>
  );
}
