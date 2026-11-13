import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { createDatabase, seedTwoWorkspaces, asUser, asService, USERS } from './helpers.mjs';

let db, wsA, wsB, camp, lead;

before(async () => {
  db = await createDatabase();
  ({ wsA, wsB } = await seedTwoWorkspaces(db));
  camp = (await db.query(`insert into campaigns (workspace_id, name, niche, status) values ($1, 'C', 'dentists', 'active') returning id`, [wsA])).rows[0].id;
  lead = (await db.query(`insert into leads (workspace_id, campaign_id, email, source_channel) values ($1, $2, 'a@x.test', 'apollo') returning id`, [wsA, camp])).rows[0].id;
});

const add = (ws, over = {}) => {
  const n = { event: 'handoff', title: 'Meeting for your team', lead_id: lead, dedupe_key: null, link_path: `/w/${ws}/leads/${lead}`, ...over };
  return asService(db, (tx) => tx.query(
    `insert into notifications (workspace_id, event, title, lead_id, dedupe_key, link_path) values ($1, $2, $3, $4, $5, $6) returning id`,
    [ws, n.event, n.title, n.lead_id, n.dedupe_key, n.link_path]));
};
const accept = (user, id) => asUser(db, user, (tx) => tx.query(
  `update notifications set accepted_by = $2, accepted_at = now() where id = $1 returning id`, [id, user]));

test('NF-01 settings default to every Slack event, no quiet hours and safe limits, and are checked', async () => {
  const w = (await db.query(`select notify_slack_events, notify_quiet_start, notify_timezone, bounce_pause_pct::float8 b, optout_pause_pct::float8 o, low_credits_threshold::float8 l from workspaces where id = $1`, [wsA])).rows[0];
  assert.equal(w.notify_slack_events.length, 11);
  assert.deepEqual([w.notify_quiet_start, w.notify_timezone, w.b, w.o, w.l], [null, 'UTC', 5, 3, 100]);
  await assert.rejects(db.query(`update workspaces set notify_slack_events = array['everything'] where id = $1`, [wsA]), /check constraint/);
  await assert.rejects(db.query(`update workspaces set notify_quiet_start = 20 where id = $1`, [wsA]), /check constraint/);
  await assert.rejects(db.query(`update workspaces set notify_quiet_start = 8, notify_quiet_end = 8 where id = $1`, [wsA]), /check constraint/);
  await assert.rejects(db.query(`update workspaces set notify_timezone = 'UTC; drop table x' where id = $1`, [wsA]), /check constraint/);
  await assert.rejects(db.query(`update workspaces set bounce_pause_pct = 0 where id = $1`, [wsA]), /check constraint/);
  await db.query(`update workspaces set notify_quiet_start = 20, notify_quiet_end = 7, notify_timezone = 'Asia/Karachi' where id = $1`, [wsA]);
});

test('NF-02 members read their own workspace notifications; nobody else writes them', async () => {
  await add(wsA, { event: 'meeting_booked', title: 'Meeting booked' });
  assert.equal((await asUser(db, USERS.viewerA, (tx) => tx.query('select id from notifications'))).rows.length, 1);
  assert.equal((await asUser(db, USERS.ownerB, (tx) => tx.query('select id from notifications'))).rows.length, 0);
  await assert.rejects(asUser(db, USERS.ownerA, (tx) => tx.query(`insert into notifications (workspace_id, event, title) values ($1, 'system_alert', 'x')`, [wsA])), /permission denied/);
  await assert.rejects(asUser(db, USERS.ownerA, (tx) => tx.query(`update notifications set title = 'x'`)), /permission denied/);
  await assert.rejects(asUser(db, USERS.ownerA, (tx) => tx.query(`delete from notifications`)), /permission denied/);
});

test('NF-03 the same alert key is stored once; links stay inside the workspace', async () => {
  await add(wsA, { event: 'system_alert', title: 'Emails paused', dedupe_key: 'autopause:x:2026-11-13' });
  await assert.rejects(add(wsA, { event: 'system_alert', title: 'Emails paused', dedupe_key: 'autopause:x:2026-11-13' }), /duplicate key/);
  await assert.rejects(add(wsA, { event: 'system_alert', link_path: 'https://evil.example/w/x' }), /check constraint/);
  await assert.rejects(add(wsA, { event: 'unknown' }), /check constraint/);
  await assert.rejects(asService(db, (tx) => tx.query(`insert into notifications (workspace_id, event, title, action_url) values ($1, 'handoff', 'x', 'javascript:alert(1)')`, [wsA])), /check constraint/);
});

test('NF-04 a rep accepts a handoff for themselves, once; viewers and other workspaces cannot', async () => {
  const id = (await add(wsA)).rows[0].id;
  assert.equal((await accept(USERS.viewerA, id)).rows.length, 0);
  assert.equal((await accept(USERS.ownerB, id)).rows.length, 0);
  // Accepting in someone else's name is refused
  await assert.rejects(asUser(db, USERS.repA, (tx) => tx.query(`update notifications set accepted_by = $2, accepted_at = now() where id = $1`, [id, USERS.adminA])), /row-level security/);
  assert.equal((await accept(USERS.repA, id)).rows.length, 1);
  assert.equal((await accept(USERS.adminA, id)).rows.length, 0);
  const n = (await db.query('select accepted_by from notifications where id = $1', [id])).rows[0];
  assert.equal(n.accepted_by, USERS.repA);
  // Only handoffs can be accepted
  const other = (await add(wsA, { event: 'deal_won', title: 'Deal won' })).rows[0].id;
  assert.equal((await accept(USERS.repA, other)).rows.length, 0);
});

test('NF-05 each member keeps their own last-seen time', async () => {
  await asUser(db, USERS.repA, (tx) => tx.query(`insert into notification_seen (workspace_id, user_id) values ($1, $2)`, [wsA, USERS.repA]));
  await asUser(db, USERS.repA, (tx) => tx.query(`update notification_seen set seen_at = now() where workspace_id = $1 and user_id = $2`, [wsA, USERS.repA]));
  await assert.rejects(asUser(db, USERS.repA, (tx) => tx.query(`insert into notification_seen (workspace_id, user_id) values ($1, $2)`, [wsA, USERS.viewerA])), /row-level security/);
  await assert.rejects(asUser(db, USERS.ownerB, (tx) => tx.query(`insert into notification_seen (workspace_id, user_id) values ($1, $2)`, [wsA, USERS.ownerB])), /row-level security/);
  assert.equal((await asUser(db, USERS.adminA, (tx) => tx.query('select * from notification_seen'))).rows.length, 0);
});

test('NF-06 retries wait before they run again, and stop after three attempts', async () => {
  const job = (await db.query(`insert into agent_jobs (workspace_id, campaign_id, type) values ($1, $2, 'research') returning id`, [wsA, camp])).rows[0].id;
  const claim = () => asService(db, (tx) => tx.query('select id, attempts from agent_jobs_claim(5)'));
  const retry = (mins) => asService(db, async (tx) => (await tx.query('select agent_job_retry($1, $2, $3) as ok', [job, 'Apollo did not respond in time', mins])).rows[0].ok);
  assert.equal((await claim()).rows.length, 1);
  assert.equal(await retry(2), true);
  assert.equal((await claim()).rows.length, 0);
  const j = (await db.query(`select status, error, run_after > now() + interval '90 seconds' as waits from agent_jobs where id = $1`, [job])).rows[0];
  assert.deepEqual(j, { status: 'queued', error: 'Apollo did not respond in time', waits: true });
  for (const n of [2, 3]) {
    await db.query(`update agent_jobs set run_after = now() - interval '1 second' where id = $1`, [job]);
    assert.equal((await claim()).rows[0].attempts, n);
    assert.equal(await retry(4), n < 3);
  }
  await assert.rejects(asUser(db, USERS.ownerA, (tx) => tx.query('select agent_job_retry($1, $2, 1)', [job, 'x'])), /permission denied/);
});

test('NF-07 the monitor hands out each workspace at most every 15 minutes, to the agent service only', async () => {
  const claim = () => asService(db, (tx) => tx.query('select id from monitoring_claim(10)'));
  assert.equal((await claim()).rows.length, 2);
  assert.equal((await claim()).rows.length, 0);
  await db.query(`update workspaces set monitored_at = now() - interval '16 minutes' where id = $1`, [wsB]);
  assert.deepEqual((await claim()).rows.map((r) => r.id), [wsB]);
  await assert.rejects(asUser(db, USERS.ownerA, (tx) => tx.query('select monitoring_claim(1)')), /permission denied/);
});

test('NF-08 automatic pauses are recorded on the campaign', async () => {
  await db.query(`update campaigns set auto_paused_reason = 'Bounce rate 9.0%', auto_paused_at = now() where id = $1`, [camp]);
  await assert.rejects(db.query(`update campaigns set auto_paused_reason = repeat('x', 301) where id = $1`, [camp]), /check constraint/);
});
