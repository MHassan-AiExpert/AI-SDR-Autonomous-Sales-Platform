import { NextResponse, type NextRequest } from 'next/server';
import { THEME_COOKIE, readTheme, safeBack } from '@/lib/theme';

/** The Dark / Light switch: remembers the choice for a year and returns to the same page. */
export async function POST(request: NextRequest) {
  const form = await request.formData().catch(() => null);
  const theme = readTheme(String(form?.get('theme') ?? ''));
  const back = safeBack(String(form?.get('back') ?? ''));
  const res = NextResponse.redirect(new URL(back, request.url), 303);
  if (theme) {
    res.cookies.set(THEME_COOKIE, theme, { path: '/', maxAge: 60 * 60 * 24 * 365, sameSite: 'lax', secure: request.nextUrl.protocol === 'https:' });
  } else {
    res.cookies.delete(THEME_COOKIE);
  }
  return res;
}
