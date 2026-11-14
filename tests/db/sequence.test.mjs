import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { createDatabase, seedTwoWorkspaces, asUser, asAnon, asService, insertLead, USERS } from './helpers.mjs';

let db, wsA, wsB, camp, stepA, stepB;

before(async () => {
  db = await createDatabase();
  ({ wsA, wsB } = await seedTwoWorkspaces(db));
  camp = (await db.query(`insert into campaigns (workspace_id, name, niche) values ($1, 'Austin', 'dentists') returning id`, [wsA])).rows[0].id;
  stepA = (await asUser(db, USERS.ownerA, (tx) => tx.query(
    `insert into sequence_steps (workspace_id, campaign_id, position, channel, wait_hours, condition)
     values ($1, $2, 1, 'email', 0, '{}'::jsonb) returning id`, [wsA, camp]))).rows[0].id;
  stepB = (await asUser(db, USERS.ownerA, (tx) => tx.query(
    `insert into sequence_steps (workspace_id, campaign_id, position, channel, wait_hours, condition, is_last)
     values ($1, $2, 2, 'sms', 48, '{"all":[{"fact":"replied","is":false}]}'::jsonb, true) returning id`, [wsA, camp]))).rows[0].id;
});

const candidates = (ws = wsA, campaign = camp) =>
  asService(db, (tx) => tx.query(`select * from sequence_candidates($1, $2, 100)`, [ws, campaign]));
const factsFor = async (leadId) => {
  const rows = (await candidates()).rows;
  return rows.find((r) => r.lead_id === leadId)?.facts;
};

test('SEQB-01 members read the sequence; only owners and admins change it', async () => {
  assert.equal((await asUser(db, USERS.viewerA, (tx) => tx.query('select id from sequence_steps'))).rows.length, 2);
  await assert.rejects(asUser(db, USERS.viewerA, (tx) => tx.query(
    `insert into sequence_steps (workspace_id, campaign_id, position, channel) values ($1, $2, 9, 'email')`, [wsA, camp])), /row-level security/);
  await assert.rejects(asUser(db, USERS.repA, (tx) => tx.query(
    `insert into sequence_steps (workspace_id, campaign_id, position, channel) values ($1, $2, 9, 'email')`, [wsA, camp])), /row-level security/);
  await asUser(db, USERS.ownerA, (tx) => tx.query(
    `insert into sequence_variants (workspace_id, step_id, label, subject, body) values ($1, $2, 'a', 'Hello', 'Body a')`, [wsA, stepA]));
  assert.equal((await asUser(db, USERS.viewerA, (tx) => tx.query('select id from sequence_variants'))).rows.length, 1);
});

test('SEQB-02 another workspace sees nothing and cannot write here', async () => {
  assert.equal((await asUser(db, USERS.ownerB, (tx) => tx.query('select id from sequence_steps'))).rows.length, 0);
  await assert.rejects(asUser(db, USERS.ownerB, (tx) => tx.query(
    `insert into sequence_steps (workspace_id, campaign_id, position, channel) values ($1, $2, 5, 'email')`, [wsA, camp])), /row-level security/);
});

test('SEQB-03 a position is used once per campaign, and a variant label once per step', async () => {
  await assert.rejects(asUser(db, USERS.ownerA, (tx) => tx.query(
    `insert into sequence_steps (workspace_id, campaign_id, position, channel) values ($1, $2, 1, 'email')`, [wsA, camp])), /duplicate key|unique/i);
  await assert.rejects(asUser(db, USERS.ownerA, (tx) => tx.query(
    `insert into sequence_variants (workspace_id, step_id, label, body) values ($1, $2, 'a', 'Another a')`, [wsA, stepA])), /duplicate key|unique/i);
  await assert.rejects(asUser(db, USERS.ownerA, (tx) => tx.query(
    `insert into sequence_variants (workspace_id, step_id, label, body) values ($1, $2, 'd', 'Fourth')`, [wsA, stepA])), /violates check constraint/i);
});

test('SEQB-04 a fresh lead has no touches, so the first step is not held back', async () => {
  const lead = await asUser(db, USERS.repA, (tx) => insertLead(tx, wsA, { email: 'fresh@acme.test' }));
  await db.query(`update leads set campaign_id = $2, verification_status = 'valid' where id = $1`, [lead, camp]);
  const f = await factsFor(lead);
  assert.equal(f.hours_since_last_touch, null, 'never contacted');
  assert.deepEqual(
    { emails_sent: Number(f.emails_sent), replied: f.replied, has_email: f.has_email, steps_run: Number(f.steps_run), stopped: f.stopped },
    { emails_sent: 0, replied: false, has_email: true, steps_run: 0, stopped: false },
  );
  assert.deepEqual(f.steps_done, []);
});

test('SEQB-05 the facts follow what actually happened on each channel', async () => {
  const lead = await asUser(db, USERS.repA, (tx) => insertLead(tx, wsA, { email: 'busy@acme.test' }));
  await db.query(`update leads set campaign_id = $2, verification_status = 'valid', phone = '+15125550111' where id = $1`, [lead, camp]);
  await asService(db, (tx) => tx.query(
    `insert into emails (workspace_id, lead_id, campaign_id, step, subject, body, status, sent_at, idempotency_key)
     values ($1, $2, $3, 1, 'Hi', 'Body', 'sent', now() - interval '50 hours', 'k-email-1')`, [wsA, lead, camp]));
  await asService(db, (tx) => tx.query(
    `insert into calls (workspace_id, lead_id, campaign_id, agent, direction, outcome, status, ended_at, idempotency_key)
     values ($1, $2, $3, 'caller', 'outbound', 'voicemail', 'ended', now() - interval '3 hours', 'k-call-1')`, [wsA, lead, camp]));
  await asService(db, (tx) => tx.query(
    `insert into messages (workspace_id, lead_id, channel, direction, body, idempotency_key)
     values ($1, $2, 'sms', 'outbound', 'A text', 'k-sms-1')`, [wsA, lead]));

  const f = await factsFor(lead);
  assert.equal(Number(f.emails_sent), 1);
  assert.equal(Number(f.calls_made), 1);
  assert.equal(f.call_outcome, 'voicemail');
  assert.equal(f.has_phone, true);
  // The most recent touch of any kind governs the wait: the call three hours ago
  assert.ok(f.hours_since_last_touch >= 2 && f.hours_since_last_touch <= 4, `expected about 3, got ${f.hours_since_last_touch}`);

  await asService(db, (tx) => tx.query(
    `insert into replies (workspace_id, lead_id, channel, body, classification) values ($1, $2, 'email', 'Tell me more', 'interested')`, [wsA, lead]));
  const after = await factsFor(lead);
  assert.equal(after.replied, true);
  assert.equal(after.reply_type, 'interested');
});

test('SEQB-06 leads nobody should contact again are never candidates', async () => {
  const done = await asUser(db, USERS.repA, (tx) => insertLead(tx, wsA, { email: 'won@acme.test' }));
  const out = await asUser(db, USERS.repA, (tx) => insertLead(tx, wsA, { email: 'nope@acme.test' }));
  const supp = await asUser(db, USERS.repA, (tx) => insertLead(tx, wsA, { email: 'quiet@acme.test' }));
  await db.query(`update leads set campaign_id = $1 where id = any($2::uuid[])`, [camp, [done, out, supp]]);
  await db.query(`update leads set stage = 'won' where id = $1`, [done]);
  await db.query(`update leads set stage = 'do_not_contact' where id = $1`, [out]);
  await asUser(db, USERS.ownerA, (tx) => tx.query(
    `insert into suppressions (workspace_id, kind, value, reason) values ($1, 'email', 'quiet@acme.test', 'unsubscribed')`, [wsA]));

  const ids = (await candidates()).rows.map((r) => r.lead_id);
  for (const [id, why] of [[done, 'won'], [out, 'do-not-contact'], [supp, 'suppressed']]) {
    assert.ok(!ids.includes(id), `a ${why} lead must not be a candidate`);
  }
});

test('SEQB-07 a step runs once per lead, however often it is recorded', async () => {
  const lead = await asUser(db, USERS.repA, (tx) => insertLead(tx, wsA, { email: 'once@acme.test' }));
  await db.query(`update leads set campaign_id = $2, verification_status = 'valid' where id = $1`, [lead, camp]);
  assert.equal((await asService(db, (tx) => tx.query(
    `select lead_step_record($1, $2, $3, 'a', 'sent', null) as r`, [wsA, lead, stepA]))).rows[0].r, true);
  assert.equal((await asService(db, (tx) => tx.query(
    `select lead_step_record($1, $2, $3, 'b', 'sent', null) as r`, [wsA, lead, stepA]))).rows[0].r, false, 'the second attempt changes nothing');
  assert.equal((await db.query(`select count(*)::int n from lead_step_runs where lead_id = $1`, [lead])).rows[0].n, 1);
  assert.equal((await db.query(`select variant_label from lead_step_runs where lead_id = $1`, [lead])).rows[0].variant_label, 'a');

  const f = await factsFor(lead);
  assert.deepEqual(f.steps_done, [stepA]);
  assert.equal(Number(f.steps_run), 1);
  assert.equal(f.stopped, false, 'step 1 is not the last step');
});

test('SEQB-08 running the last step stops the sequence for that lead', async () => {
  const lead = await asUser(db, USERS.repA, (tx) => insertLead(tx, wsA, { email: 'final@acme.test' }));
  await db.query(`update leads set campaign_id = $2, verification_status = 'valid' where id = $1`, [lead, camp]);
  await asService(db, (tx) => tx.query(`select lead_step_record($1, $2, $3, 'a', 'sent', null)`, [wsA, lead, stepB]));
  assert.equal((await factsFor(lead)).stopped, true);
});

test('SEQB-09 a skipped or failed step does not count as stopping or as a send', async () => {
  const lead = await asUser(db, USERS.repA, (tx) => insertLead(tx, wsA, { email: 'failed@acme.test' }));
  await db.query(`update leads set campaign_id = $2, verification_status = 'valid' where id = $1`, [lead, camp]);
  await asService(db, (tx) => tx.query(
    `select lead_step_record($1, $2, $3, 'a', 'failed', 'Twilio refused the number')`, [wsA, lead, stepB]));
  const f = await factsFor(lead);
  assert.equal(f.stopped, false, 'a failed last step has not stopped anything');
  assert.equal(Number(f.steps_run), 0, 'only sends count');
  assert.deepEqual(f.steps_done, [stepB], 'but it is not tried again');
});

test('SEQB-10 what was sent is a record: members read it and nobody edits it', async () => {
  assert.ok((await asUser(db, USERS.viewerA, (tx) => tx.query('select id from lead_step_runs'))).rows.length > 0);
  assert.equal((await asUser(db, USERS.ownerB, (tx) => tx.query('select id from lead_step_runs'))).rows.length, 0);
  await assert.rejects(asUser(db, USERS.ownerA, (tx) => tx.query(
    `update lead_step_runs set outcome = 'sent'`)), /permission denied|row-level security/);
  await assert.rejects(asUser(db, USERS.ownerA, (tx) => tx.query('delete from lead_step_runs')), /permission denied|row-level security/);
});

test('SEQB-11 deleting a step takes its variants and its history with it', async () => {
  const temp = (await asUser(db, USERS.ownerA, (tx) => tx.query(
    `insert into sequence_steps (workspace_id, campaign_id, position, channel) values ($1, $2, 7, 'email') returning id`, [wsA, camp]))).rows[0].id;
  await asUser(db, USERS.ownerA, (tx) => tx.query(
    `insert into sequence_variants (workspace_id, step_id, label, subject, body) values ($1, $2, 'a', 'S', 'B')`, [wsA, temp]));
  const lead = await asUser(db, USERS.repA, (tx) => insertLead(tx, wsA, { email: 'cascade@acme.test' }));
  await db.query(`update leads set campaign_id = $2 where id = $1`, [lead, camp]);
  await asService(db, (tx) => tx.query(`select lead_step_record($1, $2, $3, 'a', 'sent', null)`, [wsA, lead, temp]));

  await asUser(db, USERS.ownerA, (tx) => tx.query(`delete from sequence_steps where workspace_id = $1 and id = $2`, [wsA, temp]));
  assert.equal((await db.query(`select count(*)::int n from sequence_variants where step_id = $1`, [temp])).rows[0].n, 0);
  assert.equal((await db.query(`select count(*)::int n from lead_step_runs where step_id = $1`, [temp])).rows[0].n, 0);
});

test('SEQB-12 the campaign carries the two new switches, off by default', async () => {
  const row = (await db.query(`select branching_enabled, open_tracking from campaigns where id = $1`, [camp])).rows[0];
  assert.deepEqual(row, { branching_enabled: false, open_tracking: false });
  await asUser(db, USERS.ownerA, (tx) => tx.query(`update campaigns set branching_enabled = true where workspace_id = $1 and id = $2`, [wsA, camp]));
  assert.equal((await db.query(`select branching_enabled from campaigns where id = $1`, [camp])).rows[0].branching_enabled, true);
});

test('SEQB-13 a visitor cannot read the sequence or record a step', async () => {
  await assert.rejects(asAnon(db, (tx) => tx.query('select * from sequence_steps')), /permission denied/);
  await assert.rejects(asAnon(db, (tx) => tx.query('select * from sequence_variants')), /permission denied/);
  await assert.rejects(asAnon(db, (tx) => tx.query('select * from lead_step_runs')), /permission denied/);
  await assert.rejects(asAnon(db, (tx) => tx.query(`select lead_step_record($1, $1, $1, 'a', 'sent', null)`, [wsA])), /permission denied/);
  await assert.rejects(asAnon(db, (tx) => tx.query(`select * from sequence_candidates($1, $1, 10)`, [wsA])), /permission denied/);
});
