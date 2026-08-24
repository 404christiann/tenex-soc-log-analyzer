/**
 * Synthetic user/IP pool — "light per-user session shaping" per the Phase 3
 * brief: a fixed set of employees, each with a stable IP and a couple of
 * preferred benign categories, so baseline traffic reads as believable
 * per-person browsing bursts rather than uniform noise.
 */
import { faker } from "@faker-js/faker";
import type { UrlCategory } from "@tenex/shared";

export const BENIGN_CATEGORIES: UrlCategory[] = [
  "Business",
  "Social Networking",
  "Streaming Media",
  "News & Media",
  "Technology",
  "Shopping",
  "Webmail",
  "File Sharing",
];

export interface SyntheticUser {
  login: string;
  cip: string;
  /** 2-3 benign categories this person browses most — drives session shaping. */
  preferredCategories: UrlCategory[];
}

function buildPool(count: number, cidrBlock: string): SyntheticUser[] {
  const users: SyntheticUser[] = [];
  const usedLogins = new Set<string>();
  const usedIps = new Set<string>();

  for (let i = 0; i < count; i++) {
    let login = faker.internet.username().toLowerCase().replace(/[^a-z0-9._-]/g, "");
    while (usedLogins.has(login)) {
      login = `${login}${faker.number.int({ min: 2, max: 99 })}`;
    }
    usedLogins.add(login);

    let cip = faker.internet.ipv4({ cidrBlock });
    while (usedIps.has(cip)) {
      cip = faker.internet.ipv4({ cidrBlock });
    }
    usedIps.add(cip);

    const shuffled = faker.helpers.shuffle(BENIGN_CATEGORIES);
    const preferredCategories = shuffled.slice(0, faker.number.int({ min: 2, max: 3 }));

    users.push({ login, cip, preferredCategories });
  }

  return users;
}

/**
 * Builds a deterministic pool of `count` ordinary baseline employees. Call
 * order matters for reproducibility — always build the full pool for a file
 * in one shot, immediately after `faker.seed()`, before any other faker
 * calls for that file.
 */
export function buildUserPool(count: number): SyntheticUser[] {
  return buildPool(count, "10.4.0.0/16");
}

/**
 * Builds a deterministic pool of `count` dedicated "anomaly actor" identities
 * — never used for ordinary baseline traffic, only as the actor behind an
 * injected anomaly instance. Kept on a distinct /16 purely so an analyst
 * skimming the file can visually separate baseline noise (10.4.x.x) from
 * anomaly actors (10.9.x.x); the detection rules never look at the IP range
 * itself.
 */
export function buildAnomalyActorPool(count: number): SyntheticUser[] {
  return buildPool(count, "10.9.0.0/16");
}
