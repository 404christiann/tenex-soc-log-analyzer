import { afterEach, describe, expect, it, vi } from "vitest";
import type { Anomaly, LogEvent } from "@tenex/shared";
import {
  clampConfidence,
  clampConfidenceDelta,
  JUDGE_CANDIDATE_LIMIT,
  JUDGE_CONFIDENCE_DELTA_MAX,
  JUDGE_CONFIDENCE_DELTA_MIN,
  judge,
} from "./judge";
import { JUDGE_TOOL_NAME } from "./prompts";

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

/** N anomalies + a parallel events array, each anomaly's eventRef pointing at its own event, baseConfidence descending with index (anomaly 0 highest). */
function makeAnomalySet(n: number): { anomalies: Anomaly[]; events: LogEvent[] } {
  const events: LogEvent[] = [];
  const anomalies: Anomaly[] = [];
  for (let i = 0; i < n; i++) {
    events.push(makeEvent({ url: `https://host-${i}.example.com/` }));
    anomalies.push(
      makeAnomaly({
        id: `anomaly-${i}`,
        eventRef: String(i),
        baseConfidence: 100 - i, // strictly descending, so sort order == index order
        rank: i + 1,
      }),
    );
  }
  return { anomalies, events };
}

function toolUseResponse(results: Array<{ index: number; explanation: string; confidenceDelta: number }>) {
  return {
    content: [{ type: "tool_use", id: "tu_1", name: JUDGE_TOOL_NAME, input: { results } }],
  };
}

function mockClientWithCreate(createImpl: (...args: unknown[]) => unknown) {
  const create = vi.fn(createImpl);
  vi.mocked(getAnthropicClient).mockReturnValue({ messages: { create } } as any);
  return create;
}

// ---------------------------------------------------------------------------
// Clamping
// ---------------------------------------------------------------------------

describe("clampConfidenceDelta", () => {
  it("passes through in-range deltas unchanged", () => {
    expect(clampConfidenceDelta(10)).toBe(10);
    expect(clampConfidenceDelta(-10)).toBe(-10);
    expect(clampConfidenceDelta(0)).toBe(0);
  });

  it("clamps a delta above the max", () => {
    expect(clampConfidenceDelta(9999)).toBe(JUDGE_CONFIDENCE_DELTA_MAX);
  });

  it("clamps a delta below the min", () => {
    expect(clampConfidenceDelta(-9999)).toBe(JUDGE_CONFIDENCE_DELTA_MIN);
  });

  it("clamps exactly at the boundary", () => {
    expect(clampConfidenceDelta(15)).toBe(15);
    expect(clampConfidenceDelta(-15)).toBe(-15);
    expect(clampConfidenceDelta(15.0001)).toBe(15);
  });
});

describe("clampConfidence", () => {
  it("clamps to [0, 100]", () => {
    expect(clampConfidence(-5)).toBe(0);
    expect(clampConfidence(105)).toBe(100);
    expect(clampConfidence(50)).toBe(50);
  });
});

// ---------------------------------------------------------------------------
// not_configured short-circuit
// ---------------------------------------------------------------------------

describe("judge — not_configured", () => {
  it("returns not_configured immediately with no network call when ANTHROPIC_API_KEY is unset", async () => {
    delete process.env.ANTHROPIC_API_KEY;
    const { anomalies, events } = makeAnomalySet(3);

    const result = await judge(anomalies, events);

    expect(result.status).toEqual({ status: "not_configured" });
    expect(result.candidateCount).toBe(0);
    expect(result.anomalies).toEqual(anomalies); // untouched — same deterministic explanations
    expect(getAnthropicClient).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Candidate cap (top-N=20) + index mapping
// ---------------------------------------------------------------------------

describe("judge — candidate cap and index mapping", () => {
  it("sends only the top JUDGE_CANDIDATE_LIMIT candidates by baseConfidence, and reports the cap", async () => {
    process.env.ANTHROPIC_API_KEY = "sk-ant-test";
    const total = JUDGE_CANDIDATE_LIMIT + 5;
    const { anomalies, events } = makeAnomalySet(total);

    const create = mockClientWithCreate((params: any) => {
      const userMessage = params.messages[0].content as string;
      // The 20th candidate (index 19) should be present; the 21st (index 20) must not be.
      expect(userMessage).toContain("CANDIDATE 19:");
      expect(userMessage).not.toContain("CANDIDATE 20:");
      return toolUseResponse(
        Array.from({ length: JUDGE_CANDIDATE_LIMIT }, (_, i) => ({
          index: i,
          explanation: `refined-${i}`,
          confidenceDelta: 1,
        })),
      );
    });

    const result = await judge(anomalies, events);

    expect(create).toHaveBeenCalledTimes(1);
    expect(result.candidateCount).toBe(JUDGE_CANDIDATE_LIMIT);
    expect(result.status).toEqual({ status: "ok" });

    // The top 20 (by baseConfidence, i.e. anomaly-0..19) got judged...
    for (let i = 0; i < JUDGE_CANDIDATE_LIMIT; i++) {
      const a = result.anomalies.find((x) => x.id === `anomaly-${i}`)!;
      expect(a.llmExplanation).toBe(`refined-${i}`);
      expect(a.llmAdjustedConfidence).toBe(Math.min(100, a.baseConfidence + 1));
    }
    // ...the remaining 5 (anomaly-20..24) fell outside the cap and keep the
    // deterministic Layer 1 fields untouched.
    for (let i = JUDGE_CANDIDATE_LIMIT; i < total; i++) {
      const a = result.anomalies.find((x) => x.id === `anomaly-${i}`)!;
      expect(a.llmExplanation).toBeNull();
      expect(a.llmAdjustedConfidence).toBeNull();
    }
  });

  it("maps response indices back to the correct anomaly even when input order differs from confidence order", async () => {
    process.env.ANTHROPIC_API_KEY = "sk-ant-test";
    // Build 3 anomalies out of confidence order to prove sort-then-index, not array-position.
    const events = [makeEvent({ url: "https://low.example.com/" }), makeEvent({ url: "https://high.example.com/" }), makeEvent({ url: "https://mid.example.com/" })];
    const anomalies: Anomaly[] = [
      makeAnomaly({ id: "low", eventRef: "0", baseConfidence: 50 }),
      makeAnomaly({ id: "high", eventRef: "1", baseConfidence: 90 }),
      makeAnomaly({ id: "mid", eventRef: "2", baseConfidence: 70 }),
    ];

    // Sorted descending: high(0), mid(1), low(2) — that's the index contract.
    const create = mockClientWithCreate(() =>
      toolUseResponse([
        { index: 0, explanation: "for high", confidenceDelta: 0 },
        { index: 1, explanation: "for mid", confidenceDelta: 0 },
        { index: 2, explanation: "for low", confidenceDelta: 0 },
      ]),
    );

    const result = await judge(anomalies, events);
    expect(create).toHaveBeenCalledTimes(1);

    expect(result.anomalies.find((a) => a.id === "high")!.llmExplanation).toBe("for high");
    expect(result.anomalies.find((a) => a.id === "mid")!.llmExplanation).toBe("for mid");
    expect(result.anomalies.find((a) => a.id === "low")!.llmExplanation).toBe("for low");
  });

  it("keeps the deterministic explanation for an index the model silently omitted", async () => {
    process.env.ANTHROPIC_API_KEY = "sk-ant-test";
    const { anomalies, events } = makeAnomalySet(2);

    mockClientWithCreate(() => toolUseResponse([{ index: 0, explanation: "only this one", confidenceDelta: 2 }]));

    const result = await judge(anomalies, events);
    expect(result.anomalies.find((a) => a.id === "anomaly-0")!.llmExplanation).toBe("only this one");
    const omitted = result.anomalies.find((a) => a.id === "anomaly-1")!;
    expect(omitted.llmExplanation).toBeNull();
    expect(omitted.llmAdjustedConfidence).toBeNull();
  });

  it("returns ok with zero candidates and skips the network call when there are no anomalies to judge", async () => {
    process.env.ANTHROPIC_API_KEY = "sk-ant-test";
    const create = mockClientWithCreate(() => toolUseResponse([]));

    const result = await judge([], []);

    expect(result.status).toEqual({ status: "ok" });
    expect(result.candidateCount).toBe(0);
    expect(result.anomalies).toEqual([]);
    expect(create).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Server-side confidence-delta clamping, end to end through judge()
// ---------------------------------------------------------------------------

describe("judge — server-side confidence clamping", () => {
  it("clamps an out-of-range delta from the model regardless of what it returned", async () => {
    process.env.ANTHROPIC_API_KEY = "sk-ant-test";
    const { anomalies, events } = makeAnomalySet(2);
    // anomaly-0 baseConfidence=100, anomaly-1 baseConfidence=99
    mockClientWithCreate(() =>
      toolUseResponse([
        { index: 0, explanation: "way too generous", confidenceDelta: 500 },
        { index: 1, explanation: "way too harsh", confidenceDelta: -500 },
      ]),
    );

    const result = await judge(anomalies, events);
    const a0 = result.anomalies.find((a) => a.id === "anomaly-0")!;
    const a1 = result.anomalies.find((a) => a.id === "anomaly-1")!;

    // delta clamped to +15 then confidence clamped to 100 (already saturated).
    expect(a0.llmAdjustedConfidence).toBe(100);
    // delta clamped to -15 -> 99 - 15 = 84.
    expect(a1.llmAdjustedConfidence).toBe(84);
  });
});

// ---------------------------------------------------------------------------
// Malformed response handling
// ---------------------------------------------------------------------------

describe("judge — malformed response handling", () => {
  it("treats a response with no tool_use block as failed, not a crash, and retries once", async () => {
    process.env.ANTHROPIC_API_KEY = "sk-ant-test";
    const { anomalies, events } = makeAnomalySet(2);
    const create = mockClientWithCreate(() => ({ content: [{ type: "text", text: "I refuse to use tools." }] }));

    const result = await expectNoThrow(() => judge(anomalies, events));

    expect(create).toHaveBeenCalledTimes(2); // one retry
    expect(result.status.status).toBe("failed");
    expect(result.status.reason).toBeTruthy();
    expect(result.anomalies).toEqual(anomalies); // untouched deterministic fallback
  });

  it("treats a schema-invalid tool_use input as failed, not a crash", async () => {
    process.env.ANTHROPIC_API_KEY = "sk-ant-test";
    const { anomalies, events } = makeAnomalySet(1);
    const create = mockClientWithCreate(() => ({
      content: [
        {
          type: "tool_use",
          id: "tu_1",
          name: JUDGE_TOOL_NAME,
          input: { results: [{ index: "not-a-number", explanation: 123, confidenceDelta: "nope" }] },
        },
      ],
    }));

    const result = await expectNoThrow(() => judge(anomalies, events));

    expect(create).toHaveBeenCalledTimes(2);
    expect(result.status.status).toBe("failed");
    expect(result.anomalies).toEqual(anomalies);
  });

  it("does not retry a non-retryable API error (e.g. auth failure) — one call, immediate failed status", async () => {
    process.env.ANTHROPIC_API_KEY = "sk-ant-test";
    const { anomalies, events } = makeAnomalySet(1);
    const create = mockClientWithCreate(() => {
      throw new Error("401 authentication_error");
    });

    const result = await judge(anomalies, events);

    expect(create).toHaveBeenCalledTimes(1);
    expect(result.status.status).toBe("failed");
    expect(result.anomalies).toEqual(anomalies);
  });
});

async function expectNoThrow<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    // Re-throw with a clearer failure message than an unhandled rejection would give.
    throw new Error(`Expected judge() not to throw, but it did: ${String(err)}`);
  }
}
