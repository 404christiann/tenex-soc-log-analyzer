import { describe, expect, it } from "vitest";
import request from "supertest";
import { createApp } from "./app";

/**
 * `createApp()`-level tests for the security-headers + CORS hardening pass
 * (DECISIONS.md §5/§15). Deliberately exercised over real HTTP (supertest)
 * against `/health` — no Supabase/Anthropic env vars required, since these
 * assertions are about response headers `app.ts` attaches to every
 * response, not about any route's business logic.
 */
describe("app — security headers (helmet)", () => {
  const app = createApp();

  it("sets helmet's core security headers on every response", async () => {
    const res = await request(app).get("/health");
    expect(res.status).toBe(200);
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
    expect(res.headers["x-dns-prefetch-control"]).toBe("off");
    expect(res.headers["x-frame-options"]).toBe("SAMEORIGIN");
    expect(res.headers["content-security-policy"]).toBeDefined();
  });

  it("overrides helmet's default same-origin Cross-Origin-Resource-Policy to cross-origin — required for apps/web (a different origin/port) to read this API's responses", async () => {
    const res = await request(app).get("/health");
    expect(res.headers["cross-origin-resource-policy"]).toBe("cross-origin");
  });
});

describe("app — CORS hardening", () => {
  const ALLOWED_ORIGIN = process.env.FRONTEND_ORIGIN || "http://localhost:3000";

  it("reflects the configured frontend origin on a simple GET", async () => {
    const app = createApp();
    const res = await request(app).get("/health").set("Origin", ALLOWED_ORIGIN);
    expect(res.headers["access-control-allow-origin"]).toBe(ALLOWED_ORIGIN);
  });

  it("always answers with the fixed FRONTEND_ORIGIN value, never reflecting the caller's actual Origin — the `cors` package's documented behavior for a static-string `origin` config", async () => {
    // `cors` with a static string doesn't do server-side per-request origin
    // matching — it always emits this exact configured value on every
    // response. The real protection is enforced by the CALLING BROWSER: a
    // page at https://attacker.example gets this response back, sees its
    // own origin doesn't match the Access-Control-Allow-Origin value, and
    // refuses to expose the response to attacker.example's JS. Verified
    // here so a future switch to a dynamic/array origin (which WOULD need
    // real per-request matching) doesn't silently regress this property
    // without a test noticing.
    const app = createApp();
    const res = await request(app).get("/health").set("Origin", "https://attacker.example");
    expect(res.headers["access-control-allow-origin"]).toBe(ALLOWED_ORIGIN);
    expect(res.headers["access-control-allow-origin"]).not.toBe("https://attacker.example");
    expect(res.headers["access-control-allow-origin"]).not.toBe("*");
  });

  it("preflight for POST /api/logs/upload allows exactly Content-Type + Authorization, and does not mark the response as credentialed", async () => {
    const app = createApp();
    const res = await request(app)
      .options("/api/logs/upload")
      .set("Origin", ALLOWED_ORIGIN)
      .set("Access-Control-Request-Method", "POST")
      .set("Access-Control-Request-Headers", "authorization,content-type");

    expect(res.status).toBe(204);
    expect(res.headers["access-control-allow-origin"]).toBe(ALLOWED_ORIGIN);
    expect(res.headers["access-control-allow-methods"]).toContain("POST");
    expect(res.headers["access-control-allow-headers"]).toBe("Content-Type,Authorization");
    // credentials: false (DECISIONS.md §15) — no cookie-based session
    // crosses this boundary (apps/web/src/lib/api.ts sends a Bearer token,
    // never `credentials: "include"`), so this header must be absent.
    expect(res.headers["access-control-allow-credentials"]).toBeUndefined();
  });

  it("rejects a disallowed method at the preflight layer (DELETE is not in the allowlist)", async () => {
    const app = createApp();
    const res = await request(app)
      .options("/api/logs/some-id")
      .set("Origin", ALLOWED_ORIGIN)
      .set("Access-Control-Request-Method", "DELETE");
    // The `cors` package's preflight handler still replies 204, but a
    // disallowed method is simply absent from Access-Control-Allow-Methods
    // — the browser is what actually blocks the real request client-side.
    expect(res.headers["access-control-allow-methods"]).not.toContain("DELETE");
  });
});
