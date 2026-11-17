import { describe, expect, test } from 'vitest';
import {
  CHECK_HELP, CHECK_LABELS, MAILBOX_STATUS, WARMUP_STATUS, asStatus, blocklistStatus, mailboxTone, rate, readBlocklists, readIssues,
  scoreBand, selectorSchema,
} from '../src/lib/deliverability';

describe('WDLV deliverability', () => {
  test('WDLV-01 stored issues are read defensively and failures come first', () => {
    const fix = { severity: 'warn', check: 'dmarc', message: 'p=none', fix: 'tighten' };
    const fail = { severity: 'fail', check: 'spf', message: 'No SPF record', fix: 'add one' };
    expect(readIssues([fix, fail, { severity: 'boom', check: 'x', message: 'y', fix: 'z' }, null, 'text', { severity: 'fail' }])).toEqual([fail, fix]);
    expect(readIssues({})).toEqual([]);
    expect(readIssues(null)).toEqual([]);
  });

  test('WDLV-02 a blocklist is clear only when every list answered clear', () => {
    const l = (status: string) => ({ list: 'L', status, detail: 'd' });
    expect(blocklistStatus(readBlocklists([l('clear'), l('clear'), l('clear')]))).toBe('pass');
    expect(blocklistStatus(readBlocklists([l('clear'), l('unknown')]))).toBe('unknown');
    expect(blocklistStatus(readBlocklists([l('unknown'), l('listed')]))).toBe('fail');
    expect(blocklistStatus(readBlocklists([]))).toBe('unknown');
    expect(readBlocklists([l('maybe'), { list: 1 }])).toEqual([]);
  });

  test('WDLV-03 unknown statuses never show as a pass', () => {
    expect(asStatus('pass')).toBe('pass');
    expect(asStatus(null)).toBe('unknown');
    expect(asStatus('PASS')).toBe('unknown');
  });

  test('WDLV-04 score bands', () => {
    expect(scoreBand(null)).toEqual({ label: 'Not checked yet', tone: 'unknown' });
    expect(scoreBand(100).tone).toBe('pass');
    expect(scoreBand(90).tone).toBe('pass');
    expect(scoreBand(67)).toEqual({ label: 'Needs work', tone: 'warn' });
    expect(scoreBand(25)).toEqual({ label: 'At risk', tone: 'fail' });
  });

  test('WDLV-05 mailbox tone follows sending and warm-up problems', () => {
    expect(mailboxTone('active', 'active')).toBe('pass');
    expect(mailboxTone('connection_error', 'active')).toBe('fail');
    expect(mailboxTone('active', 'banned')).toBe('fail');
    expect(mailboxTone('active', 'spam_folder_unknown')).toBe('warn');
    expect(mailboxTone('paused', 'paused')).toBe('warn');
    expect(mailboxTone('unknown', 'unknown')).toBe('unknown');
    for (const k of ['active', 'paused', 'maintenance', 'connection_error', 'soft_bounce_error', 'sending_error', 'unknown']) expect(MAILBOX_STATUS[k]).toBeTruthy();
    for (const k of ['active', 'paused', 'banned', 'spam_folder_unknown', 'suspended', 'unknown']) expect(WARMUP_STATUS[k]).toBeTruthy();
  });

  test('WDLV-06 rates need at least 20 sends', () => {
    expect(rate(1, 19)).toBe('—');
    expect(rate(1, 20)).toBe('5.0%');
    expect(rate(0, 0)).toBe('—');
    expect(rate(3, 1000)).toBe('0.3%');
  });

  test('WDLV-07 a DKIM selector is cleaned, and anything else is refused', () => {
    expect(selectorSchema.parse(' s1 ')).toBe('s1');
    expect(selectorSchema.parse('mx2026._domainkey.acme.com')).toBe('mx2026');
    expect(selectorSchema.parse('')).toBe('');
    expect(selectorSchema.safeParse('bad selector').success).toBe(false);
    expect(selectorSchema.safeParse('x;drop').success).toBe(false);
    expect(selectorSchema.safeParse('a'.repeat(64)).success).toBe(false);
  });

  test('WDLV-08 every check has a label and an explanation', () => {
    for (const k of ['spf', 'dkim', 'dmarc', 'mx', 'blocklist']) {
      expect(CHECK_LABELS[k]).toBeTruthy();
      expect(CHECK_HELP[k]).toBeTruthy();
    }
    expect(CHECK_HELP.dmarc).toContain('Gmail and Yahoo');
  });
});
