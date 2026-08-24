import type { AnomalyRuleType } from "@tenex/shared";

/**
 * One rule module's raw output for one event: "this rule fired on event
 * `eventIndex` with this confidence, for this reason." A single event can
 * accumulate multiple candidates (from the same rule module, e.g.
 * burst-per-ip flagging every event in an over-threshold window, or from
 * different rule modules). `engine.ts` merges all candidates per event per
 * the max-confidence-plus-all-reasons policy (DECISIONS.md §3).
 */
export interface RuleCandidate {
  /** Index into the full `LogEvent[]` passed to the rule module. */
  eventIndex: number;
  ruleType: AnomalyRuleType;
  /** 0-100. */
  confidence: number;
  /** Human-readable explanation of why this specific event triggered this specific rule. */
  reason: string;
}
