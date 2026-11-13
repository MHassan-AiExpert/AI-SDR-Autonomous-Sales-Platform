// CRM sync (SRS M9): mirrors a campaign's leads, deals and key activity to
// HubSpot. Leads go to contacts (upserted by email) with a lead status that
// follows their stage; deals go to the chosen pipeline, associated with the
// contact; replies, meetings and calls become notes on the contact, once each.
// A fingerprint of what was sent means unchanged records are skipped. Wins and
// losses set in HubSpot are read back before anything is pushed, so a change
// made by a person in the CRM is never overwritten by an older platform value.

import { createHash } from 'node:crypto';
import { ProviderError } from './http.ts';
import { createDeal, createNote, noteEscape, readDealStages, updateDeal, upsertContacts, type ContactInput, type DealInput } from './sources/hubspot.ts';
import type { Deps } from './jobs.ts';
import type { Campaign, Job } from './store.ts';
import { log } from './log.ts';
import { notify } from './notify.ts';
import { slackEscape } from './sources/slack.ts';

export const LIMITS = { leads: 200, deals: 100, activities: 200 };

export const LEAD_STATUS: Record<string, string> = {
  new: 'NEW', contacted: 'ATTEMPTED_TO_CONTACT', engaged: 'CONNECTED', interested: 'IN_PROGRESS', meeting_booked: 'OPEN_DEAL',
  won: 'OPEN_DEAL', lost: 'BAD_TIMING', not_interested: 'UNQUALIFIED', do_not_contact: 'UNQUALIFIED',
};

export const DEAL_STAGES = ['meeting_booked', 'meeting_held', 'proposal_sent', 'negotiation', 'won', 'lost'] as const;
export type DealStage = (typeof DEAL_STAGES)[number];

/** Stage ids of HubSpot's default sales pipeline. */
export const DEFAULT_STAGE_MAP: Record<DealStage, string> = {
  meeting_booked: 'appointmentscheduled', meeting_held: 'presentationscheduled', proposal_sent: 'contractsent',
  negotiation: 'decisionmakerboughtin', won: 'closedwon', lost: 'closedlost',
};

const STAGE_ID = /^[A-Za-z0-9_-]{1,64}$/;
export function stageMap(saved: unknown): Record<DealStage, string> {
  const out = { ...DEFAULT_STAGE_MAP };
  if (saved && typeof saved === 'object' && !Array.isArray(saved)) {
    for (const s of DEAL_STAGES) {
      const v = (saved as Record<string, unknown>)[s];
      if (typeof v === 'string' && STAGE_ID.test(v.trim())) out[s] = v.trim();
    }
  }
  return out;
}

export class CrmError extends Error {}

export const fingerprint = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex');

export type CrmLead = {
  id: string; email: string; full_name: string | null; phone: string | null; title: string | null; stage: string;
  company: string | null; domain: string | null; score: number | null; linkedin_url: string | null;
};

const EMAIL = /^[^\s@<>"]{1,64}@[^\s@<>"]{1,255}\.[A-Za-z]{2,}$/;

export function contactProperties(l: CrmLead): Record<string, string> {
  const [first, ...rest] = (l.full_name ?? '').trim().split(/\s+/).filter(Boolean);
  const p: Record<string, string> = { hs_lead_status: LEAD_STATUS[l.stage] ?? 'OPEN' };
  if (first) p.firstname = first.slice(0, 100);
  if (rest.length) p.lastname = rest.join(' ').slice(0, 100);
  if (l.phone) p.phone = l.phone;
  if (l.title) p.jobtitle = l.title.slice(0, 200);
  if (l.company) p.company = l.company.slice(0, 200);
  if (l.domain) p.website = l.domain;
  if (l.linkedin_url) p.hs_linkedin_url = l.linkedin_url;
  if (l.stage === 'won') p.lifecyclestage = 'customer';
  return p;
}

export type CrmDeal = {
  id: string; lead_id: string; stage: DealStage; value_cents: number | null; currency: string; lead_name: string | null;
  company: string | null; plan_name: string | null; closed_at: Date | null;
};

export function dealInput(d: CrmDeal, pipeline: string, map: Record<DealStage, string>): DealInput {
  const who = d.company ?? d.lead_name ?? 'New customer';
  return {
    name: d.plan_name ? `${who}: ${d.plan_name}` : who,
    pipeline, stage: map[d.stage],
    amount: d.value_cents === null ? null : (d.value_cents / 100).toFixed(2),
    closeDate: d.closed_at ? d.closed_at.toISOString() : null,
  };
}

export type CrmActivity = { id: string; lead_id: string; kind: 'reply' | 'meeting' | 'call'; at: Date; detail: Record<string, string | number | null> };

const CLASS: Record<string, string> = {
  interested: 'interested', question: 'asked a question', objection: 'raised an objection', not_now: 'not right now', referral: 'referred someone',
  out_of_office: 'out of office', wrong_person: 'wrong person', unsubscribe: 'asked to stop', negative: 'not interested',
};

export function noteBody(a: CrmActivity, brand = 'the AI SDR platform'): string {
  const d = a.detail;
  const t = (v: unknown, n = 500) => noteEscape(String(v ?? '').trim().slice(0, n));
  if (a.kind === 'reply') {
    const head = `<strong>Reply by ${t(d.channel, 20)}</strong>${d.classification ? ` (${t(CLASS[String(d.classification)] ?? d.classification, 40)})` : ''}`;
    return `${head}<br>${t(d.body, 1500)}<br><em>Logged by ${noteEscape(brand)}</em>`;
  }
  if (a.kind === 'meeting') {
    return `<strong>Meeting ${t(d.status, 20)}</strong> for ${t(a.at.toISOString().replace('T', ' ').slice(0, 16), 20)} UTC` +
      `${d.run_by === 'ai_closer' ? ', run by the AI closer' : ''}${d.outcome ? `<br>Outcome: ${t(d.outcome)}` : ''}<br><em>Logged by ${noteEscape(brand)}</em>`;
  }
  const mins = typeof d.duration_seconds === 'number' ? ` (${Math.max(1, Math.round(d.duration_seconds / 60))} min)` : '';
  return `<strong>${d.direction === 'inbound' ? 'Inbound' : 'Outbound'} AI call</strong>${mins}${d.outcome ? `: ${t(d.outcome, 30)}` : ''}` +
    `${d.summary ? `<br>${t(d.summary, 1500)}` : ''}<br><em>Logged by ${noteEscape(brand)}</em>`;
}

type Stats = {
  contacts_sent: number; contacts_unchanged: number; contacts_without_email: number; deals_created: number; deals_updated: number;
  deals_unchanged: number; deals_without_contact: number; notes_created: number; closed_from_crm: number; rate_limited: boolean;
};

export async function runCrmSync(deps: Deps, job: Job, campaign: Campaign) {
  const ws = job.workspace_id;
  const { store, fetchImpl } = deps;
  const settings = await store.crmSettings(ws);
  if (!settings?.enabled) return { skipped: 'CRM sync is switched off' };
  const connected = await store.connectedTools(ws);
  if (!connected.has('hubspot')) return { skipped: 'HubSpot is not connected' };
  const token = (await store.secret(ws, 'hubspot'))?.access_token;
  if (!token) return { skipped: 'HubSpot is not connected' };
  const map = stageMap(settings.stage_map);
  const stats: Stats = {
    contacts_sent: 0, contacts_unchanged: 0, contacts_without_email: 0, deals_created: 0, deals_updated: 0,
    deals_unchanged: 0, deals_without_contact: 0, notes_created: 0, closed_from_crm: 0, rate_limited: false,
  };

  try {
    // 1. Wins and losses recorded in HubSpot come back first
    const linked = await store.crmLinkedDeals(ws, campaign.id);
    if (linked.length) {
      const stages = await readDealStages(token, linked.map((x) => x.external_id), fetchImpl);
      for (const x of linked) {
        const hsStage = stages.get(x.external_id);
        const ours = hsStage === map.won ? 'won' : hsStage === map.lost ? 'lost' : null;
        const closed = ours && ours !== x.stage ? await store.closeDealFromCrm(ws, x.record_id, ours) : null;
        if (closed && ours) {
          stats.closed_from_crm++;
          const link = deps.appUrl ? ` <${deps.appUrl}/w/${ws}/leads/${closed.leadId}|Open lead>` : '';
          await notify(store, ws, {
            event: ours === 'won' ? 'deal_won' : 'deal_lost', leadId: closed.leadId, campaignId: campaign.id, dedupe: `${ours}:${closed.leadId}`,
            slack: `${ours === 'won' ? ':tada: *Deal won*' : ':small_red_triangle_down: *Deal lost*'}: ${slackEscape(closed.name)} was marked ${ours} in HubSpot.${link}`,
          }, fetchImpl);
        }
      }
    }

    // 2. Contacts
    const leads = await store.crmLeads(ws, campaign.id, settings.scope, LIMITS.leads);
    const links = await store.crmLinks(ws, 'lead', leads.map((l) => l.id));
    const toSend: { lead: CrmLead; input: ContactInput; fp: string }[] = [];
    for (const l of leads) {
      const email = l.email?.trim().toLowerCase();
      if (!email || !EMAIL.test(email)) { stats.contacts_without_email++; continue; }
      const properties = contactProperties(l);
      const fp = fingerprint({ email, properties });
      if (links.get(l.id)?.fingerprint === fp) { stats.contacts_unchanged++; continue; }
      toSend.push({ lead: l, input: { email, properties }, fp });
    }
    if (toSend.length) {
      const ids = await upsertContacts(token, toSend.map((x) => x.input), fetchImpl);
      for (const x of toSend) {
        const id = ids.get(x.input.email);
        if (!id) continue;
        await store.saveCrmLink(ws, 'lead', x.lead.id, id, x.fp);
        stats.contacts_sent++;
      }
    }

    // 3. Deals
    const deals = await store.crmDeals(ws, campaign.id, LIMITS.deals);
    const contactIds = await store.crmLinks(ws, 'lead', deals.map((d) => d.lead_id));
    const dealLinks = await store.crmLinks(ws, 'deal', deals.map((d) => d.id));
    for (const d of deals) {
      const contact = contactIds.get(d.lead_id)?.external_id;
      if (!contact) { stats.deals_without_contact++; continue; }
      const input = dealInput(d, settings.pipeline_id, map);
      const fp = fingerprint(input);
      const link = dealLinks.get(d.id);
      if (link?.fingerprint === fp) { stats.deals_unchanged++; continue; }
      if (link) {
        await updateDeal(token, link.external_id, input, fetchImpl);
        stats.deals_updated++;
        await store.saveCrmLink(ws, 'deal', d.id, link.external_id, fp);
      } else {
        const id = await createDeal(token, input, contact, fetchImpl);
        stats.deals_created++;
        await store.saveCrmLink(ws, 'deal', d.id, id, fp);
      }
    }

    // 4. Activity notes, once each, for contacts already in HubSpot
    const acts = await store.crmActivities(ws, campaign.id, LIMITS.activities);
    const brand = acts.length ? await store.brandName(ws) : null;
    const actContacts = await store.crmLinks(ws, 'lead', [...new Set(acts.map((a) => a.lead_id))]);
    for (const a of acts) {
      const contact = actContacts.get(a.lead_id)?.external_id;
      if (!contact) continue;
      const id = await createNote(token, contact, noteBody(a, brand ?? undefined), a.at, fetchImpl);
      await store.saveCrmLink(ws, 'activity', a.id, id, null);
      stats.notes_created++;
    }
  } catch (err) {
    if (err instanceof ProviderError && (err.status === 401 || err.status === 403)) {
      await store.markToolError(ws, 'hubspot', 'expired', 'HubSpot rejected the access token. Reconnect HubSpot in Setup.');
      throw new CrmError('HubSpot rejected the access token. Reconnect HubSpot in Setup.');
    }
    if (err instanceof ProviderError && err.status === 429) {
      // Whatever was saved stays saved; the rest goes in the next hourly run
      stats.rate_limited = true;
      log('warn', 'HubSpot rate limit reached, the rest syncs next run', { job: job.id });
      return stats;
    }
    throw err;
  }
  await store.crmSynced(ws);
  return stats;
}
