// SMS and WhatsApp follow-up settings, consent and labels.

import { z } from 'zod';

export const TEXT_CHANNELS = ['sms', 'whatsapp'] as const;
export type TextChannel = (typeof TEXT_CHANNELS)[number];
export const CHANNEL_LABELS: Record<TextChannel, string> = { sms: 'SMS', whatsapp: 'WhatsApp' };

export const TEXT_CONSENT_BASES = ['prior_express_consent', 'existing_customer', 'inbound_request'] as const;
export const TEXT_CONSENT_LABELS: Record<(typeof TEXT_CONSENT_BASES)[number], string> = {
  prior_express_consent: 'Agreed in writing to receive messages',
  existing_customer: 'Existing customer relationship',
  inbound_request: 'Messaged us first or asked us to message',
};

export const DELIVERY_LABELS: Record<string, string> = {
  queued: 'Sending', sent: 'Sent', delivered: 'Delivered', read: 'Read', failed: 'Not delivered', received: 'Received',
};

const e164 = z.string().trim().regex(/^\+[1-9][0-9]{6,14}$/, 'Enter the number with its country code, like +15125550100');
const smsSender = z.string().trim().regex(/^(\+[1-9][0-9]{6,14}|MG[0-9a-f]{32})$/, 'Enter your Twilio number with its country code, or a Messaging Service SID starting with MG');
const contentSid = z.string().trim().regex(/^HX[0-9a-f]{32}$/, 'Copy the template\'s Content SID from Twilio; it starts with HX');
const optional = <T extends z.ZodTypeAny>(s: T) => z.union([z.literal('').transform(() => null), s]);

export const textSettingsSchema = z.object({
  sms_channel: z.enum(TEXT_CHANNELS, 'Choose SMS or WhatsApp'),
  sms_from: optional(smsSender),
  whatsapp_from: optional(e164),
  whatsapp_content_sid: optional(contentSid),
  sms_after_days: z.coerce.number().int().min(1, 'Wait 1 to 30 days before texting').max(30, 'Wait 1 to 30 days before texting'),
  sms_daily_limit: z.coerce.number().int().min(1, 'Texts per day must be 1 to 5000').max(5000, 'Texts per day must be 1 to 5000'),
  sms_max_messages: z.coerce.number().int().min(1, 'Texts per lead must be 1 to 3').max(3, 'Texts per lead must be 1 to 3'),
}).refine((v) => v.sms_channel !== 'sms' || v.sms_from, { message: 'Add the Twilio number or Messaging Service that sends the SMS', path: ['sms_from'] })
  .refine((v) => v.sms_channel !== 'whatsapp' || (v.whatsapp_from && v.whatsapp_content_sid), { message: 'WhatsApp needs your WhatsApp sender number and an approved template', path: ['whatsapp_from'] });

export function parseTextSettings(form: FormData) {
  return textSettingsSchema.safeParse({
    sms_channel: form.get('sms_channel') ?? '',
    sms_from: form.get('sms_from') ?? '',
    whatsapp_from: form.get('whatsapp_from') ?? '',
    whatsapp_content_sid: form.get('whatsapp_content_sid') ?? '',
    sms_after_days: form.get('sms_after_days') ?? '',
    sms_daily_limit: form.get('sms_daily_limit') ?? '',
    sms_max_messages: form.get('sms_max_messages') ?? '',
  });
}

export type TextReadinessInput = {
  twilioConnected: boolean; channel: TextChannel; channelOn: boolean;
  smsFrom: string | null; whatsappFrom: string | null; contentSid: string | null;
};

export function textReadiness(i: TextReadinessInput) {
  const items = [
    { id: 'twilio', label: 'Twilio connected in Setup', done: i.twilioConnected },
    { id: 'channel', label: `${CHANNEL_LABELS[i.channel]} switched on in Settings`, done: i.channelOn },
    ...(i.channel === 'sms'
      ? [{ id: 'sender', label: 'SMS sender chosen (a Twilio number registered for business texting, or a Messaging Service)', done: Boolean(i.smsFrom) }]
      : [
        { id: 'sender', label: 'WhatsApp sender number chosen (approved in Twilio)', done: Boolean(i.whatsappFrom) },
        { id: 'template', label: 'Approved WhatsApp template added ({{1}} first name, {{2}} message)', done: Boolean(i.contentSid) },
      ]),
  ];
  return { items, ready: items.every((x) => x.done) };
}

/** The address to paste into the Twilio number's "A message comes in" setting. */
export function inboundWebhookUrl(base: string | undefined, token: string | null): string | null {
  if (!base || !token || !/^https?:\/\//.test(base) || !/^[0-9a-f]{64}$/.test(token)) return null;
  return `${base.replace(/\/+$/, '')}/webhook/twilio/${token}`;
}
