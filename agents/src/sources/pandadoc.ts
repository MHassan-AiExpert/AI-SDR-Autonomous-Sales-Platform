// PandaDoc: the proposal from the company's own template, filled with the
// agreed plan and the payment link, sent to the prospect for e-signature.

import { ProviderError, describeStatus, isObject, str, type Fetch } from '../http.ts';

const API = 'https://api.pandadoc.com/public/v1';

async function pd(key: string, path: string, init: { method: string; body?: unknown }, fetchImpl: Fetch = fetch): Promise<Record<string, unknown>> {
  let res: Response;
  try {
    res = await fetchImpl(`${API}/${path}`, {
      method: init.method,
      headers: { Authorization: `API-Key ${key}`, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      redirect: 'error',
      signal: AbortSignal.timeout(30_000),
    });
  } catch (err) {
    const timedOut = err instanceof Error && err.name === 'TimeoutError';
    throw new ProviderError('PandaDoc', null, timedOut ? 'PandaDoc did not respond in time' : 'Could not reach PandaDoc');
  }
  let body: unknown = {};
  try { body = await res.json(); } catch { /* empty body */ }
  if (!res.ok) throw new ProviderError('PandaDoc', res.status, res.status === 400 ? 'PandaDoc rejected the proposal: check the template ID and its roles' : describeStatus('PandaDoc', res.status));
  return isObject(body) ? body : {};
}

export type Proposal = {
  templateId: string; name: string; recipient: { email: string; first_name?: string; last_name?: string; role: string };
  tokens: Record<string, string>; message: string; subject: string;
};

export function documentBody(p: Proposal) {
  return {
    name: p.name.slice(0, 200),
    template_uuid: p.templateId,
    recipients: [{ email: p.recipient.email, first_name: p.recipient.first_name ?? '', last_name: p.recipient.last_name ?? '', role: p.recipient.role }],
    tokens: Object.entries(p.tokens).map(([name, value]) => ({ name, value })),
    metadata: { source: 'ai_sdr_platform' },
  };
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Creates the document, waits until PandaDoc has prepared it, and sends it. Returns its id. */
export async function sendProposal(key: string, p: Proposal, fetchImpl?: Fetch, pauseMs = 1500): Promise<string> {
  const created = await pd(key, 'documents', { method: 'POST', body: documentBody(p) }, fetchImpl);
  const id = str(created.id);
  if (!id || !/^[A-Za-z0-9]{10,40}$/.test(id)) throw new ProviderError('PandaDoc', null, 'PandaDoc did not return a document');
  let status = str(created.status);
  for (let i = 0; status !== 'document.draft' && i < 10; i++) {
    await wait(pauseMs);
    status = str((await pd(key, `documents/${id}`, { method: 'GET' }, fetchImpl)).status);
    if (status === 'document.error') throw new ProviderError('PandaDoc', null, 'PandaDoc could not prepare the proposal from the template');
  }
  if (status !== 'document.draft') throw new ProviderError('PandaDoc', null, 'PandaDoc is still preparing the proposal; it will be retried');
  await pd(key, `documents/${id}/send`, { method: 'POST', body: { subject: p.subject.slice(0, 200), message: p.message.slice(0, 2000), silent: false } }, fetchImpl);
  return id;
}
