// Twilio Programmable Messaging: SMS and WhatsApp from the company's own
// number, plus checking that webhooks really came from Twilio.

import { createHmac, timingSafeEqual } from 'node:crypto';
import { ProviderError, describeStatus, isObject, str, type Fetch } from '../http.ts';

export type TwilioCreds = { accountSid: string; authToken: string };

export class TwilioError extends ProviderError {
  readonly code: string | null;
  constructor(status: number | null, code: string | null, message: string) {
    super('Twilio', status, message);
    this.code = code;
  }
}

// Twilio error codes that say something about the recipient, worded for people
const CODE_MESSAGES: Record<string, string> = {
  '21610': 'The recipient has replied STOP to this number',
  '21211': 'The number is not a valid phone number',
  '21614': 'The number cannot receive text messages',
  '21408': 'Texting this country is not enabled on the Twilio account',
  '21606': 'The sending number cannot send text messages',
  '63016': 'WhatsApp only allows free text within 24 hours of the prospect\'s last message',
  '63018': 'WhatsApp is rate limiting this sender',
};
/** Codes after which the number must never be texted again. */
export const OPTED_OUT_CODES: ReadonlySet<string> = new Set(['21610']);

export function twilioMessage(code: string | null, status: number | null): string {
  if (code && CODE_MESSAGES[code]) return CODE_MESSAGES[code];
  if (status) return describeStatus('Twilio', status);
  return 'Twilio did not accept the message';
}

export type OutboundMessage = {
  channel: 'sms' | 'whatsapp';
  to: string;
  /** E.164 number, or a Messaging Service SID for SMS */
  from: string;
  body?: string;
  contentSid?: string;
  contentVariables?: Record<string, string>;
  statusCallback?: string;
};

export function messageForm(m: OutboundMessage): URLSearchParams {
  const p = new URLSearchParams();
  const wa = m.channel === 'whatsapp';
  p.set('To', wa ? `whatsapp:${m.to}` : m.to);
  if (!wa && m.from.startsWith('MG')) p.set('MessagingServiceSid', m.from);
  else p.set('From', wa ? `whatsapp:${m.from}` : m.from);
  if (m.contentSid) {
    p.set('ContentSid', m.contentSid);
    p.set('ContentVariables', JSON.stringify(m.contentVariables ?? {}));
  } else {
    p.set('Body', m.body ?? '');
  }
  if (m.statusCallback) p.set('StatusCallback', m.statusCallback);
  return p;
}

export async function sendMessage(creds: TwilioCreds, m: OutboundMessage, fetchImpl: Fetch = fetch): Promise<{ sid: string; status: string }> {
  const auth = Buffer.from(`${creds.accountSid}:${creds.authToken}`).toString('base64');
  let res: Response;
  try {
    res = await fetchImpl(`https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(creds.accountSid)}/Messages.json`, {
      method: 'POST',
      headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: messageForm(m).toString(),
      redirect: 'error',
      signal: AbortSignal.timeout(30_000),
    });
  } catch (err) {
    const timedOut = err instanceof Error && err.name === 'TimeoutError';
    throw new TwilioError(null, null, timedOut ? 'Twilio did not respond in time' : 'Could not reach Twilio');
  }
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    /* handled below */
  }
  if (!res.ok) {
    // Only Twilio's numeric code is read from an error; its text is never passed on
    const code = isObject(body) && (typeof body.code === 'number' || typeof body.code === 'string') ? String(body.code) : null;
    throw new TwilioError(res.status, code && /^\d{1,6}$/.test(code) ? code : null, twilioMessage(code, res.status));
  }
  const sid = isObject(body) ? str(body.sid) : undefined;
  if (!sid || !/^(SM|MM)[0-9a-f]{32}$/.test(sid)) throw new TwilioError(res.status, null, 'Twilio did not return a message id');
  return { sid, status: (isObject(body) && str(body.status)) || 'queued' };
}

// ---------------------------------------------------------------- webhooks

export function parseForm(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of new URLSearchParams(raw)) out[k] = v;
  return out;
}

/** Twilio's X-Twilio-Signature: HMAC-SHA1 of the URL followed by every POST field, sorted by name. */
export function twilioSignature(authToken: string, url: string, params: Record<string, string>): string {
  const data = url + Object.keys(params).sort().map((k) => k + params[k]).join('');
  return createHmac('sha1', authToken).update(data, 'utf8').digest('base64');
}

export function verifyTwilioSignature(authToken: string, url: string, params: Record<string, string>, signature: string): boolean {
  if (!signature || signature.length > 200) return false;
  const expected = Buffer.from(twilioSignature(authToken, url, params));
  const given = Buffer.from(signature);
  return expected.length === given.length && timingSafeEqual(expected, given);
}

/** "whatsapp:+447700900123" or "+447700900123" to "+447700900123"; anything else to null. */
export function plainNumber(v: string | undefined): string | null {
  const n = (v ?? '').replace(/^whatsapp:/i, '').trim();
  return /^\+[1-9]\d{6,14}$/.test(n) ? n : null;
}
