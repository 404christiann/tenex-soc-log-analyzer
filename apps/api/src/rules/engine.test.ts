import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { LogEvent } from "@tenex/shared";
import { parseLogFile } from "../parser/parse-log";
import { runRuleEngine } from "./engine";
import { burstPerIpRule } from "./burst-per-ip";
import { exfilBytesRule } from "./exfil-bytes";
import { offHoursRule } from "./off-hours";
import { rareUserAgentRule } from "./rare-user-agent";
import { repeatedBlockedRule } from "./repeated-blocked";
import { threatNameRule } from "./threat-name";
import { malwareCategoryRule } from "./malware-category";

const EXAMPLES_DIR = path.resolve(__dirname, "../../../../examples");

function parseExample(filename: string): LogEvent[] {
  const buf = fs.readFileSync(path.join(EXAMPLES_DIR, filename));
  const result = parseLogFile(buf);
  expect(result.fileLevelError).toBeUndefined();
  expect(result.errors).toEqual([]);
  return result.events;
}

/** Base fields for a benign synthetic event; individual tests override only what matters. */
function makeEvent(overrides: Partial<LogEvent>): LogEvent {
  return {
    datetime: "2026-01-05T09:00:00Z", // Monday, 09:00 UTC — inside business hours
    cip: "10.0.0.1",
    login: "jdoe",
    url: "https://example.com/",
    action: "allowed",
    urlcat: "Business",
    threatname: null,
    respcode: 200,
    bytes_out: 100,
    bytes_in: 500,
    useragent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
    reqmethod: "GET",
    ...overrides,
  };
}

function isoPlusSeconds(baseIso: string, seconds: number): string {
  return new Date(new Date(baseIso).getTime() + seconds * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");
}

// ---------------------------------------------------------------------------
// End-to-end: real example files vs. ANSWER_KEY.md ground truth
// ---------------------------------------------------------------------------

describe("engine — clean-traffic.log (negative control)", () => {
  it("flags zero anomalies (false-positive-rate proof, DECISIONS.md §13)", () => {
    const events = parseExample("clean-traffic.log");
    expect(events).toHaveLength(300);
    const anomalies = runRuleEngine(events);
    expect(anomalies).toEqual([]);
  });
});

describe("engine — normal-traffic.log vs. ANSWER_KEY.md", () => {
  const events = parseExample("normal-traffic.log");
  const anomalies = runRuleEngine(events);
  // 1-indexed source line numbers === (index + 1) here since the parser
  // produced zero errors/skips for this file (verified in parseExample).
  const flaggedLines = new Set(anomalies.map((a) => Number(a.eventRef) + 1));

  it("parses the documented 2414 rows", () => {
    expect(events).toHaveLength(2414);
  });

  it("flags every line in burst-per-IP instance #1 (lines 1882-1884,1886-1893,1895-1899,1901)", () => {
    const lines = [
      1882, 1883, 1884, 1886, 1887, 1888, 1889, 1890, 1891, 1892, 1893, 1895, 1896, 1897, 1898, 1899, 1901,
    ];
    for (const line of lines) expect(flaggedLines.has(line)).toBe(true);
  });

  it("flags every line in burst-per-IP instance #2 (lines 166-181,183-185)", () => {
    const lines = [166, 167, 168, 169, 170, 171, 172, 173, 174, 175, 176, 177, 178, 179, 180, 181, 183, 184, 185];
    for (const line of lines) expect(flaggedLines.has(line)).toBe(true);
  });

  it("flags both exfil bytes_out instances (lines 736, 18) with matching reasons", () => {
    expect(flaggedLines.has(736)).toBe(true);
    expect(flaggedLines.has(18)).toBe(true);
    const a736 = anomalies.find((a) => Number(a.eventRef) + 1 === 736)!;
    const a18 = anomalies.find((a) => Number(a.eventRef) + 1 === 18)!;
    expect(a736.triggeredReasons.some((r) => r.includes("z-score 4.16"))).toBe(true);
    expect(a18.triggeredReasons.some((r) => r.includes("z-score 24.52"))).toBe(true);
  });

  it("flags all 3 threatname instances (lines 1326, 2186, 1978)", () => {
    for (const line of [1326, 2186, 1978]) expect(flaggedLines.has(line)).toBe(true);
  });

  it("flags all 3 malware-category instances (lines 2414, 1307, 1047)", () => {
    for (const line of [2414, 1307, 1047]) expect(flaggedLines.has(line)).toBe(true);
  });

  it("flags all repeated-blocked lines (1355-1360, 333-339)", () => {
    for (const line of [1355, 1356, 1357, 1358, 1359, 1360, 333, 334, 335, 336, 337, 338, 339]) {
      expect(flaggedLines.has(line)).toBe(true);
    }
  });

  it("flags all 3 off-hours instances (lines 1, 215, 1187)", () => {
    for (const line of [1, 215, 1187]) expect(flaggedLines.has(line)).toBe(true);
  });

  it("flags all 4 rare/scripted UA instances (lines 1589, 2178, 1125, 93)", () => {
    for (const line of [1589, 2178, 1125, 93]) expect(flaggedLines.has(line)).toBe(true);
  });
});

describe("engine — quick-demo.log vs. ANSWER_KEY.md", () => {
  const events = parseExample("quick-demo.log");
  const anomalies = runRuleEngine(events);
  const flaggedLines = new Set(anomalies.map((a) => Number(a.eventRef) + 1));

  it("parses the documented 169 rows", () => {
    expect(events).toHaveLength(169);
  });

  it("flags both burst-per-IP instances (lines 81-97, 22-40)", () => {
    for (let line = 81; line <= 97; line++) expect(flaggedLines.has(line)).toBe(true);
    for (let line = 22; line <= 40; line++) expect(flaggedLines.has(line)).toBe(true);
  });

  it("flags both exfil instances (lines 141, 9) with matching z-scores", () => {
    const a141 = anomalies.find((a) => Number(a.eventRef) + 1 === 141)!;
    const a9 = anomalies.find((a) => Number(a.eventRef) + 1 === 9)!;
    expect(a141.triggeredReasons.some((r) => r.includes("z-score 4.01"))).toBe(true);
    expect(a9.triggeredReasons.some((r) => r.includes("z-score 6.86"))).toBe(true);
  });

  it("flags both threatname instances (lines 135, 60)", () => {
    for (const line of [135, 60]) expect(flaggedLines.has(line)).toBe(true);
  });

  it("flags both malware-category instances (lines 128, 59)", () => {
    for (const line of [128, 59]) expect(flaggedLines.has(line)).toBe(true);
  });

  it("flags both repeated-blocked instances (lines 119-123,125 and 155-161)", () => {
    for (const line of [119, 120, 121, 122, 123, 125]) expect(flaggedLines.has(line)).toBe(true);
    for (let line = 155; line <= 161; line++) expect(flaggedLines.has(line)).toBe(true);
  });

  it("flags both off-hours instances (lines 1, 115)", () => {
    for (const line of [1, 115]) expect(flaggedLines.has(line)).toBe(true);
  });

  it("flags both rare/scripted UA instances (lines 167, 118)", () => {
    for (const line of [167, 118]) expect(flaggedLines.has(line)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Unit tests — one rule module at a time, small synthetic fixtures
// ---------------------------------------------------------------------------

describe("burstPerIpRule (unit)", () => {
  it("flags a 17-request/48s burst from one IP, and nothing else", () => {
    const events: LogEvent[] = [];
    for (let i = 0; i < 17; i++) {
      events.push(makeEvent({ cip: "10.9.201.163", datetime: isoPlusSeconds("2026-01-05T09:00:00Z", i * 3) }));
    }
    // A handful of unrelated baseline events elsewhere.
    events.push(makeEvent({ cip: "10.0.0.9", datetime: "2026-01-05T09:05:00Z" }));
    events.push(makeEvent({ cip: "10.0.0.10", datetime: "2026-01-05T09:06:00Z" }));

    const candidates = burstPerIpRule(events);
    const flaggedIndexes = new Set(candidates.map((c) => c.eventIndex));
    expect(flaggedIndexes.size).toBe(17);
    for (let i = 0; i < 17; i++) expect(flaggedIndexes.has(i)).toBe(true);
    expect(flaggedIndexes.has(17)).toBe(false);
    expect(flaggedIndexes.has(18)).toBe(false);
  });

  it("does not flag 10 requests/60s from one IP (below the absolute floor of 15)", () => {
    const events: LogEvent[] = [];
    for (let i = 0; i < 10; i++) {
      events.push(makeEvent({ cip: "10.9.201.163", datetime: isoPlusSeconds("2026-01-05T09:00:00Z", i * 5) }));
    }
    expect(burstPerIpRule(events)).toEqual([]);
  });
});

describe("exfilBytesRule (unit)", () => {
  it("skips the exfil rule entirely below the 30-sample POST/PUT floor", () => {
    const events: LogEvent[] = [];
    for (let i = 0; i < 10; i++) {
      events.push(makeEvent({ reqmethod: "POST", bytes_out: 100 + i }));
    }
    events.push(makeEvent({ reqmethod: "POST", bytes_out: 999_999 }));
    expect(exfilBytesRule(events)).toEqual([]);
  });

  it("flags a POST outlier once >=30 POST/PUT samples exist", () => {
    const events: LogEvent[] = [];
    for (let i = 0; i < 40; i++) {
      events.push(makeEvent({ reqmethod: "POST", bytes_out: 100 + (i % 5) }));
    }
    events.push(makeEvent({ reqmethod: "POST", bytes_out: 50_000 }));
    const candidates = exfilBytesRule(events);
    expect(candidates).toHaveLength(1);
    expect(candidates[0].eventIndex).toBe(40);
    expect(candidates[0].confidence).toBeGreaterThanOrEqual(65);
  });
});

describe("offHoursRule (unit)", () => {
  it("flags an event before 08:00 UTC and one on a Saturday, not a Monday-10am event", () => {
    const events: LogEvent[] = [
      makeEvent({ datetime: "2026-01-05T01:48:00Z" }), // Monday 01:48 UTC — before business hours
      makeEvent({ datetime: "2026-01-10T18:16:00Z" }), // Saturday
      makeEvent({ datetime: "2026-01-05T10:00:00Z" }), // Monday 10:00 UTC — inside business hours
    ];
    const candidates = offHoursRule(events);
    const flagged = candidates.map((c) => c.eventIndex).sort();
    expect(flagged).toEqual([0, 1]);
    expect(candidates.every((c) => c.confidence === 50)).toBe(true);
  });
});

describe("rareUserAgentRule (unit)", () => {
  it("flags a known scripted signature with confidence 60 and a rare-but-unknown UA with confidence 50", () => {
    const events: LogEvent[] = [];
    for (let i = 0; i < 200; i++) {
      events.push(makeEvent({ useragent: "Mozilla/5.0 common browser" }));
    }
    events.push(makeEvent({ useragent: "curl/8.4.0" }));
    events.push(makeEvent({ useragent: "SomeUnknownRareThing/1.0" }));

    const candidates = rareUserAgentRule(events);
    const curlCandidate = candidates.find((c) => c.eventIndex === 200)!;
    const rareCandidate = candidates.find((c) => c.eventIndex === 201)!;
    expect(curlCandidate.confidence).toBe(60);
    expect(rareCandidate.confidence).toBe(50);
    // The common UA (200 occurrences, way above 1%) must never be flagged.
    expect(candidates.some((c) => c.eventIndex < 200)).toBe(false);
  });

  it("flags an empty user-agent as a known signature", () => {
    const events: LogEvent[] = [];
    for (let i = 0; i < 150; i++) events.push(makeEvent({ useragent: "Mozilla/5.0 common browser" }));
    events.push(makeEvent({ useragent: "" }));
    const candidates = rareUserAgentRule(events);
    expect(candidates).toHaveLength(1);
    expect(candidates[0].confidence).toBe(60);
  });
});

describe("repeatedBlockedRule (unit)", () => {
  it("flags 6 blocked events for the same login within 10 minutes", () => {
    const events: LogEvent[] = [];
    for (let i = 0; i < 6; i++) {
      events.push(
        makeEvent({
          login: "catalina50",
          cip: "10.9.29.141",
          action: "blocked",
          respcode: 403,
          datetime: isoPlusSeconds("2026-01-12T15:39:04Z", i * 80),
        }),
      );
    }
    const candidates = repeatedBlockedRule(events);
    expect(candidates).toHaveLength(6);
    expect(candidates.every((c) => c.confidence >= 55)).toBe(true);
  });

  it("does not flag 4 blocked events (below the floor of 5)", () => {
    const events: LogEvent[] = [];
    for (let i = 0; i < 4; i++) {
      events.push(makeEvent({ login: "x", action: "blocked", datetime: isoPlusSeconds("2026-01-12T15:39:04Z", i * 80) }));
    }
    expect(repeatedBlockedRule(events)).toEqual([]);
  });
});

describe("threatNameRule (unit)", () => {
  it("flags a populated threatname with fixed confidence 95, independent of urlcat", () => {
    const events: LogEvent[] = [
      makeEvent({ threatname: "Win32.Trojan.Generic", urlcat: "Business" }),
      makeEvent({ threatname: null }),
    ];
    const candidates = threatNameRule(events);
    expect(candidates).toHaveLength(1);
    expect(candidates[0].eventIndex).toBe(0);
    expect(candidates[0].confidence).toBe(95);
  });
});

describe("malwareCategoryRule (unit)", () => {
  it("flags one of the 4 high-risk categories with fixed confidence 90, independent of threatname/action", () => {
    const events: LogEvent[] = [
      makeEvent({ urlcat: "Malware Sites", threatname: null, action: "allowed" }),
      makeEvent({ urlcat: "Business" }),
    ];
    const candidates = malwareCategoryRule(events);
    expect(candidates).toHaveLength(1);
    expect(candidates[0].eventIndex).toBe(0);
    expect(candidates[0].confidence).toBe(90);
  });
});

// ---------------------------------------------------------------------------
// Merge policy: max confidence, all reasons listed (DECISIONS.md §3)
// ---------------------------------------------------------------------------

describe("engine — merge policy", () => {
  it("takes the max confidence and lists both reasons when two rules fire on one event", () => {
    // threatname_hit (95) + off_hours (50) on the same event — max confidence
    // wins (95, threatname_hit), but both reasons must appear.
    const events: LogEvent[] = [
      makeEvent({
        threatname: "Emotet.C2",
        datetime: "2026-01-10T02:00:00Z", // Saturday — also off-hours
      }),
    ];
    const anomalies = runRuleEngine(events);
    expect(anomalies).toHaveLength(1);
    const [anomaly] = anomalies;
    expect(anomaly.baseConfidence).toBe(95);
    expect(anomaly.ruleType).toBe("threatname_hit");
    expect(anomaly.triggeredReasons).toHaveLength(2);
    expect(anomaly.triggeredReasons.some((r) => r.includes("threatname"))).toBe(true);
    expect(anomaly.triggeredReasons.some((r) => r.includes("business-hours"))).toBe(true);
    expect(anomaly.llmAdjustedConfidence).toBeNull();
    expect(anomaly.llmExplanation).toBeNull();
  });

  it("produces exactly one Anomaly per flagged event, ranked by confidence descending", () => {
    const events: LogEvent[] = [
      makeEvent({ urlcat: "Malware Sites" }), // 90
      makeEvent({ threatname: "Win32.Trojan.Generic" }), // 95
      makeEvent({ datetime: "2026-01-10T02:00:00Z" }), // off-hours, 50
    ];
    const anomalies = runRuleEngine(events);
    expect(anomalies).toHaveLength(3);
    expect(anomalies.map((a) => a.baseConfidence)).toEqual([95, 90, 50]);
    expect(anomalies.map((a) => a.rank)).toEqual([1, 2, 3]);
  });
});
