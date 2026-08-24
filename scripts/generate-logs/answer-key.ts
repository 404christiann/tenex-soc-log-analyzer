/** Renders `examples/ANSWER_KEY.md` from the `AnswerKeyFact`s collected during generation. */
import type { AnomalyRuleType } from "@tenex/shared";
import type { AnswerKeyFact } from "./anomaly-injectors";
import type { GenEvent } from "./wire-format";

export interface ResolvedFact {
  fact: AnswerKeyFact;
  lineNumbers: number[]; // 1-indexed, ascending
}

/** Maps each `AnswerKeyFact`'s events to their final 1-indexed line numbers in the sorted, serialized file. */
export function resolveLineNumbers(sortedEvents: GenEvent[], facts: AnswerKeyFact[]): ResolvedFact[] {
  const indexOfEvent = new Map<GenEvent, number>();
  sortedEvents.forEach((e, i) => indexOfEvent.set(e, i + 1));
  return facts.map((fact) => ({
    fact,
    lineNumbers: fact.events.map((e) => {
      const idx = indexOfEvent.get(e);
      if (idx === undefined) throw new Error(`resolveLineNumbers: event for fact "${fact.label}" not found in sorted file`);
      return idx;
    }).sort((a, b) => a - b),
  }));
}

/** Condenses a sorted list of line numbers into "N" / "N-M" range notation, e.g. [5,6,7,9] -> "5-7, 9". */
function formatLineNumbers(nums: number[]): string {
  if (nums.length === 0) return "(none)";
  const ranges: string[] = [];
  let start = nums[0];
  let prev = nums[0];
  for (let i = 1; i <= nums.length; i++) {
    const cur = nums[i];
    if (cur !== prev + 1) {
      ranges.push(start === prev ? `${start}` : `${start}-${prev}`);
      start = cur;
    }
    prev = cur;
  }
  return ranges.join(", ");
}

const RULE_TYPE_TITLES: Record<AnomalyRuleType, string> = {
  burst_per_ip: "Burst-per-IP",
  bytes_out_exfil: "Exfil (bytes_out z-score)",
  threatname_hit: "threatname populated",
  malware_category: "Malware-category access",
  repeated_blocked: "Repeated-blocked",
  off_hours: "Off-hours access",
  rare_scripted_user_agent: "Rare/scripted user-agent",
};

export const RULE_TYPE_ORDER: AnomalyRuleType[] = [
  "burst_per_ip",
  "bytes_out_exfil",
  "threatname_hit",
  "malware_category",
  "repeated_blocked",
  "off_hours",
  "rare_scripted_user_agent",
];

export function renderFileSection(fileLabel: string, filename: string, totalRows: number, resolved: ResolvedFact[]): string {
  const lines: string[] = [];
  lines.push(`## ${fileLabel} (\`examples/${filename}\`, ${totalRows} rows)`);
  lines.push("");

  if (resolved.length === 0) {
    lines.push(
      "**Zero injected anomalies.** This file is the negative control (DECISIONS.md §13) — every row is " +
        "ordinary baseline traffic. A correct detector should flag nothing here; if it does, that's a false positive.",
    );
    lines.push("");
    return lines.join("\n");
  }

  const byRule = new Map<AnomalyRuleType, ResolvedFact[]>();
  for (const r of resolved) {
    const arr = byRule.get(r.fact.ruleType) ?? [];
    arr.push(r);
    byRule.set(r.fact.ruleType, arr);
  }

  for (const ruleType of RULE_TYPE_ORDER) {
    const instances = byRule.get(ruleType);
    if (!instances || instances.length === 0) continue;
    lines.push(`### ${RULE_TYPE_TITLES[ruleType]} — ${instances.length} instance${instances.length === 1 ? "" : "s"}`);
    lines.push("");
    for (const { fact, lineNumbers } of instances) {
      const lineWord = lineNumbers.length === 1 ? "Line" : "Lines";
      lines.push(`- **${fact.label}** — ${lineWord} ${formatLineNumbers(lineNumbers)}: ${fact.reason}`);
    }
    lines.push("");
  }

  return lines.join("\n");
}

export function renderAnswerKey(sections: string[]): string {
  return `# Answer Key — synthetic anomaly ground truth

**This file is for the human developer's own validation while building the rule engine
(DECISIONS.md §13, §14a). Detection code must NEVER read this file at runtime** — doing so
would make anomaly detection circular (grading its own answer sheet) instead of an honest,
independently-verifiable pass over the raw log data. It exists so a developer implementing
Layer 1's deterministic rules can check "did my rule engine find exactly these rows, for
exactly these reasons" against known ground truth, instead of eyeballing results.

Generated deterministically by \`scripts/generate-logs/generate.ts\` (\`faker.seed(42)\`) — see
that script and \`scripts/generate-logs/anomaly-injectors.ts\` for exactly how each instance
below was constructed. Line numbers are 1-indexed and count every line in the file (there is no
header row). \`malformed-edge-cases.log\` deliberately has no answer key here — it's a parser
robustness test, not an anomaly-detection test; see \`examples/README.md\` for what it covers
instead.

---

${sections.join("\n---\n\n")}`;
}
