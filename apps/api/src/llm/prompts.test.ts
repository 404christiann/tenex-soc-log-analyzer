import { describe, expect, it } from "vitest";
import type { Anomaly, LogEvent } from "@tenex/shared";
import {
  buildJudgeToolInputSchema,
  buildJudgeUserPrompt,
  buildSummaryUserPrompt,
  JUDGE_SYSTEM_PROMPT,
  JUDGE_TOOL_NAME,
  JudgeToolResponseSchema,
  SUMMARY_SYSTEM_PROMPT,
  type JudgeCandidate,
} from "./prompts";

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

// ---------------------------------------------------------------------------
// buildJudgeToolInputSchema — Zod-derived JSON Schema for the forced tool
// ---------------------------------------------------------------------------

describe("buildJudgeToolInputSchema", () => {
  it("is a JSON object schema with additionalProperties: false at every level (required for strict tool use)", () => {
    const schema = buildJudgeToolInputSchema();
    expect(schema.type).toBe("object");
    expect(schema.additionalProperties).toBe(false);

    const results = (schema.properties as any).results;
    expect(results.type).toBe("array");
    expect(results.items.additionalProperties).toBe(false);
    expect(results.items.required).toEqual(["index", "explanation", "confidenceDelta"]);
  });

  it("strips JSON Schema keywords the structured-output validator does not support", () => {
    const schema = buildJudgeToolInputSchema();
    const serialized = JSON.stringify(schema);
    for (const forbidden of ["$schema", "minimum", "maximum", "minLength", "maxLength", "multipleOf"]) {
      expect(serialized).not.toContain(`"${forbidden}"`);
    }
  });
});

// ---------------------------------------------------------------------------
// JudgeToolResponseSchema — runtime validation of what comes back
// ---------------------------------------------------------------------------

describe("JudgeToolResponseSchema", () => {
  it("accepts a well-formed response", () => {
    const parsed = JudgeToolResponseSchema.safeParse({
      results: [{ index: 0, explanation: "looks like a real threat hit.", confidenceDelta: 5 }],
    });
    expect(parsed.success).toBe(true);
  });

  it("rejects a response missing the required results field", () => {
    const parsed = JudgeToolResponseSchema.safeParse({});
    expect(parsed.success).toBe(false);
  });

  it("rejects a candidate result with the wrong type for confidenceDelta", () => {
    const parsed = JudgeToolResponseSchema.safeParse({
      results: [{ index: 0, explanation: "x", confidenceDelta: "not a number" }],
    });
    expect(parsed.success).toBe(false);
  });

  it("rejects a candidate result missing explanation", () => {
    const parsed = JudgeToolResponseSchema.safeParse({
      results: [{ index: 0, confidenceDelta: 5 }],
    });
    expect(parsed.success).toBe(false);
  });

  it("rejects extra/unexpected top-level fields (strict schema)", () => {
    const parsed = JudgeToolResponseSchema.safeParse({
      results: [],
      extraField: "should not be here",
    });
    expect(parsed.success).toBe(false);
  });

  it("rejects a non-object payload entirely (e.g. the model returned a bare string)", () => {
    const parsed = JudgeToolResponseSchema.safeParse("not even an object");
    expect(parsed.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// buildJudgeUserPrompt — indexing contract + prompt-injection delimiting
// ---------------------------------------------------------------------------

describe("buildJudgeUserPrompt", () => {
  it("numbers candidates 0..N-1 in the given order, unambiguously", () => {
    const candidates: JudgeCandidate[] = [
      { anomaly: makeAnomaly({ id: "a", eventRef: "0" }), event: makeEvent({ url: "https://a.example.com/" }) },
      { anomaly: makeAnomaly({ id: "b", eventRef: "1" }), event: makeEvent({ url: "https://b.example.com/" }) },
      { anomaly: makeAnomaly({ id: "c", eventRef: "2" }), event: makeEvent({ url: "https://c.example.com/" }) },
    ];
    const prompt = buildJudgeUserPrompt(candidates);

    expect(prompt).toContain("CANDIDATE 0:");
    expect(prompt).toContain("CANDIDATE 1:");
    expect(prompt).toContain("CANDIDATE 2:");
    expect(prompt).not.toContain("CANDIDATE 3:");

    // Each candidate's own URL should appear once, next to its own index —
    // a crude but effective check that the mapping isn't scrambled.
    const idx0 = prompt.indexOf("CANDIDATE 0:");
    const idx1 = prompt.indexOf("CANDIDATE 1:");
    const idx2 = prompt.indexOf("CANDIDATE 2:");
    expect(prompt.slice(idx0, idx1)).toContain("a.example.com");
    expect(prompt.slice(idx1, idx2)).toContain("b.example.com");
    expect(prompt.slice(idx2)).toContain("c.example.com");
  });

  it("delimits each candidate's log-derived fields as a labeled DATA block", () => {
    const candidates: JudgeCandidate[] = [
      { anomaly: makeAnomaly(), event: makeEvent({ url: "https://evil.example.com/?x=1" }) },
    ];
    const prompt = buildJudgeUserPrompt(candidates);

    expect(prompt).toContain("<<<EVENT_DATA");
    expect(prompt).toContain("EVENT_DATA>>>");
    expect(prompt).toMatch(/untrusted DATA/i);
    // The url value itself appears inside the delimited block.
    const dataStart = prompt.indexOf("<<<EVENT_DATA");
    const dataEnd = prompt.indexOf("EVENT_DATA>>>");
    expect(prompt.slice(dataStart, dataEnd)).toContain("evil.example.com");
  });

  it("references the tool name so the model knows what to call", () => {
    const candidates: JudgeCandidate[] = [{ anomaly: makeAnomaly(), event: makeEvent() }];
    expect(buildJudgeUserPrompt(candidates)).toContain(JUDGE_TOOL_NAME);
  });
});

describe("JUDGE_SYSTEM_PROMPT", () => {
  it("explicitly instructs the model that log field values are untrusted data, not commands", () => {
    expect(JUDGE_SYSTEM_PROMPT).toMatch(/not instructions/i);
    expect(JUDGE_SYSTEM_PROMPT).toMatch(/DATA/);
    expect(JUDGE_SYSTEM_PROMPT).toContain(JUDGE_TOOL_NAME);
  });
});

// ---------------------------------------------------------------------------
// buildSummaryUserPrompt — grounded in computed facts, not raw log dump
// ---------------------------------------------------------------------------

describe("buildSummaryUserPrompt", () => {
  it("includes real computed facts (event count, time range, anomaly detail)", () => {
    const events = [
      makeEvent({ datetime: "2026-01-05T09:00:00Z", cip: "10.0.0.5" }),
      makeEvent({ datetime: "2026-01-05T09:05:00Z", cip: "10.0.0.6" }),
      makeEvent({ datetime: "2026-01-05T14:02:00Z", cip: "10.0.0.7", bytes_out: 999_999 }),
    ];
    const anomalies = [makeAnomaly({ eventRef: "2", ruleType: "bytes_out_exfil", rank: 1, baseConfidence: 88 })];

    const prompt = buildSummaryUserPrompt(events, anomalies, 20);

    expect(prompt).toContain("total_events: 3");
    expect(prompt).toContain("total_anomalies_flagged: 1");
    expect(prompt).toContain("10.0.0.7"); // the anomalous event's real IP
    expect(prompt).toContain("bytes_out_exfil");
  });

  it("caps anomaly detail at the given limit", () => {
    const events = Array.from({ length: 5 }, (_, i) =>
      makeEvent({ datetime: `2026-01-05T0${i}:00:00Z` }),
    );
    const anomalies = Array.from({ length: 5 }, (_, i) =>
      makeAnomaly({ id: `a${i}`, eventRef: String(i), rank: i + 1, baseConfidence: 100 - i }),
    );

    const prompt = buildSummaryUserPrompt(events, anomalies, 2);
    expect(prompt).toContain("up to 2");
    // Only the top-2-ranked anomalies' rank markers should appear.
    expect(prompt).toContain("[rank 1,");
    expect(prompt).toContain("[rank 2,");
    expect(prompt).not.toContain("[rank 3,");
  });

  it("handles zero events without crashing and says so plainly", () => {
    const prompt = buildSummaryUserPrompt([], [], 20);
    expect(prompt.toLowerCase()).toContain("zero parsed events");
  });

  // §14d: each top-anomaly line carries the anomaly's REAL row id so the
  // model can cite it via the `event:<id>` link scheme — the only id source
  // it has, so a citation is either real or frontend-de-linked.
  it("includes each top anomaly's real id for event: citation links", () => {
    const events = [makeEvent({ datetime: "2026-01-05T09:00:00Z" })];
    const anomalies = [makeAnomaly({ id: "8f4c1a2e-real-row-id", eventRef: "0", rank: 1 })];

    const prompt = buildSummaryUserPrompt(events, anomalies, 20);
    expect(prompt).toContain("id 8f4c1a2e-real-row-id");
  });

  it("system prompt instructs event: citation links using only provided ids", () => {
    expect(SUMMARY_SYSTEM_PROMPT).toContain("event:<id>");
    expect(SUMMARY_SYSTEM_PROMPT).toMatch(/never invent/i);
  });

  // Severity-grouped summary: the model is told each anomaly's tier
  // explicitly (same shared banding as the UI badges) and instructed to
  // group bullets under exact section headings — never to guess a tier from
  // the confidence number.
  it("labels each top anomaly with its explicit severity tier, banded on adjusted-else-base confidence", () => {
    const events = [makeEvent(), makeEvent(), makeEvent()];
    const anomalies = [
      // base 90 → high on its own; judge pulled it to 70 → medium is authoritative.
      makeAnomaly({ id: "adj", eventRef: "0", rank: 1, baseConfidence: 90, llmAdjustedConfidence: 70 }),
      makeAnomaly({ id: "hi", eventRef: "1", rank: 2, baseConfidence: 88, llmAdjustedConfidence: null }),
      makeAnomaly({ id: "lo", eventRef: "2", rank: 3, baseConfidence: 40, llmAdjustedConfidence: null }),
    ];

    const prompt = buildSummaryUserPrompt(events, anomalies, 20);
    expect(prompt).toContain("id adj, threatname_hit, confidence 70, severity medium");
    expect(prompt).toContain("id hi, threatname_hit, confidence 88, severity high");
    expect(prompt).toContain("id lo, threatname_hit, confidence 40, severity low");
  });

  it("system prompt instructs the exact severity section headings, in order, empty sections omitted", () => {
    expect(SUMMARY_SYSTEM_PROMPT).toContain("### High severity");
    expect(SUMMARY_SYSTEM_PROMPT).toContain("### Medium severity");
    expect(SUMMARY_SYSTEM_PROMPT).toContain("### Low severity");
    expect(SUMMARY_SYSTEM_PROMPT).toContain("### Observations");
    expect(SUMMARY_SYSTEM_PROMPT).toMatch(/omit any section that would be empty/i);
    expect(SUMMARY_SYSTEM_PROMPT).toMatch(/never re-derive severity/i);
  });

  // Executive-digest TL;DR lead (recombined with severity grouping per the
  // §14e closing note): the client's splitTldr() keys on the exact marker as
  // the FIRST line, and the severity sections must start only AFTER it.
  it("system prompt requires a first-line **TL;DR:** lead the UI can split into the digest hero", () => {
    expect(SUMMARY_SYSTEM_PROMPT).toContain("`**TL;DR:** <sentence>`");
    expect(SUMMARY_SYSTEM_PROMPT).toMatch(/very first line/i);
    // One sentence, grounded, no citations in the lead — citations stay in bullets.
    expect(SUMMARY_SYSTEM_PROMPT).toMatch(/Exactly one sentence/);
    expect(SUMMARY_SYSTEM_PROMPT).toMatch(/No `event:<id>` citation links in the TL;DR/);
  });

  it("system prompt sequences the TL;DR ABOVE the severity sections — lead line first, blank line, then the first heading", () => {
    // The two instruction blocks must compose, not contradict: the TL;DR is
    // explicitly not a heading, and the first section heading comes only
    // after the TL;DR's blank line.
    expect(SUMMARY_SYSTEM_PROMPT).toMatch(/NOT a heading/);
    expect(SUMMARY_SYSTEM_PROMPT).toMatch(/first line after the blank line is the first section heading/);
    // And the ordering of the blocks in the prompt itself: Lead line rules
    // appear before the Severity grouping rules.
    expect(SUMMARY_SYSTEM_PROMPT.indexOf("Lead line")).toBeGreaterThan(-1);
    expect(SUMMARY_SYSTEM_PROMPT.indexOf("Lead line")).toBeLessThan(SUMMARY_SYSTEM_PROMPT.indexOf("Severity grouping"));
  });

  it("system prompt keeps the one-flagged-event-per-bullet rule (TL;DR addition must not regress it)", () => {
    expect(SUMMARY_SYSTEM_PROMPT).toContain("One flagged event per bullet, always.");
    expect(SUMMARY_SYSTEM_PROMPT).toMatch(/Never combine two or more distinct flagged events/);
  });

  it("omits ids of anomalies beyond the cap — the model can never cite what it wasn't given", () => {
    const events = [makeEvent(), makeEvent()];
    const anomalies = [
      makeAnomaly({ id: "id-in-cap", eventRef: "0", rank: 1 }),
      makeAnomaly({ id: "id-beyond-cap", eventRef: "1", rank: 2 }),
    ];

    const prompt = buildSummaryUserPrompt(events, anomalies, 1);
    expect(prompt).toContain("id-in-cap");
    expect(prompt).not.toContain("id-beyond-cap");
  });
});
