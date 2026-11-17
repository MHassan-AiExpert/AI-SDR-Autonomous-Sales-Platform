// Signals (F26), for the interface and the ingest endpoint.

import { z } from 'zod';

export const SIGNAL_KINDS = ['funding', 'news', 'hiring', 'tech_change', 'job_change', 'intent_surge', 'social_post', 'website_visit'] as const;
export type SignalKind = (typeof SIGNAL_KINDS)[number];

export const KIND_LABELS: Record<SignalKind, string> = {
  funding: 'Funding',
  news: 'News',
  hiring: 'Hiring',
  tech_change: 'Technology change',
  job_change: 'Job change',
  intent_surge: 'Buying intent',
  social_post: 'Social post',
  website_visit: 'Website visit',
};

/** The kinds the agent looks for itself; the rest arrive from other tools. */
export const BUILT_IN_KINDS = ['funding', 'news', 'hiring', 'tech_change', 'job_change'] as const;
export type BuiltInKind = (typeof BUILT_IN_KINDS)[number];

export const BUILT_IN_HELP: Record<BuiltInKind, string> = {
  funding: 'Funding rounds, acquisitions and investments, found by web search',
  news: 'Launches, expansions, awards and leadership changes, found by web search',
  hiring: 'Open roles, especially ones related to what you sell, found by web search',
  tech_change: 'Tools appearing on or leaving their website, such as a new CRM or chat',
  job_change: 'Your contact moving to another company. Uses one Apollo credit per person checked, at most once a month each',
};

export const SOURCE_LABELS: Record<string, string> = {
  web_search: 'Web search',
  website: 'Their website',
  apollo: 'Apollo',
  ingest: 'Sent in by a tool',
  visitor: 'Website visitor',
};

export const signalSettingsSchema = z.object({
  signals_enabled: z.boolean(),
  signal_kinds: z.array(z.enum(BUILT_IN_KINDS)).max(BUILT_IN_KINDS.length),
});

// ---------------------------------------------------------------- ingest

/** The webhook address token: 64 lowercase hex characters. */
export const TOKEN = /^[0-9a-f]{64}$/;
export const MAX_BODY_BYTES = 64_000;
export const MAX_SIGNALS_PER_REQUEST = 50;

/**
 * Accepts one signal, or `{ "signals": [...] }`. Field checks happen in the
 * database, which gives the same answer whatever sends the request; this only
 * shapes the body and bounds its size.
 */
export function parseIngestBody(text: string): { signals: Record<string, unknown>[] } | { error: string } {
  if (new TextEncoder().encode(text).length > MAX_BODY_BYTES) return { error: `The body is larger than ${MAX_BODY_BYTES / 1000} KB` };
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return { error: 'The body is not valid JSON' };
  }
  const list = body && typeof body === 'object' && !Array.isArray(body) && Array.isArray((body as { signals?: unknown }).signals)
    ? (body as { signals: unknown[] }).signals
    : [body];
  if (!list.length) return { error: 'No signals were sent' };
  if (list.length > MAX_SIGNALS_PER_REQUEST) return { error: `Send at most ${MAX_SIGNALS_PER_REQUEST} signals per request` };
  if (!list.every((s) => s && typeof s === 'object' && !Array.isArray(s))) return { error: 'Each signal must be a JSON object' };
  return { signals: list as Record<string, unknown>[] };
}

/** A database refusal, in words the sending tool's owner can act on. */
export function ingestError(message: string | undefined): string {
  if (!message) return 'The signal could not be stored';
  const known = [/Unknown kind[^.]*/, /A signal needs a title[^.]*/, /A signal is a JSON object[^.]*/, /Unknown webhook address/];
  for (const re of known) {
    const m = message.match(re);
    if (m) return m[0];
  }
  return 'The signal could not be stored';
}

/** An example a person can paste into Zapier, Make or their tool's webhook settings. */
export const INGEST_EXAMPLE = JSON.stringify({
  kind: 'intent_surge',
  title: 'Researching patient scheduling software',
  domain: 'brightteeth.com',
  provider: 'bombora',
  url: 'https://example.com/report/123',
  id: 'evt-123',
}, null, 2);
