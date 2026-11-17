import { NextResponse, type NextRequest } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { apiError, bearerKey, readBody, route } from '@/lib/api';

// Public API (F29). Authenticated by an API key in the Authorization header;
// the key, its scope and its rate limit are checked by api_call in the
// database, which only ever acts in the key's own workspace. No CORS headers
// are sent: keys are for servers, so browsers on other sites cannot use one.

const json = (body: unknown, status = 200) =>
  NextResponse.json(body, { status, headers: { 'Cache-Control': 'no-store' } });

async function handle(request: NextRequest, params: Promise<{ path: string[] }>) {
  const key = bearerKey(request.headers.get('authorization'));
  if (!key) return json({ error: 'Send your API key as "Authorization: Bearer sdr_..."' }, 401);
  const { path } = await params;
  let body: Record<string, unknown> | null = null;
  if (request.method === 'POST' || request.method === 'PATCH') {
    const parsed = readBody(await request.text());
    if ('error' in parsed) return json({ error: parsed.error }, 400);
    body = parsed.body;
  }
  const r = route(request.method, path, request.nextUrl.searchParams, body);
  if ('error' in r) return json({ error: r.error }, r.status);

  const supabase = await createClient();
  const { data, error } = await supabase.rpc('api_call', { p_key: key, p_action: r.action, p_args: r.args });
  if (error) {
    const e = apiError(error);
    return json({ error: e.error }, e.status);
  }
  const out = (data ?? {}) as Record<string, unknown>;
  // A created lead is 201; a duplicate or suppressed one is 200 with the reason
  return json(out, r.action === 'leads.create' && out.created === true ? 201 : 200);
}

type Ctx = { params: Promise<{ path: string[] }> };
export const GET = (req: NextRequest, ctx: Ctx) => handle(req, ctx.params);
export const POST = (req: NextRequest, ctx: Ctx) => handle(req, ctx.params);
export const PATCH = (req: NextRequest, ctx: Ctx) => handle(req, ctx.params);
export const DELETE = () => json({ error: 'Method not allowed' }, 405);
export const PUT = () => json({ error: 'Method not allowed' }, 405);
