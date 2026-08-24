/**
 * "Normal" traffic generator — realistic mixed browsing with light per-user
 * session shaping (Phase 3 brief), engineered so it never accidentally
 * crosses any of the 7 rule thresholds in DECISIONS.md §14a on its own.
 * Anomalies are injected separately (`anomaly-injectors.ts`) and merged in
 * by the orchestrator.
 */
import { faker } from "@faker-js/faker";
import type { SyntheticUser } from "./users";
import { BENIGN_CATEGORIES } from "./users";
import { urlForCategory, randomRealisticUserAgent } from "./content";
import {
  BUSINESS_START_UTC_HOUR,
  BUSINESS_END_UTC_HOUR,
  isWeekdayUtc,
  addSeconds,
} from "./time-utils";
import type { GenEvent } from "./wire-format";

const SESSION_GAP_MS = 5 * 60 * 1000; // min gap between two sessions for the same user
const TOPUP_GAP_MS = 60 * 1000; // min gap for a standalone top-up event vs. any existing event for that user (keeps bursts from contaminating baseline)
const BLOCKED_LOOKBACK_MS = 10 * 60 * 1000; // matches the repeated-blocked rule's own window
const MAX_BLOCKED_IN_WINDOW_BASELINE = 2; // stay well under the ≥5 trigger threshold

export interface BaselineParams {
  users: SyntheticUser[];
  targetCount: number;
  rangeStartUtc: Date;
  rangeEndUtc: Date;
  /** Guarantees at least this many POST/PUT baseline events exist (exfil rule needs ≥30 samples, DECISIONS.md §14a). */
  minPostPutCount: number;
}

/** All UTC weekday "day starts" (00:00) between start (inclusive) and end (exclusive). */
export function businessDaysInRange(start: Date, end: Date): Date[] {
  const days: Date[] = [];
  const cursor = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate()));
  while (cursor.getTime() < end.getTime()) {
    if (isWeekdayUtc(cursor)) days.push(new Date(cursor));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return days;
}

/**
 * A uniformly-random moment inside business hours on a random day from `days`.
 * `marginSeconds` shrinks the window from the end (e.g. so a multi-event
 * session starting at the returned moment can't drift past 18:00 UTC as
 * later events in the session add their own gaps).
 */
export function randomBusinessMoment(days: Date[], marginSeconds = 0): Date {
  const day = faker.helpers.arrayElement(days);
  const startSec = BUSINESS_START_UTC_HOUR * 3600;
  const endSec = BUSINESS_END_UTC_HOUR * 3600 - marginSeconds;
  if (endSec <= startSec) throw new Error("randomBusinessMoment: marginSeconds too large for the business-hours window");
  const offsetSec = faker.number.int({ min: startSec, max: endSec - 1 });
  return new Date(Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate(), 0, 0, offsetSec));
}

function farEnough(candidateMs: number, existingMs: number[], gapMs: number): boolean {
  return existingMs.every((t) => Math.abs(t - candidateMs) >= gapMs);
}

type BaselineMethod = "GET" | "POST" | "PUT" | "HEAD" | "OPTIONS";

function pickBaselineMethod(): BaselineMethod {
  return faker.helpers.weightedArrayElement([
    { weight: 62, value: "GET" },
    { weight: 20, value: "POST" },
    { weight: 8, value: "PUT" },
    { weight: 6, value: "HEAD" },
    { weight: 4, value: "OPTIONS" },
  ]);
}

function postPutBytesOut(): number {
  // Deliberately tight range so injected exfil outliers stand well clear of the baseline distribution.
  return faker.number.int({ min: 300, max: 1800 });
}

function getLikeBytesOut(): number {
  return faker.number.int({ min: 60, max: 400 });
}

function responseBytesIn(category: string): number {
  if (category === "Streaming Media") return faker.number.int({ min: 50_000, max: 500_000 });
  return faker.number.int({ min: 500, max: 40_000 });
}

interface BuildContext {
  eventTimesByLogin: Map<string, number[]>;
  blockedTimesByLogin: Map<string, number[]>;
}

function recordEventTime(ctx: BuildContext, login: string, ms: number) {
  const arr = ctx.eventTimesByLogin.get(login) ?? [];
  arr.push(ms);
  ctx.eventTimesByLogin.set(login, arr);
}

function countBlockedInWindow(ctx: BuildContext, login: string, ms: number): number {
  const arr = ctx.blockedTimesByLogin.get(login) ?? [];
  return arr.filter((t) => Math.abs(t - ms) <= BLOCKED_LOOKBACK_MS).length;
}

function recordBlocked(ctx: BuildContext, login: string, ms: number) {
  const arr = ctx.blockedTimesByLogin.get(login) ?? [];
  arr.push(ms);
  ctx.blockedTimesByLogin.set(login, arr);
}

function makeSession(user: SyntheticUser, startTime: Date, ctx: BuildContext): GenEvent[] {
  const length = faker.number.int({ min: 3, max: 8 });
  const useragent = randomRealisticUserAgent();
  const events: GenEvent[] = [];
  let t = startTime;

  for (let i = 0; i < length; i++) {
    const category = faker.datatype.boolean({ probability: 0.75 })
      ? faker.helpers.arrayElement(user.preferredCategories)
      : faker.helpers.arrayElement(BENIGN_CATEGORIES);
    const method = pickBaselineMethod();
    const isPostPut = method === "POST" || method === "PUT";
    const bytes_out = isPostPut ? postPutBytesOut() : getLikeBytesOut();
    const bytes_in = responseBytesIn(category);

    let action: GenEvent["action"] = "allowed";
    let respcode: number = faker.helpers.arrayElement([200, 200, 200, 204, 301, 302]);

    const ms = t.getTime();
    const wouldBlock = faker.datatype.boolean({ probability: 0.03 });
    if (wouldBlock && countBlockedInWindow(ctx, user.login, ms) < MAX_BLOCKED_IN_WINDOW_BASELINE) {
      action = "blocked";
      respcode = faker.helpers.arrayElement([403, 407]);
      recordBlocked(ctx, user.login, ms);
    }

    events.push({
      datetime: t,
      cip: user.cip,
      login: user.login,
      url: urlForCategory(category),
      action,
      urlcat: category,
      threatname: null,
      respcode,
      bytes_out,
      bytes_in,
      useragent,
      reqmethod: method,
    });
    recordEventTime(ctx, user.login, ms);

    t = addSeconds(t, faker.number.int({ min: 5, max: 40 }));
  }

  return events;
}

const POSTPUT_TOPUP_CATEGORIES = ["Business", "File Sharing", "Technology"] as const;

function makeStandalonePostPutEvent(user: SyntheticUser, time: Date): GenEvent {
  const category = faker.helpers.arrayElement(POSTPUT_TOPUP_CATEGORIES);
  const method: GenEvent["reqmethod"] = faker.helpers.arrayElement(["POST", "PUT"]);
  return {
    datetime: time,
    cip: user.cip,
    login: user.login,
    url: urlForCategory(category),
    action: "allowed",
    urlcat: category,
    threatname: null,
    respcode: faker.helpers.arrayElement([200, 201, 204]),
    bytes_out: postPutBytesOut(),
    bytes_in: responseBytesIn(category),
    useragent: randomRealisticUserAgent(),
    reqmethod: method,
  };
}

export function generateBaseline(params: BaselineParams): GenEvent[] {
  const { users, targetCount, rangeStartUtc, rangeEndUtc, minPostPutCount } = params;
  if (minPostPutCount >= targetCount) {
    throw new Error("minPostPutCount must be smaller than targetCount");
  }

  const days = businessDaysInRange(rangeStartUtc, rangeEndUtc);
  if (days.length === 0) throw new Error("Date range contains no UTC weekdays");

  const ctx: BuildContext = { eventTimesByLogin: new Map(), blockedTimesByLogin: new Map() };
  const sessionStartsByLogin = new Map<string, number[]>();

  const mainLoopBudget = targetCount - minPostPutCount;
  const events: GenEvent[] = [];

  let guard = 0;
  while (events.length < mainLoopBudget) {
    guard++;
    if (guard > mainLoopBudget * 50) {
      throw new Error("generateBaseline: exceeded retry guard while scheduling sessions");
    }
    const user = faker.helpers.arrayElement(users);
    // Margin covers the worst case a session can drift: up to 7 gaps of up to 40s each (280s) before the
    // session's own bytes are done — without this, a session starting near 17:59 could spill past 18:00 UTC.
    const candidate = randomBusinessMoment(days, 300);
    const candidateMs = candidate.getTime();
    const priorStarts = sessionStartsByLogin.get(user.login) ?? [];
    if (!farEnough(candidateMs, priorStarts, SESSION_GAP_MS)) continue;

    priorStarts.push(candidateMs);
    sessionStartsByLogin.set(user.login, priorStarts);

    const session = makeSession(user, candidate, ctx);
    const remaining = mainLoopBudget - events.length;
    events.push(...session.slice(0, remaining));
  }

  // Top up POST/PUT volume so the exfil rule's ≥30-sample statistical floor is always cleared with margin.
  let topUpGuard = 0;
  let topUpAdded = 0;
  while (topUpAdded < minPostPutCount) {
    topUpGuard++;
    if (topUpGuard > minPostPutCount * 50) {
      throw new Error("generateBaseline: exceeded retry guard while scheduling POST/PUT top-up");
    }
    const user = faker.helpers.arrayElement(users);
    const candidate = randomBusinessMoment(days);
    const candidateMs = candidate.getTime();
    const existing = ctx.eventTimesByLogin.get(user.login) ?? [];
    if (!farEnough(candidateMs, existing, TOPUP_GAP_MS)) continue;

    const event = makeStandalonePostPutEvent(user, candidate);
    events.push(event);
    recordEventTime(ctx, user.login, candidateMs);
    topUpAdded++;
  }

  events.sort((a, b) => a.datetime.getTime() - b.datetime.getTime());
  return events;
}
