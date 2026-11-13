'use server';

import { z } from 'zod';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { friendlyDbError } from '@/lib/errors';
import type { FormState } from '@/lib/form-state';
import { requireUser } from '@/lib/session';
import { JOB_TYPES, parseCampaignForm, scoreThreshold, type JobType } from '@/lib/campaigns';
import { firstError, uuidSchema } from '@/lib/validation';
import { parseEmailSettings, outreachReadiness } from '@/lib/outreach';
import { BOOKING_EVENT_TYPE } from '@/lib/replies';
import { parseVoiceSettings, voiceReadiness } from '@/lib/voice';
import { parseTextSettings, textReadiness } from '@/lib/texting';
import { closerAssistantSchema } from '@/lib/closer';
import { parseReceptionistSettings } from '@/lib/receptionist';

const NO_PERMISSION = 'Only owners and admins can manage campaigns.';

// Row-level security re-checks every write: only owners and admins can create
// campaigns or queue agent work, and only inside their own workspace.

export async function createCampaign(_prev: FormState, form: FormData): Promise<FormState> {
  const ws = uuidSchema.safeParse(form.get('workspace_id'));
  if (!ws.success) return { error: 'Workspace not found.' };
  const parsed = parseCampaignForm(form);
  if (!parsed.success) return { error: firstError(parsed.error) };
  const { find_leads_now, ...fields } = parsed.data;

  const { supabase, user } = await requireUser();
  const { data: campaign, error } = await supabase
    .from('campaigns')
    .insert({ workspace_id: ws.data, ...fields, status: 'active', created_by: user.id })
    .select('id')
    .single();
  if (error || !campaign) return { error: error?.code === '42501' ? NO_PERMISSION : friendlyDbError(error) };

  // The setup agent plans first; lead sourcing then runs on the saved plan
  const jobs = [{ workspace_id: ws.data, campaign_id: campaign.id, type: 'campaign_plan', requested_by: user.id }];
  if (find_leads_now) jobs.push({ workspace_id: ws.data, campaign_id: campaign.id, type: 'lead_sourcing', requested_by: user.id });
  const { error: jobError } = await supabase.from('agent_jobs').insert(jobs);
  if (jobError) return { error: friendlyDbError(jobError) };

  revalidatePath(`/w/${ws.data}/campaigns`);
  redirect(`/w/${ws.data}/campaigns/${campaign.id}`);
}

export async function queueAgentJob(_prev: FormState, form: FormData): Promise<FormState> {
  const ws = uuidSchema.safeParse(form.get('workspace_id'));
  const campaignId = uuidSchema.safeParse(form.get('campaign_id'));
  const type = form.get('type') as JobType;
  if (!ws.success || !campaignId.success) return { error: 'Campaign not found.' };
  if (!(JOB_TYPES as readonly string[]).includes(type)) return { error: 'Unknown agent task.' };

  const { supabase, user } = await requireUser();
  const { error } = await supabase
    .from('agent_jobs')
    .insert({ workspace_id: ws.data, campaign_id: campaignId.data, type, requested_by: user.id });
  if (error?.code === '23505') return { error: 'The agent is already working on this. Wait for it to finish.' };
  if (error?.code === '42501') return { error: NO_PERMISSION };
  if (error?.code === '23503') return { error: 'Campaign not found.' };
  if (error) return { error: friendlyDbError(error) };

  revalidatePath(`/w/${ws.data}/campaigns/${campaignId.data}`);
  const notices: Record<JobType, string> = {
    campaign_plan: 'The setup agent will re-plan this campaign within a minute.',
    lead_sourcing: 'The lead sourcing agent will start within a minute.',
    enrichment: 'The enrichment agent will find contacts and verify emails and phones within a minute.',
    research: 'The research agent will research and score new leads within a minute.',
    copywriting: 'The copywriting agent will write emails for new qualified leads within a minute.',
    email_outreach: 'Approved emails will be handed to Instantly within a minute.',
    voice_outreach: 'The AI caller will start calls within a minute, if it is inside calling hours.',
    sms_outreach: 'Text follow-ups will go out within a minute, if it is inside contact hours.',
    ai_closer: 'The AI closer will check for meetings starting now and proposals to send within a minute.',
    audit_reports: 'The audit agent will audit new qualified leads within a minute.',
    learning: 'The learning agent will look at the latest results within a minute.',
    crm_sync: 'This campaign will be synced to HubSpot within a minute.',
  };
  return { notice: notices[type] };
}

export async function setCampaignStatus(_prev: FormState, form: FormData): Promise<FormState> {
  const ws = uuidSchema.safeParse(form.get('workspace_id'));
  const campaignId = uuidSchema.safeParse(form.get('campaign_id'));
  const status = form.get('status');
  if (!ws.success || !campaignId.success) return { error: 'Campaign not found.' };
  if (status !== 'active' && status !== 'paused' && status !== 'archived') return { error: 'Unknown status.' };

  const { supabase } = await requireUser();
  const { data, error } = await supabase
    .from('campaigns')
    .update({ status, updated_at: new Date().toISOString() })
    .eq('workspace_id', ws.data)
    .eq('id', campaignId.data)
    .select('id');
  if (error) return { error: friendlyDbError(error) };
  if (!data?.length) return { error: NO_PERMISSION };
  revalidatePath(`/w/${ws.data}/campaigns/${campaignId.data}`);
  return { notice: status === 'active' ? 'Campaign is active.' : status === 'paused' ? 'Campaign paused.' : 'Campaign archived.' };
}

export async function setScoreThreshold(_prev: FormState, form: FormData): Promise<FormState> {
  const ws = uuidSchema.safeParse(form.get('workspace_id'));
  const campaignId = uuidSchema.safeParse(form.get('campaign_id'));
  const threshold = scoreThreshold.safeParse(form.get('score_threshold') ?? '');
  if (!ws.success || !campaignId.success) return { error: 'Campaign not found.' };
  if (!threshold.success) return { error: firstError(threshold.error) };

  const { supabase } = await requireUser();
  const { data, error } = await supabase
    .from('campaigns')
    .update({ score_threshold: threshold.data, updated_at: new Date().toISOString() })
    .eq('workspace_id', ws.data)
    .eq('id', campaignId.data)
    .select('id');
  if (error) return { error: friendlyDbError(error) };
  if (!data?.length) return { error: NO_PERMISSION };
  revalidatePath(`/w/${ws.data}/campaigns/${campaignId.data}`);
  return { notice: `Leads scoring ${threshold.data} or more now qualify for outreach. Existing scores are kept; re-run research to re-score.` };
}

export async function saveEmailSettings(_prev: FormState, form: FormData): Promise<FormState> {
  const ws = uuidSchema.safeParse(form.get('workspace_id'));
  const campaignId = uuidSchema.safeParse(form.get('campaign_id'));
  if (!ws.success || !campaignId.success) return { error: 'Campaign not found.' };
  const parsed = parseEmailSettings(form);
  if (!parsed.success) return { error: firstError(parsed.error) };

  const { supabase } = await requireUser();
  const { data, error } = await supabase
    .from('campaigns')
    .update({ ...parsed.data, updated_at: new Date().toISOString() })
    .eq('workspace_id', ws.data)
    .eq('id', campaignId.data)
    .select('id, instantly_campaign_id');
  if (error) return { error: friendlyDbError(error) };
  if (!data?.length) return { error: NO_PERMISSION };
  revalidatePath(`/w/${ws.data}/campaigns/${campaignId.data}`);
  return {
    notice: data[0].instantly_campaign_id
      ? 'Email settings saved. Sequence length and schedule changes apply to new campaigns; adjust the live Instantly campaign there if needed.'
      : 'Email settings saved.',
  };
}

export async function setOutreachStatus(_prev: FormState, form: FormData): Promise<FormState> {
  const ws = uuidSchema.safeParse(form.get('workspace_id'));
  const campaignId = uuidSchema.safeParse(form.get('campaign_id'));
  const status = form.get('status');
  if (!ws.success || !campaignId.success) return { error: 'Campaign not found.' };
  if (status !== 'live' && status !== 'paused') return { error: 'Unknown outreach status.' };

  const { supabase, user } = await requireUser();
  if (status === 'live') {
    const [{ data: c }, { data: w }, { data: tools }] = await Promise.all([
      supabase.from('campaigns').select('sender_name, email_footer, sending_accounts, status').eq('workspace_id', ws.data).eq('id', campaignId.data).maybeSingle(),
      supabase.from('workspaces').select('enabled_channels, setup_checklist').eq('id', ws.data).maybeSingle(),
      supabase.from('integrations').select('tool, status').eq('workspace_id', ws.data).eq('tool', 'instantly'),
    ]);
    if (!c || !w) return { error: 'Campaign not found.' };
    const { items, ready } = outreachReadiness({
      instantlyConnected: (tools ?? []).some((t) => t.status === 'connected'),
      emailChannelOn: (w.enabled_channels as Record<string, boolean>)?.email !== false,
      senderName: c.sender_name, footer: c.email_footer, accounts: c.sending_accounts,
      sendingDomainsChecked: (w.setup_checklist as Record<string, unknown>)?.sending_domains === true && (w.setup_checklist as Record<string, unknown>)?.mailbox_warmup === true,
    });
    if (!ready) return { error: `Before launching: ${items.filter((i) => i.blocking && !i.done).map((i) => i.label.toLowerCase()).join('; ')}.` };
    if (c.status !== 'active') return { error: 'Resume the campaign before launching email outreach.' };
  }

  const { data, error } = await supabase
    .from('campaigns')
    .update({ outreach_status: status, updated_at: new Date().toISOString(), ...(status === 'live' ? { auto_paused_reason: null, auto_paused_at: null } : {}) })
    .eq('workspace_id', ws.data)
    .eq('id', campaignId.data)
    .select('id');
  if (error) return { error: friendlyDbError(error) };
  if (!data?.length) return { error: NO_PERMISSION };
  if (status === 'live') {
    // Start straight away instead of waiting for the daily run
    await supabase.from('agent_jobs').insert({ workspace_id: ws.data, campaign_id: campaignId.data, type: 'email_outreach', requested_by: user.id });
  }
  revalidatePath(`/w/${ws.data}/campaigns/${campaignId.data}`);
  return { notice: status === 'live' ? 'Email outreach is live. Approved sequences go to Instantly within a minute.' : 'Email outreach paused. The Instantly campaign is paused within a minute.' };
}

const emailEditSchema = z.object({
  subject: z.string().trim().min(2, 'Add a subject').max(200, 'Subject is too long'),
  body: z.string().trim().min(10, 'Add the email text').max(5000, 'Email is too long'),
});

export async function updateEmail(_prev: FormState, form: FormData): Promise<FormState> {
  const ws = uuidSchema.safeParse(form.get('workspace_id'));
  const emailId = uuidSchema.safeParse(form.get('email_id'));
  const decision = form.get('decision');
  if (!ws.success || !emailId.success) return { error: 'Email not found.' };
  if (decision !== 'save' && decision !== 'approve' && decision !== 'reject') return { error: 'Unknown action.' };
  const parsed = emailEditSchema.safeParse({ subject: form.get('subject') ?? '', body: form.get('body') ?? '' });
  if (!parsed.success) return { error: firstError(parsed.error) };
  if (/(\{\{|\}\}|<[a-z!/])/i.test(parsed.data.subject + parsed.data.body)) return { error: 'Emails are plain text: remove HTML and {{ }} placeholders.' };

  const update: Record<string, string> = { ...parsed.data };
  if (decision === 'approve') update.status = 'approved';
  if (decision === 'reject') update.status = 'rejected';
  const { supabase } = await requireUser();
  const { data, error } = await supabase.from('emails').update(update).eq('workspace_id', ws.data).eq('id', emailId.data).select('id, campaign_id');
  if (error) return { error: error.code === '23514' && error.message ? error.message : friendlyDbError(error) };
  if (!data?.length) return { error: 'You do not have permission to change this email.' };
  revalidatePath(`/w/${ws.data}/campaigns/${data[0].campaign_id}/emails`);
  return { notice: decision === 'approve' ? 'Approved.' : decision === 'reject' ? 'Rejected. This lead will not be emailed unless you approve it again.' : 'Saved.' };
}

export async function approveAllDrafts(_prev: FormState, form: FormData): Promise<FormState> {
  const ws = uuidSchema.safeParse(form.get('workspace_id'));
  const campaignId = uuidSchema.safeParse(form.get('campaign_id'));
  if (!ws.success || !campaignId.success) return { error: 'Campaign not found.' };
  const { supabase } = await requireUser();
  const { data, error } = await supabase.from('emails').update({ status: 'approved' })
    .eq('workspace_id', ws.data).eq('campaign_id', campaignId.data).eq('status', 'draft').select('id');
  if (error) return { error: friendlyDbError(error) };
  revalidatePath(`/w/${ws.data}/campaigns/${campaignId.data}/emails`);
  return { notice: data?.length ? `${data.length} emails approved.` : 'There are no drafts waiting for approval.' };
}

export async function saveReplySettings(_prev: FormState, form: FormData): Promise<FormState> {
  const ws = uuidSchema.safeParse(form.get('workspace_id'));
  const campaignId = uuidSchema.safeParse(form.get('campaign_id'));
  if (!ws.success || !campaignId.success) return { error: 'Campaign not found.' };
  const eventType = String(form.get('booking_event_type') ?? '').trim();
  if (eventType && !BOOKING_EVENT_TYPE.test(eventType)) return { error: 'Use the event type address from Calendly, like https://api.calendly.com/event_types/ABC123, or leave it empty.' };
  const { supabase } = await requireUser();
  const { data, error } = await supabase.from('campaigns')
    .update({ auto_answer: form.get('auto_answer') === 'on', booking_event_type: eventType || null, updated_at: new Date().toISOString() })
    .eq('workspace_id', ws.data).eq('id', campaignId.data).select('id');
  if (error) return { error: friendlyDbError(error) };
  if (!data?.length) return { error: NO_PERMISSION };
  revalidatePath(`/w/${ws.data}/campaigns/${campaignId.data}`);
  return { notice: 'Reply settings saved.' };
}

export async function saveVoiceSettings(_prev: FormState, form: FormData): Promise<FormState> {
  const ws = uuidSchema.safeParse(form.get('workspace_id'));
  const campaignId = uuidSchema.safeParse(form.get('campaign_id'));
  if (!ws.success || !campaignId.success) return { error: 'Campaign not found.' };
  const parsed = parseVoiceSettings(form);
  if (!parsed.success) return { error: firstError(parsed.error) };
  const { attest, ...fields } = parsed.data;
  const { supabase } = await requireUser();
  const { data: current } = await supabase.from('campaigns').select('dnc_attested_at').eq('workspace_id', ws.data).eq('id', campaignId.data).maybeSingle();
  // The database stamps who attested and when; the value sent here only switches it on or off
  const attestation = attest ? (current?.dnc_attested_at ?? new Date().toISOString()) : null;
  const { data, error } = await supabase.from('campaigns')
    .update({ ...fields, dnc_attested_at: attestation, updated_at: new Date().toISOString() })
    .eq('workspace_id', ws.data).eq('id', campaignId.data).select('id');
  if (error) return { error: friendlyDbError(error) };
  if (!data?.length) return { error: NO_PERMISSION };
  revalidatePath(`/w/${ws.data}/campaigns/${campaignId.data}`);
  return { notice: 'Calling settings saved.' };
}

export async function setVoiceStatus(_prev: FormState, form: FormData): Promise<FormState> {
  const ws = uuidSchema.safeParse(form.get('workspace_id'));
  const campaignId = uuidSchema.safeParse(form.get('campaign_id'));
  const status = form.get('status');
  if (!ws.success || !campaignId.success) return { error: 'Campaign not found.' };
  if (status !== 'live' && status !== 'paused') return { error: 'Unknown status.' };
  const { supabase, user } = await requireUser();
  if (status === 'live') {
    const [{ data: c }, { data: w }, { data: tools }] = await Promise.all([
      supabase.from('campaigns').select('vapi_assistant_id, vapi_phone_number_id, status').eq('workspace_id', ws.data).eq('id', campaignId.data).maybeSingle(),
      supabase.from('workspaces').select('enabled_channels').eq('id', ws.data).maybeSingle(),
      supabase.from('integrations').select('status').eq('workspace_id', ws.data).eq('tool', 'vapi'),
    ]);
    if (!c || !w) return { error: 'Campaign not found.' };
    const { items, ready } = voiceReadiness({
      vapiConnected: (tools ?? []).some((t) => t.status === 'connected'),
      voiceChannelOn: (w.enabled_channels as Record<string, boolean>)?.voice !== false,
      assistantId: c.vapi_assistant_id, phoneNumberId: c.vapi_phone_number_id,
    });
    if (!ready) return { error: `Before launching calls: ${items.filter((i) => !i.done).map((i) => i.label.toLowerCase()).join('; ')}.` };
    if (c.status !== 'active') return { error: 'Resume the campaign before launching calls.' };
  }
  const { data, error } = await supabase.from('campaigns').update({ voice_status: status, updated_at: new Date().toISOString() })
    .eq('workspace_id', ws.data).eq('id', campaignId.data).select('id');
  if (error) return { error: friendlyDbError(error) };
  if (!data?.length) return { error: NO_PERMISSION };
  if (status === 'live') await supabase.from('agent_jobs').insert({ workspace_id: ws.data, campaign_id: campaignId.data, type: 'voice_outreach', requested_by: user.id });
  revalidatePath(`/w/${ws.data}/campaigns/${campaignId.data}`);
  return { notice: status === 'live' ? 'AI calling is live. Calls start in the next calling window.' : 'AI calling paused. Calls already in progress finish normally.' };
}

export async function saveTextSettings(_prev: FormState, form: FormData): Promise<FormState> {
  const ws = uuidSchema.safeParse(form.get('workspace_id'));
  const campaignId = uuidSchema.safeParse(form.get('campaign_id'));
  if (!ws.success || !campaignId.success) return { error: 'Campaign not found.' };
  const parsed = parseTextSettings(form);
  if (!parsed.success) return { error: firstError(parsed.error) };
  const { supabase } = await requireUser();
  const { data, error } = await supabase.from('campaigns')
    .update({ ...parsed.data, updated_at: new Date().toISOString() })
    .eq('workspace_id', ws.data).eq('id', campaignId.data).select('id');
  if (error) return { error: friendlyDbError(error) };
  if (!data?.length) return { error: NO_PERMISSION };
  revalidatePath(`/w/${ws.data}/campaigns/${campaignId.data}`);
  return { notice: 'Text settings saved.' };
}

export async function setTextStatus(_prev: FormState, form: FormData): Promise<FormState> {
  const ws = uuidSchema.safeParse(form.get('workspace_id'));
  const campaignId = uuidSchema.safeParse(form.get('campaign_id'));
  const status = form.get('status');
  if (!ws.success || !campaignId.success) return { error: 'Campaign not found.' };
  if (status !== 'live' && status !== 'paused') return { error: 'Unknown status.' };
  const { supabase, user } = await requireUser();
  if (status === 'live') {
    const [{ data: c }, { data: w }, { data: tools }] = await Promise.all([
      supabase.from('campaigns').select('sms_channel, sms_from, whatsapp_from, whatsapp_content_sid, status').eq('workspace_id', ws.data).eq('id', campaignId.data).maybeSingle(),
      supabase.from('workspaces').select('enabled_channels').eq('id', ws.data).maybeSingle(),
      supabase.from('integrations').select('status').eq('workspace_id', ws.data).eq('tool', 'twilio'),
    ]);
    if (!c || !w) return { error: 'Campaign not found.' };
    const { items, ready } = textReadiness({
      twilioConnected: (tools ?? []).some((t) => t.status === 'connected'),
      channel: c.sms_channel === 'whatsapp' ? 'whatsapp' : 'sms',
      channelOn: (w.enabled_channels as Record<string, boolean>)?.[c.sms_channel] !== false,
      smsFrom: c.sms_from, whatsappFrom: c.whatsapp_from, contentSid: c.whatsapp_content_sid,
    });
    if (!ready) return { error: `Before launching texts: ${items.filter((i) => !i.done).map((i) => i.label.toLowerCase()).join('; ')}.` };
    if (c.status !== 'active') return { error: 'Resume the campaign before launching texts.' };
  }
  const { data, error } = await supabase.from('campaigns').update({ sms_status: status, updated_at: new Date().toISOString() })
    .eq('workspace_id', ws.data).eq('id', campaignId.data).select('id');
  if (error) return { error: friendlyDbError(error) };
  if (!data?.length) return { error: NO_PERMISSION };
  if (status === 'live') await supabase.from('agent_jobs').insert({ workspace_id: ws.data, campaign_id: campaignId.data, type: 'sms_outreach', requested_by: user.id });
  revalidatePath(`/w/${ws.data}/campaigns/${campaignId.data}`);
  return { notice: status === 'live' ? 'Text follow-ups are live. They go out in the next contact window.' : 'Text follow-ups paused.' };
}

export async function saveCloserSettings(_prev: FormState, form: FormData): Promise<FormState> {
  const ws = uuidSchema.safeParse(form.get('workspace_id'));
  const campaignId = uuidSchema.safeParse(form.get('campaign_id'));
  if (!ws.success || !campaignId.success) return { error: 'Campaign not found.' };
  const raw = String(form.get('vapi_closer_assistant_id') ?? '').trim();
  const parsed = raw ? closerAssistantSchema.safeParse(raw) : null;
  if (parsed && !parsed.success) return { error: firstError(parsed.error) };
  const { supabase } = await requireUser();
  const { data, error } = await supabase.from('campaigns')
    .update({ vapi_closer_assistant_id: parsed?.success ? parsed.data : null, updated_at: new Date().toISOString() })
    .eq('workspace_id', ws.data).eq('id', campaignId.data).select('id');
  if (error) return { error: friendlyDbError(error) };
  if (!data?.length) return { error: NO_PERMISSION };
  revalidatePath(`/w/${ws.data}/campaigns/${campaignId.data}`);
  return { notice: parsed ? 'Closer saved.' : 'Closer removed. Meetings for this campaign go to your team.' };
}

export async function saveReceptionistSettings(_prev: FormState, form: FormData): Promise<FormState> {
  const ws = uuidSchema.safeParse(form.get('workspace_id'));
  const campaignId = uuidSchema.safeParse(form.get('campaign_id'));
  if (!ws.success || !campaignId.success) return { error: 'Campaign not found.' };
  const parsed = parseReceptionistSettings(form);
  if (!parsed.success) return { error: firstError(parsed.error) };
  const { supabase } = await requireUser();
  const { data, error } = await supabase.from('campaigns').update({ ...parsed.data, updated_at: new Date().toISOString() })
    .eq('workspace_id', ws.data).eq('id', campaignId.data).select('id');
  if (error?.code === '23505') return { error: 'Another campaign already answers this phone number.' };
  if (error) return { error: friendlyDbError(error) };
  if (!data?.length) return { error: NO_PERMISSION };
  revalidatePath(`/w/${ws.data}/campaigns/${campaignId.data}`);
  return { notice: 'Receptionist settings saved.' };
}

export async function setReceptionistStatus(_prev: FormState, form: FormData): Promise<FormState> {
  const ws = uuidSchema.safeParse(form.get('workspace_id'));
  const campaignId = uuidSchema.safeParse(form.get('campaign_id'));
  const status = form.get('status');
  if (!ws.success || !campaignId.success) return { error: 'Campaign not found.' };
  if (status !== 'live' && status !== 'off') return { error: 'Unknown status.' };
  const { supabase } = await requireUser();
  if (status === 'live') {
    const [{ data: c }, { data: tools }] = await Promise.all([
      supabase.from('campaigns').select('vapi_receptionist_assistant_id, vapi_inbound_number_id').eq('workspace_id', ws.data).eq('id', campaignId.data).maybeSingle(),
      supabase.from('integrations').select('status').eq('workspace_id', ws.data).eq('tool', 'vapi'),
    ]);
    if (!c) return { error: 'Campaign not found.' };
    if (!(tools ?? []).some((t) => t.status === 'connected')) return { error: 'Connect Vapi in Setup before switching on the receptionist.' };
    if (!c.vapi_receptionist_assistant_id || !c.vapi_inbound_number_id) return { error: 'Add the receptionist assistant and phone number first.' };
  }
  const { data, error } = await supabase.from('campaigns').update({ receptionist_status: status, updated_at: new Date().toISOString() })
    .eq('workspace_id', ws.data).eq('id', campaignId.data).select('id');
  if (error) return { error: friendlyDbError(error) };
  if (!data?.length) return { error: NO_PERMISSION };
  revalidatePath(`/w/${ws.data}/campaigns/${campaignId.data}`);
  return { notice: status === 'live' ? 'The AI receptionist answers your calls from now on.' : 'Receptionist off. Calls go to your team number.' };
}

export async function setAuditEnabled(_prev: FormState, form: FormData): Promise<FormState> {
  const ws = uuidSchema.safeParse(form.get('workspace_id'));
  const campaignId = uuidSchema.safeParse(form.get('campaign_id'));
  const enabled = form.get('enabled') === 'true';
  if (!ws.success || !campaignId.success) return { error: 'Campaign not found.' };
  const { supabase, user } = await requireUser();
  const { data, error } = await supabase.from('campaigns').update({ audit_enabled: enabled, updated_at: new Date().toISOString() })
    .eq('workspace_id', ws.data).eq('id', campaignId.data).select('id');
  if (error) return { error: friendlyDbError(error) };
  if (!data?.length) return { error: NO_PERMISSION };
  if (enabled) await supabase.from('agent_jobs').insert({ workspace_id: ws.data, campaign_id: campaignId.data, type: 'audit_reports', requested_by: user.id });
  revalidatePath(`/w/${ws.data}/campaigns/${campaignId.data}`);
  return { notice: enabled ? 'Audits are on. Qualified leads get their audit within a minute, and emails link to it.' : 'Audits are off. New emails are written without an audit.' };
}
