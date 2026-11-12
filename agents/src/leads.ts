// The shape every source adapter returns, and the shared helpers to merge,
// de-duplicate and check them before they are stored.

import { normalizeEmail, normalizePhone, domainFromUrl, normalizeInstagramHandle, normalizeLinkedinUrl, cleanText } from './normalize.ts';

export type SourceChannel = 'apollo' | 'google_maps' | 'instagram' | 'llm_search';

export type CompanyCandidate = {
  name: string;
  domain?: string;
  industry?: string;
  sizeBand?: string;
  location?: string;
  googleRating?: number;
  googleReviews?: number;
  social?: Record<string, string>;
};

export type LeadCandidate = {
  source: SourceChannel;
  sourceQuery: string;
  fullName?: string;
  title?: string;
  email?: string;
  phone?: string;
  linkedinUrl?: string;
  socialHandles?: Record<string, string>;
  company: CompanyCandidate;
};

export type SourceResult = { leads: LeadCandidate[]; found: number; creditsUsed?: number; notes?: string[] };

/** Applies the normalisers so all later comparisons are like for like. */
export function normalizeCandidate(c: LeadCandidate): LeadCandidate {
  const social: Record<string, string> = {};
  for (const [k, v] of Object.entries(c.socialHandles ?? {})) {
    const value = k === 'instagram' ? normalizeInstagramHandle(v) : cleanText(v, 300);
    if (value) social[k] = value;
  }
  const companySocial: Record<string, string> = {};
  for (const [k, v] of Object.entries(c.company.social ?? {})) {
    const value = cleanText(v, 300);
    if (value) companySocial[k] = value;
  }
  return {
    source: c.source,
    sourceQuery: cleanText(c.sourceQuery, 300) ?? '',
    fullName: cleanText(c.fullName, 160),
    title: cleanText(c.title, 160),
    email: normalizeEmail(c.email),
    phone: normalizePhone(c.phone),
    linkedinUrl: normalizeLinkedinUrl(c.linkedinUrl),
    socialHandles: social,
    company: {
      name: cleanText(c.company.name, 200) ?? 'Unknown company',
      domain: domainFromUrl(c.company.domain),
      industry: cleanText(c.company.industry, 120),
      sizeBand: cleanText(c.company.sizeBand, 40),
      location: cleanText(c.company.location, 200),
      googleRating: c.company.googleRating !== undefined && c.company.googleRating >= 0 && c.company.googleRating <= 5
        ? Math.round(c.company.googleRating * 10) / 10 : undefined,
      googleReviews: c.company.googleReviews !== undefined && c.company.googleReviews >= 0 ? Math.floor(c.company.googleReviews) : undefined,
      social: companySocial,
    },
  };
}

export function hasContact(c: LeadCandidate): boolean {
  return Boolean(c.email || c.phone || c.linkedinUrl || Object.keys(c.socialHandles ?? {}).length);
}

/** Keys that identify the same person or business across sources. */
export function identityKeys(c: LeadCandidate): string[] {
  const keys: string[] = [];
  if (c.email) keys.push(`email:${c.email}`);
  if (c.phone) keys.push(`phone:${c.phone.replace(/^\+/, '')}`);
  if (c.linkedinUrl) keys.push(`linkedin:${c.linkedinUrl}`);
  if (c.socialHandles?.instagram) keys.push(`instagram:${c.socialHandles.instagram}`);
  // A business without a named person is the same lead as any other
  // nameless record for that domain.
  if (!c.fullName && c.company.domain) keys.push(`domain:${c.company.domain}`);
  return keys;
}

export type ExistingKeys = Set<string>;

export type DedupeOutcome = { fresh: LeadCandidate[]; duplicates: number };

/**
 * Removes candidates already in `seen` (stored leads, or earlier candidates
 * in this run). Adds the keys of kept candidates to `seen`, so one set can be
 * shared across every source of a run.
 */
export function dedupe(candidates: LeadCandidate[], seen: ExistingKeys): DedupeOutcome {
  const fresh: LeadCandidate[] = [];
  let duplicates = 0;
  for (const c of candidates) {
    const keys = identityKeys(c);
    if (keys.some((k) => seen.has(k))) {
      duplicates++;
      continue;
    }
    keys.forEach((k) => seen.add(k));
    fresh.push(c);
  }
  return { fresh, duplicates };
}

export type Suppressions = { emails: Set<string>; phones: Set<string>; domains: Set<string> };

export function isSuppressed(c: LeadCandidate, s: Suppressions): boolean {
  if (c.email && (s.emails.has(c.email) || s.domains.has(c.email.split('@')[1]))) return true;
  if (c.phone && (s.phones.has(c.phone) || s.phones.has(c.phone.replace(/^\+/, '')))) return true;
  if (c.company.domain && s.domains.has(c.company.domain)) return true;
  return false;
}
