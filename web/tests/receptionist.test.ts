import { describe, expect, test } from 'vitest';
import { parseReceptionistSettings, receptionistReadiness, vapiServerUrl } from '@/lib/receptionist';
import { OUTCOME_LABELS } from '@/lib/voice';

const form = (over: Record<string, string> = {}) => {
  const f = new FormData();
  for (const [k, v] of Object.entries({
    vapi_receptionist_assistant_id: '55555555-5555-4555-8555-555555555555', vapi_inbound_number_id: '44444444-4444-4444-8444-444444444444',
    receptionist_transfer_number: '+15125550199', receptionist_notes: ' Open 9 to 5 ', ...over,
  })) f.set(k, v);
  return f;
};
const err = (over: Record<string, string>) => { const r = parseReceptionistSettings(form(over)); return r.success ? null : r.error.issues[0].message; };

describe('AI receptionist settings', () => {
  test('RW-01 valid settings are parsed; empty optional fields are saved as empty', () => {
    const r = parseReceptionistSettings(form());
    expect(r.success && r.data).toEqual({ vapi_receptionist_assistant_id: '55555555-5555-4555-8555-555555555555', vapi_inbound_number_id: '44444444-4444-4444-8444-444444444444', receptionist_transfer_number: '+15125550199', receptionist_notes: 'Open 9 to 5' });
    const empty = parseReceptionistSettings(form({ receptionist_transfer_number: '', receptionist_notes: '' }));
    expect(empty.success && empty.data).toMatchObject({ receptionist_transfer_number: null, receptionist_notes: null });
  });

  test('RW-02 bad ids, numbers and long notes get one clear message each', () => {
    expect(err({ vapi_receptionist_assistant_id: 'x' })).toMatch(/receptionist assistant ID from Vapi/);
    expect(err({ vapi_inbound_number_id: 'x' })).toMatch(/phone number ID from Vapi/);
    expect(err({ receptionist_transfer_number: '5125550199' })).toMatch(/country code/);
    expect(err({ receptionist_notes: 'x'.repeat(2001) })).toBe('Notes can be up to 2000 characters');
  });

  test('RW-03 the checklist separates what is required from what is optional', () => {
    const ok = { vapiConnected: true, voiceChannelOn: true, assistantId: 'a', numberId: 'n', webhookReady: true, transferNumber: null, smsSender: null, calendlyConnected: false };
    expect(receptionistReadiness(ok).ready).toBe(true);
    for (const k of ['vapiConnected', 'voiceChannelOn', 'webhookReady'] as const) expect(receptionistReadiness({ ...ok, [k]: false }).ready).toBe(false);
    expect(receptionistReadiness({ ...ok, numberId: null }).ready).toBe(false);
    expect(receptionistReadiness({ ...ok, calendlyConnected: true }).optional.find((i) => i.id === 'booking')!.done).toBe(false);
    expect(receptionistReadiness({ ...ok, calendlyConnected: true, smsSender: '+15125550100' }).optional.find((i) => i.id === 'booking')!.done).toBe(true);
  });

  test('RW-04 the Vapi server address and inbound outcome labels', () => {
    const tok = 'b'.repeat(64);
    expect(vapiServerUrl('https://n8n.example.com/', tok)).toBe(`https://n8n.example.com/webhook/vapi/${tok}`);
    expect(vapiServerUrl(undefined, tok)).toBeNull();
    expect(vapiServerUrl('https://n8n.example.com', null)).toBeNull();
    for (const o of ['answered', 'transferred', 'spam']) expect(OUTCOME_LABELS[o]).toBeTruthy();
  });
});
