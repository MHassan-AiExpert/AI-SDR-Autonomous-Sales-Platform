// Enrichment agent (SRS M3): turns companies found without a contact into
// leads, fills in company details, verifies every email and checks every
// phone's line type, using the company's own connected tools.
// Contacts come from a provider waterfall (F25, see waterfall.ts).

import { ProviderError } from './http.ts';
import { IcpSchema, SourcePlanSchema } from './plan.ts';
import { dedupe, hasContact, isSuppressed, normalizeCandidate, type LeadCandidate } from './leads.ts';
import { enrichOrganization } from './sources/apollo.ts';
import type { Resolver } from './sources/website.ts';
import { runWaterfall, PROVIDER_LABELS, type ProviderId, type WaterfallResult } from './waterfall.ts';
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
    providers: {} as WaterfallResult['providers'],
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

    // The provider chain, in the workspace's order, using only connected providers
    const order = await store.enrichmentOrder(ws);
    const keys: Partial<Record<ProviderId, string>> = {};
    for (const p of order) {
      if (!connected.has(p)) continue;
      const key = (await store.secret(ws, p))?.api_key;
      if (key) keys[p] = key;
    }
    const titles = titlesFor(campaign);
    // Apollo searches by title, so without titles it has nothing to search for
    if (!titles.length) delete keys.apollo;
    if (!Object.keys(keys).length) {
      notes.push('Connect Apollo, Hunter or People Data Labs to find named decision makers; the agent used company websites only.');
    }

    const withDomain = pending.filter((c): c is PendingCompany & { domain: string } => Boolean(c.domain));
    const fall = remaining > 0 && withDomain.length
      ? await runWaterfall({
        companies: withDomain, order, keys, titles, perCompany: LIMITS.decisionMakersPerCompany,
        budget: Math.min(remaining, LIMITS.companies), wanted: remaining, concurrency: LIMITS.concurrency,
        fetchImpl: deps.fetchImpl, resolve: deps.resolve, mapLimit,
      })
      : null;
    const found = fall?.found ?? new Map<string, LeadCandidate[]>();
    if (fall) {
      result.providers = fall.providers;
      result.apollo_credits_used = fall.providers.apollo?.credits_used ?? 0;
      notes.push(...fall.notes);
      const errors = Object.entries(fall.providers).filter(([, s]) => s?.error).map(([p, s]) => `${PROVIDER_LABELS[p as ProviderId]}: ${s!.error}`);
      if (errors.length) result.companies.error = errors.join('; ');
      for (const [p, msg] of fall.authFailed) await store.markToolError(ws, p, 'error', msg);
      await store.recordEnrichmentAttempts(ws, campaign.id, fall.attempts);
      log('info', 'waterfall enrichment', { job: job.id, providers: Object.keys(fall.providers), found: found.size, failed: fall.failed.size });
    }
    const failed = fall?.failed ?? new Set<string>();
    const sourceOf = new Map(pending.map((c) => [c.id, c.source_channel]));

    // In the order the companies were found, so the daily limit is applied fairly and predictably
    const candidates = pending
      .flatMap((c) => (found.get(c.id) ?? []).map((p) => ({ ...p, companyId: c.id, source: sourceOf.get(c.id) ?? (p.enrichmentProvider === 'apollo' ? 'apollo' as const : 'manual' as const) })))
      .map(normalizeCandidate).filter(hasContact);
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
      else if (!failed.has(c.id) && remaining > 0) {
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
