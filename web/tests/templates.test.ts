import { describe, expect, test } from 'vitest';
import {
  KIND_LABELS, bodyOf, describeSequenceTemplate, describeTemplateSteps, saveSequenceSchema,
  scopeOf, snippetSchema, stepsOf, type TemplateRow,
} from '../src/lib/templates';
import { conditionFor } from '../src/lib/sequence';

const sequence = (steps: unknown[]): Pick<TemplateRow, 'payload'> => ({ payload: { steps } as never });

const step = (over: Record<string, unknown> = {}) => ({
  position: 1, channel: 'email', wait_hours: 48, condition: conditionFor('no_reply'), is_last: false,
  variants: [{ label: 'a', subject: 'Quick question', body: 'Hello' }], ...over,
});

describe('WTPL reading a template', () => {
  test('WTPL-01 steps come back in order, and malformed ones are ignored', () => {
    const t = sequence([step({ position: 3 }), step({ position: 1 }), null, { nonsense: true }, step({ position: 2 })]);
    expect(stepsOf(t).map((s) => s.position)).toEqual([1, 2, 3]);
  });

  test('WTPL-02 a payload that is not a sequence yields no steps rather than throwing', () => {
    expect(stepsOf({ payload: null })).toEqual([]);
    expect(stepsOf({ payload: {} })).toEqual([]);
    expect(stepsOf({ payload: { steps: 'not a list' } as never })).toEqual([]);
  });

  test('WTPL-03 a snippet body is read, and a missing one is empty rather than undefined', () => {
    expect(bodyOf({ payload: { body: 'We helped a practice double its bookings.' } })).toBe('We helped a practice double its bookings.');
    expect(bodyOf({ payload: {} })).toBe('');
    expect(bodyOf({ payload: null })).toBe('');
  });
});

describe('WTPL describing a template', () => {
  test('WTPL-04 a sequence is summarised by steps, channels and messages', () => {
    const t = sequence([
      step({ position: 1, channel: 'email', variants: [{ label: 'a', subject: 'Hi', body: 'x' }, { label: 'b', subject: 'Ho', body: 'y' }] }),
      step({ position: 2, channel: 'voice', variants: [{ label: 'a', subject: null, body: 'x' }] }),
      step({ position: 3, channel: 'sms', is_last: true, variants: [{ label: 'a', subject: null, body: 'x' }] }),
    ]);
    expect(describeSequenceTemplate(t)).toBe('3 steps — Email, AI call, SMS — 4 messages.');
  });

  test('WTPL-05 a sequence with no closing step says so', () => {
    expect(describeSequenceTemplate(sequence([step()]))).toBe('1 step — Email — 1 message, with no closing step.');
  });

  test('WTPL-06 repeated channels are not repeated in the summary', () => {
    const t = sequence([
      step({ position: 1, channel: 'email' }),
      step({ position: 2, channel: 'email' }),
      step({ position: 3, channel: 'sms', is_last: true }),
    ]);
    expect(describeSequenceTemplate(t)).toContain('Email, SMS');
  });

  test('WTPL-07 an empty template says so instead of pretending', () => {
    expect(describeSequenceTemplate(sequence([]))).toBe('No steps.');
    expect(describeSequenceTemplate({ payload: null })).toBe('No steps.');
  });

  test('WTPL-08 each step reads back as a sentence, with the split and the ending', () => {
    const t = sequence([
      step({ position: 1, wait_hours: 0, condition: {}, variants: [{ label: 'a', subject: 'Hi', body: 'x' }, { label: 'b', subject: 'Ho', body: 'y' }] }),
      step({ position: 2, channel: 'sms', wait_hours: 48, condition: conditionFor('voicemail'), is_last: true }),
    ]);
    const lines = describeTemplateSteps(t);
    expect(lines[0]).toBe('Step 1: Email straight away, when always, once the wait has passed. 2 messages, split evenly.');
    expect(lines[1]).toBe('Step 2: SMS after 2 days, when the call reached voicemail. The sequence stops here.');
  });

  test('WTPL-09 a condition the library did not write is named as such, not guessed at', () => {
    const t = sequence([step({ condition: { all: [{ fact: 'score', at_least: 42 }] } })]);
    expect(describeTemplateSteps(t)[0]).toContain('on a condition set outside this screen');
  });
});

describe('WTPL scope and labels', () => {
  test('WTPL-10 an inherited template is distinguished from your own', () => {
    expect(scopeOf({ agency_id: 'a1' })).toBe('agency');
    expect(scopeOf({ agency_id: null })).toBe('workspace');
  });

  test('WTPL-11 both kinds are labelled', () => {
    expect(KIND_LABELS.sequence).toBe('Sequence');
    expect(KIND_LABELS.snippet).toBe('Snippet');
  });
});

describe('WTPL what a person may save', () => {
  test('WTPL-12 saving a sequence needs a name within the limit', () => {
    expect(saveSequenceSchema.safeParse({ name: 'Dental four-touch', description: '' }).success).toBe(true);
    expect(saveSequenceSchema.safeParse({ name: '   ', description: '' }).success).toBe(false);
    expect(saveSequenceSchema.safeParse({ name: 'x'.repeat(121), description: '' }).success).toBe(false);
    expect(saveSequenceSchema.safeParse({ name: 'Fine', description: 'y'.repeat(501) }).success).toBe(false);
  });

  test('WTPL-13 a snippet needs a name and a body, both within their limits', () => {
    expect(snippetSchema.safeParse({ name: 'Case study', description: '', body: 'We helped X.' }).success).toBe(true);
    expect(snippetSchema.safeParse({ name: 'Case study', description: '', body: '   ' }).success).toBe(false);
    expect(snippetSchema.safeParse({ name: '', description: '', body: 'Something' }).success).toBe(false);
    expect(snippetSchema.safeParse({ name: 'Case study', description: '', body: 'z'.repeat(2001) }).success).toBe(false);
  });

  test('WTPL-14 the name and body are trimmed, so stray spaces are not saved', () => {
    const parsed = snippetSchema.safeParse({ name: '  Guarantee  ', description: '  ', body: '  Money back in 60 days.  ' });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.name).toBe('Guarantee');
      expect(parsed.data.body).toBe('Money back in 60 days.');
    }
  });
});
