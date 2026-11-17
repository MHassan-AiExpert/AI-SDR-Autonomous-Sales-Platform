// Waterfall enrichment (F25): asks contact providers one after another, in the
// order the workspace chose, and stops for a company at the first provider
// that finds someone reachable. The company's own website is read last.
//
// Each provider is asked only about the companies the providers before it
// missed, and every answer is recorded, so a provider's match rate is
// measured on exactly the companies it was given.

import { ProviderError, type Fetch } from './http.ts';
import type { LeadCandidate } from './leads.ts';
import { findDecisionMakers } from './sources/apollo.ts';
import { hunterDomainPeople, hunterFindEmail } from './sources/hunter.ts';
import { pdlFindPeople } from './sources/pdl.ts';
import { findSiteContacts, defaultResolver, type Resolver } from './sources/website.ts';
import type { PendingCompany } from './store.ts';

export type ProviderId = 'apollo' | 'hunter' | 'pdl';
export type EnrichmentProvider = ProviderId | 'website';
export const PROVIDERS: ProviderId[] = ['apollo', 'hunter', 'pdl'];
export const PROVIDER_LABELS: Record<EnrichmentProvider, string> = {
  apollo: 'Apollo', hunter: 'Hunter', pdl: 'People Data Labs', website: 'company website',
};

export type Attempt = { companyId: string; provider: EnrichmentProvider; outcome: 'found' | 'no_match' | 'error'; contacts: number };

export type ProviderSummary = { tried: number; found: number; errors: number; credits_used: number; emails_found?: number; error?: string };

type Company = PendingCompany & { domain: string };

export type WaterfallInput = {
  companies: Company[];
  order: ProviderId[];
  keys: Partial<Record<ProviderId, string>>;
  titles: string[];
  perCompany: number;
  /** Most paid lookups any one provider may spend in this run. */
  budget: number;
  /** Stop asking once this many companies have someone to contact. */
  wanted: number;
  concurrency: number;
  fetchImpl?: Fetch;
  resolve?: Resolver;
  mapLimit: <T, R>(items: T[], n: number, fn: (item: T) => Promise<R>) => Promise<R[]>;
};

export type WaterfallResult = {
  found: Map<string, LeadCandidate[]>;
  attempts: Attempt[];
  providers: Partial<Record<EnrichmentProvider, ProviderSummary>>;
  /** Companies a provider failed on without anyone else finding them: retried next run. */
  failed: Set<string>;
  /** Providers whose stored key was refused, to flag on the setup screen. */
  authFailed: Map<ProviderId, string>;
  notes: string[];
};

const isAuthError = (err: unknown) => err instanceof ProviderError && (err.status === 401 || err.status === 402 || err.status === 403);
const message = (err: unknown) => (err instanceof Error ? err.message : 'unknown error');
const reachable = (c: LeadCandidate) => Boolean(c.email || c.phone);

/** Asks one provider about every company it is given; returns people by company domain. */
async function ask(
  provider: ProviderId,
  companies: Company[],
  input: WaterfallInput,
  key: string,
  summary: ProviderSummary,
): Promise<{ byDomain: Map<string, LeadCandidate[]>; errored: Set<string>; notes: string[] }> {
  const errored = new Set<string>();
  const notes: string[] = [];
  const domains = companies.map((c) => c.domain);
  if (provider === 'apollo') {
    const { byDomain, creditsUsed } = await findDecisionMakers(domains, input.titles, key, {
      perCompany: input.perCompany, limit: input.budget, fetchImpl: input.fetchImpl,
    });
    summary.credits_used += creditsUsed;
    return { byDomain, errored, notes };
  }
  if (provider === 'pdl') {
    const { byDomain, creditsUsed, contactsHidden } = await pdlFindPeople(domains, input.titles, key, {
      perCompany: input.perCompany, budget: input.budget, fetchImpl: input.fetchImpl,
    });
    summary.credits_used += creditsUsed;
    if (contactsHidden) notes.push('People Data Labs is hiding contact details on this plan; a Pro plan is needed to receive emails and phones.');
    return { byDomain, errored, notes };
  }
  // Hunter is asked one domain at a time, within the budget
  const byDomain = new Map<string, LeadCandidate[]>();
  let fatal: unknown;
  await input.mapLimit(domains.slice(0, input.budget), input.concurrency, async (domain) => {
    if (fatal) return;
    try {
      const { people, searched } = await hunterDomainPeople(domain, input.titles, key, { perCompany: input.perCompany, fetchImpl: input.fetchImpl });
      if (searched) summary.credits_used++;
      if (people.length) byDomain.set(domain, people);
    } catch (err) {
      if (isAuthError(err)) fatal = err;
      else errored.add(domain);
    }
  });
  if (fatal) throw fatal;
  return { byDomain, errored, notes };
}

export async function runWaterfall(input: WaterfallInput): Promise<WaterfallResult> {
  const out: WaterfallResult = { found: new Map(), attempts: [], providers: {}, failed: new Set(), authFailed: new Map(), notes: [] };
  // A named person without a way to reach them, kept in case nothing better turns up
  const fallback = new Map<string, LeadCandidate[]>();
  let open = [...input.companies];
  const hunterKey = input.order.includes('hunter') ? input.keys.hunter : undefined;

  for (const provider of input.order) {
    const key = input.keys[provider];
    if (!key || !open.length || out.found.size >= input.wanted) continue;
    const summary: ProviderSummary = { tried: 0, found: 0, errors: 0, credits_used: 0 };
    out.providers[provider] = summary;
    // Hunter only spends its budget on as many domains as it may look up
    const asked = provider === 'hunter' ? open.slice(0, input.budget) : open;
    let answer: Awaited<ReturnType<typeof ask>>;
    try {
      answer = await ask(provider, asked, input, key, summary);
    } catch (err) {
      summary.errors = asked.length;
      summary.error = message(err);
      if (isAuthError(err)) out.authFailed.set(provider, message(err));
      for (const c of asked) {
        out.attempts.push({ companyId: c.id, provider, outcome: 'error', contacts: 0 });
        out.failed.add(c.id);
      }
      continue; // the next provider still gets its turn: one vendor's outage is not the end of the chain
    }
    out.notes.push(...answer.notes);

    // A person found without an email: ask Hunter for their work address
    if (hunterKey) {
      const named = [...answer.byDomain.values()].flat().filter((p) => p.fullName && !p.email && p.company.domain);
      let stop = false;
      await input.mapLimit(named, input.concurrency, async (p) => {
        if (stop) return;
        try {
          const email = await hunterFindEmail(p.fullName!, p.company.domain!, hunterKey, input.fetchImpl);
          if (email) {
            p.email = email;
            p.sourceQuery = `${p.sourceQuery} (email from Hunter)`;
            const h = (out.providers.hunter ??= { tried: 0, found: 0, errors: 0, credits_used: 0 });
            h.emails_found = (h.emails_found ?? 0) + 1;
            h.credits_used++;
          }
        } catch (err) {
          if (isAuthError(err)) {
            stop = true;
            out.authFailed.set('hunter', message(err));
          }
        }
      });
    }

    const next: Company[] = [];
    for (const c of asked) {
      if (answer.errored.has(c.domain)) {
        summary.errors++;
        out.attempts.push({ companyId: c.id, provider, outcome: 'error', contacts: 0 });
        out.failed.add(c.id);
        next.push(c);
        continue;
      }
      summary.tried++;
      const people = (answer.byDomain.get(c.domain) ?? []).map((p) => ({ ...p, enrichmentProvider: provider }));
      const usable = people.filter(reachable);
      if (usable.length) {
        summary.found++;
        out.found.set(c.id, usable);
        out.failed.delete(c.id);
        out.attempts.push({ companyId: c.id, provider, outcome: 'found', contacts: usable.length });
      } else {
        if (people.length && !fallback.has(c.id)) fallback.set(c.id, people);
        out.attempts.push({ companyId: c.id, provider, outcome: 'no_match', contacts: 0 });
        next.push(c);
      }
    }
    open = [...next, ...open.filter((c) => !asked.includes(c))];
  }

  // Last: the company's own website, which costs nothing
  const rest = input.companies.filter((c) => !out.found.has(c.id));
  if (rest.length) {
    const summary: ProviderSummary = { tried: 0, found: 0, errors: 0, credits_used: 0 };
    out.providers.website = summary;
    await input.mapLimit(rest, input.concurrency, async (c) => {
      try {
        const site = await findSiteContacts(c.domain, input.fetchImpl, input.resolve ?? defaultResolver);
        summary.tried++;
        if (site.email || site.phone) {
          summary.found++;
          out.failed.delete(c.id);
          out.found.set(c.id, [{
            source: 'manual', sourceQuery: `Company website ${c.domain}`, enrichmentProvider: 'website',
            email: site.email, phone: site.phone, company: { name: c.name, domain: c.domain },
          }]);
          out.attempts.push({ companyId: c.id, provider: 'website', outcome: 'found', contacts: 1 });
        } else {
          out.attempts.push({ companyId: c.id, provider: 'website', outcome: 'no_match', contacts: 0 });
        }
      } catch {
        // An unreachable website is a no-match, not an outage worth retrying daily
        summary.tried++;
        out.attempts.push({ companyId: c.id, provider: 'website', outcome: 'no_match', contacts: 0 });
      }
    });
  }

  // Nobody reachable anywhere: keep the named person (LinkedIn only) rather than nothing
  for (const [id, people] of fallback) if (!out.found.has(id)) out.found.set(id, people);
  return out;
}
