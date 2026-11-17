// Hunter: people at a company domain (Domain Search) and one person's work
// email from their name (Email Finder). The key travels in the X-API-KEY
// header, never in the URL, so it cannot end up in a log line.
//
// Documented behaviour this relies on (hunter.io/api-documentation/v2):
//   - Domain Search returns 200 with data.emails = [] when nothing is known
//   - 401 is a bad key, 403 is the rate limit, 429 is the plan's usage limit
//   - Email Finder does not charge when no email is found

import { ProviderError, requestJson, isObject, str, num, type Fetch } from '../http.ts';
import type { LeadCandidate } from '../leads.ts';

const BASE = 'https://api.hunter.io/v2';
const headers = (apiKey: string) => ({ 'X-API-KEY': apiKey });

/** Hunter answers 403 for its rate limit, which must not read as a bad key. */
async function hunterJson(url: string, apiKey: string, fetchImpl?: Fetch): Promise<unknown> {
  try {
    return await requestJson('Hunter', url, { method: 'GET', headers: headers(apiKey) }, { fetchImpl, timeoutMs: 30_000 });
  } catch (err) {
    if (err instanceof ProviderError && err.status === 403) throw new ProviderError('Hunter', 429, 'Hunter is rate limiting requests');
    if (err instanceof ProviderError && err.status === 429) throw new ProviderError('Hunter', 402, 'Hunter reports the plan\'s usage limit is reached');
    throw err;
  }
}

/** Lower is better: a title the campaign asked for, then a decision maker, then an executive. */
export function rankPerson(position: string | undefined, decisionMaker: boolean, seniority: string | undefined, titles: string[]): number | null {
  const p = (position ?? '').toLowerCase();
  if (p && titles.some((t) => t && p.includes(t.toLowerCase()))) return 0;
  if (decisionMaker) return 1;
  if (seniority === 'executive') return 2;
  return null;
}

export async function hunterDomainPeople(
  domain: string,
  titles: string[],
  apiKey: string,
  options: { perCompany: number; fetchImpl?: Fetch },
): Promise<{ people: LeadCandidate[]; searched: boolean }> {
  const q = new URLSearchParams({ domain, type: 'personal', limit: '10' });
  const body = await hunterJson(`${BASE}/domain-search?${q}`, apiKey, options.fetchImpl);
  const data = isObject(body) && isObject(body.data) ? body.data : {};
  const emails = Array.isArray(data.emails) ? data.emails : [];
  const ranked = emails
    .filter(isObject)
    .map((e) => ({
      e,
      rank: rankPerson(str(e.position), e.decision_maker === true, str(e.seniority), titles),
      confidence: num(e.confidence) ?? 0,
    }))
    // Anyone Hunter is unsure of, or who is not someone the campaign wants to reach, is left out
    .filter((x) => x.rank !== null && str(x.e.value) && x.confidence >= 50)
    .sort((a, b) => a.rank! - b.rank! || b.confidence - a.confidence)
    .slice(0, options.perCompany);
  const people = ranked.map(({ e }) => ({
    source: 'manual' as const,
    sourceQuery: `Hunter decision maker at ${domain}`,
    fullName: [str(e.first_name), str(e.last_name)].filter(Boolean).join(' ') || undefined,
    title: str(e.position),
    email: str(e.value),
    phone: str(e.phone_number),
    linkedinUrl: str(e.linkedin),
    company: { name: str(data.organization) ?? domain, domain },
  }));
  return { people, searched: emails.length > 0 };
}

/**
 * A named person's work email. Only addresses Hunter is reasonably sure of
 * are returned; every address is still verified by ZeroBounce before sending.
 */
export async function hunterFindEmail(fullName: string, domain: string, apiKey: string, fetchImpl?: Fetch): Promise<string | undefined> {
  const q = new URLSearchParams({ domain, full_name: fullName });
  let body: unknown;
  try {
    body = await hunterJson(`${BASE}/email-finder?${q}`, apiKey, fetchImpl);
  } catch (err) {
    // 400 is a domain Hunter cannot search (for example no mail server), 404 is no one found
    if (err instanceof ProviderError && (err.status === 400 || err.status === 404 || err.status === 422)) return undefined;
    throw err;
  }
  const data = isObject(body) && isObject(body.data) ? body.data : {};
  const email = str(data.email);
  const score = num(data.score) ?? 0;
  const status = isObject(data.verification) ? str(data.verification.status) : undefined;
  return email && (score >= 70 || status === 'valid') ? email : undefined;
}
