import { NextResponse, type NextRequest } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { TOKEN, ingestError, parseIngestBody } from '@/lib/signals';

// The paid and social signal tiers (F26). Any tool — Bombora, 6sense, a
// social listening service, or Zapier and Make in front of one — can send
// signals here. The address carries the workspace's secret webhook token, the
// same credential its other webhooks use, and every field is checked again in
// the database by signal_ingest.

const json = (body: unknown, status = 200) =>
  NextResponse.json(body, { status, headers: { 'Cache-Control': 'no-store' } });

export async function POST(request: NextRequest, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  // A malformed token never reaches the database, and is answered the same way
  // as a wrong one, so the endpoint does not say which tokens exist
  if (!TOKEN.test(token)) return json({ error: 'Unknown webhook address' }, 404);

  const parsed = parseIngestBody(await request.text());
  if ('error' in parsed) return json({ error: parsed.error }, 400);

  const supabase = await createClient();
  const results: { index: number; stored: boolean; duplicate?: boolean; reason?: string; error?: string }[] = [];
  for (const [index, signal] of parsed.signals.entries()) {
    const { data, error } = await supabase.rpc('signal_ingest', { p_token: token, p_signal: signal });
    if (error) {
      const message = ingestError(error.message);
      if (message === 'Unknown webhook address') return json({ error: message }, 404);
      results.push({ index, stored: false, error: message });
      continue;
    }
    const r = (data ?? {}) as { stored?: boolean; duplicate?: boolean; reason?: string };
    results.push({ index, stored: Boolean(r.stored), ...(r.duplicate ? { duplicate: true } : {}), ...(r.reason ? { reason: r.reason } : {}) });
  }

  return json({
    received: results.length,
    stored: results.filter((r) => r.stored).length,
    duplicates: results.filter((r) => r.duplicate).length,
    not_stored: results.filter((r) => !r.stored && !r.duplicate).length,
    results,
  });
}

export function GET() {
  return json({ error: 'Send signals with POST' }, 405);
}
