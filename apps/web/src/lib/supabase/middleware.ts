import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

/**
 * Session-refresh + route-protection helper, called from `proxy.ts` (Next.js
 * 16 renamed `middleware.ts` -> `proxy.ts`; see AGENTS.md/DECISIONS.md §7 —
 * the behavior is identical to Supabase's documented middleware pattern,
 * just invoked from the new file/export name).
 *
 * Two jobs, per Supabase's official Next.js App Router guidance:
 *  1. Refresh the session cookie on every request (`getClaims()` — verified,
 *     not just decoded — so it also rotates a near-expired access token).
 *  2. Gate the authenticated route group: unauthenticated requests to
 *     anything other than `/login` are redirected to `/login`; authenticated
 *     requests to `/login` (or `/`) are sent to `/dashboard` instead of
 *     showing the auth form again. (`/login` is the only auth entry point —
 *     DECISIONS.md §14d collapsed signup into the same passwordless screen.)
 */

const PUBLIC_PATHS = new Set(["/login"]);

export async function updateSession(request: NextRequest): Promise<NextResponse> {
  let response = NextResponse.next({
    request: {
      headers: request.headers,
    },
  });

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
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
    },
  );

  // IMPORTANT per Supabase's docs: do not add logic between `createServerClient`
  // and this call — it's what actually revalidates/refreshes the token.
  // `data` (not just `claims`) can be `null` (no session, or a validation
  // error) per this SDK version's return type, so it's checked as a whole.
  const { data } = await supabase.auth.getClaims();
  const isAuthenticated = data?.claims != null;

  const { pathname } = request.nextUrl;
  const isPublicPath = PUBLIC_PATHS.has(pathname);

  if (!isAuthenticated && !isPublicPath) {
    const redirectUrl = new URL("/login", request.url);
    if (pathname !== "/") {
      redirectUrl.searchParams.set("next", pathname);
    }
    return NextResponse.redirect(redirectUrl);
  }

  if (isAuthenticated && (isPublicPath || pathname === "/")) {
    return NextResponse.redirect(new URL("/dashboard", request.url));
  }

  // IMPORTANT: return `response` as-is (or a new response built from its
  // cookies) — never construct a fresh `NextResponse.next()` here, or the
  // refreshed session cookie set above gets dropped.
  return response;
}
