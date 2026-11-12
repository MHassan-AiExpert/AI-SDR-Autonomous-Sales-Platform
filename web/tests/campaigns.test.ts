import { describe, test, expect } from 'vitest';
import { parseCampaignForm, parseLeadFilters, searchTerm, filtersToQuery, describeJobResult, describeSourcePlan } from '@/lib/campaigns';

const form = (over: Record<string, string> = {}) => {
  const f = new FormData();
  for (const [k, v] of Object.entries({ name: 'Austin dentists', niche: 'Dental clinics', target_areas: 'Austin, Texas\nDallas, Texas', offer: '', daily_lead_limit: '100', find_leads_now: 'on', ...over })) f.set(k, v);
  return f;
};

describe('campaign form', () => {
  test('CMP-01 a valid campaign is parsed, areas split by line or semicolon', () => {
    const r = parseCampaignForm(form({ target_areas: 'Austin, Texas\n\n Dallas, Texas ; Austin, Texas' }));
    expect(r.success && r.data).toEqual({ name: 'Austin dentists', niche: 'Dental clinics', target_areas: ['Austin, Texas', 'Dallas, Texas'], offer: null, daily_lead_limit: 100, find_leads_now: true });
  });

  test('CMP-02 missing niche, areas or a bad limit give a clear message', () => {
    const msg = (over: Record<string, string>) => { const r = parseCampaignForm(form(over)); return r.success ? null : r.error.issues[0].message; };
    expect(msg({ niche: '' })).toBe('Describe the niche you sell to');
    expect(msg({ target_areas: ' \n ' })).toBe('Add at least one target area, for example a country or city');
    expect(msg({ target_areas: Array.from({ length: 11 }, (_, i) => `City ${i}`).join('\n') })).toBe('Use at most 10 target areas');
    expect(msg({ daily_lead_limit: '0' })).toBe('Daily lead limit must be at least 1');
    expect(msg({ daily_lead_limit: '5000' })).toBe('Daily lead limit must be at most 1000');
    expect(msg({ daily_lead_limit: '2.5' })).toBe('Use a whole number');
  });

  test('CMP-03 an unticked "find leads now" box means plan only', () => {
    const f = form();
    f.delete('find_leads_now');
    const r = parseCampaignForm(f);
    expect(r.success && r.data.find_leads_now).toBe(false);
  });
});

describe('lead filters', () => {
  test('CMP-04 known filters are kept and unknown values ignored', () => {
    expect(parseLeadFilters({ source: 'google_maps', stage: 'new', campaign: 'A7C1A3A0-0000-4000-8000-000000000001', q: 'smile', page: '3' }))
      .toEqual({ source: 'google_maps', stage: 'new', campaign: 'a7c1a3a0-0000-4000-8000-000000000001', q: 'smile', page: 3 });
    expect(parseLeadFilters({ source: 'myspace', stage: 'drop table', campaign: '1 or 1=1', page: '-2' }))
      .toEqual({ source: null, stage: null, campaign: null, q: '', page: 1 });
    expect(parseLeadFilters({ source: ['apollo', 'x'] }).source).toBe('apollo');
  });

  test('CMP-05 search text cannot break out of the filter expression', () => {
    expect(searchTerm('a,b),email.eq.x%_*\\"\'')).toBe('a b email eq x');
    expect(searchTerm('  Smile   Dental ')).toBe('Smile Dental');
    expect(searchTerm('x'.repeat(200))).toHaveLength(80);
  });

  test('CMP-06 filters round-trip into a query string for links and paging', () => {
    const f = parseLeadFilters({ source: 'apollo', q: 'ana' });
    expect(filtersToQuery(f)).toBe('?source=apollo&q=ana');
    expect(filtersToQuery(f, { page: 2 })).toBe('?source=apollo&q=ana&page=2');
    expect(filtersToQuery(parseLeadFilters({}))).toBe('');
  });
});

describe('job and plan summaries', () => {
  test('CMP-07 job results become one readable line', () => {
    expect(describeJobResult('campaign_plan', 'succeeded', { enabled_sources: ['apollo', 'llm_search', 'evil'] }, null)).toBe('Plan ready. Searching Apollo, LLM search.');
    expect(describeJobResult('campaign_plan', 'succeeded', { enabled_sources: [] }, null)).toBe('Plan ready, but no lead source is connected yet.');
    expect(describeJobResult('lead_sourcing', 'succeeded', { added: 7, sources: { apollo: { added: 5 }, google_maps: { error: 'Apify rejected the stored credentials' }, llm_search: { added: 2 } } }, null))
      .toBe('7 new leads (Apollo 5, Google Maps failed: Apify rejected the stored credentials, LLM search 2).');
    expect(describeJobResult('lead_sourcing', 'succeeded', { added: 1 }, null)).toBe('1 new lead.');
    expect(describeJobResult('lead_sourcing', 'failed', {}, 'Every lead source failed.')).toBe('Every lead source failed.');
    expect(describeJobResult('lead_sourcing', 'queued', {}, null)).toMatch(/Waiting/);
    expect(describeJobResult('lead_sourcing', 'succeeded', { note: 'The daily lead limit for this campaign is already reached' }, null)).toMatch(/daily lead limit/);
  });

  test('CMP-08 the saved source plan is shown source by source', () => {
    const rows = describeSourcePlan({
      apollo: { enabled: true, person_titles: ['Owner', 'Office Manager'] },
      google_maps: { enabled: true, search_terms: ['dentist'], locations: ['Austin'] },
      instagram: { enabled: false, hashtags: ['austindentist'] },
    });
    expect(rows).toEqual([
      { source: 'apollo', enabled: true, detail: 'Owner, Office Manager' },
      { source: 'google_maps', enabled: true, detail: 'dentist in Austin' },
      { source: 'instagram', enabled: false, detail: '#austindentist' },
      { source: 'llm_search', enabled: false, detail: '—' },
    ]);
    expect(describeSourcePlan(null).every((r) => !r.enabled)).toBe(true);
  });
});
