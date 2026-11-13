import { NextResponse, type NextRequest } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { AUDIT_TOKEN, viewSeconds } from '@/lib/audit';

// Records a visit to a shared audit. Signed-in team members previewing it are not counted.
export async function POST(request: NextRequest, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  if (!AUDIT_TOKEN.test(token)) return new NextResponse(null, { status: 204 });
  let seconds: number | null = null;
  try {
    const text = await request.text();
    if (text.length <= 200) seconds = viewSeconds((JSON.parse(text) as { seconds?: unknown }).seconds);
  } catch {
    seconds = null;
  }
  if (seconds === null) return new NextResponse(null, { status: 204 });
  const supabase = await createClient();
  const { data } = await supabase.auth.getUser();
  if (!data.user) await supabase.rpc('audit_view', { p_token: token, p_seconds: seconds });
  return new NextResponse(null, { status: 204, headers: { 'Cache-Control': 'no-store' } });
}
