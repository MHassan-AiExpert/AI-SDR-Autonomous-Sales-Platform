import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { createDatabase, seedTwoWorkspaces, asUser, asService, USERS, insertLead } from './helpers.mjs';

let db, wsA, camp, lead, lead2;
const LINK = 'plink_' + 'A1b2C3d4E5';

before(async () => {
  db = await createDatabase();
  ({ wsA } = await seedTwoWorkspaces(db));
  camp = (await db.query(`insert into campaigns (workspace_id, name, niche, status) values ($1, 'C', 'dentists', 'active') returning id`, [wsA])).rows[0].id;
  lead = await asService(db, (tx) => insertLead(tx, wsA, { email: 'kim@bright.com' }));
  lead2 = await asService(db, (tx) => insertLead(tx, wsA, { email: 'lee@bright.com' }));
});

const meeting = (startsIn, over = {}) => db.query(
  `insert into meetings (workspace_id, lead_id, campaign_id, starts_at, booked_via, run_by, phone) values ($1,$2,$3, now() + make_interval(secs => $4), 'calendly', $5, '+15125550101') returning id`,
  [wsA, over.lead ?? lead, camp, startsIn, over.runBy ?? 'ai_closer']);

test('CL-01 closer fields default safely and are validated', async () => {
  const m = (await meeting(3600)).rows[0].id;
  assert.equal((await db.query('select closer_status from meetings where id = $1', [m])).rows[0].closer_status, 'pending');
  for (const [sql, args] of [
    [`update meetings set phone = '5125550101' where id = $1`, [m]],
    [`update meetings set closer_status = 'maybe' where id = $1`, [m]],
    [`update campaigns set vapi_closer_assistant_id = 'nope' where id = $1`, [camp]],
  ]) await assert.rejects(db.query(sql, args), /check constraint/);
  await db.query(`delete from meetings where id = $1`, [m]);
  const d = (await db.query(`insert into deals (workspace_id, lead_id) values ($1,$2) returning close_status, payment_status`, [wsA, lead])).rows[0];
  assert.deepEqual(d, { close_status: 'none', payment_status: 'none' });
  for (const sql of [
    `update deals set payment_url = 'https://evil.example/pay' where lead_id = $1`,
    `update deals set stripe_payment_link_id = 'link-1' where lead_id = $1`,
    `update deals set quote_url = 'http://x' where lead_id = $1`,
    `update deals set billing_interval = 'week' where lead_id = $1`,
  ]) await assert.rejects(db.query(sql, [lead]), /check constraint/);
});

test('CL-02 people move deals and record offline payments, but cannot set proposal or payment links', async () => {
  await asUser(db, USERS.repA, (tx) => tx.query(`update deals set stage = 'negotiation', payment_status = 'paid', close_status = 'needs_team' where lead_id = $1`, [lead]));
  for (const sql of [
    `update deals set payment_url = 'https://buy.stripe.com/test_123' where lead_id = $1`,
    `update deals set pandadoc_document_id = 'AbCdEfGhIjKl' where lead_id = $1`,
    `update deals set close_status = 'pending' where lead_id = $1`,
  ]) await assert.rejects(asUser(db, USERS.adminA, (tx) => tx.query(sql, [lead])), /set by the platform/);
  await assert.rejects(asUser(db, USERS.repA, (tx) => tx.query(`insert into deals (workspace_id, lead_id, payment_url) values ($1,$2,'https://buy.stripe.com/x')`, [wsA, lead2])), /set by the platform/);
  await asService(db, (tx) => tx.query(`update deals set payment_url = 'https://buy.stripe.com/test_123', stripe_payment_link_id = $2, close_status = 'sent' where lead_id = $1`, [lead, LINK]));
});

test('CL-03 a Stripe payment link belongs to one deal; endpoint secrets are never visible to signed-in users', async () => {
  await assert.rejects(asService(db, (tx) => tx.query(`insert into deals (workspace_id, lead_id, stripe_payment_link_id) values ($1,$2,$3)`, [wsA, lead2, LINK])), /duplicate key/);
  await asService(db, (tx) => tx.query(`insert into stripe_endpoints (workspace_id, endpoint_id, signing_secret) values ($1, 'we_123456789', 'whsec_abcdefghijklmnopqrstuv')`, [wsA]));
  await assert.rejects(asUser(db, USERS.ownerA, (tx) => tx.query('select * from stripe_endpoints')), /permission denied/);
  await assert.rejects(asService(db, (tx) => tx.query(`update stripe_endpoints set signing_secret = 'plain' where workspace_id = $1`, [wsA])), /check constraint/);
});

test('CL-04 a closer run starts as an AI-run meeting begins, or when an agreed deal is waiting; the kill switch holds it', async () => {
  const count = async () => (await db.query(`select count(*)::int n from agent_jobs where type = 'ai_closer' and status = 'queued'`)).rows[0].n;
  const enqueue = () => asService(db, (tx) => tx.query('select agent_jobs_enqueue_due(24)'));
  await db.query(`delete from agent_jobs`);
  await db.query(`update deals set close_status = 'sent'`);
  await meeting(1800); await meeting(-1200); await meeting(30, { runBy: 'human' });
  await enqueue();
  assert.equal(await count(), 0, 'nothing starts for a meeting in 30 minutes, one 20 minutes ago or one the team runs');
  const soon = (await meeting(30)).rows[0].id;
  await db.query(`update workspaces set ai_closer_enabled = false where id = $1`, [wsA]);
  await enqueue();
  assert.equal(await count(), 0, 'nothing starts while the AI closer is off');
  await db.query(`update workspaces set ai_closer_enabled = true where id = $1`, [wsA]);
  await enqueue(); await enqueue();
  assert.equal(await count(), 1, 'one run for the meeting starting now');
  await db.query(`update meetings set closer_status = 'calling' where id = $1`, [soon]);
  await db.query(`update agent_jobs set status = 'succeeded', created_at = now() - interval '2 minutes'`);
  await asService(db, (tx) => tx.query(`update deals set close_status = 'pending', campaign_id = $2 where lead_id = $1`, [lead, camp]));
  await enqueue();
  assert.equal(await count(), 1, 'one run for the agreed deal');
  await db.query(`update workspaces set outreach_paused = true where id = $1`, [wsA]);
  const claimed = await asService(db, async (tx) => (await tx.query(`select type from agent_jobs_claim(20) where type = 'ai_closer'`)).rows);
  assert.deepEqual(claimed, []);
  await db.query(`update workspaces set outreach_paused = false where id = $1`, [wsA]);
});

test('CL-05 publishing a playbook makes a new live version; only owners and admins can publish', async () => {
  const v1 = await asUser(db, USERS.adminA, async (tx) => (await tx.query(`select playbook_publish($1, '{"offer_summary":"First"}'::jsonb) as v`, [wsA])).rows[0].v);
  const v2 = await asUser(db, USERS.ownerA, async (tx) => (await tx.query(`select playbook_publish($1, '{"offer_summary":"Second"}'::jsonb) as v`, [wsA])).rows[0].v);
  assert.equal(v2, v1 + 1);
  const live = (await db.query(`select version, content->>'offer_summary' as offer from playbooks where workspace_id = $1 and is_active`, [wsA])).rows;
  assert.deepEqual(live, [{ version: v2, offer: 'Second' }]);
  await assert.rejects(asUser(db, USERS.repA, (tx) => tx.query(`select playbook_publish($1, '{}'::jsonb)`, [wsA])), /row-level security/);
  await assert.rejects(asUser(db, USERS.ownerA, (tx) => tx.query(`select playbook_publish($1, '[1]'::jsonb)`, [wsA])), /not valid/);
});
