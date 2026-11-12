import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { createDatabase, seedTwoWorkspaces, asUser, asAnon, asService, USERS } from './helpers.mjs';

let db, wsA, wsB, campA, campB;

before(async () => {
  db = await createDatabase();
  ({ wsA, wsB } = await seedTwoWorkspaces(db));
  campA = await asUser(db, USERS.ownerA, async (tx) =>
    (await tx.query(`insert into campaigns (workspace_id, name, niche) values ($1, 'UK dentists', 'dental clinics') returning id`, [wsA])).rows[0].id);
  campB = await asUser(db, USERS.ownerB, async (tx) =>
    (await tx.query(`insert into campaigns (workspace_id, name) values ($1, 'B campaign') returning id`, [wsB])).rows[0].id);
});

const queue = (user, ws, campaign, type = 'campaign_plan', extra = '') =>
  asUser(db, user, (tx) => tx.query(
    `insert into agent_jobs (workspace_id, campaign_id, type${extra ? ', ' + extra.split('=')[0] : ''}) values ($1, $2, $3${extra ? ', ' + extra.split('=')[1] : ''}) returning *`,
    [ws, campaign, type]));
const claim = (limit = 5) => asService(db, async (tx) => (await tx.query('select * from agent_jobs_claim($1)', [limit])).rows);
const finish = (id, status, result = {}, error = null) =>
  asService(db, (tx) => tx.query('select agent_job_finish($1, $2, $3::jsonb, $4)', [id, status, JSON.stringify(result), error]));

test('JOB-01 an owner or admin queues a job that is recorded as theirs', async () => {
  const { rows } = await queue(USERS.adminA, wsA, campA);
  assert.equal(rows[0].status, 'queued');
  assert.equal(rows[0].requested_by, USERS.adminA);
  assert.ok(rows[0].correlation_id);
});

test('JOB-02 the same work cannot be queued twice while it is waiting or running', async () => {
  await assert.rejects(queue(USERS.ownerA, wsA, campA), /duplicate key/);
});

test('JOB-03 reps, viewers, other companies and visitors cannot queue jobs', async () => {
  for (const user of [USERS.repA, USERS.viewerA, USERS.ownerB, USERS.outsider]) {
    await assert.rejects(queue(user, wsA, campA, 'lead_sourcing'), /row-level security/);
  }
  await assert.rejects(asAnon(db, (tx) => tx.query(
    `insert into agent_jobs (workspace_id, campaign_id, type) values ($1, $2, 'lead_sourcing')`, [wsA, campA])), /permission denied/);
});

test('JOB-04 a client cannot queue a job that pretends to be finished or someone else\'s', async () => {
  for (const extra of [`status='succeeded'`, `attempts=3`, `result='{"leads":1}'::jsonb`, `error='x'`, `started_at=now()`, `requested_by='${USERS.repA}'`]) {
    await assert.rejects(queue(USERS.ownerA, wsA, campA, 'lead_sourcing', extra), /row-level security/, extra);
  }
});

test('JOB-05 a job cannot point at another company\'s campaign', async () => {
  await assert.rejects(queue(USERS.ownerA, wsA, campB, 'lead_sourcing'), /foreign key|row-level security/);
});

test('JOB-06 clients cannot change or delete jobs', async () => {
  const up = asUser(db, USERS.ownerA, (tx) => tx.query(`update agent_jobs set status = 'succeeded'`));
  await assert.rejects(up, /permission denied/);
  await assert.rejects(asUser(db, USERS.ownerA, (tx) => tx.query('delete from agent_jobs')), /permission denied/);
});

test('JOB-07 members see their company\'s jobs; other companies see none', async () => {
  assert.equal((await asUser(db, USERS.viewerA, (tx) => tx.query('select id from agent_jobs'))).rows.length, 1);
  assert.equal((await asUser(db, USERS.ownerB, (tx) => tx.query('select id from agent_jobs'))).rows.length, 0);
});

test('JOB-08 only the backend can claim and finish jobs', async () => {
  await assert.rejects(asUser(db, USERS.ownerA, (tx) => tx.query('select * from agent_jobs_claim(5)')), /permission denied/);
  await assert.rejects(asUser(db, USERS.ownerA, (tx) => tx.query(`select agent_job_finish(gen_random_uuid(), 'succeeded')`)), /permission denied/);
});

test('JOB-09 claiming marks jobs running, counts the attempt and never hands out the same job twice', async () => {
  await queue(USERS.ownerB, wsB, campB, 'lead_sourcing');
  const first = await claim(1);
  const second = await claim(5);
  assert.equal(first.length, 1);
  assert.equal(second.length, 1);
  assert.notEqual(first[0].id, second[0].id);
  for (const j of [...first, ...second]) {
    assert.equal(j.status, 'running');
    assert.equal(j.attempts, 1);
    assert.ok(j.started_at);
  }
  assert.equal((await claim(5)).length, 0);
});

test('JOB-10 jobs are claimed oldest first', async () => {
  const { rows } = await db.query(`select id, created_at from agent_jobs order by created_at`);
  const claimedOrder = (await db.query(`select id from agent_jobs order by started_at, created_at`)).rows.map((r) => r.id);
  assert.deepEqual(claimedOrder, rows.map((r) => r.id));
});

test('JOB-11 finishing records the result once; a finished job cannot be finished again', async () => {
  const job = (await db.query(`select id from agent_jobs where workspace_id = $1`, [wsA])).rows[0];
  await finish(job.id, 'succeeded', { leads_added: 42 });
  await finish(job.id, 'failed', {}, 'late duplicate');
  const r = (await db.query('select status, result, error, finished_at from agent_jobs where id = $1', [job.id])).rows[0];
  assert.equal(r.status, 'succeeded');
  assert.deepEqual(r.result, { leads_added: 42 });
  assert.equal(r.error, null);
  assert.ok(r.finished_at);
  await assert.rejects(finish(job.id, 'running'), /Invalid job status/);
});

test('JOB-12 after a job finishes, the same work can be queued again', async () => {
  const { rows } = await queue(USERS.ownerA, wsA, campA);
  assert.equal(rows[0].status, 'queued');
});

test('JOB-13 a job left running by a crashed worker is retried, then failed after 3 attempts', async () => {
  const id = (await db.query(`select id from agent_jobs where workspace_id = $1 and status = 'queued'`, [wsA])).rows[0].id;
  for (let attempt = 1; attempt <= 3; attempt++) {
    const claimed = await claim(5);
    assert.equal(claimed.find((j) => j.id === id)?.attempts, attempt);
    await db.query(`update agent_jobs set started_at = now() - interval '20 minutes' where id = $1`, [id]);
  }
  await claim(5);
  const r = (await db.query('select status, error, attempts from agent_jobs where id = $1', [id])).rows[0];
  assert.equal(r.status, 'failed');
  assert.match(r.error, /3 attempts/);
  assert.equal(r.attempts, 3);
});

test('JOB-14 the kill switch holds lead sourcing but not campaign planning', async () => {
  await asUser(db, USERS.ownerA, (tx) => tx.query(`update workspaces set outreach_paused = true where id = $1`, [wsA]));
  const sourcing = (await queue(USERS.ownerA, wsA, campA, 'lead_sourcing')).rows[0].id;
  const planning = (await queue(USERS.ownerA, wsA, campA, 'campaign_plan')).rows[0].id;
  const claimed = (await claim(10)).map((j) => j.id);
  assert.ok(claimed.includes(planning));
  assert.ok(!claimed.includes(sourcing));
  await asUser(db, USERS.ownerA, (tx) => tx.query(`update workspaces set outreach_paused = false where id = $1`, [wsA]));
  assert.ok((await claim(10)).some((j) => j.id === sourcing));
});

test('JOB-15 the campaign source plan defaults to empty and is stored per campaign', async () => {
  const r = (await db.query('select source_plan from campaigns where id = $1', [campA])).rows[0];
  assert.deepEqual(r.source_plan, {});
});
