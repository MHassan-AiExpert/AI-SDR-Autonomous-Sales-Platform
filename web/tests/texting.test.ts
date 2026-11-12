import { describe, expect, test } from 'vitest';
import { DELIVERY_LABELS, TEXT_CONSENT_BASES, TEXT_CONSENT_LABELS, inboundWebhookUrl, parseTextSettings, textReadiness } from '@/lib/texting';
import { describeJobResult, JOB_LABELS, JOB_TYPES } from '@/lib/campaigns';

const form = (over: Record<string, string> = {}) => {
  const f = new FormData();
  for (const [k, v] of Object.entries({ sms_channel: 'sms', sms_from: '+15125550100', whatsapp_from: '', whatsapp_content_sid: '', sms_after_days: '3', sms_daily_limit: '100', sms_max_messages: '1', ...over })) f.set(k, v);
  return f;
};

describe('text follow-up settings', () => {
  test('TW-01 valid SMS and WhatsApp settings are parsed; empty fields become empty', () => {
    const sms = parseTextSettings(form());
    expect(sms.success && sms.data).toEqual({ sms_channel: 'sms', sms_from: '+15125550100', whatsapp_from: null, whatsapp_content_sid: null, sms_after_days: 3, sms_daily_limit: 100, sms_max_messages: 1 });
    const svc = parseTextSettings(form({ sms_from: 'MG' + 'a'.repeat(32) }));
    expect(svc.success).toBe(true);
    const wa = parseTextSettings(form({ sms_channel: 'whatsapp', sms_from: '', whatsapp_from: '+447700900100', whatsapp_content_sid: 'HX' + 'b'.repeat(32) }));
    expect(wa.success && wa.data).toMatchObject({ sms_channel: 'whatsapp', sms_from: null, whatsapp_from: '+447700900100' });
  });

  test('TW-02 each channel needs its sender; WhatsApp also needs an approved template', () => {
    const msg = (f: FormData) => { const r = parseTextSettings(f); return r.success ? null : r.error.issues[0].message; };
    expect(msg(form({ sms_from: '' }))).toBe('Add the Twilio number or Messaging Service that sends the SMS');
    expect(msg(form({ sms_channel: 'whatsapp', whatsapp_from: '+447700900100' }))).toBe('WhatsApp needs your WhatsApp sender number and an approved template');
    expect(msg(form({ sms_channel: 'telegram' }))).toBe('Choose SMS or WhatsApp');
  });

  test('TW-03 bad numbers, template ids and limits get one clear message each', () => {
    const msg = (over: Record<string, string>) => { const r = parseTextSettings(form(over)); return r.success ? null : r.error.issues[0].message; };
    expect(msg({ sms_from: '5125550100' })).toMatch(/country code/);
    expect(msg({ whatsapp_content_sid: 'template-1' })).toMatch(/starts with HX/);
    expect(msg({ sms_after_days: '0' })).toBe('Wait 1 to 30 days before texting');
    expect(msg({ sms_daily_limit: '9000' })).toBe('Texts per day must be 1 to 5000');
    expect(msg({ sms_max_messages: '4' })).toBe('Texts per lead must be 1 to 3');
  });

  test('TW-04 the launch checklist lists what is missing for the chosen channel', () => {
    const ok = { twilioConnected: true, channel: 'sms' as const, channelOn: true, smsFrom: '+15125550100', whatsappFrom: null, contentSid: null };
    expect(textReadiness(ok).ready).toBe(true);
    expect(textReadiness({ ...ok, twilioConnected: false }).ready).toBe(false);
    expect(textReadiness({ ...ok, channelOn: false }).ready).toBe(false);
    expect(textReadiness({ ...ok, smsFrom: null }).ready).toBe(false);
    const wa = textReadiness({ ...ok, channel: 'whatsapp', whatsappFrom: '+447700900100' });
    expect(wa.ready).toBe(false);
    expect(wa.items.filter((i) => !i.done).map((i) => i.id)).toEqual(['template']);
  });

  test('TW-05 labels, the Twilio address and text run results', () => {
    for (const b of TEXT_CONSENT_BASES) expect(TEXT_CONSENT_LABELS[b]).toBeTruthy();
    for (const s of ['queued', 'sent', 'delivered', 'read', 'failed', 'received']) expect(DELIVERY_LABELS[s]).toBeTruthy();
    const tok = 'a'.repeat(64);
    expect(inboundWebhookUrl('https://n8n.example.com/', tok)).toBe(`https://n8n.example.com/webhook/twilio/${tok}`);
    expect(inboundWebhookUrl(undefined, tok)).toBeNull();
    expect(inboundWebhookUrl('https://n8n.example.com', 'short')).toBeNull();
    expect(JOB_TYPES).toContain('sms_outreach');
    expect(JOB_LABELS.sms_outreach).toBe('Text follow-ups');
    expect(describeJobResult('sms_outreach', 'succeeded', { sent: 3, failed: 1, reasons: { 'no recorded consent to receive texts': 2 } }, null))
      .toBe('3 texts sent, 1 could not be sent; not texted: 2 no recorded consent to receive texts.');
    expect(describeJobResult('sms_outreach', 'succeeded', { sent: 0, note: 'Outside contact hours; texts continue in the next window.' }, null)).toBe('Outside contact hours; texts continue in the next window.');
  });
});
