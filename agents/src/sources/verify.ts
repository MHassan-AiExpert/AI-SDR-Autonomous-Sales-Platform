// Email verification (ZeroBounce) and phone line type (Twilio Lookup v2).

import { requestJson, isObject, str, ProviderError, type Fetch } from '../http.ts';

export type EmailVerdict = 'valid' | 'invalid' | 'catch_all' | 'risky';

/** ZeroBounce status to the lead's verification status (SRS FR-3.2). */
export function mapZeroBounceStatus(status: string | undefined): EmailVerdict {
  switch ((status ?? '').toLowerCase()) {
    case 'valid': return 'valid';
    case 'catch-all': return 'catch_all';
    case 'invalid': case 'spamtrap': case 'abuse': case 'do_not_mail': return 'invalid';
    default: return 'risky';
  }
}

export async function verifyEmail(email: string, apiKey: string, fetchImpl?: Fetch): Promise<{ verdict: EmailVerdict; raw: string }> {
  const url = `https://api.zerobounce.net/v2/validate?api_key=${encodeURIComponent(apiKey)}&email=${encodeURIComponent(email)}&ip_address=`;
  const body = await requestJson('ZeroBounce', url, { method: 'GET' }, { fetchImpl, timeoutMs: 30_000 });
  if (isObject(body) && typeof body.error === 'string') {
    // ZeroBounce answers 200 with an error message for bad keys and empty credits
    throw new ProviderError('ZeroBounce', /credit/i.test(body.error) ? 402 : 401,
      /credit/i.test(body.error) ? 'ZeroBounce reports the account is out of credits or needs a plan upgrade' : 'ZeroBounce rejected the stored credentials');
  }
  const raw = isObject(body) ? str(body.status) ?? 'unknown' : 'unknown';
  return { verdict: mapZeroBounceStatus(raw), raw };
}

export type LineType = 'mobile' | 'landline' | 'voip' | 'unknown';

export function mapLineType(type: string | undefined): LineType {
  switch (type) {
    case 'mobile': case 'personal': return 'mobile';
    case 'landline': return 'landline';
    case 'fixedVoip': case 'nonFixedVoip': return 'voip';
    default: return 'unknown';
  }
}

export type PhoneCheck = { valid: boolean; e164?: string; country?: string; lineType: LineType };

export async function lookupPhone(phone: string, accountSid: string, authToken: string, fetchImpl?: Fetch): Promise<PhoneCheck> {
  const url = `https://lookups.twilio.com/v2/PhoneNumbers/${encodeURIComponent(phone)}?Fields=line_type_intelligence`;
  const auth = Buffer.from(`${accountSid}:${authToken}`).toString('base64');
  let body: unknown;
  try {
    body = await requestJson('Twilio', url, { method: 'GET', headers: { Authorization: `Basic ${auth}` } }, { fetchImpl, timeoutMs: 20_000 });
  } catch (err) {
    if (err instanceof ProviderError && err.status === 404) return { valid: false, lineType: 'unknown' };
    throw err;
  }
  if (!isObject(body)) return { valid: false, lineType: 'unknown' };
  const lti = isObject(body.line_type_intelligence) ? body.line_type_intelligence : {};
  const country = str(body.country_code);
  return {
    valid: body.valid === true,
    e164: str(body.phone_number),
    country: country && /^[A-Z]{2}$/.test(country) ? country : undefined,
    lineType: mapLineType(str(lti.type)),
  };
}
