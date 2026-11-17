import { describe, expect, test } from 'vitest';
import { readFileSync } from 'node:fs';
import { clientIp, hostsSchema, originHost, parseBeacon, skipRequest, snippet, topPaths, SITE_KEY } from '../src/lib/visitors';
import { PROBES } from '../src/lib/connection-tests';
import { TOOLS, buildOnboardingPlan } from '../src/lib/integrations';

const H = (o: Record<string, string>) => new Headers(o);
const BROWSER = { 'user-agent': 'Mozilla/5.0 (Macintosh) AppleWebKit/605 Safari/605' };

describe('WVIS visitor tracking', () => {
  test('WVIS-01 the visitor address comes from the platform headers, and only a real address is used', () => {
    expect(clientIp(H({ 'x-vercel-forwarded-for': '203.0.113.7', 'x-forwarded-for': '10.0.0.1' }))).toBe('203.0.113.7');
    expect(clientIp(H({ 'x-forwarded-for': '198.51.100.20, 10.0.0.1' }))).toBe('198.51.100.20');
    expect(clientIp(H({ 'x-real-ip': '2001:db8::1' }))).toBe('2001:db8::1');
    expect(clientIp(H({ 'x-forwarded-for': 'unknown' }))).toBeNull();
    expect(clientIp(H({ 'x-forwarded-for': '999.1.1.1' }))).toBeNull();
    expect(clientIp(H({}))).toBeNull();
  });

  test('WVIS-02 the page host comes from the Origin header', () => {
    expect(originHost('https://www.Acme.com')).toBe('www.acme.com');
    expect(originHost('null')).toBeNull();
    expect(originHost('file:///x')).toBeNull();
    expect(originHost(null)).toBeNull();
  });

  test('WVIS-03 beacons are small JSON with a path; anything else is ignored', () => {
    expect(parseBeacon('{"p":"/pricing","r":"Google.com"}')).toEqual({ path: '/pricing', referrer: 'google.com' });
    expect(parseBeacon('{"p":"/x","r":"<script>"}')).toEqual({ path: '/x', referrer: null });
    expect(parseBeacon('{"p":"https://evil"}')).toBeNull();
    expect(parseBeacon('nope')).toBeNull();
    expect(parseBeacon(JSON.stringify({ p: '/' + 'a'.repeat(3000) }))).toBeNull();
  });

  test('WVIS-04 Global Privacy Control, Do Not Track and bots are not counted', () => {
    expect(skipRequest(H(BROWSER))).toBe(false);
    expect(skipRequest(H({ ...BROWSER, 'sec-gpc': '1' }))).toBe(true);
    expect(skipRequest(H({ ...BROWSER, dnt: '1' }))).toBe(true);
    for (const ua of ['Googlebot/2.1', 'HeadlessChrome/120', 'curl/8.0', 'python-requests/2', '']) expect(skipRequest(H({ 'user-agent': ua }))).toBe(true);
  });

  test('WVIS-05 website hosts are cleaned and checked', () => {
    expect(hostsSchema.parse('https://www.Acme.com/about\nblog.acme.com, acme.com')).toEqual(['acme.com', 'blog.acme.com']);
    expect(hostsSchema.safeParse('not a host').success).toBe(false);
    expect(hostsSchema.safeParse(Array.from({ length: 11 }, (_, i) => `h${i}.com`).join('\n')).success).toBe(false);
    expect(hostsSchema.parse('')).toEqual([]);
  });

  test('WVIS-06 the snippet and the script', () => {
    const k = 'site_' + 'a'.repeat(32);
    expect(SITE_KEY.test(k)).toBe(true);
    expect(snippet('https://app.example.com/', k)).toBe(`<script async src="https://app.example.com/v.js" data-site="${k}"></script>`);
    const js = readFileSync(new URL('../public/v.js', import.meta.url), 'utf8');
    expect(js).toContain('globalPrivacyControl');
    expect(js).toContain('doNotTrack');
    expect(js).toContain('sendBeacon');
    for (const banned of ['document.cookie', 'localStorage', 'sessionStorage', 'indexedDB']) expect(js).not.toContain(banned);
    expect(topPaths({ '/a': 1, '/b': 5, '/c': 3, '/d': 2 })).toEqual(['/b', '/c', '/d']);
    expect(topPaths(null)).toEqual([]);
  });

  test('WVIS-07 ipapi.is is an optional Setup step, checked with the key in the body', () => {
    expect(TOOLS.ipapi.fields.map((f) => [f.name, f.secret])).toEqual([['api_key', true]]);
    expect(PROBES.ipapi.url({ api_key: 'k' })).toBe('https://api.ipapi.is');
    const init = PROBES.ipapi.init({ api_key: 'k-123' });
    expect(JSON.parse(String(init.body))).toEqual({ q: '8.8.8.8', key: 'k-123' });
    const plan = buildOnboardingPlan({ enabledChannels: { email: true }, aiCloserEnabled: false, statuses: {}, checklist: {} } as never);
    expect(plan.steps.find((s) => s.id === 'visitors')).toMatchObject({ tools: ['ipapi'], required: false });
  });
});
