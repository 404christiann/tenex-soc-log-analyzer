import { createBrowserClient } from "@supabase/ssr";

/**
 * Browser-side Supabase client (DECISIONS.md §7 — Supabase Auth via
 * `@supabase/ssr`, Supabase's current official Next.js App Router pattern).
 * Session state is persisted in cookies (not `localStorage`), which is what
 * lets the server (Server Components, `proxy.ts`) read the same session.
 *
 * Used from Client Components: the passwordless login form, the sign-out button,
 * and `lib/api.ts` (which needs the current access token to attach as a
 * `Bearer` header on every request to the Express API).
 */
export function createClient() {
  return createBrowserClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
  );
}

/**
 * Matches only the PKCE code-verifier cookies `@supabase/ssr` writes when a
 * sign-in flow is initiated — all three observed shapes for any project ref
 * (`sb-<ref>-auth-token-flow-<uuid>-code-verifier`,
 * `sb-<ref>-auth-token-flows-code-verifier`,
 * `sb-<ref>-auth-token-code-verifier`), plus chunked `.0`/`.1` variants.
 * Deliberately does NOT match the session cookie itself
 * (`sb-<ref>-auth-token`, no `-code-verifier` suffix).
 */
const PKCE_VERIFIER_COOKIE = /^sb-.+-code-verifier(?:\.\d+)?$/;

/**
 * Deletes any lingering PKCE code-verifier cookies for this origin.
 *
 * Every `signInWithOtp()` call starts a new flow and writes a new
 * code-verifier cookie, but cookies from flows that were never completed
 * (the user hit "Resend code", or requested a code and navigated away) are
 * never cleaned up by the SDK — they accumulate until the origin's cookie
 * state gets large enough to break `/login` with ERR_TOO_MANY_REDIRECTS.
 * Supabase only ever consults the verifier of the most recently initiated
 * flow, so older ones are dead weight: call this immediately before each
 * `signInWithOtp()` so every new flow starts from a clean slate. The active
 * session cookie (and everything else) is left untouched.
 */
export function clearStalePkceVerifierCookies(): void {
  if (typeof document === "undefined") return;
  for (const pair of document.cookie.split(";")) {
    const name = pair.split("=")[0]?.trim();
    if (name && PKCE_VERIFIER_COOKIE.test(name)) {
      // Same attributes `@supabase/ssr` writes them with (path=/, host-only),
      // so this expiry actually matches and removes each cookie.
      document.cookie = `${name}=; path=/; expires=Thu, 01 Jan 1970 00:00:00 GMT`;
    }
  }
}
