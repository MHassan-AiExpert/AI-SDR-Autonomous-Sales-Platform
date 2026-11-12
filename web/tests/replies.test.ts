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

import { ANSWER_LABELS, safeMeetingUrl, BOOKING_EVENT_TYPE } from '@/lib/replies';

describe('answers and meetings', () => {
  it('RIN-05 answer states have labels; only https meeting links and Calendly event types are accepted', () => {
    for (const s of ['none', 'draft', 'approved', 'sending', 'sent', 'failed']) expect(ANSWER_LABELS[s]).toBeTruthy();
    expect(safeMeetingUrl('https://zoom.us/j/123')).toBe('https://zoom.us/j/123');
    for (const bad of ['http://zoom.us/j/1', 'javascript:alert(1)', 'https://a b', null]) expect(safeMeetingUrl(bad)).toBeNull();
    expect(BOOKING_EVENT_TYPE.test('https://api.calendly.com/event_types/ABC-123')).toBe(true);
    expect(BOOKING_EVENT_TYPE.test('https://calendly.com/me/15min')).toBe(false);
  });

  it('RIN-06 answer sending runs are described in plain words', () => {
    expect(describeJobResult('reply_send', 'succeeded', { sent: 2, failed: 1, skipped: 1 }, null)).toBe('2 answers sent; 1 could not be sent; 1 skipped because the lead opted out or the thread is unknown.');
    expect(describeJobResult('reply_send', 'succeeded', { sent: 0, note: 'Email outreach is paused, so answers are waiting.' }, null)).toBe('Email outreach is paused, so answers are waiting.');
  });
});
