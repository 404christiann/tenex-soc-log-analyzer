import { z } from "zod";

/**
 * v1 rule set (DECISIONS.md §3, §14a). Every anomaly's `ruleType` names the
 * primary rule that fired; `triggeredReasons` carries every reason so that
 * when multiple rules fire on one event, nothing is lost even though only
 * the max confidence is surfaced (§3: "take the max confidence, list all
 * triggered reasons").
 */
export const AnomalyRuleTypeSchema = z.enum([
  "burst_per_ip",
  "bytes_out_exfil",
  "threatname_hit",
  "malware_category",
  "repeated_blocked",
  "off_hours",
  "rare_scripted_user_agent",
]);
export type AnomalyRuleType = z.infer<typeof AnomalyRuleTypeSchema>;

export const AnomalySchema = z.object({
  /** Anomaly row id. */
  id: z.string(),
  /** Which rule produced this anomaly's confidence score (the max-confidence rule, if several fired). */
  ruleType: AnomalyRuleTypeSchema,
  /** Every rule reason that fired on this event, not just the winning one. */
  triggeredReasons: z.array(z.string()).min(1),
  /**
   * Layer 1 deterministic score (0-100). Never overwritten by the LLM judge —
   * kept as a separate column/field from `llmAdjustedConfidence` on purpose
   * (DECISIONS.md §8) so the UI/interview can show "deterministic score vs.
   * what the judge nudged it to and why".
   */
  baseConfidence: z.number().min(0).max(100),
  /**
   * Layer 2 (LLM judge) nudge, bounded to ±15 of `baseConfidence`. `null`
   * when the judge didn't run (not_configured), failed, or this event fell
   * outside the top-N batched candidates (DECISIONS.md §3).
   */
  llmAdjustedConfidence: z.number().min(0).max(100).nullable(),
  /** Layer 1's templated explanation — always present, used as the fallback display text. */
  explanation: z.string(),
  /** Layer 2's reworded/contextualized explanation. `null` under the same conditions as `llmAdjustedConfidence`. */
  llmExplanation: z.string().nullable(),
  /** Display/severity ordering, e.g. by confidence descending. */
  rank: z.number().int(),
  /** Id of the `LogEvent` this anomaly refers to. */
  eventRef: z.string(),
  /**
   * ISO datetime of the referenced event, when known. Additive/optional on
   * purpose: the in-memory rule-engine anomalies (whose `eventRef` is still
   * an array index into the parsed events) don't carry it — it's populated
   * by the API's DB mappers so the results page's anomalies table can show
   * a timestamp column (DECISIONS.md §14c) without the client having to
   * page through every event to resolve `eventRef`.
   */
  eventDatetime: z.string().nullable().optional(),
});
export type Anomaly = z.infer<typeof AnomalySchema>;
