import { test, expect } from 'vitest';
import { loadConfig } from '../src/config.ts';

test('CFG-01 required settings are checked and limits clamped', () => {
  expect(() => loadConfig({})).toThrow(/DATABASE_URL/);
  expect(() => loadConfig({ DATABASE_URL: 'postgres://x', PLATFORM_HMAC_SECRET: 'short' })).toThrow(/32 characters/);
  const c = loadConfig({ DATABASE_URL: 'postgres://x', PLATFORM_HMAC_SECRET: 's'.repeat(32), JOBS_PER_RUN: '99' });
  expect(c).toMatchObject({ port: 8080, jobsPerRun: 20, scheduleHours: 24, models: { openai: 'gpt-4.1-mini', anthropic: null, gemini: 'gemini-2.5-flash' } });
});

test('CFG-02 the daily schedule can be changed or switched off', () => {
  const base = { DATABASE_URL: 'postgres://x', PLATFORM_HMAC_SECRET: 's'.repeat(32) };
  expect(loadConfig({ ...base, SCHEDULE_HOURS: '0' }).scheduleHours).toBe(0);
  expect(loadConfig({ ...base, SCHEDULE_HOURS: '12' }).scheduleHours).toBe(12);
  expect(loadConfig({ ...base, SCHEDULE_HOURS: '9999' }).scheduleHours).toBe(168);
  expect(loadConfig({ ...base, SCHEDULE_HOURS: 'soon' }).scheduleHours).toBe(0);
});
