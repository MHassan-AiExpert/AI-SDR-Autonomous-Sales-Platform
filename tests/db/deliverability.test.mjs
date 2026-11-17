import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { createDatabase, seedTwoWorkspaces, asUser, asAnon, asService, USERS } from './helpers.mjs';

let db, wsA, wsB, dom;

const addDomain = (ws, domain, over = {}) => asService(db, (tx) => tx.query(
  `insert into sending_domains (workspace_id, domain, spf_status, score, issues) values ($1, $2, $3, $4, $5::jsonb) returning id`,
  [ws, domain, over.spf ?? 'pass', over.score ?? 100, JSON.stringify(over.issues ?? [])]));
const addBox = (ws, email, over = {}) => asService(db, (tx) => tx.query(
  `insert into mailboxes (workspace_id, email, domain, status) values ($1, $2, $3, $4) returning id`, [ws, email, email.split('@')[1], over.status ?? 'active']));
let k = 0;
const event = (ws, type, account) => db.query(
  `insert into inbound_events (workspace_id, provider, event_type, lead_email, payload, dedupe_key) values ($1, 'instantly', $2, 'l@x.com', $3::jsonb, $4)`,
  [ws, type, JSON.stringify(account ? { email_account: account } : {}), `dlb-${k++}`]);

before(async () => {
  db = await createDatabase();
  ({ wsA, wsB } = await seedTwoWorkspaces(db));
  dom = (await addDomain(wsA, 'acme.com')).rows[0].id;
  await addBox(wsA, 'sam@acme.com');
  await addDomain(wsB, 'other.io');
  await addBox(wsB, 'bo@other.io');
});

test('DLB-01 members read domains and mailboxes; only their own workspace', async () => {
  for (const u of [USERS.viewerA, USERS.repA, USERS.ownerA]) {
    const r = await asUser(db, u, (tx) => tx.query('select domain from sending_domains'));
    assert.deepEqual(r.rows.map((x) => x.domain), ['acme.com']);
    assert.deepEqual((await asUser(db, u, (tx) => tx.query('select email from mailboxes'))).rows.map((x) => x.email), ['sam@acme.com']);
  }
  assert.deepEqual((await asUser(db, USERS.ownerB, (tx) => tx.query('select domain from sending_domains'))).rows.map((x) => x.domain), ['other.io']);
});

test('DLB-02 owners and admins set the DKIM selector; nobody else changes anything', async () => {
  await asUser(db, USERS.ownerA, (tx) => tx.query(`update sending_domains set dkim_selector = 'mx2026' where id = $1`, [dom]));
  assert.equal((await db.query('select dkim_selector from sending_domains where id = $1', [dom])).rows[0].dkim_selector, 'mx2026');
  // A rep's or viewer's update touches nothing
  for (const u of [USERS.repA, USERS.viewerA]) await asUser(db, u, (tx) => tx.query(`update sending_domains set dkim_selector = 'rep' where id = $1`, [dom]));
  assert.equal((await db.query('select dkim_selector from sending_domains where id = $1', [dom])).rows[0].dkim_selector, 'mx2026');
  // Another workspace's owner changes nothing
  await asUser(db, USERS.ownerB, (tx) => tx.query(`update sending_domains set dkim_selector = 'b'`));
  assert.equal((await db.query('select dkim_selector from sending_domains where id = $1', [dom])).rows[0].dkim_selector, 'mx2026');
  // The results themselves cannot be rewritten, added or removed by a person
  await assert.rejects(asUser(db, USERS.ownerA, (tx) => tx.query(`update sending_domains set score = 100, spf_status = 'pass' where id = $1`, [dom])), /permission denied/);
  await assert.rejects(asUser(db, USERS.ownerA, (tx) => tx.query(`insert into sending_domains (workspace_id, domain) values ($1, 'fake.com')`, [wsA])), /permission denied/);
  await assert.rejects(asUser(db, USERS.ownerA, (tx) => tx.query('delete from sending_domains where id = $1', [dom])), /permission denied/);
  await assert.rejects(asUser(db, USERS.ownerA, (tx) => tx.query(`update mailboxes set status = 'active'`)), /permission denied/);
  await assert.rejects(asUser(db, USERS.ownerA, (tx) => tx.query(`insert into mailboxes (workspace_id, email, domain) values ($1, 'x@acme.com', 'acme.com')`, [wsA])), /permission denied/);
});

test('DLB-03 a selector, a domain and an address must be well formed', async () => {
  await assert.rejects(asUser(db, USERS.ownerA, (tx) => tx.query(`update sending_domains set dkim_selector = 'bad selector; drop' where id = $1`, [dom])), /check constraint/);
  await assert.rejects(addDomain(wsA, 'Not A Domain'), /check constraint/);
  await assert.rejects(addDomain(wsA, 'ACME.com'), /check constraint/);
  await assert.rejects(addDomain(wsA, 'acme.com'), /duplicate key/);
  await assert.rejects(addBox(wsA, 'Kim@Acme.com'), /check constraint/);
  await assert.rejects(addBox(wsA, 'sam@acme.com'), /duplicate key/);
  await assert.rejects(addBox(wsA, 'x@acme.com', { status: 'great' }), /check constraint/);
  await assert.rejects(asService(db, (tx) => tx.query(`update sending_domains set score = 101 where id = $1`, [dom])), /check constraint/);
  await assert.rejects(asService(db, (tx) => tx.query(`update sending_domains set issues = '{}'::jsonb where id = $1`, [dom])), /check constraint/);
});

test('DLB-04 every member sees per-mailbox counts for their own workspace only', async () => {
  await event(wsA, 'email_sent', 'Sam@acme.com');
  await event(wsA, 'email_sent', 'sam@acme.com');
  await event(wsA, 'email_bounced', 'sam@acme.com');
  await event(wsA, 'lead_unsubscribed', 'sam@acme.com');
  await event(wsA, 'email_opened', 'sam@acme.com');
  await event(wsA, 'email_sent', null);
  await event(wsB, 'email_sent', 'bo@other.io');
  const r = (await asUser(db, USERS.viewerA, (tx) => tx.query('select * from mailbox_stats($1, 30)', [wsA]))).rows
    .map((x) => [x.email_account, Number(x.sent), Number(x.bounced), Number(x.replied), Number(x.unsubscribed)]);
  assert.deepEqual(r, [['sam@acme.com', 2, 1, 0, 1], ['', 1, 0, 0, 0]]);
  // Reps and viewers cannot read the raw events, but do see the counts
  assert.equal((await asUser(db, USERS.viewerA, (tx) => tx.query('select id from inbound_events'))).rows.length, 0);
  assert.equal((await asUser(db, USERS.repA, (tx) => tx.query('select * from mailbox_stats($1, 30)', [wsA]))).rows.length, 2);
  // Asking about another workspace returns nothing: membership is checked first
  assert.deepEqual((await asUser(db, USERS.ownerA, (tx) => tx.query('select * from mailbox_stats($1, 30)', [wsB]))).rows, []);
});

test('DLB-05 visitors read nothing and cannot call the statistics', async () => {
  await assert.rejects(asAnon(db, (tx) => tx.query('select * from sending_domains')), /permission denied/);
  await assert.rejects(asAnon(db, (tx) => tx.query('select * from mailboxes')), /permission denied/);
  await assert.rejects(asAnon(db, (tx) => tx.query('select * from mailbox_stats($1, 30)', [wsA])), /permission denied/);
});

test('DLB-06 an owner can ask for a check now; a viewer cannot', async () => {
  await db.query('update workspaces set deliverability_checked_at = now() where id = $1', [wsA]);
  await asUser(db, USERS.viewerA, (tx) => tx.query('update workspaces set deliverability_checked_at = null where id = $1', [wsA]));
  assert.notEqual((await db.query('select deliverability_checked_at from workspaces where id = $1', [wsA])).rows[0].deliverability_checked_at, null);
  await asUser(db, USERS.ownerA, (tx) => tx.query('update workspaces set deliverability_checked_at = null where id = $1', [wsA]));
  assert.equal((await db.query('select deliverability_checked_at from workspaces where id = $1', [wsA])).rows[0].deliverability_checked_at, null);
});

test('DLB-07 deleting a workspace removes its domains and mailboxes', async () => {
  await db.query('delete from workspaces where id = $1', [wsB]);
  assert.equal((await db.query('select count(*)::int n from sending_domains where workspace_id = $1', [wsB])).rows[0].n, 0);
  assert.equal((await db.query('select count(*)::int n from mailboxes where workspace_id = $1', [wsB])).rows[0].n, 0);
});
