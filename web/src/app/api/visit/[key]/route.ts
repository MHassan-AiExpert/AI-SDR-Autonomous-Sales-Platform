import { type NextRequest } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { SITE_KEY, clientIp, originHost, parseBeacon, skipRequest } from '@/lib/visitors';

// Page views from the visitor script (F30). Always answers 204 with no body,
// whatever happened, so the endpoint reveals nothing about keys or settings.
// The database decides whether the view counts (key, tracking on, listed
// host, rate limits); nothing here is stored except through visit_record.

const done = () => new Response(null, { status: 204, headers: { 'Cache-Control': 'no-store' } });

export async function POST(request: NextRequest, { params }: { params: Promise<{ key: string }> }) {
  const { key } = await params;
  if (!SITE_KEY.test(key) || skipRequest(request.headers)) return done();
  const host = originHost(request.headers.get('origin'));
  const ip = clientIp(request.headers);
  const beacon = parseBeacon(await request.text().catch(() => ''));
  if (!host || !ip || !beacon) return done();
  const supabase = await createClient();
  await supabase.rpc('visit_record', { p_key: key, p_ip: ip, p_host: host, p_path: beacon.path, p_referrer: beacon.referrer });
  return done();
}

export const GET = () => new Response(null, { status: 405 });
