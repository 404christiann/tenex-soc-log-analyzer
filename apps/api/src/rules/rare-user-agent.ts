import type { LogEvent } from "@tenex/shared";
import {
  KNOWN_SCRIPTED_UA_CONFIDENCE,
  KNOWN_SCRIPTED_UA_SIGNATURES,
  RARE_UA_FRACTION_THRESHOLD,
  RARE_UA_STATISTICAL_CONFIDENCE,
} from "./config";
import type { RuleCandidate } from "./types";

/** Case-insensitive substring match against the known scripted/tooling signatures, or an outright empty UA. */
function matchesKnownScriptedSignature(useragent: string): string | null {
  if (useragent === "") return "(empty string)";
  const lower = useragent.toLowerCase();
  for (const signature of KNOWN_SCRIPTED_UA_SIGNATURES) {
    if (lower.includes(signature)) return signature;
  }
  return null;
}

/**
 * Rare / scripted user-agent (DECISIONS.md §14a) — two sub-cases folded into
 * one rule type (`rare_scripted_user_agent` is the only UA-related value in
 * the shared `AnomalyRuleType` enum):
 *
 *   1. Known signature (curl / python-requests / wget / empty) — a direct,
 *      specific match, so it gets the higher fixed confidence (~60).
 *   2. Statistical rarity (this exact UA string appears in < 1% of the
 *      file's events) with no known-signature match — weaker, more
 *      speculative evidence, so it gets the lower fixed confidence (~50).
 *
 * A known-signature UA is *also* almost always statistically rare, but we
 * only emit one candidate per event (the known-signature case takes
 * precedence) rather than two redundant candidates for the same rule type.
 */
export function rareUserAgentRule(events: LogEvent[]): RuleCandidate[] {
  const candidates: RuleCandidate[] = [];

  const uaCounts = new Map<string, number>();
  for (const e of events) {
    uaCounts.set(e.useragent, (uaCounts.get(e.useragent) ?? 0) + 1);
  }

  events.forEach((e, index) => {
    const knownMatch = matchesKnownScriptedSignature(e.useragent);
    if (knownMatch) {
      candidates.push({
        eventIndex: index,
        ruleType: "rare_scripted_user_agent",
        confidence: KNOWN_SCRIPTED_UA_CONFIDENCE,
        reason: `useragent="${e.useragent === "" ? "(empty string)" : e.useragent}" matches a known scripted/tooling signature (curl/python-requests/wget/empty).`,
      });
      return;
    }

    const count = uaCounts.get(e.useragent) ?? 0;
    const fraction = events.length === 0 ? 0 : count / events.length;
    if (fraction < RARE_UA_FRACTION_THRESHOLD) {
      candidates.push({
        eventIndex: index,
        ruleType: "rare_scripted_user_agent",
        confidence: RARE_UA_STATISTICAL_CONFIDENCE,
        reason: `useragent="${e.useragent}" appears in only ${(fraction * 100).toFixed(
          2,
        )}% of the file's events (< ${(RARE_UA_FRACTION_THRESHOLD * 100).toFixed(0)}%), with no known-script signature match.`,
      });
    }
  });

  return candidates;
}
