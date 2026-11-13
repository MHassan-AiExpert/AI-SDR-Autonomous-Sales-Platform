// Vapi: outbound AI phone calls with the company's own assistant and number.

import { requestJson, isObject, str, type Fetch } from '../http.ts';

export type StartCall = {
  assistantId: string; phoneNumberId: string; number: string; name?: string;
  firstMessage: string; systemPrompt: string; model: string; variables: Record<string, string>;
  serverUrl: string; analysisSchema: Record<string, unknown>;
};

export function callBody(c: StartCall) {
  return {
    assistantId: c.assistantId,
    phoneNumberId: c.phoneNumberId,
    customer: { number: c.number, ...(c.name ? { name: c.name.slice(0, 40) } : {}) },
    assistantOverrides: {
      firstMessage: c.firstMessage,
      model: { provider: 'openai', model: c.model, messages: [{ role: 'system', content: c.systemPrompt }] },
      variableValues: c.variables,
      server: { url: c.serverUrl, timeoutSeconds: 20 },
      serverMessages: ['end-of-call-report', 'status-update'],
      analysisPlan: { structuredDataPlan: { enabled: true, schema: c.analysisSchema } },
    },
  };
}

export async function startCall(apiKey: string, c: StartCall, fetchImpl?: Fetch): Promise<string> {
  const body = await requestJson('Vapi', 'https://api.vapi.ai/call', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(callBody(c)),
  }, { fetchImpl, timeoutMs: 30_000 });
  const id = isObject(body) ? str(body.id) : undefined;
  if (!id) throw new Error('Vapi did not return a call id');
  return id;
}

/** The call as Vapi has it in the company's own account: the trusted copy of an inbound call. */
export async function getCall(apiKey: string, id: string, fetchImpl?: Fetch): Promise<Record<string, unknown> | null> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
  try {
    const body = await requestJson('Vapi', `https://api.vapi.ai/call/${encodeURIComponent(id)}`, {
      method: 'GET', headers: { Authorization: `Bearer ${apiKey}` },
    }, { fetchImpl, timeoutMs: 20_000 });
    return isObject(body) ? body : null;
  } catch (err) {
    if (err instanceof Error && 'status' in err && (err as { status: number | null }).status === 404) return null;
    throw err;
  }
}
