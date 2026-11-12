import { describe, expect, test } from 'vitest';
import { CLOSE_STATUS_LABELS, CLOSER_STATUS_LABELS, DEAL_STAGE_LABELS, PAYMENT_HOSTS, PAYMENT_LABELS, PROPOSAL_HOSTS, closerAssistantSchema, closerReadiness, money, parsePlaybook, readPlaybook, safeLink, toCents } from '@/lib/closer';
import { describeJobResult, JOB_TYPES } from '@/lib/campaigns';

const form = (over: Record<string, string> = {}) => {
  const f = new FormData();
  const base: Record<string, string> = {
    offer_summary: 'Done-for-you patient booking automation for dental clinics.',
    plan_0_name: 'Starter', plan_0_price: '199', plan_0_currency: 'usd', plan_0_interval: 'month', plan_0_description: 'One clinic',
    plan_1_name: 'Growth', plan_1_price: '1,250.50', plan_1_currency: 'USD', plan_1_interval: 'year', plan_1_description: '',
    qualification_questions: 'How many clinics?\n\nWho decides?',
    objections: 'too expensive | Two new patients a month pay for it\nnot now | We can start next month',
    handoff_rules: 'Custom contract', proposal_template_id: 'TplABCDEFGHIJ12345', proposal_role: '', ...over,
  };
  for (const [k, v] of Object.entries(base)) f.set(k, v);
  return f;
};
const err = (over: Record<string, string>) => { const r = parsePlaybook(form(over)); return r.success ? null : r.error.issues[0].message; };

describe('sales playbook', () => {
  test('CW-01 a playbook form becomes plans in cents with questions, objections and rules', () => {
    const r = parsePlaybook(form());
    expect(r.success).toBe(true);
    if (!r.success) return;
    expect(r.data.plans).toEqual([
      { name: 'Starter', price_cents: 19900, currency: 'USD', interval: 'month', description: 'One clinic' },
      { name: 'Growth', price_cents: 125050, currency: 'USD', interval: 'year', description: '' },
    ]);
    expect(r.data.qualification_questions).toEqual(['How many clinics?', 'Who decides?']);
    expect(r.data.objections[0]).toEqual({ objection: 'too expensive', answer: 'Two new patients a month pay for it' });
    expect(r.data.proposal_role).toBe('Client');
    expect(readPlaybook(r.data)?.plans).toHaveLength(2);
    expect(readPlaybook({ offer_summary: 'x' })).toBeNull();
  });

  test('CW-02 prices, currencies and the offer are checked with one clear message each', () => {
    expect(toCents('12.5')).toBe(1250);
    expect(Number.isNaN(toCents('12.505'))).toBe(true);
    expect(err({ plan_0_price: 'abc' })).toBe('Each plan needs a price of at least 1.00');
    expect(err({ plan_0_currency: 'dollars' })).toBe('Use a three-letter currency code, like USD');
    expect(err({ plan_0_name: '', plan_0_price: '', plan_1_name: '', plan_1_price: '' })).toBe('Add at least one plan with a name and a price');
    expect(err({ offer_summary: 'Short' })).toBe('Describe the offer in at least 20 characters');
    expect(err({ proposal_template_id: 'bad id!' })).toBe('Copy the template ID from PandaDoc (letters and numbers)');
  });

  test('CW-03 the closer checklist separates what is required from what is optional', () => {
    const ok = { closerEnabled: true, vapiConnected: true, playbookReady: true, assistantId: 'a', phoneNumberId: 'p', stripeConnected: false, pandadocConnected: false, templateId: null };
    expect(closerReadiness(ok).ready).toBe(true);
    for (const k of ['closerEnabled', 'vapiConnected', 'playbookReady'] as const) expect(closerReadiness({ ...ok, [k]: false }).ready).toBe(false);
    expect(closerReadiness({ ...ok, assistantId: null }).ready).toBe(false);
    expect(closerReadiness({ ...ok, pandadocConnected: true }).optional.find((i) => i.id === 'pandadoc')!.done).toBe(false);
    expect(closerReadiness({ ...ok, pandadocConnected: true, templateId: 'T' }).optional.find((i) => i.id === 'pandadoc')!.done).toBe(true);
    expect(closerAssistantSchema.safeParse('33333333-3333-4333-8333-333333333333').success).toBe(true);
    expect(closerAssistantSchema.safeParse('assistant').success).toBe(false);
  });

  test('CW-04 only Stripe payment links and PandaDoc documents are shown as links', () => {
    expect(safeLink('https://buy.stripe.com/test_1', PAYMENT_HOSTS)).toBe('https://buy.stripe.com/test_1');
    expect(safeLink('https://evil.example/buy.stripe.com/', PAYMENT_HOSTS)).toBeNull();
    expect(safeLink('javascript:alert(1)', PAYMENT_HOSTS)).toBeNull();
    expect(safeLink('https://app.pandadoc.com/a/#/documents/Doc1', PROPOSAL_HOSTS)).toBe('https://app.pandadoc.com/a/#/documents/Doc1');
    expect(safeLink(null, PROPOSAL_HOSTS)).toBeNull();
    expect(money(49900, 'USD')).toBe('$499');
    expect(money(null, 'USD')).toBe('—');
  });

  test('CW-05 labels and closer run results', () => {
    for (const s of ['meeting_booked', 'meeting_held', 'proposal_sent', 'negotiation', 'won', 'lost']) expect(DEAL_STAGE_LABELS[s]).toBeTruthy();
    for (const s of ['none', 'pending', 'sending', 'sent', 'needs_team', 'failed']) expect(CLOSE_STATUS_LABELS[s]).toBeTruthy();
    for (const s of ['none', 'link_sent', 'paid', 'refunded']) expect(PAYMENT_LABELS[s]).toBeTruthy();
    for (const s of ['pending', 'calling', 'held', 'no_answer', 'handed_off', 'failed']) expect(CLOSER_STATUS_LABELS[s]).toBeTruthy();
    expect(JOB_TYPES).toContain('ai_closer');
    expect(describeJobResult('ai_closer', 'succeeded', { calls_started: 1, handed_off: 2, proposals_sent: 1, payment_links: 1 }, null))
      .toBe('1 meeting started; 2 handed to your team; 1 proposal sent; 1 payment link created.');
    expect(describeJobResult('ai_closer', 'succeeded', {}, null)).toBe('No meetings starting and no proposals to send.');
  });
});
