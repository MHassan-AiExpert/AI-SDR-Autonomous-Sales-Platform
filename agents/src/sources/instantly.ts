// Instantly API v2: campaigns that send each lead its own AI-written emails.
// The sequence uses per-lead variables ({{subject_1}}, {{body_1}}, ...), so one
// Instantly campaign carries many personal sequences.

import { requestJson, isObject, str, type Fetch } from '../http.ts';

const BASE = 'https://api.instantly.ai/api/v2';

export const INSTANTLY_TIMEZONES = [
  'America/Anchorage', 'America/Boise', 'America/Chicago', 'America/Detroit', 'America/Bogota', 'America/Sao_Paulo',
  'America/Santiago', 'America/St_Johns', 'Europe/Isle_of_Man', 'Europe/Belgrade', 'Europe/Helsinki', 'Europe/Istanbul',
  'Africa/Cairo', 'Asia/Dubai', 'Asia/Karachi', 'Asia/Kolkata', 'Asia/Dhaka', 'Asia/Hong_Kong', 'Australia/Perth',
  'Asia/Taipei', 'Australia/Brisbane', 'Australia/Melbourne', 'Pacific/Auckland',
] as const;

export type CampaignSettings = {
  name: string; accounts: string[]; timezone: string; from: string; to: string;
  days: Record<string, boolean>; dailyLimit: number; steps: number; delayDays: number;
};

export function campaignBody(s: CampaignSettings) {
  const days = Object.fromEntries(['0', '1', '2', '3', '4', '5', '6'].map((d) => [d, s.days[d] === true]));
  return {
    name: s.name.slice(0, 200),
    campaign_schedule: { schedules: [{ name: 'Sending hours', timing: { from: s.from, to: s.to }, days, timezone: s.timezone }] },
    sequences: [{
      steps: Array.from({ length: s.steps }, (_, i) => ({
        type: 'email',
        delay: i === s.steps - 1 ? 0 : s.delayDays,
        delay_unit: 'days',
        variants: [{ subject: `{{subject_${i + 1}}}`, body: `{{body_${i + 1}}}` }],
      })),
    }],
    email_list: s.accounts,
    daily_limit: s.dailyLimit,
    stop_on_reply: true,
    link_tracking: false,
    open_tracking: false,
    text_only: false,
  };
}

const headers = (key: string) => ({ Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' });

export async function createCampaign(key: string, s: CampaignSettings, fetchImpl?: Fetch): Promise<string> {
  const body = await requestJson('Instantly', `${BASE}/campaigns`, { method: 'POST', headers: headers(key), body: JSON.stringify(campaignBody(s)) }, { fetchImpl });
  const id = isObject(body) ? str(body.id) : undefined;
  if (!id) throw new Error('Instantly did not return a campaign id');
  return id;
}

export async function setCampaignState(key: string, id: string, state: 'active' | 'paused', fetchImpl?: Fetch) {
  const action = state === 'active' ? 'activate' : 'pause';
  await requestJson('Instantly', `${BASE}/campaigns/${encodeURIComponent(id)}/${action}`, { method: 'POST', headers: headers(key), body: '{}' }, { fetchImpl });
}

export type InstantlyLead = {
  campaign: string; email: string; firstName?: string; lastName?: string; companyName: string;
  jobTitle?: string; website?: string; emails: { subject: string; html: string }[];
};

export async function addLead(key: string, lead: InstantlyLead, fetchImpl?: Fetch): Promise<string | null> {
  const custom: Record<string, string> = {};
  lead.emails.forEach((e, i) => {
    custom[`subject_${i + 1}`] = e.subject;
    custom[`body_${i + 1}`] = e.html;
  });
  const body = await requestJson('Instantly', `${BASE}/leads`, {
    method: 'POST', headers: headers(key),
    body: JSON.stringify({
      campaign: lead.campaign, email: lead.email, first_name: lead.firstName ?? null, last_name: lead.lastName ?? null,
      company_name: lead.companyName, job_title: lead.jobTitle ?? null, website: lead.website ?? null,
      skip_if_in_campaign: true, custom_variables: custom,
    }),
  }, { fetchImpl });
  return isObject(body) ? str(body.id) ?? null : null;
}

const escapeHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** Plain text (AI or human edited) to safe HTML paragraphs, with the compliance footer. */
export function toEmailHtml(text: string, footer: string): string {
  const paras = text.trim().split(/\n{2,}/).map((p) => `<p>${escapeHtml(p).replace(/\n/g, '<br>')}</p>`);
  const foot = footer.trim() ? `<p style="color:#6b7280;font-size:12px">${escapeHtml(footer.trim()).replace(/\n/g, '<br>')}</p>` : '';
  return paras.join('') + foot;
}

export function splitName(full: string | null): { firstName?: string; lastName?: string } {
  if (!full) return {};
  const parts = full.replace(/^(dr|mr|mrs|ms|prof)\.?\s+/i, '').trim().split(/\s+/);
  return { firstName: parts[0], lastName: parts.slice(1).join(' ') || undefined };
}
