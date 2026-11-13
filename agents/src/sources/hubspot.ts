// HubSpot CRM (SRS M9): contacts upserted by email, deals in a chosen
// pipeline associated with their contact, activity notes on the contact, and
// deal stages read back so wins and losses recorded in HubSpot reach the
// platform. Uses a private app access token.

import { ProviderError, isObject, requestJson, str, type Fetch } from '../http.ts';

const BASE = 'https://api.hubapi.com';
const ID = /^[0-9]{1,30}$/;
export const BATCH = 100;

// HubSpot-defined association types
export const DEAL_TO_CONTACT = 3;
export const NOTE_TO_CONTACT = 202;

async function hs(token: string, method: 'GET' | 'POST' | 'PATCH', path: string, body: unknown, fetchImpl?: Fetch): Promise<Record<string, unknown>> {
  const res = await requestJson('HubSpot', `${BASE}${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  }, { fetchImpl, timeoutMs: 30_000 });
  if (!isObject(res)) throw new ProviderError('HubSpot', null, 'HubSpot returned an unexpected response');
  return res;
}

export type ContactInput = { email: string; properties: Record<string, string> };

/** Creates or updates contacts by email; returns email (lower case) to HubSpot id. */
export async function upsertContacts(token: string, contacts: ContactInput[], fetchImpl?: Fetch): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (let i = 0; i < contacts.length; i += BATCH) {
    const chunk = contacts.slice(i, i + BATCH);
    const res = await hs(token, 'POST', '/crm/v3/objects/contacts/batch/upsert', {
      inputs: chunk.map((c) => ({ idProperty: 'email', id: c.email, properties: { ...c.properties, email: c.email } })),
    }, fetchImpl);
    const results = Array.isArray(res.results) ? res.results : [];
    for (const r of results) {
      if (!isObject(r)) continue;
      const id = str(r.id);
      const email = isObject(r.properties) ? str(r.properties.email)?.toLowerCase() : undefined;
      if (id && ID.test(id) && email) out.set(email, id);
    }
  }
  return out;
}

export type DealInput = { name: string; pipeline: string; stage: string; amount: string | null; closeDate: string | null };

function dealProperties(d: DealInput): Record<string, string> {
  const p: Record<string, string> = { dealname: d.name.slice(0, 200), pipeline: d.pipeline, dealstage: d.stage };
  if (d.amount !== null) p.amount = d.amount;
  if (d.closeDate) p.closedate = d.closeDate;
  return p;
}

export async function createDeal(token: string, d: DealInput, contactId: string, fetchImpl?: Fetch): Promise<string> {
  const res = await hs(token, 'POST', '/crm/v3/objects/deals', {
    properties: dealProperties(d),
    associations: [{ to: { id: contactId }, types: [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: DEAL_TO_CONTACT }] }],
  }, fetchImpl);
  const id = str(res.id);
  if (!id || !ID.test(id)) throw new ProviderError('HubSpot', null, 'HubSpot did not return a deal');
  return id;
}

export async function updateDeal(token: string, dealId: string, d: DealInput, fetchImpl?: Fetch): Promise<void> {
  if (!ID.test(dealId)) throw new ProviderError('HubSpot', null, 'The HubSpot deal id is not valid');
  await hs(token, 'PATCH', `/crm/v3/objects/deals/${dealId}`, { properties: dealProperties(d) }, fetchImpl);
}

export async function createNote(token: string, contactId: string, body: string, at: Date, fetchImpl?: Fetch): Promise<string> {
  const res = await hs(token, 'POST', '/crm/v3/objects/notes', {
    properties: { hs_timestamp: at.toISOString(), hs_note_body: body.slice(0, 5000) },
    associations: [{ to: { id: contactId }, types: [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: NOTE_TO_CONTACT }] }],
  }, fetchImpl);
  const id = str(res.id);
  if (!id || !ID.test(id)) throw new ProviderError('HubSpot', null, 'HubSpot did not return a note');
  return id;
}

/** Current deal stage per HubSpot deal id. Missing (deleted) deals are left out. */
export async function readDealStages(token: string, ids: string[], fetchImpl?: Fetch): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const valid = ids.filter((x) => ID.test(x));
  for (let i = 0; i < valid.length; i += BATCH) {
    const res = await hs(token, 'POST', '/crm/v3/objects/deals/batch/read', {
      properties: ['dealstage'], inputs: valid.slice(i, i + BATCH).map((id) => ({ id })),
    }, fetchImpl);
    for (const r of Array.isArray(res.results) ? res.results : []) {
      if (!isObject(r)) continue;
      const id = str(r.id);
      const stage = isObject(r.properties) ? str(r.properties.dealstage) : undefined;
      if (id && stage) out.set(id, stage);
    }
  }
  return out;
}

/** Escapes text placed inside a HubSpot note (the body is HTML). */
export function noteEscape(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
