import express, { type Express } from "express";
import cors from "cors";
import helmet from "helmet";
import { LlmStatusSchema } from "@tenex/shared";
import { logsRouter } from "./routes/logs";
import { errorHandler } from "./middleware/error-handler";

/**
 * Builds the Express app without binding a port — kept separate from
 * `index.ts` so tests can `import { createApp }` and drive it with
 * supertest/fetch directly, no real listening socket required.
 */
export function createApp(): Express {
  const app = express();

  // --- Security headers (DECISIONS.md §5/§15 — was "helmet-equivalent,
  // deferred" until now) ---
  // `helmet()` over hand-rolled headers: it's a maintained set of ~15
  // individually-documented Express security headers (HSTS, X-Content-
  // Type-Options: nosniff, X-Frame-Options/frame-ancestors, Referrer-Policy,
  // a locked-down default Content-Security-Policy, etc.) that gets edge
  // cases right (which headers only make sense over HTTPS, correct
  // frame-ancestors vs. X-Frame-Options interplay) that are easy to get
  // subtly wrong hand-rolling one line at a time — same "don't reinvent a
  // security primitive" call as §7's Supabase Auth decision. This API is a
  // pure JSON/SSE backend (no HTML it renders itself), so almost all of
  // helmet's defaults are used as-is. ONE default is overridden, not
  // relaxed for convenience but because it would actively break this
  // app's real, working cross-origin call pattern: helmet's default
  // `Cross-Origin-Resource-Policy: same-origin` tells the BROWSER (not
  // this server) to refuse to expose a response to a page on a different
  // origin, even one the `cors` middleware below explicitly allowed via
  // `Access-Control-Allow-Origin` — and apps/web (Next.js, its own origin/
  // port) calling apps/api (this Express server, a different origin/port)
  // is exactly that cross-origin case, in dev and in the planned Vercel+
  // Render deployment alike (DECISIONS.md §14). Set to `cross-origin`
  // instead — the deliberate CORS allowlist just below is what's actually
  // gating who can read these responses, so CORP's blunter same-origin
  // default would only break the legitimate frontend without adding real
  // protection against anyone else. (Verified empirically, not just from
  // the docs — see DECISIONS.md §15.)
  app.use(helmet({ crossOriginResourcePolicy: { policy: "cross-origin" } }));

  // --- CORS (DECISIONS.md §5/§15 — hardened beyond the single-origin-only
  // note this comment used to carry) ---
  // Locked to one configurable origin via FRONTEND_ORIGIN (never a
  // wildcard, which would silently undercut the auth model), PLUS now
  // explicit about what else a cross-origin request is allowed to do:
  //   - `methods`: only the HTTP verbs this API's routes actually use.
  //     Without this, the `cors` package's default reflects every method
  //     via the preflight response.
  //   - `allowedHeaders`: only `Content-Type` (multipart upload / JSON
  //     bodies) and `Authorization` (the bearer token every route needs —
  //     see `middleware/auth.ts`). Nothing else this API reads.
  //   - `credentials: false` — checked against how the frontend actually
  //     calls this API (`apps/web/src/lib/api.ts`): every request carries
  //     its Supabase access token as an `Authorization: Bearer <token>`
  //     header, explicitly attached in JS, never via `fetch(..., {
  //     credentials: "include" })` or an ambient cookie. There is no
  //     cookie-based session shared between the Next.js app and this
  //     Express API for CORS to gate — Supabase's own session cookie
  //     lives on the Next.js origin only (`lib/supabase/middleware.ts`)
  //     and is never sent here. Leaving `credentials: true` on (the
  //     previous setting) was a leftover from an earlier, more permissive
  //     draft, not a real requirement — turning it off is a strict
  //     tightening: it makes the browser refuse to expose this API's
  //     responses to a cross-origin page even if that page somehow forced
  //     a credentialed request, with zero effect on the app's real,
  //     Bearer-token-only call pattern.
  const frontendOrigin = process.env.FRONTEND_ORIGIN || "http://localhost:3000";
  app.use(
    cors({
      origin: frontendOrigin,
      methods: ["GET", "POST"],
      allowedHeaders: ["Content-Type", "Authorization"],
      credentials: false,
    }),
  );

  app.use(express.json());

  app.get("/health", (_req, res) => {
    // Parses through the shared Zod schema at runtime (not just type-checked)
    // to confirm @tenex/shared is wired up correctly end-to-end.
    const exampleLlmStatus = LlmStatusSchema.parse({ status: "not_configured" });

    res.json({
      status: "ok",
      service: "tenex-soc-log-analyzer-api",
      timestamp: new Date().toISOString(),
      sharedSchemaCheck: exampleLlmStatus,
    });
  });

  app.use("/api/logs", logsRouter);

  // Must be registered last — Express only routes an error to a
  // 4-arg middleware once every other route/middleware has been tried.
  app.use(errorHandler);

  return app;
}
