import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { createDatabase, seedTwoWorkspaces, asService, insertLead } from './helpers.mjs';

let db, wsA, wsB, camp, lead;
const NUM = '44444444-4444-4444-8444-444444444444';

before(async () => {
  db = await createDatabase();
  ({ wsA, wsB } = await seedTwoWorkspaces(db));
  camp = (await db.query(`insert into campaigns (workspace_id, name, niche, status) values ($1, 'C', 'dentists', 'active') returning id`, [wsA])).rows[0].id;
  lead = await asService(db, (tx) => insertLead(tx, wsA, { email: 'kim@bright.com' }));
});

test('RC-01 the receptionist is off by default and its settings are validated', async () => {
  assert.equal((await db.query('select receptionist_status from campaigns where id = $1', [camp])).rows[0].receptionist_status, 'off');
  await db.query(`update campaigns set vapi_receptionist_assistant_id = $2, vapi_inbound_number_id = $3, receptionist_transfer_number = '+15125550199', receptionist_notes = 'Open 9 to 5' where id = $1`,
    [camp, '55555555-5555-4555-8555-555555555555', NUM]);
  for (const sql of [
    `update campaigns set receptionist_status = 'maybe' where id = $1`,
    `update campaigns set vapi_inbound_number_id = 'number-1' where id = $1`,
    `update campaigns set receptionist_transfer_number = '5125550199' where id = $1`,
    `update campaigns set receptionist_notes = repeat('x', 2001) where id = $1`,
  ]) await assert.rejects(db.query(sql, [camp]), /check constraint/);
});

test('RC-02 one campaign answers each number in a workspace', async () => {
  await assert.rejects(db.query(`insert into campaigns (workspace_id, name, niche, vapi_inbound_number_id) values ($1, 'D', 'dentists', $2)`, [wsA, NUM]), /duplicate key/);
  await db.query(`insert into campaigns (workspace_id, name, niche, vapi_inbound_number_id) values ($1, 'E', 'dentists', $2)`, [wsB, NUM]);
});

test('RC-03 inbound call outcomes are recorded; unknown outcomes are rejected', async () => {
  const ins = (key, outcome) => asService(db, (tx) => tx.query(
    `insert into calls (workspace_id, lead_id, campaign_id, agent, direction, outcome, provider, provider_call_id, idempotency_key) values ($1,$2,$3,'receptionist','inbound',$4,'vapi',$5,$5)`,
    [wsA, lead, camp, outcome, key]));
  for (const [i, o] of ['answered', 'transferred', 'spam'].entries()) await ins(`in-${i}`, o);
  await assert.rejects(ins('in-x', 'maybe'), /check constraint/);
});
