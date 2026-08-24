import { afterEach, describe, expect, it, vi } from "vitest";
import type { Anomaly, LogEvent } from "@tenex/shared";
import { generateFallbackSummary, streamSummary } from "./summary";

vi.mock("./client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./client")>();
  return {
    ...actual,
    getAnthropicClient: vi.fn(),
  };
});

import { getAnthropicClient } from "./client";

const ORIGINAL_KEY = process.env.ANTHROPIC_API_KEY;

afterEach(() => {
  vi.mocked(getAnthropicClient).mockReset();
  if (ORIGINAL_KEY === undefined) {
    delete process.env.ANTHROPIC_API_KEY;
  } else {
    process.env.ANTHROPIC_API_KEY = ORIGINAL_KEY;
  }
});

function makeEvent(overrides: Partial<LogEvent> = {}): LogEvent {
  return {
    datetime: "2026-01-05T09:00:00Z",
    cip: "10.0.0.1",
    login: "jdoe",
    url: "https://example.com/",
    action: "allowed",
    urlcat: "Business",
    threatname: null,
    respcode: 200,
    bytes_out: 100,
    bytes_in: 500,
    useragent: "Mozilla/5.0",
    reqmethod: "GET",
    ...overrides,
  };
}

function makeAnomaly(overrides: Partial<Anomaly> = {}): Anomaly {
  return {
    id: "anomaly-0",
    ruleType: "threatname_hit",
    triggeredReasons: ["threatname populated: direct signal."],
    baseConfidence: 95,
    llmAdjustedConfidence: null,
    explanation: "threatname populated: direct signal.",
    llmExplanation: null,
    rank: 1,
    eventRef: "0",
    ...overrides,
  };
}

/**
 * Fakes the object `client.messages.stream(...)` returns: async-iterable
 * over raw stream events plus a `finalMessage()` — the exact surface
 * `streamSummary` consumes (claude-api skill, TypeScript streaming shape).
 */
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

function mockClientWithStream(streamImpl: (...args: unknown[]) => unknown) {
  const stream = vi.fn(streamImpl);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  vi.mocked(getAnthropicClient).mockReturnValue({ messages: { stream } } as any);
  return stream;
}

// ---------------------------------------------------------------------------
// generateFallbackSummary — exact string/shape assertions
// ---------------------------------------------------------------------------

describe("generateFallbackSummary", () => {
  it("matches the exact documented shape (DECISIONS.md §14a example)", () => {
    const events = [
      makeEvent({ datetime: "2026-01-05T09:02:00Z" }),
      makeEvent({ datetime: "2026-01-05T12:00:00Z" }),
      makeEvent({ datetime: "2026-01-05T17:44:00Z" }),
    ];
    const anomalies = [
      makeAnomaly({ id: "a1", ruleType: "threatname_hit" }),
      makeAnomaly({ id: "a2", ruleType: "off_hours" }),
    ];

    expect(generateFallbackSummary(events, anomalies)).toBe(
      "3 events analyzed, 2 anomalies flagged across 2 rule types, time range 09:02–17:44.",
    );
  });

  it("counts distinct rule types, not raw anomaly count", () => {
    const events = [makeEvent()];
    const anomalies = [
      makeAnomaly({ id: "a1", ruleType: "burst_per_ip" }),
      makeAnomaly({ id: "a2", ruleType: "burst_per_ip" }),
      makeAnomaly({ id: "a3", ruleType: "off_hours" }),
    ];
    expect(generateFallbackSummary(events, anomalies)).toBe(
      "1 events analyzed, 3 anomalies flagged across 2 rule types, time range 09:00–09:00.",
    );
  });

  it("handles zero events", () => {
    expect(generateFallbackSummary([], [])).toBe(
      "0 events analyzed, 0 anomalies flagged across 0 rule types, time range n/a.",
    );
  });

  it("handles zero anomalies (negative-control file)", () => {
    const events = [makeEvent({ datetime: "2026-01-05T08:00:00Z" }), makeEvent({ datetime: "2026-01-05T09:30:00Z" })];
    expect(generateFallbackSummary(events, [])).toBe(
      "2 events analyzed, 0 anomalies flagged across 0 rule types, time range 08:00–09:30.",
    );
  });
});

// ---------------------------------------------------------------------------
// not_configured short-circuit
// ---------------------------------------------------------------------------

describe("streamSummary — not_configured", () => {
  it("returns the deterministic fallback with no network call and no deltas when ANTHROPIC_API_KEY is unset", async () => {
    delete process.env.ANTHROPIC_API_KEY;
    const events = [makeEvent()];
    const anomalies = [makeAnomaly()];
    const onThinkingDelta = vi.fn();
    const onTextDelta = vi.fn();

    const result = await streamSummary(events, anomalies, { onThinkingDelta, onTextDelta });

    expect(result.status).toEqual({ status: "not_configured" });
    expect(result.markdown).toBe(generateFallbackSummary(events, anomalies));
    expect(getAnthropicClient).not.toHaveBeenCalled();
    // §14c: no fake thinking for a call that never happened.
    expect(onThinkingDelta).not.toHaveBeenCalled();
    expect(onTextDelta).not.toHaveBeenCalled();
  });
});

describe("streamSummary — zero events", () => {
  it("skips the network call and returns ok with the fallback text when there are no events", async () => {
    process.env.ANTHROPIC_API_KEY = "sk-ant-test";
    const stream = mockClientWithStream(() => makeFakeMessageStream([], []));

    const result = await streamSummary([], []);

    expect(result.status).toEqual({ status: "ok" });
    expect(result.markdown).toBe(generateFallbackSummary([], []));
    expect(stream).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Success / failure against a mocked streaming client
// ---------------------------------------------------------------------------

describe("streamSummary — mocked LLM stream", () => {
  it("forwards thinking then text deltas in order and returns the final markdown", async () => {
    process.env.ANTHROPIC_API_KEY = "sk-ant-test";
    const events = [makeEvent()];
    const anomalies = [makeAnomaly()];
    const stream = mockClientWithStream(() =>
      makeFakeMessageStream(
        [
          thinkingDelta("Scanning the "),
          thinkingDelta("flagged anomalies."),
          textDelta("- 09:00 UTC: "),
          textDelta("a threat was flagged."),
        ],
        [
          { type: "thinking", thinking: "Scanning the flagged anomalies." },
          { type: "text", text: "- 09:00 UTC: a threat was flagged." },
        ],
      ),
    );

    const received: Array<{ kind: "thinking" | "text"; delta: string }> = [];
    const result = await streamSummary(events, anomalies, {
      onThinkingDelta: (delta) => received.push({ kind: "thinking", delta }),
      onTextDelta: (delta) => received.push({ kind: "text", delta }),
    });

    expect(result.status).toEqual({ status: "ok" });
    expect(result.markdown).toBe("- 09:00 UTC: a threat was flagged.");
    expect(received).toEqual([
      { kind: "thinking", delta: "Scanning the " },
      { kind: "thinking", delta: "flagged anomalies." },
      { kind: "text", delta: "- 09:00 UTC: " },
      { kind: "text", delta: "a threat was flagged." },
    ]);
    expect(stream).toHaveBeenCalledTimes(1);
    // The §14c-locked request shape: Sonnet 5 + adaptive thinking with
    // visible summarized reasoning.
    const params = stream.mock.calls[0][0] as { model: string; thinking: unknown };
    expect(params.model).toBe("claude-sonnet-5");
    expect(params.thinking).toEqual({ type: "adaptive", display: "summarized" });
  });

  it("falls back to the deterministic summary when the stream errors mid-generation, without throwing", async () => {
    process.env.ANTHROPIC_API_KEY = "sk-ant-test";
    const events = [makeEvent()];
    const anomalies = [makeAnomaly()];
    mockClientWithStream(() => ({
      // eslint-disable-next-line require-yield
      async *[Symbol.asyncIterator](): AsyncGenerator<unknown> {
        yield thinkingDelta("Starting to reason…");
        throw new Error("529 overloaded_error");
      },
      finalMessage: async () => {
        throw new Error("stream already errored");
      },
    }));

    const onThinkingDelta = vi.fn();
    const result = await streamSummary(events, anomalies, { onThinkingDelta });

    expect(result.status.status).toBe("failed");
    expect(result.status.reason).toBeTruthy();
    expect(result.markdown).toBe(generateFallbackSummary(events, anomalies));
    // Deltas received before the failure were still forwarded — the route
    // layer is responsible for following them with `failed` + fallback.
    expect(onThinkingDelta).toHaveBeenCalledWith("Starting to reason…");
  });

  it("falls back to the deterministic summary when the final message has no text", async () => {
    process.env.ANTHROPIC_API_KEY = "sk-ant-test";
    const events = [makeEvent()];
    const anomalies = [makeAnomaly()];
    mockClientWithStream(() => makeFakeMessageStream([], [{ type: "thinking", thinking: "…" }]));

    const result = await streamSummary(events, anomalies);

    expect(result.status.status).toBe("failed");
    expect(result.markdown).toBe(generateFallbackSummary(events, anomalies));
  });
});
