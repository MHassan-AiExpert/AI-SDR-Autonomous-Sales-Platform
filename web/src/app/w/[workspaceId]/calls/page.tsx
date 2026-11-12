import type { Metadata } from 'next';
import Link from 'next/link';
import { requireWorkspace } from '@/lib/session';
import { OUTCOME_LABELS, safeRecordingUrl } from '@/lib/voice';

export const metadata: Metadata = { title: 'Calls' };

type Row = {
  id: string; lead_id: string; created_at: string; outcome: string | null; status: string; duration_seconds: number | null;
  summary: string | null; recording_url: string | null; to_number: string | null; agent: string; direction: string;
  leads: { full_name: string | null; email: string | null; companies: { name: string } | null } | null;
};

const OUTCOMES = ['interested', 'callback', 'not_interested', 'do_not_call', 'voicemail', 'no_answer', 'wrong_number', 'failed'] as const;

export default async function CallsPage({ params, searchParams }: { params: Promise<{ workspaceId: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { workspaceId } = await params;
  const { supabase, workspace } = await requireWorkspace(workspaceId);
  const sp = await searchParams;
  const raw = Array.isArray(sp.outcome) ? sp.outcome[0] : sp.outcome;
  const outcome = (OUTCOMES as readonly string[]).includes(raw ?? '') ? raw! : null;
  let q = supabase.from('calls')
    .select('id, lead_id, created_at, outcome, status, duration_seconds, summary, recording_url, to_number, agent, direction, leads(full_name, email, companies(name))')
    .eq('workspace_id', workspace.id);
  if (outcome) q = q.eq('outcome', outcome);
  const { data } = await q.order('created_at', { ascending: false }).limit(100);
  const rows = (data ?? []) as unknown as Row[];
  const base = `/w/${workspace.id}/calls`;

  return (
    <>
      <h1>Calls</h1>
      <p className="muted">Every AI call with its outcome, summary, recording and transcript. Open a lead to read the full transcript.</p>
      <nav className="chips" aria-label="Outcome">
        <Link className={!outcome ? 'chip chip-on' : 'chip'} href={base}>All</Link>
        {OUTCOMES.map((o) => <Link key={o} className={outcome === o ? 'chip chip-on' : 'chip'} href={`${base}?outcome=${o}`}>{OUTCOME_LABELS[o]}</Link>)}
      </nav>
      {!rows.length ? <section className="card"><p className="muted">No calls yet.</p></section> : (
        <div className="table-wrap">
          <table className="table">
            <thead><tr><th scope="col">When (UTC)</th><th scope="col">Lead</th><th scope="col">Outcome</th><th scope="col">Summary</th><th scope="col">Length</th></tr></thead>
            <tbody>
              {rows.map((k) => {
                const rec = safeRecordingUrl(k.recording_url);
                return (
                  <tr key={k.id}>
                    <td><time dateTime={k.created_at}>{new Date(k.created_at).toUTCString().replace(' GMT', '')}</time></td>
                    <td><Link href={`/w/${workspace.id}/leads/${k.lead_id}`}>{k.leads?.full_name ?? k.leads?.email ?? k.to_number}</Link>{k.leads?.companies?.name ? <><br /><span className="muted">{k.leads.companies.name}</span></> : null}</td>
                    <td><span className="badge">{k.outcome ? OUTCOME_LABELS[k.outcome] ?? k.outcome : k.status}</span></td>
                    <td>{k.summary ?? '—'}{rec ? <><br /><a href={rec} target="_blank" rel="noopener noreferrer">Recording</a></> : null}</td>
                    <td>{k.duration_seconds ? `${Math.round(k.duration_seconds / 6) / 10} min` : '—'}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
