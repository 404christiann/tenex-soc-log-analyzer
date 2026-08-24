import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import WebSocket from "ws";

/**
 * Two Supabase client factories (DECISIONS.md §14a "RLS enforcement —
 * Option A", locked):
 *
 * 1. `getServiceRoleClient()` — uses `SUPABASE_SERVICE_ROLE_KEY`, which
 *    bypasses RLS entirely. Used ONLY for the Storage upload write and the
 *    initial row inserts during upload processing (before there's a "read"
 *    to scope) — narrowly, not as a general-purpose client.
 * 2. `getUserScopedClient(accessToken)` — constructs a client authenticated
 *    as the calling user's own JWT (their `Authorization: Bearer` token, as
 *    verified by `middleware/auth.ts`). Used for ALL reads (list files, get
 *    file detail, get events page). Postgres RLS itself decides what rows
 *    come back — this module and its callers must NEVER add their own
 *    `.eq('user_id', ...)` filter on top as a crutch; that would defeat the
 *    entire point of choosing Supabase + RLS (DECISIONS.md §7). Filtering by
 *    a requested resource id (e.g. `.eq('id', fileId)` for a single-file
 *    lookup) is fine — that's normal resource addressing, not an
 *    authorization check; RLS still decides whether the row is visible at
 *    all.
 */

/**
 * `createClient()` always constructs an internal `RealtimeClient` even
 * though this app never subscribes to realtime channels — and on Node < 22
 * (no native `WebSocket` global; this app targets Node 20) it throws at
 * construction time unless given a WebSocket implementation explicitly.
 * Supplying the `ws` package here is the officially documented workaround,
 * not a realtime feature we're opting into.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const REALTIME_TRANSPORT_OPTIONS = { realtime: { transport: WebSocket as any } };

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value || value.trim().length === 0) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

let cachedServiceRoleClient: SupabaseClient | null = null;

/**
 * Service-role client. Lazily constructed and cached — narrow usage only
 * (Storage upload write + initial row inserts), never for reads.
 */
export function getServiceRoleClient(): SupabaseClient {
  if (!cachedServiceRoleClient) {
    const url = requiredEnv("SUPABASE_URL");
    const serviceRoleKey = requiredEnv("SUPABASE_SERVICE_ROLE_KEY");
    cachedServiceRoleClient = createClient(url, serviceRoleKey, {
      auth: { autoRefreshToken: false, persistSession: false },
      ...REALTIME_TRANSPORT_OPTIONS,
    });
  }
  return cachedServiceRoleClient;
}

/**
 * User-scoped client, freshly constructed per call (per request) since it's
 * bound to that specific caller's access token — never cached/shared across
 * requests. All reads go through this client so Postgres RLS is the real
 * enforcement layer, not application code.
 */
export function getUserScopedClient(accessToken: string): SupabaseClient {
  const url = requiredEnv("SUPABASE_URL");
  const anonKey = requiredEnv("SUPABASE_ANON_KEY");
  return createClient(url, anonKey, {
    auth: { autoRefreshToken: false, persistSession: false },
    global: { headers: { Authorization: `Bearer ${accessToken}` } },
    ...REALTIME_TRANSPORT_OPTIONS,
  });
}

/** Test-only hook to reset the cached service-role client between test files. */
export function _resetServiceRoleClientForTests(): void {
  cachedServiceRoleClient = null;
}
