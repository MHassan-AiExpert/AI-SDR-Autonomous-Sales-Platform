import { describe, expect, test } from 'vitest';
import { DECISION_NOTICES, KIND_LABELS, SUGGESTION_STATUS_LABELS, confidenceLabel, pct, readFindings } from '@/lib/learning';
import { describeJobResult, JOB_LABELS, JOB_TYPES } from '@/lib/campaigns';

const finding = { id: 'subject_style:question', label: 'Subject line style', direction: 'better', text: 'Subject lines written as a question won interest 25.0% of the time.', n: 60, rest_n: 60, p: 0.004 };

describe('learning', () => {
  test('LW-01 findings are read defensively; anything malformed is left out', () => {
    expect(readFindings([finding, { ...finding, direction: 'sideways' }, 'junk', null])).toEqual([finding]);
    expect(readFindings({})).toEqual([]);
  });

  test('LW-02 labels, confidence and percentages', () => {
    expect([confidenceLabel(0.004), confidenceLabel(0.03)]).toEqual(['very clear', 'clear']);
    expect([pct(0.1534), pct('x'), pct(Number.NaN)]).toEqual(['15.3%', '—', '—']);
    for (const s of ['proposed', 'applied', 'dismissed', 'removed']) expect(SUGGESTION_STATUS_LABELS[s]).toBeTruthy();
    for (const k of ['copy_guidance', 'score_threshold']) expect(KIND_LABELS[k]).toBeTruthy();
    for (const d of ['applied', 'dismissed', 'removed']) expect(DECISION_NOTICES[d]).toBeTruthy();
  });

  test('LW-03 learning runs are described in plain words', () => {
    expect(JOB_TYPES).toContain('learning');
    expect(JOB_LABELS.learning).toBe('Weekly learning');
    expect(describeJobResult('learning', 'succeeded', { leads: 120, findings: 2, suggestions: 2, applied: 1 }, null)).toBe('Looked at 120 leads; 2 clear patterns; 1 lesson applied; 1 suggestion waiting for you.');
    expect(describeJobResult('learning', 'succeeded', { leads: 0 }, null)).toBe('No first emails in the last 90 days to learn from yet.');
  });
});
