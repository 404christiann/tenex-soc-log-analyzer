import path from "node:path";
import fs from "node:fs";
import dotenv from "dotenv";

/**
 * How to run this file locally (it self-skips otherwise — see
 * `SUPABASE_LOCAL_STACK_AVAILABLE` below):
 *
 *   1. `supabase start` from the repo root (spins up a disposable local
 *      Postgres + PostgREST + Auth + Storage stack via the Supabase CLI —
 *      `supabase/config.toml` is checked in; migrations 0001-0003 apply
 *      automatically). NOT the user's real hosted project.
 *   2. `supabase status -o env` and copy ANON_KEY / API_URL /
 *      SERVICE_ROLE_KEY into `apps/api/.env.test.local` as SUPABASE_ANON_KEY
 *      / SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY, plus JWT_SECRET as
 *      SUPABASE_JWT_SECRET (git-ignored via `.env.*.local` — never commit
 *      real values, though these are well-known local-dev-only defaults).
 *   3. `npm test --workspace=apps/api` (or `npx vitest run` from apps/api).
 *   4. `supabase stop --no-backup` when done to tear the disposable stack
 *      back down.
 */
dotenv.config({ path: path.resolve(__dirname, "../../.env.test.local") });

import { beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { createClient } from "@supabase/supabase-js";
import WebSocket from "ws";
import { createApp } from "../app";
import { parseLogFile } from "../parser/parse-log";
import { runRuleEngine } from "../rules/engine";

const EXAMPLES_DIR = path.resolve(__dirname, "../../../../examples");
const SUPABASE_LOCAL_STACK_AVAILABLE = Boolean(process.env.SUPABASE_URL);

/**
 * Full upload pipeline + RLS-at-the-API-layer integration tests
 * (DECISIONS.md §7/§9/§10/§14a). Runs the REAL route handlers (via
 * `createApp()` + supertest, no mocking of `db/supabase.ts`,
 * `middleware/auth.ts`, or the rules/parser/llm modules) against a
 * disposable local Supabase stack — real Postgres, real PostgREST (so RLS
 * is genuinely enforced over HTTP, not simulated), real Storage, and real
 * Supabase Auth-issued JWTs (so `middleware/auth.ts`'s verification path is
 * exercised against an actual Supabase-signed token, not a hand-rolled one).
 *
 * Skips itself (rather than failing) if `SUPABASE_URL` isn't set, so the
 * rest of the suite (unit tests) still runs standalone in an environment
 * with no local Supabase stack available.
 */
describe.skipIf(!SUPABASE_LOCAL_STACK_AVAILABLE)("logs routes — integration (local Supabase stack)", () => {
  const app = createApp();

  let userAToken = "";
  let userBToken = "";
  let uploadedFileId = "";

  beforeAll(async () => {
    // `realtime.transport` here is only the Node-20-has-no-native-WebSocket
    // workaround (see db/supabase.ts) — this test never uses realtime.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const realtimeOptions = { realtime: { transport: WebSocket as any } };
    const admin = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
      auth: { autoRefreshToken: false, persistSession: false },
      ...realtimeOptions,
    });
    const anon = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_ANON_KEY!, {
      auth: { autoRefreshToken: false, persistSession: false },
      ...realtimeOptions,
    });

    const password = "test-password-12345!";
    const emailA = `phase7-user-a-${Date.now()}@example.test`;
    const emailB = `phase7-user-b-${Date.now()}@example.test`;

    const { data: userA, error: userAErr } = await admin.auth.admin.createUser({
      email: emailA,
      password,
      email_confirm: true,
    });
    if (userAErr || !userA.user) {
      throw new Error(`Failed to create test user A: ${userAErr?.message}`);
    }

    const { data: userB, error: userBErr } = await admin.auth.admin.createUser({
      email: emailB,
      password,
      email_confirm: true,
    });
    if (userBErr || !userB.user) {
      throw new Error(`Failed to create test user B: ${userBErr?.message}`);
    }

    const { data: signInA, error: signInAErr } = await anon.auth.signInWithPassword({ email: emailA, password });
    if (signInAErr || !signInA.session) {
      throw new Error(`Failed to sign in test user A: ${signInAErr?.message}`);
    }
    userAToken = signInA.session.access_token;

    const { data: signInB, error: signInBErr } = await anon.auth.signInWithPassword({ email: emailB, password });
    if (signInBErr || !signInB.session) {
      throw new Error(`Failed to sign in test user B: ${signInBErr?.message}`);
    }
    userBToken = signInB.session.access_token;
  }, 30_000);

  it("401s an upload attempt with no Authorization header", async () => {
    const res = await request(app).post("/api/logs/upload");
    expect(res.status).toBe(401);
  });

  it("401s an upload attempt with a garbage bearer token", async () => {
    const res = await request(app).post("/api/logs/upload").set("Authorization", "Bearer not-a-real-token");
    expect(res.status).toBe(401);
  });

  it(
    "runs the full upload pipeline for quick-demo.log through the real route handler and persists a complete result",
    async () => {
      const buffer = fs.readFileSync(path.join(EXAMPLES_DIR, "quick-demo.log"));

      const res = await request(app)
        .post("/api/logs/upload")
        .set("Authorization", `Bearer ${userAToken}`)
        .attach("file", buffer, "quick-demo.log");

      expect(res.status).toBe(201);
      expect(res.body.file.status).toBe("complete");
      expect(res.body.file.errorMessage).toBeNull();
      expect(res.body.file.filename).toBe("quick-demo.log");

      // No ANTHROPIC_API_KEY is set anywhere in this test environment — the
      // judge must report an honest `not_configured` status (DECISIONS.md
      // §14a), never break the request.
      expect(res.body.llmJudgeStatus).toEqual({ status: "not_configured" });

      // §14c: the summary is decoupled from upload entirely — no summary
      // text on the response, and the status is `pending` (not attempted),
      // NOT `not_configured`/`ok` for a call that never happened.
      expect(res.body.llmSummaryStatus).toEqual({ status: "pending" });
      expect(res.body.file.llmSummaryStatus).toEqual({ status: "pending" });
      expect(res.body).not.toHaveProperty("summary");

      expect(Array.isArray(res.body.anomalies)).toBe(true);
      expect(res.body.anomalies.length).toBeGreaterThan(0);
      // Judge never ran, so every anomaly must be untouched Layer 1 output.
      for (const anomaly of res.body.anomalies) {
        expect(anomaly.llmAdjustedConfidence).toBeNull();
        expect(anomaly.llmExplanation).toBeNull();
      }

      expect(res.body.events.items.length).toBeGreaterThan(0);
      expect(res.body.events.pagination.page).toBe(0);

      uploadedFileId = res.body.file.id;
    },
    30_000,
  );

  it("persisted event/anomaly counts match the rule engine's own output for the same file (Phase 4/5 parity)", async () => {
    const buffer = fs.readFileSync(path.join(EXAMPLES_DIR, "quick-demo.log"));
    const parsed = parseLogFile(buffer);
    expect(parsed.fileLevelError).toBeUndefined();
    const expectedAnomalies = runRuleEngine(parsed.events);

    const res = await request(app)
      .get(`/api/logs/${uploadedFileId}`)
      .set("Authorization", `Bearer ${userAToken}`);

    expect(res.status).toBe(200);
    expect(res.body.events.pagination.totalCount).toBe(parsed.events.length);
    expect(res.body.anomalies.length).toBe(expectedAnomalies.length);

    const actualRuleTypeCounts = countBy(res.body.anomalies, (a: { ruleType: string }) => a.ruleType);
    const expectedRuleTypeCounts = countBy(expectedAnomalies, (a) => a.ruleType);
    expect(actualRuleTypeCounts).toEqual(expectedRuleTypeCounts);
  });

  it("RLS blocks user B from reading user A's file via GET /api/logs/:id — 404, not another user's data", async () => {
    const res = await request(app)
      .get(`/api/logs/${uploadedFileId}`)
      .set("Authorization", `Bearer ${userBToken}`);
    expect(res.status).toBe(404);
  });

  it("RLS blocks user B from paginated events on user A's file", async () => {
    const res = await request(app)
      .get(`/api/logs/${uploadedFileId}/events`)
      .set("Authorization", `Bearer ${userBToken}`);
    expect(res.status).toBe(404);
  });

  it("RLS keeps user A's file out of user B's list (GET /api/logs is scoped by RLS, not application code)", async () => {
    const res = await request(app).get("/api/logs").set("Authorization", `Bearer ${userBToken}`);
    expect(res.status).toBe(200);
    const ids = (res.body.files as Array<{ id: string }>).map((f) => f.id);
    expect(ids).not.toContain(uploadedFileId);
  });

  it("user A sees their own file in GET /api/logs", async () => {
    const res = await request(app).get("/api/logs").set("Authorization", `Bearer ${userAToken}`);
    expect(res.status).toBe(200);
    const ids = (res.body.files as Array<{ id: string }>).map((f) => f.id);
    expect(ids).toContain(uploadedFileId);
  });

  it("paginates events via GET /api/logs/:id/events", async () => {
    const res = await request(app)
      .get(`/api/logs/${uploadedFileId}/events`)
      .query({ page: 0, pageSize: 10 })
      .set("Authorization", `Bearer ${userAToken}`);
    expect(res.status).toBe(200);
    expect(res.body.items.length).toBeLessThanOrEqual(10);
    expect(res.body.pagination).toEqual(
      expect.objectContaining({ page: 0, pageSize: 10 }),
    );
  });

  it("rejects a non-UUID file id with 400 (zod param validation)", async () => {
    const res = await request(app)
      .get("/api/logs/not-a-uuid")
      .set("Authorization", `Bearer ${userAToken}`);
    expect(res.status).toBe(400);
  });

  it("404s a well-formed but nonexistent file id", async () => {
    const res = await request(app)
      .get("/api/logs/00000000-0000-0000-0000-000000000000")
      .set("Authorization", `Bearer ${userAToken}`);
    expect(res.status).toBe(404);
  });

  it("rejects a non-.log/.txt upload with 400 before any persistence", async () => {
    const res = await request(app)
      .post("/api/logs/upload")
      .set("Authorization", `Bearer ${userAToken}`)
      .attach("file", Buffer.from("hello"), "malware.exe");
    expect(res.status).toBe(400);
  });

  /**
   * DECISIONS.md §14b — TDD regression test, written BEFORE the fix, now
   * passing after the fix landed.
   *
   * `malformed-edge-cases.log` is deliberately built (examples/README.md) to
   * demonstrate the parser's per-line graceful degradation: 29 well-formed
   * lines interspersed with 22 deliberately-malformed ones (5 truncated, 5
   * missing-key, 5 invalid-UTF-8, 5 unescaped-tab), plus 2 blank lines.
   * `parser/parse-log.test.ts` already proves the parser itself handles this
   * correctly in isolation (30 recovered events / 19 errors / 2 skipped
   * blanks — see that file's own doc comment for exactly why the precise
   * numbers are 30/19 rather than the file's nominal 29/22: one unescaped-tab
   * line's corruption happens to survive schema validation as a mangled-but-
   * valid `url`, which is a documented, understood mismatch, not a bug).
   *
   * The bug (DECISIONS.md §14b, now fixed): `upload-validate.ts`'s
   * `decodeUtf8Strict()` used to run `TextDecoder("utf-8", { fatal: true })`
   * over the WHOLE file buffer with zero tolerance for invalid bytes, so
   * this file — which deliberately contains a few corrupted UTF-8 bytes
   * among mostly-valid content — was rejected at the upload-validation gate
   * (400) before the parser, which already handles per-line invalid UTF-8
   * gracefully, ever saw it.
   *
   * The fix (landed): `decodeUtf8WithThreshold()` decodes leniently and
   * rejects only when replacement characters exceed 2% of the decoded text,
   * so this file passes the upload gate and reaches the parser. This is now
   * a normal passing regression test — it stays here to keep proving the
   * fix as the codebase evolves.
   */
  it(
    "uploads malformed-edge-cases.log successfully and reports its known parse-error/skip counts",
    async () => {
      const buffer = fs.readFileSync(path.join(EXAMPLES_DIR, "malformed-edge-cases.log"));

      const res = await request(app)
        .post("/api/logs/upload")
        .set("Authorization", `Bearer ${userAToken}`)
        .attach("file", buffer, "malformed-edge-cases.log");

      // Passes the upload-validation gate now that decodeUtf8WithThreshold()
      // tolerates this file's few corrupted bytes (DECISIONS.md §14b) and
      // reaches the parser, which recovers the rest per-line.
      expect(res.status).toBe(201);
      expect(res.body.file.status).toBe("complete");
      expect(res.body.file.filename).toBe("malformed-edge-cases.log");

      // Ground truth locked in parser/parse-log.test.ts: 19 per-line errors,
      // 2 silently-skipped blank lines (not counted as errors).
      expect(res.body.parseErrors).not.toBeNull();
      expect(res.body.parseErrors.count).toBe(19);
      expect(res.body.parseErrors.skippedCount).toBe(2);
      expect(Array.isArray(res.body.parseErrors.sampleReasons)).toBe(true);
      expect(res.body.parseErrors.sampleReasons.length).toBeGreaterThan(0);

      // Ground truth: 30 successfully-parsed events persisted and returned
      // (the 29 clean lines + the one corrupted-but-schema-valid line).
      expect(res.body.events.pagination.totalCount).toBe(30);
      expect(res.body.events.items.length).toBe(30);
    },
    30_000,
  );
});

function countBy<T>(items: T[], keyFn: (item: T) => string): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const item of items) {
    const key = keyFn(item);
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}
