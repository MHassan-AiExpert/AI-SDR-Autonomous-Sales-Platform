// Website visitor identification, company level (F30), for the interface and
// the page-view route.

import { z } from 'zod';

export const SITE_KEY = /^site_[0-9a-f]{32}$/;
const IPV4 = /^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}$/;
const IPV6 = /^[0-9a-fA-F:]{2,45}$/;

/** The visitor's address as the hosting platform reports it; null when there is none worth using. */
export function clientIp(h: Headers): string | null {
  const candidates = [h.get('x-vercel-forwarded-for'), h.get('x-real-ip'), h.get('x-forwarded-for')?.split(',')[0]];
  for (const c of candidates) {
    const ip = c?.trim();
    if (ip && (IPV4.test(ip) || (IPV6.test(ip) && ip.includes(':')))) return ip;
  }
  return null;
}

/** The page's host, from the browser's Origin header. */
export function originHost(origin: string | null): string | null {
  if (!origin) return null;
  try {
    const u = new URL(origin);
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.hostname.toLowerCase() : null;
  } catch { return null; }
}

/** The beacon body: {"p": path, "r": referrer host}, at most 2 KB. */
export function parseBeacon(raw: string): { path: string; referrer: string | null } | null {
  if (!raw || raw.length > 2000) return null;
  try {
    const v = JSON.parse(raw) as { p?: unknown; r?: unknown };
    if (typeof v.p !== 'string' || !v.p.startsWith('/')) return null;
    const ref = typeof v.r === 'string' && /^[a-z0-9.-]{1,253}$/i.test(v.r) ? v.r.toLowerCase() : null;
    return { path: v.p.slice(0, 500), referrer: ref };
  } catch { return null; }
}

/** Requests that are not a person's browser, or a person who asked not to be counted. */
export function skipRequest(h: Headers): boolean {
  if (h.get('sec-gpc') === '1' || h.get('dnt') === '1') return true;
  const ua = h.get('user-agent') ?? '';
  return !ua || /bot|crawl|spider|slurp|headless|lighthouse|preview|monitor|curl|wget|python|java\/|go-http/i.test(ua);
}

const HOST = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/;

/** Website hosts, one per line or separated by commas, without www. or a scheme. */
export const hostsSchema = z.string().max(2000).transform((s) => [...new Set(s.split(/[\s,]+/)
  .map((x) => x.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/[/?#].*$/, '').replace(/^www\./, ''))
  .filter(Boolean))])
  .refine((a) => a.length <= 10, 'List at most 10 websites.')
  .refine((a) => a.every((h) => HOST.test(h)), 'Each website must be a domain, such as acme.com.');

export function snippet(appUrl: string, key: string): string {
  return `<script async src="${appUrl.replace(/\/$/, '')}/v.js" data-site="${key}"></script>`;
}

export function topPaths(v: unknown, n = 3): string[] {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return [];
  return Object.entries(v as Record<string, unknown>).filter(([, c]) => typeof c === 'number')
    .sort((a, b) => (b[1] as number) - (a[1] as number)).slice(0, n).map(([p]) => p);
}
