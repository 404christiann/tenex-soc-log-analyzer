import path from "node:path";
import { test, expect } from "@playwright/test";
import { EXAMPLES_DIR, signIn, uniqueEmail } from "./helpers";

/**
 * RLS isolation, exercised through the real UI (DECISIONS.md §7/§14a) —
 * not just an API-level assertion (see apps/api/src/routes/logs.integration.test.ts
 * for that layer). User A uploads a file; user B, in a completely separate
 * authenticated browser context, tries to navigate straight to user A's
 * results URL and must be blocked. Postgres RLS is what makes this true
 * regardless of any application-code bug (§7's whole point), so this test
 * proves it end to end: real browser, real navigation, real session.
 */
// Two OTP sign-ins plus a live-judge upload can exceed the suite's default 60s.
test.setTimeout(120_000);

test("user B cannot see or navigate to user A's uploaded file", async ({ browser }) => {
  const contextA = await browser.newContext();
  const contextB = await browser.newContext();

  try {
    const pageA = await contextA.newPage();
    await signIn(pageA, uniqueEmail("rls-a"));

    const fileInput = pageA.locator('input[type="file"]');
    await fileInput.setInputFiles(path.join(EXAMPLES_DIR, "quick-demo.log"));
    // Generous ceiling matching the API's own 60s upload timeout — the live
    // LLM judge's latency varies, especially when a summary stream from an
    // earlier spec is still generating concurrently.
    await pageA.waitForURL(/\/logs\/[0-9a-f-]+$/, { timeout: 60_000 });
    const fileUrl = pageA.url();
    await expect(pageA.getByRole("heading", { name: "quick-demo.log" })).toBeVisible();

    // A completely separate signed-up user, separate browser context (own
    // cookies/session — nothing shared with user A's tab).
    const pageB = await contextB.newPage();
    await signIn(pageB, uniqueEmail("rls-b"));

    // User B's own dashboard must not list user A's file.
    await expect(pageB.getByText("No files uploaded yet")).toBeVisible();
    await expect(pageB.getByText("quick-demo.log")).toHaveCount(0);

    // The real attack surface this test cares about: user B, while
    // authenticated as themselves, directly navigates to user A's results
    // URL. RLS must make this indistinguishable from "file doesn't exist" —
    // GET /api/logs/:id 404s (apps/api/src/routes/logs.ts's fetchOwnedFile
    // doc comment: a 404, not a 403, on purpose) and the results page must
    // render its "not found" state, never user A's data.
    await pageB.goto(fileUrl);
    await expect(pageB.getByText("File not found", { exact: true })).toBeVisible();
    await expect(pageB.getByRole("heading", { name: "quick-demo.log" })).toHaveCount(0);
  } finally {
    await contextA.close();
    await contextB.close();
  }
});
