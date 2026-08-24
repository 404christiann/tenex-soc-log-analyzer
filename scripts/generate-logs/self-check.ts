/**
 * Generation-time verification, run against the fully-merged event set for
 * each output file before it's written. This is NOT the real detection
 * engine (that's a later phase) — it's a lightweight re-implementation of
 * the same DECISIONS.md §14a thresholds, used only to guarantee two things
 * before anything is written to disk:
 *
 *   1. Baseline ("normal") traffic never accidentally crosses a threshold —
 *      otherwise the answer key would be wrong (an unlisted line would
 *      actually qualify as an anomaly).
 *   2. Every injected instance actually clears its threshold with the exact
 *      values claimed in its `AnswerKeyFact`.
 *
 * Throws on any violation — generation is fully deterministic, so a failure
 * here means a generator bug to fix, not a runtime condition to tolerate.
 */
import { HIGH_RISK_URL_CATEGORIES } from "@tenex/shared";
import { REALISTIC_USER_AGENTS } from "./content";
import { isBusinessHoursUtc } from "./time-utils";
import { mean, stddev, zScore } from "./stats";
import type { GenEvent } from "./wire-format";

const BURST_WINDOW_MS = 60_000;
const BURST_FLOOR = 15;
const BLOCKED_WINDOW_MS = 10 * 60_000;
const BLOCKED_FLOOR = 5;
const RARE_UA_FRACTION_FLOOR = 0.01;
const EXFIL_MIN_SAMPLES = 30;
const EXFIL_Z_THRESHOLD = 3;

/** Max count of `timestampsMs` (assumed sorted) falling within any `windowMs` sliding window. */
function maxSlidingWindowCount(timestampsMs: number[], windowMs: number): number {
  let maxCount = 0;
  let left = 0;
  for (let right = 0; right < timestampsMs.length; right++) {
    while (timestampsMs[right] - timestampsMs[left] > windowMs) left++;
    maxCount = Math.max(maxCount, right - left + 1);
  }
  return maxCount;
}

function groupBy<T>(items: T[], keyFn: (item: T) => string): Map<string, T[]> {
  const map = new Map<string, T[]>();
  for (const item of items) {
    const key = keyFn(item);
    const arr = map.get(key) ?? [];
    arr.push(item);
    map.set(key, arr);
  }
  return map;
}

export interface SelfCheckParams {
  fileName: string;
  events: GenEvent[];
  baselineLogins: Set<string>;
  /** Whether this file is expected to carry the ≥30-sample POST/PUT exfil baseline. */
  expectExfilBaseline: boolean;
}

export interface SelfCheckReport {
  exfilZByEvent: Map<GenEvent, number>;
  postPutSampleCount: number;
  postPutMean: number;
  postPutStddev: number;
}

export interface ExfilStats {
  postPutMean: number;
  postPutStddev: number;
  zByEvent: Map<GenEvent, number>;
}

/**
 * Standalone POST/PUT bytes_out z-score computation, exposed so the
 * orchestrator can iteratively calibrate injected exfil values (which
 * perturb the population stats they're measured against) before running
 * the full `runSelfCheck` pass.
 */
export function computeExfilStats(events: GenEvent[]): ExfilStats {
  const postPut = events.filter((e) => e.reqmethod === "POST" || e.reqmethod === "PUT");
  const postPutMean = mean(postPut.map((e) => e.bytes_out));
  const postPutStddev = stddev(postPut.map((e) => e.bytes_out));
  const zByEvent = new Map<GenEvent, number>();
  for (const e of postPut) zByEvent.set(e, zScore(e.bytes_out, postPutMean, postPutStddev));
  return { postPutMean, postPutStddev, zByEvent };
}

export function runSelfCheck(params: SelfCheckParams): SelfCheckReport {
  const { fileName, events, baselineLogins, expectExfilBaseline } = params;
  const errors: string[] = [];

  // --- 1. Burst-per-IP: baseline IPs must never cross the floor. ---
  const byCip = groupBy(events, (e) => e.cip);
  for (const [cip, evs] of byCip) {
    const isBaselineCip = evs.every((e) => baselineLogins.has(e.login));
    if (!isBaselineCip) continue; // anomaly-actor cips are checked implicitly via the injected fact itself
    const times = evs.map((e) => e.datetime.getTime()).sort((a, b) => a - b);
    const maxCount = maxSlidingWindowCount(times, BURST_WINDOW_MS);
    if (maxCount >= BURST_FLOOR) {
      errors.push(`[${fileName}] baseline cip=${cip} hits ${maxCount} requests in a 60s window (>= ${BURST_FLOOR} floor) — unintended burst_per_ip trigger`);
    }
  }

  // --- 2. Repeated-blocked: baseline logins must never cross the floor. ---
  const blockedEvents = events.filter((e) => e.action === "blocked");
  const blockedByLogin = groupBy(blockedEvents, (e) => e.login);
  for (const [login, evs] of blockedByLogin) {
    if (!baselineLogins.has(login)) continue;
    const times = evs.map((e) => e.datetime.getTime()).sort((a, b) => a - b);
    const maxCount = maxSlidingWindowCount(times, BLOCKED_WINDOW_MS);
    if (maxCount >= BLOCKED_FLOOR) {
      errors.push(`[${fileName}] baseline login=${login} hits ${maxCount} blocked events in a 10-min window (>= ${BLOCKED_FLOOR} floor) — unintended repeated_blocked trigger`);
    }
  }

  // --- 3. Off-hours: every baseline event must fall inside business hours. ---
  for (const e of events) {
    if (!baselineLogins.has(e.login)) continue;
    if (!isBusinessHoursUtc(e.datetime)) {
      errors.push(`[${fileName}] baseline login=${e.login} has an off-hours event at ${e.datetime.toISOString()} — unintended off_hours trigger`);
    }
  }

  // --- 4. threatname / malware-category: baseline must never set these. ---
  for (const e of events) {
    if (!baselineLogins.has(e.login)) continue;
    if (e.threatname) {
      errors.push(`[${fileName}] baseline login=${e.login} has threatname="${e.threatname}" set — unintended threatname_hit trigger`);
    }
    if ((HIGH_RISK_URL_CATEGORIES as readonly string[]).includes(e.urlcat)) {
      errors.push(`[${fileName}] baseline login=${e.login} has urlcat="${e.urlcat}" (high-risk) — unintended malware_category trigger`);
    }
  }

  // --- 5. Rare/scripted user-agent: every baseline (realistic) UA must clear the 1% statistical floor. ---
  const uaCounts = new Map<string, number>();
  for (const e of events) uaCounts.set(e.useragent, (uaCounts.get(e.useragent) ?? 0) + 1);
  for (const [ua, count] of uaCounts) {
    if (!REALISTIC_USER_AGENTS.includes(ua)) continue; // scripted UAs are intentionally rare
    const fraction = count / events.length;
    if (fraction < RARE_UA_FRACTION_FLOOR) {
      errors.push(`[${fileName}] realistic useragent "${ua}" only appears ${(fraction * 100).toFixed(2)}% of the file (< 1%) — unintended rare_scripted_user_agent (statistical) trigger`);
    }
  }

  // --- 6. Exfil bytes_out: z-score check over the full POST/PUT population. ---
  const postPut = events.filter((e) => e.reqmethod === "POST" || e.reqmethod === "PUT");
  const { postPutMean, postPutStddev, zByEvent: exfilZByEvent } = computeExfilStats(events);

  if (expectExfilBaseline && postPut.length < EXFIL_MIN_SAMPLES) {
    errors.push(`[${fileName}] only ${postPut.length} POST/PUT events — below the ≥${EXFIL_MIN_SAMPLES} sample floor required before the exfil rule runs at all`);
  }
  for (const e of postPut) {
    if (!baselineLogins.has(e.login)) continue;
    const z = exfilZByEvent.get(e)!;
    if (z > EXFIL_Z_THRESHOLD) {
      errors.push(`[${fileName}] baseline login=${e.login} POST/PUT bytes_out=${e.bytes_out} has z=${z.toFixed(2)} (> ${EXFIL_Z_THRESHOLD}) — unintended bytes_out_exfil trigger`);
    }
  }

  if (errors.length > 0) {
    throw new Error(`Self-check failed for ${fileName}:\n${errors.map((e) => `  - ${e}`).join("\n")}`);
  }

  return { exfilZByEvent, postPutSampleCount: postPut.length, postPutMean, postPutStddev };
}
