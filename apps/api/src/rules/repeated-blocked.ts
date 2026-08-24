import type { LogEvent } from "@tenex/shared";
import {
  REPEATED_BLOCKED_CONFIDENCE_MAX,
  REPEATED_BLOCKED_CONFIDENCE_MIN,
  REPEATED_BLOCKED_FLOOR,
  REPEATED_BLOCKED_WINDOW_MS,
} from "./config";
import { forEachTrailingWindow, scaleCountOverThresholdConfidence } from "./stats";
import type { RuleCandidate } from "./types";

/** Repeated-blocked confidence saturates once the blocked count reaches 3x the floor (15 blocked events in 10 min). */
const REPEATED_BLOCKED_RATIO_AT_MAX_CONFIDENCE = 3.0;

/**
 * Repeated-blocked (DECISIONS.md §14a): >= 5 blocked events for the same
 * actor within a 10-minute window. "Same actor" is checked two ways —
 * grouped by `login` and, separately, grouped by `cip` — since either
 * identity (a shared account or a shared source IP) is a valid repeated-
 * block signal; an event is flagged if *either* grouping's trailing window
 * clears the floor. Same trailing-window technique as burst-per-ip: every
 * event inside a qualifying window is flagged, not just the last one.
 */
export function repeatedBlockedRule(events: LogEvent[]): RuleCandidate[] {
  const blockedIndexed = events
    .map((e, index) => ({ e, index }))
    .filter(({ e }) => e.action === "blocked");

  const maxWindowCountByEvent = new Map<number, number>();

  for (const groupBy of ["login", "cip"] as const) {
    const groups = new Map<string, { index: number; timeMs: number }[]>();
    for (const { e, index } of blockedIndexed) {
      const key = `${groupBy}:${e[groupBy]}`;
      const timeMs = new Date(e.datetime).getTime();
      const arr = groups.get(key) ?? [];
      arr.push({ index, timeMs });
      groups.set(key, arr);
    }

    for (const entries of groups.values()) {
      entries.sort((a, b) => a.timeMs - b.timeMs);
      const times = entries.map((e) => e.timeMs);

      forEachTrailingWindow(times, REPEATED_BLOCKED_WINDOW_MS, (left, right, count) => {
        if (count >= REPEATED_BLOCKED_FLOOR) {
          for (let k = left; k <= right; k++) {
            const idx = entries[k].index;
            maxWindowCountByEvent.set(idx, Math.max(maxWindowCountByEvent.get(idx) ?? 0, count));
          }
        }
      });
    }
  }

  const candidates: RuleCandidate[] = [];
  for (const [eventIndex, count] of maxWindowCountByEvent) {
    const e = events[eventIndex];
    const confidence = scaleCountOverThresholdConfidence(
      count,
      REPEATED_BLOCKED_FLOOR,
      REPEATED_BLOCKED_CONFIDENCE_MIN,
      REPEATED_BLOCKED_CONFIDENCE_MAX,
      REPEATED_BLOCKED_RATIO_AT_MAX_CONFIDENCE,
    );
    candidates.push({
      eventIndex,
      ruleType: "repeated_blocked",
      confidence,
      reason: `${count} blocked events for login=${e.login} (cip=${e.cip}) within a 10-minute window — exceeds the >= ${REPEATED_BLOCKED_FLOOR}-blocked-in-10-min repeated_blocked threshold.`,
    });
  }

  return candidates;
}
