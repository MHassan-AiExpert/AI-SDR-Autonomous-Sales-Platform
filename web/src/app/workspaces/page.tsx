import type { Metadata } from 'next';
import Link from 'next/link';
import { ActionForm, SubmitButton } from '@/components/action-form';
import { ROLE_LABELS, isRole } from '@/lib/roles';
import { requireUser } from '@/lib/session';
import { createWorkspace } from './actions';
import { BrandMark } from '@/components/brand-mark';
import { hostBrand } from '@/lib/brand';

export const metadata: Metadata = { title: 'Workspaces' };

type Row = { role: string; workspaces: { id: string; name: string; outreach_paused: boolean; automation_mode: string } | null };

export default async function WorkspacesPage() {
  const { supabase, user } = await requireUser();
  const brand = await hostBrand();
  const { data } = await supabase
    .from('workspace_members')
    .select('role, workspaces (id, name, outreach_paused, automation_mode)')
    .eq('user_id', user.id)
    .order('created_at');
  const rows = ((data ?? []) as unknown as Row[]).filter((r) => r.workspaces);

  return (
    <div className="shell">
      <header className="topbar">
        <BrandMark brand={brand} />
        <div className="row">
          <Link href="/agency">Agencies</Link>
          <span className="muted">{user.email}</span>
          <form action="/auth/signout" method="post"><button className="btn btn-ghost" type="submit">Sign out</button></form>
        </div>
      </header>
      <main className="content stack-lg">
        <h1>Your workspaces</h1>
        {rows.length === 0 ? (
          <p className="muted">You are not in a workspace yet. Create one for your company below, or ask your admin to add you.</p>
        ) : (
          <ul className="list" aria-label="Workspaces">
            {rows.map(({ role, workspaces: ws }) => (
              <li key={ws!.id}>
                <Link href={`/w/${ws!.id}`} className="list-link">
                  <span className="list-title">{ws!.name}</span>
                  <span className="row">
                    {ws!.outreach_paused ? <span className="badge badge-warn">Outreach paused</span> : null}
                    <span className="badge">{isRole(role) ? ROLE_LABELS[role] : role}</span>
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}
        <section className="card stack" aria-labelledby="new-ws">
          <h2 id="new-ws">Create a workspace</h2>
          <p className="muted">One workspace per company. You become its owner, and it starts on full autopilot.</p>
          <ActionForm action={createWorkspace} className="stack">
            <label className="field">
              <span>Company name</span>
              <input name="name" type="text" required minLength={2} maxLength={120} autoComplete="organization" />
            </label>
            <SubmitButton>Create workspace</SubmitButton>
          </ActionForm>
        </section>
      </main>
    </div>
  );
}
