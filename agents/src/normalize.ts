// Cleaning contact data from every source into one comparable form.

const EMAIL = /^[a-z0-9._%+-]+@[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,24}$/;
const JUNK_EMAIL = /(^(noreply|no-reply|donotreply|example|test|user|email|name)@)|@(example\.(com|org|net)|sentry\.|wixpress\.com|domain\.com)|\.(png|jpe?g|gif|webp|svg)$/;

export function normalizeEmail(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const email = value.trim().toLowerCase().replace(/^mailto:/, '');
  if (email.length > 254 || !EMAIL.test(email) || JUNK_EMAIL.test(email)) return undefined;
  return email;
}

export function extractEmails(text: unknown): string[] {
  if (typeof text !== 'string') return [];
  const found = text.match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,24}/g) ?? [];
  return [...new Set(found.map(normalizeEmail).filter((e): e is string => Boolean(e)))];
}

/**
 * Strips formatting from a phone number. Keeps a leading + when present.
 * Returns undefined for anything that is not 7 to 15 digits.
 */
export function normalizePhone(value: unknown): string | undefined {
  if (typeof value !== 'string' && typeof value !== 'number') return undefined;
  const raw = String(value).trim();
  const plus = raw.startsWith('+') || raw.startsWith('00');
  const digits = raw.replace(/^00/, '').replace(/\D/g, '');
  if (digits.length < 7 || digits.length > 15) return undefined;
  return plus ? `+${digits}` : digits;
}

// Sites that host a business profile rather than being the business's own site.
const NOT_A_COMPANY_SITE = [
  'facebook.com', 'instagram.com', 'linkedin.com', 'twitter.com', 'x.com', 'tiktok.com', 'youtube.com',
  'linktr.ee', 'linktree.com', 'google.com', 'goo.gl', 'yelp.com', 'wa.me', 'whatsapp.com', 'bit.ly',
  'beacons.ai', 'taplink.cc', 'msha.ke', 'pinterest.com',
];

export function domainFromUrl(value: unknown): string | undefined {
  if (typeof value !== 'string' || !value.trim()) return undefined;
  let url: URL;
  try {
    url = new URL(/^https?:\/\//i.test(value.trim()) ? value.trim() : `https://${value.trim()}`);
  } catch {
    return undefined;
  }
  const host = url.hostname.toLowerCase().replace(/^www\./, '').replace(/\.$/, '');
  if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(host)) return undefined;
  if (NOT_A_COMPANY_SITE.some((d) => host === d || host.endsWith(`.${d}`))) return undefined;
  return host;
}

export function normalizeInstagramHandle(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  let handle = value.trim();
  const fromUrl = handle.match(/instagram\.com\/([A-Za-z0-9._]+)/i);
  if (fromUrl) handle = fromUrl[1];
  handle = handle.replace(/^@/, '').toLowerCase();
  if (!/^[a-z0-9._]{1,30}$/.test(handle) || ['p', 'reel', 'explore', 'accounts', 'stories'].includes(handle)) return undefined;
  return handle;
}

export function normalizeLinkedinUrl(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const m = value.trim().match(/linkedin\.com\/in\/([A-Za-z0-9_%-]+)/i);
  return m ? `https://www.linkedin.com/in/${m[1].toLowerCase()}` : undefined;
}

export function cleanText(value: unknown, max = 200): string | undefined {
  if (typeof value !== 'string') return undefined;
  const text = value.replace(/\s+/g, ' ').trim();
  return text ? text.slice(0, max) : undefined;
}

/**
 * Tidies a person's name for copy and call scripts (SRS FR-3.5): names typed
 * in all capitals or all lower case are title-cased; mixed case is kept.
 */
export function normalizePersonName(value: unknown): string | undefined {
  const name = cleanText(value, 160);
  if (!name) return undefined;
  if (name !== name.toUpperCase() && name !== name.toLowerCase()) return name;
  return name.toLowerCase().replace(/(^|[\s'-])(\p{L})/gu, (_m, sep: string, ch: string) => sep + ch.toUpperCase())
    .replace(/\bMc(\p{L})/gu, (_m, ch: string) => `Mc${ch.toUpperCase()}`);
}
