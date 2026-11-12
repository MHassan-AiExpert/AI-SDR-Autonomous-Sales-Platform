// Enrichment agent (SRS M3): turns companies found without a contact into
// leads, fills in company details, verifies every email and checks every
// phone's line type, using the company's own connected tools.

import { ProviderError } from './http.ts';
import { IcpSchema, SourcePlanSchema } from './plan.ts';
import { dedupe, hasContact, isSuppressed, normalizeCandidate, type LeadCandidate } from './leads.ts';
import { enrichOrganization, findDecisionMakers } from './sources/apollo.ts';
import { findSiteContacts, defaultResolver, type Resolver } from './sources/website.ts';
import { lookupPhone, verifyEmail, type EmailVerdict, type LineType } from './sources/verify.ts';
import type { Deps } from './jobs.ts';
import type { Campaign, Job, PendingCompany } from './store.ts';
import { log } from './log.ts';

export const LIMITS = { companies: 50, decisionMakersPerCompany: 2, details: 25, emails: 200, phones: 100, concurrency: 5 };

export type EnrichmentDeps = Deps & { resolve?: Resolver };

/** Runs `fn` over `items` with at most `n` running at once. */
export async function mapLimit<T, R>(items: T[], n: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, worker));
  return out;
}

function titlesFor(campaign: Campaign): string[] {
  const icp = IcpSchema.safeParse(campaign.icp);
  if (icp.success && icp.data.decision_maker_titles.length) return icp.data.decision_maker_titles.slice(0, 10);
  const plan = SourcePlanSchema.safeParse(campaign.source_plan);
  return plan.success ? plan.data.apollo.person_titles.slice(0, 10) : [];
}

const isAuthError = (err: unknown) => err instanceof ProviderError && (err.status === 401 || err.status === 402 || err.status === 403);
const message = (err: unknown) => (err instanceof Error ? err.message : 'unknown error');

export async function runEnrichment(deps: EnrichmentDeps, job: Job, campaign: Campaign) {
  const ws = job.workspace_id;
  const { store } = deps;
  const connected = await store.connectedTools(ws);
  const channels = await store.workspaceChannels(ws);
  const notes: string[] = [];
  const result = {
    companies: { checked: 0, leads_added: 0, no_contact: 0, error: undefined as string | undefined },
    details_updated: 0,
    apollo_credits_used: 0,
    emails: { checked: 0, valid: 0, invalid: 0, catch_all: 0, risky: 0, error: undefined as string | undefined },
    phones: { checked: 0, mobile: 0, landline: 0, voip: 0, unknown: 0, invalid: 0, error: undefined as string | undefined },
    notes,
  };

  // ---- A. Company details (before contacts, so each company is looked up once)
  if (connected.has('apollo')) {
    const apolloKey = (await store.secret(ws, 'apollo'))?.api_key;
    const missing = apolloKey ? await store.companiesMissingDetails(ws, campaign.id, LIMITS.details) : [];
    for (const c of missing) {
      try {
        const details = await enrichOrganization(c.domain!, apolloKey!, deps.fetchImpl);
        await store.updateCompany(ws, c.id, null, details ?? {});
        if (details) result.details_updated++;
      } catch (err) {
        if (isAuthError(err)) break;
        await store.updateCompany(ws, c.id, null, {});
      }
    }
  }

  // ---- B. Contacts for companies that have none
  const remaining = Math.max(0, campaign.daily_lead_limit - (await store.addedToday(ws, campaign.id)));
  const pending = await store.companiesWithoutLeads(ws, campaign.id, LIMITS.companies);
  if (pending.length) {
    result.companies.checked = pending.length;
    const found = new Map<string, LeadCandidate[]>();
    let methodFailed = false;

    const apolloKey = connected.has('apollo') ? (await store.secret(ws, 'apollo'))?.api_key : undefined;
    const titles = titlesFor(campaign);
    const withDomain = pending.filter((c): c is PendingCompany & { domain: string } => Boolean(c.domain));
    if (apolloKey && titles.length && withDomain.length && remaining > 0) {
      try {
        const { byDomain, creditsUsed } = await findDecisionMakers(withDomain.map((c) => c.domain), titles, apolloKey, {
          perCompany: LIMITS.decisionMakersPerCompany, limit: Math.min(remaining, LIMITS.companies), fetchImpl: deps.fetchImpl,
        });
        result.apollo_credits_used += creditsUsed;
        for (const c of withDomain) {
          const people = byDomain.get(c.domain) ?? [];
          if (people.length) found.set(c.id, people.map((p) => ({ ...p, source: c.source_channel ?? 'apollo', companyId: c.id })));
        }
      } catch (err) {
        methodFailed = true;
        result.companies.error = message(err);
        if (isAuthError(err)) await store.markToolError(ws, 'apollo', 'error', message(err));
      }
    } else if (!apolloKey) {
      notes.push('Connect Apollo to find named decision makers; the agent used company websites only.');
    }

    // Companies still without anyone: read their own website
    const rest = withDomain.filter((c) => !found.has(c.id));
    await mapLimit(rest, LIMITS.concurrency, async (c) => {
      try {
        const site = await findSiteContacts(c.domain, deps.fetchImpl, deps.resolve ?? defaultResolver);
        if (site.email || site.phone) {
          found.set(c.id, [{
            source: c.source_channel ?? 'manual', sourceQuery: `Company website ${c.domain}`, companyId: c.id,
            email: site.email, phone: site.phone, company: { name: c.name, domain: c.domain },
          }]);
        }
      } catch (err) {
        log('warn', 'website contact lookup failed', { job: job.id, domain: c.domain, error: message(err) });
      }
    });

    // In the order the companies were found, so the daily limit is applied fairly and predictably
    const candidates = pending.flatMap((c) => found.get(c.id) ?? []).map(normalizeCandidate).filter(hasContact);
    const suppressions = await store.suppressions(ws, candidates);
    const allowed = candidates.filter((c) => !isSuppressed(c, suppressions));
    const { fresh } = dedupe(allowed, await store.existingKeys(ws, allowed));
    const toSave = fresh.slice(0, remaining);
    const saved = toSave.length ? await store.saveLeads(ws, campaign, toSave, []) : { added: 0 };
    result.companies.leads_added = saved.added;

    const savedCompanies = new Set(toSave.map((c) => c.companyId));
    // Contacts held back by the daily limit are picked up on the next run
    const heldBack = new Set(fresh.slice(remaining).map((c) => c.companyId));
    const blocked = new Set(candidates.filter((c) => isSuppressed(c, suppressions)).map((c) => c.companyId));
    for (const c of pending) {
      if (savedCompanies.has(c.id)) await store.updateCompany(ws, c.id, 'enriched');
      else if (heldBack.has(c.id)) continue;
      else if (blocked.has(c.id)) await store.updateCompany(ws, c.id, 'skipped');
      else if (!c.domain) await store.updateCompany(ws, c.id, 'skipped');
      else if (!methodFailed && remaining > 0) {
        await store.updateCompany(ws, c.id, 'no_contact_found');
        result.companies.no_contact++;
      }
    }
  }

  // ---- C. Email verification
  if (channels.email === false) {
    notes.push('Email is switched off, so emails were not verified.');
  } else if (!connected.has('zerobounce')) {
    notes.push('Connect ZeroBounce to verify emails before any email is sent.');
  } else {
    const key = (await store.secret(ws, 'zerobounce'))?.api_key;
    const leads = key ? await store.leadsToVerify(ws, campaign.id, LIMITS.emails) : [];
    let stop = false;
    await mapLimit(leads, LIMITS.concurrency, async (lead) => {
      if (stop) return;
      try {
        const { verdict, raw } = await verifyEmail(lead.email, key!, deps.fetchImpl);
        await store.setEmailVerdict(ws, lead.id, verdict, raw);
        result.emails.checked++;
        result.emails[verdict as EmailVerdict]++;
      } catch (err) {
        if (isAuthError(err) && !stop) {
          stop = true;
          result.emails.error = message(err);
          await store.markToolError(ws, 'zerobounce', 'error', message(err));
        }
      }
    });
  }

  // ---- D. Phone line type
  const phoneChannels = ['voice', 'sms', 'whatsapp'].some((c) => channels[c] !== false);
  if (!phoneChannels) {
    notes.push('Calls, SMS and WhatsApp are switched off, so phones were not checked.');
  } else if (!connected.has('twilio')) {
    notes.push('Connect Twilio to check phone line types before calls and SMS.');
  } else {
    const s = await store.secret(ws, 'twilio');
    const leads = s?.account_sid && s.auth_token ? await store.leadsToCheckPhone(ws, campaign.id, LIMITS.phones) : [];
    let stop = false;
    await mapLimit(leads, LIMITS.concurrency, async (lead) => {
      if (stop) return;
      try {
        // Numbers without a country code cannot be looked up reliably
        const check = lead.phone.startsWith('+')
          ? await lookupPhone(lead.phone, s!.account_sid, s!.auth_token, deps.fetchImpl)
          : { valid: true, lineType: 'unknown' as LineType };
        await store.setPhoneCheck(ws, lead.id, check);
        result.phones.checked++;
        if (!check.valid) result.phones.invalid++;
        else result.phones[check.lineType]++;
      } catch (err) {
        if (isAuthError(err) && !stop) {
          stop = true;
          result.phones.error = message(err);
          await store.markToolError(ws, 'twilio', 'error', message(err));
        }
      }
    });
  }

  return JSON.parse(JSON.stringify(result)) as typeof result;
}
