import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { createDatabase, seedTwoWorkspaces, asUser, asAnon, asService, insertLead, USERS, migrationFiles } from './helpers.mjs';

let db, wsA, wsB, leadA;

const TENANT_TABLES = [
  'workspace_members', 'audit_log', 'campaigns', 'companies', 'leads', 'assets', 'activities',
  'follow_ups', 'emails', 'calls', 'messages', 'replies', 'meetings', 'deals', 'suppressions',
  'integrations', 'playbooks', 'run_logs',
];

before(async () => {
  db = await createDatabase();
  ({ wsA, wsB } = await seedTwoWorkspaces(db));
  leadA = await asUser(db, USERS.repA, (tx) => insertLead(tx, wsA, { email: 'jane@acme.test' }));
  await asUser(db, USERS.ownerB, (tx) => insertLead(tx, wsB, { email: 'bob@other.test' }));
});

// ---------------------------------------------------------------- structure
test('DB-01 migrations apply cleanly in order', () => {
  assert.equal(migrationFiles().length, 4);
});

test('DB-02 every public table has row-level security enabled', async () => {
  const { rows } = await db.query(`
    select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind = 'r' and not c.relrowsecurity`);
  assert.deepEqual(rows, []);
});

test('DB-03 every tenant table carries a mandatory workspace_id', async () => {
  const { rows } = await db.query(`
    select table_name from information_schema.columns
    where table_schema = 'public' and column_name = 'workspace_id' and is_nullable = 'NO'`);
  assert.deepEqual(rows.map((r) => r.table_name).sort(), [...TENANT_TABLES].sort());
});

test('DB-43 every function in the app schema pins its search_path', async () => {
  const { rows } = await db.query(`
    select p.proname from pg_proc p
    where p.pronamespace = 'app'::regnamespace
      and not exists (select 1 from unnest(coalesce(p.proconfig, '{}')) c where c like 'search_path=%')`);
  assert.deepEqual(rows, []);
});

test('DB-04 every table with RLS has at least one policy', async () => {
  const { rows } = await db.query(`
    select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind = 'r'
      and not exists (select 1 from pg_policy p where p.polrelid = c.oid)`);
  assert.deepEqual(rows, []);
});

// ---------------------------------------------------------------- workspaces
test('DB-05 the creator of a workspace becomes its owner', async () => {
  const { rows } = await db.query(
    `select role from workspace_members where workspace_id = $1 and user_id = $2`, [wsA, USERS.ownerA]);
  assert.equal(rows[0].role, 'owner');
});

test('DB-06 new workspaces default to full autopilot with core channels on', async () => {
  const { rows } = await db.query(`select * from workspaces where id = $1`, [wsA]);
  assert.equal(rows[0].automation_mode, 'autopilot');
  assert.equal(rows[0].outreach_paused, false);
  assert.equal(rows[0].ai_closer_enabled, true);
  assert.deepEqual(rows[0].enabled_channels, { email: true, voice: true, sms: true, whatsapp: true, linkedin: false });
});

test('DB-07 a user cannot create a workspace on behalf of someone else', async () => {
  await assert.rejects(
    asUser(db, USERS.outsider, (tx) =>
      tx.query(`insert into workspaces (name, created_by) values ('Fake', $1)`, [USERS.ownerA])),
    /row-level security/);
});

// ---------------------------------------------------------------- isolation
test('DB-08 a user sees only the workspaces they belong to', async () => {
  const a = await asUser(db, USERS.ownerA, (tx) => tx.query('select id from workspaces'));
  const b = await asUser(db, USERS.ownerB, (tx) => tx.query('select id from workspaces'));
  const none = await asUser(db, USERS.outsider, (tx) => tx.query('select id from workspaces'));
  assert.deepEqual(a.rows.map((r) => r.id), [wsA]);
  assert.deepEqual(b.rows.map((r) => r.id), [wsB]);
  assert.equal(none.rows.length, 0);
});

test('DB-09 leads of another company are invisible', async () => {
  const b = await asUser(db, USERS.ownerB, (tx) => tx.query('select email from leads'));
  assert.deepEqual(b.rows.map((r) => r.email), ['bob@other.test']);
  const direct = await asUser(db, USERS.ownerB, (tx) => tx.query('select 1 from leads where id = $1', [leadA]));
  assert.equal(direct.rows.length, 0);
});

test('DB-10 a user cannot insert data into another company', async () => {
  await assert.rejects(
    asUser(db, USERS.ownerB, (tx) => insertLead(tx, wsA, { email: 'intruder@x.test' })),
    /row-level security/);
});

test('DB-11 a user cannot update or delete data of another company', async () => {
  const upd = await asUser(db, USERS.ownerB, (tx) =>
    tx.query(`update leads set full_name = 'hacked' where id = $1`, [leadA]));
  const del = await asUser(db, USERS.ownerB, (tx) => tx.query(`delete from leads where id = $1`, [leadA]));
  assert.equal(upd.affectedRows, 0);
  assert.equal(del.affectedRows, 0);
  const { rows } = await db.query('select full_name from leads where id = $1', [leadA]);
  assert.equal(rows[0].full_name, 'Test Lead');
});

test('DB-12 a user cannot move their own row into another company', async () => {
  await assert.rejects(
    asUser(db, USERS.ownerB, (tx) => tx.query(`update leads set workspace_id = $1 where workspace_id = $2`, [wsA, wsB])),
    /row-level security/);
});

test('DB-13 members of another company are not listed', async () => {
  const { rows } = await asUser(db, USERS.ownerB, (tx) => tx.query('select user_id from workspace_members'));
  assert.deepEqual(rows.map((r) => r.user_id), [USERS.ownerB]);
});

test('DB-14 anonymous visitors can read nothing', async () => {
  for (const table of ['workspaces', 'leads', 'deals', 'suppressions']) {
    await assert.rejects(asAnon(db, (tx) => tx.query(`select * from ${table}`)), /permission denied/);
  }
});

test('DB-15 cross-company references are rejected even for the service role', async () => {
  const campaignB = await asUser(db, USERS.ownerB, async (tx) =>
    (await tx.query(`insert into campaigns (workspace_id, name) values ($1, 'B campaign') returning id`, [wsB])).rows[0].id);
  await assert.rejects(
    asService(db, (tx) => insertLead(tx, wsA, { email: 'x@y.test', campaign_id: campaignB })),
    /foreign key/);
  const leadB = (await db.query('select id from leads where workspace_id = $1', [wsB])).rows[0].id;
  await assert.rejects(
    asService(db, (tx) => tx.query(
      `insert into activities (workspace_id, lead_id, type, summary, actor) values ($1, $2, 'note', 'x', 'system')`,
      [wsA, leadB])),
    /foreign key/);
});

// ---------------------------------------------------------------- roles
test('DB-16 a viewer can read but cannot write', async () => {
  const read = await asUser(db, USERS.viewerA, (tx) => tx.query('select id from leads'));
  assert.equal(read.rows.length, 1);
  await assert.rejects(asUser(db, USERS.viewerA, (tx) => insertLead(tx, wsA, { email: 'v@x.test' })), /row-level security/);
  const upd = await asUser(db, USERS.viewerA, (tx) => tx.query(`update leads set title = 'CEO' where id = $1`, [leadA]));
  assert.equal(upd.affectedRows, 0);
});

test('DB-17 a rep works leads but cannot change configuration or delete leads', async () => {
  const upd = await asUser(db, USERS.repA, (tx) => tx.query(`update leads set title = 'CEO' where id = $1`, [leadA]));
  assert.equal(upd.affectedRows, 1);
  for (const sql of [
    `insert into campaigns (workspace_id, name) values ('${wsA}', 'Rep campaign')`,
    `insert into integrations (workspace_id, tool) values ('${wsA}', 'twilio')`,
    `insert into playbooks (workspace_id, version) values ('${wsA}', 1)`,
  ]) {
    await assert.rejects(asUser(db, USERS.repA, (tx) => tx.query(sql)), /row-level security/);
  }
  const del = await asUser(db, USERS.repA, (tx) => tx.query('delete from leads where id = $1', [leadA]));
  assert.equal(del.affectedRows, 0);
});

test('DB-18 an admin manages configuration and workspace settings', async () => {
  await asUser(db, USERS.adminA, async (tx) => {
    await tx.query(`insert into campaigns (workspace_id, name) values ($1, 'UK dentists')`, [wsA]);
    await tx.query(`insert into integrations (workspace_id, tool, status) values ($1, 'twilio', 'connected')`, [wsA]);
    const r = await tx.query(`update workspaces set automation_mode = 'approval' where id = $1`, [wsA]);
    assert.equal(r.affectedRows, 1);
  });
});

test('DB-19 a rep cannot change workspace settings or the kill switch', async () => {
  const r = await asUser(db, USERS.repA, (tx) => tx.query(`update workspaces set outreach_paused = true where id = $1`, [wsA]));
  assert.equal(r.affectedRows, 0);
});

test('DB-20 only an owner can grant the owner or admin role', async () => {
  await assert.rejects(
    asUser(db, USERS.adminA, (tx) => tx.query(
      `insert into workspace_members (workspace_id, user_id, role) values ($1, $2, 'owner')`, [wsA, USERS.outsider])),
    /row-level security/);
  await assert.rejects(
    asUser(db, USERS.adminA, (tx) => tx.query(
      `update workspace_members set role = 'admin' where workspace_id = $1 and user_id = $2`, [wsA, USERS.repA])),
    /row-level security/);
  const blocked = await asUser(db, USERS.adminA, (tx) => tx.query(
    `update workspace_members set role = 'viewer' where workspace_id = $1 and user_id = $2`, [wsA, USERS.ownerA]));
  assert.equal(blocked.affectedRows, 0);
});

test('DB-21 a rep cannot add members or promote themselves', async () => {
  await assert.rejects(
    asUser(db, USERS.repA, (tx) => tx.query(
      `insert into workspace_members (workspace_id, user_id, role) values ($1, $2, 'viewer')`, [wsA, USERS.outsider])),
    /row-level security/);
  const r = await asUser(db, USERS.repA, (tx) => tx.query(
    `update workspace_members set role = 'owner' where workspace_id = $1 and user_id = $2`, [wsA, USERS.repA]));
  assert.equal(r.affectedRows, 0);
});

test('DB-22 a workspace always keeps at least one owner', async () => {
  await assert.rejects(
    asUser(db, USERS.ownerA, (tx) => tx.query(
      `update workspace_members set role = 'admin' where workspace_id = $1 and user_id = $2`, [wsA, USERS.ownerA])),
    /at least one owner/);
  await assert.rejects(
    asUser(db, USERS.ownerA, (tx) => tx.query(
      `delete from workspace_members where workspace_id = $1 and user_id = $2`, [wsA, USERS.ownerA])),
    /at least one owner/);
});

// ---------------------------------------------------------------- audit
test('DB-23 access and outreach changes are written to the audit log', async () => {
  await asUser(db, USERS.ownerA, async (tx) => {
    await tx.query(`update workspaces set outreach_paused = true where id = $1`, [wsA]);
    await tx.query(`update workspaces set enabled_channels = enabled_channels || '{"sms": false}' where id = $1`, [wsA]);
    await tx.query(`update workspace_members set role = 'rep' where workspace_id = $1 and user_id = $2`, [wsA, USERS.viewerA]);
  });
  const { rows } = await asUser(db, USERS.ownerA, (tx) =>
    tx.query(`select action, actor_id from audit_log where workspace_id = $1`, [wsA]));
  const actions = rows.map((r) => r.action);
  for (const a of ['member.added', 'outreach.paused', 'channels.changed', 'member.role_changed', 'automation.changed']) {
    assert.ok(actions.includes(a), `missing audit action ${a}`);
  }
  assert.ok(rows.some((r) => r.action === 'outreach.paused' && r.actor_id === USERS.ownerA));
});

test('DB-24 the audit log is read-only and limited to owners and admins', async () => {
  const rep = await asUser(db, USERS.repA, (tx) => tx.query('select * from audit_log'));
  assert.equal(rep.rows.length, 0);
  const other = await asUser(db, USERS.ownerB, (tx) => tx.query('select * from audit_log where workspace_id = $1', [wsA]));
  assert.equal(other.rows.length, 0);
  await assert.rejects(
    asUser(db, USERS.ownerA, (tx) => tx.query(
      `insert into audit_log (workspace_id, action, entity) values ($1, 'fake', 'x')`, [wsA])),
    /permission denied/);
  await assert.rejects(asUser(db, USERS.ownerA, (tx) => tx.query('delete from audit_log')), /permission denied/);
});

test('DB-25 run logs are written by the backend only', async () => {
  await assert.rejects(
    asUser(db, USERS.ownerA, (tx) => tx.query(
      `insert into run_logs (workspace_id, workflow, status) values ($1, 'x', 'success')`, [wsA])),
    /permission denied/);
  await asService(db, (tx) => tx.query(
    `insert into run_logs (workspace_id, workflow, status) values ($1, 'lead-sourcing', 'success')`, [wsA]));
  const owner = await asUser(db, USERS.ownerA, (tx) => tx.query('select workflow from run_logs'));
  assert.equal(owner.rows.length, 1);
  const rep = await asUser(db, USERS.repA, (tx) => tx.query('select workflow from run_logs'));
  assert.equal(rep.rows.length, 0);
});
