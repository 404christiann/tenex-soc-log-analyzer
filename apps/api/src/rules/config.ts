/**
 * Every threshold/constant used by the deterministic rule engine (Phase 5),
 * in one place, each with a one-line comment explaining the reasoning. This
 * file is the "here's every number and why" artifact — see DECISIONS.md
 * §3 (architecture/philosophy) and §14a (the locked rule table this file
 * implements verbatim; do not change these numbers without updating that
 * table and documenting a strong reason here).
 */

// ---------------------------------------------------------------------------
// Burst-per-IP
// ---------------------------------------------------------------------------

/** Sliding window size for counting requests from one IP (DECISIONS.md §14a). */
export const BURST_WINDOW_MS = 60_000;

/**
 * Absolute floor: never flag a burst below this many requests/60s, even if
 * the file's own per-IP-per-minute p99 is lower (guards against flagging
 * trivial bursts in an unusually quiet dataset — DECISIONS.md §14a).
 */
export const BURST_ABSOLUTE_FLOOR = 15;

/** Percentile of the file's own per-IP-per-minute request-count distribution used as the statistical baseline. */
export const BURST_P99_PERCENTILE = 0.99;

/** Burst confidence floor: the score assigned right at the qualifying threshold (weakest still-flagged burst). */
export const BURST_CONFIDENCE_MIN = 60;

/** Burst confidence ceiling: reached once a window's count is >= 2x the effective threshold. */
export const BURST_CONFIDENCE_MAX = 95;

// ---------------------------------------------------------------------------
// Exfil (bytes_out z-score)
// ---------------------------------------------------------------------------

/**
 * Minimum POST/PUT sample size before the statistical exfil rule is allowed
 * to run at all — below this, mean/stddev are too noisy to trust, so we skip
 * the rule entirely rather than risk a false flag on a thin sample
 * (DECISIONS.md §14a: "too few samples = skip, not false-flag").
 */
export const EXFIL_MIN_SAMPLES = 30;

/** z-score threshold on POST/PUT bytes_out above which an event is flagged as a possible exfil outlier. */
export const EXFIL_Z_THRESHOLD = 3;

/** z-score at/above which exfil confidence saturates at its ceiling (DECISIONS.md §14a: "z>=6 -> ~95"). */
export const EXFIL_Z_HIGH = 6;

/** Confidence assigned right at z == EXFIL_Z_THRESHOLD (DECISIONS.md §14a: "z=3 -> ~65"). */
export const EXFIL_CONFIDENCE_AT_THRESHOLD = 65;

/** Confidence assigned at/above EXFIL_Z_HIGH (DECISIONS.md §14a: "z>=6 -> ~95"). */
export const EXFIL_CONFIDENCE_AT_HIGH = 95;

// ---------------------------------------------------------------------------
// Off-hours
// ---------------------------------------------------------------------------

/** Business hours start, UTC (DECISIONS.md §14a: fixed synthetic-org hours). */
export const BUSINESS_START_UTC_HOUR = 8;

/** Business hours end, UTC (exclusive — 18:00 itself is already off-hours). */
export const BUSINESS_END_UTC_HOUR = 18;

/** Fixed confidence for an off-hours access — suggestive on its own, not conclusive (DECISIONS.md §14a: "~50"). */
export const OFF_HOURS_CONFIDENCE = 50;

// ---------------------------------------------------------------------------
// Rare / scripted user-agent
// ---------------------------------------------------------------------------

/**
 * Known scripted/tooling UA signatures, matched case-insensitively as a
 * substring of the full useragent string (e.g. "curl/8.4.0" matches "curl").
 * An empty useragent string is checked separately, not via this list.
 */
export const KNOWN_SCRIPTED_UA_SIGNATURES = ["curl", "python-requests", "wget"];

/** Confidence for a direct known-signature match (DECISIONS.md §14a: "~60"). */
export const KNOWN_SCRIPTED_UA_CONFIDENCE = 60;

/** Below this fraction of the file, a useragent is considered statistically rare (DECISIONS.md §14a: "<1%"). */
export const RARE_UA_FRACTION_THRESHOLD = 0.01;

/** Confidence for statistical rarity with no known-script match (DECISIONS.md §14a: "~50"). */
export const RARE_UA_STATISTICAL_CONFIDENCE = 50;

// ---------------------------------------------------------------------------
// Repeated-blocked
// ---------------------------------------------------------------------------

/** Sliding window size for counting blocked events from the same user/IP (DECISIONS.md §14a). */
export const REPEATED_BLOCKED_WINDOW_MS = 10 * 60_000;

/** Minimum blocked-event count within the window before this rule fires (DECISIONS.md §14a: "≥5"). */
export const REPEATED_BLOCKED_FLOOR = 5;

/** Confidence floor: the score assigned right at REPEATED_BLOCKED_FLOOR (weakest still-flagged cluster). */
export const REPEATED_BLOCKED_CONFIDENCE_MIN = 55;

/** Confidence ceiling, reached once the blocked count reaches 3x the floor (i.e. 15 blocked events in 10 min). */
export const REPEATED_BLOCKED_CONFIDENCE_MAX = 95;

// ---------------------------------------------------------------------------
// Direct signals
// ---------------------------------------------------------------------------

/** threatname populated: a confirmed-bad direct signal, not inferred, so it gets a fixed high confidence (DECISIONS.md §14a: "fixed 95"). */
export const THREATNAME_CONFIDENCE = 95;

/** Access to one of the 4 high-risk url categories: also a confirmed-bad direct signal (DECISIONS.md §14a: "fixed 90"). */
export const MALWARE_CATEGORY_CONFIDENCE = 90;
