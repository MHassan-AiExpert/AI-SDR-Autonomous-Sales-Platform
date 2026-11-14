import { describe, expect, test } from 'vitest';
import {
  TRIGGERS, TRIGGER_KEYS, conditionFor, describeStep, describeWait, percentOf,
  problems, stepSchema, triggerOf, variantSchema, type StepRow, type VariantRow,
} from '../src/lib/sequence';

const variant = (over: Partial<VariantRow> = {}): VariantRow => ({
  id: 'v1', label: 'a', subject: 'Quick question', body: 'Hello {{first_name}}', active: true, ...over,
});

const step = (over: Partial<StepRow> = {}): StepRow => ({
  id: 's1', position: 1, channel: 'email', wait_hours: 48, condition: conditionFor('no_reply'),
  is_last: false, sequence_variants: [variant()], ...over,
});

describe('WSEQ conditions', () => {
  test('WSEQ-01 a trigger becomes the shape the engine reads', () => {
    expect(conditionFor('always')).toEqual({});
    expect(conditionFor('no_reply')).toEqual({ all: [{ fact: 'replied', is: false }] });
    expect(conditionFor('voicemail')).toEqual({ all: [{ fact: 'call_outcome', is: 'voicemail' }] });
    expect(conditionFor('no_answer')).toEqual({ all: [{ fact: 'call_outcome', in: ['no_answer', 'failed'] }] });
  });

  test('WSEQ-02 every trigger is recognised again from what was stored', () => {
    for (const key of TRIGGER_KEYS) {
      expect(triggerOf(conditionFor(key)), `${key} should round-trip`).toBe(key);
    }
  });

  test('WSEQ-03 a condition this screen did not write is reported as custom, not mistaken for one', () => {
    expect(triggerOf({ all: [{ fact: 'score', at_least: 42 }] })).toBe('custom');
    expect(triggerOf({ any: [{ fact: 'replied', is: false }] })).toBe('custom');
    expect(triggerOf(null)).toBe('always');
    expect(triggerOf('nonsense')).toBe('always');
  });

  test('WSEQ-04 every trigger has a label, and only the opens one needs tracking', () => {
    for (const key of TRIGGER_KEYS) expect(TRIGGERS[key].label.length).toBeGreaterThan(3);
    const needsOpens = TRIGGER_KEYS.filter((k) => JSON.stringify(conditionFor(k)).includes('email_opened'));
    expect(needsOpens).toEqual(['opened_no_reply']);
  });
});

describe('WSEQ wording', () => {
  test('WSEQ-05 a wait is described the way a person would say it', () => {
    expect(describeWait(0)).toBe('straight away');
    expect(describeWait(1)).toBe('after an hour');
    expect(describeWait(4)).toBe('after 4 hours');
    expect(describeWait(24)).toBe('after a day');
    expect(describeWait(72)).toBe('after 3 days');
  });

  test('WSEQ-06 a step reads as a sentence, and the last step says so', () => {
    expect(describeStep(step())).toBe('Email after 2 days, when they have not replied.');
    expect(describeStep(step({ channel: 'sms', wait_hours: 0, condition: conditionFor('voicemail'), is_last: true })))
      .toBe('SMS straight away, when the call reached voicemail. This is the last step; the sequence stops here.');
    expect(describeStep(step({ condition: { all: [{ fact: 'score', at_least: 42 }] } })))
      .toContain('on a condition set outside this screen');
  });

  test('WSEQ-07 a share is a percentage, and nothing sent is not nought per cent', () => {
    expect(percentOf(3, 12)).toBe('25.0%');
    expect(percentOf(0, 10)).toBe('0.0%');
    expect(percentOf(0, 0)).toBe('—');
  });
});

describe('WSEQ checks before a run', () => {
  test('WSEQ-08 a sound sequence has nothing to report', () => {
    expect(problems([step({ is_last: true })], false)).toEqual([]);
  });

  test('WSEQ-09 a step with no active message is reported', () => {
    const out = problems([step({ sequence_variants: [variant({ active: false })], is_last: true })], false);
    expect(out).toEqual(['Step 1 has no active message, so it will never be sent.']);
  });

  test('WSEQ-10 an email step needs a subject on every active message', () => {
    const blank = problems([step({ sequence_variants: [variant({ subject: '  ' })], is_last: true })], false);
    expect(blank.join(' ')).toContain('every active message needs a subject');
    // The other channels do not
    const texting = problems([step({ channel: 'sms', sequence_variants: [variant({ subject: null })], is_last: true })], false);
    expect(texting).toEqual([]);
  });

  test('WSEQ-11 an opens condition without open tracking is reported, and clears when it is on', () => {
    const steps = [step({ condition: conditionFor('opened_no_reply'), is_last: true })];
    expect(problems(steps, false).join(' ')).toContain('turn on open tracking');
    expect(problems(steps, true)).toEqual([]);
  });

  test('WSEQ-12 a sequence with no last step is reported, and an empty one is not', () => {
    expect(problems([step()], false).join(' ')).toContain('No step is marked as the last one');
    expect(problems([], false)).toEqual([]);
  });
});

describe('WSEQ what a person may save', () => {
  test('WSEQ-13 a step is checked before it is written', () => {
    expect(stepSchema.safeParse({ position: '2', channel: 'sms', wait_hours: '48', trigger: 'no_reply', is_last: false }).success).toBe(true);
    expect(stepSchema.safeParse({ position: '0', channel: 'sms', wait_hours: '48', trigger: 'no_reply', is_last: false }).success).toBe(false);
    expect(stepSchema.safeParse({ position: '21', channel: 'sms', wait_hours: '48', trigger: 'no_reply', is_last: false }).success).toBe(false);
    expect(stepSchema.safeParse({ position: '1', channel: 'pigeon', wait_hours: '48', trigger: 'no_reply', is_last: false }).success).toBe(false);
    expect(stepSchema.safeParse({ position: '1', channel: 'sms', wait_hours: '721', trigger: 'no_reply', is_last: false }).success).toBe(false);
    expect(stepSchema.safeParse({ position: '1', channel: 'sms', wait_hours: '48', trigger: 'whenever', is_last: false }).success).toBe(false);
  });

  test('WSEQ-14 a message needs a body, and an over-long one is refused', () => {
    expect(variantSchema.safeParse({ label: 'a', subject: 'Hi', body: 'Hello', active: true }).success).toBe(true);
    expect(variantSchema.safeParse({ label: 'a', subject: '', body: '   ', active: true }).success).toBe(false);
    expect(variantSchema.safeParse({ label: 'd', subject: '', body: 'Hello', active: true }).success).toBe(false);
    expect(variantSchema.safeParse({ label: 'a', subject: 'x'.repeat(301), body: 'Hello', active: true }).success).toBe(false);
    expect(variantSchema.safeParse({ label: 'a', subject: '', body: 'x'.repeat(5001), active: true }).success).toBe(false);
  });
});
