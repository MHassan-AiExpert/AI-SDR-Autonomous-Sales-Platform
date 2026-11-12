import { describe, expect, it } from 'vitest';
import {
  addMemberSchema, firstError, parseSettingsForm, safeNextPath, signInSchema, signUpSchema, uuidSchema, workspaceNameSchema,
} from '@/lib/validation';

const form = (entries: Record<string, string>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(entries)) f.set(k, v);
  return f;
};

describe('sign-up and sign-in', () => {
  it('WEB-08 accepts a valid email and strong password, normalising the email', () => {
    const r = signUpSchema.safeParse({ email: '  Jane@Acme.COM ', password: 'correct-horse-9' });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.email).toBe('jane@acme.com');
  });

  it('WEB-09 rejects malformed emails', () => {
    for (const email of ['', 'jane', 'jane@', '@acme.com', 'jane acme@x.com']) {
      expect(signUpSchema.safeParse({ email, password: 'correct-horse-9' }).success).toBe(false);
    }
  });

  it('WEB-10 enforces password length, a letter and a number', () => {
    const msg = (password: string) => {
      const r = signUpSchema.safeParse({ email: 'a@b.co', password });
      return r.success ? null : firstError(r.error);
    };
    expect(msg('short1')).toMatch(/at least 10/);
    expect(msg('1234567890123')).toMatch(/letter/);
    expect(msg('onlyletters-here')).toMatch(/number/);
    expect(msg('a1'.repeat(40))).toMatch(/at most 72/);
    expect(msg('good-password-1')).toBeNull();
  });

  it('WEB-11 sign-in requires both fields but does not apply sign-up password rules', () => {
    expect(signInSchema.safeParse({ email: 'a@b.co', password: '' }).success).toBe(false);
    expect(signInSchema.safeParse({ email: 'a@b.co', password: 'old' }).success).toBe(true);
  });
});

describe('workspaces and team', () => {
  it('WEB-12 workspace names are trimmed and length-checked', () => {
    expect(workspaceNameSchema.parse('  Acme Dental  ')).toBe('Acme Dental');
    expect(workspaceNameSchema.safeParse(' a ').success).toBe(false);
    expect(workspaceNameSchema.safeParse('x'.repeat(121)).success).toBe(false);
  });

  it('WEB-13 adding a member needs a valid email and a known role', () => {
    expect(addMemberSchema.safeParse({ email: 'rep@acme.com', role: 'rep' }).success).toBe(true);
    expect(addMemberSchema.safeParse({ email: 'rep@acme.com', role: 'root' }).success).toBe(false);
    expect(addMemberSchema.safeParse({ email: 'nope', role: 'rep' }).success).toBe(false);
  });

  it('WEB-14 identifiers must be UUIDs', () => {
    expect(uuidSchema.safeParse('2b1f1c1e-7f0a-4c59-9d2e-1b2c3d4e5f60').success).toBe(true);
    expect(uuidSchema.safeParse("1' or '1'='1").success).toBe(false);
  });
});

describe('settings form', () => {
  const base = { name: 'Acme', automation_mode: 'autopilot' };

  it('WEB-15 unchecked boxes mean the channel is off', () => {
    const r = parseSettingsForm(form({ ...base, channel_email: 'on' }));
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.enabled_channels).toEqual({ email: true, voice: false, sms: false, whatsapp: false, linkedin: false });
      expect(r.data.ai_closer_enabled).toBe(false);
    }
  });

  it('WEB-16 reads every channel and the AI closer switch', () => {
    const r = parseSettingsForm(form({
      ...base, automation_mode: 'approval', ai_closer_enabled: 'on',
      channel_email: 'on', channel_voice: 'on', channel_sms: 'on', channel_whatsapp: 'on', channel_linkedin: 'on',
    }));
    expect(r.success).toBe(true);
    if (r.success) {
      expect(Object.values(r.data.enabled_channels).every(Boolean)).toBe(true);
      expect(r.data.automation_mode).toBe('approval');
      expect(r.data.ai_closer_enabled).toBe(true);
    }
  });

  it('WEB-17 rejects an unknown automation mode and extra fields are dropped', () => {
    expect(parseSettingsForm(form({ ...base, automation_mode: 'yolo' })).success).toBe(false);
    const r = parseSettingsForm(form({ ...base, outreach_paused: 'true', plan: 'enterprise', created_by: 'x' }));
    expect(r.success).toBe(true);
    if (r.success) expect(Object.keys(r.data).sort()).toEqual(['ai_closer_enabled', 'automation_mode', 'enabled_channels', 'name']);
  });
});

describe('redirect safety', () => {
  it('WEB-18 keeps paths inside the app', () => {
    expect(safeNextPath('/w/123/members')).toBe('/w/123/members');
  });

  it('WEB-19 blocks open redirects', () => {
    for (const bad of ['https://evil.test', '//evil.test', '/\\evil.test', 'javascript:alert(1)', '', null, undefined, 42, '/ok\nSet-Cookie: x']) {
      expect(safeNextPath(bad)).toBe('/workspaces');
    }
  });
});
