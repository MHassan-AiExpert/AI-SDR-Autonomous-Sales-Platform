// Runs an Apify actor synchronously and returns its dataset items.

import { requestJson, type Fetch } from '../http.ts';

export async function runActor(actor: string, input: unknown, token: string, fetchImpl?: Fetch): Promise<unknown[]> {
  const url = `https://api.apify.com/v2/acts/${actor}/run-sync-get-dataset-items?timeout=240&format=json&clean=true`;
  const body = await requestJson('Apify', url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  }, { fetchImpl, timeoutMs: 300_000 });
  return Array.isArray(body) ? body : [];
}
