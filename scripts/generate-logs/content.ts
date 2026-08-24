/**
 * Realistic-looking content pools: user agents and per-category
 * domains/paths. Kept as fixed lists (not faker-generated free text) so the
 * "rare/scripted user-agent (statistical, <1%)" rule never fires by
 * accident on baseline traffic — every baseline UA is drawn from a small,
 * evenly-reused pool, comfortably above the 1% floor in every output file.
 */
import { faker } from "@faker-js/faker";
import type { UrlCategory } from "@tenex/shared";

/** Realistic desktop/mobile browser UAs — the *only* UAs baseline traffic ever uses. */
export const REALISTIC_USER_AGENTS: string[] = [
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.6 Safari/605.1.15",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:130.0) Gecko/20100101 Firefox/130.0",
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36",
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.6 Mobile/15E148 Safari/604.1",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36 Edg/128.0.0.0",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36",
  "Mozilla/5.0 (iPad; CPU OS 17_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.6 Mobile/15E148 Safari/604.1",
];

/** Known-scripted/tooling UAs — the exact signature set named in the take-home brief. */
export const SCRIPTED_USER_AGENTS: string[] = [
  "curl/8.4.0",
  "python-requests/2.31.0",
  "Wget/1.21.3",
  "",
];

interface CategorySite {
  category: UrlCategory;
  domains: string[];
  paths: string[];
}

const CATEGORY_SITES: CategorySite[] = [
  {
    category: "Business",
    domains: ["salesforce.com", "workday.com", "docusign.net", "zoom.us", "atlassian.net", "slack.com"],
    paths: ["/dashboard", "/reports/quarterly", "/meetings/join", "/tickets", "/docs/shared", "/login"],
  },
  {
    category: "Social Networking",
    domains: ["linkedin.com", "facebook.com", "x.com", "instagram.com"],
    paths: ["/feed", "/notifications", "/messages", "/profile", "/explore"],
  },
  {
    category: "Streaming Media",
    domains: ["youtube.com", "netflix.com", "spotify.com", "twitch.tv"],
    paths: ["/watch", "/browse", "/playlist", "/live", "/search"],
  },
  {
    category: "News & Media",
    domains: ["nytimes.com", "bbc.com", "reuters.com", "cnn.com"],
    paths: ["/world", "/business", "/technology", "/article", "/live-updates"],
  },
  {
    category: "Technology",
    domains: ["github.com", "stackoverflow.com", "npmjs.com", "aws.amazon.com", "docs.microsoft.com"],
    paths: ["/repo/issues", "/questions", "/package", "/console", "/docs"],
  },
  {
    category: "Shopping",
    domains: ["amazon.com", "ebay.com", "walmart.com", "target.com"],
    paths: ["/cart", "/product", "/orders", "/deals", "/checkout"],
  },
  {
    category: "Webmail",
    domains: ["mail.google.com", "outlook.office.com", "mail.yahoo.com"],
    paths: ["/inbox", "/compose", "/sent", "/calendar"],
  },
  {
    category: "File Sharing",
    domains: ["drive.google.com", "dropbox.com", "box.com", "wetransfer.com"],
    paths: ["/folder", "/upload", "/share", "/download"],
  },
  {
    category: "Uncategorized",
    domains: ["internal-tool-42.corp.local", "vendor-portal-xyz.example.net"],
    paths: ["/", "/status", "/api/ping"],
  },
  {
    category: "Malware Sites",
    domains: ["free-cracked-software.ru", "totally-legit-update.cc", "download-hub-premium.tk"],
    paths: ["/download.exe", "/setup", "/update.php", "/installer"],
  },
  {
    category: "Phishing",
    domains: ["secure-login-verify.com", "account-update-portal.info", "banking-alert-service.xyz"],
    paths: ["/login", "/verify-account", "/reset-password", "/confirm"],
  },
  {
    category: "Botnet Callback",
    domains: ["c2-relay-node91.top", "beacon-check.duckdns.org", "cdn-sync-service.icu"],
    paths: ["/checkin", "/beacon", "/task", "/gate.php"],
  },
  {
    category: "Spyware or Adware",
    domains: ["adtrack-metrics.biz", "freegame-bundle-installer.win", "toolbar-update-service.pw"],
    paths: ["/track", "/install-bundle", "/collect", "/ads/serve"],
  },
];

const CATEGORY_SITE_MAP: Map<UrlCategory, CategorySite> = new Map(
  CATEGORY_SITES.map((c) => [c.category, c]),
);

/** Builds a plausible URL for the given category, deterministically off the shared faker instance. */
export function urlForCategory(category: UrlCategory): string {
  const site = CATEGORY_SITE_MAP.get(category);
  if (!site) throw new Error(`No content pool registered for urlcat "${category}"`);
  const domain = faker.helpers.arrayElement(site.domains);
  const path = faker.helpers.arrayElement(site.paths);
  const includeQuery = faker.datatype.boolean({ probability: 0.35 });
  const query = includeQuery ? `?id=${faker.string.alphanumeric(6)}&ref=${faker.string.alphanumeric(4)}` : "";
  return `https://${domain}${path}${query}`;
}

export function randomRealisticUserAgent(): string {
  return faker.helpers.arrayElement(REALISTIC_USER_AGENTS);
}
