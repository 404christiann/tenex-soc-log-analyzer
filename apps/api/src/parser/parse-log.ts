import { LogEventSchema, type LogEvent } from "@tenex/shared";

/**
 * Log parser — Phase 4 (DECISIONS.md §14a wire-format rules).
 *
 * Wire format: one event per line, tab-separated `key=value` tokens, NSS-style
 * field names (`datetime=`, `cip=`, ...). Parsing algorithm, locked in §14a:
 * split each line on tabs FIRST, then split each resulting token on the FIRST
 * `=` only — this keeps a `url=` value containing `=` (e.g. a query string)
 * intact, since the tab (not the equals sign) is the true field delimiter.
 *
 * Explicitly NOT this module's job (§14a, §9): magic-byte/content sniffing
 * (binary signatures, null-byte rejection) happens one layer up, in the API,
 * before a buffer ever reaches this parser. This module only owns the
 * tab/key=value → LogEvent transform and its own file-shape sanity check.
 */

export interface ParseError {
  lineNumber: number;
  reason: string;
  rawSnippet: string;
}

export interface ParseResult {
  events: LogEvent[];
  errors: ParseError[];
  /** Count of blank/whitespace-only lines — skipped silently, not an error. */
  skippedCount: number;
  /**
   * Set instead of populating `events`/`errors` when the successfully-parsed
   * ratio is absurdly low — the file doesn't look like the expected format
   * at all, so we don't bother reporting hundreds of individual line errors
   * (DECISIONS.md §14a).
   */
  fileLevelError?: string;
}

const RAW_SNIPPET_MAX_LEN = 200;

/** Below this fraction of successfully-parsed non-blank lines, treat the
 * whole file as not-the-expected-format rather than line-by-line garbage. */
const MIN_VALID_RATIO = 0.1;

/** The three wire fields that are numeric in the schema — the raw token
 * value is always a string, so these need an explicit `Number(...)`
 * conversion before `LogEventSchema.safeParse` (Zod v4 does not coerce
 * string "200" into number 200 for a plain `z.number()`). */
const NUMERIC_FIELDS = new Set<string>(["respcode", "bytes_out", "bytes_in"]);

function truncateSnippet(s: string): string {
  return s.length > RAW_SNIPPET_MAX_LEN ? `${s.slice(0, RAW_SNIPPET_MAX_LEN)}…` : s;
}

/**
 * Split a Buffer into per-line Buffers on `\n` (0x0A), at the byte level —
 * i.e. before any UTF-8 decoding is attempted. This is what lets a single
 * line with invalid UTF-8 bytes be caught and reported as one line-level
 * error instead of either corrupting the whole file (naive
 * `buffer.toString("utf-8")` silently replaces bad bytes with U+FFFD) or
 * throwing and aborting the entire parse.
 */
function splitBufferIntoLines(buf: Buffer): Buffer[] {
  const lines: Buffer[] = [];
  let start = 0;
  for (let i = 0; i < buf.length; i++) {
    if (buf[i] === 0x0a) {
      lines.push(buf.subarray(start, i));
      start = i + 1;
    }
  }
  if (start < buf.length) {
    lines.push(buf.subarray(start));
  }
  return lines;
}

function stripTrailingCr(s: string): string {
  return s.endsWith("\r") ? s.slice(0, -1) : s;
}

/**
 * Best-effort human-readable preview of a line's raw bytes for an error
 * snippet only (never used for actual field parsing). latin1 maps every
 * byte 1:1 to a code point and can never throw, unlike a UTF-8 decode.
 */
function bufferPreview(buf: Buffer): string {
  return buf.toString("latin1");
}

/**
 * Header/shape sanity check. Exported so the API layer (a later phase) can
 * reuse it as one of the four content-validation checks in DECISIONS.md
 * §14a ("confirm the first line matches the expected NSS-style header
 * shape") — run *before* this parser is even invoked, as a fast rejection
 * for files that are obviously the wrong format. Not called internally by
 * `parseLogFile`; the abort-threshold check below covers that case here.
 */
export function looksLikeExpectedFormat(firstNonBlankLine: string): boolean {
  return firstNonBlankLine.includes("datetime=");
}

interface LineParseOutcome {
  event?: LogEvent;
  error?: ParseError;
}

function parseLine(lineText: string, lineNumber: number): LineParseOutcome {
  const tokens = lineText.split("\t");
  const record: Record<string, unknown> = {};

  for (const token of tokens) {
    const eqIndex = token.indexOf("=");
    if (eqIndex === -1) {
      // A tab-delimited token with no `=` at all means either a stray
      // unescaped tab split a value in two, or an unterminated line ended
      // mid-token — either way this line's field count no longer lines up
      // with the wire format and we can't safely attribute it to a key.
      return {
        error: {
          lineNumber,
          reason: `malformed field with no '=' (likely an unescaped tab inside a value, or a truncated line): "${truncateSnippet(
            token,
          )}"`,
          rawSnippet: truncateSnippet(lineText),
        },
      };
    }

    const key = token.slice(0, eqIndex);
    const rawValue = token.slice(eqIndex + 1);
    let value: unknown = rawValue;

    if (NUMERIC_FIELDS.has(key)) {
      value = Number(rawValue);
    } else if (key === "threatname" && rawValue === "") {
      // The wire format has no literal encoding for `null` — an empty
      // `threatname=` value is the convention for "no threat", which is
      // what the schema's `z.string().nullable()` expects to represent it.
      value = null;
    }

    record[key] = value;
  }

  const result = LogEventSchema.safeParse(record);
  if (!result.success) {
    const reason = result.error.issues
      .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("; ");
    return {
      error: {
        lineNumber,
        reason: `schema validation failed — ${reason}`,
        rawSnippet: truncateSnippet(lineText),
      },
    };
  }

  return { event: result.data };
}

/**
 * Parses raw log file bytes (the tab-separated `key=value` wire format) into
 * events + per-line errors. Never throws — a single bad line becomes a
 * `ParseError`, not an aborted file (unless the file-level abort threshold
 * fires, see `fileLevelError`).
 *
 * Takes a `Buffer`, not a decoded string, so invalid UTF-8 can be detected
 * and attributed to a specific line rather than corrupting the whole read.
 */
export function parseLogFile(buffer: Buffer): ParseResult {
  const events: LogEvent[] = [];
  const errors: ParseError[] = [];
  let skippedCount = 0;
  let nonBlankCount = 0;

  const rawLines = splitBufferIntoLines(buffer);
  // `fatal: true` makes decode() throw on invalid UTF-8 instead of silently
  // substituting U+FFFD replacement characters, which would otherwise pass
  // bad bytes straight through as corrupted-but-"successful" text.
  const decoder = new TextDecoder("utf-8", { fatal: true });

  for (let i = 0; i < rawLines.length; i++) {
    const lineNumber = i + 1;
    const lineBuf = rawLines[i];

    if (lineBuf.length === 0) {
      skippedCount++;
      continue;
    }

    let lineText: string;
    try {
      lineText = stripTrailingCr(decoder.decode(lineBuf));
    } catch {
      nonBlankCount++;
      errors.push({
        lineNumber,
        reason: "invalid UTF-8 byte sequence",
        rawSnippet: truncateSnippet(bufferPreview(lineBuf)),
      });
      continue;
    }

    if (lineText.trim().length === 0) {
      skippedCount++;
      continue;
    }

    nonBlankCount++;
    const outcome = parseLine(lineText, lineNumber);
    if (outcome.event) {
      events.push(outcome.event);
    } else if (outcome.error) {
      errors.push(outcome.error);
    }
  }

  if (nonBlankCount > 0 && events.length / nonBlankCount < MIN_VALID_RATIO) {
    const pct = ((events.length / nonBlankCount) * 100).toFixed(1);
    return {
      events: [],
      errors: [],
      skippedCount,
      fileLevelError:
        `Only ${events.length}/${nonBlankCount} (${pct}%) of non-blank lines parsed successfully — ` +
        "this file does not look like the expected tab-separated key=value log format.",
    };
  }

  return { events, errors, skippedCount };
}
