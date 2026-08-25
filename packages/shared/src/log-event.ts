import { z } from "zod";

/**
 * The 12 fields captured per DECISIONS.md §2, using the exact NSS-style wire
 * field names locked in §14a (`datetime=`, `cip=`, `login=`, ...). The parser
 * (a later phase) is responsible for turning a raw tab-separated log line
 * into this shape.
 */

export const LogActionSchema = z.enum(["allowed", "blocked"]);
export type LogAction = z.infer<typeof LogActionSchema>;

export const HttpMethodSchema = z.enum([
  "GET",
  "POST",
  "PUT",
  "DELETE",
  "HEAD",
  "OPTIONS",
  "PATCH",
  "CONNECT",
  "TRACE",
]);
export type HttpMethod = z.infer<typeof HttpMethodSchema>;

/**
 * Locked 12-category `urlcat` taxonomy per DECISIONS.md §14a: 8 benign
 * categories, 4 high-risk categories (drive the malware-category rule), and
 * an `Uncategorized` fallback.
 */
export const UrlCategorySchema = z.enum([
  // Benign
  "Business",
  "Social Networking",
  "Streaming Media",
  "News & Media",
  "Technology",
  "Shopping",
  "Webmail",
  "File Sharing",
  // High-risk
  "Malware Sites",
  "Phishing",
  "Botnet Callback",
  "Spyware or Adware",
  // Fallback
  "Uncategorized",
]);
export type UrlCategory = z.infer<typeof UrlCategorySchema>;

/** The 4 high-risk categories that drive the malware-category rule (DECISIONS.md §14a rule table). */
export const HIGH_RISK_URL_CATEGORIES = [
  "Malware Sites",
  "Phishing",
  "Botnet Callback",
  "Spyware or Adware",
] as const satisfies readonly UrlCategory[];

export const LogEventSchema = z.object({
  /**
   * ISO 8601 timestamp. Wire field `datetime=`. Validated (not just
   * `z.string()`) so a garbled/unparseable value fails parsing here instead
   * of silently becoming `NaN` later when rule modules do
   * `new Date(e.datetime).getTime()`. The generator (scripts/generate-logs/
   * wire-format.ts `formatDatetime`) always emits whole-second, `Z`-suffixed
   * timestamps (e.g. `2026-01-01T09:00:00Z`), which this format accepts.
   */
  datetime: z.iso.datetime(),
  /** Client IP — actor identity for per-IP rate anomalies. Wire field `cip=`. */
  cip: z.string(),
  /**
   * Authenticated user/login. Named `login` (not `user`) to match the NSS
   * wire field; the DB column is further renamed to `log_user` to avoid
   * clashing with Postgres/Supabase Auth's `user` semantics (DECISIONS.md §8).
   */
  login: z.string(),
  /** Requested URL/domain. Wire field `url=`. */
  url: z.string(),
  /** Outcome of the request. Wire field `action=`. */
  action: LogActionSchema,
  /** Category of `url`. Wire field `urlcat=`. */
  urlcat: UrlCategorySchema,
  /** Direct threat signal when populated; nullable. Wire field `threatname=`. */
  threatname: z.string().nullable(),
  /** HTTP response status code. Wire field `respcode=`. */
  respcode: z.number().int(),
  /** Bytes sent by the client — exfiltration signal. Wire field `bytes_out=`. */
  bytes_out: z.number().int().nonnegative(),
  /** Bytes received by the client. Wire field `bytes_in=`. */
  bytes_in: z.number().int().nonnegative(),
  /** Client user agent — bot/script/recon detection. Wire field `useragent=`. */
  useragent: z.string(),
  /** HTTP method. Wire field `reqmethod=`. */
  reqmethod: HttpMethodSchema,
});
export type LogEvent = z.infer<typeof LogEventSchema>;
