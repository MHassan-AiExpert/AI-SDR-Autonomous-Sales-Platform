// Google Maps via the Apify Google Places crawler, with contact details
// scraped from each business's website.

import { isObject, num, str, type Fetch } from '../http.ts';
import type { LeadCandidate, SourceResult } from '../leads.ts';
import type { SourcePlan } from '../plan.ts';
import { runActor } from './apify.ts';

export const GOOGLE_MAPS_ACTOR = 'compass~crawler-google-places';

const first = (v: unknown): string | undefined => (Array.isArray(v) ? v.map(str).find(Boolean) : str(v));

export function placeToCandidate(place: Record<string, unknown>, query: string): LeadCandidate {
  const location = str(place.address) ?? [str(place.street), str(place.city), str(place.state), str(place.countryCode)].filter(Boolean).join(', ');
  const social: Record<string, string> = {};
  const ig = first(place.instagrams);
  const fb = first(place.facebooks);
  const li = first(place.linkedIns);
  if (fb) social.facebook = fb;
  if (li) social.linkedin = li;
  if (str(place.url)) social.google_maps = str(place.url)!;
  return {
    source: 'google_maps',
    sourceQuery: query,
    email: first(place.emails),
    phone: str(place.phoneUnformatted) ?? str(place.phone),
    socialHandles: ig ? { instagram: ig } : {},
    company: {
      name: str(place.title) ?? 'Unknown business',
      domain: str(place.website),
      industry: str(place.categoryName) ?? first(place.categories),
      location: location || undefined,
      googleRating: num(place.totalScore),
      googleReviews: num(place.reviewsCount),
      social,
    },
  };
}

export async function sourceGoogleMaps(
  plan: SourcePlan['google_maps'],
  token: string,
  limit: number,
  fetchImpl?: Fetch,
): Promise<SourceResult> {
  const leads: LeadCandidate[] = [];
  let found = 0;
  const perLocation = Math.max(1, Math.ceil(limit / plan.locations.length));
  for (const location of plan.locations) {
    if (leads.length >= limit) break;
    const items = await runActor(GOOGLE_MAPS_ACTOR, {
      searchStringsArray: plan.search_terms,
      locationQuery: location,
      maxCrawledPlacesPerSearch: Math.max(1, Math.ceil(perLocation / plan.search_terms.length)),
      language: 'en',
      skipClosedPlaces: true,
      scrapeContacts: true,
    }, token, fetchImpl);
    found += items.length;
    for (const item of items) {
      if (isObject(item) && leads.length < limit) {
        leads.push(placeToCandidate(item, `${str(item.searchString) ?? plan.search_terms.join(', ')} in ${location}`));
      }
    }
  }
  return { leads, found };
}
