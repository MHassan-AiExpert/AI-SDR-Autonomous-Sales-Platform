import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ActionForm, SubmitButton } from '@/components/action-form';
import { canManageSettings } from '@/lib/roles';
import { requireWorkspace } from '@/lib/session';
import { uuidSchema } from '@/lib/validation';
import { JOB_LABELS, JOB_STATUS_LABELS, PLAN_SOURCE_TOOLS, SOURCE_LABELS, describeJobResult, describeSourcePlan } from '@/lib/campaigns';
import { queueAgentJob, saveReplySettings, setCampaignStatus, setScoreThreshold } from '../actions';
import { OutreachSection, type OutreachCampaign } from './outreach-section';
import { VoiceSection, type VoiceCampaign } from './voice-section';
import { TextSection, type TextCampaign } from './text-section';
import { CloserSection } from './closer-section';
import { readPlaybook } from '@/lib/closer';

export const metadata: Metadata = { title: 'Campaign' };

const list = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);

export default async function CampaignPage({ params }: { params: Promise<{ workspaceId: string; campaignId: string }> }) {
  const { workspaceId, campaignId } = await params;
  if (!uuidSchema.safeParse(campaignId).success) notFound();
  const { supabase, workspace } = await requireWorkspace(workspaceId);
  const manage = canManageSettings(workspace.role);

  const { data: campaign } = await supabase
    .from('campaigns')
    .select('id, name, niche, offer, status, target_areas, daily_lead_limit, score_threshold, icp, source_plan, created_at, outreach_status, sender_name, email_footer, sending_accounts, send_timezone, send_window_start, send_window_end, send_days, daily_send_limit, follow_up_count, follow_up_delay_days, instantly_campaign_id, instantly_state, auto_answer, booking_event_type, voice_status, vapi_assistant_id, vapi_phone_number_id, call_timezone, call_window_start, call_window_end, call_days, call_daily_limit, call_max_attempts, call_rule, dnc_attested_at, sms_status, sms_channel, sms_from, whatsapp_from, whatsapp_content_sid, sms_after_days, sms_daily_limit, sms_max_messages, vapi_closer_assistant_id')
    .eq('workspace_id', workspace.id)
    .eq('id', campaignId)
    .maybeSingle();
  if (!campaign) notFound();

  const emailCount = (status: string) => supabase.from('emails').select('id', { count: 'exact', head: true }).eq('workspace_id', workspace.id).eq('campaign_id', campaign.id).eq('status', status);
  const [{ data: jobs }, { count: leadCount }, { count: verified }, { count: awaiting }, { count: qualified }, { count: drafts }, { count: approvedEmails }, { count: queuedEmails }, { data: instantly }, { data: vapi }, { count: callsToday }, { data: twilio }, { count: textsToday }, { data: payTools }, { data: playbookRow }] = await Promise.all([
    supabase.from('agent_jobs').select('id, type, status, result, error, created_at, finished_at')
      .eq('workspace_id', workspace.id).eq('campaign_id', campaign.id).order('created_at', { ascending: false }).limit(20),
    supabase.from('leads').select('id', { count: 'exact', head: true }).eq('workspace_id', workspace.id).eq('campaign_id', campaign.id),
    supabase.from('leads').select('id', { count: 'exact', head: true }).eq('workspace_id', workspace.id).eq('campaign_id', campaign.id).eq('verification_status', 'valid'),
    supabase.from('companies').select('id', { count: 'exact', head: true }).eq('workspace_id', workspace.id).eq('campaign_id', campaign.id).eq('enrichment_status', 'pending'),
    supabase.from('leads').select('id', { count: 'exact', head: true }).eq('workspace_id', workspace.id).eq('campaign_id', campaign.id).gte('score', campaign.score_threshold),
    emailCount('draft'), emailCount('approved'), emailCount('queued'),
    supabase.from('integrations').select('status').eq('workspace_id', workspace.id).eq('tool', 'instantly').maybeSingle(),
    supabase.from('integrations').select('status').eq('workspace_id', workspace.id).eq('tool', 'vapi').maybeSingle(),
    supabase.from('calls').select('id', { count: 'exact', head: true }).eq('workspace_id', workspace.id).eq('campaign_id', campaign.id).eq('direction', 'outbound').gte('created_at', new Date(new Date().setUTCHours(0, 0, 0, 0)).toISOString()),
    supabase.from('integrations').select('status').eq('workspace_id', workspace.id).eq('tool', 'twilio').maybeSingle(),
    supabase.from('messages').select('id', { count: 'exact', head: true }).eq('workspace_id', workspace.id).eq('campaign_id', campaign.id).eq('direction', 'outbound').not('step', 'is', null).gte('created_at', new Date(new Date().setUTCHours(0, 0, 0, 0)).toISOString()),
    supabase.from('integrations').select('tool, status').eq('workspace_id', workspace.id).in('tool', ['stripe', 'pandadoc']),
    supabase.from('playbooks').select('content').eq('workspace_id', workspace.id).eq('is_active', true).maybeSingle(),
  ]);
  const playbook = readPlaybook(playbookRow?.content);
  const toolOn = (t: string) => (payTools ?? []).some((x) => x.tool === t && x.status === 'connected');
  const checklist = (workspace.setup_checklist ?? {}) as Record<string, unknown>;
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
        <div><dt>Qualified for outreach</dt><dd>{qualified ?? 0}</dd></div>
        <div><dt>Verified emails</dt><dd>{verified ?? 0}</dd></div>
        <div><dt>Companies awaiting contacts</dt><dd>{awaiting ?? 0}</dd></div>
        <div><dt>Leads per day</dt><dd>{campaign.daily_lead_limit}</dd></div>
        <div><dt>Niche</dt><dd>{campaign.niche}</dd></div>
        <div><dt>Target areas</dt><dd>{list(campaign.target_areas).join('; ')}</dd></div>
      </dl>
      <p className="row">
        <Link className="btn btn-secondary" href={`${base}/leads?campaign=${campaign.id}&sort=score`}>View leads by score</Link>
        <Link href={`${base}/leads?campaign=${campaign.id}&min_score=${campaign.score_threshold}&sort=score`}>Qualified leads only</Link>
      </p>

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
              <input type="hidden" name="type" value="research" />
              <SubmitButton variant="secondary">Research and score</SubmitButton>
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

      <OutreachSection
        workspaceId={workspace.id}
        campaign={campaign as unknown as OutreachCampaign}
        manage={manage}
        counts={{ draft: drafts ?? 0, approved: approvedEmails ?? 0, queued: queuedEmails ?? 0 }}
        instantlyConnected={instantly?.status === 'connected'}
        emailChannelOn={workspace.enabled_channels?.email !== false}
        domainsReady={checklist.sending_domains === true && checklist.mailbox_warmup === true}
      />

      <VoiceSection
        workspaceId={workspace.id}
        campaign={campaign as unknown as VoiceCampaign}
        manage={manage}
        vapiConnected={vapi?.status === 'connected'}
        voiceChannelOn={workspace.enabled_channels?.voice !== false}
        callsToday={callsToday ?? 0}
      />

      <TextSection
        workspaceId={workspace.id}
        campaign={campaign as unknown as TextCampaign}
        manage={manage}
        twilioConnected={twilio?.status === 'connected'}
        channelOn={workspace.enabled_channels?.[campaign.sms_channel === 'whatsapp' ? 'whatsapp' : 'sms'] !== false}
        textsToday={textsToday ?? 0}
      />

      <CloserSection
        workspaceId={workspace.id}
        campaignId={campaign.id}
        assistantId={campaign.vapi_closer_assistant_id}
        manage={manage}
        readiness={{
          closerEnabled: workspace.ai_closer_enabled, vapiConnected: vapi?.status === 'connected', playbookReady: Boolean(playbook),
          assistantId: campaign.vapi_closer_assistant_id, phoneNumberId: campaign.vapi_phone_number_id,
          stripeConnected: toolOn('stripe'), pandadocConnected: toolOn('pandadoc'), templateId: playbook?.proposal_template_id ?? null,
        }}
      />

      <section className="card stack" aria-labelledby="answers">
        <h2 id="answers">Replies and booking</h2>
        <p className="muted">The reply agent drafts an answer for interested prospects, questions, objections and referrals, with a single-use Calendly link when Calendly is connected. In autopilot, confident answers to interested prospects, questions and referrals are sent on their own; objections always wait for a person.</p>
        {manage ? (
          <ActionForm action={saveReplySettings} className="stack">
            <input type="hidden" name="workspace_id" value={workspace.id} />
            <input type="hidden" name="campaign_id" value={campaign.id} />
            <label className="choice">
              <input type="checkbox" name="auto_answer" defaultChecked={campaign.auto_answer} />
              <span><strong>Send confident answers automatically in autopilot</strong></span>
            </label>
            <label className="field">
              <span>Calendly event type for booking links (optional, the first active one is used when empty)</span>
              <input name="booking_event_type" type="url" placeholder="https://api.calendly.com/event_types/ABC123" defaultValue={campaign.booking_event_type ?? ''} />
            </label>
            <SubmitButton variant="secondary">Save reply settings</SubmitButton>
          </ActionForm>
        ) : <p className="muted">Automatic answers: {campaign.auto_answer ? 'on' : 'off'}.</p>}
      </section>

      <section className="card stack" aria-labelledby="threshold">
        <h2 id="threshold">Outreach threshold</h2>
        <p className="muted">The research agent scores every lead from 0 to 100 for fit and intent. Only leads scoring {campaign.score_threshold} or more go on to outreach.</p>
        {manage ? (
          <ActionForm action={setScoreThreshold} className="row">
            <input type="hidden" name="workspace_id" value={workspace.id} />
            <input type="hidden" name="campaign_id" value={campaign.id} />
            <label className="field">
              <span className="sr-only">Minimum score</span>
              <input name="score_threshold" type="number" min={0} max={100} step={1} defaultValue={campaign.score_threshold} required />
            </label>
            <SubmitButton variant="secondary">Save threshold</SubmitButton>
          </ActionForm>
        ) : null}
      </section>

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
