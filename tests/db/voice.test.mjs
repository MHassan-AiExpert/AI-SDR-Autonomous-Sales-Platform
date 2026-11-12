import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { createDatabase, seedTwoWorkspaces, asUser, asService, USERS, insertLead } from './helpers.mjs';

let db, wsA, camp, lead;

before(async () => {
  db = await createDatabase();
  ({ wsA } = await seedTwoWorkspaces(db));
  camp = (await db.query(`insert into campaigns (workspace_id, name, niche, status) values ($1, 'C', 'dentists', 'active') returning id`, [wsA])).rows[0].id;
  lead = await asService(db, (tx) => insertLead(tx, wsA, { email: 'kim@bright.com' }));
});

test('VO-01 voice settings default to safe values and are validated', async () => {
  const c = (await db.query('select voice_status, call_rule, call_window_start, call_window_end, call_daily_limit, call_max_attempts from campaigns where id = $1', [camp])).rows[0];
  assert.deepEqual(c, { voice_status: 'not_started', call_rule: 'consent_only', call_window_start: '10:00', call_window_end: '16:00', call_daily_limit: 30, call_max_attempts: 2 });
  for (const sql of [
    `update campaigns set call_rule = 'anyone' where id = $1`,
    `update campaigns set call_max_attempts = 9 where id = $1`,
    `update campaigns set vapi_assistant_id = 'not-a-uuid' where id = $1`,
    `update campaigns set call_window_end = '25:00' where id = $1`,
  ]) await assert.rejects(db.query(sql, [camp]), /check constraint/);
});

test('VO-02 attesting to registry screening records who and when; clearing it removes both', async () => {
  await asUser(db, USERS.adminA, (tx) => tx.query(`update campaigns set dnc_attested_at = '2000-01-01' where id = $1`, [camp]));
  let c = (await db.query('select dnc_attested_at, dnc_attested_by from campaigns where id = $1', [camp])).rows[0];
  assert.equal(c.dnc_attested_by, USERS.adminA);
  assert.ok(new Date(c.dnc_attested_at).getFullYear() >= 2026, 'time is set by the database, not the client');
  await asUser(db, USERS.adminA, (tx) => tx.query(`update campaigns set dnc_attested_at = null where id = $1`, [camp]));
  c = (await db.query('select dnc_attested_at, dnc_attested_by from campaigns where id = $1', [camp])).rows[0];
  assert.deepEqual(c, { dnc_attested_at: null, dnc_attested_by: null });
});

test('VO-03 each provider call is stored once; recordings must be https', async () => {
  const ins = (key) => db.query(`insert into calls (workspace_id, lead_id, campaign_id, agent, direction, idempotency_key, provider, provider_call_id) values ($1,$2,$3,'caller','outbound',$4,'vapi','call-1')`, [wsA, lead, camp, key]);
  await ins('k1');
  await assert.rejects(ins('k2'), /duplicate key/);
  await assert.rejects(db.query(`insert into calls (workspace_id, lead_id, agent, direction, idempotency_key, recording_url) values ($1,$2,'caller','outbound','k3','http://x/rec.wav')`, [wsA, lead]), /check constraint/);
});

test('VO-04 the kill switch holds calls; live voice campaigns get a job every hour', async () => {
  await db.query(`delete from agent_jobs`);
  await db.query(`update campaigns set voice_status = 'live' where id = $1`, [camp]);
  await asService(db, (tx) => tx.query('select agent_jobs_enqueue_due(24)'));
  assert.equal((await db.query(`select count(*)::int n from agent_jobs where type = 'voice_outreach'`)).rows[0].n, 1);
  await db.query(`update agent_jobs set status = 'succeeded', created_at = now() - interval '61 minutes' where type = 'voice_outreach'`);
  await asService(db, (tx) => tx.query('select agent_jobs_enqueue_due(24)'));
  assert.equal((await db.query(`select count(*)::int n from agent_jobs where type = 'voice_outreach' and status = 'queued'`)).rows[0].n, 1);
  await db.query(`update workspaces set outreach_paused = true where id = $1`, [wsA]);
  const claimed = await asService(db, async (tx) => (await tx.query(`select type from agent_jobs_claim(20) where type = 'voice_outreach'`)).rows);
  assert.deepEqual(claimed, []);
  await db.query(`update workspaces set outreach_paused = false where id = $1`, [wsA]);
});
