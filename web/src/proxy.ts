import { createServerClient } from '@supabase/ssr';
import { NextResponse, type NextRequest } from 'next/server';

const PROTECTED = ['/workspaces', '/w/'];
const AUTH_PAGES = ['/login', '/signup'];

// Refreshes the session cookie on every request and keeps signed-out visitors
// out of the app. Data access is still enforced by row-level security.
export async function proxy(request: NextRequest) {
  let response = NextResponse.next({ request });

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
  if (!url || !key) return response;

  const supabase = createServerClient(url, key, {
    cookies: {
      getAll() {
        return request.cookies.getAll();
      },
      setAll(cookiesToSet) {
        cookiesToSet.forEach(({ name, value }) => request.cookies.set(name, value));
        response = NextResponse.next({ request });
        cookiesToSet.forEach(({ name, value, options }) => response.cookies.set(name, value, options));
      },
    },
  });

  const { data } = await supabase.auth.getUser();
  const signedIn = Boolean(data.user);
  const path = request.nextUrl.pathname;

  if (!signedIn && PROTECTED.some((p) => path.startsWith(p))) {
    const target = request.nextUrl.clone();
    target.pathname = '/login';
    // Keep the query too, so a shared filtered link (for example a lead list) survives sign-in
    target.search = `?next=${encodeURIComponent(path + request.nextUrl.search)}`;
    return NextResponse.redirect(target);
  }
  if (signedIn && AUTH_PAGES.includes(path)) {
    const target = request.nextUrl.clone();
    target.pathname = '/workspaces';
    target.search = '';
    return NextResponse.redirect(target);
  }
  return response;
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)'],
};
