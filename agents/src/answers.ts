// Sends approved answers as replies in the prospect's Instantly thread.

import { requestJson, ProviderError, type Fetch } from './http.ts';
import type { Deps } from './jobs.ts';
import type { Campaign, Job } from './store.ts';

const escapeHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** Plain text answer to HTML; only Calendly booking links become clickable. */
export function answerHtml(text: string, footer: string | null): string {
  const linkify = (s: string) => s.replace(/https:\/\/calendly\.com\/[^\s<]+/g, (u) => `<a href="${u}">${u}</a>`);
  const paras = text.trim().split(/\n{2,}/).map((p) => `<p>${linkify(escapeHtml(p)).replace(/\n/g, '<br/>')}</p>`);
  const foot = footer?.trim() ? `<p style="color:#6b7280;font-size:12px">${escapeHtml(footer.trim()).replace(/\n/g, '<br/>')}</p>` : '';
  return paras.join('') + foot;
}

export function replySubject(subject: string | null): string {
  const base = (subject ?? '').replace(/^\s*((re|aw|sv|antw)\s*:\s*)+/i, '').trim();
  return `Re: ${base || 'our conversation'}`.slice(0, 200);
}

export async function sendInstantlyReply(key: string, r: { eaccount: string; replyTo: string; subject: string; text: string; html: string }, fetchImpl?: Fetch) {
  return requestJson('Instantly', 'https://api.instantly.ai/api/v2/emails/reply', {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ eaccount: r.eaccount, reply_to_uuid: r.replyTo, subject: r.subject, body: { text: r.text, html: r.html } }),
  }, { fetchImpl, timeoutMs: 30_000 });
}

export async function runReplySend(deps: Deps, job: Job, campaign: Campaign) {
  const ws = job.workspace_id;
  const { store } = deps;
  const stats = { sent: 0, failed: 0, skipped: 0, error: undefined as string | undefined };
  const state = await store.workspaceState(ws);
  if (state.outreach_paused || state.enabled_channels.email === false) return { ...stats, note: 'Email outreach is paused, so answers are waiting.' };
  const key = (await store.connectedTools(ws)).has('instantly') ? (await store.secret(ws, 'instantly'))?.api_key : undefined;
  if (!key) throw new Error('Connect Instantly in Setup to send answers');

  for (const a of await store.approvedAnswers(ws, campaign.id, 50)) {
    // The lead may have opted out since the answer was approved
    if (a.stage === 'do_not_contact' || a.suppressed || !a.provider_email_id || !a.email_account) {
      await store.setAnswerStatus(ws, a.id, 'failed', a.suppressed || a.stage === 'do_not_contact' ? 'The lead asked not to be contacted' : 'The original email is unknown, answer in Instantly');
      stats.skipped++;
      continue;
    }
    if (!(await store.claimAnswer(ws, a.id))) continue;
    try {
      await sendInstantlyReply(key, {
        eaccount: a.email_account, replyTo: a.provider_email_id, subject: replySubject(a.subject),
        text: a.answer + (campaign.email_footer ? `\n\n${campaign.email_footer}` : ''), html: answerHtml(a.answer, campaign.email_footer),
      }, deps.fetchImpl);
      await store.answerSent(ws, a.id, a.lead_id, a.lead_stage_after);
      stats.sent++;
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Sending failed';
      await store.setAnswerStatus(ws, a.id, 'failed', message.slice(0, 300));
      stats.failed++;
      if (err instanceof ProviderError && (err.status === 401 || err.status === 402 || err.status === 403)) {
        stats.error = message;
        await store.markToolError(ws, 'instantly', 'error', message);
        break;
      }
    }
  }
  return JSON.parse(JSON.stringify(stats)) as typeof stats;
}
