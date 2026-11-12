import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { createDatabase, seedTwoWorkspaces, asUser, asService, USERS, insertLead } from './helpers.mjs';

let db, wsA, wsB, camp, lead;

before(async () => {
  db = await createDatabase();
  ({ wsA, wsB } = await seedTwoWorkspaces(db));
  camp = (await db.query(`insert into campaigns (workspace_id, name, niche, status) values ($1, 'C', 'dentists', 'active') returning id`, [wsA])).rows[0].id;
  lead = await asService(db, (tx) => insertLead(tx, wsA, { email: 'kim@bright.com' }));
});

const email = async (step = 1, status = 'draft') =>
  (await db.query(`insert into emails (workspace_id, lead_id, campaign_id, step, subject, body, status, idempotency_key) values ($1,$2,$3,$4,'Hi','Body',$5,$6) returning id`,
    [wsA, lead, camp, step, status, `${camp}:${lead}:${step}:${Math.random()}`])).rows[0].id;
const row = async (id) => (await db.query('select * from emails where id = $1', [id])).rows[0];
const jobs = async (c, type = 'email_outreach') => (await db.query(`select status from agent_jobs where campaign_id = $1 and type = $2`, [c, type])).rows;

test('OUT-01 a rep approves and edits a draft; the approver is recorded', async () => {
  const id = await email();
  await asUser(db, USERS.repA, (tx) => tx.query(`update emails set subject = 'Quick idea for Bright', status = 'approved' where id = $1`, [id]));
  const r = await row(id);
  assert.equal(r.subject, 'Quick idea for Bright');
  assert.equal(r.approved_by, USERS.repA);
  assert.ok(r.approved_at);
  await asUser(db, USERS.repA, (tx) => tx.query(`update emails set status = 'rejected' where id = $1`, [id]));
  const rejected = await row(id);
  assert.equal(rejected.approved_by, null);
});

test('OUT-02 people cannot move an email into sending states or edit one already handed over', async () => {
  const id = await email();
  await assert.rejects(asUser(db, USERS.ownerA, (tx) => tx.query(`update emails set status = 'queued' where id = $1`, [id])), /Only the outreach agent/);
  await assert.rejects(asUser(db, USERS.ownerA, (tx) => tx.query(`update emails set status = 'sent' where id = $1`, [id])), /Only the outreach agent/);
  const queued = await email(2, 'queued');
  await assert.rejects(asUser(db, USERS.ownerA, (tx) => tx.query(`update emails set body = 'changed' where id = $1`, [queued])), /already with the sending service/);
});

test('OUT-03 only subject, body and approval can be changed, and never emptied', async () => {
  const id = await email();
  for (const sql of [
    `update emails set step = 9 where id = $1`,
    `update emails set provider_id = 'x' where id = $1`,
    `update emails set idempotency_key = 'other' where id = $1`,
  ]) {
    await assert.rejects(asUser(db, USERS.ownerA, (tx) => tx.query(sql, [id])), /Only the subject, body and approval/);
  }
  await assert.rejects(asUser(db, USERS.ownerA, (tx) => tx.query(`update emails set subject = '  ' where id = $1`, [id])), /empty or too long/);
});

test('OUT-04 viewers and other companies cannot approve; the backend can queue', async () => {
  const id = await email();
  for (const user of [USERS.viewerA, USERS.ownerB]) {
    const r = await asUser(db, user, (tx) => tx.query(`update emails set status = 'approved' where id = $1`, [id]));
    assert.equal(r.affectedRows, 0);
  }
  await asService(db, (tx) => tx.query(`update emails set status = 'queued', provider_id = 'inst-1', queued_at = now() where id = $1`, [id]));
  assert.equal((await row(id)).status, 'queued');
});

test('OUT-05 sending settings are validated', async () => {
  for (const sql of [
    `update campaigns set send_window_start = '25:00' where id = $1`,
    `update campaigns set send_window_end = '9am' where id = $1`,
    `update campaigns set daily_send_limit = 0 where id = $1`,
    `update campaigns set follow_up_count = 5 where id = $1`,
    `update campaigns set sending_accounts = '{"a":1}' where id = $1`,
    `update campaigns set outreach_status = 'sending' where id = $1`,
  ]) {
    await assert.rejects(db.query(sql, [camp]), /check constraint/);
  }
  const c = (await db.query('select outreach_status, daily_send_limit, follow_up_count, send_days from campaigns where id = $1', [camp])).rows[0];
  assert.deepEqual([c.outreach_status, c.daily_send_limit, c.follow_up_count, c.send_days['1'], c.send_days['0']], ['not_started', 50, 2, true, false]);
});

test('OUT-06 pausing the workspace, the email channel or the campaign queues a sync with the sending service', async () => {
  const noInstantly = (await db.query(`insert into campaigns (workspace_id, name, niche, status) values ($1, 'D', 'x', 'active') returning id`, [wsA])).rows[0].id;
  await db.query(`update campaigns set instantly_campaign_id = 'inst-camp', outreach_status = 'live' where id = $1`, [camp]);
  await db.query(`delete from agent_jobs`);
  await asUser(db, USERS.ownerA, (tx) => tx.query('update workspaces set outreach_paused = true where id = $1', [wsA]));
  assert.deepEqual(await jobs(camp), [{ status: 'queued' }]);
  assert.deepEqual(await jobs(noInstantly), []);
  await db.query(`delete from agent_jobs`);
  await asUser(db, USERS.ownerA, (tx) => tx.query(`update workspaces set outreach_paused = false, enabled_channels = enabled_channels || '{"email": false}' where id = $1`, [wsA]));
  assert.deepEqual(await jobs(camp), [{ status: 'queued' }]);
  await db.query(`delete from agent_jobs`);
  await asUser(db, USERS.ownerA, (tx) => tx.query(`update campaigns set outreach_status = 'paused' where id = $1`, [camp]));
  assert.deepEqual(await jobs(camp), [{ status: 'queued' }]);
  await db.query(`delete from agent_jobs`);
  await asUser(db, USERS.ownerA, (tx) => tx.query(`update campaigns set name = 'Renamed' where id = $1`, [camp]));
  assert.deepEqual(await jobs(camp), []);
  await db.query(`update workspaces set enabled_channels = enabled_channels || '{"email": true}' where id = $1`, [wsA]);
});

test('OUT-07 the kill switch still lets outreach syncs run, but holds copywriting', async () => {
  await db.query(`delete from agent_jobs`);
  await db.query(`update workspaces set outreach_paused = true where id = $1`, [wsA]);
  await db.query(`insert into agent_jobs (workspace_id, campaign_id, type) values ($1,$2,'copywriting')`, [wsA, camp]);
  const claimed = await asService(db, async (tx) => (await tx.query('select type from agent_jobs_claim(10)')).rows.map((r) => r.type));
  assert.deepEqual(claimed.sort(), ['email_outreach']);
  assert.deepEqual(await jobs(camp, 'copywriting'), [{ status: 'queued' }]);
  await db.query(`update workspaces set outreach_paused = false where id = $1`, [wsA]);
});

test('OUT-08 the daily schedule sends only for campaigns whose outreach is live', async () => {
  await db.query(`delete from agent_jobs`);
  const draftOutreach = (await db.query(`insert into campaigns (workspace_id, name, niche, status) values ($1, 'E', 'x', 'active') returning id`, [wsB])).rows[0].id;
  await db.query(`update campaigns set outreach_status = 'live' where id = $1`, [camp]);
  await asService(db, (tx) => tx.query('select agent_jobs_enqueue_due(24)'));
  assert.equal((await jobs(camp)).length, 1);
  assert.equal((await jobs(draftOutreach)).length, 0);
  assert.equal((await jobs(draftOutreach, 'copywriting')).length, 1);
});
