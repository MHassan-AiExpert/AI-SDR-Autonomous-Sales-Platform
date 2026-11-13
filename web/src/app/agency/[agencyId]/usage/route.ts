import { NextResponse } from 'next/server';
import { parseRange, period } from '@/lib/analytics';
import { readUsage, usageCsv } from '@/lib/agency';
import { createClient } from '@/lib/supabase/server';
import { uuidSchema } from '@/lib/validation';

// Per-client usage for billing: counts only, for the agency team
export async function GET(request: Request, { params }: { params: Promise<{ agencyId: string }> }) {
  const { agencyId } = await params;
  if (!uuidSchema.safeParse(agencyId).success) return new NextResponse('Not found', { status: 404 });
  const supabase = await createClient();
  const { data: auth } = await supabase.auth.getUser();
  if (!auth.user) return NextResponse.redirect(new URL(`/login?next=/agency/${agencyId}`, request.url));
  const range = parseRange(new URL(request.url).searchParams.get('range'));
  const { from, to } = period(range);
  const { data, error } = await supabase.rpc('agency_usage', { ag: agencyId, p_from: from.toISOString(), p_to: to.toISOString() });
  const rows = error ? null : readUsage(data);
  if (!rows) return new NextResponse('Not found', { status: 404 });
  return new NextResponse(usageCsv(rows, from, to), {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="client-usage-${from.toISOString().slice(0, 10)}-to-${to.toISOString().slice(0, 10)}.csv"`,
      'Cache-Control': 'no-store',
    },
  });
}
