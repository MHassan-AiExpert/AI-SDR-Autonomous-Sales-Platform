import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { CHECKLIST_IDS, TOOL_IDS, TOOLS, buildOnboardingPlan, isToolId, maskSecret, parseCredentials, type ToolId } from '@/lib/integrations';

const form = (entries: Record<string, string>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(entries)) f.set(k, v);
  return f;
};

const allOn = { email: true, voice: true, sms: true, whatsapp: true, linkedin: false };
const connected = (...tools: ToolId[]) => Object.fromEntries(tools.map((t) => [t, 'connected' as const]));

describe('tool catalog', () => {
  it('ONB-01 the catalog matches the tools the database accepts', () => {
    const dir = new URL('../../supabase/migrations/', import.meta.url);
    const sql = readdirSync(dir).map((f) => readFileSync(new URL(f, dir), 'utf8')).join('\n');
    const match = sql.match(/integrations_tool_check check \(tool in \(([\s\S]*?)\)\)/);
    expect(match).not.toBeNull();
    const dbTools = [...match![1].matchAll(/'([a-z]+)'/g)].map((m) => m[1]).sort();
    expect([...TOOL_IDS].sort()).toEqual(dbTools);
  });

  it('ONB-02 every tool has a name, purpose, docs link and at least one secret field', () => {
    for (const id of TOOL_IDS) {
      const t = TOOLS[id];
      expect(t.id).toBe(id);
      expect(t.name.length).toBeGreaterThan(1);
      expect(t.docsUrl).toMatch(/^https:\/\//);
      expect(t.fields.some((f) => f.secret)).toBe(true);
    }
  });

  it('ONB-03 unknown tool ids are rejected', () => {
    expect(isToolId('stripe')).toBe(true);
    expect(isToolId('myspace')).toBe(false);
    expect(isToolId(undefined)).toBe(false);
  });
});

describe('credential form', () => {
  it('ONB-04 secret fields go to the vault, identifiers and a masked hint to metadata', () => {
    const r = parseCredentials(TOOLS.twilio, form({ account_sid: 'AC' + 'a'.repeat(32), auth_token: 'b'.repeat(28) + 'wxyz' }));
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.secret).toEqual({ account_sid: 'AC' + 'a'.repeat(32), auth_token: 'b'.repeat(28) + 'wxyz' });
      expect(r.value.meta).toEqual({ account_sid: 'AC' + 'a'.repeat(32), hint: '•••• wxyz' });
      expect(JSON.stringify(r.value.meta)).not.toContain('bbbb');
    }
  });

  it('ONB-05 values are trimmed', () => {
    const r = parseCredentials(TOOLS.openai, form({ api_key: '  sk-abcdefghijkl  ' }));
    expect(r.ok && r.value.secret.api_key).toBe('sk-abcdefghijkl');
  });

  it('ONB-06 missing and malformed fields are rejected with the field name', () => {
    const missing = parseCredentials(TOOLS.openai, form({}));
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.error).toBe('Enter the API key.');
    const cases: [ToolId, Record<string, string>, RegExp][] = [
      ['twilio', { account_sid: 'XX123', auth_token: 'a'.repeat(32) }, /Account SID does not look right/],
      ['slack', { bot_token: 'xoxp-1234567890abc' }, /Bot token does not look right. Starts with xoxb-/],
      ['stripe', { secret_key: 'pk_live_abcdefghijk' }, /does not look right/],
      ['whatsapp', { phone_number_id: '12ab', access_token: 'x'.repeat(20) }, /Phone number ID/],
      ['openai', { api_key: 'has spaces in it' }, /does not look right/],
    ];
    for (const [tool, values, msg] of cases) {
      const r = parseCredentials(TOOLS[tool], form(values));
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toMatch(msg);
    }
  });

  it('ONB-07 identifiers used in request addresses cannot contain path or query characters', () => {
    for (const bad of ['AC/../../evil', 'AC?x=1', 'AC' + 'a'.repeat(31) + '#']) {
      expect(TOOLS.twilio.fields[0].pattern!.test(bad)).toBe(false);
    }
    expect(TOOLS.whatsapp.fields[0].pattern!.test('123/me')).toBe(false);
    expect(TOOLS.zoom.fields[0].pattern!.test('abc@evil.test/x')).toBe(false);
  });

  it('ONB-08 only the last four characters of a secret are ever shown', () => {
    expect(maskSecret('sk-proj-1234567890abcd')).toBe('•••• abcd');
    expect(maskSecret('short')).toBe('••••');
  });
});

describe('onboarding plan', () => {
  it('ONB-09 a new workspace with all core channels needs 12 tool steps and 4 manual steps', () => {
    const plan = buildOnboardingPlan({ enabledChannels: allOn, aiCloserEnabled: true, statuses: {}, checklist: {} });
    expect(plan.steps.filter((s) => s.required).map((s) => s.id)).toEqual([
      'llm', 'lead_data', 'verification', 'email', 'voice_agent', 'telephony', 'whatsapp', 'meetings', 'calendar', 'alerts', 'agreements', 'payments',
    ]);
    expect(plan.checklist.map((c) => c.id)).toEqual(['sending_domains', 'mailbox_warmup', 'a2p_10dlc', 'whatsapp_templates']);
    expect(plan.progress).toBe(0);
    expect(plan.ready).toBe(false);
  });

  it('ONB-10 any one language model or lead source completes its step', () => {
    for (const tool of ['openai', 'anthropic', 'gemini'] as ToolId[]) {
      const plan = buildOnboardingPlan({ enabledChannels: allOn, aiCloserEnabled: true, statuses: connected(tool), checklist: {} });
      expect(plan.steps.find((s) => s.id === 'llm')!.done).toBe(true);
    }
    const plan = buildOnboardingPlan({ enabledChannels: allOn, aiCloserEnabled: true, statuses: connected('apify'), checklist: {} });
    expect(plan.steps.find((s) => s.id === 'lead_data')!.done).toBe(true);
  });

  it('ONB-11 a tool with an error or expired status does not count as done', () => {
    const plan = buildOnboardingPlan({ enabledChannels: allOn, aiCloserEnabled: true, statuses: { openai: 'error', anthropic: 'expired' }, checklist: {} });
    expect(plan.steps.find((s) => s.id === 'llm')!.done).toBe(false);
  });

  it('ONB-12 cold email only with the AI closer off needs only email-related steps', () => {
    const plan = buildOnboardingPlan({
      enabledChannels: { email: true, voice: false, sms: false, whatsapp: false, linkedin: false },
      aiCloserEnabled: false, statuses: {}, checklist: {},
    });
    expect(plan.steps.filter((s) => s.required).map((s) => s.id)).toEqual(['llm', 'lead_data', 'verification', 'email', 'meetings', 'calendar', 'alerts']);
    expect(plan.checklist.map((c) => c.id)).toEqual(['sending_domains', 'mailbox_warmup']);
  });

  it('ONB-13 the AI closer alone still needs the voice agent, agreements and payments', () => {
    const plan = buildOnboardingPlan({
      enabledChannels: { email: true, voice: false, sms: false, whatsapp: false, linkedin: false },
      aiCloserEnabled: true, statuses: {}, checklist: {},
    });
    const ids = plan.steps.filter((s) => s.required).map((s) => s.id);
    expect(ids).toContain('voice_agent');
    expect(ids).toContain('agreements');
    expect(ids).toContain('payments');
    expect(ids).not.toContain('telephony');
  });

  it('ONB-14 the external CRM is always optional and never blocks readiness', () => {
    const plan = buildOnboardingPlan({ enabledChannels: allOn, aiCloserEnabled: true, statuses: {}, checklist: {} });
    expect(plan.steps.find((s) => s.id === 'crm')!.required).toBe(false);
  });

  it('ONB-15 progress counts tool steps and manual steps; everything done means ready', () => {
    const everything = connected('openai', 'apollo', 'zerobounce', 'instantly', 'vapi', 'twilio', 'whatsapp', 'zoom', 'calendly', 'slack', 'pandadoc', 'stripe');
    const half = buildOnboardingPlan({ enabledChannels: allOn, aiCloserEnabled: true, statuses: everything, checklist: {} });
    expect(half.progress).toBe(Math.round((12 / 16) * 100));
    expect(half.ready).toBe(false);
    const all = buildOnboardingPlan({
      enabledChannels: allOn, aiCloserEnabled: true, statuses: everything,
      checklist: Object.fromEntries(CHECKLIST_IDS.map((id) => [id, true])),
    });
    expect(all.progress).toBe(100);
    expect(all.ready).toBe(true);
  });

  it('ONB-16 checklist values other than true do not count', () => {
    const plan = buildOnboardingPlan({ enabledChannels: allOn, aiCloserEnabled: true, statuses: {}, checklist: { sending_domains: 'yes', mailbox_warmup: 1 } });
    expect(plan.checklist.every((c) => !c.done)).toBe(true);
  });
});
