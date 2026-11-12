import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { createDatabase, seedTwoWorkspaces, asUser, asService, USERS } from './helpers.mjs';

let db, wsA, wsB;

before(async () => {
  db = await createDatabase();
  ({ wsA, wsB } = await seedTwoWorkspaces(db));
});

const campaign = async (ws, status = 'active', niche = 'dentists') =>
  (await db.query(`insert into campaigns (workspace_id, name, niche, status) values ($1, 'C', $2, $3) returning id`, [ws, niche, status])).rows[0].id;
const due = (hours = 24) => asService(db, async (tx) => (await tx.query('select agent_jobs_enqueue_due($1) as n', [hours])).rows[0].n);
const jobs = async (c) => (await db.query(`select type, status, requested_by from agent_jobs where campaign_id = $1 order by type`, [c])).rows;

test('ENR-01 the daily run queues sourcing, enrichment, research and copywriting for each active campaign', async () => {
  const a = await campaign(wsA);
  const draft = await campaign(wsA, 'draft');
  const paused = await campaign(wsA, 'paused');
  const noNiche = await campaign(wsA, 'active', null);
  assert.equal(await due(), 4);
  assert.deepEqual(await jobs(a), [
    { type: 'copywriting', status: 'queued', requested_by: null },
    { type: 'enrichment', status: 'queued', requested_by: null },
    { type: 'lead_sourcing', status: 'queued', requested_by: null },
    { type: 'research', status: 'queued', requested_by: null },
  ]);
  for (const c of [draft, paused, noNiche]) assert.deepEqual(await jobs(c), []);
});

test('ENR-02 running it again queues nothing while jobs wait or ran recently', async () => {
  assert.equal(await due(), 0);
  await db.query(`update agent_jobs set status = 'succeeded', finished_at = now() where workspace_id = $1`, [wsA]);
  assert.equal(await due(), 0);
  await db.query(`update agent_jobs set created_at = now() - interval '25 hours' where workspace_id = $1`, [wsA]);
  assert.equal(await due(), 4);
});

test('ENR-03 a paused workspace gets no scheduled jobs', async () => {
  const b = await campaign(wsB);
  await db.query('update workspaces set outreach_paused = true where id = $1', [wsB]);
  await due();
  assert.deepEqual(await jobs(b), []);
  await db.query('update workspaces set outreach_paused = false where id = $1', [wsB]);
  await due();
  assert.equal((await jobs(b)).length, 4);
});

test('ENR-04 a finished sourcing job can hand over to enrichment exactly once', async () => {
  const c = await campaign(wsA, 'draft');
  const enqueue = () => asService(db, async (tx) => (await tx.query(`select agent_job_enqueue($1, $2, 'enrichment') as ok`, [wsA, c])).rows[0].ok);
  assert.equal(await enqueue(), true);
  assert.equal(await enqueue(), false);
  assert.equal((await jobs(c)).length, 1);
});

test('ENR-05 only the backend can schedule jobs this way', async () => {
  const c = await campaign(wsA, 'draft');
  await assert.rejects(asUser(db, USERS.ownerA, (tx) => tx.query('select agent_jobs_enqueue_due(24)')), /permission denied/);
  await assert.rejects(asUser(db, USERS.ownerA, (tx) => tx.query(`select agent_job_enqueue($1, $2, 'enrichment')`, [wsA, c])), /permission denied/);
});

test('ENR-06 owners can queue enrichment from the app; unknown job types are rejected', async () => {
  const c = await campaign(wsA, 'draft');
  const { rows } = await asUser(db, USERS.ownerA, (tx) =>
    tx.query(`insert into agent_jobs (workspace_id, campaign_id, type) values ($1, $2, 'enrichment') returning type`, [wsA, c]));
  assert.equal(rows[0].type, 'enrichment');
  await assert.rejects(db.query(`insert into agent_jobs (workspace_id, campaign_id, type) values ($1, $2, 'mining')`, [wsA, c]), /check constraint/);
});

test('ENR-07 a company keeps the campaign and source that found it, inside its own workspace only', async () => {
  const a = await campaign(wsA, 'draft');
  const { rows } = await db.query(
    `insert into companies (workspace_id, name, domain, campaign_id, source_channel) values ($1, 'Bright Teeth', 'brightteeth.com', $2, 'llm_search') returning enrichment_status`, [wsA, a]);
  assert.equal(rows[0].enrichment_status, 'pending');
  await assert.rejects(db.query(`insert into companies (workspace_id, name, campaign_id) values ($1, 'X', $2)`, [wsB, a]), /foreign key/);
  await assert.rejects(db.query(`insert into companies (workspace_id, name, source_channel) values ($1, 'X', 'myspace')`, [wsA]), /check constraint/);
  await db.query('delete from campaigns where id = $1', [a]);
  const kept = (await db.query(`select campaign_id from companies where domain = 'brightteeth.com'`)).rows[0];
  assert.equal(kept.campaign_id, null);
});

test('ENR-08 phone country must be a two-letter code', async () => {
  const ok = await db.query(`insert into leads (workspace_id, phone, phone_country, source_channel) values ($1, '+15125550101', 'US', 'manual') returning id`, [wsA]);
  assert.ok(ok.rows[0].id);
  await assert.rejects(db.query(`insert into leads (workspace_id, phone, phone_country, source_channel) values ($1, '+1', 'usa', 'manual')`, [wsA]), /check constraint/);
});
