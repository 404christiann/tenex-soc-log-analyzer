import path from "node:path";
import fs from "node:fs";
import dotenv from "dotenv";

// Same local-stack harness as logs.integration.test.ts — see that file's
// header comment for how to run this (supabase start + .env.test.local).
dotenv.config({ path: path.resolve(__dirname, "../../.env.test.local") });

import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import request, { type Response as SupertestResponse } from "supertest";
import { createClient } from "@supabase/supabase-js";
import WebSocket from "ws";
import { SummaryStreamEventSchema, type SummaryStreamEvent } from "@tenex/shared";

// Partial-mock the Anthropic client factory ONLY (same pattern as
// summary.test.ts): `isAnthropicConfigured` stays real (driven by the
// ANTHROPIC_API_KEY env var, which these tests set/unset per path), and the
// automated suite never needs a live key — the real streaming path was
// proven manually against the live API (DECISIONS.md §14c verification).
vi.mock("../llm/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../llm/client")>();
  return {
    ...actual,
    getAnthropicClient: vi.fn(),
  };
});

import { getAnthropicClient } from "../llm/client";
import { createApp } from "../app";

const EXAMPLES_DIR = path.resolve(__dirname, "../../../../examples");
const SUPABASE_LOCAL_STACK_AVAILABLE = Boolean(process.env.SUPABASE_URL);

// ---------------------------------------------------------------------------
// SSE plumbing helpers
// ---------------------------------------------------------------------------

/** Supertest parser that buffers the raw SSE body as text (superagent doesn't buffer text/event-stream on its own). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function collectRawBody(res: any, cb: (err: Error | null, body: string) => void): void {
  let data = "";
  res.setEncoding("utf8");
  res.on("data", (chunk: string) => {
    data += chunk;
  });
  res.on("end", () => cb(null, data));
}

/** Parses a complete SSE body into validated `SummaryStreamEvent`s, asserting each frame's `event:` name matches its JSON `type`. */
function parseSseEvents(raw: string): SummaryStreamEvent[] {
  const frames = raw
    .split("\n\n")
    .map((f) => f.trim())
    .filter((f) => f.length > 0);
  return frames.map((frame) => {
    const eventLine = frame.split("\n").find((l) => l.startsWith("event: "));
    const dataLine = frame.split("\n").find((l) => l.startsWith("data: "));
    expect(eventLine, `SSE frame missing event line: ${frame}`).toBeDefined();
    expect(dataLine, `SSE frame missing data line: ${frame}`).toBeDefined();
    const parsed = SummaryStreamEventSchema.parse(JSON.parse(dataLine!.slice("data: ".length)));
    expect(eventLine!.slice("event: ".length)).toBe(parsed.type);
    return parsed;
  });
}

function streamRequest(app: ReturnType<typeof createApp>, fileId: string, token: string): Promise<SupertestResponse> {
  return request(app)
    .get(`/api/logs/${fileId}/summary/stream`)
    .set("Authorization", `Bearer ${token}`)
    .buffer(true)
    .parse(collectRawBody) as unknown as Promise<SupertestResponse>;
}

/** Fake for the object `client.messages.stream(...)` returns — async-iterable raw events + `finalMessage()`. */
function makeFakeMessageStream(events: unknown[], finalContent: unknown[]) {
  return {
    async *[Symbol.asyncIterator]() {
      for (const event of events) {
        yield event;
      }
    },
    finalMessage: async () => ({ content: finalContent }),
  };
}

function thinkingDelta(thinking: string) {
  return { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking } };
}

function textDelta(text: string) {
  return { type: "content_block_delta", index: 1, delta: { type: "text_delta", text } };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe.skipIf(!SUPABASE_LOCAL_STACK_AVAILABLE)(
  "GET /api/logs/:id/summary/stream — integration (local Supabase stack, mocked Anthropic)",
  () => {
    const app = createApp();

    let userAToken = "";
    let userBToken = "";
    /** File used for the success -> cached-replay arc. */
    let fileOkId = "";
    /** File used for the failure -> cached-fallback arc. */
    let fileFailId = "";
    /** File used for the not_configured path (must stay un-generated). */
    let fileNotConfiguredId = "";

    async function uploadQuickDemo(token: string): Promise<string> {
      const buffer = fs.readFileSync(path.join(EXAMPLES_DIR, "quick-demo.log"));
      const res = await request(app)
        .post("/api/logs/upload")
        .set("Authorization", `Bearer ${token}`)
        .attach("file", buffer, "quick-demo.log");
      expect(res.status).toBe(201);
      return res.body.file.id as string;
    }

    beforeAll(async () => {
      // Uploads below must run with no key so the judge short-circuits to
      // not_configured instead of hitting the mocked client factory.
      delete process.env.ANTHROPIC_API_KEY;

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
      const emailA = `sse-user-a-${Date.now()}@example.test`;
      const emailB = `sse-user-b-${Date.now()}@example.test`;

      for (const email of [emailA, emailB]) {
        const { error } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
        if (error) throw new Error(`Failed to create test user ${email}: ${error.message}`);
      }
      const { data: signInA, error: errA } = await anon.auth.signInWithPassword({ email: emailA, password });
      if (errA || !signInA.session) throw new Error(`Failed to sign in user A: ${errA?.message}`);
      userAToken = signInA.session.access_token;
      const { data: signInB, error: errB } = await anon.auth.signInWithPassword({ email: emailB, password });
      if (errB || !signInB.session) throw new Error(`Failed to sign in user B: ${errB?.message}`);
      userBToken = signInB.session.access_token;

      fileOkId = await uploadQuickDemo(userAToken);
      fileFailId = await uploadQuickDemo(userAToken);
      fileNotConfiguredId = await uploadQuickDemo(userAToken);
    }, 60_000);

    afterEach(() => {
      vi.mocked(getAnthropicClient).mockReset();
      delete process.env.ANTHROPIC_API_KEY;
    });

    it("401s with no Authorization header", async () => {
      const res = await request(app).get(`/api/logs/${fileOkId}/summary/stream`);
      expect(res.status).toBe(401);
    });

    it("404s (JSON, not SSE) for another user's file — RLS scoping, indistinguishable from nonexistent", async () => {
      const res = await request(app)
        .get(`/api/logs/${fileOkId}/summary/stream`)
        .set("Authorization", `Bearer ${userBToken}`);
      expect(res.status).toBe(404);
      expect(res.headers["content-type"]).toMatch(/json/);
    });

    it("404s a well-formed but nonexistent file id", async () => {
      const res = await request(app)
        .get("/api/logs/00000000-0000-0000-0000-000000000000/summary/stream")
        .set("Authorization", `Bearer ${userAToken}`);
      expect(res.status).toBe(404);
    });

    it("emits not_configured then done (fallback text), persists nothing, when no key is set", async () => {
      delete process.env.ANTHROPIC_API_KEY;

      const res = await streamRequest(app, fileNotConfiguredId, userAToken);
      expect(res.status).toBe(200);
      expect(res.headers["content-type"]).toMatch(/text\/event-stream/);

      const events = parseSseEvents(res.body as unknown as string);
      expect(events.map((e) => e.type)).toEqual(["not_configured", "done"]);
      const done = events[1] as Extract<SummaryStreamEvent, { type: "done" }>;
      expect(done.status).toBe("not_configured");
      expect(done.cached).toBe(false);
      // §14a's deterministic fallback shape, grounded in the file's real rows.
      expect(done.summary).toMatch(/events analyzed.*anomalies flagged/);
      expect(getAnthropicClient).not.toHaveBeenCalled();

      // Nothing persisted: a key configured later must trigger a REAL
      // generation, not replay a "not configured" fallback forever.
      const detail = await request(app).get(`/api/logs/${fileNotConfiguredId}`).set("Authorization", `Bearer ${userAToken}`);
      expect(detail.body.summary).toBeNull();
      expect(detail.body.file.llmSummaryStatus).toEqual({ status: "pending" });
    });

    it("streams thinking -> text -> done on first generation, persists, then replays from cache without a second LLM call", async () => {
      process.env.ANTHROPIC_API_KEY = "sk-ant-test";
      const finalMarkdown = "- 09:00 UTC: baseline traffic.\n- 09:14 UTC: threatname hit flagged.";
      const stream = vi.fn(() =>
        makeFakeMessageStream(
          [
            thinkingDelta("Reviewing the computed aggregates "),
            thinkingDelta("and the top anomalies."),
            textDelta("- 09:00 UTC: baseline traffic.\n"),
            textDelta("- 09:14 UTC: threatname hit flagged."),
          ],
          [
            { type: "thinking", thinking: "Reviewing the computed aggregates and the top anomalies." },
            { type: "text", text: finalMarkdown },
          ],
        ),
      );
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      vi.mocked(getAnthropicClient).mockReturnValue({ messages: { stream } } as any);

      // --- First connection: live generation ---
      const first = await streamRequest(app, fileOkId, userAToken);
      expect(first.status).toBe(200);
      const firstEvents = parseSseEvents(first.body as unknown as string);

      // Exact event ordering: all thinking deltas, then all text deltas,
      // then exactly one terminal done — no failed/not_configured frames.
      expect(firstEvents.map((e) => e.type)).toEqual(["thinking", "thinking", "text", "text", "done"]);
      const thinkingJoined = firstEvents
        .filter((e): e is Extract<SummaryStreamEvent, { type: "thinking" }> => e.type === "thinking")
        .map((e) => e.delta)
        .join("");
      expect(thinkingJoined).toBe("Reviewing the computed aggregates and the top anomalies.");
      const textJoined = firstEvents
        .filter((e): e is Extract<SummaryStreamEvent, { type: "text" }> => e.type === "text")
        .map((e) => e.delta)
        .join("");
      expect(textJoined).toBe(finalMarkdown);
      const firstDone = firstEvents[firstEvents.length - 1] as Extract<SummaryStreamEvent, { type: "done" }>;
      expect(firstDone).toEqual({ type: "done", summary: finalMarkdown, status: "ok", cached: false });
      expect(stream).toHaveBeenCalledTimes(1);

      // --- Persistence: summary + ok status visible through normal reads ---
      const detail = await request(app).get(`/api/logs/${fileOkId}`).set("Authorization", `Bearer ${userAToken}`);
      expect(detail.body.summary).toBe(finalMarkdown);
      expect(detail.body.file.llmSummaryStatus).toEqual({ status: "ok" });

      // --- Second connection: cached replay, no second Anthropic call ---
      const second = await streamRequest(app, fileOkId, userAToken);
      const secondEvents = parseSseEvents(second.body as unknown as string);
      expect(secondEvents).toEqual([{ type: "done", summary: finalMarkdown, status: "ok", cached: true }]);
      expect(stream).toHaveBeenCalledTimes(1); // still exactly one — the cache answered, not the API
    }, 30_000);

    it("emits failed then done (fallback), persists the fallback + failed status, and replays that from cache", async () => {
      process.env.ANTHROPIC_API_KEY = "sk-ant-test";
      const stream = vi.fn(() => ({
        async *[Symbol.asyncIterator](): AsyncGenerator<unknown> {
          yield thinkingDelta("Starting…");
          throw new Error("simulated mid-stream failure");
        },
        finalMessage: async () => {
          throw new Error("stream already errored");
        },
      }));
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      vi.mocked(getAnthropicClient).mockReturnValue({ messages: { stream } } as any);

      const res = await streamRequest(app, fileFailId, userAToken);
      expect(res.status).toBe(200);
      const events = parseSseEvents(res.body as unknown as string);

      // Deltas already sent stay sent; then the honest failure, then done
      // with the deterministic fallback — the client always gets something.
      expect(events.map((e) => e.type)).toEqual(["thinking", "failed", "done"]);
      const failed = events[1] as Extract<SummaryStreamEvent, { type: "failed" }>;
      expect(failed.reason).toBeTruthy();
      const done = events[2] as Extract<SummaryStreamEvent, { type: "done" }>;
      expect(done.status).toBe("failed");
      expect(done.cached).toBe(false);
      expect(done.summary).toMatch(/events analyzed.*anomalies flagged/);
      expect(done.reason).toBe(failed.reason);

      // Persisted: fallback text + failed status/reason.
      const detail = await request(app).get(`/api/logs/${fileFailId}`).set("Authorization", `Bearer ${userAToken}`);
      expect(detail.body.summary).toBe(done.summary);
      expect(detail.body.file.llmSummaryStatus).toEqual({ status: "failed", reason: failed.reason });

      // Reconnect replays the persisted fallback (status failed) without
      // another LLM call.
      const second = await streamRequest(app, fileFailId, userAToken);
      const secondEvents = parseSseEvents(second.body as unknown as string);
      expect(secondEvents.map((e) => e.type)).toEqual(["done"]);
      const secondDone = secondEvents[0] as Extract<SummaryStreamEvent, { type: "done" }>;
      expect(secondDone).toEqual({
        type: "done",
        summary: done.summary,
        status: "failed",
        reason: failed.reason,
        cached: true,
      });
      expect(stream).toHaveBeenCalledTimes(1);
    }, 30_000);
  },
);
