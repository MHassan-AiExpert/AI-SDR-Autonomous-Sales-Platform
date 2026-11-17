import { describe, test, expect } from 'vitest';
import { AGENT_COUNT, agentStatus, attentionItems, greeting, hourIn } from '@/lib/overview';

describe('overview', () => {
  test('OVW-01 only things that need someone are shown, each linking to the page that handles it', () => {
    const base = '/w/abc';
    expect(attentionItems({ handoffs: 0, drafts: 0, warnings: 0 }, base)).toEqual([]);
    const items = attentionItems({ handoffs: 2, drafts: 38, warnings: 1 }, base);
    expect(items.map((i) => [i.key, i.count, i.href])).toEqual([
      ['handoffs', 2, '/w/abc/notifications?view=handoffs'],
      ['drafts', 38, '/w/abc/campaigns'],
      ['warnings', 1, '/w/abc/notifications?view=attention'],
    ]);
    expect(attentionItems({ handoffs: 1, drafts: 0, warnings: 0 }, base)[0].title).toBe('Conversation waiting for a person');
    expect(items[0].title).toBe('Conversations waiting for a person');
    expect(attentionItems({ handoffs: 0, drafts: 5, warnings: 0 }, base).map((i) => i.key)).toEqual(['drafts']);
  });

  test('OVW-02 the status line says plainly whether the agents are working', () => {
    expect(AGENT_COUNT).toBe(17);
    expect(agentStatus(false)).toBe('All 17 AI agents are working');
    expect(agentStatus(true)).toBe('Outreach is paused: agents are not sending anything');
  });

  test('OVW-03 the greeting follows the workspace time zone', () => {
    const at = new Date('2026-11-17T10:30:00Z');
    expect(hourIn('Asia/Karachi', at)).toBe(15);
    expect(hourIn('Not/AZone', at)).toBe(10);
    expect(hourIn(null, at)).toBe(10);
    expect([greeting(9), greeting(15), greeting(21)]).toEqual(['Good morning', 'Good afternoon', 'Good evening']);
  });
});
