// AI calling settings, consent and labels.

import { z } from 'zod';
import { DAY_LABELS, SEND_TIMEZONES } from './outreach';

export const CALL_RULES = ['consent_only', 'consent_or_business_landline'] as const;
export const CONSENT_BASES = ['prior_express_consent', 'existing_customer', 'inbound_request'] as const;
export type ConsentBasis = (typeof CONSENT_BASES)[number];

export const CONSENT_LABELS: Record<ConsentBasis, string> = {
  prior_express_consent: 'Gave consent to be called',
  existing_customer: 'Existing customer relationship',
  inbound_request: 'Asked us to call',
};

export const OUTCOME_LABELS: Record<string, string> = {
  booked: 'Meeting booked', interested: 'Interested', callback: 'Call back', not_interested: 'Not interested',
  wrong_number: 'Wrong number', do_not_call: 'Do not call', voicemail: 'Voicemail', no_answer: 'No answer', failed: 'Failed',
  answered: 'Answered', transferred: 'Put through to the team', spam: 'Spam',
};

const time = z.string().regex(/^([01][0-9]|2[0-3]):[0-5][0-9]$/, 'Use a time like 10:00');
const vapiId = z.string().trim().toLowerCase().regex(/^[0-9a-f-]{36}$/, 'Copy the ID from Vapi; it looks like 1a2b3c4d-…');

export const voiceSettingsSchema = z.object({
  vapi_assistant_id: vapiId,
  vapi_phone_number_id: vapiId,
  call_timezone: z.enum(SEND_TIMEZONES, 'Choose a time zone'),
  call_window_start: time,
  call_window_end: time,
  call_days: z.record(z.string(), z.boolean()),
  call_daily_limit: z.coerce.number().int().min(1, 'Calls per day must be 1 to 2000').max(2000, 'Calls per day must be 1 to 2000'),
  call_max_attempts: z.coerce.number().int().min(1, 'Attempts must be 1 to 5').max(5, 'Attempts must be 1 to 5'),
  call_rule: z.enum(CALL_RULES, 'Choose who may be called'),
  attest: z.boolean(),
}).refine((v) => v.call_window_start < v.call_window_end, { message: 'The calling window must end after it starts', path: ['call_window_end'] })
  .refine((v) => Object.values(v.call_days).some(Boolean), { message: 'Choose at least one calling day', path: ['call_days'] })
  .refine((v) => v.call_rule === 'consent_only' || v.attest, { message: 'To call business landlines, confirm the numbers were screened against Do Not Call registries', path: ['attest'] });

export function parseVoiceSettings(form: FormData) {
  return voiceSettingsSchema.safeParse({
    vapi_assistant_id: form.get('vapi_assistant_id') ?? '',
    vapi_phone_number_id: form.get('vapi_phone_number_id') ?? '',
    call_timezone: form.get('call_timezone') ?? '',
    call_window_start: form.get('call_window_start') ?? '',
    call_window_end: form.get('call_window_end') ?? '',
    call_days: Object.fromEntries(DAY_LABELS.map((_, i) => [String(i), form.get(`call_day_${i}`) === 'on'])),
    call_daily_limit: form.get('call_daily_limit') ?? '',
    call_max_attempts: form.get('call_max_attempts') ?? '',
    call_rule: form.get('call_rule') ?? '',
    attest: form.get('attest') === 'on',
  });
}

export type VoiceReadinessInput = { vapiConnected: boolean; voiceChannelOn: boolean; assistantId: string | null; phoneNumberId: string | null };

export function voiceReadiness(i: VoiceReadinessInput) {
  const items = [
    { id: 'vapi', label: 'Vapi connected in Setup', done: i.vapiConnected },
    { id: 'channel', label: 'AI voice calls switched on in Settings', done: i.voiceChannelOn },
    { id: 'assistant', label: 'Vapi assistant chosen (its voice is used on every call)', done: Boolean(i.assistantId) },
    { id: 'number', label: 'Vapi phone number chosen (your Twilio number imported into Vapi)', done: Boolean(i.phoneNumberId) },
  ];
  return { items, ready: items.every((x) => x.done) };
}

export function safeRecordingUrl(url: string | null): string | null {
  return url && /^https:\/\/[^\s]+$/.test(url) ? url : null;
}
