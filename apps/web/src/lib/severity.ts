/**
 * Severity banding for anomaly confidence scores.
 *
 * The tier boundaries themselves (`getSeverity`, >=85 high / 60-84 medium /
 * <60 low) now live in `@tenex/shared` — the API's summary prompt builder
 * prints each anomaly's tier into the LLM prompt (so the timeline summary's
 * severity sections are grouped on the same banding the UI shows), and a
 * shared single source of truth is the only way the two sides can't drift.
 * This module re-exports them and keeps the web-only visual class maps.
 */
export {
  getSeverity,
  anomalySeverityConfidence,
  SEVERITY_LABEL,
  SEVERITY_ORDER,
  type Severity,
} from "@tenex/shared";
import type { Severity } from "@tenex/shared";

/**
 * Badge classes — light mode only (DECISIONS.md §14b). Solid `-50` tint +
 * `-200` border + `-700`/`-800` text, rather than low-opacity overlays, so
 * each band stays a clearly distinct, accessible color on a white/near-white
 * background instead of three shades of "faint pink." Medium uses `amber-800`
 * (not `-700`) specifically because amber-700-on-amber-50 alone reads too
 * close to AA's 4.5:1 line — bumping one step keeps it unambiguous next to
 * high/low at a glance, which is the actual job of this scale.
 */
export const SEVERITY_BADGE_CLASSES: Record<Severity, string> = {
  high: "border-red-200 bg-red-50 text-red-700",
  medium: "border-amber-200 bg-amber-50 text-amber-800",
  low: "border-slate-300 bg-slate-100 text-slate-600",
};

/** Left-border accent used to highlight anomalous rows in the events table. */
export const SEVERITY_ROW_CLASSES: Record<Severity, string> = {
  high: "border-l-2 border-l-red-500 bg-red-50/70",
  medium: "border-l-2 border-l-amber-500 bg-amber-50/70",
  low: "border-l-2 border-l-slate-400 bg-slate-50",
};

/**
 * Solid indicator-dot color per tier — deliberately the same `-500`/`-400`
 * hues as `SEVERITY_ROW_CLASSES`' left borders, so the badge dot in an
 * anomaly card and the row accent in the events table read as one system.
 */
export const SEVERITY_DOT_CLASSES: Record<Severity, string> = {
  high: "bg-red-500",
  medium: "bg-amber-500",
  low: "bg-slate-400",
};

/** Left-edge accent for anomaly cards — mirrors the events-table row accents. */
export const SEVERITY_CARD_ACCENT_CLASSES: Record<Severity, string> = {
  high: "border-l-red-500",
  medium: "border-l-amber-500",
  low: "border-l-slate-400",
};
