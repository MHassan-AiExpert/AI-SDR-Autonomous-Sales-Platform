// Deliverability dashboard (F27), for the interface.

import { z } from 'zod';

export type CheckStatus = 'pass' | 'warn' | 'fail' | 'unknown';
export type Issue = { severity: 'fail' | 'warn'; check: string; message: string; fix: string };
export type Blocklist = { list: string; status: 'listed' | 'clear' | 'unknown'; detail: string };

export const STATUS_LABELS: Record<CheckStatus, string> = { pass: 'Pass', warn: 'Warning', fail: 'Fail', unknown: 'Not checked' };

export const CHECK_LABELS: Record<string, string> = { spf: 'SPF', dkim: 'DKIM', dmarc: 'DMARC', mx: 'MX', blocklist: 'Blocklists' };

export const CHECK_HELP: Record<string, string> = {
  spf: 'Which services may send email for the domain',
  dkim: 'A signature proving the email was not changed on the way',
  dmarc: 'What receivers should do with email that fails SPF and DKIM; required by Gmail and Yahoo for bulk senders',
  mx: 'Where replies and bounces are delivered',
  blocklist: 'Spamhaus DBL, SURBL and URIBL',
};

export function asStatus(v: unknown): CheckStatus {
  return v === 'pass' || v === 'warn' || v === 'fail' ? v : 'unknown';
}

/** Issues stored by the agent, read defensively: anything malformed is left out. */
export function readIssues(v: unknown): Issue[] {
  if (!Array.isArray(v)) return [];
  return v.filter((i): i is Issue => !!i && typeof i === 'object'
    && (i.severity === 'fail' || i.severity === 'warn') && typeof i.message === 'string' && typeof i.fix === 'string' && typeof i.check === 'string')
    .sort((a, b) => (a.severity === b.severity ? 0 : a.severity === 'fail' ? -1 : 1));
}

export function readBlocklists(v: unknown): Blocklist[] {
  if (!Array.isArray(v)) return [];
  return v.filter((b): b is Blocklist => !!b && typeof b === 'object' && typeof b.list === 'string'
    && (b.status === 'listed' || b.status === 'clear' || b.status === 'unknown') && typeof b.detail === 'string');
}

/** The overall state of a blocklist check: listed beats unknown beats clear. */
export function blocklistStatus(lists: Blocklist[]): CheckStatus {
  if (!lists.length) return 'unknown';
  if (lists.some((l) => l.status === 'listed')) return 'fail';
  if (lists.every((l) => l.status === 'clear')) return 'pass';
  return 'unknown';
}

export function scoreBand(score: number | null): { label: string; tone: CheckStatus } {
  if (score === null) return { label: 'Not checked yet', tone: 'unknown' };
  if (score >= 90) return { label: 'Good', tone: 'pass' };
  if (score >= 60) return { label: 'Needs work', tone: 'warn' };
  return { label: 'At risk', tone: 'fail' };
}

export const MAILBOX_STATUS: Record<string, string> = {
  active: 'Sending', paused: 'Paused', maintenance: 'Maintenance', connection_error: 'Cannot connect',
  soft_bounce_error: 'Stopped after soft bounces', sending_error: 'Stopped after sending errors', unknown: 'Unknown',
};
export const WARMUP_STATUS: Record<string, string> = {
  active: 'Warming up', paused: 'Paused', banned: 'Banned', spam_folder_unknown: 'Cannot find spam folder', suspended: 'Suspended', unknown: 'Unknown',
};
export const PROVIDER_LABELS: Record<string, string> = { google: 'Google', microsoft: 'Microsoft', smtp: 'IMAP/SMTP', aws: 'AWS', airmail: 'Airmail', other: 'Other' };

export function mailboxTone(status: string, warmup: string): CheckStatus {
  if (['connection_error', 'soft_bounce_error', 'sending_error'].includes(status) || ['banned', 'suspended'].includes(warmup)) return 'fail';
  if (status === 'active' && warmup !== 'spam_folder_unknown') return 'pass';
  return status === 'unknown' ? 'unknown' : 'warn';
}

/** A percentage of sends, or a dash when too few were sent for it to mean anything. */
export function rate(part: number, sent: number, minimum = 20): string {
  if (sent < minimum) return '—';
  return `${(Math.round((part / sent) * 1000) / 10).toFixed(1)}%`;
}

export const selectorSchema = z.string().trim().max(63)
  .transform((s) => s.replace(/\._domainkey.*$/i, ''))
  .refine((s) => s === '' || /^[A-Za-z0-9._-]{1,63}$/.test(s), 'A selector uses only letters, numbers, dots, dashes and underscores, for example "s1" or "mx2026".');
