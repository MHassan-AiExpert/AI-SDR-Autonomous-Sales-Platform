// Conditional branching and A/B testing (F22).
//
// A campaign's sequence is a list of steps. Each step names a channel, a
// minimum wait since the lead was last contacted, and a condition that must
// hold of the lead for the step to run. The engine picks the first step that
// has not run yet and whose condition holds, so a lead who went to voicemail
// can jump straight to a text while a lead who never answered at all carries
// on down the list.
//
// Conditions are evaluated here rather than in the database, so they can be
// unit tested. The database only gathers the facts (sequence_candidates).
//
// Nothing in this module sends anything; it decides. The caller does the send
// and records the outcome, which is what makes a step idempotent.

import { z } from 'zod';

// ---------------------------------------------------------------- conditions

/** The comparisons a step may make. Deliberately small and total. */
export const ClauseSchema = z.union([
  z.object({ fact: z.string().min(1), is: z.union([z.string(), z.number(), z.boolean(), z.null()]) }).strict(),
  z.object({ fact: z.string().min(1), not: z.union([z.string(), z.number(), z.boolean(), z.null()]) }).strict(),
  z.object({ fact: z.string().min(1), at_least: z.number() }).strict(),
  z.object({ fact: z.string().min(1), at_most: z.number() }).strict(),
  z.object({ fact: z.string().min(1), in: z.array(z.union([z.string(), z.number()])).min(1).max(20) }).strict(),
]);

export type Clause = z.infer<typeof ClauseSchema>;

/**
 * An empty object is no condition at all: the wait alone governs. When both
 * `all` and `any` are given, both must hold.
 */
export const ConditionSchema = z.object({
  all: z.array(ClauseSchema).max(10).optional(),
  any: z.array(ClauseSchema).max(10).optional(),
}).strict();

export type Condition = z.infer<typeof ConditionSchema>;

export type Facts = Record<string, unknown>;

/**
 * The facts a condition may name. Anything else is a mistake in the sequence
 * rather than a fact that happens to be missing, and is reported as such.
 */
export const KNOWN_FACTS = [
  'stage', 'score', 'emails_sent', 'email_bounced', 'email_opened', 'replied', 'reply_type',
  'calls_made', 'call_outcome', 'texts_sent', 'meeting_booked', 'hours_since_last_touch',
  'has_email', 'has_phone', 'steps_run',
] as const;

export type KnownFact = (typeof KNOWN_FACTS)[number];

/**
 * A lead never contacted has no "hours since last touch". Every comparison
 * treats that as long enough ago, so the first step of a sequence runs.
 */
const NULL_IS_FOREVER = new Set<string>(['hours_since_last_touch']);

function numberOf(fact: string, value: unknown): number | undefined {
  if (typeof value === 'number') return value;
  if (value === null || value === undefined) return NULL_IS_FOREVER.has(fact) ? Number.POSITIVE_INFINITY : undefined;
  // jsonb counts arrive as strings from some drivers
  if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) return Number(value);
  return undefined;
}

/** True when one comparison holds. An unanswerable comparison is false. */
export function clauseHolds(clause: Clause, facts: Facts): boolean {
  const value = facts[clause.fact] ?? null;
  if ('is' in clause) return value === clause.is;
  if ('not' in clause) return value !== clause.not;
  if ('in' in clause) return clause.in.some((v) => v === value);
  const n = numberOf(clause.fact, value);
  if (n === undefined) return false;
  return 'at_least' in clause ? n >= clause.at_least : n <= clause.at_most;
}

/** True when the whole condition holds. An empty condition always holds. */
export function conditionHolds(condition: Condition, facts: Facts): boolean {
  const all = condition.all ?? [];
  const any = condition.any ?? [];
  if (all.length && !all.every((c) => clauseHolds(c, facts))) return false;
  if (any.length && !any.some((c) => clauseHolds(c, facts))) return false;
  return true;
}

/** Names a condition uses that are not facts this system has. */
export function unknownFacts(condition: Condition): string[] {
  const names = [...(condition.all ?? []), ...(condition.any ?? [])].map((c) => c.fact);
  return [...new Set(names.filter((n) => !(KNOWN_FACTS as readonly string[]).includes(n)))];
}

// ---------------------------------------------------------------- variants

export type Variant = { id: string; label: 'a' | 'b' | 'c'; subject: string | null; body: string; active: boolean };

export type Step = {
  id: string;
  position: number;
  channel: 'email' | 'voice' | 'sms' | 'whatsapp';
  wait_hours: number;
  condition: unknown;
  is_last: boolean;
  instantly_campaign_id: string | null;
  variants: Variant[];
};

/** FNV-1a over a string, as an unsigned 32-bit number. */
function hash(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/**
 * Which variant a lead gets. Chosen from the lead and the step alone, so the
 * same lead always sees the same variant for that step however often the
 * engine runs, with no assignment table to keep. Spread is even across leads
 * because the hash is.
 */
export function pickVariant(stepId: string, leadId: string, variants: Variant[]): Variant | undefined {
  const live = variants.filter((v) => v.active);
  if (!live.length) return undefined;
  const ordered = [...live].sort((a, b) => a.label.localeCompare(b.label));
  return ordered[hash(`${stepId}:${leadId}`) % ordered.length];
}

// ---------------------------------------------------------------- step choice

export type Decision =
  | { run: Step; variant: Variant | undefined }
  | { run: undefined; reason: 'stopped' | 'waiting' | 'no_steps' | 'no_contact' | 'all_done' };

const CHANNEL_NEEDS: Record<Step['channel'], 'has_email' | 'has_phone'> = {
  email: 'has_email', voice: 'has_phone', sms: 'has_phone', whatsapp: 'has_phone',
};

/**
 * The next step for one lead, or why there is none.
 *
 * A step is eligible when it has not run for this lead, enough time has passed
 * since the lead was last contacted, the lead can be reached on that channel,
 * and its condition holds. The first eligible step in position order wins,
 * which is what lets a sequence branch rather than only march.
 *
 * A step is never recorded as skipped for want of a contact detail or an unmet
 * condition: both can change later, and a step the lead has not had should
 * stay available when they do.
 */
export function decide(steps: Step[], facts: Facts, leadId: string): Decision {
  if (!steps.length) return { run: undefined, reason: 'no_steps' };
  if (facts.stopped === true) return { run: undefined, reason: 'stopped' };

  const done = new Set(Array.isArray(facts.steps_done) ? (facts.steps_done as unknown[]).map(String) : []);
  const ordered = [...steps].sort((a, b) => a.position - b.position);
  const remaining = ordered.filter((s) => !done.has(s.id));
  if (!remaining.length) return { run: undefined, reason: 'all_done' };

  const hours = numberOf('hours_since_last_touch', facts.hours_since_last_touch) ?? Number.POSITIVE_INFINITY;
  let heldByWait = false;
  let heldByContact = false;

  for (const step of remaining) {
    if (facts[CHANNEL_NEEDS[step.channel]] !== true) {
      heldByContact = true;
      continue;
    }
    const parsed = ConditionSchema.safeParse(step.condition ?? {});
    // A condition that does not parse is treated as unmet rather than as
    // always true: a broken sequence must not start contacting people.
    if (!parsed.success) continue;
    if (!conditionHolds(parsed.data, facts)) continue;
    if (hours < step.wait_hours) {
      heldByWait = true;
      continue;
    }
    return { run: step, variant: pickVariant(step.id, leadId, step.variants) };
  }

  return { run: undefined, reason: heldByWait ? 'waiting' : heldByContact ? 'no_contact' : 'waiting' };
}

// ---------------------------------------------------------------- validation

/** Problems a person should fix in a sequence, in words they can act on. */
export function sequenceProblems(steps: Step[], openTracking: boolean): string[] {
  const problems: string[] = [];
  const positions = new Set<number>();
  for (const step of [...steps].sort((a, b) => a.position - b.position)) {
    const where = `Step ${step.position}`;
    if (positions.has(step.position)) problems.push(`${where} shares its position with another step.`);
    positions.add(step.position);

    const parsed = ConditionSchema.safeParse(step.condition ?? {});
    if (!parsed.success) {
      problems.push(`${where} has a condition this system cannot read.`);
      continue;
    }
    const unknown = unknownFacts(parsed.data);
    if (unknown.length) problems.push(`${where} asks about ${unknown.join(', ')}, which this system does not measure.`);
    if (!openTracking && [...(parsed.data.all ?? []), ...(parsed.data.any ?? [])].some((c) => c.fact === 'email_opened')) {
      problems.push(`${where} depends on email opens, so turn on open tracking for this campaign or the step will never run.`);
    }
    if (!step.variants.filter((v) => v.active).length) problems.push(`${where} has no active message.`);
    if (step.channel === 'email' && step.variants.some((v) => v.active && !v.subject?.trim())) {
      problems.push(`${where} is an email step, so every active message needs a subject.`);
    }
  }
  if (steps.length && !steps.some((s) => s.is_last)) {
    problems.push('No step ends the sequence, so leads who reach the end are simply left alone. Mark the final step as the last one.');
  }
  return problems;
}
