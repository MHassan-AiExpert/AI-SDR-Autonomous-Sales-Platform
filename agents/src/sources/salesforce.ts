// Salesforce CRM (F28): contacts matched by email, opportunities linked to the
// contact through a contact role, activity logged as completed tasks, and
// opportunity outcomes read back.
//
// Sign-in uses the OAuth 2.0 client credentials flow, Salesforce's
// server-to-server option: a connected app with "Enable Client Credentials
// Flow" and a run-as user. The token comes from the org's own My Domain host
// (POST https://{MyDomain}.my.salesforce.com/services/oauth2/token), so the
// agent only ever talks to that host, and no user password is stored.
//
// Records are created and updated with sObject Collections (up to 200 per
// request, results in request order) and read with SOQL.

import { ProviderError, isObject, requestJson, str, type Fetch } from '../http.ts';

export const API_VERSION = 'v62.0';
export const COLLECTION_BATCH = 200;
const QUERY_BATCH = 100;
export const SF_ID = /^[A-Za-z0-9]{15}([A-Za-z0-9]{3})?$/;

/** A Salesforce My Domain host, production or sandbox. Anything else is refused. */
export const SF_HOST = /^[a-z0-9-]{1,80}(\.(sandbox|develop|scratch))?\.my\.salesforce\.com$/;

/** The host from what a person typed: a host, or a URL with or without a path. */
export function salesforceHost(input: string): string | null {
  const s = input.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/[/?#].*$/, '').replace(/\.$/, '');
  return SF_HOST.test(s) ? s : null;
}

export type SfAuth = { host: string; token: string };

/** Signs in with the client credentials flow. Wrong credentials surface as 401. */
export async function getToken(cfg: { domain: string; client_id: string; client_secret: string }, fetchImpl: Fetch = fetch): Promise<SfAuth> {
  const host = salesforceHost(cfg.domain ?? '');
  if (!host) throw new ProviderError('Salesforce', 401, 'The Salesforce My Domain is not valid. Reconnect Salesforce in Setup.');
  let res: unknown;
  try {
    res = await requestJson('Salesforce', `https://${host}/services/oauth2/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'client_credentials', client_id: cfg.client_id, client_secret: cfg.client_secret }).toString(),
    }, { fetchImpl, timeoutMs: 20_000 });
  } catch (err) {
    // Salesforce answers bad client credentials with 400 invalid_client
    if (err instanceof ProviderError && err.status === 400) throw new ProviderError('Salesforce', 401, 'Salesforce rejected the stored credentials');
    throw err;
  }
  const token = isObject(res) ? str(res.access_token) : undefined;
  if (!token) throw new ProviderError('Salesforce', null, 'Salesforce did not return an access token');
  return { host, token };
}

async function sf(auth: SfAuth, method: 'GET' | 'POST' | 'PATCH', path: string, body?: unknown, fetchImpl?: Fetch): Promise<unknown> {
  return requestJson('Salesforce', `https://${auth.host}/services/data/${API_VERSION}${path}`, {
    method,
    headers: { Authorization: `Bearer ${auth.token}`, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  }, { fetchImpl, timeoutMs: 30_000, allowEmpty: true });
}

/** A SOQL string literal. Backslashes and quotes are escaped, so data cannot change the query. */
export function soqlString(s: string): string {
  return `'${s.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
}

async function query(auth: SfAuth, soql: string, fetchImpl?: Fetch): Promise<Record<string, unknown>[]> {
  const res = await sf(auth, 'GET', `/query?q=${encodeURIComponent(soql)}`, undefined, fetchImpl);
  return isObject(res) && Array.isArray(res.records) ? res.records.filter(isObject) : [];
}

type SaveResult = { id: string | null; error: string | null };

function readResults(res: unknown, n: number): SaveResult[] {
  if (!Array.isArray(res) || res.length !== n) throw new ProviderError('Salesforce', null, 'Salesforce returned an unexpected response');
  return res.map((r) => {
    if (isObject(r) && r.success === true) return { id: str(r.id) ?? null, error: null };
    const e = isObject(r) && Array.isArray(r.errors) && isObject(r.errors[0]) ? r.errors[0] : null;
    return { id: null, error: e ? `${str(e.statusCode) ?? 'ERROR'}: ${str(e.message) ?? ''}`.slice(0, 200) : 'Salesforce did not save the record' };
  });
}

/** Creates records with sObject Collections; results are in request order. */
export async function createRecords(auth: SfAuth, type: string, records: Record<string, unknown>[], fetchImpl?: Fetch): Promise<SaveResult[]> {
  const out: SaveResult[] = [];
  for (let i = 0; i < records.length; i += COLLECTION_BATCH) {
    const chunk = records.slice(i, i + COLLECTION_BATCH);
    const res = await sf(auth, 'POST', '/composite/sobjects', { allOrNone: false, records: chunk.map((r) => ({ attributes: { type }, ...r })) }, fetchImpl);
    out.push(...readResults(res, chunk.length));
  }
  return out;
}

/** Updates records (each with its Id) with sObject Collections. */
export async function updateRecords(auth: SfAuth, type: string, records: (Record<string, unknown> & { Id: string })[], fetchImpl?: Fetch): Promise<SaveResult[]> {
  const out: SaveResult[] = [];
  for (let i = 0; i < records.length; i += COLLECTION_BATCH) {
    const chunk = records.slice(i, i + COLLECTION_BATCH);
    const res = await sf(auth, 'PATCH', '/composite/sobjects', {
      allOrNone: false, records: chunk.map(({ Id, ...rest }) => ({ attributes: { type }, id: Id, ...rest })),
    }, fetchImpl);
    out.push(...readResults(res, chunk.length));
  }
  return out;
}

const EMAIL = /^[^\s@'"\\]{1,64}@[^\s@'"\\]{1,255}\.[A-Za-z]{2,}$/;

/** Existing contacts by email (lower case), the oldest one when there are several. */
export async function findContacts(auth: SfAuth, emails: string[], fetchImpl?: Fetch): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const valid = [...new Set(emails.map((e) => e.toLowerCase()).filter((e) => EMAIL.test(e)))];
  for (let i = 0; i < valid.length; i += QUERY_BATCH) {
    const list = valid.slice(i, i + QUERY_BATCH).map(soqlString).join(', ');
    for (const r of await query(auth, `SELECT Id, Email FROM Contact WHERE Email IN (${list}) ORDER BY CreatedDate ASC`, fetchImpl)) {
      const id = str(r.Id);
      const email = str(r.Email)?.toLowerCase();
      if (id && SF_ID.test(id) && email && !out.has(email)) out.set(email, id);
    }
  }
  return out;
}

export type ContactFields = { FirstName?: string; LastName: string; Email: string; Phone?: string; Title?: string };

/** Creates or updates contacts by email; returns email (lower case) to Salesforce id. */
export async function upsertContacts(auth: SfAuth, contacts: ContactFields[], fetchImpl?: Fetch): Promise<{ ids: Map<string, string>; errors: string[] }> {
  const ids = await findContacts(auth, contacts.map((c) => c.Email), fetchImpl);
  const errors: string[] = [];
  const fresh = contacts.filter((c) => !ids.has(c.Email.toLowerCase()));
  const known = contacts.filter((c) => ids.has(c.Email.toLowerCase()));
  // An update leaves the email alone: it is how the contact was found
  const upd = await updateRecords(auth, 'Contact', known.map(({ Email: _e, ...rest }) => ({ ...rest, Id: ids.get(_e.toLowerCase())! })), fetchImpl);
  upd.forEach((r, i) => { if (r.error) { errors.push(r.error); ids.delete(known[i].Email.toLowerCase()); } });
  const made = await createRecords(auth, 'Contact', fresh, fetchImpl);
  made.forEach((r, i) => {
    if (r.id && SF_ID.test(r.id)) ids.set(fresh[i].Email.toLowerCase(), r.id);
    else if (r.error) errors.push(r.error);
  });
  return { ids, errors };
}

export type OpportunityFields = { Name: string; StageName: string; Amount?: number; CloseDate?: string };

async function one(auth: SfAuth, type: string, fields: Record<string, unknown>, fetchImpl?: Fetch): Promise<string> {
  const res = await sf(auth, 'POST', `/sobjects/${type}/`, fields, fetchImpl);
  const id = isObject(res) && res.success !== false ? str(res.id) : undefined;
  if (!id || !SF_ID.test(id)) throw new ProviderError('Salesforce', null, `Salesforce did not return a ${type}`);
  return id;
}

/** Thirty days from `now`, as Salesforce's YYYY-MM-DD; CloseDate is required on an open opportunity. */
export const defaultCloseDate = (now = new Date()) => new Date(now.getTime() + 30 * 86_400_000).toISOString().slice(0, 10);

/**
 * Creates the opportunity and makes the contact its primary contact role. The
 * role is best effort: the opportunity's id is returned either way, so a
 * failed role never leads to a second opportunity on the next run.
 */
export async function createOpportunity(auth: SfAuth, o: OpportunityFields, contactId: string, fetchImpl?: Fetch, now = new Date()): Promise<{ id: string; roleError: string | null }> {
  const id = await one(auth, 'Opportunity', { ...o, CloseDate: o.CloseDate ?? defaultCloseDate(now) }, fetchImpl);
  try {
    await one(auth, 'OpportunityContactRole', { OpportunityId: id, ContactId: contactId, IsPrimary: true }, fetchImpl);
    return { id, roleError: null };
  } catch (err) {
    return { id, roleError: err instanceof Error ? err.message : 'The contact role was not saved' };
  }
}

export async function updateOpportunity(auth: SfAuth, id: string, o: OpportunityFields, fetchImpl?: Fetch): Promise<void> {
  if (!SF_ID.test(id)) throw new ProviderError('Salesforce', null, 'The Salesforce opportunity id is not valid');
  await sf(auth, 'PATCH', `/sobjects/Opportunity/${id}`, o, fetchImpl);
}

/**
 * Won or lost per opportunity id, from IsWon and IsClosed. These follow the
 * org's own stage settings, so custom stage names need no mapping to be read.
 */
export async function readOutcomes(auth: SfAuth, ids: string[], fetchImpl?: Fetch): Promise<Map<string, 'won' | 'lost' | 'open'>> {
  const out = new Map<string, 'won' | 'lost' | 'open'>();
  const valid = ids.filter((x) => SF_ID.test(x));
  for (let i = 0; i < valid.length; i += QUERY_BATCH) {
    const list = valid.slice(i, i + QUERY_BATCH).map(soqlString).join(', ');
    for (const r of await query(auth, `SELECT Id, IsWon, IsClosed FROM Opportunity WHERE Id IN (${list})`, fetchImpl)) {
      const id = str(r.Id);
      if (!id) continue;
      // Salesforce returns 18-character ids; match on what was stored
      const key = valid.find((v) => v === id || v === id.slice(0, 15) || id === v.slice(0, 15)) ?? id;
      out.set(key, r.IsWon === true ? 'won' : r.IsClosed === true ? 'lost' : 'open');
    }
  }
  return out;
}

/** A completed task on the contact: how Salesforce records a logged activity. */
export async function createTask(auth: SfAuth, contactId: string, subject: string, description: string, at: Date, fetchImpl?: Fetch): Promise<string> {
  return one(auth, 'Task', {
    WhoId: contactId, Subject: subject.slice(0, 255), Description: description.slice(0, 32_000),
    Status: 'Completed', ActivityDate: at.toISOString().slice(0, 10),
  }, fetchImpl);
}
