// ipapi.is (F30): which organisation an IP address belongs to.
//
// Request and response taken from ipapi.is's developer documentation:
// POST https://api.ipapi.is with {"q": <ip>, "key": <key>} (the documented
// POST form, so the key is never part of a URL), returning boolean network flags
// (is_bogon, is_mobile, is_satellite, is_crawler, is_datacenter, is_tor,
// is_proxy, is_vpn), a `company` object from the most specific WHOIS record
// (name, domain, type: hosting, isp, education, government, banking or
// business) and `location.country_code`. A bad key answers 403
// (ERR_FORBIDDEN_INVALID_API_KEY); a used-up quota 429 (ERR_QUOTA_EXCEEDED).

import { isObject, requestJson, str, type Fetch } from '../http.ts';

export async function lookupIp(key: string, ip: string, fetchImpl?: Fetch): Promise<Record<string, unknown>> {
  const res = await requestJson('ipapi.is', 'https://api.ipapi.is', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ q: ip, key }),
  }, { fetchImpl, timeoutMs: 10_000 });
  return isObject(res) ? res : {};
}

const DOMAIN = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/;
/** Organisation types that are a company someone could sell to; ISPs and hosting are not */
export const ORG_TYPES = new Set(['business', 'banking', 'education', 'government']);

export type Identified = { company: { domain: string; name: string | null; country: string | null } } | { skip: string };

/**
 * Whether a lookup names a company. Anything that could be a person at home,
 * on a phone, behind a VPN, or a bot, is discarded rather than guessed at.
 */
export function identify(r: Record<string, unknown>): Identified {
  const flags: [string, string][] = [
    ['is_bogon', 'private network'], ['is_crawler', 'crawler'], ['is_tor', 'VPN or proxy'], ['is_proxy', 'VPN or proxy'],
    ['is_vpn', 'VPN or proxy'], ['is_datacenter', 'data centre'], ['is_mobile', 'mobile network'], ['is_satellite', 'satellite network'],
  ];
  for (const [k, reason] of flags) if (r[k] === true) return { skip: reason };
  const c = isObject(r.company) ? r.company : null;
  if (!c) return { skip: 'no organisation' };
  const type = str(c.type)?.toLowerCase();
  if (!type || !ORG_TYPES.has(type)) return { skip: type === 'isp' ? 'home or office internet provider' : type === 'hosting' ? 'data centre' : 'not a company network' };
  const domain = str(c.domain)?.trim().toLowerCase().replace(/^www\./, '');
  if (!domain || !DOMAIN.test(domain)) return { skip: 'no company domain' };
  const loc = isObject(r.location) ? r.location : null;
  const cc = str(loc?.country_code)?.toUpperCase();
  return { company: { domain, name: str(c.name)?.trim().slice(0, 200) || null, country: cc && /^[A-Z]{2}$/.test(cc) ? cc : null } };
}
