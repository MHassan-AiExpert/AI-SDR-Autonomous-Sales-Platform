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

export function toCandidate(p: Person, query: string): LeadCandidate {
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
  const headers = apolloHeaders(apiKey);
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

  const { leads, creditsUsed } = await enrichPeople([...ids], query, headers, fetchImpl);
  return { leads, found, creditsUsed };
}

type Headers = Record<string, string>;
const apolloHeaders = (apiKey: string): Headers => ({ 'x-api-key': apiKey, 'Content-Type': 'application/json', 'Cache-Control': 'no-cache' });

/** Bulk enrichment, 10 people per call. Spends Apollo credits. */
async function enrichPeople(ids: string[], query: string, headers: Headers, fetchImpl?: Fetch) {
  const leads: LeadCandidate[] = [];
  let creditsUsed = 0;
  for (let i = 0; i < ids.length; i += 10) {
    const chunk = ids.slice(i, i + 10);
    const body = await requestJson('Apollo', `${BASE}/people/bulk_match?reveal_personal_emails=false&reveal_phone_number=false`, {
      method: 'POST', headers, body: JSON.stringify({ details: chunk.map((id) => ({ id })) }),
    }, { fetchImpl });
    const matches = isObject(body) && Array.isArray(body.matches) ? body.matches : [];
    for (const m of matches) if (isObject(m)) leads.push(toCandidate(m, query));
    creditsUsed += isObject(body) && typeof body.credits_consumed === 'number' ? body.credits_consumed : chunk.length;
  }
  return { leads, creditsUsed };
}

/**
 * Decision makers at known companies (SRS FR-3.1): searches people at the
 * given domains with the campaign's titles, enriches them, and keeps at most
 * `perCompany` people whose current employer is that domain.
 */
export async function findDecisionMakers(
  domains: string[],
  titles: string[],
  apiKey: string,
  options: { perCompany: number; limit: number; fetchImpl?: Fetch },
): Promise<{ byDomain: Map<string, LeadCandidate[]>; creditsUsed: number }> {
  const headers = apolloHeaders(apiKey);
  const byDomain = new Map<string, LeadCandidate[]>();
  let creditsUsed = 0;
  const wanted = new Set(domains);
  for (let i = 0; i < domains.length; i += 25) {
    const chunk = domains.slice(i, i + 25);
    const q = new URLSearchParams();
    chunk.forEach((d) => q.append('q_organization_domains_list[]', d));
    titles.forEach((t) => q.append('person_titles[]', t));
    q.set('page', '1');
    q.set('per_page', String(Math.min(100, chunk.length * options.perCompany * 3)));
    const body = await requestJson('Apollo', `${BASE}/mixed_people/api_search?${q}`, { method: 'POST', headers }, { fetchImpl: options.fetchImpl });
    const people = isObject(body) && Array.isArray(body.people) ? body.people : [];
    const ids = [...new Set(people.map((p) => (isObject(p) ? str(p.id) : undefined)).filter((x): x is string => Boolean(x)))]
      .slice(0, Math.max(0, options.limit - creditsUsed));
    if (!ids.length) continue;
    const { leads, creditsUsed: used } = await enrichPeople(ids, 'decision makers at known companies', headers, options.fetchImpl);
    creditsUsed += used;
    for (const lead of leads) {
      const domain = lead.company.domain?.toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/.*$/, '');
      if (!domain || !wanted.has(domain)) continue; // a former employer
      const list = byDomain.get(domain) ?? [];
      if (list.length < options.perCompany) list.push({ ...lead, sourceQuery: `Apollo decision maker at ${domain}` });
      byDomain.set(domain, list);
    }
    if (creditsUsed >= options.limit) break;
  }
  return { byDomain, creditsUsed };
}

export type OrgDetails = { industry?: string; sizeBand?: string; location?: string; linkedin?: string; phone?: string };

/** Company firmographics by domain. */
export async function enrichOrganization(domain: string, apiKey: string, fetchImpl?: Fetch): Promise<OrgDetails | null> {
  const body = await requestJson('Apollo', `${BASE}/organizations/enrich?domain=${encodeURIComponent(domain)}`, { method: 'GET', headers: apolloHeaders(apiKey) }, { fetchImpl });
  const org = isObject(body) && isObject(body.organization) ? body.organization : null;
  if (!org) return null;
  const location = [str(org.city), str(org.state), str(org.country)].filter(Boolean).join(', ');
  return {
    industry: str(org.industry),
    sizeBand: typeof org.estimated_num_employees === 'number' ? String(org.estimated_num_employees) : undefined,
    location: location || undefined,
    linkedin: str(org.linkedin_url),
    phone: isObject(org.primary_phone) ? str(org.primary_phone.sanitized_number) : str(org.phone),
  };
}
