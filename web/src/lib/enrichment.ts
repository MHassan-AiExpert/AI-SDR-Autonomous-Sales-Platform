// Waterfall enrichment (F25): the order contact providers are tried in, and
// how their match rates are shown.

export const ENRICHMENT_PROVIDERS = ['apollo', 'hunter', 'pdl'] as const;
export type EnrichmentProvider = (typeof ENRICHMENT_PROVIDERS)[number];

export const PROVIDER_LABELS: Record<EnrichmentProvider | 'website', string> = {
  apollo: 'Apollo', hunter: 'Hunter', pdl: 'People Data Labs', website: 'Company website',
};

export const DEFAULT_ORDER: EnrichmentProvider[] = ['apollo', 'hunter', 'pdl'];

const isProvider = (v: unknown): v is EnrichmentProvider =>
  typeof v === 'string' && (ENRICHMENT_PROVIDERS as readonly string[]).includes(v);

/** The saved order, with anything unknown dropped. */
export function savedOrder(value: unknown): EnrichmentProvider[] {
  return Array.isArray(value) ? value.filter(isProvider) : DEFAULT_ORDER;
}

/**
 * Reads the three position selects (order_1 .. order_3). An empty position is
 * skipped; a provider chosen twice is an error rather than a silent fix, so
 * the order saved is always the order the person sees.
 */
export function parseOrderForm(form: FormData): { ok: true; order: EnrichmentProvider[] } | { ok: false; error: string } {
  const order: EnrichmentProvider[] = [];
  for (let i = 1; i <= ENRICHMENT_PROVIDERS.length; i++) {
    const raw = form.get(`order_${i}`);
    if (raw === null || raw === '') continue;
    if (!isProvider(raw)) return { ok: false, error: 'Choose a provider from the list.' };
    if (order.includes(raw)) return { ok: false, error: `${PROVIDER_LABELS[raw]} is chosen twice. Pick each provider once, or leave a position empty.` };
    order.push(raw);
  }
  return { ok: true, order };
}

export type ProviderStat = { provider: string; attempts: number; found: number; errors: number; match_rate: number | null; leads: number };

/** Rows from enrichment_provider_stats(), as numbers (Postgres returns bigint and numeric as strings). */
export function toStats(rows: unknown): ProviderStat[] {
  if (!Array.isArray(rows)) return [];
  return rows.map((r) => {
    const n = (v: unknown) => (v === null || v === undefined ? 0 : Number(v));
    return {
      provider: String(r.provider),
      attempts: n(r.attempts),
      found: n(r.found),
      errors: n(r.errors),
      match_rate: r.match_rate === null || r.match_rate === undefined ? null : Number(r.match_rate),
      leads: n(r.leads),
    };
  });
}

export function matchRateLabel(rate: number | null): string {
  return rate === null ? 'Not asked yet' : `${rate % 1 === 0 ? rate.toFixed(0) : rate.toFixed(1)}%`;
}

/** One sentence on the order, so nobody has to read the selects to know what happens. */
export function describeOrder(order: EnrichmentProvider[], connected: Set<string>): string {
  const used = order.filter((p) => connected.has(p)).map((p) => PROVIDER_LABELS[p]);
  if (!used.length) return 'No contact provider is connected and in the order, so the agent reads company websites only.';
  return `The agent asks ${used.join(', then ')}, then reads the company website, and stops at the first that finds someone.`;
}
