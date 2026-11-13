import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { createDatabase, seedTwoWorkspaces, asUser, asAnon, asService, USERS } from './helpers.mjs';

// ownerA runs the agency; adminA is an agency admin, repA agency staff; ownerB is a client's own owner
let db, wsA, wsB, agency, client;

before(async () => {
  db = await createDatabase();
  ({ wsA, wsB } = await seedTwoWorkspaces(db));
  agency = (await asUser(db, USERS.ownerA, (tx) => tx.query(`insert into agencies (name) values ('Northwind Growth') returning id`))).rows[0].id;
});

const rpc = (user, sql, params) => asUser(db, user, (tx) => tx.query(sql, params));

test('WL-01 agency owners add admins and staff by email; others cannot', async () => {
  const email = async (id) => (await db.query('select email from auth.users where id = $1', [id])).rows[0].email;
  await rpc(USERS.ownerA, 'select agency_member_add($1, $2, $3)', [agency, await email(USERS.adminA), 'admin']);
  await rpc(USERS.adminA, 'select agency_member_add($1, $2, $3)', [agency, await email(USERS.repA), 'staff']);
  await assert.rejects(rpc(USERS.repA, 'select agency_member_add($1, $2, $3)', [agency, await email(USERS.viewerA), 'staff']), /Only agency owners and admins/);
  await assert.rejects(rpc(USERS.ownerB, 'select agency_member_add($1, $2, $3)', [agency, await email(USERS.ownerB), 'admin']), /Only agency owners and admins/);
  await assert.rejects(rpc(USERS.ownerA, 'select agency_member_add($1, $2, $3)', [agency, 'nobody@nowhere.test', 'staff']), /No account uses that email/);
  const team = (await rpc(USERS.repA, 'select role from agency_members_list($1)', [agency])).rows.map((r) => r.role);
  assert.deepEqual(team, ['owner', 'admin', 'staff']);
  assert.equal((await rpc(USERS.ownerB, 'select * from agency_members_list($1)', [agency])).rows.length, 0);
  assert.equal((await rpc(USERS.ownerB, 'select id from agencies', [])).rows.length, 0);
});

test('WL-02 the brand is checked, set by agency admins and read by the team', async () => {
  const set = (user, b) => rpc(user, `insert into agency_brands (agency_id, app_name, logo_url, primary_color, support_email, custom_domain) values ($1, $2, $3, $4, $5, $6)
    on conflict (agency_id) do update set app_name = excluded.app_name, logo_url = excluded.logo_url, primary_color = excluded.primary_color, support_email = excluded.support_email, custom_domain = excluded.custom_domain`,
    [agency, b.app_name, b.logo_url ?? null, b.primary_color ?? '#2f5bea', b.support_email ?? null, b.custom_domain ?? null]);
  await assert.rejects(set(USERS.repA, { app_name: 'Staff brand' }), /row-level security/);
  await assert.rejects(set(USERS.adminA, { app_name: 'X', logo_url: 'http://insecure.example/logo.png' }), /check constraint/);
  await assert.rejects(set(USERS.adminA, { app_name: 'X', primary_color: 'red' }), /check constraint/);
  await assert.rejects(set(USERS.adminA, { app_name: 'X', custom_domain: 'App.Agency.com' }), /check constraint/);
  await set(USERS.adminA, { app_name: 'Northwind Sales Cloud', logo_url: 'https://cdn.northwind.test/logo.png', primary_color: '#0e7c66', support_email: 'help@northwind.test', custom_domain: 'app.northwind.test' });
  assert.equal((await rpc(USERS.repA, 'select app_name from agency_brands', [])).rows[0].app_name, 'Northwind Sales Cloud');
  assert.equal((await rpc(USERS.ownerB, 'select app_name from agency_brands', [])).rows.length, 0);
});

test('WL-03 visitors get the brand of a custom domain, and nothing else', async () => {
  const brand = async (host) => (await asAnon(db, (tx) => tx.query('select brand_for_host($1) as b', [host]))).rows[0].b;
  assert.deepEqual(await brand('app.northwind.test'), { app_name: 'Northwind Sales Cloud', logo_url: 'https://cdn.northwind.test/logo.png', primary_color: '#0e7c66', support_email: 'help@northwind.test' });
  assert.equal(await brand('unknown.example'), null);
  assert.equal(await brand("app.northwind.test' or 1=1 --"), null);
});

test('WL-04 agency admins create client workspaces from the agency defaults; staff cannot', async () => {
  await rpc(USERS.ownerA, `update agencies set campaign_defaults = $2, default_playbook = $3 where id = $1`,
    [agency, JSON.stringify({ follow_up_count: 3, daily_send_limit: 120, send_window_start: '08:30' }), JSON.stringify({ company: 'Northwind', plans: [] })]);
  await assert.rejects(rpc(USERS.ownerA, `update agencies set campaign_defaults = '{"evil_column": 1}' where id = $1`, [agency]), /check constraint/);
  await assert.rejects(rpc(USERS.repA, 'select agency_create_workspace($1, $2, $3, $4, $5)', [agency, 'Bright Dental', 'growth', 500, 3]), /Only agency owners and admins/);
  client = (await rpc(USERS.adminA, 'select agency_create_workspace($1, $2, $3, $4, $5) as id', [agency, 'Bright Dental', 'growth', 500, 3])).rows[0].id;
  const w = (await db.query('select plan, agency_id, monthly_lead_limit, seat_limit, campaign_defaults from workspaces where id = $1', [client])).rows[0];
  assert.deepEqual(w, { plan: 'growth', agency_id: agency, monthly_lead_limit: 500, seat_limit: 3, campaign_defaults: { follow_up_count: 3, daily_send_limit: 120, send_window_start: '08:30' } });
  assert.equal((await db.query('select role from workspace_members where workspace_id = $1 and user_id = $2', [client, USERS.adminA])).rows[0].role, 'owner');
  assert.deepEqual((await db.query('select version, is_active, content from playbooks where workspace_id = $1', [client])).rows, [{ version: 1, is_active: true, content: { company: 'Northwind', plans: [] } }]);
  // New campaigns start from the cadence defaults
  const c = (await rpc(USERS.adminA, `insert into campaigns (workspace_id, name) values ($1, 'Austin') returning follow_up_count, daily_send_limit, send_window_start, follow_up_delay_days`, [client])).rows[0];
  assert.deepEqual(c, { follow_up_count: 3, daily_send_limit: 120, send_window_start: '08:30', follow_up_delay_days: 3 });
});

test('WL-05 a client cannot change its own plan, limits or agency; the agency can', async () => {
  await assert.rejects(rpc(USERS.adminA, `update workspaces set seat_limit = 50 where id = $1`, [client]), /managed by your agency/);
  await assert.rejects(rpc(USERS.ownerB, `update workspaces set agency_id = $2 where id = $1`, [wsB, agency]), /managed by your agency/);
  await assert.rejects(rpc(USERS.ownerB, `insert into workspaces (name, agency_id) values ('Sneaky', $1)`, [agency]), /created from the agency console/);
  // Ordinary settings still work
  assert.equal((await rpc(USERS.adminA, `update workspaces set name = 'Bright Dental Group' where id = $1 returning id`, [client])).rows.length, 1);
  await assert.rejects(rpc(USERS.repA, 'select agency_set_plan($1, $2, $3, $4)', [client, 'pro', 2000, 10]), /Only the agency that manages/);
  await assert.rejects(rpc(USERS.ownerA, 'select agency_set_plan($1, $2, $3, $4)', [wsA, 'pro', 2000, 10]), /Only the agency that manages/);
  await rpc(USERS.ownerA, 'select agency_set_plan($1, $2, $3, $4)', [client, 'pro', 2000, 2]);
  assert.deepEqual((await db.query('select plan, monthly_lead_limit, seat_limit from workspaces where id = $1', [client])).rows[0], { plan: 'pro', monthly_lead_limit: 2000, seat_limit: 2 });
});

test('WL-06 the seat limit is enforced when members are added', async () => {
  await asService(db, (tx) => tx.query(`insert into workspace_members (workspace_id, user_id, role) values ($1, $2, 'rep')`, [client, USERS.viewerA]));
  await assert.rejects(asService(db, (tx) => tx.query(`insert into workspace_members (workspace_id, user_id, role) values ($1, $2, 'rep')`, [client, USERS.ownerB])), /This plan allows 2 team members/);
});

test('WL-07 agency staff see client usage counts but no client records without a workspace role', async () => {
  const lead = (await db.query(`insert into leads (workspace_id, email, source_channel) values ($1, 'kim@bright.test', 'apollo') returning id`, [client])).rows[0].id;
  await db.query(`insert into deals (workspace_id, lead_id, stage, value_cents, currency, closed_at) values ($1, $2, 'won', 149900, 'USD', now())`, [client, lead]);
  const usage = (await rpc(USERS.repA, `select agency_usage($1, now() - interval '30 days', now() + interval '1 minute') as u`, [agency])).rows[0].u;
  assert.equal(usage.length, 1);
  assert.deepEqual({ name: usage[0].name, plan: usage[0].plan, members: usage[0].members, leads: usage[0].leads, leads_this_month: usage[0].leads_this_month, won: usage[0].won, revenue: usage[0].revenue },
    { name: 'Bright Dental Group', plan: 'pro', members: 2, leads: 1, leads_this_month: 1, won: 1, revenue: { USD: 149900 } });
  // Staff hold no role in the client workspace, so its records stay hidden
  assert.equal((await rpc(USERS.repA, 'select id from leads where workspace_id = $1', [client])).rows.length, 0);
  await assert.rejects(rpc(USERS.ownerB, `select agency_usage($1, now() - interval '30 days', now())`, [agency]), /Only the agency team/);
  await assert.rejects(rpc(USERS.ownerA, `select agency_usage($1, now() - interval '2 years', now())`, [agency]), /up to one year/);
});

test('WL-08 visitors cannot use the console functions', async () => {
  await assert.rejects(asAnon(db, (tx) => tx.query('select agency_usage($1, now() - interval \'1 day\', now())', [agency])), /permission denied/);
  await assert.rejects(asAnon(db, (tx) => tx.query('select agency_create_workspace($1, $2, null, null, null)', [agency, 'X'])), /permission denied/);
});
