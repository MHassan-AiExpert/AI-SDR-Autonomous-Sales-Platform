// Catalog of the tools a company connects during onboarding, and the plan
// that decides which of them its enabled channels need.

import type { Channel } from './validation';

export const TOOL_IDS = [
  'openai', 'anthropic', 'gemini', 'apollo', 'apify', 'zerobounce', 'instantly', 'twilio',
  'vapi', 'whatsapp', 'zoom', 'calendly', 'hubspot', 'slack', 'pandadoc', 'stripe',
] as const;
export type ToolId = (typeof TOOL_IDS)[number];

export type Field = {
  name: string;
  label: string;
  /** Secret fields are write-only: stored in the vault, never shown again. */
  secret: boolean;
  /** Allowed format, checked before any network call. */
  pattern?: RegExp;
  help?: string;
};

export type Tool = {
  id: ToolId;
  name: string;
  purpose: string;
  fields: Field[];
  docsUrl: string;
};

const KEY = /^[\x21-\x7e]{8,512}$/; // printable, no spaces

export const TOOLS: Record<ToolId, Tool> = {
  openai: {
    id: 'openai', name: 'OpenAI', purpose: 'Research, copywriting, reply classification and lead discovery',
    fields: [{ name: 'api_key', label: 'API key', secret: true, pattern: KEY }],
    docsUrl: 'https://platform.openai.com/api-keys',
  },
  anthropic: {
    id: 'anthropic', name: 'Anthropic', purpose: 'Alternative or backup language model',
    fields: [{ name: 'api_key', label: 'API key', secret: true, pattern: KEY }],
    docsUrl: 'https://console.anthropic.com/settings/keys',
  },
  gemini: {
    id: 'gemini', name: 'Google Gemini', purpose: 'Alternative or backup language model and lead discovery',
    fields: [{ name: 'api_key', label: 'API key', secret: true, pattern: KEY }],
    docsUrl: 'https://aistudio.google.com/apikey',
  },
  apollo: {
    id: 'apollo', name: 'Apollo', purpose: 'B2B lead data and contact enrichment',
    fields: [{ name: 'api_key', label: 'API key', secret: true, pattern: KEY }],
    docsUrl: 'https://developer.apollo.io/',
  },
  apify: {
    id: 'apify', name: 'Apify', purpose: 'Google Maps and social media scraping',
    fields: [{ name: 'api_token', label: 'API token', secret: true, pattern: KEY }],
    docsUrl: 'https://console.apify.com/settings/integrations',
  },
  zerobounce: {
    id: 'zerobounce', name: 'ZeroBounce', purpose: 'Email verification before any email is sent',
    fields: [{ name: 'api_key', label: 'API key', secret: true, pattern: KEY }],
    docsUrl: 'https://www.zerobounce.net/members/API',
  },
  instantly: {
    id: 'instantly', name: 'Instantly', purpose: 'Sending email sequences from your mailboxes',
    fields: [{ name: 'api_key', label: 'API key (v2)', secret: true, pattern: KEY }],
    docsUrl: 'https://developer.instantly.ai/',
  },
  twilio: {
    id: 'twilio', name: 'Twilio', purpose: 'Phone numbers for AI calls and SMS',
    fields: [
      { name: 'account_sid', label: 'Account SID', secret: false, pattern: /^AC[0-9a-fA-F]{32}$/, help: 'Starts with AC, 34 characters' },
      { name: 'auth_token', label: 'Auth token', secret: true, pattern: /^[0-9a-zA-Z]{32}$/ },
    ],
    docsUrl: 'https://console.twilio.com/',
  },
  vapi: {
    id: 'vapi', name: 'Vapi', purpose: 'AI voice agents: cold caller, closer and receptionist',
    fields: [{ name: 'api_key', label: 'Private API key', secret: true, pattern: KEY }],
    docsUrl: 'https://dashboard.vapi.ai/org/api-keys',
  },
  whatsapp: {
    id: 'whatsapp', name: 'WhatsApp Business', purpose: 'Sending audits, proposals and reminders on WhatsApp',
    fields: [
      { name: 'phone_number_id', label: 'Phone number ID', secret: false, pattern: /^\d{5,20}$/, help: 'From WhatsApp Manager, API setup' },
      { name: 'access_token', label: 'Permanent access token', secret: true, pattern: KEY },
    ],
    docsUrl: 'https://developers.facebook.com/docs/whatsapp/cloud-api/get-started',
  },
  zoom: {
    id: 'zoom', name: 'Zoom', purpose: 'Creating meetings for booked prospects',
    fields: [
      { name: 'account_id', label: 'Account ID', secret: false, pattern: /^[A-Za-z0-9_-]{10,64}$/, help: 'Server-to-Server OAuth app' },
      { name: 'client_id', label: 'Client ID', secret: false, pattern: /^[A-Za-z0-9_-]{10,64}$/ },
      { name: 'client_secret', label: 'Client secret', secret: true, pattern: KEY },
    ],
    docsUrl: 'https://developers.zoom.us/docs/internal-apps/s2s-oauth/',
  },
  calendly: {
    id: 'calendly', name: 'Calendly', purpose: 'Live availability and booking links',
    fields: [{ name: 'access_token', label: 'Personal access token', secret: true, pattern: KEY }],
    docsUrl: 'https://calendly.com/integrations/api_webhooks',
  },
  hubspot: {
    id: 'hubspot', name: 'HubSpot', purpose: 'Optional sync to your existing CRM',
    fields: [{ name: 'access_token', label: 'Private app access token', secret: true, pattern: KEY }],
    docsUrl: 'https://developers.hubspot.com/docs/api/private-apps',
  },
  slack: {
    id: 'slack', name: 'Slack', purpose: 'Hot-lead, handoff and deal alerts for your team',
    fields: [{ name: 'bot_token', label: 'Bot token', secret: true, pattern: /^xoxb-[\x21-\x7e]{10,250}$/, help: 'Starts with xoxb-' }],
    docsUrl: 'https://api.slack.com/apps',
  },
  pandadoc: {
    id: 'pandadoc', name: 'PandaDoc', purpose: 'Sending agreements for e-signature',
    fields: [{ name: 'api_key', label: 'API key', secret: true, pattern: KEY }],
    docsUrl: 'https://app.pandadoc.com/a/#/settings/integrations/api',
  },
  stripe: {
    id: 'stripe', name: 'Stripe', purpose: 'Payment links and invoices for won deals',
    fields: [{ name: 'secret_key', label: 'Restricted or secret key', secret: true, pattern: /^(sk|rk)_(live|test)_[A-Za-z0-9]{10,250}$/, help: 'Starts with sk_ or rk_' }],
    docsUrl: 'https://dashboard.stripe.com/apikeys',
  },
};

export function isToolId(value: unknown): value is ToolId {
  return typeof value === 'string' && (TOOL_IDS as readonly string[]).includes(value);
}

export type ParsedCredentials = { secret: Record<string, string>; meta: Record<string, string> };

/**
 * Reads and checks the credential fields of a tool from a form. Secret fields
 * go to the vault; non-secret identifiers (and a masked hint of the key) are
 * kept in the integration's metadata so people can see what is connected.
 */
export function parseCredentials(tool: Tool, form: FormData): { ok: true; value: ParsedCredentials } | { ok: false; error: string } {
  const secret: Record<string, string> = {};
  const meta: Record<string, string> = {};
  for (const field of tool.fields) {
    const raw = form.get(field.name);
    const value = typeof raw === 'string' ? raw.trim() : '';
    if (!value) return { ok: false, error: `Enter the ${field.label}.` };
    if (field.pattern && !field.pattern.test(value)) {
      return { ok: false, error: `The ${field.label} does not look right.${field.help ? ` ${field.help}.` : ''}` };
    }
    secret[field.name] = value;
    if (!field.secret) meta[field.name] = value;
  }
  const mainSecret = tool.fields.find((f) => f.secret);
  if (mainSecret) meta.hint = maskSecret(secret[mainSecret.name]);
  return { ok: true, value: { secret, meta } };
}

/** Shows only the last four characters of a secret. */
export function maskSecret(value: string): string {
  return value.length <= 8 ? '••••' : `•••• ${value.slice(-4)}`;
}

// -----------------------------------------------------------------------------
// Onboarding plan
// -----------------------------------------------------------------------------

export type IntegrationStatus = 'connected' | 'error' | 'expired' | 'disconnected';
export type StepStatus = 'done' | 'todo' | 'optional';

export type PlanStep = {
  id: string;
  title: string;
  description: string;
  /** Any one of these tools completes the step. */
  tools: ToolId[];
  required: boolean;
  done: boolean;
};

export type ChecklistItem = { id: string; title: string; description: string; done: boolean };

export type OnboardingPlan = {
  steps: PlanStep[];
  checklist: ChecklistItem[];
  /** Required steps and checklist items completed, 0-100. */
  progress: number;
  ready: boolean;
};

type PlanInput = {
  enabledChannels: Partial<Record<Channel, boolean>>;
  aiCloserEnabled: boolean;
  statuses: Partial<Record<ToolId, IntegrationStatus>>;
  checklist: Record<string, unknown>;
};

const STEP_DEFS: { id: string; title: string; description: string; tools: ToolId[]; needs: (i: PlanInput) => boolean }[] = [
  { id: 'llm', title: 'Language model', description: 'Powers research, writing, reply handling and the voice agents. Connect at least one.', tools: ['openai', 'anthropic', 'gemini'], needs: () => true },
  { id: 'lead_data', title: 'Lead sources', description: 'Where agents find leads. Apollo for B2B data, Apify for Google Maps and social media.', tools: ['apollo', 'apify'], needs: () => true },
  { id: 'verification', title: 'Email verification', description: 'Checks every address before it is emailed, to protect your domains.', tools: ['zerobounce'], needs: (i) => Boolean(i.enabledChannels.email) },
  { id: 'email', title: 'Email sending', description: 'Sends your sequences from warmed-up mailboxes.', tools: ['instantly'], needs: (i) => Boolean(i.enabledChannels.email) },
  { id: 'voice_agent', title: 'AI voice agents', description: 'Runs the cold caller, the closer and the receptionist.', tools: ['vapi'], needs: (i) => Boolean(i.enabledChannels.voice) || i.aiCloserEnabled },
  { id: 'telephony', title: 'Phone numbers', description: 'Local numbers for AI calls and SMS.', tools: ['twilio'], needs: (i) => Boolean(i.enabledChannels.voice || i.enabledChannels.sms) },
  { id: 'whatsapp', title: 'WhatsApp', description: 'Sends audits, proposals and reminders to leads who opted in.', tools: ['whatsapp'], needs: (i) => Boolean(i.enabledChannels.whatsapp) },
  { id: 'meetings', title: 'Meetings', description: 'Creates the Zoom meeting for every booking.', tools: ['zoom'], needs: () => true },
  { id: 'calendar', title: 'Calendar', description: 'Live availability and booking links.', tools: ['calendly'], needs: () => true },
  { id: 'alerts', title: 'Team alerts', description: 'Hot leads, handoffs and won deals in Slack.', tools: ['slack'], needs: () => true },
  { id: 'agreements', title: 'Agreements', description: 'Sends the agreement for e-signature when a deal is won.', tools: ['pandadoc'], needs: (i) => i.aiCloserEnabled },
  { id: 'payments', title: 'Payments', description: 'Sends payment links and invoices for won deals.', tools: ['stripe'], needs: (i) => i.aiCloserEnabled },
  { id: 'crm', title: 'External CRM', description: 'Optional. The built-in sales workspace already keeps every lead and deal.', tools: ['hubspot'], needs: () => false },
];

const CHECKLIST_DEFS: { id: string; title: string; description: string; needs: (i: PlanInput) => boolean }[] = [
  { id: 'sending_domains', title: 'Sending domains authenticated', description: 'Separate sending domains with SPF, DKIM and DMARC records set.', needs: (i) => Boolean(i.enabledChannels.email) },
  { id: 'mailbox_warmup', title: 'Mailboxes warmed up', description: 'Warm-up running for at least two weeks before the first campaign.', needs: (i) => Boolean(i.enabledChannels.email) },
  { id: 'a2p_10dlc', title: 'SMS registration approved', description: 'A2P 10DLC brand and campaign registered in Twilio (required for US numbers).', needs: (i) => Boolean(i.enabledChannels.sms) },
  { id: 'whatsapp_templates', title: 'WhatsApp templates approved', description: 'Message templates for audits, proposals and reminders approved by Meta.', needs: (i) => Boolean(i.enabledChannels.whatsapp) },
];

export function buildOnboardingPlan(input: PlanInput): OnboardingPlan {
  const steps = STEP_DEFS.map((d) => ({
    id: d.id,
    title: d.title,
    description: d.description,
    tools: d.tools,
    required: d.needs(input),
    done: d.tools.some((t) => input.statuses[t] === 'connected'),
  }));
  const checklist = CHECKLIST_DEFS.filter((d) => d.needs(input)).map((d) => ({
    id: d.id, title: d.title, description: d.description, done: input.checklist[d.id] === true,
  }));
  const required = [...steps.filter((s) => s.required), ...checklist];
  const done = required.filter((s) => s.done).length;
  const progress = required.length ? Math.round((done / required.length) * 100) : 100;
  return { steps, checklist, progress, ready: done === required.length };
}

export const CHECKLIST_IDS = CHECKLIST_DEFS.map((d) => d.id);
