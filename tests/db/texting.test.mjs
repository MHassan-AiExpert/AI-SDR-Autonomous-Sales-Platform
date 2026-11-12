import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { createDatabase, seedTwoWorkspaces, asUser, asService, USERS, insertLead } from './helpers.mjs';

let db, wsA, camp, lead;
const SID = 'SM' + 'a'.repeat(32);

before(async () => {
  db = await createDatabase();
  ({ wsA } = await seedTwoWorkspaces(db));
  camp = (await db.query(`insert into campaigns (workspace_id, name, niche, status) values ($1, 'C', 'dentists', 'active') returning id`, [wsA])).rows[0].id;
  lead = await asService(db, (tx) => insertLead(tx, wsA, { email: 'kim@bright.com' }));
});

test('TX-01 text settings default to safe values and are validated', async () => {
  const c = (await db.query('select sms_status, sms_channel, sms_after_days, sms_daily_limit, sms_max_messages from campaigns where id = $1', [camp])).rows[0];
  assert.deepEqual(c, { sms_status: 'not_started', sms_channel: 'sms', sms_after_days: 3, sms_daily_limit: 100, sms_max_messages: 1 });
  await db.query(`update campaigns set sms_from = '+15125550100', whatsapp_from = '+447700900123', whatsapp_content_sid = $2 where id = $1`, [camp, 'HX' + 'b'.repeat(32)]);
  await db.query(`update campaigns set sms_from = $2 where id = $1`, [camp, 'MG' + 'c'.repeat(32)]);
  for (const sql of [
    `update campaigns set sms_channel = 'telegram' where id = $1`,
    `update campaigns set sms_from = '5125550100' where id = $1`,
    `update campaigns set whatsapp_content_sid = 'template-1' where id = $1`,
    `update campaigns set sms_max_messages = 5 where id = $1`,
    `update campaigns set sms_after_days = 0 where id = $1`,
  ]) await assert.rejects(db.query(sql, [camp]), /check constraint/);
});

test('TX-02 each Twilio message is stored once; message ids and statuses are validated', async () => {
  const ins = (key, sid = SID) => asService(db, (tx) => tx.query(
    `insert into messages (workspace_id, lead_id, campaign_id, channel, direction, body, provider, provider_message_id, idempotency_key) values ($1,$2,$3,'sms','outbound','Hi','twilio',$4,$5)`,
    [wsA, lead, camp, sid, key]));
  await ins('t1');
  await assert.rejects(ins('t2'), /duplicate key/);
  await assert.rejects(ins('t3', 'not-a-sid'), /check constraint/);
  await assert.rejects(asService(db, (tx) => tx.query(`update messages set delivery_status = 'bounced' where idempotency_key = 't1'`)), /check constraint/);
  await asService(db, (tx) => tx.query(`update messages set delivery_status = 'read' where idempotency_key = 't1'`));
});

test('TX-03 people can log a text they sent themselves but cannot add or change Twilio records', async () => {
  await asUser(db, USERS.repA, (tx) => tx.query(
    `insert into messages (workspace_id, lead_id, channel, direction, body, idempotency_key) values ($1,$2,'sms','outbound','Called you back','manual-1')`, [wsA, lead]));
  await assert.rejects(asUser(db, USERS.repA, (tx) => tx.query(
    `insert into messages (workspace_id, lead_id, channel, direction, body, provider, provider_message_id, idempotency_key) values ($1,$2,'sms','outbound','Fake','twilio',$3,'fake-1')`,
    [wsA, lead, 'SM' + 'd'.repeat(32)])), /Only the platform records texts sent through Twilio/);
  await assert.rejects(asUser(db, USERS.adminA, (tx) => tx.query(`update messages set body = 'Changed' where idempotency_key = 't1'`)), /cannot be changed/);
  await assert.rejects(asUser(db, USERS.repA, (tx) => tx.query(`update messages set provider = 'twilio' where idempotency_key = 'manual-1'`)), /Only the platform/);
  await asUser(db, USERS.repA, (tx) => tx.query(`update messages set body = 'Called you back today' where idempotency_key = 'manual-1'`));
});

test('TX-04 the kill switch holds texts; live text campaigns get a job every hour', async () => {
  await db.query(`delete from agent_jobs`);
  await db.query(`update campaigns set sms_status = 'live' where id = $1`, [camp]);
  await asService(db, (tx) => tx.query('select agent_jobs_enqueue_due(24)'));
  assert.equal((await db.query(`select count(*)::int n from agent_jobs where type = 'sms_outreach'`)).rows[0].n, 1);
  await db.query(`update agent_jobs set status = 'succeeded', created_at = now() - interval '61 minutes' where type = 'sms_outreach'`);
  await asService(db, (tx) => tx.query('select agent_jobs_enqueue_due(24)'));
  assert.equal((await db.query(`select count(*)::int n from agent_jobs where type = 'sms_outreach' and status = 'queued'`)).rows[0].n, 1);
  await db.query(`update workspaces set outreach_paused = true where id = $1`, [wsA]);
  const claimed = await asService(db, async (tx) => (await tx.query(`select type from agent_jobs_claim(20) where type = 'sms_outreach'`)).rows);
  assert.deepEqual(claimed, []);
  await db.query(`update workspaces set outreach_paused = false where id = $1`, [wsA]);
  // A paused text campaign gets no new jobs
  await db.query(`delete from agent_jobs where type = 'sms_outreach'`);
  await db.query(`update campaigns set sms_status = 'paused' where id = $1`, [camp]);
  await asService(db, (tx) => tx.query('select agent_jobs_enqueue_due(24)'));
  assert.equal((await db.query(`select count(*)::int n from agent_jobs where type = 'sms_outreach'`)).rows[0].n, 0);
});
