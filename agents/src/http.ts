// One place for calling third-party APIs: timeouts, no redirects, and error
// messages that never contain credentials or response bodies.

export type Fetch = typeof fetch;

export class ProviderError extends Error {
  readonly provider: string;
  readonly status: number | null;
  constructor(provider: string, status: number | null, message: string) {
    super(message);
    this.name = 'ProviderError';
    this.provider = provider;
    this.status = status;
  }
}

export function describeStatus(provider: string, status: number): string {
  if (status === 401 || status === 403) return `${provider} rejected the stored credentials`;
  if (status === 402) return `${provider} reports the account is out of credits or needs a plan upgrade`;
  if (status === 404) return `${provider} could not find the requested resource`;
  if (status === 422 || status === 400) return `${provider} rejected the search parameters`;
  if (status === 429) return `${provider} is rate limiting requests`;
  return `${provider} returned an error (${status})`;
}

export async function requestJson(
  provider: string,
  url: string,
  init: RequestInit,
  options: { fetchImpl?: Fetch; timeoutMs?: number } = {},
): Promise<unknown> {
  const fetchImpl = options.fetchImpl ?? fetch;
  let response: Response;
  try {
    response = await fetchImpl(url, {
      ...init,
      headers: { Accept: 'application/json', ...(init.headers as Record<string, string> | undefined) },
      redirect: 'error',
      signal: AbortSignal.timeout(options.timeoutMs ?? 60_000),
    });
  } catch (err) {
    const timedOut = err instanceof Error && err.name === 'TimeoutError';
    throw new ProviderError(provider, null, timedOut ? `${provider} did not respond in time` : `Could not reach ${provider}`);
  }
  if (!response.ok) throw new ProviderError(provider, response.status, describeStatus(provider, response.status));
  try {
    return await response.json();
  } catch {
    throw new ProviderError(provider, response.status, `${provider} returned a response that is not JSON`);
  }
}

export function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() ? v.trim() : undefined;
}

export function num(v: unknown): number | undefined {
  const n = typeof v === 'string' ? Number(v) : v;
  return typeof n === 'number' && Number.isFinite(n) ? n : undefined;
}
