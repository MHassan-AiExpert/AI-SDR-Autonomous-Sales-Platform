import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { createDatabase, seedTwoWorkspaces, asUser, asAnon, asService, insertLead, USERS } from './helpers.mjs';

// ownerA runs the agency as well as workspace A; ownerB is another workspace entirely
let db, wsA, wsB, agency, client, campA, campB, stepOne;

const rpc = (user, sql, params) => asUser(db, user, (tx) => tx.query(sql, params));
const email = async (user) => (await db.query('select email from auth.users where id = $1', [user])).rows[0].email;

before(async () => {
  db = await createDatabase();
  ({ wsA, wsB } = await seedTwoWorkspaces(db));
  agency = (await rpc(USERS.ownerA, `insert into agencies (name) values ('Northwind Growth') returning id`)).rows[0].id;
  campA = (await rpc(USERS.ownerA, `insert into campaigns (workspace_id, name, niche) values ($1, 'Austin', 'dentists') returning id`, [wsA])).rows[0].id;
  campB = (await rpc(USERS.ownerA, `insert into campaigns (workspace_id, name, niche) values ($1, 'Dallas', 'dentists') returning id`, [wsA])).rows[0].id;

  // A two-step sequence on campA, with an A/B pair and one message switched off
  stepOne = (await rpc(USERS.ownerA, `insert into sequence_steps (workspace_id, campaign_id, position, channel, wait_hours, condition)
    values ($1, $2, 1, 'email', 0, '{}'::jsonb) returning id`, [wsA, campA])).rows[0].id;
  const stepTwo = (await rpc(USERS.ownerA, `insert into sequence_steps (workspace_id, campaign_id, position, channel, wait_hours, condition, is_last)
    values ($1, $2, 2, 'sms', 48, '{"all":[{"fact":"replied","is":false}]}'::jsonb, true) returning id`, [wsA, campA])).rows[0].id;
  await rpc(USERS.ownerA, `insert into sequence_variants (workspace_id, step_id, label, subject, body) values
    ($1, $2, 'a', 'Quick question', 'Hello {{first_name}}'),
    ($1, $2, 'b', 'Worth a look?', 'Hi {{first_name}}'),
    ($1, $2, 'c', 'Off', 'Never sent')`, [wsA, stepOne]);
  await rpc(USERS.ownerA, `update sequence_variants set active = false where workspace_id = $1 and label = 'c'`, [wsA]);
  await rpc(USERS.ownerA, `insert into sequence_variants (workspace_id, step_id, label, body) values ($1, $2, 'a', 'Following up')`, [wsA, stepTwo]);
});

test('TPL-01 an owner saves a campaign sequence as a template; a rep and a viewer cannot', async () => {
  const id = (await rpc(USERS.ownerA, `select template_save_sequence($1, $2, $3, $4) as id`,
    [wsA, campA, 'Dental four-touch', 'Email then text'])).rows[0].id;
  assert.ok(id);
  const t = (await db.query(`select kind, name, description, workspace_id, agency_id, is_default from templates where id = $1`, [id])).rows[0];
  assert.deepEqual(t, { kind: 'sequence', name: 'Dental four-touch', description: 'Email then text', workspace_id: wsA, agency_id: null, is_default: false });

  await assert.rejects(rpc(USERS.repA, `select template_save_sequence($1, $2, $3, null)`, [wsA, campA, 'Rep try']), /row-level security/);
  await assert.rejects(rpc(USERS.viewerA, `select template_save_sequence($1, $2, $3, null)`, [wsA, campA, 'Viewer try']), /row-level security/);
});

test('TPL-02 the saved template holds the whole sequence, and only the messages that were on', async () => {
  const payload = (await db.query(`select payload from templates where workspace_id = $1 and name = 'Dental four-touch'`, [wsA])).rows[0].payload;
  assert.equal(payload.steps.length, 2);
  const [one, two] = payload.steps;
  assert.deepEqual(
    { position: one.position, channel: one.channel, wait_hours: one.wait_hours, is_last: one.is_last, condition: one.condition },
    { position: 1, channel: 'email', wait_hours: 0, is_last: false, condition: {} },
  );
  assert.deepEqual(one.variants.map((v) => v.label), ['a', 'b'], 'the switched-off message is not carried into the template');
  assert.equal(one.variants[0].subject, 'Quick question');
  assert.deepEqual(
    { position: two.position, channel: two.channel, wait_hours: two.wait_hours, is_last: two.is_last },
    { position: 2, channel: 'sms', wait_hours: 48, is_last: true },
  );
  assert.deepEqual(two.condition, { all: [{ fact: 'replied', is: false }] });
});

test('TPL-03 a campaign with no sequence has nothing to save', async () => {
  await assert.rejects(rpc(USERS.ownerA, `select template_save_sequence($1, $2, 'Empty', null)`, [wsA, campB]), /no sequence to save/);
});

test('TPL-04 applying a template builds the sequence on another campaign', async () => {
  const id = (await db.query(`select id from templates where workspace_id = $1 and name = 'Dental four-touch'`, [wsA])).rows[0].id;
  const written = (await rpc(USERS.ownerA, `select template_apply_sequence($1, $2, $3) as n`, [wsA, id, campB])).rows[0].n;
  assert.equal(written, 2);

  const steps = (await db.query(`select id, position, channel, wait_hours, condition, is_last from sequence_steps
    where workspace_id = $1 and campaign_id = $2 order by position`, [wsA, campB])).rows;
  assert.deepEqual(steps.map((s) => [s.position, s.channel, s.wait_hours, s.is_last]), [[1, 'email', 0, false], [2, 'sms', 48, true]]);
  assert.deepEqual(steps[1].condition, { all: [{ fact: 'replied', is: false }] });

  const variants = (await db.query(`select v.label, v.subject, v.body, v.active from sequence_variants v
    join sequence_steps s on s.id = v.step_id where s.campaign_id = $1 order by s.position, v.label`, [campB])).rows;
  assert.deepEqual(variants.map((v) => v.label), ['a', 'b', 'a']);
  assert.ok(variants.every((v) => v.active), 'messages arrive switched on');
  assert.equal(variants[0].subject, 'Quick question');
});

test('TPL-05 a rep cannot apply a template', async () => {
  const id = (await db.query(`select id from templates where workspace_id = $1 limit 1`, [wsA])).rows[0].id;
  await assert.rejects(rpc(USERS.repA, `select template_apply_sequence($1, $2, $3)`, [wsA, id, campB]), /Only owners and admins/);
});

test('TPL-06 a template is a snapshot: changing the campaign it came from does not change it', async () => {
  await rpc(USERS.ownerA, `update sequence_variants set body = 'Rewritten after saving' where workspace_id = $1 and step_id = $2 and label = 'a'`, [wsA, stepOne]);
  const payload = (await db.query(`select payload from templates where workspace_id = $1 and name = 'Dental four-touch'`, [wsA])).rows[0].payload;
  assert.equal(payload.steps[0].variants[0].body, 'Hello {{first_name}}');
});

test('TPL-07 applying over a campaign that has already sent steps is refused unless asked plainly', async () => {
  const id = (await db.query(`select id from templates where workspace_id = $1 and name = 'Dental four-touch'`, [wsA])).rows[0].id;
  const lead = await asUser(db, USERS.repA, (tx) => insertLead(tx, wsA, { email: 'sent@acme.test' }));
  await db.query(`update leads set campaign_id = $2 where id = $1`, [lead, campB]);
  const step = (await db.query(`select id from sequence_steps where campaign_id = $1 order by position limit 1`, [campB])).rows[0].id;
  await asService(db, (tx) => tx.query(`select lead_step_record($1, $2, $3, 'a', 'sent', null)`, [wsA, lead, step]));

  await assert.rejects(rpc(USERS.ownerA, `select template_apply_sequence($1, $2, $3)`, [wsA, id, campB]),
    /already sent 1 sequence step/);
  // Said plainly, it goes ahead, and the old record goes with the old steps
  const written = (await rpc(USERS.ownerA, `select template_apply_sequence($1, $2, $3, true) as n`, [wsA, id, campB])).rows[0].n;
  assert.equal(written, 2);
  assert.equal((await db.query(`select count(*)::int n from lead_step_runs where workspace_id = $1 and lead_id = $2`, [wsA, lead])).rows[0].n, 0);
});

test('TPL-08 a name is used once per kind in a workspace, whatever the case', async () => {
  await rpc(USERS.ownerA, `insert into templates (workspace_id, kind, name, payload) values ($1, 'snippet', 'Case study line', '{"body":"We helped X"}'::jsonb)`, [wsA]);
  await assert.rejects(rpc(USERS.ownerA,
    `insert into templates (workspace_id, kind, name, payload) values ($1, 'snippet', 'case study line', '{"body":"Again"}'::jsonb)`, [wsA]),
    /duplicate key|unique/i);
  // The same name is fine for a different kind
  await rpc(USERS.ownerA, `insert into templates (workspace_id, kind, name, payload) values ($1, 'sequence', 'Case study line', '{"steps":[]}'::jsonb)`, [wsA]);
});

test('TPL-09 a template belongs to a workspace or an agency, never both or neither', async () => {
  await assert.rejects(rpc(USERS.ownerA,
    `insert into templates (workspace_id, agency_id, kind, name, payload) values ($1, $2, 'snippet', 'Both', '{}'::jsonb)`, [wsA, agency]),
    /templates_one_owner/);
  await assert.rejects(rpc(USERS.ownerA,
    `insert into templates (kind, name, payload) values ('snippet', 'Neither', '{}'::jsonb)`, []),
    /templates_one_owner|row-level security/);
});

test('TPL-10 only an agency template can be a default for new clients', async () => {
  await assert.rejects(rpc(USERS.ownerA,
    `insert into templates (workspace_id, kind, name, payload, is_default) values ($1, 'snippet', 'Workspace default', '{"body":"x"}'::jsonb, true)`, [wsA]),
    /templates_default_is_agency/);
  await rpc(USERS.ownerA,
    `insert into templates (agency_id, kind, name, description, payload, is_default) values ($1, 'snippet', 'Agency opener', 'House opener', '{"body":"We work with dentists"}'::jsonb, true)`, [agency]);
});

test('TPL-11 another workspace sees nothing of this one and cannot write into it', async () => {
  assert.equal((await rpc(USERS.ownerB, `select id from templates where workspace_id = $1`, [wsA])).rows.length, 0);
  await assert.rejects(rpc(USERS.ownerB,
    `insert into templates (workspace_id, kind, name, payload) values ($1, 'snippet', 'Intruder', '{"body":"x"}'::jsonb)`, [wsA]),
    /row-level security/);
  await assert.rejects(rpc(USERS.ownerB, `select template_apply_sequence($1, $2, $3)`,
    [wsA, (await db.query(`select id from templates where workspace_id = $1 limit 1`, [wsA])).rows[0].id, campB]),
    /Only owners and admins/);
});

test('TPL-12 the agency library is readable by its clients and writable only by agency admins', async () => {
  // A workspace with no agency sees nothing of it
  assert.equal((await rpc(USERS.ownerB, `select id from templates where agency_id = $1`, [agency])).rows.length, 0);
  // The agency owner may write; a client owner may not
  await assert.rejects(rpc(USERS.ownerB,
    `insert into templates (agency_id, kind, name, payload) values ($1, 'snippet', 'Client try', '{"body":"x"}'::jsonb)`, [agency]),
    /row-level security/);
  assert.equal((await rpc(USERS.ownerA, `select name from templates where agency_id = $1`, [agency])).rows[0].name, 'Agency opener');
});

test('TPL-13 a new client workspace starts with the agency default templates', async () => {
  await rpc(USERS.ownerA, `select agency_member_add($1, $2, 'admin')`, [agency, await email(USERS.adminA)]);
  await rpc(USERS.ownerA, `insert into templates (agency_id, kind, name, payload, is_default) values ($1, 'sequence', 'Agency four-touch', '{"steps":[{"position":1,"channel":"email","wait_hours":0,"is_last":true,"condition":{},"variants":[{"label":"a","subject":"Hi","body":"Hello"}]}]}'::jsonb, true)`, [agency]);
  // Not a default, so it must not be copied
  await rpc(USERS.ownerA, `insert into templates (agency_id, kind, name, payload) values ($1, 'snippet', 'Internal note', '{"body":"not for clients"}'::jsonb)`, [agency]);

  client = (await rpc(USERS.adminA, `select agency_create_workspace($1, $2, 'growth', 500, 3) as id`, [agency, 'Bright Dental'])).rows[0].id;
  const copied = (await db.query(`select kind, name, is_default from templates where workspace_id = $1 order by name`, [client])).rows;
  assert.deepEqual(copied, [
    { kind: 'sequence', name: 'Agency four-touch', is_default: false },
    { kind: 'snippet', name: 'Agency opener', is_default: false },
  ]);

  // The copies are the client's own: the client owner may edit them
  await rpc(USERS.adminA, `update templates set description = 'Tuned for us' where workspace_id = $1 and name = 'Agency opener'`, [client]);
  assert.equal((await db.query(`select description from templates where agency_id = $1 and name = 'Agency opener'`, [agency])).rows[0].description,
    'House opener', 'the agency original is untouched');
});

test('TPL-14 a client that is not under the agency inherits nothing', async () => {
  const solo = (await rpc(USERS.ownerB, `insert into workspaces (name) values ('Solo shop') returning id`)).rows[0].id;
  assert.equal((await db.query(`select count(*)::int n from templates where workspace_id = $1`, [solo])).rows[0].n, 0);
});

test('TPL-15 a visitor can reach none of it', async () => {
  await assert.rejects(asAnon(db, (tx) => tx.query('select * from templates')), /permission denied/);
  await assert.rejects(asAnon(db, (tx) => tx.query(`select template_save_sequence($1, $1, 'x', null)`, [wsA])), /permission denied/);
  await assert.rejects(asAnon(db, (tx) => tx.query(`select template_apply_sequence($1, $1, $1)`, [wsA])), /permission denied/);
});
