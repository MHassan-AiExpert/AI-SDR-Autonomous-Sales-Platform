import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { createDatabase, seedTwoWorkspaces, asUser, USERS } from './helpers.mjs';

let db, wsA;

before(async () => {
  db = await createDatabase();
  ({ wsA } = await seedTwoWorkspaces(db));
});

test('RES-01 campaigns get a score threshold of 60 that owners can change within 0 to 100', async () => {
  const c = await asUser(db, USERS.ownerA, async (tx) =>
    (await tx.query(`insert into campaigns (workspace_id, name, niche) values ($1, 'C', 'dentists') returning id, score_threshold`, [wsA])).rows[0]);
  assert.equal(c.score_threshold, 60);
  const upd = await asUser(db, USERS.adminA, (tx) => tx.query('update campaigns set score_threshold = 75 where id = $1', [c.id]));
  assert.equal(upd.affectedRows, 1);
  const rep = await asUser(db, USERS.repA, (tx) => tx.query('update campaigns set score_threshold = 10 where id = $1', [c.id]));
  assert.equal(rep.affectedRows, 0);
  await assert.rejects(db.query('update campaigns set score_threshold = 101 where id = $1', [c.id]), /check constraint/);
});

test('RES-02 research jobs can be queued; scores outside 0 to 100 are rejected', async () => {
  const c = (await db.query(`insert into campaigns (workspace_id, name, niche) values ($1, 'D', 'dentists') returning id`, [wsA])).rows[0].id;
  const { rows } = await asUser(db, USERS.ownerA, (tx) =>
    tx.query(`insert into agent_jobs (workspace_id, campaign_id, type) values ($1, $2, 'research') returning type`, [wsA, c]));
  assert.equal(rows[0].type, 'research');
  await assert.rejects(db.query(`insert into leads (workspace_id, email, source_channel, score) values ($1, 'a@b.com', 'manual', 140)`, [wsA]), /check constraint/);
});

test('RES-03 a company stores its research once; leads record when they were scored', async () => {
  const co = (await db.query(`insert into companies (workspace_id, name, research, researched_at) values ($1, 'Bright', '{"summary":"x"}', now()) returning research`, [wsA])).rows[0];
  assert.deepEqual(co.research, { summary: 'x' });
  const l = (await db.query(`insert into leads (workspace_id, email, source_channel) values ($1, 'z@b.com', 'manual') returning researched_at`, [wsA])).rows[0];
  assert.equal(l.researched_at, null);
});
