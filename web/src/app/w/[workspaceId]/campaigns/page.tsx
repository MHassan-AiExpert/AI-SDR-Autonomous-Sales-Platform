import type { Metadata } from 'next';
import Link from 'next/link';
import { canManageSettings } from '@/lib/roles';
import { requireWorkspace } from '@/lib/session';

export const metadata: Metadata = { title: 'Campaigns' };

const STATUS: Record<string, string> = { draft: 'Draft', active: 'Active', paused: 'Paused', archived: 'Archived' };

export default async function CampaignsPage({ params }: { params: Promise<{ workspaceId: string }> }) {
  const { workspaceId } = await params;
  const { supabase, workspace } = await requireWorkspace(workspaceId);
  const manage = canManageSettings(workspace.role);

  const { data: campaigns } = await supabase
    .from('campaigns')
    .select('id, name, niche, status, target_areas, daily_lead_limit, created_at')
    .eq('workspace_id', workspace.id)
    .order('created_at', { ascending: false })
    .limit(100);

  return (
    <>
      <div className="spread">
        <h1>Campaigns</h1>
        {manage ? <Link className="btn btn-primary" href={`/w/${workspace.id}/campaigns/new`}>New campaign</Link> : null}
      </div>
      {!campaigns?.length ? (
        <section className="card stack">
          <h2>No campaigns yet</h2>
          <p className="muted">Type the niche you sell to and where. The setup agent builds the customer profile and finds leads on Apollo, Google Maps, Instagram and LLM search.</p>
        </section>
      ) : (
        <ul className="list">
          {campaigns.map((c) => (
            <li key={c.id}>
              <Link className="list-link" href={`/w/${workspace.id}/campaigns/${c.id}`}>
                <span className="list-title">{c.name}</span>
                <span className="muted">{c.niche ?? 'No niche'} · {Array.isArray(c.target_areas) ? c.target_areas.join('; ') : ''}</span>
                <span className="badge">{STATUS[c.status] ?? c.status}</span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
