/**
 * Builds `examples/malformed-edge-cases.log` — deliberately broken input
 * that proves graceful parser degradation (DECISIONS.md §13, §14a), not
 * total failure. Interspersed with enough well-formed lines that a parser
 * should still produce *some* successfully parsed events.
 *
 * Per DECISIONS.md §14a: "missing field" = a key entirely absent from the
 * line (not present-but-empty); "malformed" = a token with no `=`, an
 * unterminated line, non-UTF-8 bytes, or an unescaped tab inside a value.
 * Every category below is a direct instance of one of those.
 *
 * Returns raw bytes (not a string) because two of the categories require
 * byte sequences that are not valid UTF-8 and cannot be represented as a JS
 * string.
 */
import { faker } from "@faker-js/faker";
import { buildUserPool } from "./users";
import { urlForCategory, randomRealisticUserAgent } from "./content";
import { BENIGN_CATEGORIES } from "./users";
import { FIELD_ORDER, serializeEvent, type GenEvent } from "./wire-format";

const NL = Buffer.from("\n", "utf8");

function line(s: string): Buffer {
  return Buffer.from(s, "utf8");
}

/** A valid line with one entire key=value token removed (the key is absent, not empty). */
function lineMissingKey(event: GenEvent, keyToOmit: (typeof FIELD_ORDER)[number]): string {
  const full = serializeEvent(event);
  const tokens = full.split("\t");
  const kept = tokens.filter((tok) => !tok.startsWith(`${keyToOmit}=`));
  return kept.join("\t");
}

/** Cuts a valid line partway through, landing inside a field value (never exactly on a tab boundary). */
function truncateMidField(event: GenEvent, fraction: number): string {
  const full = serializeEvent(event);
  let cut = Math.floor(full.length * fraction);
  if (full[cut] === "\t") cut += 1;
  return full.slice(0, cut);
}

/** Splices raw (possibly invalid-UTF-8) bytes into the middle of one field's value. */
function injectBadBytes(event: GenEvent, targetKey: string, badBytes: number[]): Buffer {
  const full = serializeEvent(event);
  const keyPrefix = `${targetKey}=`;
  const start = full.indexOf(keyPrefix) + keyPrefix.length;
  // Land the corruption a few characters into the value so it's visibly "inside" the field, not at its edge.
  const insertAt = Math.min(start + 3, full.length);
  const before = full.slice(0, insertAt);
  const after = full.slice(insertAt);
  return Buffer.concat([line(before), Buffer.from(badBytes), line(after)]);
}

/** A valid line with a real tab character spliced into the middle of a value (breaks the tab-delimiter assumption). */
function lineWithUnescapedTabInValue(event: GenEvent, targetKey: string, insertion: string): string {
  const full = serializeEvent(event);
  const keyPrefix = `${targetKey}=`;
  const start = full.indexOf(keyPrefix) + keyPrefix.length;
  const insertAt = Math.min(start + 8, full.length);
  return full.slice(0, insertAt) + "\t" + insertion + full.slice(insertAt);
}

function makeValidEvent(login: string, cip: string, offsetSeconds: number): GenEvent {
  const category = faker.helpers.arrayElement(BENIGN_CATEGORIES);
  return {
    datetime: new Date(Date.UTC(2026, 3, 6, 9, 0, 0) + offsetSeconds * 1000), // 2026-04-06 (Monday), 09:00 UTC onward
    cip,
    login,
    url: urlForCategory(category),
    action: "allowed",
    urlcat: category,
    threatname: null,
    respcode: 200,
    bytes_out: faker.number.int({ min: 100, max: 2000 }),
    bytes_in: faker.number.int({ min: 500, max: 20_000 }),
    useragent: randomRealisticUserAgent(),
    reqmethod: "GET",
  };
}

export function buildMalformedFileBuffer(): { buffer: Buffer; validLineCount: number; malformedLineCount: number } {
  const users = buildUserPool(6);
  let t = 0;
  const nextEvent = () => makeValidEvent(faker.helpers.arrayElement(users).login, faker.helpers.arrayElement(users).cip, t++ * 17);

  const buffers: Buffer[] = [];
  let validLineCount = 0;
  let malformedLineCount = 0;

  const addValid = () => {
    buffers.push(line(serializeEvent(nextEvent())));
    validLineCount++;
  };
  const addMalformedString = (s: string) => {
    buffers.push(line(s));
    malformedLineCount++;
  };
  const addMalformedBuffer = (b: Buffer) => {
    buffers.push(b);
    malformedLineCount++;
  };

  // A few valid lines up front so a parser has something to succeed on immediately.
  addValid();
  addValid();
  addValid();

  // --- Category 1: truncated mid-field / unterminated line (5) ---
  for (const fraction of [0.25, 0.4, 0.55, 0.7, 0.85]) {
    addMalformedString(truncateMidField(nextEvent(), fraction));
    addValid();
  }

  // --- Category 2: missing key entirely (5) ---
  const keysToOmit: (typeof FIELD_ORDER)[number][] = ["respcode", "threatname", "useragent", "urlcat", "bytes_in"];
  for (const key of keysToOmit) {
    addMalformedString(lineMissingKey(nextEvent(), key));
    addValid();
  }

  // --- Category 3: non-UTF-8 byte sequences inserted (5) ---
  const badByteVariants: { key: string; bytes: number[]; note: string }[] = [
    { key: "login", bytes: [0xff], note: "0xFF is never valid in UTF-8" },
    { key: "useragent", bytes: [0xfe], note: "0xFE is never valid in UTF-8" },
    { key: "url", bytes: [0x80], note: "lone continuation byte with no lead byte" },
    { key: "cip", bytes: [0xc0, 0xaf], note: "overlong encoding, rejected by strict UTF-8 decoders" },
    { key: "login", bytes: [0xed, 0xa0, 0x80], note: "UTF-16 surrogate encoded in UTF-8, invalid per RFC 3629" },
  ];
  for (const variant of badByteVariants) {
    addMalformedBuffer(injectBadBytes(nextEvent(), variant.key, variant.bytes));
    addValid();
  }

  // --- Category 4: unescaped tab inside a value (5) ---
  const tabInsertions: { key: string; insertion: string }[] = [
    { key: "url", insertion: "extra-fragment-after-tab" },
    { key: "login", insertion: "trailingname" },
    { key: "useragent", insertion: "SuspiciousExtraToken/1.0" },
    { key: "url", insertion: "?a=1" },
    { key: "login", insertion: "x" },
  ];
  for (const variant of tabInsertions) {
    addMalformedString(lineWithUnescapedTabInValue(nextEvent(), variant.key, variant.insertion));
    addValid();
  }

  // --- Blank / whitespace-only lines (2) — common real-world log noise, cheap to handle gracefully. ---
  addMalformedString("");
  addMalformedString("   ");

  // A closing run of valid lines.
  addValid();
  addValid();
  addValid();
  addValid();
  addValid();
  addValid();

  const buffer = Buffer.concat(buffers.flatMap((b) => [b, NL]));

  return { buffer, validLineCount, malformedLineCount };
}
