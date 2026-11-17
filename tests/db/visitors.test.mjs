import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { createDatabase, seedTwoWorkspaces, asUser, asAnon, asService, USERS } from './helpers.mjs';

let db, wsA, wsB, keyA;

const record = (key, ip, host = 'acme.com', path = '/pricing?utm=x#top', ref = 'www.google.com') =>
  asAnon(db, (tx) => tx.query('select visit_record($1, $2, $3, $4, $5) as ok', [key, ip, host, path, ref])).then((r) => r.rows[0].ok);
const visits = () => db.query(`select ip, host, path, referrer_host, status from site_visits where workspace_id = $1 order by created_at`, [wsA]).then((r) => r.rows);

before(async () => {
  db = await createDatabase();
  ({ wsA, wsB } = await seedTwoWorkspaces(db));
  keyA = (await db.query('select visitor_site_key from workspaces where id = $1', [wsA])).rows[0].visitor_site_key;
});

test('VIS-01 every workspace gets its own site key; tracking is off by default', async () => {
  const rows = (await db.query('select visitor_site_key, visitor_tracking_enabled from workspaces where id in ($1, $2)', [wsA, wsB])).rows;
  assert.equal(rows.length, 2);
  assert.notEqual(rows[0].visitor_site_key, rows[1].visitor_site_key);
  for (const r of rows) { assert.match(r.visitor_site_key, /^site_[0-9a-f]{32}$/); assert.equal(r.visitor_tracking_enabled, false); }
  assert.equal(await record(keyA, '203.0.113.7'), false);
  assert.equal((await visits()).length, 0);
});

test('VIS-02 views are recorded only from the listed hosts, with the query and fragment removed', async () => {
  await db.query(`update workspaces set visitor_tracking_enabled = true, visitor_allowed_hosts = '{acme.com}' where id = $1`, [wsA]);
  assert.equal(await record(keyA, '203.0.113.7'), true);
  assert.equal(await record(keyA, '203.0.113.7', 'www.acme.com', '/'), true);
  assert.equal(await record(keyA, '203.0.113.7', 'blog.acme.com', '/post', 'blog.acme.com'), true);
  for (const host of ['evil.com', 'acme.com.evil.com', 'notacme.com', '']) assert.equal(await record(keyA, '203.0.113.7', host), false);
  const v = await visits();
  assert.deepEqual(v.map((x) => [x.host, x.path, x.referrer_host, x.status]), [
    ['acme.com', '/pricing', 'google.com', 'pending'], ['acme.com', '/', 'google.com', 'pending'], ['blog.acme.com', '/post', null, 'pending'],
  ]);
});

test('VIS-03 a wrong key, a malformed key or a malformed address records nothing', async () => {
  const before = (await visits()).length;
  for (const [k, ip] of [['site_' + '0'.repeat(32), '1.2.3.4'], ['nope', '1.2.3.4'], [keyA, 'not an ip'], [keyA, "1.2.3.4'; drop table leads"], [keyA, null]]) {
    assert.equal(await record(k, ip), false);
  }
  assert.equal((await visits()).length, before);
});

test('VIS-04 one network is limited to 60 views an hour', async () => {
  for (let i = 0; i < 57; i++) await record(keyA, '203.0.113.7', 'acme.com', `/p${i}`);
  assert.equal(await record(keyA, '203.0.113.7'), false);
  assert.equal(await record(keyA, '198.51.100.20'), true);
});

test('VIS-05 nobody but the agent service reads raw views or the lookup cache', async () => {
  for (const u of [USERS.ownerA, USERS.viewerA]) {
    await assert.rejects(asUser(db, u, (tx) => tx.query('select ip from site_visits')), /permission denied/);
    await assert.rejects(asUser(db, u, (tx) => tx.query('select * from ip_lookups')), /permission denied/);
  }
  await assert.rejects(asAnon(db, (tx) => tx.query('select * from site_visits')), /permission denied/);
  await assert.rejects(asAnon(db, (tx) => tx.query('select * from site_visitors')), /permission denied/);
  await assert.rejects(asUser(db, USERS.ownerA, (tx) => tx.query('select * from site_visits_claim(10)')), /permission denied/);
});

test('VIS-06 claims hold views for ten minutes; IPs are erased once resolved and after a day regardless', async () => {
  const claim = (n = 500) => asService(db, (tx) => tx.query('select * from site_visits_claim($1)', [n])).then((r) => r.rows);
  const first = await claim();
  assert.ok(first.length >= 4);
  assert.ok(first.every((v) => v.ip));
  assert.equal((await claim()).length, 0);
  await db.query(`update site_visits set resolved_at = now() - interval '11 minutes' where id = $1`, [first[0].id]);
  assert.deepEqual((await claim()).map((v) => v.id), [first[0].id]);
  // A resolved view loses its IP on the next claim at the latest
  await db.query(`update site_visits set status = 'identified' where id = $1`, [first[0].id]);
  await claim();
  assert.equal((await db.query('select ip from site_visits where id = $1', [first[0].id])).rows[0].ip, null);
  // A view never looked up is skipped and erased after a day
  await db.query(`update site_visits set created_at = now() - interval '25 hours' where id = $1`, [first[1].id]);
  await claim();
  assert.deepEqual((await db.query('select ip, status, skip_reason from site_visits where id = $1', [first[1].id])).rows[0],
    { ip: null, status: 'skipped', skip_reason: 'not looked up within a day' });
});

test('VIS-07 members read identified companies for their own workspace only', async () => {
  await asService(db, (tx) => tx.query(`insert into site_visitors (workspace_id, company_domain, company_name, visits) values ($1, 'bright.test', 'Bright', 3)`, [wsA]));
  assert.equal((await asUser(db, USERS.viewerA, (tx) => tx.query('select company_domain from site_visitors'))).rows.length, 1);
  assert.equal((await asUser(db, USERS.ownerB, (tx) => tx.query('select company_domain from site_visitors'))).rows.length, 0);
  await assert.rejects(asUser(db, USERS.ownerA, (tx) => tx.query(`update site_visitors set visits = 0`)), /permission denied/);
  await assert.rejects(asService(db, (tx) => tx.query(`insert into site_visitors (workspace_id, company_domain) values ($1, 'Not A Domain')`, [wsA])), /check constraint/);
});

test('VIS-08 owners and admins replace the site key; others cannot; the old key stops working', async () => {
  await assert.rejects(asUser(db, USERS.repA, (tx) => tx.query('select workspace_rotate_site_key($1)', [wsA])), /Only owners and admins/);
  const k = (await asUser(db, USERS.adminA, (tx) => tx.query('select workspace_rotate_site_key($1) as k', [wsA]))).rows[0].k;
  assert.match(k, /^site_[0-9a-f]{32}$/);
  assert.equal(await record(keyA, '192.0.2.50'), false);
  assert.equal(await record(k, '192.0.2.50'), true);
  await assert.rejects(db.query(`update workspaces set visitor_allowed_hosts = $2 where id = $1`, [wsA, Array.from({ length: 11 }, (_, i) => `h${i}.com`)]), /check constraint/);
  await assert.rejects(db.query(`update workspaces set visitor_site_key = 'guessable' where id = $1`, [wsA]), /check constraint/);
});
