import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { createDatabase, seedTwoWorkspaces, asUser, asAnon, asService, USERS } from './helpers.mjs';

let db, wsA, wsB;

before(async () => {
  db = await createDatabase();
  ({ wsA, wsB } = await seedTwoWorkspaces(db));
});

const connect = (user, ws, tool, secret, extra = {}) =>
  asUser(db, user, (tx) => tx.query(
    'select integration_connect($1, $2, $3::jsonb, $4::jsonb, $5, $6, $7) as id',
    [ws, tool, JSON.stringify(secret), JSON.stringify(extra.meta ?? {}), extra.status ?? 'connected', extra.error ?? null, extra.credits ?? null]));
const secretOf = (ws, tool) =>
  asService(db, async (tx) => (await tx.query('select integration_secret($1, $2) as s', [ws, tool])).rows[0].s);
const row = async (ws, tool) =>
  (await db.query('select * from integrations where workspace_id = $1 and tool = $2', [ws, tool])).rows[0];

test('INT-01 an owner connects a tool; the secret goes to the vault, not the table', async () => {
  await connect(USERS.ownerA, wsA, 'openai', { api_key: 'sk-test-A' }, { meta: { hint: '•••• st-A' } });
  const r = await row(wsA, 'openai');
  assert.equal(r.status, 'connected');
  assert.ok(r.last_health_check_at);
  assert.deepEqual(r.meta, { hint: '•••• st-A' });
  assert.doesNotMatch(JSON.stringify(r), /sk-test-A/);
  assert.deepEqual(await secretOf(wsA, 'openai'), { api_key: 'sk-test-A' });
});

test('INT-02 an admin can connect tools; reps, viewers and outsiders cannot', async () => {
  await connect(USERS.adminA, wsA, 'slack', { bot_token: 'xoxb-A' });
  for (const user of [USERS.repA, USERS.viewerA, USERS.ownerB, USERS.outsider]) {
    await assert.rejects(connect(user, wsA, 'twilio', { auth_token: 'x' }), /Only owners and admins/);
  }
  assert.equal(await row(wsA, 'twilio'), undefined);
});

test('INT-03 reconnecting replaces the secret and keeps one row and one vault entry', async () => {
  await connect(USERS.ownerA, wsA, 'openai', { api_key: 'sk-test-A2' });
  assert.deepEqual(await secretOf(wsA, 'openai'), { api_key: 'sk-test-A2' });
  const rows = (await db.query(`select count(*)::int n from integrations where workspace_id = $1 and tool = 'openai'`, [wsA])).rows[0].n;
  const secrets = (await db.query(`select count(*)::int n from vault.secrets where name like $1`, [`integration:${wsA}:openai`])).rows[0].n;
  assert.equal(rows, 1);
  assert.equal(secrets, 1);
});

test('INT-04 each company has its own credentials for the same tool', async () => {
  await connect(USERS.ownerB, wsB, 'openai', { api_key: 'sk-test-B' });
  assert.deepEqual(await secretOf(wsA, 'openai'), { api_key: 'sk-test-A2' });
  assert.deepEqual(await secretOf(wsB, 'openai'), { api_key: 'sk-test-B' });
});

test('INT-05 signed-in users can never read a decrypted secret', async () => {
  for (const user of [USERS.ownerA, USERS.adminA, USERS.ownerB]) {
    await assert.rejects(asUser(db, user, (tx) => tx.query('select integration_secret($1, $2)', [wsA, 'openai'])), /permission denied/);
    await assert.rejects(asUser(db, user, (tx) => tx.query('select * from vault.decrypted_secrets')), /permission denied/);
    await assert.rejects(asUser(db, user, (tx) => tx.query('select * from vault.secrets')), /permission denied/);
  }
});

test('INT-06 anonymous visitors cannot call any integration function', async () => {
  for (const sql of [
    `select integration_connect('${wsA}', 'openai', '{"api_key":"x"}'::jsonb)`,
    `select integration_disconnect('${wsA}', 'openai')`,
    `select integration_secret('${wsA}', 'openai')`,
    `select integration_health_update('${wsA}', 'openai', 'error')`,
  ]) {
    await assert.rejects(asAnon(db, (tx) => tx.query(sql)), /permission denied/);
  }
});

test('INT-07 clients cannot write the integrations table directly', async () => {
  for (const sql of [
    `insert into integrations (workspace_id, tool) values ('${wsA}', 'stripe')`,
    `update integrations set secret_ref = 'someone-elses-secret' where workspace_id = '${wsA}'`,
    `delete from integrations where workspace_id = '${wsA}'`,
  ]) {
    await assert.rejects(asUser(db, USERS.ownerA, (tx) => tx.query(sql)), /permission denied/);
  }
});

test('INT-08 members see connection status; other companies see nothing', async () => {
  const mine = await asUser(db, USERS.viewerA, (tx) => tx.query('select tool, status from integrations order by tool'));
  assert.deepEqual(mine.rows.map((r) => r.tool), ['openai', 'slack']);
  const other = await asUser(db, USERS.outsider, (tx) => tx.query('select tool from integrations'));
  assert.equal(other.rows.length, 0);
});

test('INT-09 a failed connection test is stored as an error with its message', async () => {
  await connect(USERS.ownerA, wsA, 'twilio', { account_sid: 'AC1', auth_token: 'bad' }, { status: 'error', error: 'The credentials were rejected by Twilio.' });
  const r = await row(wsA, 'twilio');
  assert.equal(r.status, 'error');
  assert.equal(r.last_error, 'The credentials were rejected by Twilio.');
});

test('INT-10 credits reported by the tool are stored', async () => {
  await connect(USERS.ownerA, wsA, 'zerobounce', { api_key: 'zb' }, { credits: 2500 });
  assert.equal(Number((await row(wsA, 'zerobounce')).credits_remaining), 2500);
});

test('INT-11 unknown tools, empty or oversized credentials and bad statuses are rejected', async () => {
  await assert.rejects(connect(USERS.ownerA, wsA, 'myspace', { api_key: 'x' }), /check constraint/);
  await assert.rejects(connect(USERS.ownerA, wsA, 'stripe', {}), /Invalid credentials/);
  await assert.rejects(connect(USERS.ownerA, wsA, 'stripe', { secret_key: 'x'.repeat(9000) }), /Invalid credentials/);
  await assert.rejects(connect(USERS.ownerA, wsA, 'stripe', { secret_key: 'x' }, { status: 'disconnected' }), /Invalid connection status/);
  const leftovers = (await db.query(`select count(*)::int n from vault.secrets where name like '%:myspace' or name like '%:stripe'`)).rows[0].n;
  assert.equal(leftovers, 0);
});

test('INT-12 disconnecting deletes the secret and marks the tool disconnected', async () => {
  await asUser(db, USERS.adminA, (tx) => tx.query('select integration_disconnect($1, $2)', [wsA, 'slack']));
  const r = await row(wsA, 'slack');
  assert.equal(r.status, 'disconnected');
  assert.equal(r.secret_ref, null);
  assert.equal(await secretOf(wsA, 'slack'), null);
  const secrets = (await db.query(`select count(*)::int n from vault.secrets where name = $1`, [`integration:${wsA}:slack`])).rows[0].n;
  assert.equal(secrets, 0);
});

test('INT-13 a rep cannot disconnect a tool, and another company cannot disconnect ours', async () => {
  for (const user of [USERS.repA, USERS.ownerB]) {
    await assert.rejects(asUser(db, user, (tx) => tx.query('select integration_disconnect($1, $2)', [wsA, 'openai'])), /Only owners and admins/);
  }
  assert.deepEqual(await secretOf(wsA, 'openai'), { api_key: 'sk-test-A2' });
});

test('INT-14 the backend records scheduled health checks', async () => {
  await asService(db, (tx) => tx.query(`select integration_health_update($1, 'openai', 'expired', 'Token expired', 12)`, [wsA]));
  let r = await row(wsA, 'openai');
  assert.equal(r.status, 'expired');
  assert.equal(r.last_error, 'Token expired');
  assert.equal(Number(r.credits_remaining), 12);
  await asService(db, (tx) => tx.query(`select integration_health_update($1, 'openai', 'connected')`, [wsA]));
  r = await row(wsA, 'openai');
  assert.equal(r.status, 'connected');
  assert.equal(r.last_error, null);
  await assert.rejects(
    asUser(db, USERS.ownerA, (tx) => tx.query(`select integration_health_update($1, 'openai', 'connected')`, [wsA])),
    /permission denied/);
});

test('INT-15 a health check does not revive a disconnected tool', async () => {
  await asService(db, (tx) => tx.query(`select integration_health_update($1, 'slack', 'connected')`, [wsA]));
  assert.equal((await row(wsA, 'slack')).status, 'disconnected');
});

test('INT-16 connecting and disconnecting are written to the audit log', async () => {
  const { rows } = await asUser(db, USERS.ownerA, (tx) =>
    tx.query(`select action, entity_id from audit_log where workspace_id = $1 and entity = 'integration'`, [wsA]));
  assert.ok(rows.some((r) => r.action === 'integration.connected' && r.entity_id === 'openai'));
  assert.ok(rows.some((r) => r.action === 'integration.disconnected' && r.entity_id === 'slack'));
  assert.doesNotMatch(JSON.stringify(rows), /sk-test/);
});

test('INT-17 deleting a workspace deletes its encrypted credentials', async () => {
  await asUser(db, USERS.ownerB, (tx) => tx.query('delete from workspaces where id = $1', [wsB]));
  assert.equal(await secretOf(wsB, 'openai'), null);
  const left = (await db.query(`select count(*)::int n from vault.secrets where name like $1`, [`integration:${wsB}:%`])).rows[0].n;
  assert.equal(left, 0);
  const kept = (await db.query(`select count(*)::int n from vault.secrets where name like $1`, [`integration:${wsA}:%`])).rows[0].n;
  assert.ok(kept > 0);
});

test('INT-18 owners and admins tick off manual setup steps; reps cannot', async () => {
  const ok = await asUser(db, USERS.adminA, (tx) =>
    tx.query(`update workspaces set setup_checklist = setup_checklist || '{"sending_domains": true}' where id = $1`, [wsA]));
  assert.equal(ok.affectedRows, 1);
  const no = await asUser(db, USERS.repA, (tx) =>
    tx.query(`update workspaces set setup_checklist = '{}' where id = $1`, [wsA]));
  assert.equal(no.affectedRows, 0);
  const { rows } = await db.query('select setup_checklist from workspaces where id = $1', [wsA]);
  assert.deepEqual(rows[0].setup_checklist, { sending_domains: true });
});
