import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { createDatabase, seedTwoWorkspaces, asUser, asService, USERS } from './helpers.mjs';

let db, wsA, wsB, coA;

before(async () => {
  db = await createDatabase();
  ({ wsA, wsB } = await seedTwoWorkspaces(db));
  coA = (await db.query(`insert into companies (workspace_id, name, domain) values ($1, 'Alpha', 'alpha.com') returning id`, [wsA])).rows[0].id;
});

const attempt = (tx, ws, provider, outcome, contacts = 0, company = null) =>
  tx.query(`insert into enrichment_attempts (workspace_id, company_id, provider, outcome, contacts) values ($1, $2, $3, $4, $5)`,
    [ws, company, provider, outcome, contacts]);

test('WFD-01 every workspace starts with the order Apollo, Hunter, People Data Labs', async () => {
  const { rows } = await db.query('select enrichment_order from workspaces where id = $1', [wsA]);
  assert.deepEqual(rows[0].enrichment_order, ['apollo', 'hunter', 'pdl']);
});

test('WFD-02 owners and admins can reorder or drop providers; reps cannot', async () => {
  await asUser(db, USERS.adminA, (tx) => tx.query(`update workspaces set enrichment_order = '{hunter,apollo}' where id = $1`, [wsA]));
  assert.deepEqual((await db.query('select enrichment_order from workspaces where id = $1', [wsA])).rows[0].enrichment_order, ['hunter', 'apollo']);
  const rep = await asUser(db, USERS.repA, (tx) => tx.query(`update workspaces set enrichment_order = '{pdl}' where id = $1 returning id`, [wsA]));
  assert.equal(rep.rows.length, 0);
  await db.query(`update workspaces set enrichment_order = '{apollo,hunter,pdl}' where id = $1`, [wsA]);
});

test('WFD-03 an order with an unknown or repeated provider is refused', async () => {
  for (const bad of ['{apollo,apollo}', '{clearbit}', '{apollo,hunter,pdl,apollo}']) {
    await assert.rejects(db.query(`update workspaces set enrichment_order = $2 where id = $1`, [wsA, bad]), /check constraint/);
  }
  await db.query(`update workspaces set enrichment_order = '{}' where id = $1`, [wsB]); // websites only is allowed
  await db.query(`update workspaces set enrichment_order = '{apollo,hunter,pdl}' where id = $1`, [wsB]);
});

test('WFD-04 Hunter and People Data Labs can be connected like any other tool', async () => {
  for (const tool of ['hunter', 'pdl']) {
    await asUser(db, USERS.ownerA, (tx) => tx.query('select integration_connect($1, $2, $3::jsonb)', [wsA, tool, JSON.stringify({ api_key: `${tool}-secret-key` })]));
  }
  const { rows } = await db.query(`select tool, status from integrations where workspace_id = $1 and tool in ('hunter', 'pdl') order by tool`, [wsA]);
  assert.deepEqual(rows, [{ tool: 'hunter', status: 'connected' }, { tool: 'pdl', status: 'connected' }]);
});

test('WFD-05 a lead records which provider found it, from a fixed list', async () => {
  await db.query(`insert into leads (workspace_id, email, source_channel, enrichment_provider) values ($1, 'a@alpha.com', 'llm_search', 'hunter')`, [wsA]);
  await assert.rejects(db.query(`insert into leads (workspace_id, email, source_channel, enrichment_provider) values ($1, 'b@alpha.com', 'llm_search', 'clearbit')`, [wsA]), /check constraint/);
});

test('WFD-06 only the agent service records attempts; members read their own workspace only', async () => {
  await asService(db, async (tx) => {
    await attempt(tx, wsA, 'apollo', 'no_match', 0, coA);
    await attempt(tx, wsA, 'hunter', 'found', 1, coA);
    await attempt(tx, wsB, 'apollo', 'found', 2);
  });
  await assert.rejects(asUser(db, USERS.ownerA, (tx) => attempt(tx, wsA, 'pdl', 'found', 1)), /permission denied/);
  const seen = await asUser(db, USERS.viewerA, (tx) => tx.query('select workspace_id from enrichment_attempts'));
  assert.ok(seen.rows.length === 2 && seen.rows.every((r) => r.workspace_id === wsA));
  const outsider = await asUser(db, USERS.ownerB, (tx) => tx.query('select * from enrichment_attempts where workspace_id = $1', [wsA]));
  assert.equal(outsider.rows.length, 0);
});

test('WFD-07 an attempt is found exactly when it has contacts, and cannot point at another workspace\'s company', async () => {
  await assert.rejects(asService(db, (tx) => attempt(tx, wsA, 'apollo', 'found', 0)), /check constraint/);
  await assert.rejects(asService(db, (tx) => attempt(tx, wsA, 'apollo', 'no_match', 2)), /check constraint/);
  await assert.rejects(asService(db, (tx) => attempt(tx, wsB, 'apollo', 'no_match', 0, coA)), /foreign key/);
});

test('WFD-08 the stats give attempts, matches and match rate per provider, errors not counted as attempts', async () => {
  await asService(db, async (tx) => {
    await attempt(tx, wsA, 'apollo', 'found', 2);
    await attempt(tx, wsA, 'apollo', 'error');
    await attempt(tx, wsA, 'website', 'no_match');
  });
  const { rows } = await asUser(db, USERS.repA, (tx) => tx.query('select * from enrichment_provider_stats($1)', [wsA]));
  const out = rows.map((r) => [r.provider, Number(r.attempts), Number(r.found), Number(r.errors), r.match_rate === null ? null : Number(r.match_rate), Number(r.leads)]);
  assert.deepEqual(out, [
    ['apollo', 2, 1, 1, 50, 0],
    ['hunter', 1, 1, 0, 100, 1],
    ['website', 1, 0, 0, 0, 0],
  ]);
  const other = await asUser(db, USERS.ownerB, (tx) => tx.query('select * from enrichment_provider_stats($1)', [wsA]));
  assert.equal(other.rows.length, 0, 'another workspace sees nothing');
});

test('WFD-09 deleting a company keeps its attempts, so match rates are not rewritten', async () => {
  await db.query('delete from companies where id = $1', [coA]);
  const { rows } = await db.query(`select count(*)::int n from enrichment_attempts where workspace_id = $1 and company_id is null and provider = 'hunter'`, [wsA]);
  assert.equal(rows[0].n, 1);
});
