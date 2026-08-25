import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { looksLikeExpectedFormat, parseLogFile } from "./parse-log";

const EXAMPLES_DIR = path.resolve(__dirname, "../../../../examples");

function readExample(filename: string): Buffer {
  return fs.readFileSync(path.join(EXAMPLES_DIR, filename));
}

describe("parseLogFile — clean example files", () => {
  it("parses normal-traffic.log with zero errors and the documented row count", () => {
    const result = parseLogFile(readExample("normal-traffic.log"));
    expect(result.fileLevelError).toBeUndefined();
    expect(result.errors).toEqual([]);
    expect(result.events).toHaveLength(2414);
  });

  it("parses quick-demo.log with zero errors and the documented row count", () => {
    const result = parseLogFile(readExample("quick-demo.log"));
    expect(result.fileLevelError).toBeUndefined();
    expect(result.errors).toEqual([]);
    expect(result.events).toHaveLength(169);
  });

  it("parses clean-traffic.log with zero errors and the documented row count", () => {
    const result = parseLogFile(readExample("clean-traffic.log"));
    expect(result.fileLevelError).toBeUndefined();
    expect(result.errors).toEqual([]);
    expect(result.events).toHaveLength(300);
  });
});

describe("parseLogFile — malformed-edge-cases.log", () => {
  // Ground truth per examples/README.md: 51 total lines = 29 valid + 2 blank
  // + 20 deliberately malformed (5 truncated, 5 missing-key, 5 invalid-UTF-8,
  // 5 unescaped-tab-in-value).
  //
  // The parser actually recovers 30 events / 19 errors, not 29/20. This is a
  // real, understood mismatch, not a bug: one of the 5 "unescaped tab"
  // lines (line 40) inserts a tab whose *second* half happens to itself
  // contain a `=` (`...url=https://<TAB>?a=1walmart.com/...`). Per the
  // locked algorithm (DECISIONS.md §14a — split on tabs first, then each
  // token on the first `=`), that second half parses as an extra,
  // unrecognized `?a=...` field, which Zod silently drops, while the `url`
  // field itself is left holding just `"https://"` — a corrupted-but
  // schema-valid string. Every other malformed line either produces a
  // tab-split token with no `=` at all, or a schema-required field that's
  // entirely absent, so it reliably surfaces as an error. This one specific
  // shape is the one case the algorithm as specified cannot distinguish
  // from a legitimate line — expected, not a defect, given the spec locks
  // "tab is the true delimiter, not the equals sign".
  // Within the 5 nominally "truncated" lines, 4 of them (4, 6, 10, 12) are
  // cut off partway through a token that already contains its `=`, so the
  // built record is simply missing later required fields — a schema
  // validation failure. Line 8 is cut off mid-*keyname*, before any `=` was
  // ever written (the last tab-delimited token is just the bare letter
  // "u"), so it lands in the same "token with no '='" bucket as the caught
  // unescaped-tab lines instead — a real, byte-level-truncation-point
  // distinction, not a miscategorization.
  const SCHEMA_FAILURE_LINES = [4, 6, 10, 12, ...[14, 16, 18, 20, 22]]; // truncated (minus 8) + missing-key
  const NO_EQUALS_LINES = [8, 34, 36, 38, 42]; // line 8's truncation point + 4 of the 5 unescaped-tab lines
  const INVALID_UTF8_LINES = [24, 26, 28, 30, 32];

  it("recovers valid events and does not throw or abort", () => {
    expect(() => parseLogFile(readExample("malformed-edge-cases.log"))).not.toThrow();
    const result = parseLogFile(readExample("malformed-edge-cases.log"));
    expect(result.fileLevelError).toBeUndefined();
  });

  it("skips the 2 blank lines silently, without counting them as errors", () => {
    const result = parseLogFile(readExample("malformed-edge-cases.log"));
    expect(result.skippedCount).toBe(2);
  });

  it("reports one error for every malformed line except the one the locked algorithm cannot catch (line 40)", () => {
    const result = parseLogFile(readExample("malformed-edge-cases.log"));
    const erroredLines = result.errors.map((e) => e.lineNumber).sort((a, b) => a - b);
    const expectedErrorLines = [...SCHEMA_FAILURE_LINES, ...NO_EQUALS_LINES, ...INVALID_UTF8_LINES].sort(
      (a, b) => a - b,
    );
    expect(erroredLines).toEqual(expectedErrorLines);
    expect(result.errors).toHaveLength(19);
  });

  it("recovers 30 valid events: the 29 clean lines plus the one line (40) whose corruption survives schema validation", () => {
    const result = parseLogFile(readExample("malformed-edge-cases.log"));
    expect(result.events).toHaveLength(30);
  });

  it("categorizes the invalid-UTF-8 lines by reason", () => {
    const result = parseLogFile(readExample("malformed-edge-cases.log"));
    const invalidUtf8Errors = result.errors.filter((e) => INVALID_UTF8_LINES.includes(e.lineNumber));
    expect(invalidUtf8Errors).toHaveLength(5);
    for (const err of invalidUtf8Errors) {
      expect(err.reason).toContain("invalid UTF-8");
    }
  });

  it("categorizes the 'token with no =' lines (4 caught unescaped-tab lines + line 8's mid-keyname truncation) by reason", () => {
    const result = parseLogFile(readExample("malformed-edge-cases.log"));
    const noEqualsErrors = result.errors.filter((e) => NO_EQUALS_LINES.includes(e.lineNumber));
    expect(noEqualsErrors).toHaveLength(5);
    for (const err of noEqualsErrors) {
      expect(err.reason).toContain("no '='");
    }
  });

  it("categorizes the remaining truncated/missing-key lines as schema validation failures", () => {
    const result = parseLogFile(readExample("malformed-edge-cases.log"));
    const structuralErrors = result.errors.filter((e) => SCHEMA_FAILURE_LINES.includes(e.lineNumber));
    expect(structuralErrors).toHaveLength(9);
    for (const err of structuralErrors) {
      expect(err.reason).toContain("schema validation failed");
    }
  });

  it("truncates rawSnippet to a reasonable length", () => {
    const result = parseLogFile(readExample("malformed-edge-cases.log"));
    for (const err of result.errors) {
      expect(err.rawSnippet.length).toBeLessThanOrEqual(201); // 200 + ellipsis char
    }
  });
});

describe("parseLogFile — unit tests", () => {
  it("preserves an '=' inside a url value's query string (tab is the true delimiter, not '=')", () => {
    const line =
      "datetime=2026-01-01T09:00:00Z\tcip=10.0.0.1\tlogin=jdoe\turl=https://x.com?a=1&b=2\taction=allowed\turlcat=Business\tthreatname=\trespcode=200\tbytes_out=100\tbytes_in=200\tuseragent=Mozilla/5.0\treqmethod=GET\n";
    const result = parseLogFile(Buffer.from(line, "utf-8"));
    expect(result.errors).toEqual([]);
    expect(result.events).toHaveLength(1);
    expect(result.events[0]?.url).toBe("https://x.com?a=1&b=2");
  });

  it("skips blank and whitespace-only lines without counting them as errors", () => {
    // Trailing "\n" after the last real line intentionally produces no extra
    // line (an empty tail after a final newline isn't a distinct line) —
    // so this is 2 blank lines ("" and "   "), not 3.
    const text = [
      "datetime=2026-01-01T09:00:00Z\tcip=10.0.0.1\tlogin=jdoe\turl=https://x.com\taction=allowed\turlcat=Business\tthreatname=\trespcode=200\tbytes_out=100\tbytes_in=200\tuseragent=Mozilla/5.0\treqmethod=GET",
      "",
      "   ",
      "datetime=2026-01-01T09:00:17Z\tcip=10.0.0.1\tlogin=jdoe\turl=https://x.com/2\taction=allowed\turlcat=Business\tthreatname=\trespcode=200\tbytes_out=100\tbytes_in=200\tuseragent=Mozilla/5.0\treqmethod=GET",
      "",
    ].join("\n");
    const result = parseLogFile(Buffer.from(text, "utf-8"));
    expect(result.errors).toEqual([]);
    expect(result.events).toHaveLength(2);
    expect(result.skippedCount).toBe(2);
  });

  it("converts an empty threatname= value to null (nullable schema field)", () => {
    const line =
      "datetime=2026-01-01T09:00:00Z\tcip=10.0.0.1\tlogin=jdoe\turl=https://x.com\taction=allowed\turlcat=Business\tthreatname=\trespcode=200\tbytes_out=100\tbytes_in=200\tuseragent=Mozilla/5.0\treqmethod=GET\n";
    const result = parseLogFile(Buffer.from(line, "utf-8"));
    expect(result.events[0]?.threatname).toBeNull();
  });

  it("captures a populated threatname value", () => {
    const line =
      "datetime=2026-01-01T09:00:00Z\tcip=10.0.0.1\tlogin=jdoe\turl=https://x.com\taction=allowed\turlcat=Malware Sites\tthreatname=Win32.Trojan.Generic\trespcode=200\tbytes_out=100\tbytes_in=200\tuseragent=Mozilla/5.0\treqmethod=GET\n";
    const result = parseLogFile(Buffer.from(line, "utf-8"));
    expect(result.events[0]?.threatname).toBe("Win32.Trojan.Generic");
  });

  it("reports a ParseError (not silently 0) for an empty numeric field value", () => {
    // Number("") is 0 in JS — without the NaN guard, this would silently
    // parse as a valid bytes_out=0 instead of failing validation.
    // Padded with enough good lines that the bad line doesn't itself trip
    // the file-level abort threshold.
    const goodLine =
      "datetime=2026-01-01T09:00:00Z\tcip=10.0.0.1\tlogin=jdoe\turl=https://x.com\taction=allowed\turlcat=Business\tthreatname=\trespcode=200\tbytes_out=100\tbytes_in=200\tuseragent=Mozilla/5.0\treqmethod=GET";
    const badLine =
      "datetime=2026-01-01T09:00:17Z\tcip=10.0.0.1\tlogin=jdoe\turl=https://x.com\taction=allowed\turlcat=Business\tthreatname=\trespcode=200\tbytes_out=\tbytes_in=200\tuseragent=Mozilla/5.0\treqmethod=GET";
    const text = [goodLine, goodLine, goodLine, goodLine, goodLine, goodLine, goodLine, goodLine, goodLine, badLine].join(
      "\n",
    );
    const result = parseLogFile(Buffer.from(text, "utf-8"));
    expect(result.fileLevelError).toBeUndefined();
    expect(result.events).toHaveLength(9);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.lineNumber).toBe(10);
    expect(result.errors[0]?.reason).toContain("schema validation failed");
    expect(result.errors[0]?.reason).toContain("bytes_out");
  });

  it("reports a ParseError (not a throw) for a line missing a required field", () => {
    // Paired with enough valid lines that the bad line doesn't itself trip
    // the file-level abort threshold (which is exercised separately below).
    const goodLine =
      "datetime=2026-01-01T09:00:00Z\tcip=10.0.0.1\tlogin=jdoe\turl=https://x.com\taction=allowed\turlcat=Business\tthreatname=\trespcode=200\tbytes_out=100\tbytes_in=200\tuseragent=Mozilla/5.0\treqmethod=GET";
    const badLine = "datetime=2026-01-01T09:00:17Z\tcip=10.0.0.1\tlogin=jdoe";
    const text = [goodLine, goodLine, goodLine, goodLine, goodLine, goodLine, goodLine, goodLine, goodLine, badLine].join(
      "\n",
    );
    const result = parseLogFile(Buffer.from(text, "utf-8"));
    expect(result.fileLevelError).toBeUndefined();
    expect(result.events).toHaveLength(9);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.lineNumber).toBe(10);
    expect(result.errors[0]?.reason).toContain("schema validation failed");
  });

  it("does not throw and does not abort the file when one bad line is interspersed with good ones", () => {
    const text = [
      "datetime=2026-01-01T09:00:00Z\tcip=10.0.0.1\tlogin=jdoe\turl=https://x.com\taction=allowed\turlcat=Business\tthreatname=\trespcode=200\tbytes_out=100\tbytes_in=200\tuseragent=Mozilla/5.0\treqmethod=GET",
      "totally not a valid line",
      "datetime=2026-01-01T09:00:17Z\tcip=10.0.0.1\tlogin=jdoe\turl=https://x.com/2\taction=allowed\turlcat=Business\tthreatname=\trespcode=200\tbytes_out=100\tbytes_in=200\tuseragent=Mozilla/5.0\treqmethod=GET",
    ].join("\n");
    expect(() => parseLogFile(Buffer.from(text, "utf-8"))).not.toThrow();
    const result = parseLogFile(Buffer.from(text, "utf-8"));
    expect(result.events).toHaveLength(2);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.lineNumber).toBe(2);
  });

  it("fires fileLevelError instead of per-line errors when the file is mostly garbage", () => {
    const lines: string[] = [];
    // One valid line among 30 lines of garbage — well under the 10% floor.
    lines.push(
      "datetime=2026-01-01T09:00:00Z\tcip=10.0.0.1\tlogin=jdoe\turl=https://x.com\taction=allowed\turlcat=Business\tthreatname=\trespcode=200\tbytes_out=100\tbytes_in=200\tuseragent=Mozilla/5.0\treqmethod=GET",
    );
    for (let i = 0; i < 30; i++) {
      lines.push(`this is not a log line at all, line ${i}`);
    }
    const result = parseLogFile(Buffer.from(lines.join("\n"), "utf-8"));
    expect(result.fileLevelError).toBeDefined();
    expect(result.fileLevelError).toContain("does not look like the expected");
    expect(result.events).toEqual([]);
    expect(result.errors).toEqual([]);
  });

  it("does not fire fileLevelError when the valid ratio is comfortably above the floor", () => {
    const lines: string[] = [];
    for (let i = 0; i < 9; i++) {
      lines.push(
        `datetime=2026-01-01T09:00:0${i}Z\tcip=10.0.0.1\tlogin=jdoe\turl=https://x.com\taction=allowed\turlcat=Business\tthreatname=\trespcode=200\tbytes_out=100\tbytes_in=200\tuseragent=Mozilla/5.0\treqmethod=GET`,
      );
    }
    lines.push("garbage line");
    const result = parseLogFile(Buffer.from(lines.join("\n"), "utf-8"));
    expect(result.fileLevelError).toBeUndefined();
    expect(result.events).toHaveLength(9);
    expect(result.errors).toHaveLength(1);
  });

  it("detects and reports a line with an invalid UTF-8 byte sequence without throwing", () => {
    const goodLine = Buffer.from(
      "datetime=2026-01-01T09:00:00Z\tcip=10.0.0.1\tlogin=jdoe\turl=https://x.com\taction=allowed\turlcat=Business\tthreatname=\trespcode=200\tbytes_out=100\tbytes_in=200\tuseragent=Mozilla/5.0\treqmethod=GET\n",
      "utf-8",
    );
    // 0xC3 alone (no valid continuation byte) is an invalid UTF-8 sequence.
    const badLine = Buffer.concat([
      Buffer.from("datetime=2026-01-01T09:00:17Z\tcip=10.0.0.1\tlogin=jdoe_", "utf-8"),
      Buffer.from([0xc3]),
      Buffer.from("\n", "utf-8"),
    ]);
    const buf = Buffer.concat([goodLine, badLine]);
    expect(() => parseLogFile(buf)).not.toThrow();
    const result = parseLogFile(buf);
    expect(result.events).toHaveLength(1);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.lineNumber).toBe(2);
    expect(result.errors[0]?.reason).toContain("invalid UTF-8");
  });
});

describe("looksLikeExpectedFormat", () => {
  it("returns true for a line containing datetime=", () => {
    expect(looksLikeExpectedFormat("datetime=2026-01-01T09:00:00Z\tcip=10.0.0.1")).toBe(true);
  });

  it("returns false for a line without datetime=", () => {
    expect(looksLikeExpectedFormat("not,a,log,line")).toBe(false);
    expect(looksLikeExpectedFormat("")).toBe(false);
  });
});
