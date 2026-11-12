import { z } from 'zod';
import { ROLES } from './roles';

export const CHANNELS = ['email', 'voice', 'sms', 'whatsapp', 'linkedin'] as const;
export type Channel = (typeof CHANNELS)[number];

export const CHANNEL_LABELS: Record<Channel, string> = {
  email: 'Email',
  voice: 'AI voice calls',
  sms: 'SMS',
  whatsapp: 'WhatsApp',
  linkedin: 'LinkedIn',
};

const email = z
  .string()
  .trim()
  .toLowerCase()
  .min(1, 'Enter your email address')
  .max(254, 'Email address is too long')
  .pipe(z.email('Enter a valid email address'));

const password = z
  .string()
  .min(10, 'Password must be at least 10 characters')
  .max(72, 'Password must be at most 72 characters')
  .regex(/[a-zA-Z]/, 'Password must include a letter')
  .regex(/[0-9]/, 'Password must include a number');

export const signUpSchema = z.object({ email, password });

export const signInSchema = z.object({
  email,
  password: z.string().min(1, 'Enter your password').max(72, 'Password is too long'),
});

export const workspaceNameSchema = z
  .string()
  .trim()
  .min(2, 'Workspace name must be at least 2 characters')
  .max(120, 'Workspace name must be at most 120 characters');

export const addMemberSchema = z.object({
  email,
  role: z.enum(ROLES, 'Choose a role'),
});

export const roleSchema = z.enum(ROLES, 'Choose a role');

export const uuidSchema = z.uuid('Invalid identifier');

export const settingsSchema = z.object({
  name: workspaceNameSchema,
  automation_mode: z.enum(['autopilot', 'approval'], 'Choose an automation mode'),
  ai_closer_enabled: z.boolean(),
  enabled_channels: z.object({
    email: z.boolean(),
    voice: z.boolean(),
    sms: z.boolean(),
    whatsapp: z.boolean(),
    linkedin: z.boolean(),
  }),
  slack_channel: z.string().trim()
    .transform((v) => (v === '' ? null : v.startsWith('#') ? v.toLowerCase() : v))
    .pipe(z.string().regex(/^(#[a-z0-9._-]{1,80}|[CGD][A-Z0-9]{8,12})$/, 'Use a Slack channel like #sales-alerts or a channel ID').nullable()),
});
export type SettingsInput = z.infer<typeof settingsSchema>;

/** Reads the settings form. Unchecked checkboxes are absent from form data. */
export function parseSettingsForm(form: FormData) {
  return settingsSchema.safeParse({
    name: form.get('name') ?? '',
    automation_mode: form.get('automation_mode') ?? '',
    ai_closer_enabled: form.get('ai_closer_enabled') === 'on',
    enabled_channels: Object.fromEntries(CHANNELS.map((c) => [c, form.get(`channel_${c}`) === 'on'])),
    slack_channel: form.get('slack_channel') ?? '',
  });
}

/** First validation message, for showing next to a form. */
export function firstError(error: z.ZodError): string {
  return error.issues[0]?.message ?? 'Check the form and try again';
}

/**
 * Only allow redirects to paths inside this app. Blocks open redirects such as
 * //evil.test, /\evil.test or absolute URLs passed in a `next` parameter.
 */
export function safeNextPath(next: unknown, fallback = '/workspaces'): string {
  if (typeof next !== 'string') return fallback;
  if (!next.startsWith('/') || next.startsWith('//') || next.includes('\\') || next.includes('\n')) return fallback;
  return next;
}
