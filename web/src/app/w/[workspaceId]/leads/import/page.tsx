import type { Metadata } from 'next';
import Link from 'next/link';
import { ActionForm, SubmitButton } from '@/components/action-form';
import { requireWorkspace } from '@/lib/session';
import { describeImport } from '@/lib/csv';
import { undoImport } from '../../actions';
import { ImportForm } from './import-form';

export const metadata: Metadata = { title: 'Import leads' };

export default async function ImportLeadsPage({ params }: { params: Promise<{ workspaceId: string }> }) {
  const { workspaceId } = await params;
  const { supabase, workspace } = await requireWorkspace(workspaceId);
  const manage = workspace.role !== 'viewer';
  const [{ data: campaigns }, { data: imports }] = await Promise.all([
    supabase.from('campaigns').select('id, name').eq('workspace_id', workspace.id).order('created_at', { ascending: false }).limit(50),
    supabase.from('lead_imports').select('id, filename, total_rows, added, duplicates, suppressed, invalid, undone_at, created_at')
      .eq('workspace_id', workspace.id).order('created_at', { ascending: false }).limit(10),
  ]);

  return (
    <>
      <div className="spread">
        <h1>Import leads</h1>
        <Link href={`/w/${workspace.id}/leads`}>Back to leads</Link>
      </div>
      <p className="muted">
        Upload a CSV and match its columns. Every row goes through the same checks as a lead the agents find: the contact is
        normalized, anyone on your suppression list is left out, and leads already here are skipped.
      </p>

      <section className="card stack" aria-labelledby="upload">
        <h2 id="upload">Upload a file</h2>
        {manage ? <ImportForm workspaceId={workspace.id} campaigns={campaigns ?? []} /> : <p className="muted">Viewers cannot import leads.</p>}
      </section>

      {imports?.length ? (
        <section className="card stack" aria-labelledby="history">
          <h2 id="history">Recent imports</h2>
          <ul className="list">
            {(imports ?? []).map((i) => (
              <li key={i.id} className="spread">
                <span>
                  <strong>{i.filename}</strong><br />
                  <span className="muted">{new Date(i.created_at).toUTCString().slice(5, 22)} UTC · {describeImport(i)}</span>
                </span>
                <span className="row">
                  {i.undone_at ? <span className="badge">Undone</span> : null}
                  {!i.undone_at && i.added > 0 && (workspace.role === 'owner' || workspace.role === 'admin') ? (
                    <ActionForm action={undoImport}>
                      <input type="hidden" name="workspace_id" value={workspace.id} />
                      <input type="hidden" name="import_id" value={i.id} />
                      <SubmitButton variant="secondary">Undo</SubmitButton>
                    </ActionForm>
                  ) : null}
                </span>
              </li>
            ))}
          </ul>
          <p className="muted">Undoing an import removes only leads that have not been worked. Anything contacted, replied to or booked stays.</p>
        </section>
      ) : null}
    </>
  );
}
