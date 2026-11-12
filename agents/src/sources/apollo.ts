// Apollo: people search (free, no emails) then bulk enrichment for contact
// details, ten people per call. Enrichment spends the company's Apollo credits,
// so only as many people as the daily limit allows are enriched.

import { requestJson, isObject, str, type Fetch } from '../http.ts';
import type { LeadCandidate, SourceResult } from '../leads.ts';
import type { SourcePlan } from '../plan.ts';

const BASE = 'https://api.apollo.io/api/v1';

export function apolloSearchUrl(plan: SourcePlan['apollo'], page: number, perPage: number): string {
  const q = new URLSearchParams();
  plan.person_titles.forEach((t) => q.append('person_titles[]', t));
  plan.person_locations.forEach((l) => q.append('person_locations[]', l));
  plan.employee_ranges.forEach((r) => q.append('organization_num_employees_ranges[]', r));
  if (plan.keywords) q.set('q_keywords', plan.keywords);
  q.set('page', String(page));
  q.set('per_page', String(perPage));
  return `${BASE}/mixed_people/api_search?${q}`;
}

type Person = Record<string, unknown>;

function toCandidate(p: Person, query: string): LeadCandidate {
  const org = isObject(p.organization) ? p.organization : {};
  const name = str(p.name) ?? [str(p.first_name), str(p.last_name)].filter(Boolean).join(' ');
  const phones = Array.isArray(p.phone_numbers) ? p.phone_numbers : [];
  const phone = phones.map((x) => (isObject(x) ? str(x.sanitized_number) ?? str(x.raw_number) : undefined)).find(Boolean)
    ?? (isObject(org.primary_phone) ? str(org.primary_phone.sanitized_number) : undefined);
  const location = [str(p.city), str(p.state), str(p.country)].filter(Boolean).join(', ');
  return {
    source: 'apollo',
    sourceQuery: query,
    fullName: name || undefined,
    title: str(p.title),
    email: str(p.email),
    phone,
    linkedinUrl: str(p.linkedin_url),
    company: {
      name: str(org.name) ?? 'Unknown company',
      domain: str(org.primary_domain) ?? str(org.website_url),
      industry: str(org.industry),
      sizeBand: typeof org.estimated_num_employees === 'number' ? String(org.estimated_num_employees) : undefined,
      location: location || undefined,
      social: Object.fromEntries(
        [['linkedin', str(org.linkedin_url)], ['facebook', str(org.facebook_url)], ['twitter', str(org.twitter_url)]]
          .filter((e): e is [string, string] => Boolean(e[1]))),
    },
  };
}

export async function sourceApollo(
  plan: SourcePlan['apollo'],
  apiKey: string,
  limit: number,
  fetchImpl?: Fetch,
): Promise<SourceResult> {
  const headers = { 'x-api-key': apiKey, 'Content-Type': 'application/json', 'Cache-Control': 'no-cache' };
  const query = [plan.person_titles.join(', '), plan.person_locations.join(', ')].filter(Boolean).join(' in ');
  const ids = new Set<string>();
  const perPage = Math.min(100, Math.max(10, limit));
  let found = 0;
  for (let page = 1; ids.size < limit && page <= 5; page++) {
    const body = await requestJson('Apollo', apolloSearchUrl(plan, page, perPage), { method: 'POST', headers }, { fetchImpl });
    const people = isObject(body) && Array.isArray(body.people) ? body.people : [];
    if (page === 1 && isObject(body) && typeof body.total_entries === 'number') found = body.total_entries;
    for (const p of people) {
      const id = isObject(p) ? str(p.id) : undefined;
      if (id && ids.size < limit) ids.add(id);
    }
    // A short page is the last page
    if (people.length < perPage) break;
  }
  if (!found) found = ids.size;

  const leads: LeadCandidate[] = [];
  let creditsUsed = 0;
  const idList = [...ids];
  for (let i = 0; i < idList.length; i += 10) {
    const chunk = idList.slice(i, i + 10);
    const body = await requestJson('Apollo', `${BASE}/people/bulk_match?reveal_personal_emails=false&reveal_phone_number=false`, {
      method: 'POST', headers, body: JSON.stringify({ details: chunk.map((id) => ({ id })) }),
    }, { fetchImpl });
    const matches = isObject(body) && Array.isArray(body.matches) ? body.matches : [];
    for (const m of matches) if (isObject(m)) leads.push(toCandidate(m, query));
    creditsUsed += isObject(body) && typeof body.credits_consumed === 'number' ? body.credits_consumed : chunk.length;
  }
  return { leads, found, creditsUsed };
}
