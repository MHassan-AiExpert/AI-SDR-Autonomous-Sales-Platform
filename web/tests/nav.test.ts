import { describe, test, expect } from 'vitest';
import { NAV_GROUPS, isActive } from '@/lib/nav';

describe('workspace navigation', () => {
  test('NAV-01 the sidebar keeps every workspace page, each exactly once', () => {
    const hrefs = NAV_GROUPS.flatMap((g) => g.items.map((i) => i.href));
    expect([...hrefs].sort()).toEqual([
      '', '/analytics', '/calls', '/campaigns', '/deals', '/deliverability', '/developers', '/inbox', '/leads', '/learning',
      '/meetings', '/members', '/notifications', '/playbook', '/settings', '/setup', '/signals', '/templates', '/texts', '/visitors',
    ]);
    expect(NAV_GROUPS.map((g) => g.title)).toEqual([null, 'Sell', 'Outreach', 'Insights', 'Manage']);
    expect(NAV_GROUPS[0].items.map((i) => i.label)).toEqual(['Home', 'Inbox', 'Notifications']);
  });

  test('NAV-02 the current page is highlighted, including pages below it', () => {
    const base = '/w/abc';
    expect(isActive('/w/abc', base, '')).toBe(true);
    expect(isActive('/w/abc/leads', base, '')).toBe(false);
    expect(isActive('/w/abc/leads', base, '/leads')).toBe(true);
    expect(isActive('/w/abc/leads/123', base, '/leads')).toBe(true);
    expect(isActive('/w/abc/leadsx', base, '/leads')).toBe(false);
    expect(isActive('/w/abc/campaigns/1/emails', base, '/campaigns')).toBe(true);
  });
});
