import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { createDatabase, seedTwoWorkspaces, asUser, asAnon, USERS } from './helpers.mjs';

let db, wsA, wsB;

before(async () => {
  db = await createDatabase();
  ({ wsA, wsB } = await seedTwoWorkspaces(db));
});

const list = (user, ws) => asUser(db, user, (tx) => tx.query('select * from workspace_members_list($1)', [ws]));
const add = (user, ws, email, role) =>
  asUser(db, user, (tx) => tx.query('select workspace_member_add($1, $2, $3) as id', [ws, email, role]));

test('TEAM-01 members see the team with emails and roles', async () => {
  const { rows } = await list(USERS.viewerA, wsA);
  assert.deepEqual(
    rows.map((r) => [r.email, r.role]).sort(),
    [['adminA@example.test', 'admin'], ['ownerA@example.test', 'owner'], ['repA@example.test', 'rep'], ['viewerA@example.test', 'viewer']]);
});

test('TEAM-02 another company cannot list the team', async () => {
  assert.equal((await list(USERS.ownerB, wsA)).rows.length, 0);
  assert.equal((await list(USERS.outsider, wsA)).rows.length, 0);
});

test('TEAM-03 anonymous visitors cannot call team functions', async () => {
  await assert.rejects(asAnon(db, (tx) => tx.query('select * from workspace_members_list($1)', [wsA])), /permission denied/);
  await assert.rejects(
    asAnon(db, (tx) => tx.query(`select workspace_member_add($1, 'outsider@example.test', 'viewer')`, [wsA])),
    /permission denied/);
});

test('TEAM-04 an owner adds an existing account by email, ignoring letter case', async () => {
  const { rows } = await add(USERS.ownerB, wsB, '  Outsider@Example.test ', 'admin');
  assert.equal(rows[0].id, USERS.outsider);
  const team = await list(USERS.ownerB, wsB);
  assert.ok(team.rows.some((r) => r.email === 'outsider@example.test' && r.role === 'admin'));
});

test('TEAM-05 an unknown email is rejected with a clear message', async () => {
  await assert.rejects(add(USERS.ownerA, wsA, 'nobody@example.test', 'rep'), /No account found for this email/);
});

test('TEAM-06 an existing member cannot be added twice', async () => {
  await assert.rejects(add(USERS.ownerA, wsA, 'repA@example.test', 'viewer'), /already a member/);
});

test('TEAM-07 an admin adds reps and viewers but not admins or owners', async () => {
  await assert.rejects(add(USERS.adminA, wsA, 'ownerB@example.test', 'admin'), /not allowed/);
  await assert.rejects(add(USERS.adminA, wsA, 'ownerB@example.test', 'owner'), /not allowed/);
  const { rows } = await add(USERS.adminA, wsA, 'ownerB@example.test', 'viewer');
  assert.equal(rows[0].id, USERS.ownerB);
});

test('TEAM-08 reps, viewers and outsiders cannot add members', async () => {
  for (const user of [USERS.repA, USERS.viewerA, USERS.outsider]) {
    await assert.rejects(add(user, wsA, 'outsider@example.test', 'viewer'), /not allowed/);
  }
});

test('TEAM-09 adding a member is written to the audit log', async () => {
  const { rows } = await asUser(db, USERS.ownerB, (tx) =>
    tx.query(`select actor_id, entity_id from audit_log where workspace_id = $1 and action = 'member.added' and entity_id = $2`,
      [wsB, USERS.outsider]));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].actor_id, USERS.ownerB);
});
