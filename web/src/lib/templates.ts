// The template library (F23), for the interface.
//
// Templates are named, reusable, scoped content: a saved sequence, or a
// snippet of copy the writer can draw on. The database holds both in one
// table with a `kind`; this module validates what a person types and describes
// a template back to them.

import { z } from 'zod';
import { CHANNEL_LABELS, describeWait, triggerOf, TRIGGERS, type StepChannel } from './sequence';

export const TEMPLATE_KINDS = ['sequence', 'snippet'] as const;
export type TemplateKind = (typeof TEMPLATE_KINDS)[number];

export const KIND_LABELS: Record<TemplateKind, string> = {
  sequence: 'Sequence',
  snippet: 'Snippet',
};

export const MAX_SNIPPETS_IN_PROMPT = 20;

export const templateNameSchema = z.string().trim().min(1, 'Give the template a name.').max(120);
export const templateDescriptionSchema = z.string().trim().max(500).optional().or(z.literal(''));

export const saveSequenceSchema = z.object({
  name: templateNameSchema,
  description: templateDescriptionSchema,
});

export const snippetSchema = z.object({
  name: templateNameSchema,
  description: templateDescriptionSchema,
  body: z.string().trim().min(1, 'Write the snippet.').max(2000),
});

export type TemplateStep = {
  position: number;
  channel: StepChannel;
  wait_hours: number;
  condition: unknown;
  is_last: boolean;
  variants: { label: string; subject: string | null; body: string }[];
};

export type TemplateRow = {
  id: string;
  workspace_id: string | null;
  agency_id: string | null;
  kind: TemplateKind;
  name: string;
  description: string | null;
  payload: { steps?: TemplateStep[]; body?: string } | null;
  is_default: boolean;
  updated_at: string;
};

/** The steps a sequence template holds, in order, ignoring anything malformed. */
export function stepsOf(template: Pick<TemplateRow, 'payload'>): TemplateStep[] {
  const steps = template.payload?.steps;
  if (!Array.isArray(steps)) return [];
  return steps
    .filter((s): s is TemplateStep => Boolean(s) && typeof s === 'object' && typeof s.position === 'number')
    .sort((a, b) => a.position - b.position);
}

/** The snippet's text, or empty when the payload is not a snippet. */
export const bodyOf = (template: Pick<TemplateRow, 'payload'>) =>
  typeof template.payload?.body === 'string' ? template.payload.body : '';

/** A one-line summary of a sequence template: how many steps, on which channels. */
export function describeSequenceTemplate(template: Pick<TemplateRow, 'payload'>): string {
  const steps = stepsOf(template);
  if (!steps.length) return 'No steps.';
  const channels: string[] = [];
  for (const s of steps) {
    const label = CHANNEL_LABELS[s.channel] ?? s.channel;
    if (channels.at(-1) !== label) channels.push(label);
  }
  const messages = steps.reduce((n, s) => n + (Array.isArray(s.variants) ? s.variants.length : 0), 0);
  const ends = steps.some((s) => s.is_last) ? '' : ', with no closing step';
  return `${steps.length} ${steps.length === 1 ? 'step' : 'steps'} — ${channels.join(', ')} — ${messages} ${messages === 1 ? 'message' : 'messages'}${ends}.`;
}

/** Each step of a template read back as a sentence, for the detail view. */
export function describeTemplateSteps(template: Pick<TemplateRow, 'payload'>): string[] {
  return stepsOf(template).map((s) => {
    const trigger = triggerOf(s.condition);
    const when = trigger === 'custom' ? 'on a condition set outside this screen' : TRIGGERS[trigger].label.toLowerCase();
    const count = Array.isArray(s.variants) ? s.variants.length : 0;
    const messages = count > 1 ? ` ${count} messages, split evenly.` : '';
    const ending = s.is_last ? ' The sequence stops here.' : '';
    return `Step ${s.position}: ${CHANNEL_LABELS[s.channel] ?? s.channel} ${describeWait(s.wait_hours)}, when ${when}.${messages}${ending}`;
  });
}

/** Where a template came from, so an inherited one is not mistaken for your own. */
export const scopeOf = (t: Pick<TemplateRow, 'agency_id'>) => (t.agency_id ? 'agency' : 'workspace');
