// LLM search: asks each connected web-search model for the top companies
// that fit the profile (SRS M2), and keeps the ones with a website or contact.

import { z } from 'zod';
import type { LlmClient } from '../llm.ts';
import type { LeadCandidate, SourceResult } from '../leads.ts';
import type { Icp, SourcePlan } from '../plan.ts';
import { log } from '../log.ts';

const CompanySchema = z.object({
  name: z.string().trim().min(1).max(200),
  website: z.string().trim().max(300),
  location: z.string().trim().max(200),
  email: z.string().trim().max(254),
  phone: z.string().trim().max(40),
  why_fit: z.string().trim().max(400),
});
const ResultSchema = z.object({ companies: z.array(CompanySchema).max(20) });

const COMPANY_JSON_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['companies'],
  properties: {
    companies: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false,
        required: ['name', 'website', 'location', 'email', 'phone', 'why_fit'],
        properties: {
          name: { type: 'string' }, website: { type: 'string' }, location: { type: 'string' },
          email: { type: 'string' }, phone: { type: 'string' }, why_fit: { type: 'string' },
        },
      },
    },
  },
};

const SYSTEM = `You research companies for a sales team. Search the web and list the top 10 real companies that answer the question.
Use only facts you found in search results. Give the company's own website. Give a public business email or phone only if the company publishes it, otherwise an empty string. Never guess an email address.`;

export async function sourceLlmSearch(
  plan: SourcePlan['llm_search'],
  icp: Icp,
  clients: LlmClient[],
  limit: number,
): Promise<SourceResult> {
  const leads: LeadCandidate[] = [];
  const notes: string[] = [];
  let found = 0;
  for (const client of clients) {
    for (const query of plan.queries) {
      if (leads.length >= limit) break;
      try {
        const raw = await client.generateJson({
          system: SYSTEM,
          prompt: `${query}\nLocations: ${icp.locations.join('; ') || 'any'}\nCustomer profile: ${icp.summary}`,
          schemaName: 'top_companies',
          schema: COMPANY_JSON_SCHEMA,
          webSearch: true,
        });
        const { companies } = ResultSchema.parse(raw);
        const top = companies.slice(0, 10);
        found += top.length;
        for (const c of top) {
          if (leads.length >= limit) break;
          leads.push({
            source: 'llm_search',
            sourceQuery: `${client.provider}: ${query}`,
            email: c.email || undefined,
            phone: c.phone || undefined,
            company: { name: c.name, domain: c.website || undefined, location: c.location || undefined, social: {} },
          });
        }
      } catch (err) {
        // One provider failing does not stop the others
        const message = err instanceof Error ? err.message : 'unknown error';
        notes.push(`${client.provider}: ${message}`);
        log('warn', 'llm search query failed', { provider: client.provider, error: message });
      }
    }
  }
  if (!found && notes.length) throw new Error(`LLM search failed. ${notes.join('; ')}`);
  return { leads, found, notes };
}
