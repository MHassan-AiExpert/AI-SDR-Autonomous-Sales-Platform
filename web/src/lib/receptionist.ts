// Inbound AI receptionist settings.

import { z } from 'zod';

const vapiId = (what: string) => z.string().trim().toLowerCase().regex(/^[0-9a-f-]{36}$/, `Copy the ${what} ID from Vapi; it looks like 1a2b3c4d-…`);

export const receptionistSettingsSchema = z.object({
  vapi_receptionist_assistant_id: vapiId('receptionist assistant'),
  vapi_inbound_number_id: vapiId('phone number'),
  receptionist_transfer_number: z.union([z.literal('').transform(() => null), z.string().trim().regex(/^\+[1-9][0-9]{6,14}$/, 'Enter the team number with its country code, like +15125550199')]),
  receptionist_notes: z.string().trim().max(2000, 'Notes can be up to 2000 characters').transform((v) => v || null),
});

export function parseReceptionistSettings(form: FormData) {
  return receptionistSettingsSchema.safeParse({
    vapi_receptionist_assistant_id: form.get('vapi_receptionist_assistant_id') ?? '',
    vapi_inbound_number_id: form.get('vapi_inbound_number_id') ?? '',
    receptionist_transfer_number: form.get('receptionist_transfer_number') ?? '',
    receptionist_notes: form.get('receptionist_notes') ?? '',
  });
}

export type ReceptionistReadinessInput = {
  vapiConnected: boolean; voiceChannelOn: boolean; assistantId: string | null; numberId: string | null; webhookReady: boolean;
  transferNumber: string | null; smsSender: string | null; calendlyConnected: boolean;
};

export function receptionistReadiness(i: ReceptionistReadinessInput) {
  const required = [
    { id: 'vapi', label: 'Vapi connected in Setup', done: i.vapiConnected },
    { id: 'channel', label: 'AI voice calls switched on in Settings', done: i.voiceChannelOn },
    { id: 'assistant', label: 'Receptionist assistant chosen in Vapi (its voice answers your calls)', done: Boolean(i.assistantId) },
    { id: 'number', label: 'Phone number chosen; in Vapi, set its server URL to the Vapi address shown below and leave its assistant empty', done: Boolean(i.numberId) },
    { id: 'webhook', label: 'Public webhook address set (NEXT_PUBLIC_WEBHOOK_BASE_URL)', done: i.webhookReady },
  ];
  const optional = [
    { id: 'transfer', label: 'Team number: callers who ask for a person are put through, and calls go there while the receptionist is off', done: Boolean(i.transferNumber) },
    { id: 'booking', label: 'Booking links by text: Calendly connected and an SMS sender set under Text follow-ups', done: i.calendlyConnected && Boolean(i.smsSender) },
  ];
  return { required, optional, ready: required.every((x) => x.done) };
}

export function vapiServerUrl(base: string | undefined, token: string | null): string | null {
  if (!base || !token || !/^https?:\/\//.test(base) || !/^[0-9a-f]{64}$/.test(token)) return null;
  return `${base.replace(/\/+$/, '')}/webhook/vapi/${token}`;
}
