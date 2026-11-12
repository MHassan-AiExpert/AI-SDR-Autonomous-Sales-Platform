import { describe, test, expect } from 'vitest';
import { apolloSearchUrl, sourceApollo } from '../src/sources/apollo.ts';
import { sourceGoogleMaps, placeToCandidate, GOOGLE_MAPS_ACTOR } from '../src/sources/googleMaps.ts';
import { sourceInstagram } from '../src/sources/instagram.ts';
import { sourceLlmSearch } from '../src/sources/llmSearch.ts';
import { normalizeCandidate } from '../src/leads.ts';
import type { LlmClient } from '../src/llm.ts';
import { fakeFetch } from './harness.ts';
import { MODEL_PLAN } from './fixtures.ts';

const apolloPlan = { enabled: true, person_titles: ['Practice Owner'], person_locations: ['Austin, Texas'], employee_ranges: ['1,10'], keywords: 'dental' };

describe('Apollo', () => {
  test('SRC-01 the search URL carries every filter as query parameters', () => {
    const u = new URL(apolloSearchUrl(apolloPlan, 2, 25));
    expect(u.pathname).toBe('/api/v1/mixed_people/api_search');
    expect(u.searchParams.getAll('person_titles[]')).toEqual(['Practice Owner']);
    expect(u.searchParams.getAll('organization_num_employees_ranges[]')).toEqual(['1,10']);
    expect(u.searchParams.get('page')).toBe('2');
    expect(u.searchParams.get('per_page')).toBe('25');
  });

  test('SRC-02 people are searched, then enriched ten at a time up to the limit', async () => {
    const people = Array.from({ length: 12 }, (_, i) => ({ id: `p${i}`, first_name: 'A', title: 'Owner' }));
    const f = fakeFetch([
      [/api_search/, () => ({ total_entries: 340, people })],
      [/bulk_match/, (_u, init) => ({
        credits_consumed: JSON.parse(String(init.body)).details.length,
        matches: JSON.parse(String(init.body)).details.map(({ id }: { id: string }) => ({
          id, name: `Person ${id}`, title: 'Practice Owner', email: `${id}@clinic${id}.com`, linkedin_url: `https://linkedin.com/in/${id}`,
          city: 'Austin', state: 'Texas', country: 'United States',
          organization: { name: `Clinic ${id}`, primary_domain: `clinic${id}.com`, industry: 'Dental', estimated_num_employees: 8 },
        })),
      })],
    ]);
    const r = await sourceApollo(apolloPlan, 'apollo-key', 12, f.impl);
    expect(r.found).toBe(340);
    expect(r.leads).toHaveLength(12);
    expect(r.creditsUsed).toBe(12);
    expect(f.calls.filter((c) => /bulk_match/.test(c.url)).map((c) => JSON.parse(String(c.init.body)).details.length)).toEqual([10, 2]);
    expect((f.calls[0].init.headers as Record<string, string>)['x-api-key']).toBe('apollo-key');
    expect(r.leads[0]).toMatchObject({ source: 'apollo', fullName: 'Person p0', email: 'p0@clinicp0.com', company: { name: 'Clinic p0', domain: 'clinicp0.com', location: 'Austin, Texas, United States' } });
  });

  test('SRC-03 an Apollo error carries a plain message and no key', async () => {
    const f = fakeFetch([[/api_search/, () => new Response('{"error":"invalid apollo-key"}', { status: 401 })]]);
    const err = await sourceApollo(apolloPlan, 'apollo-key', 5, f.impl).catch((e) => e);
    expect(err).toMatchObject({ name: 'ProviderError', status: 401, message: 'Apollo rejected the stored credentials' });
  });
});

describe('Apollo paging', () => {
  test('SRC-10 a short page ends the search and repeated people are enriched once', async () => {
    const f = fakeFetch([
      [/api_search/, () => ({ total_entries: 3, people: [{ id: 'x1' }, { id: 'x1' }, { id: 'x2' }] })],
      [/bulk_match/, (_u, init) => ({ matches: JSON.parse(String(init.body)).details.map(({ id }: { id: string }) => ({ id, email: `${id}@a.com`, organization: { name: 'A' } })) })],
    ]);
    const r = await sourceApollo(apolloPlan, 'k', 50, f.impl);
    expect(f.calls.filter((c) => /api_search/.test(c.url))).toHaveLength(1);
    expect(r.leads.map((l) => l.email)).toEqual(['x1@a.com', 'x2@a.com']);
    expect(r.creditsUsed).toBe(2);
  });
});

const place = (i: number, extra: Record<string, unknown> = {}) => ({
  title: `Smile Dental ${i}`, totalScore: 4.7, reviewsCount: 88, street: '1 Main St', city: 'Austin', state: 'Texas', countryCode: 'US',
  website: `https://www.smile${i}.com/`, phone: '(512) 555-01' + String(i).padStart(2, '0'), categoryName: 'Dentist', url: `https://maps.google.com/?cid=${i}`,
  emails: [`hello@smile${i}.com`], instagrams: [`https://instagram.com/smile${i}`], searchString: 'dentist', ...extra,
});

describe('Google Maps', () => {
  test('SRC-04 the Apify actor is run with contact scraping for each location', async () => {
    const f = fakeFetch([[/run-sync-get-dataset-items/, () => [place(1), place(2)]]]);
    const r = await sourceGoogleMaps({ enabled: true, search_terms: ['dentist'], locations: ['Austin, Texas', 'Dallas, Texas'] }, 'apify-token', 4, f.impl);
    expect(f.calls).toHaveLength(2);
    expect(f.calls[0].url).toContain(`/acts/${GOOGLE_MAPS_ACTOR}/run-sync-get-dataset-items`);
    expect(JSON.parse(String(f.calls[0].init.body))).toMatchObject({ searchStringsArray: ['dentist'], locationQuery: 'Austin, Texas', scrapeContacts: true, skipClosedPlaces: true, maxCrawledPlacesPerSearch: 2 });
    expect((f.calls[0].init.headers as Record<string, string>).Authorization).toBe('Bearer apify-token');
    expect(r.leads).toHaveLength(4);
    expect(r.leads[0].sourceQuery).toBe('dentist in Austin, Texas');
  });

  test('SRC-05 a place becomes a business lead with rating, reviews and socials', () => {
    const c = normalizeCandidate(placeToCandidate(place(3), 'dentist in Austin'));
    expect(c).toMatchObject({
      email: 'hello@smile3.com', phone: '5125550103', socialHandles: { instagram: 'smile3' },
      company: { name: 'Smile Dental 3', domain: 'smile3.com', industry: 'Dentist', location: '1 Main St, Austin, Texas, US', googleRating: 4.7, googleReviews: 88 },
    });
    expect(c.company.social?.google_maps).toContain('cid=3');
  });
});

describe('Instagram', () => {
  test('SRC-06 hashtag posts lead to business profiles; personal accounts are skipped', async () => {
    const f = fakeFetch([
      [/instagram-hashtag-scraper/, () => [
        { ownerUsername: 'GlowSpa', hashtag: 'austinspa' }, { ownerUsername: 'glowspa', hashtag: 'austinspa' }, { ownerUsername: 'jane_personal' },
      ]],
      [/instagram-profile-scraper/, (_u, init) => {
        expect(JSON.parse(String(init.body)).usernames).toEqual(['glowspa', 'jane_personal']);
        return [
          { username: 'glowspa', fullName: 'Glow Spa ATX', biography: 'Book: Hello@GlowSpa.com', externalUrl: 'https://glowspa.com', businessCategoryName: 'Day Spa', followersCount: 5400 },
          { username: 'jane_personal', isBusinessAccount: false, fullName: 'Jane' },
        ];
      }],
    ]);
    const r = await sourceInstagram({ enabled: true, hashtags: ['austinspa'] }, 't', 10, f.impl);
    expect(r.found).toBe(2);
    expect(r.leads).toHaveLength(1);
    expect(normalizeCandidate(r.leads[0])).toMatchObject({
      source: 'instagram', sourceQuery: '#austinspa', email: 'hello@glowspa.com', socialHandles: { instagram: 'glowspa' },
      company: { name: 'Glow Spa ATX', domain: 'glowspa.com', industry: 'Day Spa' },
    });
  });

  test('SRC-07 no posts means no profile lookup', async () => {
    const f = fakeFetch([[/instagram-hashtag-scraper/, () => []]]);
    expect(await sourceInstagram({ enabled: true, hashtags: ['x1'] }, 't', 10, f.impl)).toEqual({ leads: [], found: 0 });
    expect(f.calls).toHaveLength(1);
  });
});

const llm = (provider: LlmClient['provider'], answer: () => unknown): LlmClient => ({ provider, generateJson: async () => answer() });
const company = (i: number, extra = {}) => ({ name: `Clinic ${i}`, website: `https://clinic${i}.com`, location: 'Austin', email: '', phone: '', why_fit: 'fits', ...extra });

describe('LLM search', () => {
  test('SRC-08 each connected model gives its top 10 companies, with web search on', async () => {
    let sawWebSearch = false;
    const openai: LlmClient = { provider: 'openai', generateJson: async (r) => { sawWebSearch = r.webSearch; return { companies: Array.from({ length: 12 }, (_, i) => company(i)) }; } };
    const r = await sourceLlmSearch({ enabled: true, queries: ['top clinics?'] }, MODEL_PLAN.icp, [openai, llm('gemini', () => ({ companies: [company(1, { email: 'hi@clinic1.com' })] }))], 50);
    expect(sawWebSearch).toBe(true);
    expect(r.found).toBe(11);
    expect(r.leads).toHaveLength(11);
    expect(r.leads[10]).toMatchObject({ source: 'llm_search', sourceQuery: 'gemini: top clinics?', email: 'hi@clinic1.com' });
    expect(r.leads[0].email).toBeUndefined();
  });

  test('SRC-09 one model failing does not stop the others; all failing is an error', async () => {
    const ok = await sourceLlmSearch({ enabled: true, queries: ['q'] }, MODEL_PLAN.icp,
      [llm('openai', () => { throw new Error('OpenAI is rate limiting requests'); }), llm('gemini', () => ({ companies: [company(1)] }))], 10);
    expect(ok.leads).toHaveLength(1);
    expect(ok.notes).toEqual(['openai: OpenAI is rate limiting requests']);
    await expect(sourceLlmSearch({ enabled: true, queries: ['q'] }, MODEL_PLAN.icp, [llm('openai', () => ({ nope: 1 }))], 10)).rejects.toThrow(/LLM search failed/);
  });
});
