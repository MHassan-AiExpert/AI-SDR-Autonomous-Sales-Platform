import { describe, test, expect } from 'vitest';
import { EVENTS, parseNotifyForm, safeJoinUrl, safeLink, unreadCount, validTimezone } from '@/lib/notifications';

const WS = '0b6c1a1e-2f43-4b8e-9d55-3a1f1c2b7e90';
const form = (over: Record<string, string> = {}, events: string[] = [...EVENTS]) => {
  const f = new FormData();
  for (const e of events) f.set(`event_${e}`, 'on');
  const base = { notify_quiet_start: '', notify_quiet_end: '', notify_timezone: 'Asia/Karachi', bounce_pause_pct: '5', optout_pause_pct: '3', low_credits_threshold: '100', ...over };
  for (const [k, v] of Object.entries(base)) f.set(k, v);
  return f;
};

describe('notification settings', () => {
  test('WNF-01 a full form saves the chosen events, quiet hours and limits', () => {
    const r = parseNotifyForm(form({ notify_quiet_start: '20', notify_quiet_end: '8', bounce_pause_pct: '4.5' }, ['handoff', 'system_alert']));
    expect(r.success && r.data).toEqual({
      notify_slack_events: ['handoff', 'system_alert'], notify_quiet_start: 20, notify_quiet_end: 8, notify_timezone: 'Asia/Karachi',
      bounce_pause_pct: 4.5, optout_pause_pct: 3, low_credits_threshold: 100,
    });
    const none = parseNotifyForm(form({}, []));
    expect(none.success && none.data).toMatchObject({ notify_slack_events: [], notify_quiet_start: null, notify_quiet_end: null });
  });

  test('WNF-02 half-set or empty quiet hours, a bad time zone and limits out of range are refused clearly', () => {
    const msg = (over: Record<string, string>) => { const r = parseNotifyForm(form(over)); return r.success ? null : r.error.issues[0].message; };
    expect(msg({ notify_quiet_start: '20' })).toBe('Set both the start and the end of quiet hours, or neither.');
    expect(msg({ notify_quiet_start: '9', notify_quiet_end: '9' })).toBe('Quiet hours must start and end at different times.');
    expect(msg({ notify_timezone: 'Mars/Olympus' })).toBe('Choose a time zone such as Europe/London or Asia/Karachi.');
    expect(msg({ bounce_pause_pct: '0' })).toBe('The bounce limit must be between 1 and 50.');
    expect(msg({ optout_pause_pct: '80' })).toBe('The opt-out limit must be between 1 and 50.');
    expect(msg({ low_credits_threshold: '-1' })).toBe('The low credit level cannot be negative.');
    expect(validTimezone('UTC')).toBe(true);
    expect(validTimezone('America/Argentina/Buenos_Aires')).toBe(true);
  });

  test('WNF-03 only links inside the workspace and https join links are followed', () => {
    expect(safeLink(`/w/${WS}/leads/${WS}`, WS)).toBe(`/w/${WS}/leads/${WS}`);
    expect(safeLink(`/w/${'1'.repeat(8)}-0000-0000-0000-000000000000/leads`, WS)).toBeNull();
    expect(safeLink('https://evil.example', WS)).toBeNull();
    expect(safeJoinUrl('https://zoom.us/j/123')).toBe('https://zoom.us/j/123');
    expect(safeJoinUrl('javascript:alert(1)')).toBeNull();
    expect(safeJoinUrl('http://zoom.us/j/1')).toBeNull();
  });

  test('WNF-04 unread counts only what arrived after the last visit', () => {
    const rows = [{ created_at: '2026-11-13T10:00:00Z' }, { created_at: '2026-11-13T12:00:00Z' }];
    expect(unreadCount(rows, null)).toBe(2);
    expect(unreadCount(rows, '2026-11-13T11:00:00Z')).toBe(1);
    expect(unreadCount(rows, '2026-11-13T13:00:00Z')).toBe(0);
  });
});
