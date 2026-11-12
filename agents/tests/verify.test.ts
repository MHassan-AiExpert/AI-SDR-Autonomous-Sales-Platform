import { describe, test, expect } from 'vitest';
import { isPrivateAddress, assertPublicUrl, findSiteContacts } from '../src/sources/website.ts';
import { mapZeroBounceStatus, verifyEmail, mapLineType, lookupPhone } from '../src/sources/verify.ts';
import { findDecisionMakers, enrichOrganization } from '../src/sources/apollo.ts';
import { normalizePersonName } from '../src/normalize.ts';
import { mapLimit } from '../src/enrichment.ts';
import { fakeFetch } from './harness.ts';

const publicDns = async () => ['93.184.216.34'];
const html = (body: string, status = 200, headers: Record<string, string> = {}) =>
  new Response(body, { status, headers: { 'content-type': 'text/html; charset=utf-8', ...headers } });

describe('website contacts', () => {
  test('WEB-01 private, loopback, link-local and metadata addresses are recognised', () => {
    for (const ip of ['10.1.2.3', '127.0.0.1', '169.254.169.254', '172.20.0.1', '192.168.1.1', '100.64.0.1', '0.0.0.0', '::1', 'fd00::1', 'fe80::1', '::ffff:127.0.0.1', '224.0.0.1']) {
      expect(isPrivateAddress(ip), ip).toBe(true);
    }
    for (const ip of ['93.184.216.34', '8.8.8.8', '2606:4700::1111']) expect(isPrivateAddress(ip), ip).toBe(false);
  });

  test('WEB-02 only public web addresses on standard ports are fetched', async () => {
    await expect(assertPublicUrl(new URL('https://shop.example.org/'), publicDns)).resolves.toBeUndefined();
    await expect(assertPublicUrl(new URL('https://intranet.example.org/'), async () => ['10.0.0.5'])).rejects.toThrow(/public address/);
    await expect(assertPublicUrl(new URL('https://a.example.org/'), async () => ['93.184.216.34', '127.0.0.1'])).rejects.toThrow(/public address/);
    await expect(assertPublicUrl(new URL('http://169.254.169.254/latest'), publicDns)).rejects.toThrow(/IP addresses/);
    await expect(assertPublicUrl(new URL('https://a.example.org:8443/'), publicDns)).rejects.toThrow(/port/);
    await expect(assertPublicUrl(new URL('ftp://a.example.org/'), publicDns)).rejects.toThrow(/web addresses/);
    await expect(assertPublicUrl(new URL('https://user:pw@a.example.org/'), publicDns)).rejects.toThrow(/Credentials/);
  });

  test('WEB-03 the company\'s own email and a tel: link are found on its pages', async () => {
    const f = fakeFetch([
      [/brightteeth\.com\/$/, () => html('<a href="mailto:partners@agency.com">Made by agency</a>')],
      [/brightteeth\.com\/contact$/, () => html('<p>Write to hello&#64;BrightTeeth.com</p><a href="tel:+1%20512%20555%200199">Call</a>')],
    ]);
    expect(await findSiteContacts('brightteeth.com', f.impl, publicDns)).toEqual({ email: 'hello@brightteeth.com', phone: '+15125550199', pagesRead: 2 });
    expect(f.calls.map((c) => c.url)).toEqual(['https://brightteeth.com/', 'https://brightteeth.com/contact']);
  });

  test('WEB-04 a redirect to an internal address is refused', async () => {
    const f = fakeFetch([[/brightteeth\.com/, () => html('', 302, { location: 'https://internal.brightteeth.com/' })]]);
    const resolve = async (host: string) => (host.startsWith('internal.') ? ['10.0.0.9'] : ['93.184.216.34']);
    expect(await findSiteContacts('brightteeth.com', f.impl, resolve)).toEqual({ email: undefined, phone: undefined, pagesRead: 0 });
    expect(f.calls.some((c) => c.url.includes('internal.'))).toBe(false);
  });

  test('WEB-05 non-HTML answers, errors and other companies\' addresses are ignored', async () => {
    const f = fakeFetch([
      [/a\.com\/$/, () => new Response('{"x":"info@a.com"}', { headers: { 'content-type': 'application/json' } })],
      [/a\.com\/contact$/, () => html('Contact info@wix.com or sales@other.com', 200)],
      [/a\.com\/contact-us$/, () => html('', 500)],
    ]);
    expect(await findSiteContacts('a.com', f.impl, publicDns)).toMatchObject({ email: undefined, pagesRead: 1 });
  });
});

describe('verification', () => {
  test('VER-01 ZeroBounce statuses map to the lead verification status', () => {
    expect(['valid', 'catch-all', 'invalid', 'spamtrap', 'abuse', 'do_not_mail', 'unknown', undefined].map((s) => mapZeroBounceStatus(s)))
      .toEqual(['valid', 'catch_all', 'invalid', 'invalid', 'invalid', 'invalid', 'risky', 'risky']);
  });

  test('VER-02 an email is verified with the company\'s ZeroBounce key', async () => {
    const f = fakeFetch([[/api\.zerobounce\.net\/v2\/validate/, () => ({ address: 'ana@ruizdental.com', status: 'valid', sub_status: '' })]]);
    expect(await verifyEmail('ana@ruizdental.com', 'zb-key', f.impl)).toEqual({ verdict: 'valid', raw: 'valid' });
    const u = new URL(f.calls[0].url);
    expect([u.searchParams.get('api_key'), u.searchParams.get('email')]).toEqual(['zb-key', 'ana@ruizdental.com']);
  });

  test('VER-03 ZeroBounce key and credit errors become clear messages without the key', async () => {
    const bad = fakeFetch([[/zerobounce/, () => ({ error: 'Invalid API key or your account ran out of credits' })]]);
    await expect(verifyEmail('a@b.com', 'zb-key', bad.impl)).rejects.toMatchObject({ status: 402, message: expect.not.stringContaining('zb-key') });
    const key = fakeFetch([[/zerobounce/, () => ({ error: 'Invalid API Key.' })]]);
    await expect(verifyEmail('a@b.com', 'zb-key', key.impl)).rejects.toMatchObject({ status: 401, message: 'ZeroBounce rejected the stored credentials' });
  });

  test('VER-04 Twilio line types map to mobile, landline, VoIP or unknown', () => {
    expect(['mobile', 'personal', 'landline', 'fixedVoip', 'nonFixedVoip', 'tollFree', undefined].map(mapLineType))
      .toEqual(['mobile', 'mobile', 'landline', 'voip', 'voip', 'unknown', 'unknown']);
  });

  test('VER-05 a phone is looked up with basic auth and returns E.164, country and type', async () => {
    const f = fakeFetch([[/lookups\.twilio\.com\/v2\/PhoneNumbers\/%2B15125550101\?Fields=line_type_intelligence/, () => ({
      valid: true, phone_number: '+15125550101', country_code: 'US', line_type_intelligence: { type: 'mobile', carrier_name: 'X' },
    })]]);
    expect(await lookupPhone('+15125550101', 'AC1', 'tok', f.impl)).toEqual({ valid: true, e164: '+15125550101', country: 'US', lineType: 'mobile' });
    expect((f.calls[0].init.headers as Record<string, string>).Authorization).toBe(`Basic ${Buffer.from('AC1:tok').toString('base64')}`);
    const missing = fakeFetch([[/twilio/, () => new Response('{}', { status: 404 })]]);
    expect(await lookupPhone('+1999', 'AC1', 'tok', missing.impl)).toEqual({ valid: false, lineType: 'unknown' });
  });
});

describe('Apollo enrichment', () => {
  test('APO-01 decision makers are searched by domain and kept only at their current company', async () => {
    const f = fakeFetch([
      [/api_search/, () => ({ people: [{ id: 'p1' }, { id: 'p2' }, { id: 'p3' }, { id: 'p4' }] })],
      [/bulk_match/, () => ({ matches: [
        { id: 'p1', name: 'Kim Bright', title: 'Owner', email: 'kim@brightteeth.com', organization: { name: 'Bright Teeth', primary_domain: 'brightteeth.com' } },
        { id: 'p2', name: 'Lou Bright', title: 'Office Manager', email: 'lou@brightteeth.com', organization: { name: 'Bright Teeth', primary_domain: 'brightteeth.com' } },
        { id: 'p3', name: 'Third Person', title: 'Owner', email: 'third@brightteeth.com', organization: { name: 'Bright Teeth', primary_domain: 'brightteeth.com' } },
        { id: 'p4', name: 'Moved On', title: 'Owner', email: 'm@newjob.com', organization: { name: 'New Job', primary_domain: 'newjob.com' } },
      ] })],
    ]);
    const { byDomain, creditsUsed } = await findDecisionMakers(['brightteeth.com'], ['Owner', 'Office Manager'], 'k', { perCompany: 2, limit: 50, fetchImpl: f.impl });
    expect(byDomain.get('brightteeth.com')!.map((l) => l.email)).toEqual(['kim@brightteeth.com', 'lou@brightteeth.com']);
    expect(byDomain.has('newjob.com')).toBe(false);
    expect(creditsUsed).toBe(4);
    const q = new URL(f.calls[0].url).searchParams;
    expect(q.getAll('q_organization_domains_list[]')).toEqual(['brightteeth.com']);
    expect(q.getAll('person_titles[]')).toEqual(['Owner', 'Office Manager']);
  });

  test('APO-02 company details come from organisation enrichment', async () => {
    const f = fakeFetch([[/organizations\/enrich\?domain=smile1\.com/, () => ({ organization: { industry: 'Medical Practice', estimated_num_employees: 14, city: 'Austin', state: 'Texas', country: 'United States', linkedin_url: 'https://linkedin.com/company/smile1' } })]]);
    expect(await enrichOrganization('smile1.com', 'k', f.impl)).toEqual({ industry: 'Medical Practice', sizeBand: '14', location: 'Austin, Texas, United States', linkedin: 'https://linkedin.com/company/smile1', phone: undefined });
    const none = fakeFetch([[/organizations/, () => ({})]]);
    expect(await enrichOrganization('x.com', 'k', none.impl)).toBeNull();
  });
});

describe('helpers', () => {
  test('HLP-01 names typed in one case are tidied; mixed case is kept', () => {
    expect(normalizePersonName('JOHN MCDONALD')).toBe('John McDonald');
    expect(normalizePersonName("mary o'neil-smith")).toBe("Mary O'Neil-Smith");
    expect(normalizePersonName('DeShawn van der Berg')).toBe('DeShawn van der Berg');
    expect(normalizePersonName('  ')).toBeUndefined();
  });

  test('HLP-02 work runs with a concurrency limit and keeps order', async () => {
    let running = 0, peak = 0;
    const out = await mapLimit([1, 2, 3, 4, 5, 6, 7], 3, async (n) => {
      running++; peak = Math.max(peak, running);
      await new Promise((r) => setTimeout(r, 5));
      running--;
      return n * 2;
    });
    expect(out).toEqual([2, 4, 6, 8, 10, 12, 14]);
    expect(peak).toBe(3);
  });
});
