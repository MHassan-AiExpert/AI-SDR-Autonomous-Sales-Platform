// Email outreach agent (SRS M6): keeps the campaign's Instantly campaign in
// step with what the company wants, and hands approved, still-eligible
// sequences to it within the daily limit.

import { ProviderError } from './http.ts';
import { addLead, createCampaign, setCampaignState, splitName, toEmailHtml, INSTANTLY_TIMEZONES } from './sources/instantly.ts';
import type { Deps } from './jobs.ts';
import type { Campaign, Job } from './store.ts';

export class OutreachError extends Error {}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export async function runEmailOutreach(deps: Deps, job: Job, campaign: Campaign) {
  const ws = job.workspace_id;
  const { store } = deps;
  const workspace = await store.workspaceState(ws);
  const wantLive = campaign.status === 'active' && campaign.outreach_status === 'live' && !workspace.outreach_paused && workspace.enabled_channels.email !== false;
  const connected = await store.connectedTools(ws);
  const key = connected.has('instantly') ? (await store.secret(ws, 'instantly'))?.api_key : undefined;

  // ---- Not supposed to send: make sure Instantly is paused
  if (!wantLive) {
    if (campaign.instantly_campaign_id && campaign.instantly_state === 'active') {
      if (!key) throw new OutreachError('Instantly is not connected, so the campaign could not be paused there. Pause it in Instantly directly.');
      await setCampaignState(key, campaign.instantly_campaign_id, 'paused', deps.fetchImpl);
      await store.setInstantlyState(ws, campaign.id, campaign.instantly_campaign_id, 'paused');
      return { action: 'paused', reason: pauseReason(campaign, workspace) };
    }
    return { action: 'none', reason: pauseReason(campaign, workspace) };
  }

  // ---- Supposed to send: check the setup first
  if (!key) throw new OutreachError('Connect Instantly in Setup to send emails');
  const accounts = (campaign.sending_accounts ?? []).filter((a): a is string => typeof a === 'string' && EMAIL.test(a));
  if (!accounts.length) throw new OutreachError('Add at least one sending mailbox to the campaign\'s email settings');
  if (!campaign.sender_name?.trim()) throw new OutreachError('Add the sender name to the campaign\'s email settings');
  if (!campaign.email_footer?.trim()) throw new OutreachError('Add an email footer with your company name, postal address and how to opt out');
  if (!(INSTANTLY_TIMEZONES as readonly string[]).includes(campaign.send_timezone)) throw new OutreachError('Choose a supported sending time zone in the email settings');

  let instantlyId = campaign.instantly_campaign_id;
  try {
    if (!instantlyId) {
      instantlyId = await createCampaign(key, {
        name: `${campaign.name} (${(await store.brandName(ws)) ?? 'AI SDR'})`.slice(0, 200), accounts, timezone: campaign.send_timezone, from: campaign.send_window_start,
        to: campaign.send_window_end, days: campaign.send_days, dailyLimit: campaign.daily_send_limit,
        steps: 1 + campaign.follow_up_count, delayDays: campaign.follow_up_delay_days,
      }, deps.fetchImpl);
      await store.setInstantlyState(ws, campaign.id, instantlyId, null);
    }

    const remaining = Math.max(0, campaign.daily_send_limit - (await store.leadsQueuedToday(ws, campaign.id)));
    const ready = remaining ? await store.sequencesReady(ws, campaign.id, campaign.score_threshold, 1 + campaign.follow_up_count, remaining) : [];
    let added = 0;
    for (const seq of ready) {
      const providerId = await addLead(key, {
        campaign: instantlyId, email: seq.email, ...splitName(seq.full_name), companyName: seq.company_name,
        jobTitle: seq.title ?? undefined, website: seq.domain ?? undefined,
        emails: seq.emails.map((e) => ({ subject: e.subject, html: toEmailHtml(e.body, campaign.email_footer!) })),
      }, deps.fetchImpl);
      await store.markQueued(ws, seq.lead_id, seq.emails.map((e) => e.id), providerId, seq.emails.length);
      added++;
    }

    if (campaign.instantly_state !== 'active') {
      await setCampaignState(key, instantlyId, 'active', deps.fetchImpl);
      await store.setInstantlyState(ws, campaign.id, instantlyId, 'active');
    }
    return { action: 'sending', leads_added: added, daily_limit: campaign.daily_send_limit, remaining_today: remaining - added };
  } catch (err) {
    if (err instanceof ProviderError && (err.status === 401 || err.status === 403 || err.status === 402)) {
      await store.markToolError(ws, 'instantly', 'error', err.message);
    }
    throw err;
  }
}

function pauseReason(campaign: Campaign, workspace: { outreach_paused: boolean; enabled_channels: Record<string, boolean> }): string {
  if (workspace.outreach_paused) return 'All outreach is paused for this workspace.';
  if (workspace.enabled_channels.email === false) return 'Email is switched off in Settings.';
  if (campaign.status !== 'active') return 'The campaign is not active.';
  if (campaign.outreach_status === 'paused') return 'Email outreach is paused for this campaign.';
  return 'Email outreach has not been launched for this campaign.';
}
