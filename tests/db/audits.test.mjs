import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { createDatabase, seedTwoWorkspaces, asUser, asAnon, asService, USERS, insertLead } from './helpers.mjs';

let db, wsA, camp, lead;
const TOKEN = 'a1'.repeat(24);

before(async () => {
  db = await createDatabase();
  ({ wsA } = await seedTwoWorkspaces(db));
  camp = (await db.query(`insert into campaigns (workspace_id, name, niche, status, sender_name) values ($1, 'C', 'dentists', 'active', 'Sam') returning id`, [wsA])).rows[0].id;
  lead = await asService(db, (tx) => insertLead(tx, wsA, { email: 'kim@bright.com', full_name: 'Kim Bright', phone: '+15125550101' }));
  await db.query(`update leads set stage = 'contacted' where id = $1`, [lead]);
});

const audit = (over = {}) => asService(db, (tx) => tx.query(
  `insert into assets (workspace_id, lead_id, campaign_id, type, status, title, score, content, share_token, web_url, expires_at)
   values ($1,$2,$3,'audit',$4,'Website audit for Bright Teeth',62,'{"summary":"Good start"}',$5,$6, now() + make_interval(days => $7)) returning id`,
  [wsA, over.lead ?? lead, over.campaign ?? camp, over.status ?? 'ready', over.token ?? TOKEN, 'https://app.example.com/a/' + (over.token ?? TOKEN), over.days ?? 120]));

test('AU-01 audits are off by default; one audit per lead per campaign; links and tokens are validated', async () => {
  assert.equal((await db.query('select audit_enabled from campaigns where id = $1', [camp])).rows[0].audit_enabled, false);
  await audit();
  await assert.rejects(audit({ token: 'b2'.repeat(24) }), /duplicate key/);
  for (const sql of [
    `update assets set share_token = 'short' where share_token = $1`,
    `update assets set status = 'maybe' where share_token = $1`,
    `update assets set web_url = 'javascript:alert(1)' where share_token = $1`,
    `update assets set score = 101 where share_token = $1`,
  ]) await assert.rejects(db.query(sql, [TOKEN]), /check constraint/);
});

test('AU-02 shared audits are the platform\'s; people can attach their own audit or proposal link', async () => {
  await assert.rejects(asUser(db, USERS.ownerA, (tx) => tx.query(`insert into assets (workspace_id, lead_id, type, share_token) values ($1,$2,'audit',$3)`, [wsA, lead, 'f6'.repeat(24)])), /created by the platform/);
  await assert.rejects(asUser(db, USERS.adminA, (tx) => tx.query(`update assets set score = 99 where share_token = $1`, [TOKEN])), /created by the platform/);
  const own = await asService(db, (tx) => insertLead(tx, wsA, { email: 'own@bright.com' }));
  await asUser(db, USERS.repA, (tx) => tx.query(`insert into assets (workspace_id, lead_id, type, web_url) values ($1,$2,'audit','https://docs.example/audit')`, [wsA, own]));
  await assert.rejects(asUser(db, USERS.repA, (tx) => tx.query(`update assets set share_token = $2 where lead_id = $1`, [own, 'f7'.repeat(24)])), /created by the platform/);
  await asUser(db, USERS.repA, (tx) => tx.query(`insert into assets (workspace_id, lead_id, type, web_url) values ($1,$2,'proposal','https://x.example/p')`, [wsA, lead]));
});

test('AU-03 the shared page shows the audit and whose it is, never contact details; bad or expired links show nothing', async () => {
  const r = await asAnon(db, async (tx) => (await tx.query('select audit_public($1) as a', [TOKEN])).rows[0].a);
  assert.deepEqual(Object.keys(r).sort(), ['company', 'content', 'created_at', 'first_name', 'from_company', 'score', 'sender_name', 'title']);
  assert.equal(r.first_name, 'Kim');
  assert.equal(r.score, 62);
  assert.equal(r.sender_name, 'Sam');
  assert.doesNotMatch(JSON.stringify(r), /kim@bright\.com|\+15125550101/);
  for (const t of ['c3'.repeat(24), "' or 1=1 --", '']) {
    assert.equal(await asAnon(db, async (tx) => (await tx.query('select audit_public($1) as a', [t])).rows[0].a), null);
  }
  const other = await asService(db, (tx) => insertLead(tx, wsA, { email: 'old@bright.com' }));
  await audit({ lead: other, token: 'd4'.repeat(24), days: -1 });
  assert.equal(await asAnon(db, async (tx) => (await tx.query('select audit_public($1) as a', ['d4'.repeat(24)])).rows[0].a), null);
  await assert.rejects(asAnon(db, (tx) => tx.query('select * from assets')), /permission denied/);
});

test('AU-04 opening the audit is counted once on the timeline, moves the lead forward and queues the team alert', async () => {
  await db.query('delete from agent_jobs');
  await asAnon(db, (tx) => tx.query('select audit_view($1, 0)', [TOKEN]));
  await asAnon(db, (tx) => tx.query('select audit_view($1, 0)', [TOKEN]));
  await asAnon(db, (tx) => tx.query('select audit_view($1, 5000)', [TOKEN]));
  await asAnon(db, (tx) => tx.query('select audit_view($1, 45)', [TOKEN]));
  await asAnon(db, (tx) => tx.query('select audit_view($1, 0)', ['e5'.repeat(24)]));
  await asAnon(db, (tx) => tx.query('select audit_view($1, -9)', [TOKEN]));
  const a = (await db.query('select views, seconds_viewed, first_viewed_at is not null as seen from assets where share_token = $1', [TOKEN])).rows[0];
  assert.deepEqual(a, { views: 2, seconds_viewed: 645, seen: true });
  assert.equal((await db.query(`select count(*)::int n from activities where lead_id = $1 and type = 'asset_view'`, [lead])).rows[0].n, 1);
  assert.equal((await db.query('select stage from leads where id = $1', [lead])).rows[0].stage, 'engaged');
  assert.equal((await db.query(`select count(*)::int n from agent_jobs where type = 'audit_reports' and campaign_id = $1`, [camp])).rows[0].n, 1);
  await asAnon(db, (tx) => tx.query('select audit_view($1, 0)', ['d4'.repeat(24)]));
  assert.equal((await db.query('select views from assets where share_token = $1', ['d4'.repeat(24)])).rows[0].views, 0, 'expired audits are not counted');
});
