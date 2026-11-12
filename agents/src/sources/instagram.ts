// Instagram: finds accounts posting with the plan's hashtags, then reads
// their profiles. Business email comes from the profile or its bio.

import { isObject, num, str, type Fetch } from '../http.ts';
import type { LeadCandidate, SourceResult } from '../leads.ts';
import { extractEmails, normalizeInstagramHandle } from '../normalize.ts';
import type { SourcePlan } from '../plan.ts';
import { runActor } from './apify.ts';

export const HASHTAG_ACTOR = 'apify~instagram-hashtag-scraper';
export const PROFILE_ACTOR = 'apify~instagram-profile-scraper';

export function profileToCandidate(p: Record<string, unknown>, query: string): LeadCandidate | null {
  const handle = normalizeInstagramHandle(str(p.username));
  if (!handle) return null;
  const bio = str(p.biography) ?? '';
  return {
    source: 'instagram',
    sourceQuery: query,
    fullName: undefined,
    email: str(p.businessEmail) ?? str(p.public_email) ?? extractEmails(bio)[0],
    phone: str(p.businessPhoneNumber) ?? str(p.public_phone_number),
    socialHandles: { instagram: handle },
    company: {
      name: str(p.fullName) ?? handle,
      domain: str(p.externalUrl),
      industry: str(p.businessCategoryName),
      location: str(p.businessAddress) ?? undefined,
      social: {
        instagram: `https://www.instagram.com/${handle}/`,
        ...(num(p.followersCount) !== undefined ? { instagram_followers: String(num(p.followersCount)) } : {}),
      },
    },
  };
}

export async function sourceInstagram(
  plan: SourcePlan['instagram'],
  token: string,
  limit: number,
  fetchImpl?: Fetch,
): Promise<SourceResult> {
  const posts = await runActor(HASHTAG_ACTOR, {
    hashtags: plan.hashtags,
    resultsType: 'posts',
    resultsLimit: Math.min(200, Math.max(20, limit * 3)),
  }, token, fetchImpl);
  const handleTags = new Map<string, string>();
  for (const post of posts) {
    if (!isObject(post)) continue;
    const handle = normalizeInstagramHandle(str(post.ownerUsername));
    if (handle && !handleTags.has(handle)) handleTags.set(handle, str(post.hashtag) ?? plan.hashtags[0]);
  }
  const handles = [...handleTags.keys()].slice(0, limit);
  if (!handles.length) return { leads: [], found: 0 };

  const profiles = await runActor(PROFILE_ACTOR, { usernames: handles }, token, fetchImpl);
  const leads: LeadCandidate[] = [];
  for (const p of profiles) {
    if (!isObject(p)) continue;
    // Personal accounts are not businesses to sell to
    if (p.isBusinessAccount === false && !str(p.businessCategoryName)) continue;
    const handle = normalizeInstagramHandle(str(p.username));
    const c = profileToCandidate(p, `#${handle ? handleTags.get(handle) ?? '' : ''}`.replace(/^#$/, '#instagram'));
    if (c) leads.push(c);
  }
  return { leads, found: handles.length };
}
