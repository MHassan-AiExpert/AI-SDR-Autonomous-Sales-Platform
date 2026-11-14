// Sequence steps, conditions and A/B messages (F22), for the interface.
//
// The agent service decides which step runs; this module only describes a
// sequence to a person and validates what they type. Conditions are built from
// a small set of choices rather than typed as JSON, so a sequence cannot be
// saved in a shape the engine would refuse to read.

import { z } from 'zod';

export const STEP_CHANNELS = ['email', 'voice', 'sms', 'whatsapp'] as const;
export type StepChannel = (typeof STEP_CHANNELS)[number];

export const CHANNEL_LABELS: Record<StepChannel, string> = {
  email: 'Email', voice: 'AI call', sms: 'SMS', whatsapp: 'WhatsApp',
};

export const VARIANT_LABELS = ['a', 'b', 'c'] as const;
export type VariantLabel = (typeof VARIANT_LABELS)[number];

export const MAX_STEPS = 20;
export const MAX_WAIT_HOURS = 720;

/**
 * The conditions a person can choose from, each one a ready-made clause. They
 * are deliberately named for what a salesperson would say, not for the fact
 * underneath.
 */
export const TRIGGERS = {
  always: { label: 'Always, once the wait has passed', clauses: [] },
  no_reply: { label: 'They have not replied', clauses: [{ fact: 'replied', is: false }] },
  replied: { label: 'They replied', clauses: [{ fact: 'replied', is: true }] },
  emailed_no_reply: {
    label: 'They were emailed and have not replied',
    clauses: [{ fact: 'emails_sent', at_least: 1 }, { fact: 'replied', is: false }],
  },
  opened_no_reply: {
    label: 'They opened an email and have not replied (needs open tracking)',
    clauses: [{ fact: 'email_opened', is: true }, { fact: 'replied', is: false }],
  },
  voicemail: { label: 'The call reached voicemail', clauses: [{ fact: 'call_outcome', is: 'voicemail' }] },
  no_answer: { label: 'The call was not answered', clauses: [{ fact: 'call_outcome', in: ['no_answer', 'failed'] }] },
  call_interested: { label: 'The call went well but no meeting was booked', clauses: [{ fact: 'call_outcome', is: 'interested' }, { fact: 'meeting_booked', is: false }] },
  never_reached: {
    label: 'Nothing has worked on any channel',
    clauses: [{ fact: 'replied', is: false }, { fact: 'meeting_booked', is: false }, { fact: 'calls_made', at_least: 1 }, { fact: 'emails_sent', at_least: 1 }],
  },
  bounced: { label: 'Their email bounced', clauses: [{ fact: 'email_bounced', is: true }] },
  high_score: { label: 'They score 80 or more and have not replied', clauses: [{ fact: 'score', at_least: 80 }, { fact: 'replied', is: false }] },
} as const;

export type TriggerKey = keyof typeof TRIGGERS;
export const TRIGGER_KEYS = Object.keys(TRIGGERS) as TriggerKey[];

/** Triggers that cannot be used while open tracking is off. */
export const NEEDS_OPEN_TRACKING: TriggerKey[] = ['opened_no_reply'];

export const stepSchema = z.object({
  position: z.coerce.number().int().min(1).max(MAX_STEPS),
  channel: z.enum(STEP_CHANNELS),
  wait_hours: z.coerce.number().int().min(0).max(MAX_WAIT_HOURS),
  trigger: z.enum(TRIGGER_KEYS as [TriggerKey, ...TriggerKey[]]),
  is_last: z.coerce.boolean(),
});

export const variantSchema = z.object({
  label: z.enum(VARIANT_LABELS),
  subject: z.string().trim().max(300).optional().or(z.literal('')),
  body: z.string().trim().min(1, 'Write the message.').max(5000),
  active: z.coerce.boolean(),
});

/** The condition stored for a trigger, in the shape the engine reads. */
export function conditionFor(trigger: TriggerKey): Record<string, unknown> {
  const clauses = TRIGGERS[trigger].clauses;
  return clauses.length ? { all: clauses } : {};
}

/**
 * Which trigger a stored condition came from, so an existing step can be shown
 * as the choice that made it. A condition this interface did not write is
 * reported as such rather than silently shown as something else.
 */
export function triggerOf(condition: unknown): TriggerKey | 'custom' {
  const stored = JSON.stringify(normalize(condition));
  for (const key of TRIGGER_KEYS) {
    if (JSON.stringify(normalize(conditionFor(key))) === stored) return key;
  }
  return 'custom';
}

/**
 * Sorts the clause keys so two equal conditions compare equal as text. Both
 * `all` and `any` are kept: dropping either would make a condition this screen
 * cannot express look like one it can, and saving the form would then replace
 * it without the person being told.
 */
function normalize(condition: unknown): unknown {
  if (!condition || typeof condition !== 'object') return { all: [], any: [] };
  const c = condition as Record<string, unknown>;
  const clauses = (value: unknown) =>
    (Array.isArray(value) ? value : []).map((x) => (x && typeof x === 'object' ? Object.fromEntries(Object.entries(x as object).sort()) : x));
  return { all: clauses(c.all), any: clauses(c.any) };
}

export function describeWait(hours: number): string {
  if (hours === 0) return 'straight away';
  if (hours % 24 === 0) {
    const days = hours / 24;
    return days === 1 ? 'after a day' : `after ${days} days`;
  }
  return hours === 1 ? 'after an hour' : `after ${hours} hours`;
}

/** One sentence describing a step, for the list. */
export function describeStep(step: { channel: StepChannel; wait_hours: number; condition: unknown; is_last: boolean }): string {
  const trigger = triggerOf(step.condition);
  const when = trigger === 'custom' ? 'on a condition set outside this screen' : TRIGGERS[trigger].label.toLowerCase();
  const ending = step.is_last ? ' This is the last step; the sequence stops here.' : '';
  return `${CHANNEL_LABELS[step.channel]} ${describeWait(step.wait_hours)}, when ${when}.${ending}`;
}

export type VariantRow = { id: string; label: VariantLabel; subject: string | null; body: string; active: boolean };
export type StepRow = {
  id: string; position: number; channel: StepChannel; wait_hours: number;
  condition: unknown; is_last: boolean; sequence_variants: VariantRow[];
};

/**
 * What a person needs to fix before the sequence will do anything. The agent
 * service checks the same things; this is so they see them before a run.
 */
export function problems(steps: StepRow[], openTracking: boolean): string[] {
  const out: string[] = [];
  for (const step of [...steps].sort((a, b) => a.position - b.position)) {
    const where = `Step ${step.position}`;
    const active = step.sequence_variants.filter((v) => v.active);
    if (!active.length) out.push(`${where} has no active message, so it will never be sent.`);
    if (step.channel === 'email' && active.some((v) => !v.subject?.trim())) {
      out.push(`${where} is an email step, so every active message needs a subject.`);
    }
    const trigger = triggerOf(step.condition);
    if (trigger !== 'custom' && NEEDS_OPEN_TRACKING.includes(trigger) && !openTracking) {
      out.push(`${where} depends on email opens, so turn on open tracking below or the step will never run.`);
    }
  }
  if (steps.length && !steps.some((s) => s.is_last)) {
    out.push('No step is marked as the last one, so leads who reach the end are simply left alone.');
  }
  return out;
}

/** One number as a percentage of another, to one decimal place. */
export const percentOf = (part: number, whole: number) => (whole > 0 ? `${((part / whole) * 100).toFixed(1)}%` : '—');
