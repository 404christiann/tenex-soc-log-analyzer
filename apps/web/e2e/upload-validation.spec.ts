import { test, expect } from "@playwright/test";
import { signIn, uniqueEmail } from "./helpers";

/**
 * Client-side upload validation (apps/web/src/components/upload-dropzone.tsx's
 * `validateClientSide` — an explicit *hint* mirroring apps/api's real
 * extension check, not the security boundary itself, but per an earlier
 * phase's manual verification this must reject before any network call).
 */
test("selecting a wrong-extension file is rejected client-side, with no upload request sent", async ({ page }) => {
  await signIn(page, uniqueEmail("validation"));

  const uploadRequests: string[] = [];
  page.on("request", (req) => {
    if (req.url().includes("/api/logs/upload")) {
      uploadRequests.push(req.url());
    }
  });

  const fileInput = page.locator('input[type="file"]');
  await fileInput.setInputFiles({
    name: "not-a-log.exe",
    mimeType: "application/octet-stream",
    buffer: Buffer.from("this is not a real executable, just wrong-extension content"),
  });

  await expect(page.getByText("Unsupported file type — expected .log or .txt.")).toBeVisible();

  // No staged loading state, no navigation, no request ever left the browser.
  await expect(page.getByText(/Analyzing/)).toHaveCount(0);
  await expect(page).toHaveURL(/\/dashboard$/);
  expect(uploadRequests).toEqual([]);

  // The dashboard's file list is untouched — still the pristine empty state.
  await expect(page.getByText("No files uploaded yet")).toBeVisible();
});
