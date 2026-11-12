import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { createDatabase, seedTwoWorkspaces, asUser, asService, USERS, insertLead } from './helpers.mjs';

let db, wsA, camp, lead;

before(async () => {
  db = await createDatabase();
  ({ wsA } = await seedTwoWorkspaces(db));
  camp = (await db.query(`insert into campaigns (workspace_id, name, niche) values ($1, 'C', 'dentists') returning id`, [wsA])).rows[0].id;
  lead = await asService(db, (tx) => insertLead(tx, wsA, { email: 'kim@bright.com' }));
});

const reply = async (extra = {}) => (await db.query(
  `insert into replies (workspace_id, lead_id, campaign_id, channel, body, classification, answer, answer_status, provider_email_id, email_account)
   values ($1,$2,$3,'email','Tell me more','interested',$4,$5,'em-1','sam@send.co') returning id`,
  [wsA, lead, camp, extra.answer ?? 'Happy to share more, would Tuesday suit?', extra.status ?? 'draft'])).rows[0].id;
const row = async (id) => (await db.query('select * from replies where id = $1', [id])).rows[0];

test('BK-01 a rep edits and approves an answer; the approver is recorded and the sender is queued', async () => {
  const id = await reply();
  await asUser(db, USERS.repA, (tx) => tx.query(`update replies set answer = 'Thanks Kim, does Tuesday at 10 work?', answer_status = 'approved' where id = $1`, [id]));
  const r = await row(id);
  assert.equal(r.answer_approved_by, USERS.repA);
  const jobs = (await db.query(`select type, status from agent_jobs where campaign_id = $1`, [camp])).rows;
  assert.deepEqual(jobs, [{ type: 'reply_send', status: 'queued' }]);
});

test('BK-02 people cannot send, change a sent answer, or change what the prospect wrote', async () => {
  const id = await reply();
  await assert.rejects(asUser(db, USERS.ownerA, (tx) => tx.query(`update replies set answer_status = 'sent' where id = $1`, [id])), /Only the reply agent/);
  await assert.rejects(asUser(db, USERS.ownerA, (tx) => tx.query(`update replies set body = 'I love it' where id = $1`, [id])), /Only the answer/);
  await assert.rejects(asUser(db, USERS.ownerA, (tx) => tx.query(`update replies set classification = 'negative' where id = $1`, [id])), /Only the answer/);
  const sent = await reply({ status: 'sent' });
  await assert.rejects(asUser(db, USERS.ownerA, (tx) => tx.query(`update replies set answer = 'edit' where id = $1`, [sent])), /already been sent/);
});

test('BK-03 an empty answer cannot be approved; viewers cannot approve', async () => {
  const id = await reply({ answer: '' });
  await assert.rejects(asUser(db, USERS.ownerA, (tx) => tx.query(`update replies set answer_status = 'approved' where id = $1`, [id])), /Write the answer/);
  const r = await asUser(db, USERS.viewerA, (tx) => tx.query(`update replies set answer_status = 'approved' where id = $1`, [id]));
  assert.equal(r.affectedRows, 0);
});

test('BK-04 Calendly signing keys are never readable by any signed-in user', async () => {
  await db.query(`insert into calendly_subscriptions (workspace_id, subscription_uri, user_uri, organization_uri, signing_key) values ($1, 'https://api.calendly.com/webhook_subscriptions/x', 'u', 'o', 'secret-key')`, [wsA]);
  for (const user of [USERS.ownerA, USERS.adminA]) {
    await assert.rejects(asUser(db, user, (tx) => tx.query('select * from calendly_subscriptions')), /permission denied/);
  }
});

test('BK-05 a Calendly booking is stored once per invitee; links must be Calendly links', async () => {
  const ins = () => db.query(`insert into meetings (workspace_id, lead_id, campaign_id, starts_at, booked_via, provider, external_id, status) values ($1,$2,$3, now() + interval '2 days', 'calendly', 'calendly', 'inv-1', 'scheduled')`, [wsA, lead, camp]);
  await ins();
  await assert.rejects(ins(), /duplicate key/);
  await assert.rejects(db.query(`insert into meetings (workspace_id, lead_id, starts_at, booked_via, cancel_url) values ($1,$2, now(), 'calendly', 'https://evil.example/cancel')`, [wsA, lead]), /check constraint/);
  await assert.rejects(db.query(`update campaigns set booking_event_type = 'https://evil.example/x' where id = $1`, [camp]), /check constraint/);
  await db.query(`update campaigns set booking_event_type = 'https://api.calendly.com/event_types/ABC123' where id = $1`, [camp]);
});

test('BK-06 the kill switch holds answers waiting to be sent until outreach resumes', async () => {
  await db.query(`delete from agent_jobs`);
  await db.query(`insert into agent_jobs (workspace_id, campaign_id, type) values ($1, $2, 'reply_send')`, [wsA, camp]);
  await db.query(`update workspaces set outreach_paused = true where id = $1`, [wsA]);
  const held = await asService(db, async (tx) => (await tx.query(`select type from agent_jobs_claim(10) where type = 'reply_send'`)).rows);
  assert.deepEqual(held, []);
  await db.query(`update workspaces set outreach_paused = false where id = $1`, [wsA]);
  const claimed = await asService(db, async (tx) => (await tx.query(`select type from agent_jobs_claim(10) where type = 'reply_send'`)).rows);
  assert.deepEqual(claimed, [{ type: 'reply_send' }]);
});
