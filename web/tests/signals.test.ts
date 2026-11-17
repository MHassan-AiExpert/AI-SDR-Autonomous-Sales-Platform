import { describe, expect, test } from 'vitest';
import {
  BUILT_IN_HELP, BUILT_IN_KINDS, INGEST_EXAMPLE, KIND_LABELS, MAX_SIGNALS_PER_REQUEST, SIGNAL_KINDS, TOKEN,
  ingestError, parseIngestBody, signalSettingsSchema,
} from '../src/lib/signals';
import { TRIGGERS, conditionFor, triggerOf } from '../src/lib/sequence';

describe('WSIG ingest body', () => {
  test('WSIG-01 one signal, or a list under "signals", is accepted', () => {
    expect(parseIngestBody('{"kind":"news","title":"x"}')).toEqual({ signals: [{ kind: 'news', title: 'x' }] });
    expect(parseIngestBody('{"signals":[{"kind":"news","title":"a"},{"kind":"hiring","title":"b"}]}'))
      .toEqual({ signals: [{ kind: 'news', title: 'a' }, { kind: 'hiring', title: 'b' }] });
  });

  test('WSIG-02 malformed bodies are refused with a reason a tool owner can act on', () => {
    expect(parseIngestBody('not json')).toEqual({ error: 'The body is not valid JSON' });
    expect(parseIngestBody('{"signals":[]}')).toEqual({ error: 'No signals were sent' });
    expect(parseIngestBody('{"signals":[1,2]}')).toEqual({ error: 'Each signal must be a JSON object' });
    expect(parseIngestBody('[{"kind":"news"}]')).toEqual({ error: 'Each signal must be a JSON object' });
  });

  test('WSIG-03 too many signals, or too large a body, is refused before the database', () => {
    const many = JSON.stringify({ signals: Array.from({ length: MAX_SIGNALS_PER_REQUEST + 1 }, () => ({ kind: 'news', title: 'x' })) });
    expect(parseIngestBody(many)).toEqual({ error: 'Send at most 50 signals per request' });
    expect(parseIngestBody(JSON.stringify({ kind: 'news', title: 'x'.repeat(70_000) }))).toEqual({ error: 'The body is larger than 64 KB' });
  });

  test('WSIG-04 database refusals are passed on only when they are the known, safe ones', () => {
    expect(ingestError('Unknown kind; use funding, news, hiring, tech_change, job_change, intent_surge or social_post'))
      .toBe('Unknown kind; use funding, news, hiring, tech_change, job_change, intent_surge or social_post');
    expect(ingestError('A signal needs a title of 1 to 300 characters')).toBe('A signal needs a title of 1 to 300 characters');
    expect(ingestError('Unknown webhook address')).toBe('Unknown webhook address');
    // Anything else, such as an internal error, is not echoed back
    expect(ingestError('relation "public.secret_table" does not exist')).toBe('The signal could not be stored');
    expect(ingestError(undefined)).toBe('The signal could not be stored');
  });

  test('WSIG-05 the address token has the exact shape the database issues', () => {
    expect(TOKEN.test('a'.repeat(64))).toBe(true);
    expect(TOKEN.test('A'.repeat(64))).toBe(false);
    expect(TOKEN.test('a'.repeat(63))).toBe(false);
    expect(TOKEN.test(`${'a'.repeat(63)}/`)).toBe(false);
  });

  test('WSIG-06 the example a person copies is itself a valid body', () => {
    const parsed = parseIngestBody(INGEST_EXAMPLE);
    expect('signals' in parsed && parsed.signals[0]).toMatchObject({ kind: 'intent_surge', domain: 'brightteeth.com' });
  });
});

describe('WSIG settings and labels', () => {
  test('WSIG-07 every kind has a label, and every built-in kind an explanation', () => {
    for (const k of SIGNAL_KINDS) expect(KIND_LABELS[k].length).toBeGreaterThan(2);
    for (const k of BUILT_IN_KINDS) expect(BUILT_IN_HELP[k].length).toBeGreaterThan(10);
    expect(BUILT_IN_HELP.job_change).toMatch(/Apollo credit/);
  });

  test('WSIG-08 a campaign may only choose built-in kinds', () => {
    expect(signalSettingsSchema.safeParse({ signals_enabled: true, signal_kinds: ['funding', 'job_change'] }).success).toBe(true);
    expect(signalSettingsSchema.safeParse({ signals_enabled: true, signal_kinds: ['intent_surge'] }).success).toBe(false);
  });

  test('WSIG-09 the "new signal" trigger waits for a signal and leaves people who replied or booked alone', () => {
    expect(conditionFor('new_signal')).toEqual({ all: [
      { fact: 'signal_new', is: true }, { fact: 'replied', is: false }, { fact: 'meeting_booked', is: false },
    ] });
    expect(triggerOf(conditionFor('new_signal'))).toBe('new_signal');
    expect(TRIGGERS.new_signal.label).toMatch(/new signal/);
  });
});
