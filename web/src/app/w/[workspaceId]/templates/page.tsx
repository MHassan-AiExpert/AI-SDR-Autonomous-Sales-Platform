import type { Metadata } from 'next';
import Link from 'next/link';
import { ActionForm, SubmitButton } from '@/components/action-form';
import { requireWorkspace } from '@/lib/session';
import { canManageSettings } from '@/lib/roles';
import {
  KIND_LABELS, bodyOf, describeSequenceTemplate, describeTemplateSteps, scopeOf, stepsOf, type TemplateRow,
} from '@/lib/templates';
import { applySequenceTemplate, deleteTemplate, saveSnippet } from './actions';

export const metadata: Metadata = { title: 'Templates' };

export default async function TemplatesPage({ params }: { params: Promise<{ workspaceId: string }> }) {
  const { workspaceId } = await params;
  const { supabase, workspace } = await requireWorkspace(workspaceId);
  const manage = canManageSettings(workspace.role);
  const base = `/w/${workspace.id}`;

  const [{ data: rows }, { data: campaigns }] = await Promise.all([
    supabase.from('templates')
      .select('id, workspace_id, agency_id, kind, name, description, payload, is_default, updated_at')
      .order('kind').order('name'),
    supabase.from('campaigns')
      .select('id, name, status').eq('workspace_id', workspace.id).order('name'),
  ]);

  const templates = (rows ?? []) as unknown as TemplateRow[];
  const sequences = templates.filter((t) => t.kind === 'sequence');
  const snippets = templates.filter((t) => t.kind === 'snippet');
  const ours = (t: TemplateRow) => t.workspace_id === workspace.id;

  return (
    <main className="stack-lg">
      <h1>Templates</h1>
      <p>
        A sequence worth keeping can be saved here and applied to another campaign. Snippets are blocks of copy the
        writer draws on when it drafts emails. Templates marked as coming from your agency were inherited when this
        workspace was created, and a copy is yours to change.
      </p>

      {/* ---------------------------------------------------------------- sequences */}
      <section className="stack-lg">
        <h2>Sequences</h2>
        {sequences.length === 0 && (
          <p>
            None yet. Build a sequence on a campaign, then save it from the{' '}
            <Link href={`${base}/campaigns`}>campaign&apos;s sequence screen</Link>.
          </p>
        )}
        {sequences.map((t) => (
          <article key={t.id} className="card stack">
            <h3>
              {t.name}
              {scopeOf(t) === 'agency' && <> <span className="badge">from your agency</span></>}
            </h3>
            {t.description && <p>{t.description}</p>}
            <p className="muted">{describeSequenceTemplate(t)}</p>

            {stepsOf(t).length > 0 && (
              <details>
                <summary>What it does, step by step</summary>
                <ul className="list">
                  {describeTemplateSteps(t).map((line) => <li key={line}>{line}</li>)}
                </ul>
              </details>
            )}

            {manage && (campaigns ?? []).length > 0 && (
              <details>
                <summary>Apply to a campaign</summary>
                <ActionForm action={applySequenceTemplate} className="stack">
                  <input type="hidden" name="workspace_id" value={workspace.id} />
                  <input type="hidden" name="template_id" value={t.id} />
                  <label className="field">
                    <span>Campaign</span>
                    <select name="campaign_id" defaultValue="">
                      <option value="" disabled>Choose a campaign</option>
                      {(campaigns ?? []).map((c) => (
                        <option key={c.id} value={c.id}>{c.name}</option>
                      ))}
                    </select>
                  </label>
                  <p className="muted">
                    This replaces whatever sequence that campaign has now. If it has already sent steps, the record of
                    what was sent goes with them, so that case is refused unless you tick the box.
                  </p>
                  <label className="choice">
                    <input type="checkbox" name="replace_sent" />
                    <span>Replace even if the campaign has already sent sequence steps</span>
                  </label>
                  <SubmitButton variant="secondary">Apply template</SubmitButton>
                </ActionForm>
              </details>
            )}

            {manage && ours(t) && (
              <ActionForm action={deleteTemplate}>
                <input type="hidden" name="workspace_id" value={workspace.id} />
                <input type="hidden" name="template_id" value={t.id} />
                <SubmitButton variant="ghost">Remove &ldquo;{t.name}&rdquo;</SubmitButton>
              </ActionForm>
            )}
          </article>
        ))}
      </section>

      {/* ---------------------------------------------------------------- snippets */}
      <section className="stack-lg">
        <h2>Snippets</h2>
        <p>
          The copywriter is given these alongside the playbook and uses one where it fits. They never replace the
          personal first line, and the writer is told to treat them as copy rather than as instructions.
        </p>
        {snippets.length === 0 && <p>No snippets yet.</p>}
        {snippets.map((t) => (
          <article key={t.id} className="card stack">
            <h3>
              {t.name}
              {scopeOf(t) === 'agency' && <> <span className="badge">from your agency</span></>}
            </h3>
            {t.description && <p className="muted">{t.description}</p>}
            <p className="pre">{bodyOf(t)}</p>
            {manage && ours(t) && (
              <>
                <details>
                  <summary>Edit this snippet</summary>
                  <ActionForm action={saveSnippet} className="stack">
                    <input type="hidden" name="workspace_id" value={workspace.id} />
                    <input type="hidden" name="template_id" value={t.id} />
                    <label className="field">
                      <span>Name</span>
                      <input type="text" name="name" maxLength={120} required defaultValue={t.name} />
                    </label>
                    <label className="field">
                      <span>When to use it (optional)</span>
                      <input type="text" name="description" maxLength={500} defaultValue={t.description ?? ''} />
                    </label>
                    <label className="field">
                      <span>The copy</span>
                      <textarea name="body" rows={4} maxLength={2000} required defaultValue={bodyOf(t)} />
                    </label>
                    <SubmitButton variant="secondary">Save snippet</SubmitButton>
                  </ActionForm>
                </details>
                <ActionForm action={deleteTemplate}>
                  <input type="hidden" name="workspace_id" value={workspace.id} />
                  <input type="hidden" name="template_id" value={t.id} />
                  <SubmitButton variant="ghost">Remove &ldquo;{t.name}&rdquo;</SubmitButton>
                </ActionForm>
              </>
            )}
          </article>
        ))}

        {manage && (
          <section className="card stack">
            <h3>Add a snippet</h3>
            <ActionForm action={saveSnippet} className="stack">
              <input type="hidden" name="workspace_id" value={workspace.id} />
              <label className="field">
                <span>Name</span>
                <input type="text" name="name" maxLength={120} required placeholder="Case study line" />
              </label>
              <label className="field">
                <span>When to use it (optional)</span>
                <input type="text" name="description" maxLength={500} placeholder="For practices worried it will not work for them" />
              </label>
              <label className="field">
                <span>The copy</span>
                <textarea name="body" rows={4} maxLength={2000} required placeholder="We took a practice in Austin from 12 to 40 bookings a month in nine weeks." />
              </label>
              <SubmitButton>Add snippet</SubmitButton>
            </ActionForm>
          </section>
        )}
      </section>

      <section className="card stack">
        <h2>Objection answers</h2>
        <p>
          These are not kept here. They live in the{' '}
          <Link href={`${base}/playbook`}>playbook</Link>, where the team already writes them, and both the AI closer
          and the reply agent now draw on them when a prospect pushes back on price, timing, need or trust.
        </p>
      </section>

      {!manage && (
        <p className="muted">Only owners and admins can change the library. You can read it and see what each template does.</p>
      )}
    </main>
  );
}
