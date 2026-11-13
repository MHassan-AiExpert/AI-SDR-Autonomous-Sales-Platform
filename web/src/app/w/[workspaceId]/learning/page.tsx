import type { Metadata } from 'next';
import { ActionForm, SubmitButton } from '@/components/action-form';
import { canManageSettings } from '@/lib/roles';
import { requireWorkspace } from '@/lib/session';
import { KIND_LABELS, SUGGESTION_STATUS_LABELS, confidenceLabel, pct, readFindings } from '@/lib/learning';
import { decideLesson, runLearningNow, setLearningAutoApply } from '../actions';

export const metadata: Metadata = { title: 'Learning' };

type Suggestion = { id: string; campaign_id: string; kind: string; text: string; evidence: string; status: string; created_at: string };

export default async function LearningPage({ params }: { params: Promise<{ workspaceId: string }> }) {
  const { workspaceId } = await params;
  const { supabase, workspace } = await requireWorkspace(workspaceId);
  const manage = canManageSettings(workspace.role);
  const [{ data: campaigns }, { data: reports }, { data: suggestions }] = await Promise.all([
    supabase.from('campaigns').select('id, name, status, score_threshold, learned_guidance, learning_auto_apply').eq('workspace_id', workspace.id).neq('status', 'archived').order('created_at'),
    supabase.from('learning_reports').select('id, campaign_id, summary, findings, stats, created_at').eq('workspace_id', workspace.id).order('created_at', { ascending: false }).limit(50),
    supabase.from('learning_suggestions').select('id, campaign_id, kind, text, evidence, status, created_at').eq('workspace_id', workspace.id).in('status', ['proposed', 'applied']).order('created_at', { ascending: false }),
  ]);
  const latest = new Map<string, NonNullable<typeof reports>[number]>();
  for (const r of reports ?? []) if (!latest.has(r.campaign_id)) latest.set(r.campaign_id, r);
  const hidden = (campaignId: string) => <><input type="hidden" name="workspace_id" value={workspace.id} /><input type="hidden" name="campaign_id" value={campaignId} /></>;

  return (
    <>
      <h1>Learning</h1>
      <p className="muted">Every week the learning agent compares how leads responded over the last 90 days: subject line style and length, first email length, lead source, lead score, website audits, text follow-ups and AI calls. Only differences backed by at least 30 leads on each side, and unlikely to be chance, are reported. Better copy patterns become lessons the copywriter follows; a weak lowest score band suggests a higher threshold. You decide what is applied.</p>
      {!(campaigns ?? []).length ? <section className="card"><p className="muted">No campaigns yet.</p></section> : null}
      {(campaigns ?? []).map((c) => {
        const r = latest.get(c.id);
        const fs = readFindings(r?.findings);
        const stats = (r?.stats ?? {}) as Record<string, unknown>;
        const mine = (suggestions ?? []).filter((s) => s.campaign_id === c.id) as Suggestion[];
        const waiting = mine.filter((s) => s.status === 'proposed');
        const inUse = mine.filter((s) => s.status === 'applied' && s.kind === 'copy_guidance');
        return (
          <section key={c.id} className="card stack" aria-labelledby={`l-${c.id}`}>
            <div className="spread">
              <h2 id={`l-${c.id}`}>{c.name}</h2>
              {r ? <span className="muted">Last run {new Date(r.created_at).toUTCString().slice(5, 22)} UTC</span> : <span className="muted">Not run yet</span>}
            </div>
            {r ? (
              <>
                <p>{r.summary}</p>
                <dl className="stats">
                  <div><dt>Leads emailed</dt><dd>{String(stats.leads_emailed ?? 0)}</dd></div>
                  <div><dt>Replied</dt><dd>{pct(stats.reply_rate)}</dd></div>
                  <div><dt>Interested or booked</dt><dd>{pct(stats.interest_rate)}</dd></div>
                  <div><dt>Meetings</dt><dd>{String(stats.meetings ?? 0)}</dd></div>
                </dl>
                {fs.length ? (
                  <>
                    <h3>What the results show</h3>
                    <ul className="list">{fs.map((f) => <li key={f.id}><span className={f.direction === 'better' ? 'badge badge-ok' : 'badge badge-warn'}>{f.direction === 'better' ? 'Works better' : 'Works worse'}</span> {f.text} <span className="muted">({confidenceLabel(f.p)})</span></li>)}</ul>
                  </>
                ) : null}
              </>
            ) : null}
            {waiting.length ? (
              <>
                <h3>Waiting for you</h3>
                <ul className="list">
                  {waiting.map((s) => (
                    <li key={s.id} className="stack">
                      <p><strong>{KIND_LABELS[s.kind] ?? s.kind}:</strong> {s.text}</p>
                      <p className="muted">Why: {s.evidence}</p>
                      {manage ? (
                        <div className="row">
                          {(['apply', 'dismiss'] as const).map((d) => (
                            <ActionForm key={d} action={decideLesson}>{hidden(c.id)}<input type="hidden" name="suggestion_id" value={s.id} /><input type="hidden" name="decision" value={d} />
                              <SubmitButton variant={d === 'apply' ? 'primary' : 'secondary'}>{d === 'apply' ? 'Apply' : 'Dismiss'}</SubmitButton></ActionForm>
                          ))}
                        </div>
                      ) : <p className="muted">{SUGGESTION_STATUS_LABELS.proposed}</p>}
                    </li>
                  ))}
                </ul>
              </>
            ) : null}
            <h3>Lessons the copywriter follows</h3>
            {!inUse.length ? <p className="muted">None yet. Score threshold: {c.score_threshold}.</p> : (
              <ul className="list">
                {inUse.map((s) => (
                  <li key={s.id} className="spread">
                    <span>{s.text}</span>
                    {manage ? <ActionForm action={decideLesson}>{hidden(c.id)}<input type="hidden" name="suggestion_id" value={s.id} /><input type="hidden" name="decision" value="remove" /><SubmitButton variant="ghost">Remove</SubmitButton></ActionForm> : null}
                  </li>
                ))}
              </ul>
            )}
            {manage ? (
              <div className="row">
                <ActionForm action={setLearningAutoApply}>{hidden(c.id)}<input type="hidden" name="enabled" value={c.learning_auto_apply ? 'false' : 'true'} />
                  <SubmitButton variant="secondary">{c.learning_auto_apply ? 'Stop applying lessons automatically' : 'Apply new lessons automatically'}</SubmitButton></ActionForm>
                <ActionForm action={runLearningNow}>{hidden(c.id)}<SubmitButton variant="ghost">Learn from results now</SubmitButton></ActionForm>
              </div>
            ) : null}
          </section>
        );
      })}
    </>
  );
}
