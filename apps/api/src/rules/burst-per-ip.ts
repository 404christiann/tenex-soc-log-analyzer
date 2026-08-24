import type { LogEvent } from "@tenex/shared";
import {
  BURST_ABSOLUTE_FLOOR,
  BURST_CONFIDENCE_MAX,
  BURST_CONFIDENCE_MIN,
  BURST_P99_PERCENTILE,
  BURST_WINDOW_MS,
} from "./config";
import { forEachTrailingWindow, percentile, scaleCountOverThresholdConfidence } from "./stats";
import type { RuleCandidate } from "./types";

/** Burst confidence saturates at BURST_CONFIDENCE_MAX once count is >= 2x the effective threshold. */
const BURST_RATIO_AT_MAX_CONFIDENCE = 2.0;

/**
 * Burst-per-IP (DECISIONS.md §14a): a 60s sliding window per client IP.
 *
 * Baseline: bucket every event into a (cip, calendar-minute) bucket and take
 * the count of each occupied bucket. The p99 of that distribution is the
 * file's own "how many requests/minute does one IP normally make" baseline.
 *
 * Flagging: for each IP's own time-sorted events, walk a trailing 60s window
 * (two-pointer, see `forEachTrailingWindow`). A window qualifies when its
 * count both (a) exceeds the file's p99 baseline and (b) clears the absolute
 * floor of >= 15 — the floor guards against flagging trivial bursts when the
 * baseline itself is unusually quiet (p99 near 0). Every event inside a
 * qualifying window is flagged (not just the window's last event), which is
 * why a single burst instance produces one candidate per event that
 * participated in it.
 */
export function burstPerIpRule(events: LogEvent[]): RuleCandidate[] {
  const candidates: RuleCandidate[] = [];

  // --- Build the per-IP-per-minute baseline distribution. ---
  const perMinuteCounts = new Map<string, number>(); // key: `${cip}|${minuteBucket}`
  for (const e of events) {
    const minuteBucket = Math.floor(new Date(e.datetime).getTime() / 60_000);
    const key = `${e.cip}|${minuteBucket}`;
    perMinuteCounts.set(key, (perMinuteCounts.get(key) ?? 0) + 1);
  }
  const p99 = percentile([...perMinuteCounts.values()], BURST_P99_PERCENTILE);
  const effectiveThreshold = Math.max(p99, BURST_ABSOLUTE_FLOOR);

  // --- Group event indices by IP, preserving original indices. ---
  const byIp = new Map<string, { index: number; timeMs: number }[]>();
  events.forEach((e, index) => {
    const timeMs = new Date(e.datetime).getTime();
    const arr = byIp.get(e.cip) ?? [];
    arr.push({ index, timeMs });
    byIp.set(e.cip, arr);
  });

  for (const [cip, entries] of byIp) {
    entries.sort((a, b) => a.timeMs - b.timeMs);
    const times = entries.map((e) => e.timeMs);

    // Track the largest qualifying window count each local position ended up part of.
    const maxWindowCountAt = new Array<number>(entries.length).fill(0);

    forEachTrailingWindow(times, BURST_WINDOW_MS, (left, right, count) => {
      if (count > p99 && count >= BURST_ABSOLUTE_FLOOR) {
        for (let k = left; k <= right; k++) {
          maxWindowCountAt[k] = Math.max(maxWindowCountAt[k], count);
        }
      }
    });

    entries.forEach((entry, localIndex) => {
      const count = maxWindowCountAt[localIndex];
      if (count === 0) return;
      const confidence = scaleCountOverThresholdConfidence(
        count,
        effectiveThreshold,
        BURST_CONFIDENCE_MIN,
        BURST_CONFIDENCE_MAX,
        BURST_RATIO_AT_MAX_CONFIDENCE,
      );
      candidates.push({
        eventIndex: entry.index,
        ruleType: "burst_per_ip",
        confidence,
        reason: `${count} requests from cip=${cip} within a 60s window — exceeds the file's per-IP-per-minute p99 (${p99.toFixed(
          1,
        )}) and the absolute floor of >= ${BURST_ABSOLUTE_FLOOR} requests/min.`,
      });
    });
  }

  return candidates;
}
