import type { Metadata } from 'next';
import Link from 'next/link';
import { ActionForm, SubmitButton } from '@/components/action-form';
import { requireWorkspace } from '@/lib/session';
import { ANSWER_LABELS, NEEDS_ANSWER, REPLY_CLASSES, REPLY_LABELS, parseInboxFilter, replyBadge, safeConversationUrl, type ReplyClass } from '@/lib/replies';
import { markReplyHandled, saveAnswer } from '../actions';

export const metadata: Metadata = { title: 'Inbox' };

type Row = {
  id: string; lead_id: string; body: string; subject: string | null; classification: ReplyClass | null; confidence: number | null;
  summary: string | null; suggested_response: string | null; conversation_url: string | null; channel: string; handled_at: string | null; created_at: string;
  answer: string | null; answer_status: string; answer_error: string | null; booking_url: string | null;
  leads: { full_name: string | null; email: string | null; stage: string; companies: { name: string } | null } | null;
};

export default async function InboxPage({ params, searchParams }: { params: Promise<{ workspaceId: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { workspaceId } = await params;
  const { supabase, workspace } = await requireWorkspace(workspaceId);
  const f = parseInboxFilter(await searchParams);
  const base = `/w/${workspace.id}/inbox`;
  const canAct = workspace.role !== 'viewer';

  let q = supabase.from('replies')
    .select('id, lead_id, channel, body, subject, classification, confidence, summary, suggested_response, conversation_url, handled_at, created_at, answer, answer_status, answer_error, booking_url, leads(full_name, email, stage, companies(name))')
    .eq('workspace_id', workspace.id);
  if (f.view === 'open') q = q.is('handled_at', null);
  if (f.view === 'handled') q = q.not('handled_at', 'is', null);
  if (f.kind === 'needs_answer') q = q.in('classification', NEEDS_ANSWER);
  else if (f.kind) q = q.eq('classification', f.kind);
  const { data } = await q.order('created_at', { ascending: false }).limit(100);
  const rows = (data ?? []) as unknown as Row[];
  const link = (over: Partial<typeof f>) => {
    const m = { ...f, ...over };
    const s = new URLSearchParams();
    if (m.view !== 'open') s.set('view', m.view);
    if (m.kind) s.set('kind', m.kind);
    return `${base}${s.toString() ? `?${s}` : ''}`;
  };

  return (
    <>
      <h1>Inbox</h1>
      <p className="muted">Email and text replies to your outreach, read and sorted by the AI reply agent. Opt-outs are suppressed automatically. Approve an answer to send it in the same email thread, SMS or WhatsApp chat.</p>
      <nav className="chips" aria-label="View">
        {(['open', 'handled', 'all'] as const).map((v) => <Link key={v} className={f.view === v ? 'chip chip-on' : 'chip'} href={link({ view: v })}>{v === 'open' ? 'To handle' : v === 'handled' ? 'Handled' : 'All'}</Link>)}
      </nav>
      <nav className="chips" aria-label="Type">
        <Link className={!f.kind ? 'chip chip-on' : 'chip'} href={link({ kind: null })}>Every type</Link>
        <Link className={f.kind === 'needs_answer' ? 'chip chip-on' : 'chip'} href={link({ kind: 'needs_answer' })}>Needs an answer</Link>
        {REPLY_CLASSES.map((c) => <Link key={c} className={f.kind === c ? 'chip chip-on' : 'chip'} href={link({ kind: c })}>{REPLY_LABELS[c]}</Link>)}
      </nav>

      {!rows.length ? <section className="card"><p className="muted">No replies here.</p></section> : rows.map((r) => {
        const url = safeConversationUrl(r.conversation_url);
        return (
          <article key={r.id} className="card stack">
            <div className="spread">
              <h2><Link href={`/w/${workspace.id}/leads/${r.lead_id}`}>{r.leads?.full_name ?? r.leads?.email ?? 'Lead'}</Link>{r.leads?.companies?.name ? <span className="muted"> · {r.leads.companies.name}</span> : null}<span className="muted"> · {r.channel === 'sms' ? 'SMS' : r.channel === 'whatsapp' ? 'WhatsApp' : 'Email'}</span></h2>
              <span className={`badge badge-${replyBadge(r.classification)}`}>{r.classification ? REPLY_LABELS[r.classification] : 'Unread'}{r.confidence !== null ? ` · ${Math.round(Number(r.confidence) * 100)}%` : ''}</span>
            </div>
            {r.summary ? <p><strong>{r.summary}</strong></p> : null}
            <blockquote className="pre">{r.body}</blockquote>
            {r.answer_status !== 'none' || r.suggested_response ? (
              <div className="stack">
                <div className="spread">
                  <strong>Answer</strong>
                  <span className={r.answer_status === 'sent' ? 'badge badge-ok' : r.answer_status === 'failed' ? 'badge badge-error' : 'badge badge-warn'}>{ANSWER_LABELS[r.answer_status] ?? r.answer_status}</span>
                </div>
                {r.answer_status === 'failed' && r.answer_error ? <p className="form-message form-error">{r.answer_error}</p> : null}
                {canAct && ['none', 'draft', 'failed', 'approved'].includes(r.answer_status) ? (
                  <ActionForm action={saveAnswer} className="stack">
                    <input type="hidden" name="workspace_id" value={workspace.id} />
                    <input type="hidden" name="reply_id" value={r.id} />
                    <label className="field"><span className="sr-only">Answer</span><textarea name="answer" rows={6} maxLength={3000} defaultValue={r.answer ?? r.suggested_response ?? ''} /></label>
                    <div className="row">
                      <button className="btn btn-primary" type="submit" name="decision" value="send">Approve and send</button>
                      <button className="btn btn-secondary" type="submit" name="decision" value="save">Save draft</button>
                    </div>
                  </ActionForm>
                ) : <p className="pre">{r.answer ?? r.suggested_response}</p>}
              </div>
            ) : null}
            <div className="row">
              {url ? <a className="btn btn-secondary" href={url} target="_blank" rel="noopener noreferrer">Answer in Instantly</a> : null}
              {canAct ? (
                <ActionForm action={markReplyHandled}>
                  <input type="hidden" name="workspace_id" value={workspace.id} />
                  <input type="hidden" name="reply_id" value={r.id} />
                  <input type="hidden" name="reopen" value={r.handled_at ? 'true' : 'false'} />
                  <SubmitButton variant="ghost">{r.handled_at ? 'Move back to inbox' : 'Mark as handled'}</SubmitButton>
                </ActionForm>
              ) : null}
              <time className="muted" dateTime={r.created_at}>{new Date(r.created_at).toUTCString()}</time>
            </div>
          </article>
        );
      })}
    </>
  );
}
