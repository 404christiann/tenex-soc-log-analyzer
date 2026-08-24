import type { NextRequest } from "next/server";
import { updateSession } from "@/lib/supabase/middleware";

/**
 * Next.js 16 renamed `middleware.ts` -> `proxy.ts` (deprecation notice in
 * `apps/web/AGENTS.md`, confirmed against `node_modules/next/dist/docs`).
 * Functionally this IS the `middleware.ts` the implementation plan asked
 * for — just under the current file/export name for this Next.js version.
 */
export async function proxy(request: NextRequest) {
  return updateSession(request);
}

export const config = {
  matcher: [
    /*
     * Run on every route except static assets/image optimization/favicon,
     * per Next.js's documented negative-match pattern — auth needs to gate
     * real pages, not `_next/static` etc. The image-extension exclusion is
     * Supabase's documented variant of the same pattern: without it, the
     * `_next/image` optimizer's cookie-less internal fetch of
     * `/tenex-logo.png` (and the `/icon.png` favicon route for signed-out
     * visitors) gets 307'd to /login and the image breaks.
     */
    "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)",
  ],
};
