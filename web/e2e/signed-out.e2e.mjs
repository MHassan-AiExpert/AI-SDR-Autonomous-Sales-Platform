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

await check('E2E-17', 'A shared audit link that does not exist shows the not-found page without asking to sign in', async () => {
  for (const token of ['0'.repeat(48), 'not-a-token']) {
    const res = await page.goto(`${BASE}/a/${token}`);
    assert.equal(res.status(), 404);
    assert.equal(new URL(page.url()).pathname, `/a/${token}`);
  }
  const ping = await page.request.post(`${BASE}/a/${'0'.repeat(48)}/view`, { data: { seconds: 0 } });
  assert.equal(ping.status(), 204);
});

await check('E2E-02', 'Workspace list redirects signed-out visitors to sign-in', async () => {
  await page.goto(`${BASE}/workspaces`);
  assert.equal(new URL(page.url()).pathname, '/login');
  assert.equal(new URL(page.url()).searchParams.get('next'), '/workspaces');
});

await check('E2E-03', 'Workspace pages redirect signed-out visitors and remember the destination', async () => {
  for (const path of [`/w/${WS}`, `/w/${WS}/setup`, `/w/${WS}/members`, `/w/${WS}/settings`, `/w/${WS}/campaigns`, `/w/${WS}/campaigns/new`, `/w/${WS}/campaigns/${WS}`, `/w/${WS}/leads?source=apollo`, `/w/${WS}/leads/${WS}`, `/w/${WS}/campaigns/${WS}/emails`, `/w/${WS}/inbox`, `/w/${WS}/meetings`, `/w/${WS}/calls`, `/w/${WS}/texts`, `/w/${WS}/deals`, `/w/${WS}/playbook`, `/w/${WS}/learning`, `/w/${WS}/analytics`, `/w/${WS}/analytics/export`, `/w/${WS}/notifications`, `/w/${WS}/notifications?view=handoffs`, `/agency`, `/agency/${WS}`, `/agency/${WS}/usage`, `/w/${WS}/leads/import`, `/w/${WS}/templates`, `/w/${WS}/signals`, `/w/${WS}/deliverability`, `/w/${WS}/developers`, `/w/${WS}/visitors`, `/w/${WS}/campaigns/${WS}/sequence`]) {
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

await check('E2E-19', 'The public API refuses a request without a valid key, and unknown methods, without signing in', async () => {
  const none = await fetch(`${BASE}/api/v1/leads`);
  assert.equal(none.status, 401);
  assert.match((await none.json()).error, /Authorization: Bearer/);
  assert.equal(none.headers.get('cache-control'), 'no-store');
  assert.equal(none.headers.get('access-control-allow-origin'), null);
  const bad = await fetch(`${BASE}/api/v1/leads`, { headers: { Authorization: 'Bearer sdr_not_a_key' } });
  assert.equal(bad.status, 401);
  const del = await fetch(`${BASE}/api/v1/leads`, { method: 'DELETE' });
  assert.equal(del.status, 405);
});

await check('E2E-20', 'The visitor script is served without a session, and page views answer 204 whatever is sent', async () => {
  const js = await fetch(`${BASE}/v.js`);
  assert.equal(js.status, 200);
  assert.match(js.headers.get('content-type') ?? '', /javascript/);
  assert.match(await js.text(), /globalPrivacyControl/);
  assert.equal(js.headers.get('set-cookie'), null);
  for (const key of ['site_' + '0'.repeat(32), 'nonsense']) {
    const r = await fetch(`${BASE}/api/visit/${key}`, { method: 'POST', body: '{"p":"/"}', headers: { Origin: 'https://acme.com', 'Content-Type': 'text/plain' } });
    assert.equal(r.status, 204);
    assert.equal(await r.text(), '');
    assert.equal(r.headers.get('set-cookie'), null);
  }
  assert.equal((await fetch(`${BASE}/api/visit/nonsense`)).status, 405);
});

await check('E2E-18', 'The signal address refuses a malformed token, a wrong method and a broken body without signing in', async () => {
  const bad = await fetch(`${BASE}/api/signals/not-a-token`, { method: 'POST', body: '{}' });
  assert.equal(bad.status, 404);
  assert.deepEqual(await bad.json(), { error: 'Unknown webhook address' });
  const get = await fetch(`${BASE}/api/signals/${'a'.repeat(64)}`);
  assert.equal(get.status, 405);
  const broken = await fetch(`${BASE}/api/signals/${'a'.repeat(64)}`, { method: 'POST', body: 'not json' });
  assert.equal(broken.status, 400);
  assert.deepEqual(await broken.json(), { error: 'The body is not valid JSON' });
  assert.equal(broken.headers.get('cache-control'), 'no-store');
});

if (process.env.SCREENSHOT_DIR) {
  await page.goto(`${BASE}/signup`);
  await page.screenshot({ path: `${process.env.SCREENSHOT_DIR}/signup.png` });
}

await check('E2E-21', 'The Dark / Light switch is remembered, applied before the page draws, and never leaves the site', async () => {
  const ctx = await browser.newContext({ colorScheme: 'light' });
  const p = await ctx.newPage();
  await p.goto(`${BASE}/login`);
  assert.equal(await p.evaluate(() => document.documentElement.dataset.theme ?? null), null);
  const res = await p.request.post(`${BASE}/theme`, { form: { theme: 'dark', back: '/login' }, maxRedirects: 0 });
  assert.equal(res.status(), 303);
  assert.equal(new URL(res.headers().location, BASE).pathname, '/login');
  await p.goto(`${BASE}/login`);
  assert.equal(await p.evaluate(() => document.documentElement.dataset.theme), 'dark');
  assert.equal(await p.evaluate(() => getComputedStyle(document.body).backgroundColor), 'rgb(10, 18, 34)');
  for (const back of ['//evil.test/x', 'https://evil.test', '/\\evil.test']) {
    const r = await p.request.post(`${BASE}/theme`, { form: { theme: 'light', back }, maxRedirects: 0 });
    const to = new URL(r.headers().location, BASE);
    assert.equal(to.host, new URL(BASE).host);
    assert.equal(to.pathname, '/workspaces');
  }
  const bad = await p.request.post(`${BASE}/theme`, { form: { theme: '<script>', back: '/login' }, maxRedirects: 0 });
  assert.equal(bad.status(), 303);
  await p.goto(`${BASE}/login`);
  assert.equal(await p.evaluate(() => document.documentElement.dataset.theme ?? null), null);
  await ctx.close();
});

await browser.close();
for (const r of results) console.log(r.join(' | '));
const failed = results.filter((r) => r[2] !== 'Pass').length;
console.log(`\n${results.length - failed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
