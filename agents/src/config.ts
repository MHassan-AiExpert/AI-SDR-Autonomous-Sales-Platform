// Runtime configuration from environment variables.

export type Config = {
  databaseUrl: string;
  hmacSecret: string;
  port: number;
  jobsPerRun: number;
  scheduleHours: number;
  appUrl?: string;
  webhookBaseUrl?: string;
  models: { openai: string; anthropic: string | null; gemini: string };
};

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const databaseUrl = env.DATABASE_URL;
  const hmacSecret = env.PLATFORM_HMAC_SECRET;
  if (!databaseUrl) throw new Error('DATABASE_URL is required');
  if (!hmacSecret || hmacSecret.length < 32) throw new Error('PLATFORM_HMAC_SECRET must be at least 32 characters');
  return {
    databaseUrl,
    hmacSecret,
    port: Number(env.PORT ?? 8080),
    jobsPerRun: Math.min(Math.max(Number(env.JOBS_PER_RUN ?? 3), 1), 20),
    // Hours between automatic sourcing runs per active campaign; 0 turns it off
    // Links in Slack alerts point here, for example https://app.example.com
    appUrl: /^https?:\/\/[^\s/]+$/.test(env.PUBLIC_APP_URL ?? '') ? env.PUBLIC_APP_URL : undefined,
    // Public HTTPS address of n8n; Calendly notifications are sent to <this>/webhook/calendly/<token>
    webhookBaseUrl: /^https:\/\/[^\s/]+$/.test(env.WEBHOOK_BASE_URL ?? '') ? env.WEBHOOK_BASE_URL : undefined,
    scheduleHours: Math.min(Math.max(Number(env.SCHEDULE_HOURS ?? 24) || 0, 0), 168),
    models: {
      openai: env.OPENAI_MODEL || 'gpt-4.1-mini',
      // No default: set ANTHROPIC_MODEL to a current model id to enable it.
      anthropic: env.ANTHROPIC_MODEL || null,
      gemini: env.GEMINI_MODEL || 'gemini-2.5-flash',
    },
  };
}
