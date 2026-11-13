import type { Metadata } from 'next';
import Link from 'next/link';
import { ActionForm, SubmitButton } from '@/components/action-form';
import { BrandMark } from '@/components/brand-mark';
import { hostBrand } from '@/lib/brand';
import { requireUser } from '@/lib/session';
import { AGENCY_ROLE_LABELS, type AgencyRole } from '@/lib/agency';
import { createAgency } from './actions';

export const metadata: Metadata = { title: 'Agencies' };

export default async function AgenciesPage() {
  const { supabase, user } = await requireUser();
  const brand = await hostBrand();
  const [{ data: agencies }, { data: memberships }] = await Promise.all([
    supabase.from('agencies').select('id, name, owner_id').order('created_at'),
    supabase.from('agency_members').select('agency_id, role').eq('user_id', user.id),
  ]);
  const roles = new Map((memberships ?? []).map((m) => [m.agency_id, m.role as AgencyRole]));

  return (
    <div className="shell">
      <header className="topbar">
        <BrandMark brand={brand} />
        <div className="row">
          <Link href="/workspaces">Workspaces</Link>
          <span className="muted">{user.email}</span>
          <form action="/auth/signout" method="post"><button className="btn btn-ghost" type="submit">Sign out</button></form>
        </div>
      </header>
      <main className="content stack-lg">
        <h1>Agencies</h1>
        <p className="muted">Resell the platform under your own brand: create a workspace for each client, set their plan and limits, and follow their usage. Clients see only your brand.</p>
        {(agencies ?? []).length ? (
          <ul className="list" aria-label="Agencies">
            {(agencies ?? []).map((a) => {
              const role: AgencyRole = a.owner_id === user.id ? 'owner' : roles.get(a.id) ?? 'staff';
              return (
                <li key={a.id}>
                  <Link href={`/agency/${a.id}`} className="list-link">
                    <span className="list-title">{a.name}</span>
                    <span className="badge">{AGENCY_ROLE_LABELS[role]}</span>
                  </Link>
                </li>
              );
            })}
          </ul>
        ) : <p className="muted">You are not in an agency yet.</p>}
        <section className="card stack" aria-labelledby="new-agency">
          <h2 id="new-agency">Create an agency</h2>
          <ActionForm action={createAgency} className="stack">
            <label className="field">
              <span>Agency name</span>
              <input name="name" type="text" required minLength={2} maxLength={120} autoComplete="organization" />
            </label>
            <SubmitButton>Create agency</SubmitButton>
          </ActionForm>
        </section>
      </main>
    </div>
  );
}
