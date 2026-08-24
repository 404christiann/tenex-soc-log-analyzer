/**
 * Shared statistical helpers for the rule engine (Phase 5). Every rule that
 * needs a dataset-wide baseline (burst-per-IP's p99, exfil's z-score) goes
 * through these functions so the math is defined exactly once and is easy to
 * point at in an interview.
 */

/** Arithmetic mean. Returns 0 for an empty array (callers only use this after checking sample size). */
export function mean(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

/**
 * Population standard deviation — matches the "dataset's own baseline"
 * framing (DECISIONS.md §14a: self-calibrating against the *whole* file, not
 * a sample drawn from a larger population). Mirrors
 * `scripts/generate-logs/stats.ts`, which is how the ANSWER_KEY.md z-scores
 * were computed, so this module must reproduce those exact numbers.
 */
export function stddev(values: number[]): number {
  if (values.length === 0) return 0;
  const m = mean(values);
  const variance = mean(values.map((v) => (v - m) ** 2));
  return Math.sqrt(variance);
}

/** Standard z-score. Returns 0 if stddev is 0 (a degenerate, zero-variance population can't produce an outlier). */
export function zScore(value: number, m: number, sd: number): number {
  if (sd === 0) return 0;
  return (value - m) / sd;
}

/**
 * Percentile via linear interpolation between closest ranks (same method as
 * NumPy's default `"linear"` interpolation) — deterministic, no external
 * dependency, and easy to explain: sort the values, walk to the fractional
 * rank `p * (n - 1)`, and interpolate between the two neighboring values.
 *
 * `p` is a fraction in [0, 1] (e.g. 0.99 for p99). Returns 0 for an empty
 * input.
 */
export function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  if (sorted.length === 1) return sorted[0];
  const rank = p * (sorted.length - 1);
  const lowerIndex = Math.floor(rank);
  const upperIndex = Math.ceil(rank);
  if (lowerIndex === upperIndex) return sorted[lowerIndex];
  const fraction = rank - lowerIndex;
  return sorted[lowerIndex] + (sorted[upperIndex] - sorted[lowerIndex]) * fraction;
}

/**
 * Confidence-scaling curve for the exfil rule (DECISIONS.md §14a: "z=3 ->
 * ~65, z>=6 -> ~95"). A clean linear ramp between the two documented anchor
 * points, clamped flat outside them:
 *
 *   confidence(z) = confAtThreshold + slope * (z - zThreshold)
 *   slope = (confAtHigh - confAtThreshold) / (zHigh - zThreshold)
 *
 * With the locked constants that's `65 + 10 * (z - 3)`, clamped to
 * [confAtThreshold, confAtHigh] — e.g. z=3 -> 65, z=4.16 -> ~76.6,
 * z=6 -> 95, z=24.5 -> 95 (clamped, not runaway).
 */
export function scaleExfilConfidence(
  z: number,
  zThreshold: number,
  zHigh: number,
  confAtThreshold: number,
  confAtHigh: number,
): number {
  const slope = (confAtHigh - confAtThreshold) / (zHigh - zThreshold);
  const raw = confAtThreshold + slope * (z - zThreshold);
  return clamp(raw, confAtThreshold, confAtHigh);
}

/**
 * Confidence-scaling curve shared by burst-per-ip and repeated-blocked:
 * both are "count within a sliding window, judged against a floor" rules
 * that scale "by how far over" the effective threshold the count landed.
 *
 *   confidence(count) = confMin + slope * (count / threshold - 1)
 *   slope = (confMax - confMin) / (ratioAtMax - 1)
 *
 * `ratioAtMax` is the count/threshold ratio at which confidence saturates
 * at `confMax` (e.g. 2.0 means "double the threshold maxes it out"). Ratios
 * at/below 1 clamp to `confMin` (the qualifying floor itself is the weakest
 * still-flagged signal); ratios at/above `ratioAtMax` clamp to `confMax`.
 */
export function scaleCountOverThresholdConfidence(
  count: number,
  threshold: number,
  confMin: number,
  confMax: number,
  ratioAtMax: number,
): number {
  if (threshold <= 0) return confMax;
  const ratio = count / threshold;
  const slope = (confMax - confMin) / (ratioAtMax - 1);
  const raw = confMin + slope * (ratio - 1);
  return clamp(raw, confMin, confMax);
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/**
 * For each index `right` in a time-sorted array, expands a left pointer so
 * `[left, right]` is the maximal window satisfying `times[right] - times[left]
 * <= windowMs`, and reports `right - left + 1` (the window's count) via
 * `onWindow`. Shared by burst-per-ip and repeated-blocked, which both need
 * "count of same-key events within a trailing N-ms window, per event."
 *
 * `times` must already be sorted ascending; index 0 corresponds to the
 * caller's own indexing scheme (callers pass a same-length parallel array of
 * whatever identity they need to record per window).
 */
export function forEachTrailingWindow(
  times: number[],
  windowMs: number,
  onWindow: (left: number, right: number, count: number) => void,
): void {
  let left = 0;
  for (let right = 0; right < times.length; right++) {
    while (times[right] - times[left] > windowMs) left++;
    onWindow(left, right, right - left + 1);
  }
}
