// Browser tests for everything a signed-out visitor can reach.
// Run: npm run build && npm run start, then `node e2e/signed-out.e2e.mjs`
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';

const require = createRequire(import.meta.url);
const { chromium, devices } = require('playwright');

const BASE = process.env.BASE_URL ?? 'http://localhost:3000';
const WS = '2b1f1c1e-7f0a-4c59-9d2e-1b2c3d4e5f60';
const results = [];

async function check(id, name, fn) {
  try {
    await fn();
    results.push([id, name, 'Pass']);
  } catch (err) {
    results.push([id, name, `FAIL: ${err.message.split('\n')[0]}`]);
  }
}

const browser = await chromium.launch();
const context = await browser.newContext();
const page = await context.newPage();
const externalAuthCalls = [];
page.on('request', (r) => { if (r.url().includes('supabase.co')) externalAuthCalls.push(r.url()); });

await check('E2E-01', 'Landing page offers sign-up and sign-in', async () => {
  await page.goto(BASE);
  await page.getByRole('heading', { level: 1 }).waitFor();
  assert.equal(await page.getByRole('link', { name: 'Create your account' }).getAttribute('href'), '/signup');
  assert.equal(await page.getByRole('link', { name: 'Sign in' }).getAttribute('href'), '/login');
});

await check('E2E-02', 'Workspace list redirects signed-out visitors to sign-in', async () => {
  await page.goto(`${BASE}/workspaces`);
  assert.equal(new URL(page.url()).pathname, '/login');
  assert.equal(new URL(page.url()).searchParams.get('next'), '/workspaces');
});

await check('E2E-03', 'Workspace pages redirect signed-out visitors and remember the destination', async () => {
  for (const path of [`/w/${WS}`, `/w/${WS}/setup`, `/w/${WS}/members`, `/w/${WS}/settings`, `/w/${WS}/campaigns`, `/w/${WS}/campaigns/new`, `/w/${WS}/campaigns/${WS}`, `/w/${WS}/leads?source=apollo`, `/w/${WS}/leads/${WS}`, `/w/${WS}/campaigns/${WS}/emails`, `/w/${WS}/inbox`, `/w/${WS}/meetings`, `/w/${WS}/calls`, `/w/${WS}/texts`]) {
    await page.goto(`${BASE}${path}`);
    assert.equal(new URL(page.url()).pathname, '/login');
    assert.equal(await page.locator('input[name=next]').inputValue(), path);
  }
});

await check('E2E-04', 'Sign-in with empty fields shows a validation message', async () => {
  await page.goto(`${BASE}/login`);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.getByRole('alert').filter({ hasText: 'Enter your email address' }).waitFor();
});

await check('E2E-05', 'Sign-in with a malformed email is rejected before any network call', async () => {
  await page.goto(`${BASE}/login`);
  await page.getByLabel('Email').fill('not-an-email');
  await page.getByLabel('Password').fill('x');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.getByRole('alert').filter({ hasText: 'Enter a valid email address' }).waitFor();
});

await check('E2E-06', 'Sign-up enforces the password rules', async () => {
  await page.goto(`${BASE}/signup`);
  await page.getByLabel('Work email').fill('owner@example.test');
  for (const [pw, msg] of [['short1', 'at least 10 characters'], ['onlyletters-here', 'include a number'], ['12345678901', 'include a letter']]) {
    await page.getByLabel('Password').fill(pw);
    await page.getByRole('button', { name: 'Create account' }).click();
    await page.getByRole('alert').filter({ hasText: msg }).waitFor();
  }
});

await check('E2E-16', 'What was typed stays in the form after an error', async () => {
  await page.goto(`${BASE}/signup`);
  await page.getByLabel('Work email').fill('owner@example.test');
  await page.getByLabel('Password').fill('short1');
  await page.getByRole('button', { name: 'Create account' }).click();
  await page.getByRole('alert').waitFor();
  assert.equal(await page.getByLabel('Work email').inputValue(), 'owner@example.test');
});

await check('E2E-07', 'Sign-up rejects a malformed email', async () => {
  await page.goto(`${BASE}/signup`);
  await page.getByLabel('Work email').fill('owner@');
  await page.getByLabel('Password').fill('good-password-1');
  await page.getByRole('button', { name: 'Create account' }).click();
  await page.getByRole('alert').filter({ hasText: 'Enter a valid email address' }).waitFor();
});

await check('E2E-08', 'Rejected forms never reach the auth service', async () => {
  assert.deepEqual(externalAuthCalls, []);
});

await check('E2E-09', 'An external "next" address is replaced with a safe path', async () => {
  for (const bad of ['https://evil.test/phish', '//evil.test', '/\\evil.test']) {
    await page.goto(`${BASE}/login?next=${encodeURIComponent(bad)}`);
    assert.equal(await page.locator('input[name=next]').inputValue(), '/workspaces');
  }
});

await check('E2E-10', 'A bad or expired email link returns to sign-in with a message', async () => {
  for (const path of ['/auth/callback', '/auth/confirm', '/auth/confirm?token_hash=abc&type=bogus']) {
    await page.goto(`${BASE}${path}`);
    assert.equal(new URL(page.url()).pathname, '/login');
    await page.getByRole('alert').filter({ hasText: 'invalid or has expired' }).waitFor();
  }
});

await check('E2E-11', 'Sign-out only accepts POST', async () => {
  const res = await context.request.get(`${BASE}/auth/signout`, { maxRedirects: 0 });
  assert.equal(res.status(), 405);
});

await check('E2E-12', 'Security headers are sent on every page', async () => {
  const res = await context.request.get(`${BASE}/login`);
  const h = res.headers();
  assert.match(h['strict-transport-security'], /max-age=63072000/);
  assert.equal(h['x-content-type-options'], 'nosniff');
  assert.equal(h['x-frame-options'], 'DENY');
  assert.equal(h['referrer-policy'], 'strict-origin-when-cross-origin');
  assert.equal(h['x-powered-by'], undefined);
});

await check('E2E-13', 'Unknown pages show the not-found page', async () => {
  const res = await page.goto(`${BASE}/does-not-exist`);
  assert.equal(res.status(), 404);
  await page.getByRole('heading', { name: 'Page not found' }).waitFor();
});

await check('E2E-14', 'Form fields have labels and correct autocomplete hints', async () => {
  await page.goto(`${BASE}/signup`);
  assert.equal(await page.getByLabel('Work email').getAttribute('autocomplete'), 'email');
  assert.equal(await page.getByLabel('Password').getAttribute('autocomplete'), 'new-password');
  await page.goto(`${BASE}/login`);
  assert.equal(await page.getByLabel('Password').getAttribute('autocomplete'), 'current-password');
});

await check('E2E-15', 'Pages fit a phone screen without sideways scrolling', async () => {
  const phone = await browser.newContext({ ...devices['iPhone 13'] });
  const p = await phone.newPage();
  for (const path of ['/', '/login', '/signup']) {
    await p.goto(`${BASE}${path}`);
    const overflow = await p.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    assert.ok(overflow <= 0, `${path} overflows by ${overflow}px`);
  }
  await phone.close();
});

if (process.env.SCREENSHOT_DIR) {
  await page.goto(`${BASE}/signup`);
  await page.screenshot({ path: `${process.env.SCREENSHOT_DIR}/signup.png` });
}

await browser.close();
for (const r of results) console.log(r.join(' | '));
const failed = results.filter((r) => r[2] !== 'Pass').length;
console.log(`\n${results.length - failed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
