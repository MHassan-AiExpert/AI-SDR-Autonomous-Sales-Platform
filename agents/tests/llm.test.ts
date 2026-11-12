import { describe, test, expect } from 'vitest';
import { parseJsonLoose, openaiClient, anthropicClient, geminiClient, buildClients, withFailover } from '../src/llm.ts';
import { fakeFetch } from './harness.ts';

const req = { system: 'sys', prompt: 'p', schemaName: 's', schema: { type: 'object' }, webSearch: true };

describe('language models', () => {
  test('LLM-01 JSON is read from plain, fenced or wrapped model text', () => {
    expect(parseJsonLoose('{"a":1}')).toEqual({ a: 1 });
    expect(parseJsonLoose('```json\n{"a":2}\n```')).toEqual({ a: 2 });
    expect(parseJsonLoose('Here you go: {"a":3} hope it helps')).toEqual({ a: 3 });
    expect(() => parseJsonLoose('no json')).toThrow(/valid JSON/);
  });

  test('LLM-02 OpenAI uses the Responses API with web search and a strict JSON schema', async () => {
    const f = fakeFetch([[/openai\.com\/v1\/responses/, () => ({
      output: [{ type: 'web_search_call' }, { type: 'message', content: [{ type: 'output_text', text: '{"ok":true}' }] }],
    })]]);
    expect(await openaiClient('sk-1', 'm', f.impl).generateJson(req)).toEqual({ ok: true });
    const body = JSON.parse(String(f.calls[0].init.body));
    expect(body.tools).toEqual([{ type: 'web_search' }]);
    expect(body.text.format).toMatchObject({ type: 'json_schema', strict: true, name: 's' });
    expect((f.calls[0].init.headers as Record<string, string>).Authorization).toBe('Bearer sk-1');
  });

  test('LLM-03 Anthropic uses the web search tool and reads the final text block', async () => {
    const f = fakeFetch([[/anthropic\.com\/v1\/messages/, () => ({
      content: [{ type: 'text', text: 'Searching' }, { type: 'server_tool_use' }, { type: 'text', text: '{"ok":2}' }],
    })]]);
    expect(await anthropicClient('k', 'm', f.impl).generateJson(req)).toEqual({ ok: 2 });
    const body = JSON.parse(String(f.calls[0].init.body));
    expect(body.tools[0]).toMatchObject({ type: 'web_search_20250305', name: 'web_search' });
    expect((f.calls[0].init.headers as Record<string, string>)['x-api-key']).toBe('k');
  });

  test('LLM-04 Gemini uses Google Search grounding, or JSON mode without search', async () => {
    const f = fakeFetch([[/generativelanguage/, () => ({ candidates: [{ content: { parts: [{ text: '{"ok":3}' }] } }] })]]);
    const g = geminiClient('g', 'gemini-x', f.impl);
    expect(await g.generateJson(req)).toEqual({ ok: 3 });
    expect(JSON.parse(String(f.calls[0].init.body)).tools).toEqual([{ google_search: {} }]);
    await g.generateJson({ ...req, webSearch: false });
    expect(JSON.parse(String(f.calls[1].init.body)).generationConfig).toEqual({ responseMimeType: 'application/json' });
    expect(f.calls[0].url).toContain('models/gemini-x:generateContent');
  });

  test('LLM-05 only connected providers are used, and Anthropic needs a model id', () => {
    const models = { openai: 'o', anthropic: null, gemini: 'g' };
    expect(buildClients({ openai: 'a', anthropic: 'b' }, models).map((c) => c.provider)).toEqual(['openai']);
    expect(buildClients({ anthropic: 'b', gemini: 'c' }, { ...models, anthropic: 'a1' }).map((c) => c.provider)).toEqual(['anthropic', 'gemini']);
  });

  test('LLM-06 a failing or invalid provider fails over to the next one', async () => {
    const f = fakeFetch([
      [/openai/, () => new Response('{}', { status: 429 })],
      [/generativelanguage/, () => ({ candidates: [{ content: { parts: [{ text: '{"n":5}' }] } }] })],
    ]);
    const clients = buildClients({ openai: 'a', gemini: 'c' }, { openai: 'o', anthropic: null, gemini: 'g' }, f.impl);
    const out = await withFailover(clients, (c) => c.generateJson(req), (raw) => {
      if ((raw as { n: number }).n !== 5) throw new Error('bad');
      return raw;
    });
    expect(out).toEqual({ value: { n: 5 }, provider: 'gemini' });
  });

  test('LLM-07 when every provider fails the error names each, without credentials', async () => {
    const f = fakeFetch([[/./, () => new Response('{"error":"sk-secret leaked"}', { status: 401 })]]);
    const clients = buildClients({ openai: 'sk-secret', gemini: 'g-secret' }, { openai: 'o', anthropic: null, gemini: 'g' }, f.impl);
    const err = await withFailover(clients, (c) => c.generateJson(req), (r) => r).catch((e: Error) => e);
    expect(String(err)).toMatch(/OpenAI: OpenAI rejected the stored credentials; Gemini: Gemini rejected/);
    expect(String(err)).not.toMatch(/secret/);
    await expect(withFailover([], async () => 1, (r) => r)).rejects.toThrow(/No language model is connected/);
  });
});
