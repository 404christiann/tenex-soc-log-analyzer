import rateLimit, { type Options } from "express-rate-limit";
import type { Request, Response } from "express";

/**
 * Rate limiting on the two genuinely expensive/abusable endpoints
 * (DECISIONS.md §5/§15 — one of the "stretch, deferred" items, now
 * implemented). Uses `express-rate-limit` rather than hand-rolling a
 * counter — same philosophy as §7's "don't reinvent a security primitive"
 * call for auth: a well-reviewed library gets sliding-window counting,
 * `Retry-After`/`RateLimit-*` headers, and IP-key extraction correct for
 * free, and there's nothing project-specific to justify writing it by hand.
 *
 * **Which endpoints, and why these two specifically:**
 *   - `POST /api/logs/upload` — the most expensive request in the app by a
 *     wide margin: parses a file, runs all 8 rule modules, then makes a
 *     real (billed) Anthropic API call for the LLM judge. Also the one
 *     endpoint that writes to Storage + inserts DB rows, so it's the
 *     closest thing this API has to a "login" endpoint in terms of abuse
 *     surface — see `logs.ts`'s doc comment and this project's README/
 *     DECISIONS.md §7/§14d for why there is no separate server-side login
 *     route to rate-limit: auth is Supabase's own `signInWithOtp`/
 *     `verifyOtp`, called directly from the browser against Supabase's
 *     hosted Auth service, which already enforces its own OTP send/verify
 *     rate limits server-side (§14d). This Express app never sees a
 *     credential or a login attempt, so there is nothing here to limit for
 *     that purpose.
 *   - `GET /api/logs/:id/summary/stream` — cheap on a cache hit (replays a
 *     persisted row, see `summary-stream.ts`), but expensive on a cache
 *     miss: a real streamed Anthropic call plus a full re-page of every
 *     event for prompt grounding. An attacker can't force a cache miss on
 *     someone else's file (RLS/ownership gates it first), but they could
 *     hammer their *own* files' first-ever generation repeatedly, or open
 *     many concurrent SSE connections, to run up API spend — worth capping
 *     even though the blast radius is smaller than upload's.
 *
 * **Why per-IP, not per-user:** `requireAuth` runs after these limiters in
 * the route chain for `/summary/stream` and *before* them for `/upload`
 * doesn't matter either way — express-rate-limit's default IP-based keying
 * is the right choice here regardless of auth state, since the goal is
 * bounding load/spend from one source, not enforcing a per-account quota.
 * (A per-user limiter would also be trivially bypassable by creating a new
 * Supabase account, which costs an attacker nothing — an IP is at least a
 * mild deterrent.)
 *
 * **Why these specific numbers — sensible for a single-user take-home
 * demo, not a production SaaS:** generous enough that the recruiter/
 * reviewer clicking around, uploading the four example files, and
 * reopening the Timeline tab a few times never gets close, but present
 * enough to demonstrably stop a script that fires the endpoint in a loop.
 * A 15-minute window (matching `express-rate-limit`'s own documented
 * default) is long enough to be a real speed bump, short enough that a
 * legitimate user who trips it isn't locked out for the rest of a demo
 * session.
 */

/** Shared window: DECISIONS.md reasoning above — 15 minutes is express-rate-limit's own documented default and a sensible speed-bump duration for a demo. */
const WINDOW_MS = 15 * 60_000;

/**
 * Upload cap: 20 uploads / 15 min / IP. Each of the four example files plus
 * a handful of manual re-uploads during a walkthrough recording is nowhere
 * close to 20; a tight retry loop hits it almost immediately.
 */
const UPLOAD_MAX_REQUESTS = 20;

/**
 * Summary-stream cap: 30 connections / 15 min / IP — slightly more generous
 * than upload's, since opening the Timeline tab is a normal, frequent
 * interaction (every file view, every tab revisit) and most of those hits
 * are cheap cache replays, not new LLM calls.
 */
const SUMMARY_STREAM_MAX_REQUESTS = 30;

/**
 * Consistent with `middleware/error-handler.ts`'s `{ error: string }` JSON
 * shape, so a rate-limited response looks like every other error response
 * this API produces rather than express-rate-limit's own default body.
 */
function rateLimitedJsonHandler(message: string) {
  return (_req: Request, res: Response): void => {
    res.status(429).json({ error: message });
  };
}

const SHARED_OPTIONS: Partial<Options> = {
  windowMs: WINDOW_MS,
  // Modern `RateLimit-*` headers (RFC draft), not the legacy
  // `X-RateLimit-*` ones — legacyHeaders defaults to true, explicitly off
  // here so responses only carry the one standardized header set.
  standardHeaders: true,
  legacyHeaders: false,
};

/** `POST /api/logs/upload` limiter — see this file's top-of-file doc comment for the full reasoning. */
export const uploadRateLimiter = rateLimit({
  ...SHARED_OPTIONS,
  limit: UPLOAD_MAX_REQUESTS,
  handler: rateLimitedJsonHandler(
    `Too many uploads from this address — limit is ${UPLOAD_MAX_REQUESTS} per ${WINDOW_MS / 60_000} minutes. Try again shortly.`,
  ),
});

/** `GET /api/logs/:id/summary/stream` limiter — see this file's top-of-file doc comment for the full reasoning. */
export const summaryStreamRateLimiter = rateLimit({
  ...SHARED_OPTIONS,
  limit: SUMMARY_STREAM_MAX_REQUESTS,
  handler: rateLimitedJsonHandler(
    `Too many summary requests from this address — limit is ${SUMMARY_STREAM_MAX_REQUESTS} per ${WINDOW_MS / 60_000} minutes. Try again shortly.`,
  ),
});
