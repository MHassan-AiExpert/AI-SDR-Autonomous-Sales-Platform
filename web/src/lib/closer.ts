// Sales playbook, AI closer settings and deal labels.

import { z } from 'zod';

export const INTERVALS = ['one_time', 'month', 'year'] as const;
export const INTERVAL_LABELS: Record<(typeof INTERVALS)[number], string> = { one_time: 'One-off', month: 'Per month', year: 'Per year' };
export const MAX_PLANS = 5;

const lines = (v: FormDataEntryValue | null, max: number) =>
  String(v ?? '').split('\n').map((l) => l.trim()).filter(Boolean).slice(0, max);

const planSchema = z.object({
  name: z.string().trim().min(1).max(80, 'Plan names can be up to 80 characters'),
  price_cents: z.number('Each plan needs a price of at least 1.00').int().min(100, 'Each plan needs a price of at least 1.00').max(100_000_000, 'That price is too high'),
  currency: z.string().regex(/^[A-Z]{3}$/, 'Use a three-letter currency code, like USD'),
  interval: z.enum(INTERVALS, 'Choose how each plan is billed'),
  description: z.string().trim().max(300, 'Plan descriptions can be up to 300 characters'),
});

export const playbookSchema = z.object({
  offer_summary: z.string().trim().min(20, 'Describe the offer in at least 20 characters').max(1500, 'The offer can be up to 1500 characters'),
  plans: z.array(planSchema).min(1, 'Add at least one plan with a name and a price').max(MAX_PLANS),
  qualification_questions: z.array(z.string().min(3).max(200, 'Each question can be up to 200 characters')).max(8),
  objections: z.array(z.object({ objection: z.string().min(3).max(200), answer: z.string().min(3).max(600) })).max(12),
  handoff_rules: z.array(z.string().min(3).max(200, 'Each rule can be up to 200 characters')).max(8),
  proposal_template_id: z.string().regex(/^[A-Za-z0-9]{10,40}$/, 'Copy the template ID from PandaDoc (letters and numbers)').nullable(),
  proposal_role: z.string().trim().min(1).max(60),
});
export type PlaybookContent = z.infer<typeof playbookSchema>;

/** "12.50" or "1,250" to cents; anything else to NaN so validation reports it. */
export function toCents(v: string): number {
  const s = v.trim().replace(/,/g, '');
  if (!/^\d+(\.\d{1,2})?$/.test(s)) return Number.NaN;
  return Math.round(Number(s) * 100);
}

export function parsePlaybook(form: FormData) {
  const plans = [];
  for (let i = 0; i < MAX_PLANS; i++) {
    const name = String(form.get(`plan_${i}_name`) ?? '').trim();
    const price = String(form.get(`plan_${i}_price`) ?? '').trim();
    if (!name && !price) continue;
    plans.push({
      name, price_cents: toCents(price), currency: String(form.get(`plan_${i}_currency`) ?? 'USD').trim().toUpperCase(),
      interval: String(form.get(`plan_${i}_interval`) ?? ''), description: String(form.get(`plan_${i}_description`) ?? ''),
    });
  }
  const objections = lines(form.get('objections'), 12).map((l) => {
    const [objection, ...rest] = l.split('|');
    return { objection: objection.trim(), answer: rest.join('|').trim() };
  });
  const template = String(form.get('proposal_template_id') ?? '').trim();
  return playbookSchema.safeParse({
    offer_summary: form.get('offer_summary') ?? '',
    plans,
    qualification_questions: lines(form.get('qualification_questions'), 8),
    objections,
    handoff_rules: lines(form.get('handoff_rules'), 8),
    proposal_template_id: template || null,
    proposal_role: String(form.get('proposal_role') ?? '').trim() || 'Client',
  });
}

export function readPlaybook(content: unknown): PlaybookContent | null {
  const r = playbookSchema.safeParse(content);
  return r.success ? r.data : null;
}

export function money(cents: number | null, currency: string): string {
  if (cents === null || !Number.isFinite(cents)) return '—';
  try {
    return new Intl.NumberFormat('en-US', { style: 'currency', currency, maximumFractionDigits: cents % 100 ? 2 : 0 }).format(cents / 100);
  } catch {
    return `${(cents / 100).toFixed(2)} ${currency}`;
  }
}

export const closerAssistantSchema = z.string().trim().toLowerCase().regex(/^[0-9a-f-]{36}$/, 'Copy the closer assistant ID from Vapi; it looks like 1a2b3c4d-…');

export type CloserReadinessInput = {
  closerEnabled: boolean; vapiConnected: boolean; playbookReady: boolean; assistantId: string | null; phoneNumberId: string | null;
  stripeConnected: boolean; pandadocConnected: boolean; templateId: string | null;
};

export function closerReadiness(i: CloserReadinessInput) {
  const required = [
    { id: 'enabled', label: 'AI closer switched on in Settings', done: i.closerEnabled },
    { id: 'vapi', label: 'Vapi connected in Setup', done: i.vapiConnected },
    { id: 'playbook', label: 'Sales playbook with at least one plan and price', done: i.playbookReady },
    { id: 'assistant', label: 'Closer assistant chosen in Vapi', done: Boolean(i.assistantId) },
    { id: 'number', label: 'Phone number chosen (the one set under AI calling)', done: Boolean(i.phoneNumberId) },
  ];
  const optional = [
    { id: 'stripe', label: 'Stripe connected: payment links at the playbook price', done: i.stripeConnected },
    { id: 'pandadoc', label: 'PandaDoc connected with a proposal template: proposals sent for e-signature', done: i.pandadocConnected && Boolean(i.templateId) },
  ];
  return { required, optional, ready: required.every((x) => x.done) };
}

export const DEAL_STAGE_LABELS: Record<string, string> = {
  meeting_booked: 'Meeting booked', meeting_held: 'Meeting held', proposal_sent: 'Proposal sent', negotiation: 'Negotiation', won: 'Won', lost: 'Lost',
};
export const CLOSE_STATUS_LABELS: Record<string, string> = {
  none: '—', pending: 'Preparing proposal', sending: 'Sending proposal', sent: 'Proposal sent', needs_team: 'Needs your team', failed: 'Could not send',
};
export const PAYMENT_LABELS: Record<string, string> = { none: 'Not paid', link_sent: 'Payment link sent', paid: 'Paid', refunded: 'Refunded' };
export const CLOSER_STATUS_LABELS: Record<string, string> = {
  pending: 'Waiting', calling: 'In the meeting', held: 'Held', no_answer: 'No answer', handed_off: 'With your team', failed: 'Could not call',
};

export function safeLink(url: string | null, hosts: RegExp): string | null {
  return url && /^https:\/\/[^\s]+$/.test(url) && hosts.test(url) ? url : null;
}
export const PAYMENT_HOSTS = /^https:\/\/(buy|checkout)\.stripe\.com\//;
export const PROPOSAL_HOSTS = /^https:\/\/app\.pandadoc\.com\//;
