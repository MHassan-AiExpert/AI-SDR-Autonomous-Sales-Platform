import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { createDatabase, seedTwoWorkspaces, asUser, asAnon, asService, insertLead, USERS } from './helpers.mjs';

let db, wsA, wsB, camp, co, kim, lou, token;

const ingest = (tok, signal, as = asAnon) => as(db, (tx) => tx.query('select signal_ingest($1, $2::jsonb) as r', [tok, JSON.stringify(signal)]));
const facts = async (lead) => (await asService(db, (tx) => tx.query('select * from sequence_candidates($1, $2, 100)', [wsA, camp]))).rows.find((r) => r.lead_id === lead)?.facts;
const addSignal = (over = {}) => asService(db, (tx) => tx.query(
  `insert into signals (workspace_id, company_id, lead_id, kind, source, title, fingerprint, created_at, status)
   values ($1, $2, $3, $4, 'web_search', $5, $6, $7, $8) returning id`,
  [wsA, over.company_id === undefined ? co : over.company_id, over.lead_id ?? null, over.kind ?? 'funding', over.title ?? 'Raised a round',
   over.fingerprint ?? `fp-${Math.random().toString(36).slice(2)}`, over.created_at ?? new Date().toISOString(), over.status ?? 'new']));

before(async () => {
  db = await createDatabase();
  ({ wsA, wsB } = await seedTwoWorkspaces(db));
  camp = (await db.query(`insert into campaigns (workspace_id, name, niche) values ($1, 'Austin', 'dentists') returning id`, [wsA])).rows[0].id;
  co = (await db.query(`insert into companies (workspace_id, name, domain) values ($1, 'Bright Teeth', 'brightteeth.com') returning id`, [wsA])).rows[0].id;
  kim = await asUser(db, USERS.repA, (tx) => insertLead(tx, wsA, { email: 'kim@brightteeth.com' }));
  lou = await asUser(db, USERS.repA, (tx) => insertLead(tx, wsA, { email: 'lou@brightteeth.com' }));
  await db.query(`update leads set campaign_id = $1, company_id = $2, verification_status = 'valid' where id = any($3::uuid[])`, [camp, co, [kim, lou]]);
  token = (await db.query('select webhook_token from workspaces where id = $1', [wsA])).rows[0].webhook_token;
});

test('SIGB-01 members read signals; reps and owners dismiss them; a viewer cannot; nobody edits what was found', async () => {
  const id = (await addSignal({ fingerprint: 'fp-permissions' })).rows[0].id;
  assert.equal((await asUser(db, USERS.viewerA, (tx) => tx.query('select id from signals where id = $1', [id]))).rows.length, 1);
  await asUser(db, USERS.repA, (tx) => tx.query(`update signals set status = 'dismissed' where id = $1`, [id]));
  assert.equal((await db.query('select status from signals where id = $1', [id])).rows[0].status, 'dismissed');
  // A viewer's update touches nothing
  await asUser(db, USERS.viewerA, (tx) => tx.query(`update signals set status = 'new' where id = $1`, [id]));
  assert.equal((await db.query('select status from signals where id = $1', [id])).rows[0].status, 'dismissed');
  // The finding itself cannot be rewritten, added or removed by a person
  await assert.rejects(asUser(db, USERS.ownerA, (tx) => tx.query(`update signals set title = 'Edited' where id = $1`, [id])), /permission denied/);
  await assert.rejects(asUser(db, USERS.ownerA, (tx) => tx.query(
    `insert into signals (workspace_id, company_id, kind, source, title, fingerprint) values ($1, $2, 'news', 'web_search', 'x', 'fp-manual-1')`, [wsA, co])), /permission denied/);
  await assert.rejects(asUser(db, USERS.ownerA, (tx) => tx.query('delete from signals where id = $1', [id])), /permission denied/);
});

test('SIGB-02 another workspace sees nothing and changes nothing', async () => {
  assert.equal((await asUser(db, USERS.ownerB, (tx) => tx.query('select id from signals'))).rows.length, 0);
  await asUser(db, USERS.ownerB, (tx) => tx.query(`update signals set status = 'used'`));
  assert.equal((await db.query(`select count(*)::int n from signals where status = 'used'`)).rows[0].n, 0);
});

test('SIGB-03 a signal is about someone, and the same event is stored once', async () => {
  await assert.rejects(addSignal({ company_id: null, fingerprint: 'fp-about-nobody' }), /signals_about_someone/);
  await addSignal({ fingerprint: 'fp-twice-over' });
  await assert.rejects(addSignal({ fingerprint: 'fp-twice-over' }), /duplicate key/);
});

test('SIGB-04 a tool can send a signal to the webhook address, matched by domain', async () => {
  const r = (await ingest(token, { kind: 'intent_surge', title: 'Researching patient booking software', domain: 'https://www.brightteeth.com/about', provider: 'Bombora', url: 'https://bombora.example/x', id: 'evt-1' })).rows[0].r;
  assert.deepEqual(r, { stored: true, duplicate: false });
  const row = (await db.query(`select kind, source, provider, company_id, lead_id, url from signals where source = 'ingest' and kind = 'intent_surge' and provider = 'bombora'`)).rows[0];
  assert.deepEqual(row, { kind: 'intent_surge', source: 'ingest', provider: 'bombora', company_id: co, lead_id: null, url: 'https://bombora.example/x' });
  // Sending the same event again stores nothing
  assert.deepEqual((await ingest(token, { kind: 'intent_surge', title: 'Researching patient booking software', domain: 'brightteeth.com', id: 'evt-1', provider: 'bombora' })).rows[0].r,
    { stored: false, duplicate: true });
  // Another tool's event 1 is a different event
  assert.deepEqual((await ingest(token, { kind: 'intent_surge', title: 'In-market for scheduling tools', domain: 'brightteeth.com', id: 'evt-1', provider: '6sense' })).rows[0].r,
    { stored: true, duplicate: false });
  assert.equal((await db.query(`select count(*)::int n from signals where source = 'ingest' and kind = 'intent_surge'`)).rows[0].n, 2);
});

test('SIGB-05 a signal matched by email is about that person', async () => {
  const r = (await ingest(token, { kind: 'social_post', title: 'Asked on Reddit for booking software', email: 'KIM@brightteeth.com', provider: 'syften', url: 'javascript:alert(1)' })).rows[0].r;
  assert.equal(r.stored, true);
  const row = (await db.query(`select lead_id, company_id, url from signals where kind = 'social_post'`)).rows[0];
  assert.deepEqual(row, { lead_id: kim, company_id: co, url: null }, 'a link that is not http(s) is dropped');
});

test('SIGB-06 the address refuses a wrong token, an unknown kind, a missing title, a huge body, and someone not in the workspace', async () => {
  await assert.rejects(ingest('x'.repeat(64), { kind: 'news', title: 'x', domain: 'brightteeth.com' }), /Unknown webhook address/);
  await assert.rejects(ingest(null, { kind: 'news', title: 'x' }), /Unknown webhook address/);
  await assert.rejects(ingest(token, { kind: 'gossip', title: 'x', domain: 'brightteeth.com' }), /Unknown kind/);
  await assert.rejects(ingest(token, { kind: 'news', title: '  ', domain: 'brightteeth.com' }), /needs a title/);
  await assert.rejects(ingest(token, { kind: 'news', title: 'x', domain: 'brightteeth.com', detail: 'y'.repeat(9000) }), /at most 8 KB/);
  // A stranger's domain is not stored: the address cannot be used as a dump for arbitrary data
  assert.deepEqual((await ingest(token, { kind: 'news', title: 'Someone else', domain: 'stranger.example' })).rows[0].r,
    { stored: false, reason: 'No company or lead in this workspace matches that domain or email' });
  // Workspace B's token cannot write into workspace A
  const tokenB = (await db.query('select webhook_token from workspaces where id = $1', [wsB])).rows[0].webhook_token;
  assert.equal((await ingest(tokenB, { kind: 'news', title: 'Cross-workspace', domain: 'brightteeth.com' })).rows[0].r.stored, false);
});

test('SIGB-07 the sequence sees the newest unused signal, for the person or their company', async () => {
  await db.query(`update signals set status = 'used' where workspace_id = $1`, [wsA]);
  assert.equal((await facts(lou)).signal_new, false);
  // Too old to count
  await addSignal({ title: 'Old news', created_at: new Date(Date.now() - 40 * 86_400_000).toISOString() });
  assert.equal((await facts(lou)).signal_new, false);
  // A company signal reaches every lead at the company
  await addSignal({ kind: 'hiring', title: 'Hiring two coordinators' });
  for (const lead of [kim, lou]) {
    const f = await facts(lead);
    assert.deepEqual({ n: f.signal_new, k: f.signal_kind, t: f.signal_title }, { n: true, k: 'hiring', t: 'Hiring two coordinators' });
  }
  // A signal about Kim alone does not reach Lou
  await db.query(`update signals set status = 'used' where workspace_id = $1`, [wsA]);
  await addSignal({ lead_id: kim, kind: 'job_change', title: 'Kim moved to Northwind' });
  assert.equal((await facts(kim)).signal_new, true);
  assert.equal((await facts(lou)).signal_new, false);
});

test('SIGB-08 a campaign chooses which built-in kinds to watch for; job changes are opt-in', async () => {
  const kinds = (await db.query('select signal_kinds, signals_enabled from campaigns where id = $1', [camp])).rows[0];
  assert.deepEqual(kinds, { signal_kinds: ['funding', 'news', 'hiring', 'tech_change'], signals_enabled: false });
  await asUser(db, USERS.ownerA, (tx) => tx.query(`update campaigns set signal_kinds = array['tech_change', 'job_change'] where id = $1`, [camp]));
  await assert.rejects(asUser(db, USERS.ownerA, (tx) => tx.query(`update campaigns set signal_kinds = array['gossip'] where id = $1`, [camp])), /check constraint/);
});

test('SIGB-09 the signals agent is scheduled daily where a campaign watches for signals', async () => {
  const count = async () => (await db.query(`select count(*)::int n from agent_jobs where campaign_id = $1 and type = 'signals'`, [camp])).rows[0].n;
  const enqueue = () => asService(db, (tx) => tx.query('select agent_jobs_enqueue_due(24)'));
  await db.query(`update campaigns set status = 'active' where id = $1`, [camp]);
  await enqueue();
  assert.equal(await count(), 0);
  await db.query(`update campaigns set signals_enabled = true where id = $1`, [camp]);
  await enqueue();
  assert.equal(await count(), 1);
  await db.query(`update agent_jobs set status = 'succeeded' where campaign_id = $1`, [camp]);
  await db.query(`update agent_jobs set created_at = now() - interval '23 hours' where campaign_id = $1 and type = 'signals'`, [camp]);
  await enqueue();
  assert.equal(await count(), 1, 'not again within the day');
  await db.query(`update agent_jobs set created_at = now() - interval '25 hours' where campaign_id = $1 and type = 'signals'`, [camp]);
  await enqueue();
  assert.equal(await count(), 2);
});

test('SIGB-10 a visitor cannot read signals or the facts, and can only reach the ingest address', async () => {
  await assert.rejects(asAnon(db, (tx) => tx.query('select * from signals')), /permission denied/);
  await assert.rejects(asAnon(db, (tx) => tx.query('select * from sequence_candidates($1, $1, 1)', [wsA])), /permission denied/);
});
