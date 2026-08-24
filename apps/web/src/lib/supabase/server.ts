import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";

/**
 * Server-side Supabase client for Server Components / Server Actions
 * (DECISIONS.md §7). Reads/writes the session via Next's `cookies()` API —
 * the `setAll` call is wrapped in try/catch per Supabase's documented
 * pattern because Server Components can't set cookies (only Server Actions
 * and Route Handlers can); when that happens, `proxy.ts`'s session refresh
 * is what actually keeps the cookie current.
 */
export async function createClient() {
  const cookieStore = await cookies();

  return createServerClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, {
    cookies: {
      getAll() {
        return cookieStore.getAll();
      },
      setAll(cookiesToSet) {
        try {
          cookiesToSet.forEach(({ name, value, options }) => cookieStore.set(name, value, options));
        } catch {
          // Called from a Server Component — no-op, `proxy.ts` refreshes the session instead.
        }
      },
    },
  });
}
