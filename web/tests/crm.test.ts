import { describe, test, expect } from 'vitest';
import { DEFAULT_STAGE_MAP, describeCrmSync, parseCrmForm, savedStage } from '@/lib/crm';
import { describeJobResult, JOB_LABELS, JOB_TYPES } from '@/lib/campaigns';

const form = (over: Record<string, string> = {}) => {
  const f = new FormData();
  const base: Record<string, string> = { crm_sync_enabled: 'on', crm_sync_scope: 'engaged', crm_pipeline_id: 'default', ...DEFAULT_STAGE_MAP_FIELDS, ...over };
  for (const [k, v] of Object.entries(base)) if (v !== '__omit') f.set(k, v);
  return f;
};
const DEFAULT_STAGE_MAP_FIELDS = Object.fromEntries(Object.entries(DEFAULT_STAGE_MAP).map(([k, v]) => [`stage_${k}`, v]));

describe('CRM sync settings', () => {
  test('WCR-01 default stages are not stored; custom ones are', () => {
    const r = parseCrmForm(form());
    expect(r.success && r.data).toEqual({ crm_sync_enabled: true, crm_sync_scope: 'engaged', crm_pipeline_id: 'default', crm_stage_map: {} });
    const c = parseCrmForm(form({ crm_pipeline_id: ' 7788 ', stage_won: '1001', stage_lost: '1002', crm_sync_enabled: '__omit' }));
    expect(c.success && c.data).toEqual({ crm_sync_enabled: false, crm_sync_scope: 'engaged', crm_pipeline_id: '7788', crm_stage_map: { won: '1001', lost: '1002' } });
    const blank = parseCrmForm(form({ crm_pipeline_id: '', stage_won: '' }));
    expect(blank.success && blank.data.crm_pipeline_id).toBe('default');
  });

  test('WCR-02 bad ids, an unknown scope and duplicate stages are refused with clear messages', () => {
    const bad = parseCrmForm(form({ stage_won: 'closed won!' }));
    expect(!bad.success && bad.error.issues[0].message).toBe('The HubSpot stage for Won must be letters, numbers, dashes or underscores.');
    const dup = parseCrmForm(form({ stage_lost: 'closedwon' }));
    expect(!dup.success && dup.error.issues[0].message).toBe('Each of your stages needs its own HubSpot stage.');
    const scope = parseCrmForm(form({ crm_sync_scope: 'all' }));
    expect(!scope.success && scope.error.issues[0].message).toBe('Choose which leads to send.');
    const pipe = parseCrmForm(form({ crm_pipeline_id: 'a b' }));
    expect(!pipe.success && pipe.error.issues[0].message).toBe('The pipeline must be a HubSpot id: letters, numbers, dashes or underscores.');
  });

  test('WCR-03 saved stages show the custom id or the default', () => {
    expect(savedStage({ won: '1001' }, 'won')).toBe('1001');
    expect(savedStage({ won: '<x>' }, 'won')).toBe('closedwon');
    expect(savedStage(null, 'negotiation')).toBe('decisionmakerboughtin');
  });

  test('WCR-04 sync runs are described in plain words', () => {
    expect(JOB_TYPES).toContain('crm_sync');
    expect(JOB_LABELS.crm_sync).toBe('CRM sync');
    expect(describeJobResult('crm_sync', 'succeeded', { contacts_sent: 3, deals_created: 1, deals_updated: 0, notes_created: 2, closed_from_crm: 1, contacts_without_email: 4, rate_limited: false }, null))
      .toBe('3 contacts sent; 1 deal created; 2 activity notes added; 1 deal closed from HubSpot; 4 without an email skipped.');
    expect(describeJobResult('crm_sync', 'succeeded', { contacts_sent: 0 }, null)).toBe('HubSpot is up to date.');
    expect(describeJobResult('crm_sync', 'succeeded', { contacts_sent: 1, rate_limited: true }, null)).toBe('1 contact sent. HubSpot asked to slow down; the rest syncs next hour.');
    expect(describeJobResult('crm_sync', 'succeeded', { skipped: 'HubSpot is not connected' }, null)).toBe('HubSpot is not connected.');
    expect(describeJobResult('crm_sync', 'failed', {}, 'HubSpot rejected the access token. Reconnect HubSpot in Setup.')).toBe('HubSpot rejected the access token. Reconnect HubSpot in Setup.');
  });
});
