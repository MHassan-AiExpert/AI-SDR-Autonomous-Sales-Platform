// People Data Labs: Person Search by company website and seniority.
//
// Documented behaviour this relies on (docs.peopledatalabs.com):
//   - POST /v5/person/search with a JSON body { query, size }, key in X-Api-Key
//   - Every record returned is billed, so `size` is the spending cap
//   - No match is reported as 404 or as total = 0; both mean "nobody found"
//   - 402 means the account's credits are used up
//   - Free plans return contact fields as true/false instead of values
//
// Only the work email is used. Personal addresses are not used for outreach.

import { ProviderError, requestJson, isObject, str, type Fetch } from '../http.ts';
import type { LeadCandidate } from '../leads.ts';

const URL_SEARCH = 'https://api.peopledatalabs.com/v5/person/search';
export const PDL_LEVELS = ['owner', 'cxo', 'partner', 'vp', 'director'];

export function pdlQuery(domains: string[], titles: string[]) {
  return {
    bool: {
      must: [{ terms: { job_company_website: domains } }],
      should: [
        { terms: { job_title_levels: PDL_LEVELS } },
        ...titles.slice(0, 10).map((t) => ({ match_phrase: { job_title: t.toLowerCase() } })),
      ],
      minimum_should_match: 1,
    },
  };
}

const bareDomain = (v: string | undefined) => v?.toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/.*$/, '');

export async function pdlFindPeople(
  domains: string[],
  titles: string[],
  apiKey: string,
  options: { perCompany: number; budget: number; fetchImpl?: Fetch },
): Promise<{ byDomain: Map<string, LeadCandidate[]>; creditsUsed: number; contactsHidden: boolean }> {
  const byDomain = new Map<string, LeadCandidate[]>();
  const wanted = new Set(domains);
  let creditsUsed = 0;
  let contactsHidden = false;
  for (let i = 0; i < domains.length && creditsUsed < options.budget; i += 10) {
    const chunk = domains.slice(i, i + 10);
    const size = Math.max(1, Math.min(100, chunk.length * options.perCompany, options.budget - creditsUsed));
    let body: unknown;
    try {
      body = await requestJson('People Data Labs', URL_SEARCH, {
        method: 'POST',
        headers: { 'X-Api-Key': apiKey, 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: pdlQuery(chunk, titles), size }),
      }, { fetchImpl: options.fetchImpl, timeoutMs: 30_000 });
    } catch (err) {
      if (err instanceof ProviderError && err.status === 404) continue;
      throw err;
    }
    const data = isObject(body) && Array.isArray(body.data) ? body.data.filter(isObject) : [];
    creditsUsed += data.length;
    for (const p of data) {
      const domain = bareDomain(str(p.job_company_website));
      if (!domain || !wanted.has(domain)) continue;
      if (p.work_email === true || p.mobile_phone === true) contactsHidden = true;
      const email = str(p.work_email);
      const phone = str(p.mobile_phone);
      const list = byDomain.get(domain) ?? [];
      if (list.length >= options.perCompany) continue;
      list.push({
        source: 'manual',
        sourceQuery: `People Data Labs decision maker at ${domain}`,
        fullName: str(p.full_name),
        title: str(p.job_title),
        email,
        phone,
        linkedinUrl: str(p.linkedin_url),
        company: { name: str(p.job_company_name) ?? domain, domain },
      });
      byDomain.set(domain, list);
    }
  }
  return { byDomain, creditsUsed, contactsHidden };
}
