import { NextResponse, type NextRequest } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { campaignsCsv, parseRange, period, readSummary } from '@/lib/analytics';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// The campaign table as a CSV file, for members of the workspace only
export async function GET(request: NextRequest, { params }: { params: Promise<{ workspaceId: string }> }) {
  const { workspaceId } = await params;
  if (!UUID.test(workspaceId)) return new NextResponse('Not found', { status: 404 });
  const supabase = await createClient();
  const { data: auth } = await supabase.auth.getUser();
  if (!auth.user) return NextResponse.redirect(new URL(`/login?next=/w/${workspaceId}/analytics`, request.url));
  const { data: member } = await supabase.from('workspace_members').select('role').eq('workspace_id', workspaceId).eq('user_id', auth.user.id).maybeSingle();
  if (!member) return new NextResponse('Not found', { status: 404 });
  const range = parseRange(request.nextUrl.searchParams.get('range'));
  const raw = request.nextUrl.searchParams.get('campaign');
  const campaign = raw && UUID.test(raw) ? raw : null;
  const { from, to } = period(range);
  const [{ data }, { data: ws }] = await Promise.all([
    supabase.rpc('analytics_summary', { ws: workspaceId, p_from: from.toISOString(), p_to: to.toISOString(), p_campaign: campaign }),
    supabase.from('workspaces').select('spend_currency').eq('id', workspaceId).maybeSingle(),
  ]);
  const s = readSummary(data);
  if (!s) return new NextResponse('The figures could not be loaded', { status: 503 });
  const csv = campaignsCsv(s.campaigns, s.revenue[0]?.currency ?? ws?.spend_currency ?? 'USD');
  return new NextResponse(csv, {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="campaign-results-${range}-${to.toISOString().slice(0, 10)}.csv"`,
      'Cache-Control': 'no-store',
    },
  });
}
