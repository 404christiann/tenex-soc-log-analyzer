/**
 * Orchestrator for Phase 3: builds the three well-formed example log files
 * plus the malformed edge-case file, plus `ANSWER_KEY.md` and `README.md`.
 *
 * Deterministic: a single `faker.seed(42)` call at the very top, followed by
 * a fixed, unconditional sequence of faker calls (no wall-clock time, no
 * crypto randomness, no I/O-dependent branching) — running this script twice
 * produces byte-identical output every time. Must be run from the repo root
 * (`npm run generate-logs`), since output paths are resolved against `cwd`.
 */
import fs from "node:fs";
import path from "node:path";
import { faker } from "@faker-js/faker";
import { HIGH_RISK_URL_CATEGORIES } from "@tenex/shared";

import { buildUserPool, buildAnomalyActorPool, BENIGN_CATEGORIES, type SyntheticUser } from "./users";
import { generateBaseline, businessDaysInRange, randomBusinessMoment } from "./baseline";
import { SCRIPTED_USER_AGENTS } from "./content";
import { isWeekdayUtc } from "./time-utils";
import {
  injectBurstPerIp,
  injectExfilBytesOut,
  injectThreatnameHit,
  injectMalwareCategoryAccess,
  injectRepeatedBlocked,
  injectOffHours,
  injectRareScriptedUserAgent,
  type AnswerKeyFact,
} from "./anomaly-injectors";
import { runSelfCheck, computeExfilStats } from "./self-check";
import { serializeEvent, type GenEvent } from "./wire-format";
import { resolveLineNumbers, renderFileSection, renderAnswerKey } from "./answer-key";
import { buildMalformedFileBuffer } from "./malformed";
import {
  NORMAL_TRAFFIC_PROFILE,
  QUICK_DEMO_PROFILE,
  CLEAN_TRAFFIC_PROFILE,
  totalAnomalyActors,
  type FileProfile,
} from "./profiles";

const OUTPUT_DIR = path.resolve(process.cwd(), "examples");

const THREATNAMES = ["Win32.Trojan.Generic", "Emotet.C2", "Cobalt.Strike.Beacon", "Agent.Tesla.Keylogger"];
const BURST_REQUEST_COUNTS = [17, 19];
const BLOCKED_CLUSTER_COUNTS = [6, 7];

function offHoursMoment(rangeStartUtc: Date, variantIndex: number): Date {
  const mod = variantIndex % 3;
  if (mod === 0) {
    // Same weekday as the range start, before business hours (00:00-06:59 UTC).
    return new Date(
      Date.UTC(
        rangeStartUtc.getUTCFullYear(),
        rangeStartUtc.getUTCMonth(),
        rangeStartUtc.getUTCDate(),
        faker.number.int({ min: 0, max: 6 }),
        faker.number.int({ min: 0, max: 59 }),
      ),
    );
  }
  if (mod === 1) {
    // Same weekday, after business hours (19:00-23:59 UTC).
    return new Date(
      Date.UTC(
        rangeStartUtc.getUTCFullYear(),
        rangeStartUtc.getUTCMonth(),
        rangeStartUtc.getUTCDate(),
        faker.number.int({ min: 19, max: 23 }),
        faker.number.int({ min: 0, max: 59 }),
      ),
    );
  }
  // The next weekend day on/after the range start.
  const d = new Date(rangeStartUtc);
  while (isWeekdayUtc(d)) d.setUTCDate(d.getUTCDate() + 1);
  d.setUTCHours(faker.number.int({ min: 9, max: 18 }), faker.number.int({ min: 0, max: 59 }), 0, 0);
  return d;
}

/** Iteratively bumps injected exfil bytes_out values until each clears its target z-score against the FULL dataset. */
function calibrateExfil(allEvents: GenEvent[], instances: { event: GenEvent; targetZ: number }[]) {
  for (let iter = 0; iter < 10; iter++) {
    const stats = computeExfilStats(allEvents);
    let allGood = true;
    for (const inst of instances) {
      const z = stats.zByEvent.get(inst.event) ?? 0;
      if (z < inst.targetZ) {
        allGood = false;
        const needed = stats.postPutMean + (inst.targetZ + 0.5) * stats.postPutStddev;
        inst.event.bytes_out = Math.max(Math.round(needed), Math.round(inst.event.bytes_out * 1.4));
      }
    }
    if (allGood) break;
  }
}

interface BuiltFile {
  events: GenEvent[];
  facts: AnswerKeyFact[];
}

function buildFile(profile: FileProfile): BuiltFile {
  const baselineUsers = buildUserPool(profile.baselineUserCount);
  const baselineLogins = new Set(baselineUsers.map((u) => u.login));
  const baseline = generateBaseline({
    users: baselineUsers,
    targetCount: profile.baselineTargetCount,
    rangeStartUtc: profile.rangeStartUtc,
    rangeEndUtc: profile.rangeEndUtc,
    minPostPutCount: profile.minPostPutBaseline,
  });

  const counts = profile.anomalyCounts;
  const actorPool = buildAnomalyActorPool(totalAnomalyActors(counts));
  let actorIdx = 0;
  const nextActor = (): SyntheticUser => {
    if (actorIdx >= actorPool.length) throw new Error(`buildFile(${profile.id}): ran out of anomaly actors`);
    return actorPool[actorIdx++];
  };

  const days = businessDaysInRange(profile.rangeStartUtc, profile.rangeEndUtc);
  const injected: GenEvent[] = [];
  const facts: AnswerKeyFact[] = [];
  const exfilInstances: { event: GenEvent; targetZ: number }[] = [];

  for (let i = 0; i < counts.burst; i++) {
    const actor = nextActor();
    const start = randomBusinessMoment(days);
    const requestCount = BURST_REQUEST_COUNTS[i % BURST_REQUEST_COUNTS.length];
    const { events, fact } = injectBurstPerIp(actor, start, requestCount, `Burst-per-IP #${i + 1}`);
    injected.push(...events);
    facts.push(fact);
  }

  for (let i = 0; i < counts.exfil; i++) {
    const actor = nextActor();
    const time = randomBusinessMoment(days);
    const tier: "moderate" | "high" = i % 2 === 0 ? "moderate" : "high";
    const initialGuess = tier === "moderate" ? 6000 : 30_000;
    const targetZ = tier === "moderate" ? 3.8 : 7.0;
    const { events, fact } = injectExfilBytesOut(actor, time, initialGuess, `Exfil bytes_out #${i + 1} (${tier} tier)`);
    injected.push(...events);
    facts.push(fact);
    exfilInstances.push({ event: events[0], targetZ });
  }

  for (let i = 0; i < counts.threatname; i++) {
    const actor = nextActor();
    const time = randomBusinessMoment(days);
    const threatname = THREATNAMES[i % THREATNAMES.length];
    const category = BENIGN_CATEGORIES[i % BENIGN_CATEGORIES.length];
    const { events, fact } = injectThreatnameHit(actor, time, threatname, category, `threatname hit #${i + 1}`);
    injected.push(...events);
    facts.push(fact);
  }

  for (let i = 0; i < counts.malware; i++) {
    const actor = nextActor();
    const time = randomBusinessMoment(days);
    const category = HIGH_RISK_URL_CATEGORIES[i % HIGH_RISK_URL_CATEGORIES.length];
    const { events, fact } = injectMalwareCategoryAccess(actor, time, category, `Malware-category access #${i + 1}`);
    injected.push(...events);
    facts.push(fact);
  }

  for (let i = 0; i < counts.repeatedBlocked; i++) {
    const actor = nextActor();
    const start = randomBusinessMoment(days);
    const count = BLOCKED_CLUSTER_COUNTS[i % BLOCKED_CLUSTER_COUNTS.length];
    const { events, fact } = injectRepeatedBlocked(actor, start, count, `Repeated-blocked #${i + 1}`);
    injected.push(...events);
    facts.push(fact);
  }

  for (let i = 0; i < counts.offHours; i++) {
    const actor = nextActor();
    const time = offHoursMoment(profile.rangeStartUtc, i);
    const category = BENIGN_CATEGORIES[i % BENIGN_CATEGORIES.length];
    const { events, fact } = injectOffHours(actor, time, category, `Off-hours access #${i + 1}`);
    injected.push(...events);
    facts.push(fact);
  }

  for (let i = 0; i < counts.rareUa; i++) {
    const actor = nextActor();
    const time = randomBusinessMoment(days);
    const ua = SCRIPTED_USER_AGENTS[i % SCRIPTED_USER_AGENTS.length];
    const category = BENIGN_CATEGORIES[i % BENIGN_CATEGORIES.length];
    const { events, fact } = injectRareScriptedUserAgent(actor, time, ua, category, `Rare/scripted UA #${i + 1}`);
    injected.push(...events);
    facts.push(fact);
  }

  if (actorIdx !== actorPool.length) {
    throw new Error(`buildFile(${profile.id}): actor pool size mismatch — used ${actorIdx}, built ${actorPool.length}`);
  }

  const allEvents = [...baseline, ...injected];

  if (exfilInstances.length > 0) {
    calibrateExfil(allEvents, exfilInstances);
  }

  allEvents.sort((a, b) => a.datetime.getTime() - b.datetime.getTime());

  const report = runSelfCheck({
    fileName: profile.outputFile,
    events: allEvents,
    baselineLogins,
    expectExfilBaseline: profile.expectExfilBaseline,
  });

  for (const fact of facts) {
    if (fact.ruleType !== "bytes_out_exfil") continue;
    const event = fact.events[0];
    const z = report.exfilZByEvent.get(event);
    if (z === undefined) throw new Error(`buildFile(${profile.id}): missing z-score for exfil fact "${fact.label}"`);
    fact.reason =
      `bytes_out=${event.bytes_out} on a POST event — z-score ${z.toFixed(2)} against the file's own POST/PUT ` +
      `baseline (mean=${report.postPutMean.toFixed(1)}, stddev=${report.postPutStddev.toFixed(1)}, n=${report.postPutSampleCount}) ` +
      `— exceeds the z>3 bytes_out_exfil threshold` +
      (z >= 6 ? " (z >= 6, high-confidence tier)." : ".");
  }

  return { events: allEvents, facts };
}

const FILE_LABELS: Record<string, string> = {
  "normal-traffic": "normal-traffic.log — main haystack demo",
  "quick-demo": "quick-demo.log — dense demo for the walkthrough recording",
  "clean-traffic": "clean-traffic.log — negative control",
};

function renderExamplesReadme(rowCounts: Record<string, number>, validLineCount: number, malformedLineCount: number): string {
  return `# Example log files

Four synthetic Zscaler-NSS-style proxy logs (DECISIONS.md §1, §13, §14a), generated
deterministically by \`scripts/generate-logs/generate.ts\` (\`@faker-js/faker\`, \`faker.seed(42)\`).
Regenerate with \`npm run generate-logs\` from the repo root — the output is byte-identical every
run given the same generator code. See \`ANSWER_KEY.md\` for exactly which rows are injected
anomalies and why; that file is a development-time validation artifact only, never read by the
detection code itself.

## \`normal-traffic.log\` (${rowCounts["normal-traffic.log"]} rows)

The main "needle in a haystack" demo. Realistic mixed traffic from a pool of 24 synthetic
employees browsing believable per-user session bursts (mostly benign categories, business
hours, occasional light POST/PUT and rare blocks) across two full work weeks, with at least 2
injected instances of every one of the 7 v1 anomaly rules embedded among the noise. This is the
file that best demonstrates the detector separating real signal from a large, realistic
baseline rather than flagging everything.

## \`quick-demo.log\` (${rowCounts["quick-demo.log"]} rows)

A small, dense file built for the screen-recording walkthrough: a thin two-day baseline against
the same 7 anomaly types, each still appearing at least twice, but packed close enough together
that every flagged row is visible without scrolling through thousands of benign lines on camera.

## \`clean-traffic.log\` (${rowCounts["clean-traffic.log"]} rows)

A pure negative control — ordinary baseline traffic only, zero injected anomalies, and verified
at generation time (\`scripts/generate-logs/self-check.ts\`) to never accidentally cross any rule
threshold on its own. Its purpose is to prove the detector's false-positive rate is actually
zero on this file, not just assumed to be.

## \`malformed-edge-cases.log\` (${validLineCount} valid + ${malformedLineCount} malformed lines)

Deliberately broken input: lines truncated mid-field, lines with a key entirely missing (not
just present-and-empty), lines with non-UTF-8 byte sequences spliced into a field value, and
lines with an unescaped tab character inside a value that shifts the tab-delimited field count.
Valid, well-formed lines are interspersed throughout, so a correct parser should come away with
some successfully parsed events *and* a set of per-line errors — proving graceful degradation
(and doubling as evidence for the file-upload input-validation security must-have, DECISIONS.md
§5) rather than the whole file failing to parse.
`;
}

function main() {
  faker.seed(42);
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });

  const profiles: FileProfile[] = [NORMAL_TRAFFIC_PROFILE, QUICK_DEMO_PROFILE, CLEAN_TRAFFIC_PROFILE];
  const sections: string[] = [];
  const rowCounts: Record<string, number> = {};

  for (const profile of profiles) {
    const { events, facts } = buildFile(profile);
    const serialized = events.map(serializeEvent).join("\n") + "\n";
    fs.writeFileSync(path.join(OUTPUT_DIR, profile.outputFile), serialized, "utf8");
    rowCounts[profile.outputFile] = events.length;

    const resolved = resolveLineNumbers(events, facts);
    sections.push(renderFileSection(FILE_LABELS[profile.id] ?? profile.id, profile.outputFile, events.length, resolved));

    console.log(`Wrote ${profile.outputFile}: ${events.length} rows (${facts.length} injected anomaly instances)`);
  }

  const { buffer, validLineCount, malformedLineCount } = buildMalformedFileBuffer();
  fs.writeFileSync(path.join(OUTPUT_DIR, "malformed-edge-cases.log"), buffer);
  console.log(`Wrote malformed-edge-cases.log: ${validLineCount} valid + ${malformedLineCount} malformed lines`);

  fs.writeFileSync(path.join(OUTPUT_DIR, "ANSWER_KEY.md"), renderAnswerKey(sections), "utf8");
  fs.writeFileSync(path.join(OUTPUT_DIR, "README.md"), renderExamplesReadme(rowCounts, validLineCount, malformedLineCount), "utf8");

  console.log("Done.");
}

main();
