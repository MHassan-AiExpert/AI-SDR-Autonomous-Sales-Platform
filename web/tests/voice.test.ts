import { describe, expect, it } from 'vitest';
import { parseVoiceSettings, voiceReadiness, safeRecordingUrl, OUTCOME_LABELS, CONSENT_BASES, CONSENT_LABELS } from '@/lib/voice';
import { describeJobResult } from '@/lib/campaigns';

const form = (over: Record<string, string | null> = {}) => {
  const f = new FormData();
  const base: Record<string, string | null> = {
    vapi_assistant_id: '11111111-1111-4111-8111-111111111111', vapi_phone_number_id: '22222222-2222-4222-8222-222222222222',
    call_timezone: 'America/Chicago', call_window_start: '10:00', call_window_end: '16:00', call_day_1: 'on', call_day_2: 'on',
    call_daily_limit: '30', call_max_attempts: '2', call_rule: 'consent_only', ...over,
  };
  for (const [k, v] of Object.entries(base)) if (v !== null) f.set(k, v);
  return f;
};
const err = (over: Record<string, string | null>) => { const r = parseVoiceSettings(form(over)); return r.success ? null : r.error.issues[0].message; };

describe('calling settings', () => {
  it('VW-01 valid settings are parsed', () => {
    const r = parseVoiceSettings(form());
    expect(r.success && r.data).toMatchObject({ call_rule: 'consent_only', attest: false, call_daily_limit: 30, call_days: { 1: true, 2: true, 3: false } });
  });

  it('VW-02 calling business landlines requires the registry confirmation', () => {
    expect(err({ call_rule: 'consent_or_business_landline' })).toBe('To call business landlines, confirm the numbers were screened against Do Not Call registries');
    expect(err({ call_rule: 'consent_or_business_landline', attest: 'on' })).toBeNull();
    expect(err({ call_rule: 'everyone' })).toBe('Choose who may be called');
  });

  it('VW-03 each mistake gives a clear message', () => {
    expect(err({ vapi_assistant_id: 'abc' })).toBe('Copy the ID from Vapi; it looks like 1a2b3c4d-…');
    expect(err({ call_window_start: '17:00' })).toBe('The calling window must end after it starts');
    expect(err({ call_day_1: null, call_day_2: null })).toBe('Choose at least one calling day');
    expect(err({ call_max_attempts: '9' })).toBe('Attempts must be 1 to 5');
    expect(err({ call_timezone: 'Mars/Base' })).toBe('Choose a time zone');
  });

  it('VW-04 launch needs Vapi, the voice channel, an assistant and a number', () => {
    const ok = { vapiConnected: true, voiceChannelOn: true, assistantId: 'a', phoneNumberId: 'p' };
    expect(voiceReadiness(ok).ready).toBe(true);
    for (const patch of [{ vapiConnected: false }, { voiceChannelOn: false }, { assistantId: null }, { phoneNumberId: null }]) expect(voiceReadiness({ ...ok, ...patch }).ready).toBe(false);
  });

  it('VW-05 labels, recording links and call results', () => {
    for (const o of ['interested', 'callback', 'do_not_call', 'voicemail']) expect(OUTCOME_LABELS[o]).toBeTruthy();
    for (const b of CONSENT_BASES) expect(CONSENT_LABELS[b]).toBeTruthy();
    expect(safeRecordingUrl('https://storage.vapi.ai/x.wav')).toBe('https://storage.vapi.ai/x.wav');
    expect(safeRecordingUrl('javascript:alert(1)')).toBeNull();
    expect(describeJobResult('voice_outreach', 'succeeded', { calls_started: 2, failed: 0, reasons: { 'no recorded consent to be called': 3 } }, null))
      .toBe('2 calls started; not called: 3 no recorded consent to be called.');
    expect(describeJobResult('voice_outreach', 'succeeded', { calls_started: 0, note: 'Outside calling hours; calls continue in the next calling window.' }, null)).toMatch(/Outside calling hours/);
  });
});
