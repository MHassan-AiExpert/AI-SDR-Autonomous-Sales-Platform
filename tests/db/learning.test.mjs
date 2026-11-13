import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { createDatabase, seedTwoWorkspaces, asUser, asService, USERS } from './helpers.mjs';

let db, wsA, camp, report;

before(async () => {
  db = await createDatabase();
  ({ wsA } = await seedTwoWorkspaces(db));
  camp = (await db.query(`insert into campaigns (workspace_id, name, niche, status, score_threshold) values ($1, 'C', 'dentists', 'active', 60) returning id`, [wsA])).rows[0].id;
  report = (await asService(db, (tx) => tx.query(`insert into learning_reports (workspace_id, campaign_id, period_start, period_end, summary) values ($1,$2, now() - interval '90 days', now(), 'Summary') returning id`, [wsA, camp]))).rows[0].id;
});

const suggest = (kind, text, findingId, value = null) => asService(db, (tx) => tx.query(
  `insert into learning_suggestions (workspace_id, campaign_id, report_id, kind, text, value, evidence, finding_id) values ($1,$2,$3,$4,$5,$6,'Measured',$7) returning id`,
  [wsA, camp, report, kind, text, value, findingId]));
const decide = (user, id, d) => asUser(db, user, async (tx) => (await tx.query('select learning_decide($1, $2) as r', [id, d])).rows[0].r);

test('LN-01 lessons default to none and are limited in number and length', async () => {
  const c = (await db.query('select learned_guidance, learning_auto_apply from campaigns where id = $1', [camp])).rows[0];
  assert.deepEqual(c, { learned_guidance: [], learning_auto_apply: false });
  await assert.rejects(db.query(`update campaigns set learned_guidance = array_fill('x'::text, array[9]) where id = $1`, [camp]), /check constraint/);
  await assert.rejects(db.query(`update campaigns set learned_guidance = array[repeat('x', 1601)] where id = $1`, [camp]), /check constraint/);
  await assert.rejects(suggest('score_threshold', 'Raise it', 'score_band:60'), /check constraint/);
  await assert.rejects(suggest('copy_guidance', 'Bad id', 'Subject Style!'), /check constraint/);
});

test('LN-02 members read learning; nobody writes it directly', async () => {
  const id = (await suggest('copy_guidance', 'Keep the first email under 60 words.', 'body_length:short')).rows[0].id;
  assert.equal((await asUser(db, USERS.viewerA, (tx) => tx.query('select id from learning_suggestions'))).rows.length, 1);
  assert.equal((await asUser(db, USERS.ownerB, (tx) => tx.query('select id from learning_reports'))).rows.length, 0);
  await assert.rejects(asUser(db, USERS.ownerA, (tx) => tx.query(`update learning_suggestions set status = 'applied' where id = $1`, [id])), /permission denied/);
  await assert.rejects(asUser(db, USERS.ownerA, (tx) => tx.query(`insert into learning_reports (workspace_id, campaign_id, period_start, period_end) values ($1,$2,now(),now())`, [wsA, camp])), /permission denied/);
  await assert.rejects(suggest('copy_guidance', 'Same lesson again.', 'body_length:short'), /duplicate key/);
});

test('LN-03 owners and admins apply, dismiss and remove lessons; reps and other workspaces cannot', async () => {
  const g = (await db.query(`select id from learning_suggestions where finding_id = 'body_length:short'`)).rows[0].id;
  await assert.rejects(decide(USERS.repA, g, 'apply'), /Only owners and admins/);
  await assert.rejects(decide(USERS.ownerB, g, 'apply'), /Only owners and admins/);
  assert.equal(await decide(USERS.adminA, g, 'apply'), 'applied');
  assert.deepEqual((await db.query('select learned_guidance from campaigns where id = $1', [camp])).rows[0].learned_guidance, ['Keep the first email under 60 words.']);
  await assert.rejects(decide(USERS.adminA, g, 'apply'), /already been decided/);
  const t = (await suggest('score_threshold', 'Raise the score threshold to 70.', 'score_band:60', 70)).rows[0].id;
  assert.equal(await decide(USERS.ownerA, t, 'apply'), 'applied');
  assert.equal((await db.query('select score_threshold from campaigns where id = $1', [camp])).rows[0].score_threshold, 70);
  const d = (await suggest('copy_guidance', 'Write the first subject line as a short question.', 'subject_style:question')).rows[0].id;
  assert.equal(await decide(USERS.adminA, d, 'dismiss'), 'dismissed');
  assert.equal(await decide(USERS.adminA, g, 'remove'), 'removed');
  assert.deepEqual((await db.query('select learned_guidance from campaigns where id = $1', [camp])).rows[0].learned_guidance, []);
  const row = (await db.query('select status, decided_by is not null as by from learning_suggestions where id = $1', [g])).rows[0];
  assert.deepEqual(row, { status: 'removed', by: true });
});

test('LN-04 a learning run is scheduled once a week for active campaigns', async () => {
  const n = async () => (await db.query(`select count(*)::int n from agent_jobs where type = 'learning' and campaign_id = $1`, [camp])).rows[0].n;
  await db.query('delete from agent_jobs');
  await asService(db, (tx) => tx.query('select agent_jobs_enqueue_due(24)'));
  assert.equal(await n(), 1);
  await db.query(`update agent_jobs set status = 'succeeded', created_at = now() - interval '100 hours' where type = 'learning'`);
  await asService(db, (tx) => tx.query('select agent_jobs_enqueue_due(24)'));
  assert.equal(await n(), 1, 'not again within the week');
  await db.query(`update agent_jobs set created_at = now() - interval '169 hours' where type = 'learning'`);
  await asService(db, (tx) => tx.query('select agent_jobs_enqueue_due(24)'));
  assert.equal(await n(), 2);
});
