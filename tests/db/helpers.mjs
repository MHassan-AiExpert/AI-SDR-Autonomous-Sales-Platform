// Test harness: applies the real migrations to an in-process PostgreSQL
// (PGlite) with a minimal stand-in for the Supabase auth schema and roles.
import { PGlite } from '@electric-sql/pglite';
import { readFileSync, readdirSync } from 'node:fs';

const migrationsDir = new URL('../../supabase/migrations/', import.meta.url);

const SUPABASE_STUB = `
  create role anon nologin;
  create role authenticated nologin;
  create role service_role nologin bypassrls;
  create schema auth;
  create table auth.users (id uuid primary key, email text);
  create function auth.uid() returns uuid language sql stable as $$
    select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
  $$;
  grant usage on schema auth to anon, authenticated, service_role;
  grant execute on function auth.uid() to anon, authenticated, service_role;
  grant usage on schema public to anon, authenticated, service_role;
`;

export const USERS = {
  ownerA: '00000000-0000-4000-8000-00000000000a',
  adminA: '00000000-0000-4000-8000-0000000000a1',
  repA: '00000000-0000-4000-8000-0000000000a2',
  viewerA: '00000000-0000-4000-8000-0000000000a3',
  ownerB: '00000000-0000-4000-8000-00000000000b',
  outsider: '00000000-0000-4000-8000-0000000000ff',
};

export function migrationFiles() {
  return readdirSync(migrationsDir).filter((f) => f.endsWith('.sql')).sort();
}

export async function createDatabase() {
  const db = new PGlite();
  await db.exec(SUPABASE_STUB);
  for (const file of migrationFiles()) {
    await db.exec(readFileSync(new URL(file, migrationsDir), 'utf8'));
  }
  for (const [name, id] of Object.entries(USERS)) {
    await db.query('insert into auth.users (id, email) values ($1, $2)', [id, `${name}@example.test`]);
  }
  return db;
}

// Run queries as a signed-in user. Rolls back on error, like a failed request.
export async function asUser(db, userId, fn) {
  return db.transaction(async (tx) => {
    await tx.query(`select set_config('request.jwt.claim.sub', $1, true)`, [userId]);
    await tx.exec('set local role authenticated');
    return fn(tx);
  });
}

export async function asAnon(db, fn) {
  return db.transaction(async (tx) => {
    await tx.exec('set local role anon');
    return fn(tx);
  });
}

// Run as the backend service role (bypasses RLS, still bound by constraints).
export async function asService(db, fn) {
  return db.transaction(async (tx) => {
    await tx.exec('set local role service_role');
    return fn(tx);
  });
}

// Two companies: workspace A with a full team, workspace B with one owner.
export async function seedTwoWorkspaces(db) {
  const wsA = await asUser(db, USERS.ownerA, async (tx) => {
    const { rows } = await tx.query(`insert into workspaces (name) values ('Company A') returning id`);
    const id = rows[0].id;
    await tx.query(
      `insert into workspace_members (workspace_id, user_id, role) values ($1,$2,'admin'),($1,$3,'rep'),($1,$4,'viewer')`,
      [id, USERS.adminA, USERS.repA, USERS.viewerA],
    );
    return id;
  });
  const wsB = await asUser(db, USERS.ownerB, async (tx) => {
    const { rows } = await tx.query(`insert into workspaces (name) values ('Company B') returning id`);
    return rows[0].id;
  });
  return { wsA, wsB };
}

export async function insertLead(tx, workspaceId, overrides = {}) {
  const lead = { email: 'lead@acme.test', source_channel: 'apollo', full_name: 'Test Lead', ...overrides };
  const cols = ['workspace_id', ...Object.keys(lead)];
  const vals = [workspaceId, ...Object.values(lead)];
  const { rows } = await tx.query(
    `insert into leads (${cols.join(',')}) values (${cols.map((_, i) => `$${i + 1}`).join(',')}) returning id`,
    vals,
  );
  return rows[0].id;
}
