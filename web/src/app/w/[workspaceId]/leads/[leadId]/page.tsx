import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { requireWorkspace } from '@/lib/session';
import { uuidSchema } from '@/lib/validation';
import { EMAIL_STATUS_LABELS } from '@/lib/outreach';
import { ANSWER_LABELS, REPLY_LABELS, replyBadge, safeConversationUrl, safeMeetingUrl, type ReplyClass } from '@/lib/replies';
import { LINE_TYPE_LABELS, SOURCE_LABELS, STAGE_LABELS, VERIFICATION_LABELS, readLeadReport, type LeadSource, type LeadStage, type VerificationStatus } from '@/lib/campaigns';

export const metadata: Metadata = { title: 'Lead' };

type Lead = {
  id: string; full_name: string | null; title: string | null; email: string | null; phone: string | null;
  phone_line_type: string | null; phone_country: string | null; linkedin_url: string | null; social_handles: Record<string, string> | null;
  source_channel: LeadSource; source_query: string | null; stage: LeadStage; verification_status: VerificationStatus;
  score: number | null; ai_report: unknown; created_at: string; campaign_id: string | null;
  companies: { name: string; domain: string | null; industry: string | null; size_band: string | null; location: string | null; google_rating: number | null; google_reviews: number | null } | null;
  campaigns: { name: string; score_threshold: number } | null;
};

const List = ({ items }: { items?: string[] }) => (items?.length ? <ul>{items.map((i) => <li key={i}>{i}</li>)}</ul> : <p className="muted">None found.</p>);

export default async function LeadPage({ params }: { params: Promise<{ workspaceId: string; leadId: string }> }) {
  const { workspaceId, leadId } = await params;
  if (!uuidSchema.safeParse(leadId).success) notFound();
  const { supabase, workspace } = await requireWorkspace(workspaceId);

  const { data } = await supabase
    .from('leads')
    .select('id, full_name, title, email, phone, phone_line_type, phone_country, linkedin_url, social_handles, source_channel, source_query, stage, verification_status, score, ai_report, created_at, campaign_id, companies(name, domain, industry, size_band, location, google_rating, google_reviews), campaigns(name, score_threshold)')
    .eq('workspace_id', workspace.id)
    .eq('id', leadId)
    .maybeSingle();
  if (!data) notFound();
  const lead = data as unknown as Lead;
  const { data: sequence } = await supabase
    .from('emails')
    .select('id, step, subject, body, status, queued_at, campaign_id')
    .eq('workspace_id', workspace.id)
    .eq('lead_id', lead.id)
    .order('step');
  const { data: replies } = await supabase
    .from('replies')
    .select('id, body, classification, summary, suggested_response, conversation_url, created_at, answer, answer_status')
    .eq('workspace_id', workspace.id)
    .eq('lead_id', lead.id)
    .order('created_at', { ascending: false })
    .limit(20);
  const { data: meetings } = await supabase
    .from('meetings')
    .select('id, starts_at, status, zoom_url, event_name, run_by')
    .eq('workspace_id', workspace.id)
    .eq('lead_id', lead.id)
    .order('starts_at', { ascending: false })
    .limit(10);
  const { data: activities } = await supabase
    .from('activities')
    .select('id, type, channel, summary, actor, created_at')
    .eq('workspace_id', workspace.id)
    .eq('lead_id', lead.id)
    .order('created_at', { ascending: false })
    .limit(100);

  const report = readLeadReport(lead.ai_report);
  const base = `/w/${workspace.id}`;
  const co = lead.companies;
  const threshold = lead.campaigns?.score_threshold ?? 60;

  return (
    <>
      <p><Link href={`${base}/leads${lead.campaign_id ? `?campaign=${lead.campaign_id}` : ''}`}>Leads</Link></p>
      <div className="spread">
        <h1>{lead.full_name ?? co?.name ?? 'Lead'}</h1>
        {lead.score === null
          ? <span className="badge">Not scored yet</span>
          : <span className={lead.score >= threshold ? 'badge badge-ok' : 'badge badge-warn'}>Score {lead.score}/100 · {lead.score >= threshold ? 'qualified' : 'below threshold'}</span>}
      </div>
      <dl className="stats">
        <div><dt>Stage</dt><dd>{STAGE_LABELS[lead.stage] ?? lead.stage}</dd></div>
        <div><dt>Source</dt><dd>{SOURCE_LABELS[lead.source_channel] ?? lead.source_channel}</dd></div>
        <div><dt>Campaign</dt><dd>{lead.campaign_id && lead.campaigns ? <Link href={`${base}/campaigns/${lead.campaign_id}`}>{lead.campaigns.name}</Link> : '—'}</dd></div>
        <div><dt>Found</dt><dd><time dateTime={lead.created_at}>{new Date(lead.created_at).toUTCString()}</time></dd></div>
      </dl>

      <section className="card stack" aria-labelledby="contact">
        <h2 id="contact">Contact</h2>
        <dl className="facts">
          <dt>Title</dt><dd>{lead.title ?? '—'}</dd>
          <dt>Email</dt><dd>{lead.email ? <>{lead.email} <span className="badge">{VERIFICATION_LABELS[lead.verification_status]}</span></> : '—'}</dd>
          <dt>Phone</dt><dd>{lead.phone ? `${lead.phone}${lead.phone_line_type ? ` · ${LINE_TYPE_LABELS[lead.phone_line_type] ?? lead.phone_line_type}` : ''}${lead.phone_country ? `, ${lead.phone_country}` : ''}` : '—'}</dd>
          <dt>LinkedIn</dt><dd>{lead.linkedin_url ? <a href={lead.linkedin_url} rel="noopener noreferrer nofollow" target="_blank">{lead.linkedin_url}</a> : '—'}</dd>
          <dt>Instagram</dt><dd>{lead.social_handles?.instagram ? `@${lead.social_handles.instagram}` : '—'}</dd>
          <dt>Found with</dt><dd>{lead.source_query ?? '—'}</dd>
        </dl>
      </section>

      <section className="card stack" aria-labelledby="company">
        <h2 id="company">Company</h2>
        <dl className="facts">
          <dt>Name</dt><dd>{co?.name ?? '—'}</dd>
          <dt>Website</dt><dd>{co?.domain ?? '—'}</dd>
          <dt>Industry</dt><dd>{co?.industry ?? '—'}</dd>
          <dt>Size</dt><dd>{co?.size_band ?? '—'}</dd>
          <dt>Location</dt><dd>{co?.location ?? '—'}</dd>
          <dt>Google rating</dt><dd>{co?.google_rating ? `★ ${co.google_rating}${co.google_reviews ? ` (${co.google_reviews} reviews)` : ''}` : '—'}</dd>
        </dl>
      </section>

      <section className="card stack" aria-labelledby="report">
        <h2 id="report">AI lead report</h2>
        {!report ? <p className="muted">The research agent has not researched this lead yet.</p> : (
          <>
            {report.company_summary ? <p>{report.company_summary}</p> : null}
            <h3>Likely pain points</h3><List items={report.pain_points} />
            <h3>Trigger events</h3><List items={report.trigger_events} />
            <h3>Personalisation hooks</h3><List items={report.personalization_hooks} />
            <h3>Why this score</h3>
            <p className="muted">Company fit {report.fit_score ?? '—'}, intent {report.intent_score ?? '—'}, final score {report.score ?? '—'} against a threshold of {report.threshold ?? threshold}.</p>
            <List items={[...(report.score_reasons ?? []), ...(report.model_reasons ?? [])]} />
            {report.disqualifiers?.length ? <><h3>Disqualifiers</h3><List items={report.disqualifiers} /></> : null}
          </>
        )}
      </section>

      <section className="card stack" aria-labelledby="emails">
        <h2 id="emails">Email sequence</h2>
        {!sequence?.length ? <p className="muted">No emails written for this lead yet.</p> : (
          <>
            {sequence.map((e) => (
              <article key={e.id} className="stack">
                <div className="spread"><strong>{e.step === 1 ? 'First email' : `Follow-up ${e.step - 1}`}: {e.subject}</strong><span className="badge">{EMAIL_STATUS_LABELS[e.status] ?? e.status}</span></div>
                <p className="pre">{e.body}</p>
              </article>
            ))}
            {sequence[0]?.campaign_id ? <p><Link href={`${base}/campaigns/${sequence[0].campaign_id}/emails?status=${sequence[0].status === 'queued' ? 'queued' : sequence[0].status}`}>Review in the campaign</Link></p> : null}
          </>
        )}
      </section>

      <section className="card stack" aria-labelledby="meetings">
        <h2 id="meetings">Meetings</h2>
        {!meetings?.length ? <p className="muted">No meetings booked yet.</p> : (
          <ul className="list">
            {meetings.map((m) => {
              const join = safeMeetingUrl(m.zoom_url);
              return (
                <li key={m.id} className="spread">
                  <span><time dateTime={m.starts_at}>{new Date(m.starts_at).toUTCString()}</time>{m.event_name ? ` · ${m.event_name}` : ''} · {m.run_by === 'ai_closer' ? 'AI closer' : 'Your team'}</span>
                  <span className="row"><span className="badge">{m.status}</span>{join && m.status === 'scheduled' ? <a href={join} target="_blank" rel="noopener noreferrer">Join</a> : null}</span>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <section className="card stack" aria-labelledby="replies">
        <h2 id="replies">Replies</h2>
        {!replies?.length ? <p className="muted">No replies yet.</p> : replies.map((r) => {
          const url = safeConversationUrl(r.conversation_url);
          return (
            <article key={r.id} className="stack">
              <div className="spread">
                <strong>{r.summary ?? 'Reply'}</strong>
                <span className={`badge badge-${replyBadge(r.classification)}`}>{r.classification ? REPLY_LABELS[r.classification as ReplyClass] ?? r.classification : 'Unread'}</span>
              </div>
              <blockquote className="pre">{r.body}</blockquote>
              {r.answer || r.suggested_response ? <details><summary>Answer · {ANSWER_LABELS[r.answer_status] ?? r.answer_status}</summary><p className="pre">{r.answer ?? r.suggested_response}</p></details> : null}
              {url ? <a href={url} target="_blank" rel="noopener noreferrer">Answer in Instantly</a> : null}
            </article>
          );
        })}
      </section>

      <section className="card stack" aria-labelledby="timeline">
        <h2 id="timeline">Activity</h2>
        {!activities?.length ? <p className="muted">No activity yet.</p> : (
          <ul className="list">
            {activities.map((a) => (
              <li key={a.id} className="stack">
                <span>{a.summary}</span>
                <span className="muted">{a.actor === 'ai' ? 'AI agent' : a.actor === 'human' ? 'Team member' : 'System'} · <time dateTime={a.created_at}>{new Date(a.created_at).toUTCString()}</time></span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </>
  );
}
