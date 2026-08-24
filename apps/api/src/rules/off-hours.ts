import type { LogEvent } from "@tenex/shared";
import { BUSINESS_END_UTC_HOUR, BUSINESS_START_UTC_HOUR, OFF_HOURS_CONFIDENCE } from "./config";
import type { RuleCandidate } from "./types";

/** UTC day-of-week: 0 = Sunday, 6 = Saturday. */
function isWeekdayUtc(date: Date): boolean {
  const day = date.getUTCDay();
  return day >= 1 && day <= 5;
}

/**
 * Off-hours access (DECISIONS.md §14a): outside 08:00-18:00 UTC on a
 * weekday. Fixed synthetic-org business hours (documented in the README),
 * not computed from the dataset — this is a contextual/weak signal on its
 * own (fixed ~50 confidence), meant to combine with other rules via the
 * max-confidence-plus-all-reasons merge policy, not to stand alone as strong
 * evidence.
 */
export function offHoursRule(events: LogEvent[]): RuleCandidate[] {
  const candidates: RuleCandidate[] = [];

  events.forEach((e, index) => {
    const date = new Date(e.datetime);
    const hour = date.getUTCHours();
    const weekday = isWeekdayUtc(date);
    const withinBusinessHours = weekday && hour >= BUSINESS_START_UTC_HOUR && hour < BUSINESS_END_UTC_HOUR;
    if (withinBusinessHours) return;

    const why = !weekday
      ? "falls on a Saturday/Sunday (UTC)"
      : hour < BUSINESS_START_UTC_HOUR
        ? `hour (${hour}:00 UTC) is before the ${BUSINESS_START_UTC_HOUR}:00 UTC business-hours start`
        : `hour (${hour}:00 UTC) is at/after the ${BUSINESS_END_UTC_HOUR}:00 UTC business-hours end`;

    candidates.push({
      eventIndex: index,
      ruleType: "off_hours",
      confidence: OFF_HOURS_CONFIDENCE,
      reason: `datetime=${e.datetime} ${why} — outside the ${BUSINESS_START_UTC_HOUR}:00-${BUSINESS_END_UTC_HOUR}:00 UTC weekday business-hours window.`,
    });
  });

  return candidates;
}
