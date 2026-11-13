// Language model layer. The same request can run on OpenAI, Anthropic or
// Gemini, with optional web search, and returns parsed JSON. Each company's
// own keys are used. `withFailover` moves to the next connected provider
// when one fails (SRS 10.7).

import { ProviderError, isObject, requestJson, type Fetch } from './http.ts';
import { log } from './log.ts';

export const LLM_PROVIDERS = ['openai', 'anthropic', 'gemini'] as const;
export type LlmProvider = (typeof LLM_PROVIDERS)[number];

export type JsonRequest = {
  system: string;
  prompt: string;
  schemaName: string;
  /** JSON Schema of the expected answer (all properties required, no extras). */
  schema: Record<string, unknown>;
  webSearch: boolean;
};

export type LlmClient = {
  provider: LlmProvider;
  generateJson(req: JsonRequest): Promise<unknown>;
};

const PROVIDER_NAMES: Record<LlmProvider, string> = { openai: 'OpenAI', anthropic: 'Anthropic', gemini: 'Gemini' };

/** Extracts the JSON object from model text that may include fences or prose. */
export function parseJsonLoose(text: string): unknown {
  const trimmed = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    const start = trimmed.indexOf('{');
    const end = trimmed.lastIndexOf('}');
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(trimmed.slice(start, end + 1));
      } catch {
        /* fall through */
      }
    }
  }
  throw new Error('The model did not return valid JSON');
}

function schemaInstruction(req: JsonRequest) {
  return `${req.system}\n\nReply with only one JSON object that matches this JSON Schema, with no other text:\n${JSON.stringify(req.schema)}`;
}

export function openaiClient(apiKey: string, model: string, fetchImpl?: Fetch): LlmClient {
  return {
    provider: 'openai',
    async generateJson(req) {
      const body = await requestJson('OpenAI', 'https://api.openai.com/v1/responses', {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model,
          instructions: req.system,
          input: req.prompt,
          ...(req.webSearch ? { tools: [{ type: 'web_search' }] } : {}),
          text: { format: { type: 'json_schema', name: req.schemaName, schema: req.schema, strict: true } },
        }),
      }, { fetchImpl, timeoutMs: 180_000 });
      const texts: string[] = [];
      const output = isObject(body) && Array.isArray(body.output) ? body.output : [];
      for (const item of output) {
        if (isObject(item) && item.type === 'message' && Array.isArray(item.content)) {
          for (const part of item.content) {
            if (isObject(part) && part.type === 'output_text' && typeof part.text === 'string') texts.push(part.text);
          }
        }
      }
      if (!texts.length) throw new ProviderError('OpenAI', null, 'OpenAI returned no answer');
      return parseJsonLoose(texts.join(''));
    },
  };
}

export function anthropicClient(apiKey: string, model: string, fetchImpl?: Fetch): LlmClient {
  return {
    provider: 'anthropic',
    async generateJson(req) {
      const body = await requestJson('Anthropic', 'https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model,
          max_tokens: 8000,
          system: schemaInstruction(req),
          messages: [{ role: 'user', content: req.prompt }],
          ...(req.webSearch ? { tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 5 }] } : {}),
        }),
      }, { fetchImpl, timeoutMs: 180_000 });
      const content = isObject(body) && Array.isArray(body.content) ? body.content : [];
      const texts = content.filter((b) => isObject(b) && b.type === 'text' && typeof b.text === 'string').map((b) => (b as { text: string }).text);
      if (!texts.length) throw new ProviderError('Anthropic', null, 'Anthropic returned no answer');
      // With web search the answer is the last text block, after the search steps.
      return parseJsonLoose(texts[texts.length - 1].includes('{') ? texts[texts.length - 1] : texts.join(''));
    },
  };
}

export function geminiClient(apiKey: string, model: string, fetchImpl?: Fetch): LlmClient {
  return {
    provider: 'gemini',
    async generateJson(req) {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;
      const body = await requestJson('Gemini', url, {
        method: 'POST',
        headers: { 'x-goog-api-key': apiKey, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: schemaInstruction(req) }] },
          contents: [{ role: 'user', parts: [{ text: req.prompt }] }],
          // Grounded search and JSON mode are not combined; JSON is parsed from text instead.
          ...(req.webSearch ? { tools: [{ google_search: {} }] } : { generationConfig: { responseMimeType: 'application/json' } }),
        }),
      }, { fetchImpl, timeoutMs: 180_000 });
      const candidates = isObject(body) && Array.isArray(body.candidates) ? body.candidates : [];
      const first = candidates[0];
      const parts = isObject(first) && isObject(first.content) && Array.isArray(first.content.parts) ? first.content.parts : [];
      const text = parts.map((p) => (isObject(p) && typeof p.text === 'string' ? p.text : '')).join('');
      if (!text) throw new ProviderError('Gemini', null, 'Gemini returned no answer');
      return parseJsonLoose(text);
    },
  };
}

export type LlmKeys = Partial<Record<LlmProvider, string>>;
export type ModelConfig = { openai: string; anthropic: string | null; gemini: string };

/** Clients for every connected provider, in failover order. */
export function buildClients(keys: LlmKeys, models: ModelConfig, fetchImpl?: Fetch): LlmClient[] {
  const clients: LlmClient[] = [];
  if (keys.openai) clients.push(openaiClient(keys.openai, models.openai, fetchImpl));
  if (keys.anthropic && models.anthropic) clients.push(anthropicClient(keys.anthropic, models.anthropic, fetchImpl));
  if (keys.gemini) clients.push(geminiClient(keys.gemini, models.gemini, fetchImpl));
  return clients;
}

/**
 * Runs `task` on the first provider that succeeds. `validate` turns the raw
 * answer into a checked value and throws if it does not fit, which also moves
 * on to the next provider.
 */
/** Every model failed; `transient` when each failure was an outage, timeout or rate limit. */
export class AllModelsFailed extends Error {
  readonly transient: boolean;
  constructor(message: string, transient: boolean) {
    super(message);
    this.name = 'AllModelsFailed';
    this.transient = transient;
  }
}

export async function withFailover<T>(
  clients: LlmClient[],
  task: (client: LlmClient) => Promise<unknown>,
  validate: (raw: unknown) => T,
  context: Record<string, unknown> = {},
): Promise<{ value: T; provider: LlmProvider }> {
  if (!clients.length) throw new Error('No language model is connected. Connect OpenAI, Anthropic or Gemini in Setup.');
  const failures: string[] = [];
  let transient = true;
  for (const client of clients) {
    try {
      return { value: validate(await task(client)), provider: client.provider };
    } catch (err) {
      const message = err instanceof Error ? err.message : 'unknown error';
      if (!(err instanceof ProviderError && (err.status === null || err.status === 429 || err.status >= 500))) transient = false;
      failures.push(`${PROVIDER_NAMES[client.provider]}: ${message}`);
      log('warn', 'llm provider failed, trying next', { ...context, provider: client.provider, error: message });
    }
  }
  throw new AllModelsFailed(`Every connected language model failed. ${failures.join('; ')}`, transient);
}
