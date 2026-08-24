/**
 * One injector function per v1 detection rule (DECISIONS.md §3, §14a). Each
 * injector produces events that cross the exact locked threshold for its
 * rule and a matching `AnswerKeyFact` describing why — the orchestrator
 * collects these facts, resolves final line numbers after the merged file is
 * sorted, and renders `examples/ANSWER_KEY.md` from them.
 *
 * Every instance uses a dedicated actor from the anomaly-actor pool
 * (`users.ts`), never a shared baseline employee, so injected patterns never
 * mix with — or get diluted by — ordinary baseline behavior for the same
 * identity.
 */
import { faker } from "@faker-js/faker";
import { HIGH_RISK_URL_CATEGORIES, type UrlCategory } from "@tenex/shared";
import type { SyntheticUser } from "./users";
import { BENIGN_CATEGORIES } from "./users";
import { urlForCategory, randomRealisticUserAgent, SCRIPTED_USER_AGENTS } from "./content";
import { addSeconds, isWeekdayUtc, BUSINESS_START_UTC_HOUR, BUSINESS_END_UTC_HOUR } from "./time-utils";
import { formatDatetime, type GenEvent } from "./wire-format";

export interface AnswerKeyFact {
  ruleType:
    | "burst_per_ip"
    | "bytes_out_exfil"
    | "threatname_hit"
    | "malware_category"
    | "repeated_blocked"
    | "off_hours"
    | "rare_scripted_user_agent";
  label: string;
  events: GenEvent[];
  /** Mutable — the exfil injector's reason is finalized once real z-scores are computed against the full dataset. */
  reason: string;
}

export interface InjectionResult {
  events: GenEvent[];
  fact: AnswerKeyFact;
}

// ---------------------------------------------------------------------------
// Burst-per-IP: ≥15 requests from one IP within a 60s window.
// ---------------------------------------------------------------------------
export function injectBurstPerIp(actor: SyntheticUser, startTime: Date, requestCount: number, label: string): InjectionResult {
  if (requestCount < 15) throw new Error("burst-per-IP injector requires requestCount >= 15 to clear the absolute floor");
  const GAP_SECONDS = 3; // requestCount <= 19 keeps the whole cluster inside one 60s window
  const category = faker.helpers.arrayElement(actor.preferredCategories);
  const useragent = randomRealisticUserAgent();

  const events: GenEvent[] = [];
  let t = startTime;
  for (let i = 0; i < requestCount; i++) {
    events.push({
      datetime: t,
      cip: actor.cip,
      login: actor.login,
      url: urlForCategory(category),
      action: "allowed",
      urlcat: category,
      threatname: null,
      respcode: 200,
      bytes_out: faker.number.int({ min: 60, max: 400 }),
      bytes_in: faker.number.int({ min: 500, max: 20_000 }),
      useragent,
      reqmethod: "GET",
    });
    t = addSeconds(t, GAP_SECONDS);
  }
  const lastTime = addSeconds(startTime, GAP_SECONDS * (requestCount - 1));
  const spanSeconds = GAP_SECONDS * (requestCount - 1);

  return {
    events,
    fact: {
      ruleType: "burst_per_ip",
      label,
      events,
      reason:
        `${requestCount} GET requests from cip=${actor.cip} (login=${actor.login}) within ${spanSeconds}s, ` +
        `${formatDatetime(startTime)} through ${formatDatetime(lastTime)} — exceeds the absolute floor of ` +
        `≥15 requests/60s for burst_per_ip (DECISIONS.md §14a).`,
    },
  };
}

// ---------------------------------------------------------------------------
// Exfil bytes_out: POST/PUT with z-score > 3 against the dataset's own POST/PUT baseline.
// Reason text is finalized by the orchestrator once real z-scores are known.
// ---------------------------------------------------------------------------
export function injectExfilBytesOut(actor: SyntheticUser, time: Date, bytesOutValue: number, label: string): InjectionResult {
  const category: UrlCategory = "File Sharing";
  const event: GenEvent = {
    datetime: time,
    cip: actor.cip,
    login: actor.login,
    url: urlForCategory(category),
    action: "allowed",
    urlcat: category,
    threatname: null,
    respcode: 200,
    bytes_out: bytesOutValue,
    bytes_in: faker.number.int({ min: 150, max: 900 }),
    useragent: randomRealisticUserAgent(),
    reqmethod: "POST",
  };
  return {
    events: [event],
    fact: {
      ruleType: "bytes_out_exfil",
      label,
      events: [event],
      // Placeholder — generate.ts overwrites this once the full dataset's POST/PUT mean/stddev are known.
      reason: `bytes_out=${bytesOutValue} on a POST event (z-score computed after full dataset assembly).`,
    },
  };
}

// ---------------------------------------------------------------------------
// threatname populated: direct signal, independent of urlcat (kept benign here on purpose).
// ---------------------------------------------------------------------------
export function injectThreatnameHit(actor: SyntheticUser, time: Date, threatname: string, category: UrlCategory, label: string): InjectionResult {
  const event: GenEvent = {
    datetime: time,
    cip: actor.cip,
    login: actor.login,
    url: urlForCategory(category),
    action: "blocked",
    urlcat: category,
    threatname,
    respcode: 403,
    bytes_out: faker.number.int({ min: 60, max: 400 }),
    bytes_in: faker.number.int({ min: 200, max: 2000 }),
    useragent: randomRealisticUserAgent(),
    reqmethod: "GET",
  };
  return {
    events: [event],
    fact: {
      ruleType: "threatname_hit",
      label,
      events: [event],
      reason:
        `threatname="${threatname}" is populated — direct signal for threatname_hit, independent of urlcat ` +
        `(here "${category}", a benign category, to show the rule fires on threatname alone).`,
    },
  };
}

// ---------------------------------------------------------------------------
// malware-category access: urlcat in the 4 high-risk categories, independent of threatname/action.
// ---------------------------------------------------------------------------
export function injectMalwareCategoryAccess(actor: SyntheticUser, time: Date, category: UrlCategory, label: string): InjectionResult {
  if (!(HIGH_RISK_URL_CATEGORIES as readonly string[]).includes(category)) {
    throw new Error(`injectMalwareCategoryAccess: "${category}" is not one of the high-risk categories`);
  }
  const event: GenEvent = {
    datetime: time,
    cip: actor.cip,
    login: actor.login,
    url: urlForCategory(category),
    action: "allowed",
    urlcat: category,
    threatname: null,
    respcode: 200,
    bytes_out: faker.number.int({ min: 60, max: 400 }),
    bytes_in: faker.number.int({ min: 200, max: 5000 }),
    useragent: randomRealisticUserAgent(),
    reqmethod: "GET",
  };
  return {
    events: [event],
    fact: {
      ruleType: "malware_category",
      label,
      events: [event],
      reason:
        `urlcat="${category}" is one of the 4 locked high-risk categories (Malware Sites / Phishing / ` +
        `Botnet Callback / Spyware or Adware) — direct signal for malware_category (threatname empty, ` +
        `action allowed here, to show the rule fires on category alone).`,
    },
  };
}

// ---------------------------------------------------------------------------
// repeated-blocked: ≥5 blocked events, same user/IP, within a 10-min window.
// ---------------------------------------------------------------------------
export function injectRepeatedBlocked(actor: SyntheticUser, startTime: Date, count: number, label: string): InjectionResult {
  if (count < 5) throw new Error("repeated-blocked injector requires count >= 5 to clear the trigger threshold");
  const GAP_SECONDS = 80; // count <= 7 keeps the whole cluster inside one 10-minute window
  const category = faker.helpers.arrayElement(BENIGN_CATEGORIES);
  const url = urlForCategory(category);
  const useragent = randomRealisticUserAgent();

  const events: GenEvent[] = [];
  let t = startTime;
  for (let i = 0; i < count; i++) {
    events.push({
      datetime: t,
      cip: actor.cip,
      login: actor.login,
      url,
      action: "blocked",
      urlcat: category,
      threatname: null,
      respcode: 403,
      bytes_out: faker.number.int({ min: 60, max: 300 }),
      bytes_in: faker.number.int({ min: 100, max: 800 }),
      useragent,
      reqmethod: "GET",
    });
    t = addSeconds(t, GAP_SECONDS);
  }
  const lastTime = addSeconds(startTime, GAP_SECONDS * (count - 1));
  const spanSeconds = GAP_SECONDS * (count - 1);

  return {
    events,
    fact: {
      ruleType: "repeated_blocked",
      label,
      events,
      reason:
        `${count} blocked events for login=${actor.login} (cip=${actor.cip}) against the same URL, within ` +
        `${spanSeconds}s (${formatDatetime(startTime)} through ${formatDatetime(lastTime)}, under the 10-min ` +
        `window) — exceeds the ≥5-blocked-in-10-min repeated_blocked threshold.`,
    },
  };
}

// ---------------------------------------------------------------------------
// off-hours: datetime outside 08:00-18:00 UTC on a weekday.
// ---------------------------------------------------------------------------
export function injectOffHours(actor: SyntheticUser, time: Date, category: UrlCategory, label: string): InjectionResult {
  const weekday = isWeekdayUtc(time);
  const hour = time.getUTCHours();
  if (weekday && hour >= BUSINESS_START_UTC_HOUR && hour < BUSINESS_END_UTC_HOUR) {
    throw new Error("injectOffHours: supplied time falls inside business hours — not actually off-hours");
  }
  const why = !weekday
    ? "falls on a Saturday/Sunday (UTC)"
    : hour < BUSINESS_START_UTC_HOUR
      ? `hour (${hour}:00 UTC) is before the 08:00 UTC business-hours start`
      : `hour (${hour}:00 UTC) is at/after the 18:00 UTC business-hours end`;

  const event: GenEvent = {
    datetime: time,
    cip: actor.cip,
    login: actor.login,
    url: urlForCategory(category),
    action: "allowed",
    urlcat: category,
    threatname: null,
    respcode: 200,
    bytes_out: faker.number.int({ min: 60, max: 400 }),
    bytes_in: faker.number.int({ min: 500, max: 20_000 }),
    useragent: randomRealisticUserAgent(),
    reqmethod: "GET",
  };
  return {
    events: [event],
    fact: {
      ruleType: "off_hours",
      label,
      events: [event],
      reason: `datetime=${formatDatetime(time)} ${why} — outside the 08:00-18:00 UTC weekday business-hours window (off_hours rule).`,
    },
  };
}

// ---------------------------------------------------------------------------
// rare/scripted user-agent: useragent in {curl, python-requests, Wget, empty string}.
// ---------------------------------------------------------------------------
export function injectRareScriptedUserAgent(actor: SyntheticUser, time: Date, useragent: string, category: UrlCategory, label: string): InjectionResult {
  if (!SCRIPTED_USER_AGENTS.includes(useragent)) {
    throw new Error(`injectRareScriptedUserAgent: "${useragent}" is not one of the known scripted signatures`);
  }
  const event: GenEvent = {
    datetime: time,
    cip: actor.cip,
    login: actor.login,
    url: urlForCategory(category),
    action: "allowed",
    urlcat: category,
    threatname: null,
    respcode: 200,
    bytes_out: faker.number.int({ min: 60, max: 400 }),
    bytes_in: faker.number.int({ min: 200, max: 5000 }),
    useragent,
    reqmethod: "GET",
  };
  return {
    events: [event],
    fact: {
      ruleType: "rare_scripted_user_agent",
      label,
      events: [event],
      reason: `useragent="${useragent === "" ? "(empty string)" : useragent}" matches a known scripted/tooling signature (curl/python-requests/Wget/empty) — direct signature match for rare_scripted_user_agent.`,
    },
  };
}
