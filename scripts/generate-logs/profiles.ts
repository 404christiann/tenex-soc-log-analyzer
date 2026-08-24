/**
 * Per-file scenario configs (DECISIONS.md §13, §14a; take-home brief's four
 * example files). Row counts, time ranges, and "how many of each anomaly
 * type" live here; the actual scheduling and injection logic lives in
 * `generate.ts` / `anomaly-injectors.ts`.
 */

export interface AnomalyCounts {
  burst: number;
  exfil: number;
  threatname: number;
  malware: number;
  repeatedBlocked: number;
  offHours: number;
  rareUa: number;
}

export function totalAnomalyActors(counts: AnomalyCounts): number {
  return counts.burst + counts.exfil + counts.threatname + counts.malware + counts.repeatedBlocked + counts.offHours + counts.rareUa;
}

export interface FileProfile {
  id: string;
  outputFile: string;
  baselineUserCount: number;
  /** Total baseline row budget, inclusive of the POST/PUT top-up reserved below. */
  baselineTargetCount: number;
  /** Guarantees this many POST/PUT baseline events exist (exfil rule's ≥30-sample floor, DECISIONS.md §14a). */
  minPostPutBaseline: number;
  rangeStartUtc: Date;
  rangeEndUtc: Date;
  /** Whether this file's exfil rule should be expected to have a valid statistical baseline (>= 30 POST/PUT samples). */
  expectExfilBaseline: boolean;
  anomalyCounts: AnomalyCounts;
}

const ZERO_ANOMALIES: AnomalyCounts = {
  burst: 0,
  exfil: 0,
  threatname: 0,
  malware: 0,
  repeatedBlocked: 0,
  offHours: 0,
  rareUa: 0,
};

/**
 * `normal-traffic.log` — the main "needle in a haystack" demo: ~2-5K
 * realistic rows with at least 2 injected instances of every one of the 7
 * anomaly types, embedded among believable per-user session traffic.
 */
export const NORMAL_TRAFFIC_PROFILE: FileProfile = {
  id: "normal-traffic",
  outputFile: "normal-traffic.log",
  baselineUserCount: 24,
  baselineTargetCount: 2350,
  minPostPutBaseline: 70,
  rangeStartUtc: new Date("2026-01-05T00:00:00Z"), // Monday
  rangeEndUtc: new Date("2026-01-17T00:00:00Z"), // exclusive — covers 2 full weekday work-weeks
  expectExfilBaseline: true,
  anomalyCounts: {
    burst: 2,
    exfil: 2,
    threatname: 3,
    malware: 3,
    repeatedBlocked: 2,
    offHours: 3,
    rareUa: 4,
  },
};

/**
 * `quick-demo.log` — small and dense, for the walkthrough recording: obvious
 * anomalies against a thin baseline, no need to scroll through thousands of
 * benign rows on camera. Still covers every rule type at least twice.
 */
export const QUICK_DEMO_PROFILE: FileProfile = {
  id: "quick-demo",
  outputFile: "quick-demo.log",
  baselineUserCount: 12,
  baselineTargetCount: 110,
  minPostPutBaseline: 34,
  rangeStartUtc: new Date("2026-02-02T00:00:00Z"), // Monday
  rangeEndUtc: new Date("2026-02-04T00:00:00Z"), // exclusive — Mon + Tue only, keeps everything tightly clustered
  expectExfilBaseline: true,
  anomalyCounts: {
    burst: 2,
    exfil: 2,
    threatname: 2,
    malware: 2,
    repeatedBlocked: 2,
    offHours: 2,
    rareUa: 2,
  },
};

/**
 * `clean-traffic.log` — negative control: pure baseline, zero injected
 * anomalies, proves the detector doesn't just flag everything.
 */
export const CLEAN_TRAFFIC_PROFILE: FileProfile = {
  id: "clean-traffic",
  outputFile: "clean-traffic.log",
  baselineUserCount: 16,
  baselineTargetCount: 300,
  minPostPutBaseline: 20,
  rangeStartUtc: new Date("2026-03-02T00:00:00Z"), // Monday
  rangeEndUtc: new Date("2026-03-13T00:00:00Z"), // exclusive — 2 full weekday work-weeks (Mon 3/2 - Fri 3/13)
  expectExfilBaseline: false,
  anomalyCounts: ZERO_ANOMALIES,
};
