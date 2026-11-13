import { describe, expect, test } from 'vitest';
import { AUDIT_TOKEN, STATUS_LABELS, readPublicAudit, scoreBand, siteLink, viewSeconds } from '@/lib/audit';
import { describeJobResult, JOB_TYPES } from '@/lib/campaigns';

const audit = {
  title: 'Website and marketing audit for Bright Dental', score: 62, company: 'Bright Dental', first_name: 'Kim', from_company: 'Acme Growth', sender_name: 'Sam',
  created_at: '2026-11-13T00:00:00Z',
  content: { site: 'https://bright.test/', checks: [{ id: 'https', label: 'Secure connection (HTTPS)', status: 'pass', detail: 'Secure.' }], summary: 'Good start.', recommendations: [] },
};

describe('shared audits', () => {
  test('AW-01 the shared page reads only the expected fields and rejects anything else', () => {
    expect(readPublicAudit(audit)?.content.checks).toHaveLength(1);
    expect(readPublicAudit(null)).toBeNull();
    expect(readPublicAudit({ ...audit, score: 140 })).toBeNull();
    expect(readPublicAudit({ ...audit, content: { ...audit.content, checks: [{ ...audit.content.checks[0], status: 'great' }] } })).toBeNull();
    expect(readPublicAudit({ ...audit, content: {} })?.content).toEqual({ checks: [], summary: '', recommendations: [] });
  });

  test('AW-02 tokens, visit pings and site links are validated', () => {
    expect(AUDIT_TOKEN.test('a'.repeat(48))).toBe(true);
    for (const t of ['a'.repeat(47), 'A'.repeat(48), 'z'.repeat(48)]) expect(AUDIT_TOKEN.test(t)).toBe(false);
    expect(viewSeconds(0)).toBe(0);
    expect(viewSeconds(600)).toBe(600);
    for (const v of [601, -1, 1.5, '5', null]) expect(viewSeconds(v)).toBeNull();
    expect(siteLink('https://bright.test/')).toBe('https://bright.test/');
    for (const u of ['javascript:alert(1)', 'https://bright.test/page?x=1', undefined]) expect(siteLink(u)).toBeNull();
  });

  test('AW-03 score bands, labels and audit run results', () => {
    expect([scoreBand(90), scoreBand(60), scoreBand(20), scoreBand(null)]).toEqual(['good', 'fair', 'poor', 'poor']);
    for (const s of ['pass', 'warn', 'fail', 'unknown']) expect(STATUS_LABELS[s]).toBeTruthy();
    expect(JOB_TYPES).toContain('audit_reports');
    expect(describeJobResult('audit_reports', 'succeeded', { audits: 2, without_website: 1, opened: 1 }, null)).toBe('2 audits ready; 1 without a readable website; 1 audit opened.');
    expect(describeJobResult('audit_reports', 'succeeded', {}, null)).toBe('No new qualified leads to audit.');
  });
});
