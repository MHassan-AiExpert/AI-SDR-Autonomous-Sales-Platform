import { describe, expect, it } from 'vitest';
import { parseEmailSettings, outreachReadiness, SEND_TIMEZONES } from '@/lib/outreach';
import { describeJobResult } from '@/lib/campaigns';

const form = (over: Record<string, string | null> = {}) => {
  const f = new FormData();
  const base: Record<string, string | null> = {
    sender_name: 'Sam Lee', email_footer: 'Acme Growth, 1 Main St, Austin TX. Reply "stop" to opt out.',
    sending_accounts: 'Sam@Acme-Mail.co\nsam2@acme-mail.co, sam@acme-mail.co', send_timezone: 'America/Chicago',
    send_window_start: '09:00', send_window_end: '17:00', day_1: 'on', day_3: 'on', daily_send_limit: '40', follow_up_count: '2', follow_up_delay_days: '3', ...over,
  };
  for (const [k, v] of Object.entries(base)) if (v !== null) f.set(k, v);
  return f;
};
const err = (over: Record<string, string | null>) => { const r = parseEmailSettings(form(over)); return r.success ? null : r.error.issues[0].message; };

describe('email settings', () => {
  it('OUT-W01 valid settings are parsed; mailboxes lower-cased and de-duplicated', () => {
    const r = parseEmailSettings(form());
    expect(r.success && r.data).toMatchObject({
      sending_accounts: ['sam@acme-mail.co', 'sam2@acme-mail.co'], daily_send_limit: 40, follow_up_count: 2,
      send_days: { 0: false, 1: true, 2: false, 3: true, 4: false, 5: false, 6: false },
    });
  });

  it('OUT-W02 each mistake gives a clear message', () => {
    expect(err({ sender_name: '' })).toBe('Add the sender name');
    expect(err({ email_footer: 'Acme' })).toBe('Add a footer with your company name, postal address and how to opt out');
    expect(err({ email_footer: 'Acme Growth, 1 Main St {{unsubscribe}} please' })).toBe('The footer cannot contain HTML or {{ }} placeholders');
    expect(err({ sending_accounts: 'not-an-email' })).toBe('Each sending mailbox must be a valid email address');
    expect(err({ sending_accounts: '' })).toBe('Add at least one sending mailbox');
    expect(err({ send_timezone: 'Mars/Base' })).toBe('Choose a time zone');
    expect(err({ send_window_start: '18:00' })).toBe('The sending window must end after it starts');
    expect(err({ day_1: null, day_3: null })).toBe('Choose at least one sending day');
    expect(err({ follow_up_count: '9' })).toBe('Follow-ups must be 0 to 4');
    expect(err({ send_window_end: '5pm' })).toBe('Use a time like 09:00');
  });

  it('OUT-W03 every listed time zone is one the sending service accepts', () => {
    expect(SEND_TIMEZONES).toContain('Asia/Karachi');
    expect(new Set(SEND_TIMEZONES).size).toBe(SEND_TIMEZONES.length);
  });
});

describe('launch readiness', () => {
  const ok = { instantlyConnected: true, emailChannelOn: true, senderName: 'Sam', footer: 'Acme, 1 Main St', accounts: ['sam@a.co'], sendingDomainsChecked: false };
  it('OUT-W04 launch needs Instantly, the email channel, a mailbox, a sender and a footer; domain warm-up is recommended', () => {
    expect(outreachReadiness(ok).ready).toBe(true);
    expect(outreachReadiness(ok).items.find((i) => i.id === 'domains')).toMatchObject({ done: false, blocking: false });
    for (const patch of [{ instantlyConnected: false }, { emailChannelOn: false }, { accounts: [] }, { senderName: ' ' }, { footer: null }]) {
      expect(outreachReadiness({ ...ok, ...patch }).ready).toBe(false);
    }
  });

  it('OUT-W05 copywriting and sending runs are described in plain words', () => {
    expect(describeJobResult('copywriting', 'succeeded', { leads_written: 3, waiting_for_approval: true, failed: 1 }, null)).toBe('3 email sequences written, waiting for approval; 1 could not be written and will be retried.');
    expect(describeJobResult('copywriting', 'succeeded', { leads_written: 1, waiting_for_approval: false }, null)).toBe('1 email sequence written and approved.');
    expect(describeJobResult('email_outreach', 'succeeded', { action: 'sending', leads_added: 2, daily_limit: 40 }, null)).toBe('2 leads added to Instantly today (daily limit 40).');
    expect(describeJobResult('email_outreach', 'succeeded', { action: 'paused', reason: 'All outreach is paused for this workspace.' }, null)).toBe('Instantly campaign paused. All outreach is paused for this workspace.');
  });
});
