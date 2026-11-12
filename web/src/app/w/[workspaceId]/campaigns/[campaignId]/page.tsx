import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ActionForm, SubmitButton } from '@/components/action-form';
import { canManageSettings } from '@/lib/roles';
import { requireWorkspace } from '@/lib/session';
import { uuidSchema } from '@/lib/validation';
import { JOB_LABELS, JOB_STATUS_LABELS, PLAN_SOURCE_TOOLS, SOURCE_LABELS, describeJobResult, describeSourcePlan } from '@/lib/campaigns';
import { queueAgentJob, setCampaignStatus } from '../actions';

export const metadata: Metadata = { title: 'Campaign' };

const list = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);

export default async function CampaignPage({ params }: { params: Promise<{ workspaceId: string; campaignId: string }> }) {
  const { workspaceId, campaignId } = await params;
  if (!uuidSchema.safeParse(campaignId).success) notFound();
  const { supabase, workspace } = await requireWorkspace(workspaceId);
  const manage = canManageSettings(workspace.role);

  const { data: campaign } = await supabase
    .from('campaigns')
    .select('id, name, niche, offer, status, target_areas, daily_lead_limit, icp, source_plan, created_at')
    .eq('workspace_id', workspace.id)
    .eq('id', campaignId)
    .maybeSingle();
  if (!campaign) notFound();

  const [{ data: jobs }, { count: leadCount }, { count: verified }, { count: awaiting }] = await Promise.all([
    supabase.from('agent_jobs').select('id, type, status, result, error, created_at, finished_at')
      .eq('workspace_id', workspace.id).eq('campaign_id', campaign.id).order('created_at', { ascending: false }).limit(20),
    supabase.from('leads').select('id', { count: 'exact', head: true }).eq('workspace_id', workspace.id).eq('campaign_id', campaign.id),
    supabase.from('leads').select('id', { count: 'exact', head: true }).eq('workspace_id', workspace.id).eq('campaign_id', campaign.id).eq('verification_status', 'valid'),
    supabase.from('companies').select('id', { count: 'exact', head: true }).eq('workspace_id', workspace.id).eq('campaign_id', campaign.id).eq('enrichment_status', 'pending'),
  ]);
  const icp = (campaign.icp ?? {}) as Record<string, unknown>;
  const planned = typeof icp.summary === 'string';
  const sources = describeSourcePlan(campaign.source_plan);
  const busy = (jobs ?? []).some((j) => j.status === 'queued' || j.status === 'running');
  const base = `/w/${workspace.id}`;

  return (
    <>
      <p><Link href={`${base}/campaigns`}>Campaigns</Link></p>
      <div className="spread">
        <h1>{campaign.name}</h1>
        <span className="badge">{campaign.status}</span>
      </div>
      <dl className="stats">
        <div><dt>Leads found</dt><dd>{leadCount ?? 0}</dd></div>
        <div><dt>Verified emails</dt><dd>{verified ?? 0}</dd></div>
        <div><dt>Companies awaiting contacts</dt><dd>{awaiting ?? 0}</dd></div>
        <div><dt>Leads per day</dt><dd>{campaign.daily_lead_limit}</dd></div>
        <div><dt>Niche</dt><dd>{campaign.niche}</dd></div>
        <div><dt>Target areas</dt><dd>{list(campaign.target_areas).join('; ')}</dd></div>
      </dl>
      <p><Link className="btn btn-secondary" href={`${base}/leads?campaign=${campaign.id}`}>View leads</Link></p>

      {manage ? (
        <section className="card stack" aria-labelledby="agent">
          <h2 id="agent">Agents</h2>
          <p className="muted">Active campaigns find new leads and verify them automatically once a day. Use these buttons to run an agent now.</p>
          {busy ? <p className="muted" role="status">An agent is working on this campaign. Refresh in a minute to see the result.</p> : null}
          <div className="row">
            <ActionForm action={queueAgentJob}>
              <input type="hidden" name="workspace_id" value={workspace.id} />
              <input type="hidden" name="campaign_id" value={campaign.id} />
              <input type="hidden" name="type" value="lead_sourcing" />
              <SubmitButton>Find leads now</SubmitButton>
            </ActionForm>
            <ActionForm action={queueAgentJob}>
              <input type="hidden" name="workspace_id" value={workspace.id} />
              <input type="hidden" name="campaign_id" value={campaign.id} />
              <input type="hidden" name="type" value="enrichment" />
              <SubmitButton variant="secondary">Enrich and verify</SubmitButton>
            </ActionForm>
            <ActionForm action={queueAgentJob}>
              <input type="hidden" name="workspace_id" value={workspace.id} />
              <input type="hidden" name="campaign_id" value={campaign.id} />
              <input type="hidden" name="type" value="campaign_plan" />
              <SubmitButton variant="secondary">Re-plan campaign</SubmitButton>
            </ActionForm>
            <ActionForm action={setCampaignStatus}>
              <input type="hidden" name="workspace_id" value={workspace.id} />
              <input type="hidden" name="campaign_id" value={campaign.id} />
              <input type="hidden" name="status" value={campaign.status === 'paused' ? 'active' : 'paused'} />
              <SubmitButton variant="ghost">{campaign.status === 'paused' ? 'Resume campaign' : 'Pause campaign'}</SubmitButton>
            </ActionForm>
          </div>
        </section>
      ) : null}

      <section className="card stack" aria-labelledby="icp">
        <h2 id="icp">Ideal customer profile</h2>
        {planned ? (
          <>
            <p>{String(icp.summary)}</p>
            <dl className="facts">
              <dt>Decision makers</dt><dd>{list(icp.decision_maker_titles).join(', ') || '—'}</dd>
              <dt>Industries</dt><dd>{list(icp.industries).join(', ') || '—'}</dd>
              <dt>Company size</dt><dd>{typeof icp.company_size === 'string' && icp.company_size ? icp.company_size : '—'}</dd>
              <dt>Pain points</dt><dd>{list(icp.pain_points).join('; ') || '—'}</dd>
              <dt>Buying triggers</dt><dd>{list(icp.buying_triggers).join('; ') || '—'}</dd>
            </dl>
          </>
        ) : (
          <p className="muted">The setup agent has not planned this campaign yet.</p>
        )}
      </section>

      <section className="card stack" aria-labelledby="sources">
        <h2 id="sources">Lead sources</h2>
        <ul className="tools">
          {sources.map((s) => (
            <li key={s.source} className="tool">
              <div className="spread">
                <strong>{SOURCE_LABELS[s.source]}</strong>
                <span className={s.enabled ? 'badge badge-ok' : 'badge'}>{s.enabled ? 'Searching' : 'Off'}</span>
              </div>
              <p className="muted">{s.enabled ? s.detail : planned ? `Off for this niche, or ${PLAN_SOURCE_TOOLS[s.source]} is not connected.` : 'Waiting for the plan.'}</p>
            </li>
          ))}
        </ul>
        <p className="muted"><Link href={`${base}/setup`}>Connect more tools in Setup</Link>, then re-plan to add their sources.</p>
      </section>

      <section className="card stack" aria-labelledby="history">
        <h2 id="history">Agent activity</h2>
        {!jobs?.length ? <p className="muted">No agent runs yet.</p> : (
          <ul className="list">
            {jobs.map((j) => (
              <li key={j.id} className="stack">
                <div className="spread">
                  <strong>{JOB_LABELS[j.type] ?? j.type}</strong>
                  <span className={j.status === 'failed' ? 'badge badge-error' : j.status === 'succeeded' ? 'badge badge-ok' : 'badge badge-warn'}>{JOB_STATUS_LABELS[j.status] ?? j.status}</span>
                </div>
                <span className="muted">{describeJobResult(j.type, j.status, j.result, j.error)}</span>
                <time className="muted" dateTime={j.created_at}>{new Date(j.created_at).toUTCString()}</time>
              </li>
            ))}
          </ul>
        )}
      </section>
    </>
  );
}
