import { beforeEach, describe, expect, it, vi } from "vitest";
import express, { type RequestHandler } from "express";
import request from "supertest";

/**
 * Rate-limit middleware tests (DECISIONS.md §5/§15). Exercised against a
 * minimal standalone Express app (not the full `createApp()`) so the
 * limiter's own behavior — counts requests, 429s past the cap, uses this
 * API's standard `{ error }` JSON error shape, ships standard `RateLimit-*`
 * headers — is isolated from auth/Supabase entirely. `routes/logs.ts`'s
 * wiring of these into the real `/upload` and `/:id/summary/stream` routes
 * (limiter registered BEFORE `requireAuth`, so an unauthenticated flood
 * still counts against the limit) is a one-line change, not independently
 * retested here.
 *
 * `express-rate-limit`'s store is a module-level singleton keyed by
 * (effectively) source IP — and every supertest request in this process
 * originates from the same loopback address, with no per-test IP to vary.
 * Left alone, one test's requests would bleed into the next test's counter.
 * `vi.resetModules()` + a fresh dynamic `import("./rate-limit")` per test
 * sidesteps this cleanly: each test gets its own brand-new limiter instance
 * (and therefore a zeroed counter) without needing to wait out the real
 * 15-minute window or fake IP addresses.
 */
async function freshLimiters(): Promise<{ uploadRateLimiter: RequestHandler; summaryStreamRateLimiter: RequestHandler }> {
  vi.resetModules();
  const mod = await import("./rate-limit");
  return { uploadRateLimiter: mod.uploadRateLimiter, summaryStreamRateLimiter: mod.summaryStreamRateLimiter };
}

function makeTestApp(limiter: RequestHandler) {
  const app = express();
  app.use(limiter);
  app.get("/probe", (_req, res) => res.json({ ok: true }));
  return app;
}

beforeEach(() => {
  vi.resetModules();
});

describe("uploadRateLimiter", () => {
  it("allows requests under the cap, then 429s in this API's standard error shape once the cap is exceeded", async () => {
    const { uploadRateLimiter } = await freshLimiters();
    const app = makeTestApp(uploadRateLimiter);
    const UPLOAD_MAX_REQUESTS = 20; // mirrors rate-limit.ts's UPLOAD_MAX_REQUESTS

    for (let i = 0; i < UPLOAD_MAX_REQUESTS; i++) {
      const res = await request(app).get("/probe");
      expect(res.status).toBe(200);
    }

    const overCap = await request(app).get("/probe");
    expect(overCap.status).toBe(429);
    expect(overCap.body).toEqual({ error: expect.stringContaining("Too many uploads") });
    expect(overCap.headers["ratelimit-limit"]).toBeDefined();
    // legacyHeaders: false — the older X-RateLimit-* header set should be absent.
    expect(overCap.headers["x-ratelimit-limit"]).toBeUndefined();
  });
});

describe("summaryStreamRateLimiter", () => {
  it("allows requests under its own, more generous cap, then 429s past it", async () => {
    const { summaryStreamRateLimiter } = await freshLimiters();
    const app = makeTestApp(summaryStreamRateLimiter);
    const SUMMARY_STREAM_MAX_REQUESTS = 30; // mirrors rate-limit.ts's SUMMARY_STREAM_MAX_REQUESTS

    for (let i = 0; i < SUMMARY_STREAM_MAX_REQUESTS; i++) {
      const res = await request(app).get("/probe");
      expect(res.status).toBe(200);
    }

    const overCap = await request(app).get("/probe");
    expect(overCap.status).toBe(429);
    expect(overCap.body).toEqual({ error: expect.stringContaining("Too many summary requests") });
  });

  it("is a separate counter from uploadRateLimiter — exhausting one doesn't affect the other", async () => {
    const { uploadRateLimiter, summaryStreamRateLimiter } = await freshLimiters();
    const uploadApp = makeTestApp(uploadRateLimiter);
    const summaryApp = makeTestApp(summaryStreamRateLimiter);

    for (let i = 0; i < 20; i++) {
      await request(uploadApp).get("/probe");
    }
    const uploadOverCap = await request(uploadApp).get("/probe");
    expect(uploadOverCap.status).toBe(429);

    // A fresh IP-keyed counter on the OTHER limiter is unaffected — this
    // request is still well under its own 30/15min cap.
    const summaryStillOk = await request(summaryApp).get("/probe");
    expect(summaryStillOk.status).toBe(200);
  });
});
