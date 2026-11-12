import { test, expect } from 'vitest';
import { loadConfig } from '../src/config.ts';

test('CFG-01 required settings are checked and limits clamped', () => {
  expect(() => loadConfig({})).toThrow(/DATABASE_URL/);
  expect(() => loadConfig({ DATABASE_URL: 'postgres://x', PLATFORM_HMAC_SECRET: 'short' })).toThrow(/32 characters/);
  const c = loadConfig({ DATABASE_URL: 'postgres://x', PLATFORM_HMAC_SECRET: 's'.repeat(32), JOBS_PER_RUN: '99' });
  expect(c).toMatchObject({ port: 8080, jobsPerRun: 20, models: { openai: 'gpt-4.1-mini', anthropic: null, gemini: 'gemini-2.5-flash' } });
});
