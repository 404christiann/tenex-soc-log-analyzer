/**
 * Wire format helpers — tab-separated `key=value`, NSS-style field names,
 * locked in DECISIONS.md §14a. Field order is fixed so every well-formed
 * line looks identical in shape; that consistency is what lets
 * `malformed-edge-cases.log` demonstrate a truly *missing* key (absent from
 * the line) as distinct from a key that's *present but empty*.
 */
import type { LogEvent } from "@tenex/shared";

/** Fixed key order for every serialized line — matches DECISIONS.md §14a exactly. */
export const FIELD_ORDER = [
  "datetime",
  "cip",
  "login",
  "url",
  "action",
  "urlcat",
  "threatname",
  "respcode",
  "bytes_out",
  "bytes_in",
  "useragent",
  "reqmethod",
] as const;

/** Internal generator representation. `datetime` stays a `Date` until serialization. */
export interface GenEvent {
  datetime: Date;
  cip: string;
  login: string;
  url: string;
  action: LogEvent["action"];
  urlcat: LogEvent["urlcat"];
  threatname: string | null;
  respcode: number;
  bytes_out: number;
  bytes_in: number;
  useragent: string;
  reqmethod: LogEvent["reqmethod"];
}

/** ISO 8601, truncated to whole seconds with a trailing `Z` — matches the DECISIONS.md example shape. */
export function formatDatetime(d: Date): string {
  return d.toISOString().replace(/\.\d{3}Z$/, "Z");
}

/** Serializes one `GenEvent` into a single well-formed wire-format line (no trailing newline). */
export function serializeEvent(event: GenEvent): string {
  const values: Record<(typeof FIELD_ORDER)[number], string> = {
    datetime: formatDatetime(event.datetime),
    cip: event.cip,
    login: event.login,
    url: event.url,
    action: event.action,
    urlcat: event.urlcat,
    threatname: event.threatname ?? "",
    respcode: String(event.respcode),
    bytes_out: String(event.bytes_out),
    bytes_in: String(event.bytes_in),
    useragent: event.useragent,
    reqmethod: event.reqmethod,
  };
  return FIELD_ORDER.map((key) => `${key}=${values[key]}`).join("\t");
}
