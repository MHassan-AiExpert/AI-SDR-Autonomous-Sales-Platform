import { describe, test, expect, vi } from 'vitest';

vi.mock('next/headers', () => ({ headers: async () => new Headers() }));
vi.mock('@/lib/supabase/server', () => ({ createClient: async () => ({}) }));

const { DEFAULT_BRAND, brandStyle, normalizeHost, readBrand } = await import('@/lib/brand');
const { parseBrandForm, parseClientForm, parseDefaultsForm, readUsage, revenueText, usageCsv, usagePercent } = await import('@/lib/agency');

const fd = (o: Record<string, string>) => { const f = new FormData(); for (const [k, v] of Object.entries(o)) f.set(k, v); return f; };

describe('white-label brand', () => {
  test('WWL-01 a valid brand is used; anything malformed falls back to the platform brand', () => {
    expect(readBrand({ app_name: 'Northwind Sales Cloud', logo_url: 'https://cdn.northwind.test/l.png', primary_color: '#0e7c66', support_email: 'help@northwind.test' }))
      .toEqual({ app_name: 'Northwind Sales Cloud', logo_url: 'https://cdn.northwind.test/l.png', primary_color: '#0e7c66', support_email: 'help@northwind.test' });
    expect(readBrand({ app_name: 'X', logo_url: 'javascript:alert(1)' })).toEqual(DEFAULT_BRAND);
    expect(readBrand(null)).toEqual(DEFAULT_BRAND);
    expect(brandStyle(readBrand({ app_name: 'X', primary_color: '#0e7c66' }))).toEqual({ '--accent': '#0e7c66' });
    expect(brandStyle(DEFAULT_BRAND)).toBeUndefined();
  });

  test('WWL-02 host names are normalised before the brand lookup', () => {
    expect(normalizeHost('App.Northwind.test:443')).toBe('app.northwind.test');
    expect(normalizeHost('localhost:3000')).toBeNull();
    expect(normalizeHost("evil.test' or 1=1")).toBeNull();
    expect(normalizeHost(null)).toBeNull();
  });

  test('WWL-03 brand form: domain cleaned, colour and links checked', () => {
    const ok = parseBrandForm(fd({ app_name: 'Northwind', logo_url: '', primary_color: '#0E7C66', support_email: '', custom_domain: 'https://App.Northwind.test/login' }));
    expect(ok.success && ok.data).toEqual({ app_name: 'Northwind', logo_url: null, primary_color: '#0e7c66', support_email: null, custom_domain: 'app.northwind.test' });
    const msg = (o: Record<string, string>) => { const r = parseBrandForm(fd({ app_name: 'N', logo_url: '', primary_color: '#000000', support_email: '', custom_domain: '', ...o })); return r.success ? null : r.error.issues[0].message; };
    expect(msg({ logo_url: 'http://x.test/l.png' })).toBe('The logo must be an https:// image address.');
    expect(msg({ primary_color: 'teal' })).toBe('Choose a colour like #2f5bea.');
    expect(msg({ custom_domain: 'not a domain' })).toBe('Enter a domain like app.youragency.com.');
    expect(msg({ app_name: '' })).toBe('Enter the app name your clients will see.');
  });
});

describe('agency console', () => {
  test('WWL-04 client plans: empty limits mean no limit; bad limits are refused clearly', () => {
    const r = parseClientForm(fd({ name: 'Bright Dental', plan: 'Growth', monthly_lead_limit: '500', seat_limit: '' }));
    expect(r.success && r.data).toEqual({ name: 'Bright Dental', plan: 'Growth', monthly_lead_limit: 500, seat_limit: null });
    const bad = parseClientForm(fd({ name: 'Bright Dental', plan: 'Growth', monthly_lead_limit: '0', seat_limit: '' }));
    expect(!bad.success && bad.error.issues[0].message).toBe('The monthly lead limit must be a whole number from 1 to 1,000,000, or empty for no limit.');
    const plan = parseClientForm(fd({ plan: 'Pro', monthly_lead_limit: '', seat_limit: '5' }), false);
    expect(plan.success && plan.data).toEqual({ plan: 'Pro', monthly_lead_limit: null, seat_limit: 5 });
  });

  test('WWL-05 cadence defaults keep only the fields that were filled in', () => {
    const r = parseDefaultsForm(fd({ follow_up_count: '3', daily_send_limit: '120', send_window_start: '08:30' }));
    expect(r.success && r.data).toEqual({ follow_up_count: 3, daily_send_limit: 120, send_window_start: '08:30' });
    const bad = parseDefaultsForm(fd({ follow_up_count: '9' }));
    expect(!bad.success && bad.error.issues[0].message).toBe('Follow-ups must be from 0 to 4.');
    const t = parseDefaultsForm(fd({ call_window_end: '25:00' }));
    expect(!t.success && t.error.issues[0].message).toBe('Calling end must be a time like 09:00.');
  });

  test('WWL-06 usage is read safely and exported as safe CSV', () => {
    const row = { id: 'w1', name: '=HYPERLINK("x")', plan: 'Growth', monthly_lead_limit: 500, seat_limit: 3, outreach_paused: false, members: 2, leads_this_month: 460, leads: 120,
      emails: 300, calls: 12, call_minutes: 40, texts: 25, meetings: 4, won: 1, revenue: { USD: 149900 } };
    const rows = readUsage([row])!;
    expect(rows).toHaveLength(1);
    expect(readUsage([{ ...row, leads: -1 }])).toBeNull();
    expect(revenueText({ USD: 149900, EUR: 0 })).toBe('$1,499');
    expect(revenueText({})).toBe('—');
    expect(usagePercent(460, 500)).toBe(92);
    expect(usagePercent(10, null)).toBeNull();
    const csv = usageCsv(rows, new Date('2026-10-14T00:00:00Z'), new Date('2026-11-13T00:00:00Z'));
    const [head, line] = csv.trim().split('\r\n');
    expect(head.startsWith('"Client","Plan","Period from"')).toBe(true);
    expect(line).toBe(`"'=HYPERLINK(""x"")","Growth","2026-10-14","2026-11-13","2","3","120","460","500","300","12","40","25","4","1","USD 1499.00"`);
  });
});
