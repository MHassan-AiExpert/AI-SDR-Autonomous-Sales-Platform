import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import { AUDIT_TOKEN, STATUS_LABELS, readPublicAudit, scoreBand, siteLink } from '@/lib/audit';
import { ViewTracker } from './view-tracker';

export const metadata: Metadata = { title: 'Website and marketing audit', robots: { index: false, follow: false } };
export const dynamic = 'force-dynamic';

export default async function AuditPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  if (!AUDIT_TOKEN.test(token)) notFound();
  const supabase = await createClient();
  const { data } = await supabase.rpc('audit_public', { p_token: token });
  const audit = readPublicAudit(data);
  if (!audit) notFound();
  const { content } = audit;
  const band = scoreBand(audit.score);
  const site = siteLink(content.site);
  const open = content.checks.filter((c) => c.status === 'fail' || c.status === 'warn');

  return (
    <main className="audit">
      <ViewTracker token={token} />
      <header className="stack">
        <p className="muted">Prepared by {audit.from_company}{audit.sender_name ? ` · ${audit.sender_name}` : ''} · {new Date(audit.created_at).toUTCString().slice(5, 16)}</p>
        <h1>{audit.title ?? 'Website and marketing audit'}</h1>
        {audit.first_name ? <p>Hi {audit.first_name}, here is what we found on {site ? <a href={site} rel="nofollow noopener noreferrer">{site.replace(/^https?:\/\//, '').replace(/\/$/, '')}</a> : 'your website'}.</p> : null}
      </header>

      <section className="card stack" aria-labelledby="score">
        <h2 id="score">Overall score</h2>
        <p className={`audit-score audit-${band}`}><strong>{audit.score ?? 0}</strong><span> / 100</span></p>
        {content.summary ? <p>{content.summary}</p> : null}
        <p className="muted">{open.length ? `${open.length} of ${content.checks.length} checks could be improved.` : 'Every check passed.'}</p>
      </section>

      {content.recommendations.length ? (
        <section className="card stack" aria-labelledby="recs">
          <h2 id="recs">What to fix first</h2>
          <ol className="stack">
            {content.recommendations.map((r) => (
              <li key={r.check_id}><strong>{r.title}</strong><p>{r.why}</p><p className="muted">{r.how}</p></li>
            ))}
          </ol>
        </section>
      ) : null}

      <section className="card stack" aria-labelledby="checks">
        <h2 id="checks">Everything we checked</h2>
        <ul className="list">
          {content.checks.map((c) => (
            <li key={c.id} className="spread">
              <span><strong>{c.label}</strong><br /><span className="muted">{c.detail}</span></span>
              <span className={c.status === 'pass' ? 'badge badge-ok' : c.status === 'warn' ? 'badge badge-warn' : c.status === 'fail' ? 'badge badge-error' : 'badge'}>{STATUS_LABELS[c.status]}</span>
            </li>
          ))}
        </ul>
      </section>

      <footer className="muted">
        <p>These results were measured from your home page and public reviews when the audit was made. Questions or want help with any of this? Just reply to the email this link came in{audit.sender_name ? `, and ${audit.sender_name} will get back to you` : ''}.</p>
      </footer>
    </main>
  );
}
