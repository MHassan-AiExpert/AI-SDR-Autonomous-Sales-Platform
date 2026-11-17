// The signals agent (F26, agent #17): looks at a campaign's companies and
// people and records what changed.
//
// Built-in tier, no extra vendor:
//   - funding, news, hiring: a web search through whichever language model
//     the workspace connected, validated by signals.ts before it is kept
//   - technology changes: the company's own home page, compared with the last
//     look (the first look is a baseline, never a signal)
//   - job changes: Apollo's person match, opt-in per campaign because each
//     match costs a credit
//
// The paid and social tiers arrive through the webhook address instead
// (signal_ingest in the database), so this agent has nothing to skip for
// them: they work whenever a tool is sending.
//
// Everything here only records. Contacting a lead about a signal is the
// sequence's job (a step that waits for one), so this agent can never send
// anything by itself.

import { buildClients, withFailover, type LlmKeys } from './llm.ts';
import { fetchHomePage, defaultResolver } from './sources/website.ts';
import { matchPerson } from './sources/apollo.ts';
import { mapLimit } from './enrichment.ts';
import { ProviderError } from './http.ts';
import {
  NEWS_JSON_SCHEMA, NEWS_SYSTEM, NewsSchema, SIGNAL_LIMITS, acceptNews, canonicalUrl, detectTech,
  fingerprint, jobChange, newsPrompt, techDiff, techSignalTitle,
} from './signals.ts';
import type { Deps } from './jobs.ts';
import type { Campaign, Job } from './store.ts';
import { log } from './log.ts';

export class SignalsError extends Error {}

type Row = Parameters<Deps['store']['saveSignals']>[1][number];

async function llmKeys(deps: Deps, ws: string, connected: Set<string>): Promise<LlmKeys> {
  const keys: LlmKeys = {};
  for (const p of ['openai', 'anthropic', 'gemini'] as const) {
    if (!connected.has(p)) continue;
    const s = await deps.store.secret(ws, p);
    if (s?.api_key) keys[p] = s.api_key;
  }
  return keys;
}

export async function runSignals(deps: Deps, job: Job, campaign: Campaign, now: () => Date = () => new Date()) {
  const ws = job.workspace_id;
  const { store } = deps;
  if (!campaign.signals_enabled) {
    return { signals: 0, note: 'Signals are off for this campaign.' };
  }
  const kinds = new Set(campaign.signal_kinds ?? []);
  const wantSearch = kinds.has('funding') || kinds.has('news') || kinds.has('hiring');
  const wantTech = kinds.has('tech_change');
  const wantJobs = kinds.has('job_change');

  const connected = await store.connectedTools(ws);
  const clients = wantSearch ? buildClients(await llmKeys(deps, ws, connected), deps.models, deps.fetchImpl) : [];
  const apolloKey = wantJobs && connected.has('apollo') ? (await store.secret(ws, 'apollo'))?.api_key : undefined;

  const stats = {
    companies_checked: 0, people_checked: 0, signals: 0,
    found_by_kind: {} as Record<string, number>,
    skipped: [] as string[],
    search_failures: 0,
  };
  if (wantSearch && !clients.length) stats.skipped.push('News, funding and hiring need OpenAI, Anthropic or Gemini connected in Setup.');
  if (wantJobs && !apolloKey) stats.skipped.push('Job changes need Apollo connected in Setup.');
  if (!wantSearch && !wantTech && !wantJobs) return { ...stats, note: 'No built-in signal kinds are chosen for this campaign.' };

  const today = now();
  const rows: Row[] = [];
  const count = (k: string) => { stats.found_by_kind[k] = (stats.found_by_kind[k] ?? 0) + 1; };

  // ---- companies: technology from the site, events from a web search
  if (wantTech || (wantSearch && clients.length)) {
    const companies = await store.signalCompanies(ws, campaign.id, SIGNAL_LIMITS.companies, SIGNAL_LIMITS.recheckDays);
    await mapLimit(companies, SIGNAL_LIMITS.concurrency, async (co) => {
      let tech: string[] | null = null;
      if (wantTech && co.domain) {
        try {
          const page = await fetchHomePage(co.domain, deps.fetchImpl, deps.resolve ?? defaultResolver);
          if (page) {
            tech = detectTech(page.html);
            const diff = techDiff(co.tech_stack, tech);
            const title = techSignalTitle(co.name, diff);
            if (title) {
              rows.push({
                company_id: co.id, lead_id: null, campaign_id: campaign.id, kind: 'tech_change', source: 'website',
                title, detail: null, url: page.url, occurred_at: today.toISOString(),
                fingerprint: `tech:${fingerprint(co.id, [...diff.added].sort().join(','), [...diff.removed].sort().join(','), today.toISOString().slice(0, 10))}`,
              });
              count('tech_change');
            }
          }
        } catch (err) {
          log('warn', 'signals: site read failed', { job: job.id, company: co.id, error: err instanceof Error ? err.message : 'unknown' });
        }
      }

      if (wantSearch && clients.length) {
        try {
          const out = await withFailover(clients,
            (client) => client.generateJson({
              system: NEWS_SYSTEM, prompt: newsPrompt({ name: co.name, domain: co.domain }, campaign.offer, today),
              schemaName: 'company_signals', schema: NEWS_JSON_SCHEMA, webSearch: true,
            }),
            (raw) => NewsSchema.parse(raw), { job: job.id, company: co.id });
          for (const item of acceptNews(out.value.items, today)) {
            if (!kinds.has(item.kind)) continue;
            rows.push({
              company_id: co.id, lead_id: null, campaign_id: campaign.id, kind: item.kind, source: 'web_search',
              title: item.title, detail: item.detail || null, url: item.url,
              occurred_at: new Date(Date.parse(item.date)).toISOString(),
              fingerprint: `web:${fingerprint(co.id, item.kind, canonicalUrl(item.url))}`,
            });
            count(item.kind);
          }
        } catch (err) {
          stats.search_failures++;
          log('warn', 'signals: search failed', { job: job.id, company: co.id, error: err instanceof Error ? err.message : 'unknown' });
        }
      }

      // Checked even when nothing was found: a quiet company waits a week
      await store.setCompanySignalsChecked(ws, co.id, tech);
      stats.companies_checked++;
    });
  }

  // ---- people: job changes, a credit each, so a few per run
  if (wantJobs && apolloKey) {
    const people = await store.leadsForJobCheck(ws, campaign.id, SIGNAL_LIMITS.jobChecks, SIGNAL_LIMITS.jobRecheckDays);
    const checked: string[] = [];
    for (const lead of people) {
      try {
        const person = await matchPerson({ email: lead.email, name: lead.full_name, domain: lead.company_domain }, apolloKey, deps.fetchImpl);
        checked.push(lead.id);
        const title = jobChange(lead, person);
        if (title) {
          rows.push({
            company_id: lead.company_id, lead_id: lead.id, campaign_id: campaign.id, kind: 'job_change', source: 'apollo',
            title,
            // The email on file is most likely the old employer's
            detail: 'The email address on file may belong to the previous employer. Check it before writing.',
            url: null, occurred_at: today.toISOString(),
            fingerprint: `job:${fingerprint(lead.id, person?.orgDomain ?? person?.orgName ?? '')}`,
          });
          count('job_change');
        }
      } catch (err) {
        // A rejected key stops the job checks; anything else skips one person
        if (err instanceof ProviderError && (err.status === 401 || err.status === 403)) {
          await store.markToolError(ws, 'apollo', 'error', err.message);
          stats.skipped.push('Apollo rejected the stored key, so job changes were not checked.');
          break;
        }
        log('warn', 'signals: person match failed', { job: job.id, lead: lead.id, error: err instanceof Error ? err.message : 'unknown' });
      }
    }
    await store.setJobChecked(ws, checked);
    stats.people_checked = checked.length;
  }

  stats.signals = await store.saveSignals(ws, rows);

  // Every company's search failed: the model connection is the likely cause
  if (stats.companies_checked > 0 && wantSearch && clients.length && !wantTech && stats.search_failures === stats.companies_checked) {
    throw new SignalsError('The web search failed for every company. Check the language model connections in Setup.');
  }
  return stats;
}
