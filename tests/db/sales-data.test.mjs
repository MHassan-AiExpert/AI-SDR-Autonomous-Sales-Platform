import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { createDatabase, seedTwoWorkspaces, asUser, asService, insertLead, USERS } from './helpers.mjs';

let db, wsA, wsB, leadA;

before(async () => {
  db = await createDatabase();
  ({ wsA, wsB } = await seedTwoWorkspaces(db));
  leadA = await asUser(db, USERS.repA, (tx) => insertLead(tx, wsA, { email: 'jane@acme.test', phone: '+15550001' }));
});

// ---------------------------------------------------------------- leads
test('DB-26 one lead per email per company, case-insensitive', async () => {
  await assert.rejects(
    asUser(db, USERS.repA, (tx) => insertLead(tx, wsA, { email: 'JANE@Acme.test' })),
    /duplicate key/);
});

test('DB-27 the same email can be a lead in two different companies', async () => {
  const id = await asUser(db, USERS.ownerB, (tx) => insertLead(tx, wsB, { email: 'jane@acme.test' }));
  assert.ok(id);
});

test('DB-28 a lead needs at least one way to be contacted', async () => {
  await assert.rejects(
    asUser(db, USERS.repA, (tx) => tx.query(
      `insert into leads (workspace_id, full_name, source_channel) values ($1, 'No Contact', 'csv')`, [wsA])),
    /leads_contact_present/);
  const social = await asUser(db, USERS.repA, (tx) =>
    insertLead(tx, wsA, { email: null, social_handles: JSON.stringify({ instagram: '@shop' }), source_channel: 'instagram' }));
  assert.ok(social);
});

test('DB-29 score, stage and source channel are validated', async () => {
  for (const bad of [{ score: 101 }, { score: -1 }, { stage: 'vip' }, { source_channel: 'myspace' }]) {
    await assert.rejects(
      asUser(db, USERS.repA, (tx) => insertLead(tx, wsA, { email: `bad${Math.random()}@x.test`, ...bad })),
      /check constraint/);
  }
});

test('DB-30 every supported source channel is accepted', async () => {
  const channels = ['apollo', 'clay', 'google_maps', 'instagram', 'facebook', 'linkedin', 'tiktok', 'x',
    'llm_search', 'csv', 'inbound_call', 'manual'];
  await asUser(db, USERS.repA, async (tx) => {
    for (const c of channels) await insertLead(tx, wsA, { email: `${c}@src.test`, source_channel: c });
  });
  const { rows } = await db.query(
    `select source_channel, count(*)::int as n from leads where workspace_id = $1 and email like '%@src.test' group by 1`, [wsA]);
  assert.equal(rows.length, channels.length);
});

test('DB-31 changing the stage records when it changed', async () => {
  await db.query(`update leads set stage_changed_at = now() - interval '2 days' where id = $1`, [leadA]);
  await asUser(db, USERS.repA, (tx) => tx.query(`update leads set title = 'Founder' where id = $1`, [leadA]));
  const unchanged = (await db.query(`select stage_changed_at < now() - interval '1 day' as old from leads where id = $1`, [leadA])).rows[0];
  assert.equal(unchanged.old, true);
  await asUser(db, USERS.repA, (tx) => tx.query(`update leads set stage = 'contacted' where id = $1`, [leadA]));
  const changed = (await db.query(`select stage_changed_at > now() - interval '1 minute' as fresh from leads where id = $1`, [leadA])).rows[0];
  assert.equal(changed.fresh, true);
});

test('DB-32 deleting a campaign keeps its leads', async () => {
  const { campaign, lead } = await asUser(db, USERS.ownerA, async (tx) => {
    const campaign = (await tx.query(`insert into campaigns (workspace_id, name) values ($1, 'Temp') returning id`, [wsA])).rows[0].id;
    const lead = await insertLead(tx, wsA, { email: 'camp@x.test', campaign_id: campaign });
    return { campaign, lead };
  });
  await asUser(db, USERS.ownerA, (tx) => tx.query('delete from campaigns where id = $1', [campaign]));
  const { rows } = await db.query('select campaign_id, workspace_id from leads where id = $1', [lead]);
  assert.equal(rows[0].campaign_id, null);
  assert.equal(rows[0].workspace_id, wsA);
});

// ---------------------------------------------------------------- timeline
test('DB-33 a full lead journey is stored and read back as one timeline', async () => {
  await asUser(db, USERS.repA, async (tx) => {
    await tx.query(`insert into emails (workspace_id, lead_id, subject, body, status, idempotency_key) values ($1,$2,'Your audit','Hi Jane','sent','e-1')`, [wsA, leadA]);
    await tx.query(`insert into calls (workspace_id, lead_id, agent, direction, outcome, duration_seconds, idempotency_key) values ($1,$2,'caller','outbound','booked',180,'c-1')`, [wsA, leadA]);
    await tx.query(`insert into messages (workspace_id, lead_id, channel, direction, body, idempotency_key) values ($1,$2,'whatsapp','outbound','Here is your proposal','m-1')`, [wsA, leadA]);
    await tx.query(`insert into replies (workspace_id, lead_id, channel, body, classification, confidence, handled_by) values ($1,$2,'whatsapp','Sounds good','interested',0.94,'ai')`, [wsA, leadA]);
    await tx.query(`insert into meetings (workspace_id, lead_id, starts_at, booked_via) values ($1,$2, now() + interval '2 days','call')`, [wsA, leadA]);
    await tx.query(`insert into assets (workspace_id, lead_id, type, web_url) values ($1,$2,'audit','https://example.test/a'),($1,$2,'proposal','https://example.test/p')`, [wsA, leadA]);
    await tx.query(`insert into follow_ups (workspace_id, lead_id, channel, due_at, cadence_step) values ($1,$2,'email', now() + interval '3 days', 2)`, [wsA, leadA]);
    for (const [type, summary] of [['email', 'Sent audit email'], ['call', 'Cold call: booked'], ['whatsapp', 'Sent proposal'], ['reply', 'Interested'], ['meeting', 'Zoom booked']]) {
      await tx.query(`insert into activities (workspace_id, lead_id, type, summary, actor) values ($1,$2,$3,$4,'ai')`, [wsA, leadA, type, summary]);
    }
  });
  const { rows } = await asUser(db, USERS.viewerA, (tx) =>
    tx.query('select type from activities where lead_id = $1 order by created_at', [leadA]));
  assert.equal(rows.length, 5);
  const other = await asUser(db, USERS.ownerB, (tx) => tx.query('select 1 from activities'));
  assert.equal(other.rows.length, 0);
});

test('DB-34 a retried send with the same idempotency key is rejected', async () => {
  for (const sql of [
    `insert into emails (workspace_id, lead_id, subject, body, idempotency_key) values ('${wsA}','${leadA}','Dup','Dup','e-1')`,
    `insert into calls (workspace_id, lead_id, agent, direction, idempotency_key) values ('${wsA}','${leadA}','caller','outbound','c-1')`,
    `insert into messages (workspace_id, lead_id, channel, direction, body, idempotency_key) values ('${wsA}','${leadA}','sms','outbound','Dup','m-1')`,
  ]) {
    await assert.rejects(asService(db, (tx) => tx.query(sql)), /duplicate key/);
  }
});

test('DB-35 call agents, outcomes and reply classes are validated', async () => {
  for (const sql of [
    `insert into calls (workspace_id, lead_id, agent, direction, idempotency_key) values ('${wsA}','${leadA}','robot','outbound','c-x')`,
    `insert into calls (workspace_id, lead_id, agent, direction, outcome, idempotency_key) values ('${wsA}','${leadA}','closer','outbound','maybe','c-y')`,
    `insert into replies (workspace_id, lead_id, channel, body, classification) values ('${wsA}','${leadA}','email','x','spam')`,
    `insert into replies (workspace_id, lead_id, channel, body, confidence) values ('${wsA}','${leadA}','email','x',1.5)`,
  ]) {
    await assert.rejects(asService(db, (tx) => tx.query(sql)), /check constraint/);
  }
  await asService(db, (tx) => tx.query(
    `insert into calls (workspace_id, lead_id, agent, direction, idempotency_key) values ($1,$2,'receptionist','inbound','c-in'),($1,$2,'closer','outbound','c-cl')`, [wsA, leadA]));
});

// ---------------------------------------------------------------- deals
test('DB-36 a lead has one sales record that moves through the pipeline', async () => {
  await asUser(db, USERS.repA, async (tx) => {
    await tx.query(`insert into deals (workspace_id, lead_id, value_cents, source_channel) values ($1,$2,250000,'apollo')`, [wsA, leadA]);
    await tx.query(`update deals set stage = 'won', agreement_status = 'signed', payment_status = 'paid', closed_by = 'ai', closed_at = now() where lead_id = $1`, [leadA]);
  });
  const { rows } = await db.query('select stage, closed_by, value_cents from deals where lead_id = $1', [leadA]);
  assert.deepEqual(rows[0], { stage: 'won', closed_by: 'ai', value_cents: 250000 });
  await assert.rejects(
    asUser(db, USERS.repA, (tx) => tx.query(`insert into deals (workspace_id, lead_id) values ($1,$2)`, [wsA, leadA])),
    /duplicate key/);
  await assert.rejects(
    asUser(db, USERS.repA, (tx) => tx.query(`update deals set stage = 'free' where lead_id = $1`, [leadA])),
    /check constraint/);
});

// ---------------------------------------------------------------- suppression
test('DB-37 suppression matches email, domain and phone inside one company only', async () => {
  await asUser(db, USERS.repA, (tx) => tx.query(
    `insert into suppressions (workspace_id, kind, value, reason) values
       ($1,'email','stop@acme.test','unsubscribed'),
       ($1,'domain','competitor.test','competitor'),
       ($1,'phone','+15559999','do_not_call')`, [wsA]));
  const check = async (ws, email, phone, user = USERS.repA) =>
    (await asUser(db, user, (tx) => tx.query('select app.is_suppressed($1,$2,$3) as s', [ws, email, phone]))).rows[0].s;
  assert.equal(await check(wsA, 'STOP@acme.test', null), true);
  assert.equal(await check(wsA, 'anyone@competitor.test', null), true);
  assert.equal(await check(wsA, null, '+15559999'), true);
  assert.equal(await check(wsA, 'ok@acme.test', '+15550000'), false);
  assert.equal(await check(wsB, 'stop@acme.test', '+15559999', USERS.ownerB), false);
  // Another company cannot probe this company's list
  assert.equal(await check(wsA, 'stop@acme.test', null, USERS.ownerB), false);
});

test('DB-38 suppression entries are normalised and unique', async () => {
  await assert.rejects(
    asUser(db, USERS.repA, (tx) => tx.query(
      `insert into suppressions (workspace_id, kind, value, reason) values ($1,'email','Mixed@Case.test','manual')`, [wsA])),
    /check constraint/);
  await assert.rejects(
    asUser(db, USERS.repA, (tx) => tx.query(
      `insert into suppressions (workspace_id, kind, value, reason) values ($1,'email','stop@acme.test','manual')`, [wsA])),
    /duplicate key/);
});

// ---------------------------------------------------------------- configuration
test('DB-39 only one playbook version is live per company', async () => {
  await asUser(db, USERS.ownerA, (tx) => tx.query(
    `insert into playbooks (workspace_id, version, is_active) values ($1,1,true),($1,2,false)`, [wsA]));
  await assert.rejects(
    asUser(db, USERS.ownerA, (tx) => tx.query(`update playbooks set is_active = true where workspace_id = $1 and version = 2`, [wsA])),
    /duplicate key/);
  await asUser(db, USERS.ownerA, async (tx) => {
    await tx.query(`update playbooks set is_active = false where workspace_id = $1 and version = 1`, [wsA]);
    await tx.query(`update playbooks set is_active = true where workspace_id = $1 and version = 2`, [wsA]);
  });
  const { rows } = await db.query('select version from playbooks where workspace_id = $1 and is_active', [wsA]);
  assert.deepEqual(rows, [{ version: 2 }]);
});

test('DB-40 each tool is connected once per company and stores no secret', async () => {
  await asUser(db, USERS.ownerA, (tx) => tx.query(
    `insert into integrations (workspace_id, tool, status, secret_ref) values ($1,'twilio','connected','vault:abc')`, [wsA]));
  await assert.rejects(
    asUser(db, USERS.ownerA, (tx) => tx.query(`insert into integrations (workspace_id, tool) values ($1,'twilio')`, [wsA])),
    /duplicate key/);
  await asUser(db, USERS.ownerB, (tx) => tx.query(`insert into integrations (workspace_id, tool) values ($1,'twilio')`, [wsB]));
  const { rows } = await db.query(
    `select column_name from information_schema.columns where table_name = 'integrations' and column_name ~ '(secret|token|key|password)'`);
  assert.deepEqual(rows.map((r) => r.column_name), ['secret_ref']);
});

// ---------------------------------------------------------------- lifecycle
test('DB-41 updated_at moves forward on change', async () => {
  await db.query(`update leads set updated_at = now() - interval '1 hour' where id = $1`, [leadA]);
  await asUser(db, USERS.repA, (tx) => tx.query(`update leads set niche = 'dental' where id = $1`, [leadA]));
  const { rows } = await db.query(`select updated_at > now() - interval '1 minute' as fresh from leads where id = $1`, [leadA]);
  assert.equal(rows[0].fresh, true);
});

test('DB-42 deleting a company workspace removes all of its data and nothing else', async () => {
  const before = (await db.query('select count(*)::int as n from leads where workspace_id = $1', [wsB])).rows[0].n;
  await asUser(db, USERS.ownerA, (tx) => tx.query('delete from workspaces where id = $1', [wsA]));
  for (const table of ['workspace_members', 'leads', 'activities', 'emails', 'calls', 'messages', 'deals',
    'suppressions', 'playbooks', 'integrations', 'audit_log', 'campaigns']) {
    const { rows } = await db.query(`select count(*)::int as n from ${table} where workspace_id = $1`, [wsA]);
    assert.equal(rows[0].n, 0, `${table} still has rows`);
  }
  const after = (await db.query('select count(*)::int as n from leads where workspace_id = $1', [wsB])).rows[0].n;
  assert.equal(after, before);
});
