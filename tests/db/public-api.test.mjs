import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { createDatabase, seedTwoWorkspaces, asUser, asAnon, asService, USERS } from './helpers.mjs';

let db, wsA, wsB, camp, readKey, writeKey, bKey, readKeyId;

const call = (key, action, args = {}) => asAnon(db, (tx) => tx.query('select api_call($1, $2, $3::jsonb) as r', [key, action, JSON.stringify(args)])).then((r) => r.rows[0].r);
const makeKey = (user, ws, name, scopes) => asUser(db, user, (tx) => tx.query('select api_key_create($1, $2, $3::text[]) as r', [ws, name, scopes])).then((r) => r.rows[0].r);
const deliveries = (ws) => db.query(`select event, payload, status from webhook_deliveries where workspace_id = $1 order by created_at, event`, [ws]).then((r) => r.rows);

before(async () => {
  db = await createDatabase();
  ({ wsA, wsB } = await seedTwoWorkspaces(db));
  camp = (await db.query(`insert into campaigns (workspace_id, name, niche) values ($1, 'Austin', 'dentists') returning id`, [wsA])).rows[0].id;
  const r = await makeKey(USERS.ownerA, wsA, 'Zapier read', ['leads:read', 'deals:read', 'campaigns:read', 'meetings:read']);
  readKey = r.key; readKeyId = r.id;
  writeKey = (await makeKey(USERS.adminA, wsA, 'Website form', ['leads:write', 'leads:read'])).key;
  bKey = (await makeKey(USERS.ownerB, wsB, 'B', ['leads:read'])).key;
});

test('API-01 a key is shown once, stored only as a hash, and only owners and admins make or see keys', async () => {
  assert.match(readKey, /^sdr_[0-9a-f]{64}$/);
  const row = (await db.query('select prefix, key_hash, scopes from api_keys where id = $1', [readKeyId])).rows[0];
  assert.equal(row.prefix, readKey.slice(0, 12));
  assert.notEqual(row.key_hash, readKey);
  assert.equal(JSON.stringify(row).includes(readKey.slice(12)), false);
  assert.deepEqual(row.scopes, ['campaigns:read', 'deals:read', 'leads:read', 'meetings:read']);
  for (const u of [USERS.repA, USERS.viewerA]) {
    await assert.rejects(makeKey(u, wsA, 'x', ['leads:read']), /Only owners and admins/);
    assert.equal((await asUser(db, u, (tx) => tx.query('select id from api_keys'))).rows.length, 0);
  }
  // Owners see the keys, never the hash
  assert.equal((await asUser(db, USERS.ownerA, (tx) => tx.query('select id, prefix from api_keys'))).rows.length, 2);
  await assert.rejects(asUser(db, USERS.ownerA, (tx) => tx.query('select key_hash from api_keys')), /permission denied/);
  await assert.rejects(asUser(db, USERS.ownerA, (tx) => tx.query(`update api_keys set scopes = '{leads:write}'`)), /permission denied/);
  await assert.rejects(makeKey(USERS.ownerA, wsA, 'x', ['admin']), /Choose at least one scope/);
  await assert.rejects(makeKey(USERS.ownerA, wsA, ' ', ['leads:read']), /name of 1 to 80/);
  await assert.rejects(makeKey(USERS.ownerB, wsA, 'x', ['leads:read']), /Only owners and admins/);
});

test('API-02 a wrong, malformed or revoked key is refused the same way', async () => {
  await assert.rejects(call('sdr_' + '0'.repeat(64), 'leads.list'), /Invalid API key/);
  await assert.rejects(call('not-a-key', 'leads.list'), /Invalid API key/);
  await assert.rejects(call(null, 'leads.list'), /Invalid API key/);
  const tmp = await makeKey(USERS.ownerA, wsA, 'Temp', ['leads:read']);
  assert.ok(await call(tmp.key, 'leads.list'));
  await asUser(db, USERS.ownerA, (tx) => tx.query('select api_key_revoke($1)', [tmp.id]));
  await assert.rejects(call(tmp.key, 'leads.list'), /Invalid API key/);
  // Another workspace's owner cannot revoke it
  await assert.rejects(asUser(db, USERS.ownerB, (tx) => tx.query('select api_key_revoke($1)', [readKeyId])), /API key not found/);
});

test('API-03 scopes are enforced per action', async () => {
  await assert.rejects(call(readKey, 'leads.create', { email: 'x@x.test' }), /does not have the leads:write scope/);
  await assert.rejects(call(writeKey, 'deals.list'), /does not have the deals:read scope/);
  await assert.rejects(call(readKey, 'workspaces.delete'), /Unknown action/);
});

test('API-04 creating a lead applies the hygiene rules', async () => {
  const r = await call(writeKey, 'leads.create', { email: ' Kim@Bright.test ', full_name: 'Kim Lee', company: 'Bright Dental', domain: 'https://www.bright.test/about', campaign_id: camp, phone: '+1 (512) 555-0100' });
  assert.equal(r.created, true);
  assert.equal(r.data.email, 'kim@bright.test');
  assert.equal(r.data.phone, '+15125550100');
  assert.equal(r.data.source, 'api');
  assert.equal(r.data.stage, 'new');
  assert.deepEqual({ name: r.data.company.name, domain: r.data.company.domain }, { name: 'Bright Dental', domain: 'bright.test' });
  // The same email again is a duplicate, returning the existing lead
  const dup = await call(writeKey, 'leads.create', { email: 'kim@bright.test' });
  assert.deepEqual([dup.created, dup.reason, dup.data.id], [false, 'duplicate', r.data.id]);
  // A suppressed domain is not added
  await db.query(`insert into suppressions (workspace_id, kind, value, reason) values ($1, 'domain', 'blocked.test', 'competitor')`, [wsA]);
  assert.deepEqual(await call(writeKey, 'leads.create', { email: 'a@blocked.test' }), { created: false, reason: 'suppressed' });
  for (const [args, msg] of [
    [{ full_name: 'No way to reach' }, /needs an email, a phone or a linkedin_url/],
    [{ email: 'not an email' }, /email is not a valid address/],
    [{ phone: '12' }, /phone must have 7 to 15 digits/],
    [{ linkedin_url: 'https://evil.test/in/x' }, /linkedin.com address/],
    [{ email: 'a@x.test', campaign_id: 'abc' }, /campaign_id must be an id/],
    [{ email: 'a@x.test', domain: 'bad domain' }, /domain is not a valid domain/],
  ]) await assert.rejects(call(writeKey, 'leads.create', args), msg);
  // Another workspace's campaign cannot be used
  const campB = (await db.query(`insert into campaigns (workspace_id, name) values ($1, 'B') returning id`, [wsB])).rows[0].id;
  await assert.rejects(call(writeKey, 'leads.create', { email: 'c@x.test', campaign_id: campB }), /not a campaign in this workspace/);
});

test('API-05 listing is per workspace, filtered and paged with a cursor', async () => {
  for (let i = 0; i < 4; i++) await call(writeKey, 'leads.create', { email: `p${i}@page.test` });
  const first = await call(readKey, 'leads.list', { limit: 2 });
  assert.equal(first.data.length, 2);
  assert.ok(first.next_cursor);
  const second = await call(readKey, 'leads.list', { limit: 2, cursor: first.next_cursor });
  assert.equal(second.data.length, 2);
  assert.equal(new Set([...first.data, ...second.data].map((l) => l.id)).size, 4);
  const all = await call(readKey, 'leads.list', { limit: 100 });
  assert.equal(all.next_cursor, null);
  assert.equal(all.data.length, 5);
  assert.equal((await call(readKey, 'leads.list', { campaign_id: camp })).data.length, 1);
  assert.equal((await call(readKey, 'leads.list', { stage: 'won' })).data.length, 0);
  // Workspace B's key sees none of A's leads, and cannot read one by id
  assert.equal((await call(bKey, 'leads.list')).data.length, 0);
  await assert.rejects(call(bKey, 'leads.get', { id: all.data[0].id }), /Not found/);
  await assert.rejects(call(readKey, 'leads.list', { cursor: "x'; drop table leads; --" }), /cursor is not valid/);
  await assert.rejects(call(readKey, 'leads.list', { updated_after: 'yesterday' }), /ISO 8601/);
  assert.equal((await call(readKey, 'leads.list', { limit: 5000 })).data.length, 5);
});

test('API-06 updating a stage records it, and a do-not-contact lead is not reopened', async () => {
  const kim = (await call(readKey, 'leads.list', { limit: 100 })).data.find((l) => l.email === 'kim@bright.test');
  const r = await call(writeKey, 'leads.update', { id: kim.id, stage: 'interested' });
  assert.equal(r.data.stage, 'interested');
  assert.match((await db.query(`select summary from activities where lead_id = $1 order by created_at desc limit 1`, [kim.id])).rows[0].summary, /through the API \(Website form\)/);
  await assert.rejects(call(writeKey, 'leads.update', { id: kim.id, stage: 'vip' }), /stage must be one of/);
  await call(writeKey, 'leads.update', { id: kim.id, stage: 'do_not_contact' });
  assert.equal((await db.query(`select count(*)::int n from suppressions where workspace_id = $1 and value = 'kim@bright.test'`, [wsA])).rows[0].n, 1);
  await assert.rejects(call(writeKey, 'leads.update', { id: kim.id, stage: 'new' }), /asked not to be contacted/);
});

test('API-07 deals, campaigns and meetings can be listed', async () => {
  const lead = (await db.query(`select id from leads where workspace_id = $1 limit 1`, [wsA])).rows[0].id;
  await db.query(`insert into deals (workspace_id, lead_id, campaign_id, stage, value_cents) values ($1, $2, $3, 'won', 99900)`, [wsA, lead, camp]);
  await db.query(`insert into meetings (workspace_id, lead_id, starts_at, booked_via) values ($1, $2, now() + interval '1 day', 'email')`, [wsA, lead]);
  const deals = await call(readKey, 'deals.list');
  assert.deepEqual([deals.data.length, deals.data[0].stage, deals.data[0].value_cents], [1, 'won', 99900]);
  assert.deepEqual((await call(readKey, 'campaigns.list')).data.map((c) => c.name), ['Austin']);
  assert.equal((await call(readKey, 'meetings.list')).data[0].booked_via, 'email');
});

test('API-08 each key is limited to 120 requests a minute', async () => {
  const k = (await makeKey(USERS.ownerA, wsA, 'Busy', ['campaigns:read'])).key;
  for (let i = 0; i < 120; i++) await call(k, 'campaigns.list');
  await assert.rejects(call(k, 'campaigns.list'), /Rate limit reached/);
  // Other keys are unaffected
  assert.ok(await call(readKey, 'campaigns.list'));
  // A new minute starts again
  await db.query(`update api_keys set window_start = now() - interval '2 minutes' where prefix = $1`, [k.slice(0, 12)]);
  assert.ok(await call(k, 'campaigns.list'));
});

test('API-09 visitors cannot reach keys, endpoints, deliveries or the key and secret functions', async () => {
  for (const t of ['api_keys', 'webhook_endpoints', 'webhook_deliveries']) {
    await assert.rejects(asAnon(db, (tx) => tx.query(`select * from ${t}`)), /permission denied/);
  }
  await assert.rejects(asAnon(db, (tx) => tx.query(`select api_key_create($1, 'x', '{leads:read}')`, [wsA])), /permission denied/);
  await assert.rejects(asAnon(db, (tx) => tx.query(`select webhook_deliveries_claim(10)`)), /permission denied/);
  await assert.rejects(asUser(db, USERS.ownerA, (tx) => tx.query(`select webhook_deliveries_claim(10)`)), /permission denied/);
});

// ---------------------------------------------------------------- webhooks

let ep;

test('WH-01 owners and admins register endpoints; the secret is never a readable column', async () => {
  ep = (await asUser(db, USERS.adminA, (tx) => tx.query(
    `insert into webhook_endpoints (workspace_id, url, events) values ($1, 'https://hooks.example.com/sdr', '{lead.stage_changed,deal.won,meeting.booked,reply.received}') returning id`, [wsA]))).rows[0].id;
  await assert.rejects(asUser(db, USERS.repA, (tx) => tx.query(
    `insert into webhook_endpoints (workspace_id, url, events) values ($1, 'https://x.example.com', '{deal.won}')`, [wsA])), /row-level security/);
  await assert.rejects(asUser(db, USERS.ownerA, (tx) => tx.query('select secret from webhook_endpoints')), /permission denied/);
  await assert.rejects(asUser(db, USERS.ownerA, (tx) => tx.query(`update webhook_endpoints set secret = 'whsec_x'`)), /permission denied/);
  const secret = (await asUser(db, USERS.ownerA, (tx) => tx.query('select webhook_endpoint_secret($1) as s', [ep]))).rows[0].s;
  assert.match(secret, /^whsec_[0-9a-f]{64}$/);
  const rotated = (await asUser(db, USERS.ownerA, (tx) => tx.query('select webhook_endpoint_secret($1, true) as s', [ep]))).rows[0].s;
  assert.notEqual(rotated, secret);
  await assert.rejects(asUser(db, USERS.repA, (tx) => tx.query('select webhook_endpoint_secret($1) as s', [ep])), /not found/);
  await assert.rejects(asUser(db, USERS.ownerB, (tx) => tx.query('select webhook_endpoint_secret($1) as s', [ep])), /not found/);
  assert.equal((await asUser(db, USERS.viewerA, (tx) => tx.query('select id from webhook_endpoints'))).rows.length, 0);
});

test('WH-02 only https addresses on the standard port, known events, and at most 10 endpoints', async () => {
  const add = (url, events = '{deal.won}', ws = wsB) => asUser(db, USERS.ownerB, (tx) => tx.query(`insert into webhook_endpoints (workspace_id, url, events) values ($1, $2, $3)`, [ws, url, events]));
  for (const bad of ['http://x.example.com', 'https://x.example.com:8443/hook', 'ftp://x', 'https://x.example.com/a b', `https://x.example.com/${'a'.repeat(500)}`]) {
    await assert.rejects(add(bad), /check constraint/);
  }
  await assert.rejects(add('https://x.example.com', '{lead.deleted}'), /check constraint/);
  await assert.rejects(add('https://x.example.com', '{}'), /check constraint/);
  for (let i = 0; i < 10; i++) await add(`https://h${i}.example.com/x`);
  await assert.rejects(add('https://h10.example.com/x'), /at most 10 webhook endpoints/);
  await db.query('delete from webhook_endpoints where workspace_id = $1', [wsB]);
});

test('WH-03 events are queued once per subscribed endpoint, with the same event id', async () => {
  await db.query('delete from webhook_deliveries');
  const ep2 = (await asUser(db, USERS.ownerA, (tx) => tx.query(
    `insert into webhook_endpoints (workspace_id, url, events) values ($1, 'https://two.example.com/x', '{lead.created,lead.stage_changed}') returning id`, [wsA]))).rows[0].id;
  // lead.created goes only to the second endpoint
  const r = await call(writeKey, 'leads.create', { email: 'new@events.test', full_name: 'Eve' });
  let d = await deliveries(wsA);
  assert.deepEqual(d.map((x) => x.event), ['lead.created']);
  assert.equal(d[0].payload.data.email, 'new@events.test');
  assert.equal(d[0].payload.type, 'lead.created');
  // A stage change goes to both, carrying the previous stage, under one event id
  await db.query(`update leads set stage = 'engaged' where id = $1`, [r.data.id]);
  d = (await deliveries(wsA)).filter((x) => x.event === 'lead.stage_changed');
  assert.equal(d.length, 2);
  assert.equal(d[0].payload.id, d[1].payload.id);
  assert.equal(d[0].payload.data.previous_stage, 'new');
  // Updating something else is not an event
  await db.query(`update leads set title = 'CEO' where id = $1`, [r.data.id]);
  assert.equal((await deliveries(wsA)).filter((x) => x.event === 'lead.stage_changed').length, 2);
  // A reply, a meeting, a won deal and a lost deal
  await db.query(`insert into replies (workspace_id, lead_id, channel, body) values ($1, $2, 'email', 'Sounds good')`, [wsA, r.data.id]);
  await db.query(`insert into meetings (workspace_id, lead_id, starts_at, booked_via) values ($1, $2, now() + interval '2 days', 'call')`, [wsA, r.data.id]);
  const deal = (await db.query(`insert into deals (workspace_id, lead_id, stage) values ($1, $2, 'negotiation') returning id`, [wsA, r.data.id])).rows[0].id;
  await db.query(`update deals set stage = 'won', value_cents = 5000 where id = $1`, [deal]);
  const events = (await deliveries(wsA)).map((x) => x.event);
  assert.deepEqual(events.filter((e) => ['reply.received', 'meeting.booked', 'deal.won'].includes(e)).sort(), ['deal.won', 'meeting.booked', 'reply.received']);
  // A switched-off endpoint gets nothing new
  await asUser(db, USERS.ownerA, (tx) => tx.query(`update webhook_endpoints set active = false where id = $1`, [ep2]));
  const before = (await deliveries(wsA)).length;
  await db.query(`update leads set stage = 'interested' where id = $1`, [r.data.id]);
  assert.equal((await deliveries(wsA)).length, before + 1);
  // Workspace B has no endpoints: its changes queue nothing
  await db.query(`insert into leads (workspace_id, email, source_channel) values ($1, 'b@b.test', 'manual')`, [wsB]);
  assert.equal((await deliveries(wsB)).length, 0);
});

test('WH-04 deliveries are claimed once, retried on a schedule, and dead after six attempts', async () => {
  await db.query('delete from webhook_deliveries');
  await asUser(db, USERS.ownerA, (tx) => tx.query('select webhook_send_test($1)', [ep]));
  const claim = async () => (await asService(db, (tx) => tx.query('select * from webhook_deliveries_claim(10)'))).rows;
  const c1 = await claim();
  assert.equal(c1.length, 1);
  assert.match(c1[0].secret, /^whsec_/);
  assert.equal(c1[0].attempts, 1);
  assert.equal((await claim()).length, 0);
  const fail = () => asService(db, (tx) => tx.query(`select webhook_delivery_result($1, false, 500, 'HTTP 500')`, [c1[0].id]));
  await fail();
  let row = (await db.query('select status, next_attempt_at - now() as wait from webhook_deliveries where id = $1', [c1[0].id])).rows[0];
  assert.equal(row.status, 'pending');
  // Due again only after the wait
  assert.equal((await claim()).length, 0);
  for (let attempt = 2; attempt <= 6; attempt++) {
    await db.query(`update webhook_deliveries set next_attempt_at = now() - interval '1 second' where id = $1`, [c1[0].id]);
    assert.equal((await claim())[0].attempts, attempt);
    await fail();
  }
  row = (await db.query('select status, attempts, last_error from webhook_deliveries where id = $1', [c1[0].id])).rows[0];
  assert.deepEqual(row, { status: 'dead', attempts: 6, last_error: 'HTTP 500' });
  // A stuck "sending" delivery is claimed again after ten minutes
  await asUser(db, USERS.ownerA, (tx) => tx.query('select webhook_send_test($1)', [ep]));
  const c2 = await claim();
  await db.query(`update webhook_deliveries set next_attempt_at = now() - interval '11 minutes' where id = $1`, [c2[0].id]);
  assert.equal((await claim())[0].id, c2[0].id);
  await asService(db, (tx) => tx.query(`select webhook_delivery_result($1, true, 200, null)`, [c2[0].id]));
  assert.equal((await db.query('select status from webhook_deliveries where id = $1', [c2[0].id])).rows[0].status, 'delivered');
  assert.equal((await db.query('select consecutive_failures from webhook_endpoints where id = $1', [ep])).rows[0].consecutive_failures, 0);
});

test('WH-05 fifteen failures in a row switch the endpoint off; switching it back on clears the count', async () => {
  await db.query(`update webhook_endpoints set consecutive_failures = 14 where id = $1`, [ep]);
  await asUser(db, USERS.ownerA, (tx) => tx.query('select webhook_send_test($1)', [ep]));
  const c = (await asService(db, (tx) => tx.query('select * from webhook_deliveries_claim(10)'))).rows[0];
  const off = (await asService(db, (tx) => tx.query(`select webhook_delivery_result($1, false, null, 'Could not connect') as r`, [c.id]))).rows[0].r;
  assert.equal(off, true);
  const e = (await db.query('select active, disabled_reason from webhook_endpoints where id = $1', [ep])).rows[0];
  assert.equal(e.active, false);
  assert.match(e.disabled_reason, /15 failed deliveries in a row. Last error: Could not connect/);
  // Nothing is claimed for a switched-off endpoint
  await db.query(`update webhook_deliveries set next_attempt_at = now() - interval '1 hour' where id = $1`, [c.id]);
  assert.equal((await asService(db, (tx) => tx.query('select * from webhook_deliveries_claim(10)'))).rows.length, 0);
  await asUser(db, USERS.ownerA, (tx) => tx.query(`update webhook_endpoints set active = true where id = $1`, [ep]));
  assert.deepEqual((await db.query('select consecutive_failures, disabled_reason from webhook_endpoints where id = $1', [ep])).rows[0], { consecutive_failures: 0, disabled_reason: null });
});

test('WH-06 the delivery history is readable by owners and admins only, and deliveries go with their endpoint', async () => {
  assert.ok((await asUser(db, USERS.ownerA, (tx) => tx.query('select id from webhook_deliveries'))).rows.length > 0);
  assert.equal((await asUser(db, USERS.repA, (tx) => tx.query('select id from webhook_deliveries'))).rows.length, 0);
  await assert.rejects(asUser(db, USERS.ownerA, (tx) => tx.query(`update webhook_deliveries set status = 'delivered'`)), /permission denied/);
  await asUser(db, USERS.ownerA, (tx) => tx.query('delete from webhook_endpoints where id = $1', [ep]));
  assert.equal((await db.query('select count(*)::int n from webhook_deliveries where endpoint_id = $1', [ep])).rows[0].n, 0);
});
