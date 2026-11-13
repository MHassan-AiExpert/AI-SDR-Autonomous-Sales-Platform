import { describe, expect, test } from 'vitest';
import { campaignsCsv, chartPoints, costPerMeeting, csvCell, money, parseRange, period, rate, readSummary, spendSchema } from '@/lib/analytics';

const summary = {
  funnel: { sourced: 10, verified: 8, emailed: 6, replied: 2, interested: 1, meetings_booked: 1, meetings_held: 1, won: 1 },
  revenue: [{ currency: 'USD', cents: 49900 }], won_by_ai: 1,
  channels: {
    email: { sent: 9, replies: 2, interested: 1 }, sms: { sent: 1, delivered: 1, replies: 0 }, whatsapp: { sent: 0, delivered: 0, replies: 0 },
    calls: { made: 2, connected: 1, interested: 1 }, closer: { meetings: 1, held: 1, proposals: 1, won: 1 },
    receptionist: { calls: 1, interested: 0, transferred: 1 }, audits: { ready: 1, opened: 1 },
  },
  daily: [{ day: '2026-11-12', emails: 4, replies: 1, meetings: 0 }, { day: '2026-11-13', emails: 2, replies: 2, meetings: 1 }],
  campaigns: [{ id: 'c1', name: '=Austin', status: 'active', sourced: 10, emailed: 6, replied: 2, interested: 1, meetings: 1, won: 1, revenue_cents: 49900 }],
};

describe('analytics', () => {
  test('DW-01 periods and the summary are read safely', () => {
    expect(parseRange('90d')).toBe('90d');
    expect(parseRange('5y')).toBe('30d');
    expect(parseRange(undefined)).toBe('30d');
    const p = period('7d', new Date('2026-11-13T00:00:00Z'));
    expect(p).toEqual({ from: new Date('2026-11-06T00:00:00Z'), to: new Date('2026-11-13T00:00:00Z'), days: 7 });
    expect(readSummary(summary)?.funnel.won).toBe(1);
    expect(readSummary({ ...summary, funnel: { ...summary.funnel, won: -1 } })).toBeNull();
    expect(readSummary(null)).toBeNull();
  });

  test('DW-02 rates, money and cost per meeting', () => {
    expect([rate(1, 8), rate(0, 0), rate(3, 3)]).toEqual(['12.5%', '—', '100.0%']);
    expect([money(49900, 'USD'), money(1999, 'EUR')]).toEqual(['$499', '€19.99']);
    expect(costPerMeeting(120000, 30, 4)).toBe(30000);
    expect(costPerMeeting(120000, 7, 2)).toBe(14000);
    expect(costPerMeeting(null, 30, 4)).toBeNull();
    expect(costPerMeeting(120000, 30, 0)).toBeNull();
  });

  test('DW-03 the daily chart scales each series into the box', () => {
    expect(chartPoints(summary.daily, 'emails', 100, 50, 4)).toBe('0,0 100,25');
    expect(chartPoints(summary.daily, 'meetings', 100, 50, 4)).toBe('0,50 100,37.5');
    expect(chartPoints([], 'emails', 100, 50, 4)).toBe('');
  });

  test('DW-04 the CSV quotes every cell and never lets a spreadsheet run a formula', () => {
    expect(csvCell('=HYPERLINK("x")')).toBe(`"'=HYPERLINK(""x"")"`);
    expect(csvCell('+1')).toBe(`"'+1"`);
    expect(csvCell('Austin')).toBe('"Austin"');
    const csv = campaignsCsv(summary.campaigns, 'USD');
    expect(csv.split('\r\n')[0]).toBe('"Campaign","Status","Leads sourced","Emailed","Replied","Reply rate","Interested","Meetings","Deals won","Revenue (USD)"');
    expect(csv.split('\r\n')[1]).toBe(`"'=Austin","active","10","6","2","33.3%","1","1","1","499.00"`);
  });

  test('DW-05 monthly spend is checked with one clear message each', () => {
    expect(spendSchema.safeParse({ monthly_spend: '1200.50', spend_currency: 'usd' }).data).toEqual({ monthly_spend: 120050, spend_currency: 'USD' });
    expect(spendSchema.safeParse({ monthly_spend: '', spend_currency: 'USD' }).data).toEqual({ monthly_spend: null, spend_currency: 'USD' });
    expect(spendSchema.safeParse({ monthly_spend: '12,00', spend_currency: 'USD' }).error?.issues[0].message).toBe('Enter the monthly amount, like 1200 or 1200.50');
    expect(spendSchema.safeParse({ monthly_spend: '100', spend_currency: 'dollars' }).error?.issues[0].message).toBe('Use a three-letter currency code, like USD');
  });
});
