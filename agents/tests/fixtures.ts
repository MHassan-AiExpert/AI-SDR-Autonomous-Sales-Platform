import type { CampaignPlan } from '../src/plan.ts';

export const MODEL_PLAN: CampaignPlan = {
  icp: {
    summary: 'Independent dental clinics with 1 to 50 staff that want more new patients',
    industries: ['Dental clinics'],
    company_size: '1-50',
    decision_maker_titles: ['Practice Owner', 'Office Manager', 'practice owner'],
    seniorities: ['owner'],
    locations: ['Somewhere the model made up'],
    pain_points: ['Empty chairs on weekdays'],
    buying_triggers: ['New location opened'],
    keywords: ['dental'],
  },
  sources: {
    apollo: { enabled: true, person_titles: ['Practice Owner', 'Office Manager'], person_locations: ['Mars'], employee_ranges: ['1,10', '11,50', 'lots'], keywords: 'dental' },
    google_maps: { enabled: true, search_terms: ['dental clinic', 'Dental Clinic', 'dentist'], locations: ['Mars'] },
    instagram: { enabled: true, hashtags: ['#AustinDentist', 'austin dentist', 'x', 'smile#makeover'] },
    llm_search: { enabled: true, queries: ['What are the top independent dental clinics in Austin, Texas?'] },
  },
};
