import type { LogEvent } from "@tenex/shared";
import { THREATNAME_CONFIDENCE } from "./config";
import type { RuleCandidate } from "./types";

/**
 * threatname populated (DECISIONS.md §14a): a direct, confirmed-bad signal
 * — the proxy vendor's own threat-intel match, not something inferred from
 * volume/timing. Fixed high confidence, independent of `urlcat` (a threat
 * name can be populated even on an otherwise benign category).
 */
export function threatNameRule(events: LogEvent[]): RuleCandidate[] {
  const candidates: RuleCandidate[] = [];

  events.forEach((e, index) => {
    if (e.threatname) {
      candidates.push({
        eventIndex: index,
        ruleType: "threatname_hit",
        confidence: THREATNAME_CONFIDENCE,
        reason: `threatname="${e.threatname}" is populated — direct signal, independent of urlcat ("${e.urlcat}").`,
      });
    }
  });

  return candidates;
}
