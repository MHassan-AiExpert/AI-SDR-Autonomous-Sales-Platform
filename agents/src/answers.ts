// Sends approved answers: email replies in the prospect's Instantly thread,
// and text replies by SMS or WhatsApp from the campaign's Twilio sender.

import { requestJson, ProviderError, type Fetch } from './http.ts';
import type { Deps } from './jobs.ts';
import type { Campaign, Job } from './store.ts';
import { TwilioError, sendMessage, twilioMessage, type TwilioCreds } from './sources/twilio.ts';
import { twilioCreds } from './texting.ts';

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

const WHATSAPP_WINDOW_MS = 24 * 3600_000;

export async function runReplySend(deps: Deps, job: Job, campaign: Campaign) {
  const ws = job.workspace_id;
  const { store } = deps;
  const stats = { sent: 0, failed: 0, skipped: 0, waiting: 0, error: undefined as string | undefined };
  const state = await store.workspaceState(ws);
  if (state.outreach_paused) return { ...stats, note: 'Outreach is paused, so answers are waiting.' };
  const connected = await store.connectedTools(ws);
  let key: string | undefined;
  let creds: TwilioCreds | null | undefined;
  const hookToken = deps.webhookBaseUrl ? await store.webhookToken(ws) : null;

  for (const a of await store.approvedAnswers(ws, campaign.id, 50)) {
    const channel = a.channel === 'sms' || a.channel === 'whatsapp' ? a.channel : 'email';
    // Answers on a channel switched off in Settings wait until it is on again
    if (state.enabled_channels[channel] === false) { stats.waiting++; continue; }
    // The lead may have opted out since the answer was approved
    if (a.stage === 'do_not_contact' || a.suppressed) {
      await store.setAnswerStatus(ws, a.id, 'failed', 'The lead asked not to be contacted');
      stats.skipped++;
      continue;
    }
    if (channel === 'email') {
      if (!a.provider_email_id || !a.email_account) {
        await store.setAnswerStatus(ws, a.id, 'failed', 'The original email is unknown, answer in Instantly');
        stats.skipped++;
        continue;
      }
      key ??= connected.has('instantly') ? (await store.secret(ws, 'instantly'))?.api_key : undefined;
      if (!key) throw new Error('Connect Instantly in Setup to send answers');
    } else {
      creds ??= await twilioCreds(store, ws, connected);
      const from = channel === 'sms' ? campaign.sms_from : campaign.whatsapp_from;
      const problem = !creds ? 'Connect Twilio in Setup to answer texts'
        : !from ? `Add the ${channel === 'sms' ? 'SMS' : 'WhatsApp'} sender to the campaign's text settings`
          : !a.phone ? 'The lead has no phone number'
            : channel === 'whatsapp' && Date.now() - new Date(a.created_at).getTime() > WHATSAPP_WINDOW_MS ? twilioMessage('63016', null)
              : null;
      if (problem) {
        await store.setAnswerStatus(ws, a.id, 'failed', problem);
        stats.skipped++;
        continue;
      }
    }
    if (!(await store.claimAnswer(ws, a.id))) continue;
    try {
      if (channel === 'email') {
        await sendInstantlyReply(key!, {
          eaccount: a.email_account!, replyTo: a.provider_email_id!, subject: replySubject(a.subject),
          text: a.answer + (campaign.email_footer ? `\n\n${campaign.email_footer}` : ''), html: answerHtml(a.answer, campaign.email_footer),
        }, deps.fetchImpl);
      } else {
        const from = (channel === 'sms' ? campaign.sms_from : campaign.whatsapp_from)!;
        const body = a.answer.trim().slice(0, 1500);
        const id = await store.insertText(ws, campaign.id, a.lead_id, { channel, body, template: null, to: a.phone!, from, step: null, basis: null, key: `answer:${a.id}` });
        if (id) {
          try {
            const sent = await sendMessage(creds!, { channel, to: a.phone!, from, body, statusCallback: hookToken ? `${deps.webhookBaseUrl}/webhook/twilio/${hookToken}` : undefined }, deps.fetchImpl);
            await store.textSent(ws, id, a.lead_id, sent.sid, channel === 'sms' ? 'Answer sent by SMS' : 'Answer sent on WhatsApp', channel);
          } catch (err) {
            await store.textFailed(ws, id, err instanceof Error ? err.message : 'Sending failed', err instanceof TwilioError ? err.code : null);
            throw err;
          }
        }
      }
      await store.answerSent(ws, a.id, a.lead_id, a.lead_stage_after, channel);
      stats.sent++;
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Sending failed';
      await store.setAnswerStatus(ws, a.id, 'failed', message.slice(0, 300));
      stats.failed++;
      if (err instanceof ProviderError && (err.status === 401 || err.status === 402 || err.status === 403)) {
        stats.error = message;
        await store.markToolError(ws, channel === 'email' ? 'instantly' : 'twilio', 'error', message);
        break;
      }
    }
  }
  return JSON.parse(JSON.stringify(stats)) as typeof stats;
}
