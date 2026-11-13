import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { createDatabase, seedTwoWorkspaces, asUser, asAnon, asService, USERS } from './helpers.mjs';

let db, wsA, c1, c2;
const range = [new Date(Date.now() - 30 * 86_400_000).toISOString(), new Date(Date.now() + 60_000).toISOString()];
const summary = (user, ws = wsA, campaign = null, from = range[0], to = range[1]) =>
  asUser(db, user, async (tx) => (await tx.query('select analytics_summary($1, $2, $3, $4) as s', [ws, from, to, campaign])).rows[0].s);

before(async () => {
  db = await createDatabase();
  ({ wsA } = await seedTwoWorkspaces(db));
  c1 = (await db.query(`insert into campaigns (workspace_id, name, niche, status) values ($1, 'Austin', 'dentists', 'active') returning id`, [wsA])).rows[0].id;
  c2 = (await db.query(`insert into campaigns (workspace_id, name, niche, status) values ($1, 'Dallas', 'dentists', 'active') returning id`, [wsA])).rows[0].id;
  await asService(db, async (tx) => {
    const lead = async (camp, email, over = '') => (await tx.query(`insert into leads (workspace_id, campaign_id, email, source_channel, verification_status, created_at) values ($1,$2,$3,'apollo','valid', ${over || 'now()'}) returning id`, [wsA, camp, email])).rows[0].id;
    const a = await lead(c1, 'a@x.test'); const b = await lead(c1, 'b@x.test'); const c = await lead(c2, 'c@x.test');
    await lead(c1, 'old@x.test', `now() - interval '60 days'`);
    for (const [l, camp, step] of [[a, c1, 1], [a, c1, 2], [b, c1, 1], [c, c2, 1]]) {
      await tx.query(`insert into emails (workspace_id, lead_id, campaign_id, step, subject, body, status, sent_at, idempotency_key) values ($1,$2,$3,$4,'S','B','sent', now() - interval '2 days', $5)`, [wsA, l, camp, step, `${l}:${step}`]);
    }
    for (const [l, camp, cls] of [[a, c1, 'interested'], [b, c1, 'out_of_office'], [c, c2, 'negative']]) {
      await tx.query(`insert into replies (workspace_id, lead_id, campaign_id, channel, body, classification) values ($1,$2,$3,'email','R',$4)`, [wsA, l, camp, cls]);
    }
    await tx.query(`insert into meetings (workspace_id, lead_id, campaign_id, starts_at, booked_via, status, closer_status) values ($1,$2,$3, now() - interval '1 day', 'calendly', 'completed', 'held')`, [wsA, a, c1]);
    await tx.query(`insert into deals (workspace_id, lead_id, campaign_id, stage, value_cents, currency, closed_at, closed_by) values ($1,$2,$3,'won',49900,'USD', now() - interval '1 day', 'ai')`, [wsA, a, c1]);
    await tx.query(`insert into messages (workspace_id, lead_id, campaign_id, channel, direction, body, delivery_status, idempotency_key) values ($1,$2,$3,'sms','outbound','Hi','delivered','m1')`, [wsA, b, c1]);
    await tx.query(`insert into calls (workspace_id, lead_id, campaign_id, agent, direction, outcome, idempotency_key) values ($1,$2,$3,'caller','outbound','interested','k1'), ($1,$2,$3,'caller','outbound','voicemail','k2'), ($1,$2,$3,'receptionist','inbound','transferred','k3')`, [wsA, b, c1]);
    await tx.query(`insert into assets (workspace_id, lead_id, campaign_id, type, status, share_token, first_viewed_at) values ($1,$2,$3,'audit','ready',$4, now())`, [wsA, b, c1, 'ab'.repeat(24)]);
  });
});

test('AN-01 the dashboard counts the funnel, channels, revenue, days and campaigns for the period', async () => {
  const s = await summary(USERS.viewerA);
  assert.deepEqual(s.funnel, { sourced: 3, verified: 3, emailed: 3, replied: 2, interested: 1, meetings_booked: 1, meetings_held: 1, won: 1 });
  assert.deepEqual(s.revenue, [{ currency: 'USD', cents: 49900 }]);
  assert.equal(s.won_by_ai, 1);
  assert.deepEqual(s.channels.email, { sent: 4, replies: 2, interested: 1 });
  assert.deepEqual(s.channels.sms, { sent: 1, delivered: 1, replies: 0 });
  assert.deepEqual(s.channels.calls, { made: 2, connected: 1, interested: 1 });
  assert.deepEqual(s.channels.receptionist, { calls: 1, interested: 0, transferred: 1 });
  assert.deepEqual(s.channels.audits, { ready: 1, opened: 1 });
  assert.ok(s.daily.length >= 30 && s.daily.length <= 32);
  assert.equal(s.daily.reduce((n, d) => n + d.emails, 0), 4);
  const austin = s.campaigns.find((x) => x.name === 'Austin');
  assert.deepEqual({ ...austin, id: undefined, status: undefined }, { id: undefined, status: undefined, name: 'Austin', sourced: 2, emailed: 2, replied: 1, interested: 1, meetings: 1, won: 1, revenue_cents: 49900 });
});

test('AN-02 a campaign filter narrows every figure', async () => {
  const s = await summary(USERS.ownerA, wsA, c2);
  assert.deepEqual(s.funnel, { sourced: 1, verified: 1, emailed: 1, replied: 1, interested: 0, meetings_booked: 0, meetings_held: 0, won: 0 });
  assert.deepEqual(s.campaigns.map((x) => x.name), ['Dallas']);
  assert.deepEqual(s.revenue, []);
});

test('AN-03 only members see their workspace; visitors cannot run it; periods are limited to a year', async () => {
  const other = await summary(USERS.ownerB);
  assert.equal(other.funnel.emailed, 0);
  assert.deepEqual(other.campaigns, []);
  await assert.rejects(asAnon(db, (tx) => tx.query('select analytics_summary($1, $2, $3)', [wsA, ...range])), /permission denied/);
  await assert.rejects(summary(USERS.ownerA, wsA, null, '2025-01-01', '2026-06-01'), /up to one year/);
  await assert.rejects(summary(USERS.ownerA, wsA, null, range[1], range[0]), /up to one year/);
});

test('AN-04 owners and admins set the monthly tool spend; reps cannot', async () => {
  await asUser(db, USERS.adminA, (tx) => tx.query(`update workspaces set monthly_spend_cents = 120000, spend_currency = 'USD' where id = $1`, [wsA]));
  const r = await asUser(db, USERS.repA, (tx) => tx.query(`update workspaces set monthly_spend_cents = 1 where id = $1 returning id`, [wsA]));
  assert.equal(r.rows.length, 0);
  assert.equal((await db.query('select monthly_spend_cents from workspaces where id = $1', [wsA])).rows[0].monthly_spend_cents, 120000);
  await assert.rejects(db.query(`update workspaces set spend_currency = 'dollars' where id = $1`, [wsA]), /check constraint/);
  await assert.rejects(db.query(`update workspaces set monthly_spend_cents = -1 where id = $1`, [wsA]), /check constraint/);
});
