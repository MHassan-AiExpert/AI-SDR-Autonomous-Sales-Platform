import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { createDatabase, seedTwoWorkspaces, asUser, asService, USERS, insertLead } from './helpers.mjs';

let db, wsA, wsB, lead;

before(async () => {
  db = await createDatabase();
  ({ wsA, wsB } = await seedTwoWorkspaces(db));
  lead = await asService(db, (tx) => insertLead(tx, wsA, { email: 'kim@bright.com' }));
});

test('REP-01 every workspace gets its own long random webhook token', async () => {
  const { rows } = await db.query('select webhook_token from workspaces where id in ($1, $2)', [wsA, wsB]);
  assert.equal(rows.length, 2);
  for (const r of rows) assert.match(r.webhook_token, /^[0-9a-f]{64}$/);
  assert.notEqual(rows[0].webhook_token, rows[1].webhook_token);
});

test('REP-02 owners and admins can rotate the token; reps and other companies cannot', async () => {
  const before = (await db.query('select webhook_token from workspaces where id = $1', [wsA])).rows[0].webhook_token;
  const fresh = (await asUser(db, USERS.adminA, (tx) => tx.query('select workspace_rotate_webhook_token($1) as t', [wsA]))).rows[0].t;
  assert.notEqual(fresh, before);
  assert.equal((await db.query('select webhook_token from workspaces where id = $1', [wsA])).rows[0].webhook_token, fresh);
  for (const user of [USERS.repA, USERS.ownerB]) {
    await assert.rejects(asUser(db, user, (tx) => tx.query('select workspace_rotate_webhook_token($1)', [wsA])), /Only owners and admins/);
  }
});

test('REP-03 the same event is stored once', async () => {
  const ins = () => db.query(`insert into inbound_events (workspace_id, provider, event_type, dedupe_key) values ($1, 'instantly', 'reply_received', 'k1')`, [wsA]);
  await ins();
  await assert.rejects(ins(), /duplicate key/);
});

test('REP-04 only owners and admins can read raw events, and no client can write them', async () => {
  const admin = await asUser(db, USERS.adminA, (tx) => tx.query('select count(*)::int n from inbound_events'));
  assert.equal(admin.rows[0].n, 1);
  const rep = await asUser(db, USERS.repA, (tx) => tx.query('select count(*)::int n from inbound_events'));
  assert.equal(rep.rows[0].n, 0);
  const other = await asUser(db, USERS.ownerB, (tx) => tx.query('select count(*)::int n from inbound_events'));
  assert.equal(other.rows[0].n, 0);
  await assert.rejects(asUser(db, USERS.ownerA, (tx) => tx.query(`insert into inbound_events (workspace_id, provider, event_type, dedupe_key) values ($1, 'instantly', 'x', 'k2')`, [wsA])), /permission denied/);
});

test('REP-05 a conversation link must point to Instantly; Slack channels are checked', async () => {
  await assert.rejects(db.query(`insert into replies (workspace_id, lead_id, channel, body, conversation_url) values ($1, $2, 'email', 'hi', 'https://evil.example/instantly.ai/')`, [wsA, lead]), /check constraint/);
  await db.query(`insert into replies (workspace_id, lead_id, channel, body, conversation_url) values ($1, $2, 'email', 'hi', 'https://app.instantly.ai/app/unibox?x=1')`, [wsA, lead]);
  await db.query(`update workspaces set slack_channel = '#sales-alerts' where id = $1`, [wsA]);
  await db.query(`update workspaces set slack_channel = 'C0123ABCD45' where id = $1`, [wsA]);
  await assert.rejects(db.query(`update workspaces set slack_channel = 'sales alerts!' where id = $1`, [wsA]), /check constraint/);
});

test('REP-06 reps can mark replies as handled; emails can be cancelled by the backend', async () => {
  const id = (await db.query(`insert into replies (workspace_id, lead_id, channel, body) values ($1, $2, 'email', 'Sounds good') returning id`, [wsA, lead])).rows[0].id;
  const r = await asUser(db, USERS.repA, (tx) => tx.query(`update replies set handled_at = now(), handled_by = 'human' where id = $1`, [id]));
  assert.equal(r.affectedRows, 1);
  const e = (await db.query(`insert into emails (workspace_id, lead_id, subject, body, status, idempotency_key) values ($1,$2,'s','b','queued','q1') returning id`, [wsA, lead])).rows[0].id;
  await asService(db, (tx) => tx.query(`update emails set status = 'cancelled' where id = $1`, [e]));
  assert.equal((await db.query('select status from emails where id = $1', [e])).rows[0].status, 'cancelled');
});
