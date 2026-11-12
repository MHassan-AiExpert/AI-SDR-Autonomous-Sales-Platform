// Test database: the real migrations on PGlite, served over the Postgres wire
// protocol so the agent service's own postgres.js client talks to it.

import { PGLiteSocketServer } from '@electric-sql/pglite-socket';
// @ts-expect-error plain JavaScript test helpers shared with the database tests
import { createDatabase, seedTwoWorkspaces, asUser, USERS } from '../../tests/db/helpers.mjs';
import { connect, Store, type Sql } from '../src/store.ts';

export { asUser, USERS };

export type TestDb = { db: any; sql: Sql; store: Store; wsA: string; wsB: string; close: () => Promise<void> };

export async function startTestDb(port: number): Promise<TestDb> {
  const db = await createDatabase();
  const { wsA, wsB } = await seedTwoWorkspaces(db);
  const server = new PGLiteSocketServer({ db, port, host: '127.0.0.1' });
  await server.start();
  // PGlite has a single connection, so the client uses one too
  const sql = connect(`postgres://postgres:postgres@127.0.0.1:${port}/postgres`, { max: 1 });
  return {
    db, sql, store: new Store(sql), wsA, wsB,
    close: async () => {
      await sql.end({ timeout: 1 });
      await server.stop();
      await db.close();
    },
  };
}

/** A fake fetch that answers by URL and records every call. */
export function fakeFetch(routes: Array<[RegExp, (url: string, init: RequestInit) => unknown | Response]>) {
  const calls: { url: string; init: RequestInit }[] = [];
  const impl = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = String(input);
    calls.push({ url, init });
    const route = routes.find(([re]) => re.test(url));
    if (!route) return new Response(JSON.stringify({ error: 'no route' }), { status: 404 });
    const out = await route[1](url, init);
    return out instanceof Response ? out : new Response(JSON.stringify(out), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch;
  return { impl, calls };
}
