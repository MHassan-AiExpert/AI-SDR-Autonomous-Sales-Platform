import { describe, test, expect } from 'vitest';
import { sanitizePlan, parsePlan, planPrompt, CAMPAIGN_PLAN_JSON_SCHEMA } from '../src/plan.ts';
import { MODEL_PLAN } from './fixtures.ts';

const input = (connected: string[], targetAreas = ['Austin, Texas, United States']) =>
  ({ niche: 'dental clinics', targetAreas, offer: 'Patient booking automation', connected: new Set(connected) });

describe('campaign planner', () => {
  test('PLN-01 the target areas always replace locations the model chose', () => {
    const p = sanitizePlan(MODEL_PLAN, input(['openai', 'apollo', 'apify']));
    expect(p.icp.locations).toEqual(['Austin, Texas, United States']);
    expect(p.sources.apollo.person_locations).toEqual(['Austin, Texas, United States']);
    expect(p.sources.google_maps.locations).toEqual(['Austin, Texas, United States']);
  });

  test('PLN-02 duplicates, bad employee ranges and invalid hashtags are removed', () => {
    const p = sanitizePlan(MODEL_PLAN, input(['openai', 'apollo', 'apify']));
    expect(p.sources.google_maps.search_terms).toEqual(['dental clinic', 'dentist']);
    expect(p.sources.apollo.employee_ranges).toEqual(['1,10', '11,50']);
    expect(p.sources.instagram.hashtags).toEqual(['austindentist']);
    expect(p.icp.decision_maker_titles).toEqual(['Practice Owner', 'Office Manager']);
  });

  test('PLN-03 a source is switched off when its tool is not connected', () => {
    const none = sanitizePlan(MODEL_PLAN, input([]));
    expect(Object.values(none.sources).map((s) => s.enabled)).toEqual([false, false, false, false]);
    const apifyOnly = sanitizePlan(MODEL_PLAN, input(['apify']));
    expect([apifyOnly.sources.apollo.enabled, apifyOnly.sources.google_maps.enabled, apifyOnly.sources.instagram.enabled, apifyOnly.sources.llm_search.enabled])
      .toEqual([false, true, true, false]);
    expect(sanitizePlan(MODEL_PLAN, input(['gemini'])).sources.llm_search.enabled).toBe(true);
  });

  test('PLN-04 a source the model turned off stays off', () => {
    const plan = structuredClone(MODEL_PLAN);
    plan.sources.apollo.enabled = false;
    expect(sanitizePlan(plan, input(['apollo'])).sources.apollo.enabled).toBe(false);
  });

  test('PLN-05 Google Maps needs a location; without target areas the model\'s are used', () => {
    const p = sanitizePlan(MODEL_PLAN, input(['apify'], []));
    expect(p.sources.google_maps.locations).toEqual(['Mars']);
    const noLoc = structuredClone(MODEL_PLAN);
    noLoc.sources.google_maps.locations = [];
    expect(sanitizePlan(noLoc, input(['apify'], [])).sources.google_maps.enabled).toBe(false);
  });

  test('PLN-06 answers that do not match the schema are rejected', () => {
    expect(() => parsePlan({ icp: {}, sources: {} })).toThrow();
    expect(() => parsePlan({ ...MODEL_PLAN, icp: { ...MODEL_PLAN.icp, industries: Array(50).fill('x') } })).toThrow();
    expect(parsePlan(MODEL_PLAN).icp.summary).toContain('dental');
  });

  test('PLN-07 the strict JSON schema lists every property as required', () => {
    const check = (node: any) => {
      if (node?.type === 'object') {
        expect(node.additionalProperties).toBe(false);
        expect(node.required.sort()).toEqual(Object.keys(node.properties).sort());
        Object.values(node.properties).forEach(check);
      }
    };
    check(CAMPAIGN_PLAN_JSON_SCHEMA);
    expect(planPrompt(input([]))).toMatch(/Niche: dental clinics\nTarget areas: Austin/);
  });
});
