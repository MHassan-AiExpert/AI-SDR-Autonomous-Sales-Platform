import { describe, test, expect } from 'vitest';
import { normalizeEmail, extractEmails, normalizePhone, domainFromUrl, normalizeInstagramHandle, normalizeLinkedinUrl, cleanText } from '../src/normalize.ts';
import { normalizeCandidate, hasContact, identityKeys, dedupe, isSuppressed, type LeadCandidate } from '../src/leads.ts';

describe('normalisation', () => {
  test('NRM-01 emails are lower-cased and junk addresses dropped', () => {
    expect(normalizeEmail('  Jane.Doe@Acme.COM ')).toBe('jane.doe@acme.com');
    expect(normalizeEmail('mailto:info@clinic.co.uk')).toBe('info@clinic.co.uk');
    for (const bad of ['noreply@acme.com', 'user@example.com', 'logo@2x.png', 'not-an-email', 'a@b', 'x@sentry.io.wixpress.com']) {
      expect(normalizeEmail(bad)).toBeUndefined();
    }
  });

  test('NRM-02 emails are found inside an Instagram bio', () => {
    expect(extractEmails('📍 Austin | Book: Hello@GlowSpa.com or DM us. hello@glowspa.com')).toEqual(['hello@glowspa.com']);
    expect(extractEmails('no email here')).toEqual([]);
  });

  test('NRM-03 phone numbers keep digits and a leading plus', () => {
    expect(normalizePhone('+1 (512) 555-0182')).toBe('+15125550182');
    expect(normalizePhone('0044 20 7946 0958')).toBe('+442079460958');
    expect(normalizePhone('512.555.0182')).toBe('5125550182');
    expect(normalizePhone('12345')).toBeUndefined();
    expect(normalizePhone('1'.repeat(16))).toBeUndefined();
  });

  test('NRM-04 domains come from websites, not from social or link pages', () => {
    expect(domainFromUrl('https://www.SmileDental.com/contact?x=1')).toBe('smiledental.com');
    expect(domainFromUrl('smiledental.com')).toBe('smiledental.com');
    for (const notOwn of ['https://instagram.com/x', 'https://linktr.ee/spa', 'https://m.facebook.com/page', 'https://wa.me/123', 'not a url']) {
      expect(domainFromUrl(notOwn)).toBeUndefined();
    }
  });

  test('NRM-05 Instagram handles and LinkedIn URLs are reduced to one form', () => {
    expect(normalizeInstagramHandle('@GlowSpa.ATX')).toBe('glowspa.atx');
    expect(normalizeInstagramHandle('https://www.instagram.com/glowspa_atx/?hl=en')).toBe('glowspa_atx');
    expect(normalizeInstagramHandle('https://instagram.com/p/abc')).toBeUndefined();
    expect(normalizeLinkedinUrl('http://linkedin.com/in/Jane-Doe-123/')).toBe('https://www.linkedin.com/in/jane-doe-123');
    expect(normalizeLinkedinUrl('https://linkedin.com/company/acme')).toBeUndefined();
    expect(cleanText('  a \n  b  ')).toBe('a b');
  });
});

const lead = (over: Partial<LeadCandidate> = {}): LeadCandidate => ({
  source: 'google_maps', sourceQuery: 'dentist in Austin', company: { name: 'Smile Dental', domain: 'https://smiledental.com' }, ...over,
});

describe('candidates', () => {
  test('DED-01 a candidate is normalised field by field', () => {
    const c = normalizeCandidate(lead({ email: 'INFO@SmileDental.com', phone: '(512) 555-0182', socialHandles: { instagram: '@SmileATX' }, company: { name: '  Smile   Dental ', domain: 'www.smiledental.com', googleRating: 4.76, googleReviews: 120.6 } }));
    expect(c.email).toBe('info@smiledental.com');
    expect(c.phone).toBe('5125550182');
    expect(c.socialHandles).toEqual({ instagram: 'smileatx' });
    expect(c.company).toMatchObject({ name: 'Smile Dental', domain: 'smiledental.com', googleRating: 4.8, googleReviews: 120 });
  });

  test('DED-02 a lead needs at least one way to reach it', () => {
    expect(hasContact(normalizeCandidate(lead()))).toBe(false);
    expect(hasContact(normalizeCandidate(lead({ phone: '+15125550182' })))).toBe(true);
    expect(hasContact(normalizeCandidate(lead({ socialHandles: { instagram: 'smileatx' } })))).toBe(true);
  });

  test('DED-03 duplicates are caught by email, phone, LinkedIn, Instagram or a nameless domain', () => {
    const seen = new Set<string>();
    const batch = [
      lead({ email: 'info@smiledental.com' }),
      lead({ email: 'INFO@smiledental.com', source: 'llm_search' }),
      lead({ phone: '+1 512 555 0182', company: { name: 'Other', domain: 'other.com' } }),
      lead({ phone: '15125550182', company: { name: 'Other 2' } }),
      lead({ socialHandles: { instagram: 'glow' }, company: { name: 'Glow' } }),
      lead({ socialHandles: { instagram: '@Glow' }, company: { name: 'Glow' } }),
      lead({ fullName: 'Dr Lee', email: 'lee@smiledental.com' }),
    ].map(normalizeCandidate);
    const { fresh, duplicates } = dedupe(batch, seen);
    expect(fresh.map((c) => c.email ?? c.phone ?? c.socialHandles?.instagram)).toEqual(['info@smiledental.com', '+15125550182', 'glow', 'lee@smiledental.com']);
    expect(duplicates).toBe(3);
    // The shared set also catches them in a later source of the same run
    expect(dedupe([normalizeCandidate(lead({ email: 'info@smiledental.com' }))], seen).duplicates).toBe(1);
  });

  test('DED-04 stored leads count as already seen', () => {
    const existing = new Set(identityKeys(normalizeCandidate(lead({ email: 'info@smiledental.com' }))));
    expect(dedupe([normalizeCandidate(lead({ email: 'info@smiledental.com' }))], existing).fresh).toHaveLength(0);
  });

  test('DED-05 suppressed emails, email domains, phones and company domains are blocked', () => {
    const s = { emails: new Set(['stop@a.com']), phones: new Set(['5125550182']), domains: new Set(['competitor.com']) };
    expect(isSuppressed(normalizeCandidate(lead({ email: 'stop@a.com', company: { name: 'A' } })), s)).toBe(true);
    expect(isSuppressed(normalizeCandidate(lead({ email: 'x@competitor.com', company: { name: 'C' } })), s)).toBe(true);
    expect(isSuppressed(normalizeCandidate(lead({ phone: '512 555 0182', company: { name: 'P' } })), s)).toBe(true);
    expect(isSuppressed(normalizeCandidate(lead({ phone: '1', company: { name: 'C', domain: 'competitor.com' } })), s)).toBe(true);
    expect(isSuppressed(normalizeCandidate(lead({ email: 'ok@fine.com', company: { name: 'F' } })), s)).toBe(false);
  });
});
