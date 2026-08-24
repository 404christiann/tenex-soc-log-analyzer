import type { LogEvent } from "@tenex/shared";
import {
  EXFIL_CONFIDENCE_AT_HIGH,
  EXFIL_CONFIDENCE_AT_THRESHOLD,
  EXFIL_MIN_SAMPLES,
  EXFIL_Z_HIGH,
  EXFIL_Z_THRESHOLD,
} from "./config";
import { mean, scaleExfilConfidence, stddev, zScore } from "./stats";
import type { RuleCandidate } from "./types";

/**
 * Exfil / bytes_out z-score outlier (DECISIONS.md §14a): computed only over
 * POST/PUT events (the methods that actually push data out), against the
 * *file's own* mean/stddev — self-calibrating rather than a guessed
 * constant. Requires >= EXFIL_MIN_SAMPLES POST/PUT events in the dataset
 * before the rule runs at all; with fewer, mean/stddev are too noisy to
 * trust and we skip the rule rather than risk a false flag on a thin sample.
 */
export function exfilBytesRule(events: LogEvent[]): RuleCandidate[] {
  const candidates: RuleCandidate[] = [];

  const postPut = events
    .map((e, index) => ({ e, index }))
    .filter(({ e }) => e.reqmethod === "POST" || e.reqmethod === "PUT");

  if (postPut.length < EXFIL_MIN_SAMPLES) return candidates;

  const values = postPut.map(({ e }) => e.bytes_out);
  const m = mean(values);
  const sd = stddev(values);

  for (const { e, index } of postPut) {
    const z = zScore(e.bytes_out, m, sd);
    if (z > EXFIL_Z_THRESHOLD) {
      const confidence = scaleExfilConfidence(
        z,
        EXFIL_Z_THRESHOLD,
        EXFIL_Z_HIGH,
        EXFIL_CONFIDENCE_AT_THRESHOLD,
        EXFIL_CONFIDENCE_AT_HIGH,
      );
      candidates.push({
        eventIndex: index,
        ruleType: "bytes_out_exfil",
        confidence,
        reason: `bytes_out=${e.bytes_out} on a ${e.reqmethod} event — z-score ${z.toFixed(
          2,
        )} against the file's own POST/PUT baseline (mean=${m.toFixed(1)}, stddev=${sd.toFixed(
          1,
        )}, n=${postPut.length}) — exceeds the z>${EXFIL_Z_THRESHOLD} bytes_out_exfil threshold.`,
      });
    }
  }

  return candidates;
}
