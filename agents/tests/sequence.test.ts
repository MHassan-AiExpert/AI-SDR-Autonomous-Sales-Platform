import { describe, expect, it } from 'vitest';
import {
  clauseHolds, conditionHolds, ConditionSchema, decide, pickVariant, sequenceProblems, unknownFacts,
  type Facts, type Step, type Variant,
} from '../src/sequence.ts';

const variant = (label: 'a' | 'b' | 'c', over: Partial<Variant> = {}): Variant => ({
  id: `v-${label}`, label, subject: 'Quick question', body: `Body ${label}`, active: true, ...over,
});

const step = (over: Partial<Step> = {}): Step => ({
  id: 'step-1', position: 1, channel: 'email', wait_hours: 0, condition: {}, is_last: false,
  instantly_campaign_id: null, variants: [variant('a')], ...over,
});

const facts = (over: Facts = {}): Facts => ({
  stage: 'new', score: 70, emails_sent: 0, email_bounced: false, replied: false, reply_type: null,
  calls_made: 0, call_outcome: null, texts_sent: 0, meeting_booked: false,
  hours_since_last_touch: null, has_email: true, has_phone: true, steps_run: 0, steps_done: [], stopped: false,
  ...over,
});

describe('SEQ clauses', () => {
  it('SEQ-01 compares equality, inequality and membership', () => {
    expect(clauseHolds({ fact: 'replied', is: false }, facts())).toBe(true);
    expect(clauseHolds({ fact: 'replied', is: true }, facts())).toBe(false);
    expect(clauseHolds({ fact: 'stage', not: 'won' }, facts())).toBe(true);
    expect(clauseHolds({ fact: 'call_outcome', in: ['voicemail', 'no_answer'] }, facts({ call_outcome: 'voicemail' }))).toBe(true);
    expect(clauseHolds({ fact: 'call_outcome', in: ['voicemail'] }, facts({ call_outcome: 'booked' }))).toBe(false);
  });

  it('SEQ-02 a missing fact is null, so "is null" holds and a number comparison does not', () => {
    expect(clauseHolds({ fact: 'call_outcome', is: null }, facts())).toBe(true);
    expect(clauseHolds({ fact: 'nothing_like_this', at_least: 1 }, facts())).toBe(false);
  });

  it('SEQ-03 never contacted counts as long enough ago, but only for the wait', () => {
    expect(clauseHolds({ fact: 'hours_since_last_touch', at_least: 48 }, facts())).toBe(true);
    expect(clauseHolds({ fact: 'hours_since_last_touch', at_most: 48 }, facts())).toBe(false);
    expect(clauseHolds({ fact: 'hours_since_last_touch', at_least: 48 }, facts({ hours_since_last_touch: 47 }))).toBe(false);
  });

  it('SEQ-04 counts that arrive as strings are still numbers', () => {
    expect(clauseHolds({ fact: 'emails_sent', at_least: 2 }, facts({ emails_sent: '3' }))).toBe(true);
    expect(clauseHolds({ fact: 'emails_sent', at_least: 2 }, facts({ emails_sent: '1' }))).toBe(false);
  });

  it('SEQ-05 all must hold, any needs one, and an empty condition always holds', () => {
    const f = facts({ emails_sent: 1, call_outcome: 'voicemail' });
    expect(conditionHolds({}, f)).toBe(true);
    expect(conditionHolds({ all: [{ fact: 'replied', is: false }, { fact: 'emails_sent', at_least: 1 }] }, f)).toBe(true);
    expect(conditionHolds({ all: [{ fact: 'replied', is: false }, { fact: 'emails_sent', at_least: 5 }] }, f)).toBe(false);
    expect(conditionHolds({ any: [{ fact: 'call_outcome', is: 'booked' }, { fact: 'call_outcome', is: 'voicemail' }] }, f)).toBe(true);
    expect(conditionHolds({ any: [{ fact: 'call_outcome', is: 'booked' }] }, f)).toBe(false);
    // Both given: both must hold
    expect(conditionHolds({ all: [{ fact: 'replied', is: true }], any: [{ fact: 'call_outcome', is: 'voicemail' }] }, f)).toBe(false);
  });

  it('SEQ-06 names the facts this system does not measure, and rejects a malformed clause', () => {
    expect(unknownFacts({ all: [{ fact: 'moon_phase', is: 'full' }, { fact: 'replied', is: false }] })).toEqual(['moon_phase']);
    expect(ConditionSchema.safeParse({ all: [{ fact: 'replied' }] }).success).toBe(false);
    expect(ConditionSchema.safeParse({ all: [{ fact: 'replied', is: false, at_least: 2 }] }).success).toBe(false);
    expect(ConditionSchema.safeParse({ unexpected: [] }).success).toBe(false);
  });
});

describe('SEQ variants', () => {
  it('SEQ-07 the same lead always gets the same variant, and inactive ones are never sent', () => {
    const vs = [variant('a'), variant('b'), variant('c')];
    const first = pickVariant('step-1', 'lead-1', vs);
    expect(pickVariant('step-1', 'lead-1', vs)!.label).toBe(first!.label);
    expect(pickVariant('step-1', 'lead-1', [variant('a', { active: false }), variant('b')])!.label).toBe('b');
    expect(pickVariant('step-1', 'lead-1', [variant('a', { active: false })])).toBeUndefined();
  });

  it('SEQ-08 three variants split roughly evenly across many leads', () => {
    const vs = [variant('a'), variant('b'), variant('c')];
    const counts: Record<string, number> = { a: 0, b: 0, c: 0 };
    for (let i = 0; i < 3000; i++) counts[pickVariant('step-1', `lead-${i}`, vs)!.label]++;
    for (const label of ['a', 'b', 'c']) {
      expect(counts[label]).toBeGreaterThan(850);
      expect(counts[label]).toBeLessThan(1150);
    }
  });

  it('SEQ-09 the split differs per step, so one lead is not always in the same arm', () => {
    const vs = [variant('a'), variant('b'), variant('c')];
    const perStep = new Set(['step-1', 'step-2', 'step-3', 'step-4'].map((s) => pickVariant(s, 'lead-7', vs)!.label));
    expect(perStep.size).toBeGreaterThan(1);
  });
});

describe('SEQ step choice', () => {
  it('SEQ-10 the first step runs for a lead who has never been contacted', () => {
    const d = decide([step()], facts(), 'lead-1');
    expect(d.run?.id).toBe('step-1');
    expect(d.run && d.variant?.label).toBe('a');
  });

  it('SEQ-11 a step already run is never run again', () => {
    const d = decide([step()], facts({ steps_done: ['step-1'] }), 'lead-1');
    expect(d.run).toBeUndefined();
    expect(d.run === undefined && d.reason).toBe('all_done');
  });

  it('SEQ-12 the wait is measured from the last contact on any channel', () => {
    const steps = [step({ id: 's1' }), step({ id: 's2', position: 2, wait_hours: 48 })];
    const done = facts({ steps_done: ['s1'], emails_sent: 1, hours_since_last_touch: 12 });
    expect(decide(steps, done, 'lead-1').run).toBeUndefined();
    expect(decide(steps, { ...done, hours_since_last_touch: 49 }, 'lead-1').run?.id).toBe('s2');
  });

  it('SEQ-13 branching: a voicemail jumps the email step and takes the text step', () => {
    const steps = [
      step({ id: 'call', position: 1, channel: 'voice', variants: [variant('a', { subject: null })] }),
      step({ id: 'email2', position: 2, channel: 'email', condition: { all: [{ fact: 'call_outcome', is: 'no_answer' }] } }),
      step({ id: 'text', position: 3, channel: 'sms', condition: { all: [{ fact: 'call_outcome', is: 'voicemail' }] }, variants: [variant('a', { subject: null })] }),
    ];
    const after = facts({ steps_done: ['call'], calls_made: 1, call_outcome: 'voicemail', hours_since_last_touch: 50 });
    expect(decide(steps, after, 'lead-1').run?.id).toBe('text');
    const noAnswer = { ...after, call_outcome: 'no_answer' };
    expect(decide(steps, noAnswer, 'lead-1').run?.id).toBe('email2');
  });

  it('SEQ-14 a lead who replied stops matching the no-reply steps', () => {
    const steps = [step({ id: 's1' }), step({ id: 's2', position: 2, condition: { all: [{ fact: 'replied', is: false }] } })];
    const replied = facts({ steps_done: ['s1'], replied: true, emails_sent: 1, hours_since_last_touch: 72 });
    expect(decide(steps, replied, 'lead-1').run).toBeUndefined();
  });

  it('SEQ-15 the last step stops the sequence for good', () => {
    const steps = [step({ id: 's1', is_last: true }), step({ id: 's2', position: 2 })];
    expect(decide(steps, facts({ steps_done: ['s1'], stopped: true }), 'lead-1').run).toBeUndefined();
    expect(decide(steps, facts({ steps_done: ['s1'], stopped: true }), 'lead-1')).toMatchObject({ reason: 'stopped' });
  });

  it('SEQ-16 a channel the lead cannot be reached on is passed over, not consumed', () => {
    const steps = [
      step({ id: 'call', channel: 'voice', variants: [variant('a', { subject: null })] }),
      step({ id: 'mail', position: 2, channel: 'email' }),
    ];
    // No phone today: the email step runs and the call step stays available
    const noPhone = facts({ has_phone: false });
    expect(decide(steps, noPhone, 'lead-1').run?.id).toBe('mail');
    // The phone arrives later and the call step is still there to run
    const later = facts({ has_phone: true, steps_done: ['mail'], emails_sent: 1, hours_since_last_touch: 99 });
    expect(decide(steps, later, 'lead-1').run?.id).toBe('call');
  });

  it('SEQ-17 a condition that cannot be read never contacts anyone', () => {
    const steps = [step({ id: 'broken', condition: { all: [{ fact: 'replied' }] } }), step({ id: 'fine', position: 2 })];
    expect(decide(steps, facts(), 'lead-1').run?.id).toBe('fine');
  });

  it('SEQ-18 no steps, and nothing left to do, are reported apart', () => {
    expect(decide([], facts(), 'lead-1')).toMatchObject({ reason: 'no_steps' });
    expect(decide([step()], facts({ has_email: false, has_phone: false }), 'lead-1')).toMatchObject({ reason: 'no_contact' });
  });
});

describe('SEQ sequence checks', () => {
  it('SEQ-19 reports the problems a person has to fix', () => {
    const problems = sequenceProblems([
      step({ id: 's1', variants: [variant('a', { active: false })] }),
      step({ id: 's2', position: 2, condition: { all: [{ fact: 'moon_phase', is: 'full' }] } }),
      step({ id: 's3', position: 3, channel: 'email', variants: [variant('a', { subject: '  ' })] }),
      step({ id: 's4', position: 4, condition: { all: [{ fact: 'email_opened', is: true }] } }),
    ], false);
    expect(problems.join(' ')).toContain('Step 1 has no active message');
    expect(problems.join(' ')).toContain('moon_phase');
    expect(problems.join(' ')).toContain('needs a subject');
    expect(problems.join(' ')).toContain('open tracking');
    expect(problems.join(' ')).toContain('No step ends the sequence');
  });

  it('SEQ-20 a sound sequence has nothing to report, and open tracking clears the opens warning', () => {
    const steps = [
      step({ id: 's1' }),
      step({ id: 's2', position: 2, condition: { all: [{ fact: 'email_opened', is: true }, { fact: 'replied', is: false }] }, is_last: true }),
    ];
    expect(sequenceProblems(steps, true)).toEqual([]);
    expect(sequenceProblems(steps, false)).toHaveLength(1);
  });
});
