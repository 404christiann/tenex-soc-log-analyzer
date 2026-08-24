/**
 * Severity banding for anomaly confidence scores — the phase brief's
 * recommended thresholds: >=85 high, 60-84 medium, <60 low.
 *
 * Lives in the shared package (moved here from `apps/web/src/lib/severity.ts`)
 * because BOTH sides of the app now depend on the exact same tier boundaries:
 * the web app's events table / anomalies panel / timeline severity sections
 * (visual banding), and the API's summary prompt builder, which prints each
 * anomaly's tier into the LLM prompt so the model groups its timeline bullets
 * under the correct severity section without re-deriving (and possibly
 * contradicting) the UI's banding. One function, no drift.
 */
export type Severity = "high" | "medium" | "low";

export const SEVERITY_ORDER: Severity[] = ["high", "medium", "low"];

export function getSeverity(confidence: number): Severity {
  if (confidence >= 85) return "high";
  if (confidence >= 60) return "medium";
  return "low";
}

/**
 * The display confidence an anomaly is banded on everywhere: the judge's
 * adjusted score when the judge ran, the deterministic base score otherwise.
 * Centralized for the same no-drift reason as `getSeverity` — the Anomalies
 * tab and the summary prompt must band identically or a bullet's section
 * would contradict the badge on the event it links to.
 */
export function anomalySeverityConfidence(anomaly: {
  baseConfidence: number;
  llmAdjustedConfidence: number | null;
}): number {
  return anomaly.llmAdjustedConfidence ?? anomaly.baseConfidence;
}

export const SEVERITY_LABEL: Record<Severity, string> = {
  high: "High",
  medium: "Medium",
  low: "Low",
};
