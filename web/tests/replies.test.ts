import { describe, expect, it } from 'vitest';
import { parseInboxFilter, replyBadge, safeConversationUrl, REPLY_CLASSES, REPLY_LABELS } from '@/lib/replies';
import { describeJobResult } from '@/lib/campaigns';

describe('reply inbox', () => {
  it('RIN-01 filters default to replies still to handle; unknown values are ignored', () => {
    expect(parseInboxFilter({})).toEqual({ view: 'open', kind: null });
    expect(parseInboxFilter({ view: 'handled', kind: 'interested' })).toEqual({ view: 'handled', kind: 'interested' });
    expect(parseInboxFilter({ view: 'x', kind: 'needs_answer' })).toEqual({ view: 'open', kind: 'needs_answer' });
    expect(parseInboxFilter({ kind: "interested') or true" })).toEqual({ view: 'open', kind: null });
  });

  it('RIN-02 only Instantly conversation links are shown', () => {
    expect(safeConversationUrl('https://app.instantly.ai/app/unibox?x=1')).toBe('https://app.instantly.ai/app/unibox?x=1');
    for (const bad of ['https://evil.example/instantly.ai/', 'http://app.instantly.ai/', 'javascript:alert(1)', 'https://instantly.ai.evil.com/', null]) {
      expect(safeConversationUrl(bad)).toBeNull();
    }
  });

  it('RIN-03 every reply type has a label and a colour', () => {
    for (const c of REPLY_CLASSES) expect(REPLY_LABELS[c]).toBeTruthy();
    expect([replyBadge('interested'), replyBadge('question'), replyBadge('unsubscribe'), replyBadge('out_of_office')]).toEqual(['ok', 'warn', 'error', '']);
  });

  it('RIN-04 reply agent runs are described in plain words', () => {
    expect(describeJobResult('reply_handling', 'succeeded', { replies: 4, hot: 1, unsubscribed: 1, bounced: 1, sent: 3 }, null))
      .toBe('4 replies read: 1 needs you, 1 unsubscribed; 1 bounce; 3 emails sent.');
    expect(describeJobResult('reply_handling', 'succeeded', { replies: 0, hot: 0, unsubscribed: 0, bounced: 0, sent: 0, alert_error: 'Slack rejected the stored credentials' }, null))
      .toBe('No new replies. Slack alert failed: Slack rejected the stored credentials');
  });
});
