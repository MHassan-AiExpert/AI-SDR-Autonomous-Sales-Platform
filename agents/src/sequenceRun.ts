// The sequence agent (F22): runs the step the branching engine chose.
//
// The decision is made in ./sequence.ts, which is pure and unit tested. This
// module does the sending, and it deliberately reuses what the single-channel
// agents already use: the workspace pause, the channel switches, the contact
// window, the consent gates for texts and calls, and the per-campaign daily
// limits. Branching must not become a way around any of them.
//
// Email steps are sent through Instantly, one one-step campaign per sequence
// step, created on demand. Instantly keeps the mailboxes, the sending window
// and its own daily limit; this system decides which step a lead gets and
// when, which Instantly's own multi-step sequences cannot do because they
// only see replies to their own emails.

import { ProviderError } from './http.ts';
import { addLead, createCampaign, setCampaignState, splitName, toEmailHtml, INSTANTLY_TIMEZONES } from './sources/instantly.ts';
import { sendMessage, TwilioError } from './sources/twilio.ts';
import { startCall } from './sources/vapi.ts';
import { callBasis, callWindowOpen, firstMessage, callPrompt, ANALYSIS_SCHEMA, VoiceError, type CallLead } from './voice.ts';
import { textBasis, twilioCreds, CHANNEL_NAMES, OPT_OUT_LINE, TextError, type TextLead } from './texting.ts';
import { decide, sequenceProblems, type Facts, type Step, type Variant } from './sequence.ts';
import type { Deps } from './jobs.ts';
import type { Campaign, Job, SequenceCandidate, SequenceStepRow } from './store.ts';
import { log } from './log.ts';

export class SequenceError extends Error {}

/** How many leads to consider in one run, so a single campaign cannot hold the queue. */
export const SCAN_LIMIT = 400;

const firstNameOf = (full: string | null) => (full?.trim().split(/\s+/)[0] ?? '') || 'there';

/**
 * Fills the placeholders a person may write in a variant. Anything unknown is
 * replaced with nothing rather than left as braces in a real message.
 */
export function render(template: string, lead: SequenceCandidate, senderName: string | null, ourCompany: string): string {
  const values: Record<string, string> = {
    first_name: firstNameOf(lead.full_name),
    full_name: lead.full_name ?? '',
    company: lead.company_name ?? '',
    title: lead.title ?? '',
    sender_name: senderName ?? '',
    our_company: ourCompany,
  };
  return template.replace(/\{\{\s*([a-z_]+)\s*\}\}/gi, (_, key: string) => values[key.toLowerCase()] ?? '').replace(/[ \t]{2,}/g, ' ').trim();
}

const asStep = (row: SequenceStepRow): Step => ({
  id: row.id, position: row.position, channel: row.channel, wait_hours: row.wait_hours,
  condition: row.condition, is_last: row.is_last, instantly_campaign_id: row.instantly_campaign_id,
  variants: row.variants,
});

const toTextLead = (c: SequenceCandidate, facts: Facts): TextLead => ({
  id: c.lead_id, full_name: c.full_name, email: c.email, phone: c.phone, phone_line_type: c.phone_line_type,
  consent: c.consent, company_name: c.company_name, ai_report: c.ai_report,
  sent: Number(facts.texts_sent ?? 0), last_touch_at: null, suppressed: false,
});

const toCallLead = (c: SequenceCandidate, facts: Facts): CallLead => ({
  id: c.lead_id, full_name: c.full_name, title: c.title, phone: c.phone, phone_line_type: c.phone_line_type,
  consent: c.consent, company_name: c.company_name, ai_report: c.ai_report,
  attempts: Number(facts.calls_made ?? 0), last_call_at: null, suppressed: false,
});

/** The one-step Instantly campaign that sends a given email step, made on first use. */
async function stepCampaign(deps: Deps, ws: string, campaign: Campaign, step: Step, key: string, brand: string): Promise<string> {
  if (step.instantly_campaign_id) return step.instantly_campaign_id;
  const accounts = (campaign.sending_accounts ?? []).filter((a): a is string => typeof a === 'string' && a.includes('@'));
  if (!accounts.length) throw new SequenceError('Add at least one sending mailbox to the campaign\'s email settings');
  if (!(INSTANTLY_TIMEZONES as readonly string[]).includes(campaign.send_timezone)) throw new SequenceError('Choose a supported sending time zone in the email settings');
  const id = await createCampaign(key, {
    name: `${campaign.name} step ${step.position} (${brand})`.slice(0, 200),
    accounts, timezone: campaign.send_timezone, from: campaign.send_window_start, to: campaign.send_window_end,
    days: campaign.send_days, dailyLimit: campaign.daily_send_limit,
    // One step, no delay: this system decides when a lead reaches it
    steps: 1, delayDays: 0,
  }, deps.fetchImpl);
  await deps.store.setStepInstantlyCampaign(ws, step.id, id);
  await setCampaignState(key, id, 'active', deps.fetchImpl);
  return id;
}

export async function runSequenceSteps(deps: Deps, job: Job, campaign: Campaign) {
  const ws = job.workspace_id;
  const { store } = deps;

  if (!campaign.branching_enabled) {
    return { sent: 0, note: 'Branching is off for this campaign, so the fixed email cadence is in charge.' };
  }
  const state = await store.workspaceState(ws);
  if (campaign.status !== 'active' || state.outreach_paused) {
    return { sent: 0, note: campaign.status !== 'active' ? 'The campaign is not active.' : 'All outreach is paused for this workspace.' };
  }

  const rows = await store.sequenceSteps(ws, campaign.id);
  const steps = rows.map(asStep);
  const problems = sequenceProblems(steps, campaign.open_tracking);
  if (!steps.length) return { sent: 0, note: 'This campaign has no sequence steps yet.' };

  const remaining = Math.max(0, campaign.daily_send_limit - (await store.stepsSentToday(ws, campaign.id)));
  const stats = {
    sent: 0, failed: 0, not_allowed: 0, skipped_channel_off: 0,
    by_channel: {} as Record<string, number>, by_variant: {} as Record<string, number>,
    reasons: {} as Record<string, number>, problems, remaining_today: remaining,
  };
  if (!remaining) return { ...stats, note: 'The daily limit for this campaign is reached.' };

  const connected = await store.connectedTools(ws);
  const windowOpen = callWindowOpen(new Date(), campaign.call_timezone, campaign.call_window_start, campaign.call_window_end, campaign.call_days);
  const brand = (await store.brandName(ws)) ?? 'AI SDR';
  const ourCompany = state.name;

  // Each transport is prepared once, and only if a step actually needs it
  let instantlyKey: string | undefined;
  let twilio: Awaited<ReturnType<typeof twilioCreds>> = null;
  let vapiKey: string | undefined;
  let hookToken: string | null = null;

  const note = (reason: string) => { stats.reasons[reason] = (stats.reasons[reason] ?? 0) + 1; };

  const candidates = await store.sequenceCandidates(ws, campaign.id, SCAN_LIMIT);
  for (const lead of candidates) {
    if (stats.sent >= remaining) break;
    const facts = lead.facts ?? {};
    const decision = decide(steps, facts, lead.lead_id);
    if (!decision.run) {
      note(decision.reason);
      continue;
    }
    const step = decision.run;
    const variant: Variant | undefined = decision.variant;
    if (!variant) {
      note('the step has no active message');
      continue;
    }

    // The workspace's channel switches and the contact window still rule
    if (state.enabled_channels[step.channel] === false) {
      stats.skipped_channel_off++;
      note(`${step.channel} is switched off in Settings`);
      continue;
    }
    if (step.channel !== 'email' && !windowOpen) {
      note('outside contact hours');
      continue;
    }

    const body = render(variant.body, lead, campaign.sender_name, ourCompany);
    let outcome: 'sent' | 'failed' = 'sent';
    let detail: string | null = null;

    try {
      if (step.channel === 'email') {
        instantlyKey ??= connected.has('instantly') ? (await store.secret(ws, 'instantly'))?.api_key : undefined;
        if (!instantlyKey) throw new SequenceError('Connect Instantly in Setup to send emails');
        if (!campaign.email_footer?.trim()) throw new SequenceError('Add an email footer with your company name, postal address and how to opt out');
        if (!lead.email) { note('no email address'); continue; }
        const subject = render(variant.subject ?? '', lead, campaign.sender_name, ourCompany);
        if (!subject) { note('the email step has no subject'); continue; }
        const instantlyId = await stepCampaign(deps, ws, campaign, step, instantlyKey, brand);
        step.instantly_campaign_id = instantlyId;
        await addLead(instantlyKey, {
          campaign: instantlyId, email: lead.email, ...splitName(lead.full_name), companyName: lead.company_name,
          jobTitle: lead.title ?? undefined, website: lead.domain ?? undefined,
          emails: [{ subject, html: toEmailHtml(body, campaign.email_footer) }],
        }, deps.fetchImpl);
      } else if (step.channel === 'sms' || step.channel === 'whatsapp') {
        const basis = textBasis(toTextLead(lead, facts), step.channel);
        if (!basis.ok) { stats.not_allowed++; note(basis.reason); continue; }
        twilio ??= await twilioCreds(store, ws, connected);
        if (!twilio) throw new SequenceError('Connect Twilio in Setup to send texts');
        const from = step.channel === 'sms' ? campaign.sms_from : campaign.whatsapp_from;
        if (!from) throw new SequenceError(`Add the ${CHANNEL_NAMES[step.channel]} sender to the campaign's text settings`);
        if (step.channel === 'whatsapp' && !campaign.whatsapp_content_sid) throw new SequenceError('Add the approved WhatsApp template to the campaign\'s text settings');
        if (!deps.webhookBaseUrl) throw new SequenceError('Set N8N_PUBLIC_URL so delivery updates and replies can reach the platform');
        hookToken ??= await store.webhookToken(ws);
        if (!hookToken) throw new SequenceError('The workspace has no webhook address');
        const statusCallback = `${deps.webhookBaseUrl}/webhook/twilio/${hookToken}`;
        // An SMS always carries the opt-out line, as it does on the other path
        const text = step.channel === 'sms' && !body.includes(OPT_OUT_LINE) ? `${body} ${OPT_OUT_LINE}` : body;
        const id = await store.insertText(ws, campaign.id, lead.lead_id, {
          channel: step.channel, body: text, template: step.channel === 'whatsapp' ? campaign.whatsapp_content_sid : null,
          to: lead.phone!, from, step: step.position, basis: basis.basis,
          key: `${campaign.id}:${lead.lead_id}:${step.channel}:seq:${step.id}`,
        });
        if (!id) { note('already sent'); continue; }
        try {
          const sent = await sendMessage(twilio, step.channel === 'sms'
            ? { channel: 'sms', to: lead.phone!, from, body: text, statusCallback }
            : { channel: 'whatsapp', to: lead.phone!, from, contentSid: campaign.whatsapp_content_sid!, contentVariables: { 1: firstNameOf(lead.full_name), 2: body }, statusCallback },
          deps.fetchImpl);
          await store.textSent(ws, id, lead.lead_id, sent.sid, `Step ${step.position} (${variant.label}) sent: ${text}`, step.channel);
        } catch (err) {
          const message = err instanceof Error ? err.message : 'Sending failed';
          await store.textFailed(ws, id, message, err instanceof TwilioError ? err.code : null);
          throw err;
        }
      } else {
        const basis = callBasis(toCallLead(lead, facts), campaign);
        if (!basis.ok) { stats.not_allowed++; note(basis.reason); continue; }
        vapiKey ??= connected.has('vapi') ? (await store.secret(ws, 'vapi'))?.api_key : undefined;
        if (!vapiKey) throw new SequenceError('Connect Vapi in Setup to make calls');
        if (!campaign.vapi_assistant_id || !campaign.vapi_phone_number_id) throw new SequenceError('Add the Vapi assistant and phone number to the campaign\'s calling settings');
        if (!deps.webhookBaseUrl) throw new SequenceError('Set N8N_PUBLIC_URL so call results can reach the platform');
        hookToken ??= await store.webhookToken(ws);
        if (!hookToken) throw new SequenceError('The workspace has no webhook address');
        const callLead = toCallLead(lead, facts);
        const callId = await store.insertCall(ws, campaign.id, lead.lead_id, lead.phone!, Number(facts.calls_made ?? 0) + 1, basis.basis);
        if (!callId) { note('already called'); continue; }
        try {
          const providerId = await startCall(vapiKey, {
            assistantId: campaign.vapi_assistant_id, phoneNumberId: campaign.vapi_phone_number_id,
            number: lead.phone!, name: lead.full_name ?? undefined,
            // The step's message is the opening line; the rest of the call is the campaign's playbook
            firstMessage: body || firstMessage(callLead, ourCompany),
            systemPrompt: callPrompt(campaign, callLead, ourCompany), model: deps.voiceModel ?? 'gpt-4o-mini',
            variables: { lead_name: lead.full_name ?? '', company_name: lead.company_name ?? '', sender_name: campaign.sender_name ?? '', our_company: ourCompany },
            serverUrl: `${deps.webhookBaseUrl}/webhook/vapi/${hookToken}`, analysisSchema: ANALYSIS_SCHEMA,
          }, deps.fetchImpl);
          await store.callStarted(ws, callId, providerId);
        } catch (err) {
          await store.callFailed(ws, callId, (err instanceof Error ? err.message : 'Call could not start').slice(0, 300));
          throw err;
        }
      }
    } catch (err) {
      // A wrong setting or a rejected key stops the whole run: every later lead
      // would fail the same way, and the person needs to be told once.
      if (err instanceof SequenceError) throw err;
      if (err instanceof ProviderError && (err.status === 401 || err.status === 402 || err.status === 403)) {
        const tool = step.channel === 'email' ? 'instantly' : step.channel === 'voice' ? 'vapi' : 'twilio';
        await store.markToolError(ws, tool, 'error', err.message);
        throw new SequenceError(err.message);
      }
      if (err instanceof TwilioError && (err.status === 401 || err.status === 403)) {
        await store.markToolError(ws, 'twilio', 'error', err.message);
        throw new SequenceError(err.message);
      }
      outcome = 'failed';
      detail = (err instanceof Error ? err.message : 'The step could not be sent').slice(0, 500);
      stats.failed++;
      log('warn', 'sequence step failed', { job: job.id, lead: lead.lead_id, step: step.id, error: detail });
    }

    // Recorded either way, so a failing step is not retried for ever
    const recorded = await store.recordStepRun(ws, lead.lead_id, step.id, variant.label, outcome, detail);
    if (recorded && outcome === 'sent') {
      stats.sent++;
      stats.by_channel[step.channel] = (stats.by_channel[step.channel] ?? 0) + 1;
      const k = `${step.position}${variant.label}`;
      stats.by_variant[k] = (stats.by_variant[k] ?? 0) + 1;
      await store.activity(ws, lead.lead_id, 'status_change', step.channel,
        `Sequence step ${step.position} (message ${variant.label}) sent on ${step.channel}`, 'system');
    }
  }

  return JSON.parse(JSON.stringify({ ...stats, remaining_today: Math.max(0, remaining - stats.sent) })) as typeof stats;
}

/** Kept so a sequence failure reads like the other channels' failures. */
export const asJobError = (err: unknown) => (err instanceof SequenceError || err instanceof VoiceError || err instanceof TextError ? err.message : null);
