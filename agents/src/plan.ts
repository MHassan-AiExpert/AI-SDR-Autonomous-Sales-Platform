// The AI setup agent: turns a niche and target areas into an ideal customer
// profile and a plan for which lead sources to search, and with what queries.

import { z } from 'zod';

const list = (max: number, len = 120) => z.array(z.string().trim().min(1).max(len)).max(max);

export const IcpSchema = z.object({
  summary: z.string().trim().min(1).max(600),
  industries: list(10),
  company_size: z.string().trim().max(60),
  decision_maker_titles: list(12),
  seniorities: list(6, 40),
  locations: list(10),
  pain_points: list(8, 200),
  buying_triggers: list(8, 200),
  keywords: list(12, 60),
});

export const SourcePlanSchema = z.object({
  apollo: z.object({
    enabled: z.boolean(),
    person_titles: list(10),
    person_locations: list(10),
    employee_ranges: list(6, 20),
    keywords: z.string().trim().max(120),
  }),
  google_maps: z.object({
    enabled: z.boolean(),
    search_terms: list(6, 80),
    locations: list(6),
  }),
  instagram: z.object({
    enabled: z.boolean(),
    hashtags: list(8, 60),
  }),
  llm_search: z.object({
    enabled: z.boolean(),
    queries: list(4, 300),
  }),
});

export const CampaignPlanSchema = z.object({ icp: IcpSchema, sources: SourcePlanSchema });

export type Icp = z.infer<typeof IcpSchema>;
export type SourcePlan = z.infer<typeof SourcePlanSchema>;
export type CampaignPlan = z.infer<typeof CampaignPlanSchema>;

// Hand-written JSON Schema for structured output (strict mode needs every
// property listed as required and no extra properties).
const strArr = { type: 'array', items: { type: 'string' } };
const obj = (properties: Record<string, unknown>) => ({
  type: 'object', additionalProperties: false, properties, required: Object.keys(properties),
});

export const CAMPAIGN_PLAN_JSON_SCHEMA = obj({
  icp: obj({
    summary: { type: 'string' },
    industries: strArr,
    company_size: { type: 'string' },
    decision_maker_titles: strArr,
    seniorities: strArr,
    locations: strArr,
    pain_points: strArr,
    buying_triggers: strArr,
    keywords: strArr,
  }),
  sources: obj({
    apollo: obj({ enabled: { type: 'boolean' }, person_titles: strArr, person_locations: strArr, employee_ranges: strArr, keywords: { type: 'string' } }),
    google_maps: obj({ enabled: { type: 'boolean' }, search_terms: strArr, locations: strArr }),
    instagram: obj({ enabled: { type: 'boolean' }, hashtags: strArr }),
    llm_search: obj({ enabled: { type: 'boolean' }, queries: strArr }),
  }),
});

export type PlanInput = {
  niche: string;
  targetAreas: string[];
  offer: string | null;
  connected: Set<string>;
};

export const PLAN_SYSTEM = `You are the setup agent of an AI sales development platform. A company describes who it sells to.
Work out the ideal customer profile and a lead search plan.
- Apollo finds named decision makers at B2B companies. Titles must be real job titles. Employee ranges use the form "min,max", for example "1,10", "11,50", "51,200", "201,500", "501,1000", "1001,5000".
- Google Maps finds local businesses. Search terms are what a person types into Google Maps, for example "dental clinic".
- Instagram finds businesses through hashtags they post with. Give hashtags without the # sign.
- LLM search asks a web-search model for the top companies that fit. Each query is a full question.
Enable a source only when it suits the niche: local service businesses suit Google Maps and Instagram; B2B companies suit Apollo.
Use only the target areas given as locations. Never invent facts about specific companies.`;

export function planPrompt(input: PlanInput): string {
  return [
    `Niche: ${input.niche}`,
    `Target areas: ${input.targetAreas.length ? input.targetAreas.join('; ') : 'not specified'}`,
    `What the company offers: ${input.offer ?? 'not specified'}`,
  ].join('\n');
}

/** Trims, drops empties and case-insensitive repeats (first one wins), caps the count. */
function clean(items: string[], max: number): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of items) {
    const item = raw.trim();
    if (!item || seen.has(item.toLowerCase())) continue;
    seen.add(item.toLowerCase());
    out.push(item);
  }
  return out.slice(0, max);
}
const RANGE = /^\d{1,6},\d{1,6}$/;

/**
 * Makes the model's plan safe to run: target areas always win as locations,
 * duplicates are removed, sources without a connected tool are switched off.
 */
export function sanitizePlan(plan: CampaignPlan, input: PlanInput): CampaignPlan {
  const areas = clean(input.targetAreas, 10);
  const llmConnected = ['openai', 'anthropic', 'gemini'].some((t) => input.connected.has(t));
  const s = plan.sources;
  const icp = {
    ...plan.icp,
    industries: clean(plan.icp.industries, 10),
    decision_maker_titles: clean(plan.icp.decision_maker_titles, 12),
    keywords: clean(plan.icp.keywords, 12),
    locations: areas.length ? areas : clean(plan.icp.locations, 10),
  };
  const apolloTitles = clean(s.apollo.person_titles.length ? s.apollo.person_titles : icp.decision_maker_titles, 10);
  const mapsTerms = clean(s.google_maps.search_terms, 6);
  const hashtags = clean(s.instagram.hashtags.map((h) => h.replace(/^#/, '').replace(/\s+/g, '').toLowerCase()), 8)
    .filter((h) => /^[\p{L}\p{N}_]{2,60}$/u.test(h));
  const queries = clean(s.llm_search.queries, 4);
  const locs = areas.length ? areas.slice(0, 6) : clean(s.google_maps.locations, 6);
  return {
    icp,
    sources: {
      apollo: {
        enabled: s.apollo.enabled && input.connected.has('apollo') && apolloTitles.length > 0,
        person_titles: apolloTitles,
        person_locations: areas.length ? areas : clean(s.apollo.person_locations, 10),
        employee_ranges: clean(s.apollo.employee_ranges, 6).filter((r) => RANGE.test(r)),
        keywords: s.apollo.keywords.trim(),
      },
      google_maps: {
        enabled: s.google_maps.enabled && input.connected.has('apify') && mapsTerms.length > 0 && locs.length > 0,
        search_terms: mapsTerms,
        locations: locs,
      },
      instagram: {
        enabled: s.instagram.enabled && input.connected.has('apify') && hashtags.length > 0,
        hashtags,
      },
      llm_search: {
        enabled: s.llm_search.enabled && llmConnected && queries.length > 0,
        queries,
      },
    },
  };
}

export function parsePlan(raw: unknown): CampaignPlan {
  return CampaignPlanSchema.parse(raw);
}
