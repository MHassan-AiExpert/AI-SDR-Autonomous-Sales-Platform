// Reads a company's own website for a public business email and phone.
// Domains come from scraped data, so every request is guarded: only public
// IP addresses, http(s) on standard ports, few redirects, small pages, short
// timeouts (SRS 10.9).

import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import type { Fetch } from '../http.ts';
import { extractEmails, normalizePhone } from '../normalize.ts';

export type Resolver = (host: string) => Promise<string[]>;

export const defaultResolver: Resolver = async (host) => (await lookup(host, { all: true, verbatim: true })).map((a) => a.address);

/** True for loopback, private, link-local, carrier-grade NAT, multicast and other non-public ranges. */
export function isPrivateAddress(ip: string): boolean {
  if (isIP(ip) === 4) {
    const [a, b] = ip.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || a >= 224 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254)
      || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 198 && (b === 18 || b === 19));
  }
  const v6 = ip.toLowerCase();
  if (v6 === '::' || v6 === '::1') return true;
  if (v6.startsWith('::ffff:')) return isPrivateAddress(v6.slice(7));
  return /^(fc|fd|fe8|fe9|fea|feb|ff)/.test(v6);
}

export async function assertPublicUrl(url: URL, resolve: Resolver): Promise<void> {
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error('Only web addresses are allowed');
  if (url.port && url.port !== '80' && url.port !== '443') throw new Error('Non-standard port');
  if (url.username || url.password) throw new Error('Credentials in URL');
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (isIP(host)) throw new Error('IP addresses are not allowed');
  const addresses = await resolve(host);
  if (!addresses.length || addresses.some(isPrivateAddress)) throw new Error('The site does not resolve to a public address');
}

const MAX_BYTES = 1_000_000;

async function fetchPageAt(start: URL, fetchImpl: Fetch, resolve: Resolver): Promise<{ html: string; url: URL } | null> {
  let url = start;
  for (let hop = 0; hop < 4; hop++) {
    await assertPublicUrl(url, resolve);
    const res = await fetchImpl(url, {
      redirect: 'manual',
      headers: { Accept: 'text/html', 'User-Agent': 'Mozilla/5.0 (compatible; AISDR-Research/1.0)' },
      signal: AbortSignal.timeout(8_000),
    });
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get('location');
      if (!loc) return null;
      url = new URL(loc, url);
      continue;
    }
    if (!res.ok || !(res.headers.get('content-type') ?? '').includes('text/html')) return null;
    const text = await res.text();
    return { html: text.slice(0, MAX_BYTES), url };
  }
  return null;
}

async function fetchPage(start: URL, fetchImpl: Fetch, resolve: Resolver): Promise<string | null> {
  return (await fetchPageAt(start, fetchImpl, resolve))?.html ?? null;
}

/** The home page as a visitor gets it, with the address it ended on and how long it took. */
export async function fetchHomePage(domain: string, fetchImpl: Fetch = fetch, resolve: Resolver = defaultResolver, now: () => number = Date.now): Promise<{ html: string; url: string; ms: number; bytes: number } | null> {
  for (const scheme of ['https', 'http']) {
    const started = now();
    try {
      const page = await fetchPageAt(new URL(`${scheme}://${domain}/`), fetchImpl, resolve);
      if (page) return { html: page.html, url: page.url.toString(), ms: Math.max(0, now() - started), bytes: Buffer.byteLength(page.html) };
    } catch {
      /* try the next scheme */
    }
  }
  return null;
}

export type SiteContacts = { email?: string; phone?: string; pagesRead: number };

/**
 * Looks at the home page and common contact pages. Emails at the company's own
 * domain are preferred; another address is used only when it is the only one.
 */
export async function findSiteContacts(domain: string, fetchImpl: Fetch = fetch, resolve: Resolver = defaultResolver): Promise<SiteContacts> {
  const emails: string[] = [];
  const phones: string[] = [];
  let pagesRead = 0;
  for (const path of ['/', '/contact', '/contact-us']) {
    let html: string | null = null;
    try {
      html = await fetchPage(new URL(`https://${domain}${path}`), fetchImpl, resolve);
    } catch {
      html = null;
    }
    if (!html) continue;
    pagesRead++;
    const decoded = html.replace(/&#64;|&#x40;/gi, '@').replace(/%40/g, '@');
    emails.push(...extractEmails(decoded));
    for (const m of decoded.matchAll(/href=["']tel:([^"']+)["']/gi)) {
      const p = normalizePhone(decodeURIComponent(m[1]));
      if (p) phones.push(p);
    }
    const own = emails.find((e) => e.endsWith(`@${domain}`) || e.endsWith(`.${domain}`));
    if (own && phones.length) break;
  }
  const own = emails.find((e) => e.endsWith(`@${domain}`) || e.endsWith(`.${domain}`));
  const unique = [...new Set(emails)];
  return { email: own ?? (unique.length === 1 ? unique[0] : undefined), phone: phones.find((p) => p.startsWith('+')) ?? phones[0], pagesRead };
}

/** Readable text of an HTML page: no scripts, styles, tags or entities. */
export function htmlToText(html: string): string {
  return html
    .replace(/<(script|style|noscript|svg|template)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<\/(p|div|li|h[1-6]|section|article|br|tr)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&#\d+;/g, ' ')
    .replace(/[ \t\f\v]+/g, ' ')
    .replace(/\s*\n\s*/g, '\n')
    .replace(/\n{2,}/g, '\n')
    .trim();
}

/** Text from the home and about pages, for the research agent. */
export async function fetchSiteText(domain: string, fetchImpl: Fetch = fetch, resolve: Resolver = defaultResolver, maxChars = 8000): Promise<string> {
  const parts: string[] = [];
  for (const path of ['/', '/about', '/about-us']) {
    if (parts.join('\n').length >= maxChars) break;
    try {
      const html = await fetchPage(new URL(`https://${domain}${path}`), fetchImpl, resolve);
      if (html) parts.push(htmlToText(html));
    } catch {
      /* skip pages that cannot be read */
    }
  }
  return [...new Set(parts)].join('\n').slice(0, maxChars);
}
