import path from "node:path";
import { test, expect, type Page } from "@playwright/test";
import { EXAMPLES_DIR, signIn, uniqueEmail } from "./helpers";

/**
 * Full upload -> tabbed results flow (DECISIONS.md §9/§10/§14a/§14c),
 * against the real pipeline (Express -> parse -> rule engine -> LLM judge ->
 * Supabase, then the on-demand streaming summary endpoint). A REAL
 * `ANTHROPIC_API_KEY` is configured in this environment (apps/api/.env), so
 * this exercises genuine live streaming on the Timeline tab: the SSE flow
 * must complete and real model-generated summary text must render. Model
 * output varies run to run, so the assertions check that the flow reached
 * its honest terminal state (real prose, no degraded-state banner) rather
 * than any exact live output content. Adaptive thinking is also the model's
 * call — a run may or may not surface a "Thought for Ns" reasoning fold, so
 * that part is verified only when it occurred.
 */

// Upload (~10-20s with the live judge) plus a live streaming generation
// (~10-45s) comfortably exceed the suite's default 60s budget.
test.setTimeout(180_000);

/** The three severity sub-tab labels on the Anomalies tab (DECISIONS.md §14c). */
const SEVERITY_TABS = ["High", "Medium", "Low"] as const;

/**
 * The judge's live ±15 confidence nudge decides which severity tier an
 * anomaly lands in, so the target row's sub-tab isn't knowable in advance —
 * click through the tiers until the row is visible.
 */
async function revealAnomalyRow(page: Page, ruleLabel: string) {
  const row = page.locator('div[id^="anomaly-"]').filter({ hasText: ruleLabel }).first();
  for (const tier of SEVERITY_TABS) {
    await page.getByRole("tab", { name: new RegExp(`^${tier} \\d+$`) }).click();
    if (await row.isVisible()) {
      return row;
    }
  }
  throw new Error(`No visible anomaly row for "${ruleLabel}" in any severity sub-tab`);
}

test("upload quick-demo.log: staged loading, then tabbed results — live streaming Timeline summary, expandable Anomalies table, paginated Events", async ({
  page,
}) => {
  await signIn(page, uniqueEmail("upload"));

  const fileInput = page.locator('input[type="file"]');
  await fileInput.setInputFiles(path.join(EXAMPLES_DIR, "quick-demo.log"));

  // Staged client-side loading state for the synchronous upload call
  // (apps/web/src/components/upload-file-card.tsx) — real stages topped
  // with the rotating generic flavor line ("Analyzing…" is its first
  // phrase). §14c: there is no "Summarizing" stage anymore and the upload
  // response carries no summary.
  await expect(page.getByText(/Analyzing/)).toBeVisible({ timeout: 5_000 });
  await expect(page.getByText("quick-demo.log", { exact: false })).toBeVisible();

  await page.waitForURL(/\/logs\/[0-9a-f-]+$/, { timeout: 45_000 });

  // Fixed file header above the tab bar (§14c): filename + "Complete" badge.
  await expect(page.getByRole("heading", { name: "quick-demo.log" })).toBeVisible();
  await expect(page.getByText("Complete", { exact: true })).toBeVisible();

  // The three top-level tabs, Timeline active by default.
  const timelineTab = page.getByRole("tab", { name: "Timeline" });
  const anomaliesTab = page.getByRole("tab", { name: /^Anomalies \d+$/ });
  const eventsTab = page.getByRole("tab", { name: "Events" });
  await expect(timelineTab).toBeVisible();
  await expect(anomaliesTab).toBeVisible();
  await expect(eventsTab).toBeVisible();
  await expect(timelineTab).toHaveAttribute("aria-selected", "true");

  // --- Timeline tab: REAL streaming summary over SSE (§14c) ---
  // Landing on the page opened the stream; wait for the flow to reach its
  // terminal state: genuine model prose rendered in the summary body. The
  // key IS configured, so the locked §14a degraded-state banners must NOT
  // appear, and the deterministic fallback ("N events analyzed, ...") must
  // have been replaced by real narrative text.
  const timelinePanel = page.getByRole("tabpanel").filter({ has: page.getByText("Timeline summary") });
  const summaryProse = timelinePanel.locator(".prose");
  await expect(summaryProse).toBeVisible({ timeout: 90_000 });
  await expect(async () => {
    const text = (await summaryProse.innerText()).trim();
    expect(text.length).toBeGreaterThan(80);
  }).toPass({ timeout: 90_000 });

  await expect(page.getByText("AI-enhanced analysis is disabled", { exact: false })).toHaveCount(0);
  await expect(timelinePanel.getByText("AI-enhanced analysis failed", { exact: false })).toHaveCount(0);
  // The live-stream terminal state means no shimmer labels remain.
  await expect(timelinePanel.getByText("Thinking…", { exact: true })).toHaveCount(0);
  await expect(timelinePanel.getByText("Preparing summary…", { exact: true })).toHaveCount(0);

  // Adaptive thinking: when the model chose to reason visibly, the block
  // folded into a clickable real-elapsed-time summary — expand it and check
  // the real reasoning text is preserved.
  const thoughtFold = timelinePanel.getByRole("button", { name: /Thought for \d+s/ });
  if ((await thoughtFold.count()) > 0) {
    await thoughtFold.click();
    await expect(async () => {
      const reasoning = (await timelinePanel.locator(".thinking-fade-mask").innerText()).trim();
      expect(reasoning.length).toBeGreaterThan(20);
    }).toPass({ timeout: 5_000 });
  }

  // --- Anomalies tab: severity sub-tabs + expandable table rows (§14c) ---
  await anomaliesTab.click();
  for (const tier of SEVERITY_TABS) {
    // Each sub-tab is labeled with its live count.
    await expect(page.getByRole("tab", { name: new RegExp(`^${tier} \\d+$`) })).toBeVisible();
  }

  // A specific known anomaly from examples/ANSWER_KEY.md: quick-demo.log
  // line 135, threatname="Win32.Trojan.Generic" — a direct-signal
  // threatname_hit with a fixed base confidence of 95
  // (apps/api/src/rules/config.ts's THREATNAME_CONFIDENCE). The live judge
  // may nudge its adjusted confidence (±15), but the base score is
  // deterministic and always displayed (§8's dual-confidence rule).
  const threatRow = await revealAnomalyRow(page, "Threat match");
  await expect(threatRow.getByText("95").first()).toBeVisible();

  // Click-to-expand: the full untruncated details appear inline.
  await threatRow.getByRole("button").first().click();
  await expect(threatRow.getByText("Rule explanation", { exact: true })).toBeVisible();
  await expect(threatRow.getByText("base", { exact: true })).toBeVisible();

  // --- Events tab: same real functionality as before the restructure ---
  await eventsTab.click();
  await expect(page.getByText("169 events total")).toBeVisible();
  await expect(page.getByText("Page 1 of 2")).toBeVisible();

  const rows = page.locator("table tbody tr");
  await expect(rows.first()).toBeVisible();
  const firstPageRowCount = await rows.count();
  expect(firstPageRowCount).toBeGreaterThan(0);

  // `exact: true` matters here: Next.js's own dev-tools button ("Open
  // Next.js Dev Tools") also substring-matches an inexact "Next" name.
  const nextButton = page.getByRole("button", { name: "Next", exact: true });
  await expect(nextButton).toBeEnabled();
  await nextButton.click();

  await expect(page.getByText("Page 2 of 2")).toBeVisible();
  await expect(nextButton).toBeDisabled();
  const prevButton = page.getByRole("button", { name: "Prev" });
  await expect(prevButton).toBeEnabled();
});
