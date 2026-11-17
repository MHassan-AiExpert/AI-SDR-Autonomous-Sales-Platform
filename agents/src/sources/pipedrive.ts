// Pipedrive CRM (F28): people matched by email, deals linked to the person,
// activity notes on the person, and deal outcomes read back.
//
// Endpoints and field names were taken from Pipedrive's official client
// (generated from its OpenAPI specification), not assumed:
//   API v2  https://api.pipedrive.com/api/v2   persons, persons/search, deals
//   API v1  https://api.pipedrive.com/v1       notes (no v2 equivalent), users/me
// Both accept the API token in the `x-api-token` header, so it never appears
// in a URL or a log line.

import { ProviderError, isObject, requestJson, type Fetch } from '../http.ts';

const V2 = 'https://api.pipedrive.com/api/v2';
const V1 = 'https://api.pipedrive.com/v1';
const ID = /^[0-9]{1,30}$/;
export const READ_BATCH = 100;

async function pd(token: string, method: 'GET' | 'POST' | 'PATCH', url: string, body?: unknown, fetchImpl?: Fetch): Promise<Record<string, unknown>> {
  const res = await requestJson('Pipedrive', url, {
    method,
    headers: { 'x-api-token': token, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  }, { fetchImpl, timeoutMs: 30_000 });
  if (!isObject(res)) throw new ProviderError('Pipedrive', null, 'Pipedrive returned an unexpected response');
  return res;
}

const idOf = (v: unknown): string | null => {
  const s = typeof v === 'number' && Number.isInteger(v) ? String(v) : typeof v === 'string' ? v : '';
  return ID.test(s) ? s : null;
};

export type PersonInput = { name: string; email: string; phone: string | null; job_title: string | null };

/** The person with exactly this email, if Pipedrive has one. */
export async function findPerson(token: string, email: string, fetchImpl?: Fetch): Promise<string | null> {
  const q = new URLSearchParams({ term: email, fields: 'email', exact_match: 'true', limit: '1' });
  const res = await pd(token, 'GET', `${V2}/persons/search?${q}`, undefined, fetchImpl);
  const items = isObject(res.data) && Array.isArray(res.data.items) ? res.data.items : [];
  for (const it of items) {
    const item = isObject(it) && isObject(it.item) ? it.item : null;
    const emails = item && Array.isArray(item.emails) ? item.emails.map((e) => String(e).toLowerCase()) : [];
    // exact_match is case-insensitive on Pipedrive's side; confirm before trusting it
    if (item && emails.includes(email.toLowerCase())) return idOf(item.id);
  }
  return null;
}

function personBody(p: PersonInput, withEmail: boolean) {
  const b: Record<string, unknown> = { name: p.name.slice(0, 255) };
  if (withEmail) b.emails = [{ value: p.email, primary: true, label: 'work' }];
  if (p.phone) b.phones = [{ value: p.phone, primary: true, label: 'work' }];
  if (p.job_title) b.job_title = p.job_title.slice(0, 255);
  return b;
}

/**
 * Creates the person, or updates the one with this email. An update leaves the
 * person's email list alone, so addresses a rep added in Pipedrive are kept.
 */
export async function upsertPerson(token: string, p: PersonInput, fetchImpl?: Fetch): Promise<string> {
  const existing = await findPerson(token, p.email, fetchImpl);
  if (existing) {
    await pd(token, 'PATCH', `${V2}/persons/${existing}`, personBody(p, false), fetchImpl);
    return existing;
  }
  const res = await pd(token, 'POST', `${V2}/persons`, personBody(p, true), fetchImpl);
  const id = isObject(res.data) ? idOf(res.data.id) : null;
  if (!id) throw new ProviderError('Pipedrive', null, 'Pipedrive did not return a person');
  return id;
}

export type PipedriveDeal = {
  title: string; value: number | null; currency: string; status: 'open' | 'won' | 'lost';
  pipeline_id: number | null; stage_id: number | null;
};

function dealBody(d: PipedriveDeal) {
  const b: Record<string, unknown> = { title: d.title.slice(0, 255), status: d.status, currency: d.currency };
  if (d.value !== null) b.value = d.value;
  if (d.pipeline_id !== null) b.pipeline_id = d.pipeline_id;
  if (d.stage_id !== null) b.stage_id = d.stage_id;
  return b;
}

export async function createDeal(token: string, d: PipedriveDeal, personId: string, fetchImpl?: Fetch): Promise<string> {
  const res = await pd(token, 'POST', `${V2}/deals`, { ...dealBody(d), person_id: Number(personId) }, fetchImpl);
  const id = isObject(res.data) ? idOf(res.data.id) : null;
  if (!id) throw new ProviderError('Pipedrive', null, 'Pipedrive did not return a deal');
  return id;
}

export async function updateDeal(token: string, dealId: string, d: PipedriveDeal, fetchImpl?: Fetch): Promise<void> {
  if (!ID.test(dealId)) throw new ProviderError('Pipedrive', null, 'The Pipedrive deal id is not valid');
  await pd(token, 'PATCH', `${V2}/deals/${dealId}`, dealBody(d), fetchImpl);
}

/** Each deal's status (open, won, lost or deleted). Deals Pipedrive no longer returns are left out. */
export async function readDealStatuses(token: string, ids: string[], fetchImpl?: Fetch): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const valid = ids.filter((x) => ID.test(x));
  for (let i = 0; i < valid.length; i += READ_BATCH) {
    const q = new URLSearchParams({ ids: valid.slice(i, i + READ_BATCH).join(','), limit: String(READ_BATCH) });
    const res = await pd(token, 'GET', `${V2}/deals?${q}`, undefined, fetchImpl);
    for (const r of Array.isArray(res.data) ? res.data : []) {
      if (!isObject(r)) continue;
      const id = idOf(r.id);
      if (id && typeof r.status === 'string') out.set(id, r.status);
    }
  }
  return out;
}

/** Pipedrive expects "YYYY-MM-DD HH:MM:SS" in UTC. */
export const pipedriveTime = (d: Date) => d.toISOString().slice(0, 19).replace('T', ' ');

export async function createNote(token: string, personId: string, content: string, at: Date, fetchImpl?: Fetch): Promise<string> {
  const res = await pd(token, 'POST', `${V1}/notes`, { content: content.slice(0, 10_000), person_id: Number(personId), add_time: pipedriveTime(at) }, fetchImpl);
  const id = isObject(res.data) ? idOf(res.data.id) : null;
  if (!id) throw new ProviderError('Pipedrive', null, 'Pipedrive did not return a note');
  return id;
}
