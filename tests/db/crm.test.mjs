import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { createDatabase, seedTwoWorkspaces, asUser, asService, USERS } from './helpers.mjs';

let db, wsA, wsB, camp, lead;

before(async () => {
  db = await createDatabase();
  ({ wsA, wsB } = await seedTwoWorkspaces(db));
  camp = (await db.query(`insert into campaigns (workspace_id, name, niche, status) values ($1, 'C', 'dentists', 'active') returning id`, [wsA])).rows[0].id;
  lead = (await db.query(`insert into leads (workspace_id, campaign_id, email, source_channel) values ($1, $2, 'a@x.test', 'apollo') returning id`, [wsA, camp])).rows[0].id;
});

const link = (ws, type, id, ext, fp = null) => asService(db, (tx) => tx.query(
  `insert into crm_links (workspace_id, record_type, record_id, external_id, fingerprint) values ($1, $2, $3, $4, $5) returning id`, [ws, type, id, ext, fp]));

test('CRM-01 sync is off by default with safe defaults, and settings are checked', async () => {
  const w = (await db.query('select crm_sync_enabled, crm_sync_scope, crm_pipeline_id, crm_stage_map, crm_synced_at from workspaces where id = $1', [wsA])).rows[0];
  assert.deepEqual(w, { crm_sync_enabled: false, crm_sync_scope: 'engaged', crm_pipeline_id: 'default', crm_stage_map: {}, crm_synced_at: null });
  await assert.rejects(db.query(`update workspaces set crm_sync_scope = 'all' where id = $1`, [wsA]), /check constraint/);
  await assert.rejects(db.query(`update workspaces set crm_pipeline_id = 'bad id; drop' where id = $1`, [wsA]), /check constraint/);
  await assert.rejects(db.query(`update workspaces set crm_stage_map = '[]' where id = $1`, [wsA]), /check constraint/);
  await assert.rejects(db.query(`update workspaces set crm_stage_map = jsonb_build_object('won', repeat('x', 3000)) where id = $1`, [wsA]), /check constraint/);
});

test('CRM-02 owners and admins change CRM settings; reps, viewers and other workspaces cannot', async () => {
  const set = (user, ws) => asUser(db, user, (tx) => tx.query(`update workspaces set crm_sync_enabled = true where id = $1 returning id`, [ws]));
  assert.equal((await set(USERS.adminA, wsA)).rows.length, 1);
  assert.equal((await set(USERS.repA, wsA)).rows.length, 0);
  assert.equal((await set(USERS.viewerA, wsA)).rows.length, 0);
  assert.equal((await set(USERS.ownerA, wsB)).rows.length, 0);
  await db.query('update workspaces set crm_sync_enabled = false where id = $1', [wsA]);
});

test('CRM-03 links are read by members only and written only by the agent service', async () => {
  await link(wsA, 'lead', lead, '501', 'a'.repeat(64));
  assert.equal((await asUser(db, USERS.viewerA, (tx) => tx.query('select external_id from crm_links'))).rows[0].external_id, '501');
  assert.equal((await asUser(db, USERS.ownerB, (tx) => tx.query('select id from crm_links'))).rows.length, 0);
  await assert.rejects(asUser(db, USERS.ownerA, (tx) => tx.query(`insert into crm_links (workspace_id, record_type, record_id, external_id) values ($1, 'lead', gen_random_uuid(), '9')`, [wsA])), /permission denied/);
  await assert.rejects(asUser(db, USERS.ownerA, (tx) => tx.query(`update crm_links set external_id = '9'`)), /permission denied/);
  await assert.rejects(asUser(db, USERS.ownerA, (tx) => tx.query(`delete from crm_links`)), /permission denied/);
});

test('CRM-04 one link per record, with HubSpot-shaped ids and fingerprints', async () => {
  await assert.rejects(link(wsA, 'lead', lead, '777'), /duplicate key/);
  await assert.rejects(link(wsA, 'deal', lead, 'abc'), /check constraint/);
  await assert.rejects(link(wsA, 'deal', lead, '12', 'not-a-hash'), /check constraint/);
  await assert.rejects(link(wsA, 'company', lead, '12'), /check constraint/);
  // Two leads may share one HubSpot contact (contacts merged in HubSpot)
  const twin = (await db.query(`insert into leads (workspace_id, campaign_id, email, source_channel) values ($1, $2, 'a.other@x.test', 'csv') returning id`, [wsA, camp])).rows[0].id;
  assert.equal((await link(wsA, 'lead', twin, '501')).rows.length, 1);
});

test('CRM-05 the hourly schedule adds a sync per active campaign only while sync is on', async () => {
  const count = async () => (await db.query(`select count(*)::int n from agent_jobs where campaign_id = $1 and type = 'crm_sync'`, [camp])).rows[0].n;
  await asService(db, (tx) => tx.query('select agent_jobs_enqueue_due(24)'));
  assert.equal(await count(), 0);
  await db.query('update workspaces set crm_sync_enabled = true where id = $1', [wsA]);
  await asService(db, (tx) => tx.query('select agent_jobs_enqueue_due(24)'));
  assert.equal(await count(), 1);
  // Not again within the hour
  await db.query(`update agent_jobs set status = 'succeeded', finished_at = now() where campaign_id = $1 and type = 'crm_sync'`, [camp]);
  await asService(db, (tx) => tx.query('select agent_jobs_enqueue_due(24)'));
  assert.equal(await count(), 1);
  await db.query(`update agent_jobs set created_at = now() - interval '61 minutes' where campaign_id = $1 and type = 'crm_sync'`, [camp]);
  await asService(db, (tx) => tx.query('select agent_jobs_enqueue_due(24)'));
  assert.equal(await count(), 2);
  // The kill switch stops scheduling too
  await db.query(`delete from agent_jobs where campaign_id = $1`, [camp]);
  await db.query('update workspaces set outreach_paused = true where id = $1', [wsA]);
  await asService(db, (tx) => tx.query('select agent_jobs_enqueue_due(24)'));
  assert.equal(await count(), 0);
});

test('CRM-06 links go when the workspace goes', async () => {
  const ws = (await asUser(db, USERS.ownerA, (tx) => tx.query(`insert into workspaces (name) values ('Temp') returning id`))).rows[0].id;
  await link(ws, 'lead', lead, '42');
  await db.query('delete from workspaces where id = $1', [ws]);
  assert.equal((await db.query('select count(*)::int n from crm_links where workspace_id = $1', [ws])).rows[0].n, 0);
});
