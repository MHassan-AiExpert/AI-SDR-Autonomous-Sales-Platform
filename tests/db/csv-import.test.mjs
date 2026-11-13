import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { createDatabase, seedTwoWorkspaces, asUser, asService, USERS } from './helpers.mjs';

let db, wsA, wsB, camp;

before(async () => {
  db = await createDatabase();
  ({ wsA, wsB } = await seedTwoWorkspaces(db));
  camp = (await db.query(`insert into campaigns (workspace_id, name, niche) values ($1, 'Austin', 'dentists') returning id`, [wsA])).rows[0].id;
});

const importAs = (user, rows, ws = wsA, campaign = camp, file = 'list.csv') =>
  asUser(db, user, (tx) => tx.query('select leads_import($1, $2, $3, $4::jsonb) as r', [ws, campaign, file, JSON.stringify(rows)]));
const counts = (res) => {
  const r = res.rows[0].r;
  return { added: r.added, duplicates: r.duplicates, suppressed: r.suppressed, invalid: r.invalid, total: r.total_rows };
};

test('CSV-01 a clean file imports, stamped as csv and linked to the import', async () => {
  const res = await importAs(USERS.repA, [
    { email: '  KIM@bright.test ', full_name: 'Kim Lee', title: 'Owner', phone: '(512) 555-0100' },
    { email: 'sam@acme.test', full_name: 'Sam Diaz', linkedin_url: 'https://www.linkedin.com/in/samdiaz' },
  ]);
  assert.deepEqual(counts(res), { added: 2, duplicates: 0, suppressed: 0, invalid: 0, total: 2 });
  const rows = (await db.query(`select email, phone, full_name, source_channel, source_query, stage, campaign_id, import_id from leads where workspace_id = $1 order by email`, [wsA])).rows;
  // Email lower-cased and trimmed, phone reduced to digits, source recorded
  assert.deepEqual(rows[0], { email: 'kim@bright.test', phone: '5125550100', full_name: 'Kim Lee', source_channel: 'csv', source_query: 'list.csv', stage: 'new', campaign_id: camp, import_id: rows[0].import_id });
  assert.ok(rows[0].import_id);
  assert.equal(rows[1].email, 'sam@acme.test');
});

test('CSV-02 rows with no usable contact, or a malformed one, count as invalid', async () => {
  const res = await importAs(USERS.repA, [
    { full_name: 'No Contact At All' },
    { email: 'not-an-email' },
    { email: '', phone: '123' },
    { linkedin_url: 'https://example.com/in/fake' },
    { phone: '+44 20 7946 0958', full_name: 'Valid By Phone' },
  ]);
  assert.deepEqual(counts(res), { added: 1, duplicates: 0, suppressed: 0, invalid: 4, total: 5 });
  assert.equal((await db.query(`select phone from leads where full_name = 'Valid By Phone'`)).rows[0].phone, '+442079460958');
});

test('CSV-03 duplicates are skipped, against existing leads and inside the same file', async () => {
  const res = await importAs(USERS.repA, [
    { email: 'kim@bright.test', full_name: 'Kim Again' },
    { email: 'NEW@bright.test', full_name: 'First' },
    { email: 'new@bright.test', full_name: 'Second, same address' },
  ]);
  assert.deepEqual(counts(res), { added: 1, duplicates: 2, suppressed: 0, invalid: 0, total: 3 });
  assert.equal((await db.query(`select full_name from leads where email = 'new@bright.test'`)).rows[0].full_name, 'First');
  assert.equal((await db.query(`select count(*)::int n from leads where workspace_id = $1 and email = 'kim@bright.test'`, [wsA])).rows[0].n, 1);
});

test('CSV-04 suppressed addresses, phones and whole domains never come back', async () => {
  await asUser(db, USERS.ownerA, (tx) => tx.query(
    `insert into suppressions (workspace_id, kind, value, reason) values ($1, 'email', 'stop@bright.test', 'unsubscribed'),
       ($1, 'phone', '5125559999', 'do_not_call'), ($1, 'domain', 'rival.test', 'competitor')`, [wsA]));
  const res = await importAs(USERS.repA, [
    { email: 'stop@bright.test', full_name: 'Opted out' },
    { phone: '512-555-9999', full_name: 'Do not call' },
    { email: 'ceo@rival.test', full_name: 'Competitor' },
    { email: 'fine@bright.test', full_name: 'Allowed' },
  ]);
  assert.deepEqual(counts(res), { added: 1, duplicates: 0, suppressed: 3, invalid: 0, total: 4 });
  assert.equal((await db.query(`select count(*)::int n from leads where email = 'ceo@rival.test'`)).rows[0].n, 0);
});

test('CSV-10 the counts are right even when every row is filtered out', async () => {
  // All suppressed
  const all = await importAs(USERS.repA, [
    { email: 'stop@bright.test' }, { email: 'ceo@rival.test' },
  ], wsA, null, 'all-suppressed.csv');
  assert.deepEqual(counts(all), { added: 0, duplicates: 0, suppressed: 2, invalid: 0, total: 2 });
  // All invalid
  const bad = await importAs(USERS.repA, [{ full_name: 'A' }, { email: 'nope' }], wsA, null, 'all-invalid.csv');
  assert.deepEqual(counts(bad), { added: 0, duplicates: 0, suppressed: 0, invalid: 2, total: 2 });
  // All duplicates
  const dup = await importAs(USERS.repA, [{ email: 'kim@bright.test' }], wsA, null, 'all-dupes.csv');
  assert.deepEqual(counts(dup), { added: 0, duplicates: 1, suppressed: 0, invalid: 0, total: 1 });
  // A mixture of all four, in one file
  const mixed = await importAs(USERS.repA, [
    { email: 'kim@bright.test' }, { email: 'stop@bright.test' }, { email: 'bad' }, { email: 'brandnew@bright.test' },
  ], wsA, null, 'mixed.csv');
  assert.deepEqual(counts(mixed), { added: 1, duplicates: 1, suppressed: 1, invalid: 1, total: 4 });
});

test('CSV-11 a company named in the file is created once and linked to its leads', async () => {
  const res = await importAs(USERS.repA, [
    { email: 'a@northwind.test', company: 'Northwind Dental', full_name: 'A' },
    { email: 'b@northwind.test', company: 'northwind dental', full_name: 'B' },
  ], wsA, null, 'companies.csv');
  assert.equal(counts(res).added, 2);
  const made = (await db.query(`select id, name from companies where workspace_id = $1 and lower(name) = 'northwind dental'`, [wsA])).rows;
  assert.equal(made.length, 1, 'one company, matched case-insensitively');
  const linked = (await db.query(`select company_id from leads where email in ('a@northwind.test', 'b@northwind.test')`)).rows;
  assert.deepEqual(linked.map((r) => r.company_id), [made[0].id, made[0].id]);
});

test('CSV-05 viewers cannot import, and nobody can import into another workspace', async () => {
  await assert.rejects(importAs(USERS.viewerA, [{ email: 'x@y.test' }]), /row-level security/);
  await assert.rejects(importAs(USERS.ownerB, [{ email: 'x@y.test' }], wsA, null), /row-level security/);
  assert.equal((await db.query(`select count(*)::int n from leads where email = 'x@y.test'`)).rows[0].n, 0);
});

test('CSV-06 the file size is capped and the payload must be a list', async () => {
  const many = Array.from({ length: 5001 }, (_, i) => ({ email: `b${i}@big.test` }));
  await assert.rejects(importAs(USERS.repA, many), /up to 5000 rows/);
  await assert.rejects(asUser(db, USERS.repA, (tx) => tx.query(
    `select leads_import($1, null, 'x.csv', '{"email":"a@b.test"}'::jsonb)`, [wsA])), /must be a list/);
});

test('CSV-07 an import can be undone, but only untouched leads go', async () => {
  const res = await importAs(USERS.ownerA, [
    { email: 'undo1@bright.test' }, { email: 'undo2@bright.test' }, { email: 'undo3@bright.test' },
  ], wsA, null, 'undo.csv');
  const importId = res.rows[0].r.id;
  // One has been worked, one has an activity: both must survive
  await db.query(`update leads set stage = 'contacted' where email = 'undo1@bright.test'`);
  const kept = (await db.query(`select id from leads where email = 'undo2@bright.test'`)).rows[0].id;
  await asService(db, (tx) => tx.query(
    `insert into activities (workspace_id, lead_id, type, summary, actor) values ($1, $2, 'note', 'Called', 'system')`, [wsA, kept]));

  const removed = (await asUser(db, USERS.ownerA, (tx) => tx.query('select lead_import_undo($1) as n', [importId]))).rows[0].n;
  assert.equal(removed, 1, 'only the untouched lead is removed');
  const left = (await db.query(`select email from leads where email like 'undo%' order by email`)).rows.map((r) => r.email);
  assert.deepEqual(left, ['undo1@bright.test', 'undo2@bright.test']);
  assert.ok((await db.query(`select undone_at from lead_imports where id = $1`, [importId])).rows[0].undone_at);
});

test('CSV-08 only owners and admins undo, and an import is undone once', async () => {
  const res = await importAs(USERS.ownerA, [{ email: 'solo@bright.test' }], wsA, null, 'solo.csv');
  const importId = res.rows[0].r.id;
  await assert.rejects(asUser(db, USERS.repA, (tx) => tx.query('select lead_import_undo($1)', [importId])), /Only owners and admins/);
  assert.equal((await asUser(db, USERS.ownerA, (tx) => tx.query('select lead_import_undo($1) as n', [importId]))).rows[0].n, 1);
  await assert.rejects(asUser(db, USERS.ownerA, (tx) => tx.query('select lead_import_undo($1)', [importId])), /already been undone/);
  assert.equal((await db.query(`select count(*)::int n from leads where email = 'solo@bright.test'`)).rows[0].n, 0);
});

test('CSV-09 members read their own imports only', async () => {
  assert.ok((await asUser(db, USERS.viewerA, (tx) => tx.query('select id from lead_imports'))).rows.length > 0);
  assert.equal((await asUser(db, USERS.ownerB, (tx) => tx.query('select id from lead_imports'))).rows.length, 0);
  await assert.rejects(asUser(db, USERS.ownerA, (tx) => tx.query('delete from lead_imports')), /permission denied/);
});
