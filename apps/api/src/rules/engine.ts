import type { Anomaly, LogEvent } from "@tenex/shared";
import { beaconingRule } from "./beaconing";
import { burstPerIpRule } from "./burst-per-ip";
import { exfilBytesRule } from "./exfil-bytes";
import { malwareCategoryRule } from "./malware-category";
import { offHoursRule } from "./off-hours";
import { rareUserAgentRule } from "./rare-user-agent";
import { repeatedBlockedRule } from "./repeated-blocked";
import { threatNameRule } from "./threat-name";
import type { RuleCandidate } from "./types";

/**
 * Runs all eight deterministic rule modules — the original v1 seven
 * (DECISIONS.md §3, §14a) plus `beaconingRule`, the interval-regularity
 * detector deferred out of v1 and implemented as a stretch item (§15) — over
 * the full parsed event set and merges the results into `Anomaly[]`.
 *
 * Each rule module gets the *entire* file (not a slice), since several rules
 * need dataset-wide context — burst-per-ip's p99 baseline, exfil's
 * mean/stddev — computed from the file's own distribution, not a guessed
 * constant.
 *
 * Merge policy (DECISIONS.md §3, locked): when multiple rules (or multiple
 * firings of the same rule) land on one event, take the MAX confidence among
 * them as that event's `baseConfidence`, and list every triggered reason in
 * `triggeredReasons` — never a probabilistic/noisy-OR combination. This
 * engine is Layer 1 only: `llmAdjustedConfidence`/`llmExplanation` are left
 * `null` here, populated by the (separate, later) LLM judge phase.
 *
 * Events are addressed purely by array index in this phase — there is no
 * database-backed `LogEvent.id` yet (this engine runs on in-memory
 * `LogEvent[]`, no DB/network calls), so `eventRef` is the event's index in
 * the input array, stringified. A later phase (DB-backed `StoredLogEvent`)
 * can remap this to the real row id.
 */
export function runRuleEngine(events: LogEvent[]): Anomaly[] {
  const allCandidates: RuleCandidate[] = [
    ...burstPerIpRule(events),
    ...exfilBytesRule(events),
    ...threatNameRule(events),
    ...malwareCategoryRule(events),
    ...repeatedBlockedRule(events),
    ...offHoursRule(events),
    ...rareUserAgentRule(events),
    ...beaconingRule(events),
  ];

  const byEventIndex = new Map<number, RuleCandidate[]>();
  for (const candidate of allCandidates) {
    const arr = byEventIndex.get(candidate.eventIndex) ?? [];
    arr.push(candidate);
    byEventIndex.set(candidate.eventIndex, arr);
  }

  const merged: Anomaly[] = [];
  for (const [eventIndex, candidates] of byEventIndex) {
    const maxConfidence = Math.max(...candidates.map((c) => c.confidence));
    // The rule reported by `ruleType` is the one that produced the max
    // confidence (ties broken by candidate order, i.e. rule-module order
    // above) — `triggeredReasons` still lists every reason regardless.
    const winning = candidates.find((c) => c.confidence === maxConfidence)!;

    merged.push({
      id: `anomaly-${eventIndex}`,
      ruleType: winning.ruleType,
      triggeredReasons: candidates.map((c) => c.reason),
      baseConfidence: maxConfidence,
      llmAdjustedConfidence: null,
      explanation: candidates.map((c) => c.reason).join(" "),
      llmExplanation: null,
      rank: 0, // assigned below, after sorting
      eventRef: String(eventIndex),
    });
  }

  merged.sort((a, b) => b.baseConfidence - a.baseConfidence || Number(a.eventRef) - Number(b.eventRef));
  merged.forEach((anomaly, i) => {
    anomaly.rank = i + 1;
  });

  return merged;
}
