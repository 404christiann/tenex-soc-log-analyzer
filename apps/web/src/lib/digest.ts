import type { Anomaly } from "@tenex/shared";
import { getSeverity, type Severity } from "@/lib/severity";

/**
 * Executive-digest logic for the Timeline tab (the "digest first" design):
 *
 * - `splitTldr` — separates the model's `**TL;DR:**` lead sentence (a new,
 *   additive instruction in SUMMARY_SYSTEM_PROMPT) from the bullet body so
 *   the UI can render the digest as a hero block and the bullets below it.
 *   Works on partial streamed text too: the TL;DR is the FIRST thing the
 *   model writes, so it streams into the hero slot before any bullet exists.
 * - `buildComputedDigest` — a real deterministic fallback sentence derived
 *   from the anomalies the page already has (same philosophy as
 *   `generateFallbackSummary` on the API side): used whenever there is no
 *   LLM TL;DR to show (not_configured / failed / summaries generated before
 *   the TL;DR instruction existed / model non-compliance). Purely factual —
 *   counts, severities, rule types, and a time window — so it makes no
 *   implicit AI-provenance claim.
 * - severity/window helpers shared by the stat strip.
 *
 * All time formatting here is UTC-derived from the ISO strings themselves
 * (never `Date`-to-local conversion), matching the rest of the app's
 * "timestamps are semantically UTC" stance.
 */

// ---------------------------------------------------------------------------
// TL;DR extraction from (possibly partial) summary markdown
// ---------------------------------------------------------------------------

/** Tolerant match for the prompt's `**TL;DR:**` lead marker (allows `TLDR`, optional colon inside/outside the bold). */
const TLDR_MARKER = /^\s*\*\*TL;?DR:?\*\*:?\s*/i;

/**
 * While streaming, text shorter than this could still be a partial
 * `**TL;DR:**` marker — the split reports `hold: true` and the caller
 * renders nothing yet (a sub-second window at real streaming speed) instead
 * of flashing the raw marker characters into the body.
 */
const TLDR_HOLD_CHARS = 12;

export interface SplitSummary {
  /** The TL;DR sentence's markdown (marker stripped), or `null` when the summary has no TL;DR lead. */
  tldr: string | null;
  /** True while the TL;DR sentence is still streaming in (no line break after it yet). */
  tldrStreaming: boolean;
  /** The remaining summary markdown (the bullets). */
  body: string;
  /** True only mid-stream, while too little text has arrived to tell whether it starts with the marker. */
  hold: boolean;
}

export function splitTldr(markdown: string, complete: boolean): SplitSummary {
  const marker = markdown.match(TLDR_MARKER);
  if (marker) {
    const rest = markdown.slice(marker[0].length);
    // The prompt requires the TL;DR to be a single standalone line — the
    // first line break (of any kind) ends it.
    const lineBreak = rest.search(/\r?\n/);
    if (lineBreak === -1) {
      return { tldr: rest, tldrStreaming: !complete, body: "", hold: false };
    }
    return {
      tldr: rest.slice(0, lineBreak).trimEnd(),
      tldrStreaming: false,
      body: rest.slice(lineBreak).replace(/^\s+/, ""),
      hold: false,
    };
  }
  if (!complete && markdown.trim().length <= TLDR_HOLD_CHARS) {
    return { tldr: null, tldrStreaming: false, body: "", hold: true };
  }
  return { tldr: null, tldrStreaming: false, body: markdown, hold: false };
}

// ---------------------------------------------------------------------------
// Severity + time-window aggregation (stat strip + computed digest)
// ---------------------------------------------------------------------------

/** Same effective-confidence convention as the Anomalies/Events tabs: the judge-adjusted score when present, else the deterministic base score. */
export function anomalySeverity(anomaly: Anomaly): Severity {
  return getSeverity(anomaly.llmAdjustedConfidence ?? anomaly.baseConfidence);
}

export type SeverityCounts = Record<Severity, number>;

export function countBySeverity(anomalies: Anomaly[]): SeverityCounts {
  const counts: SeverityCounts = { high: 0, medium: 0, low: 0 };
  for (const anomaly of anomalies) {
    counts[anomalySeverity(anomaly)] += 1;
  }
  return counts;
}

const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const;

interface UtcParts {
  ms: number;
  monthDay: string;
  /** `YYYY-MM-DD` — for same-day comparison. */
  dayKey: string;
  hhmm: string;
}

/** Parses an ISO datetime into UTC display parts, or `null` when unparseable. */
function toUtcParts(iso: string): UtcParts | null {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return null;
  const utc = new Date(ms).toISOString(); // normalized UTC: YYYY-MM-DDTHH:mm:ss.sssZ
  const month = Number(utc.slice(5, 7));
  const day = Number(utc.slice(8, 10));
  return {
    ms,
    monthDay: `${MONTH_NAMES[month - 1]} ${day}`,
    dayKey: utc.slice(0, 10),
    hhmm: utc.slice(11, 16),
  };
}

export interface AnomalyWindow {
  first: UtcParts;
  last: UtcParts;
  sameDay: boolean;
}

/** Min/max over the anomalies' event datetimes (nulls skipped); `null` when no anomaly carries a timestamp. */
export function getAnomalyWindow(anomalies: Anomaly[]): AnomalyWindow | null {
  let first: UtcParts | null = null;
  let last: UtcParts | null = null;
  for (const anomaly of anomalies) {
    if (!anomaly.eventDatetime) continue;
    const parts = toUtcParts(anomaly.eventDatetime);
    if (!parts) continue;
    if (!first || parts.ms < first.ms) first = parts;
    if (!last || parts.ms > last.ms) last = parts;
  }
  if (!first || !last) return null;
  return { first, last, sameDay: first.dayKey === last.dayKey };
}

/** Compact strip label: `Jan 5, 08:27–10:14 UTC` (same day) or `Jan 5 – Jan 16` (multi-day). */
export function formatWindowLabel(window: AnomalyWindow): string {
  if (window.sameDay) {
    return window.first.hhmm === window.last.hhmm
      ? `${window.first.monthDay}, ${window.first.hhmm} UTC`
      : `${window.first.monthDay}, ${window.first.hhmm}–${window.last.hhmm} UTC`;
  }
  return `${window.first.monthDay} – ${window.last.monthDay}`;
}

/** Prose phrasing of the window for the computed digest sentence. */
function describeWindow(window: AnomalyWindow | null): string | null {
  if (!window) return null;
  if (!window.sameDay) {
    return `spread between ${window.first.monthDay} and ${window.last.monthDay} (UTC)`;
  }
  const minutes = Math.round((window.last.ms - window.first.ms) / 60_000);
  if (minutes < 1) {
    return `at ${window.first.hhmm} UTC on ${window.first.monthDay}`;
  }
  const span =
    minutes < 60
      ? `${minutes}-minute`
      : `${(minutes / 60).toFixed(minutes % 60 === 0 ? 0 : 1)}-hour`;
  return `concentrated in a ${span} window on ${window.first.monthDay} (UTC)`;
}

// ---------------------------------------------------------------------------
// Deterministic computed digest sentence
// ---------------------------------------------------------------------------

/**
 * Rule types worth calling out by name in a five-second digest, in priority
 * order — at most one clause is appended so the sentence stays one breath
 * long. Wording stays appropriately hedged ("possible") because these are
 * heuristic rule hits, not confirmed incidents.
 */
const EXFIL_RULE = "bytes_out_exfil";
const THREAT_RULES = new Set(["threatname_hit", "malware_category"]);
/** DECISIONS.md §15's 8th rule — a distinct C2 signature worth its own callout, same tier as the threat-detection callout below. */
const BEACONING_RULE = "beaconing";

export function buildComputedDigest(anomalies: Anomaly[], eventsTotal: number): string {
  const eventsPhrase = `${eventsTotal.toLocaleString("en-US")} events`;

  if (anomalies.length === 0) {
    return `No anomalies flagged across ${eventsPhrase} — nothing needs immediate attention.`;
  }

  const counts = countBySeverity(anomalies);
  const lead: Severity = counts.high > 0 ? "high" : counts.medium > 0 ? "medium" : "low";
  const leadCount = counts[lead];
  const finding = leadCount === 1 ? "finding" : "findings";
  const severityPart =
    leadCount === anomalies.length
      ? `${leadCount} ${lead}-severity ${finding} across ${eventsPhrase}`
      : `${leadCount} ${lead}-severity ${finding} among ${anomalies.length} anomalies across ${eventsPhrase}`;

  // Highest-signal rule-type callout, considering only the tiers that lead
  // the sentence (a low-severity exfil hint shouldn't headline a digest led
  // by high-severity findings of another kind).
  const notable = anomalies.filter((a) => anomalySeverity(a) === lead);
  let calloutPart: string | null = null;
  if (notable.some((a) => a.ruleType === EXFIL_RULE)) {
    calloutPart = "including possible data exfiltration";
  } else if (notable.some((a) => a.ruleType === BEACONING_RULE)) {
    calloutPart = "including possible C2 beaconing";
  } else {
    const threatCount = notable.filter((a) => THREAT_RULES.has(a.ruleType)).length;
    if (threatCount > 0) {
      calloutPart = threatCount === 1 ? "including a threat detection" : `including ${threatCount} threat detections`;
    }
  }

  const windowPart = describeWindow(getAnomalyWindow(anomalies));

  const tail = [calloutPart, windowPart].filter((part): part is string => part !== null);
  return tail.length === 0 ? `${severityPart}.` : `${severityPart} — ${tail.join(", ")}.`;
}
