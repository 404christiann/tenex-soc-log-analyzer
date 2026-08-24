import { test, expect } from "@playwright/test";
import { countOtpEmails, otpInput, signIn, uniqueEmail, waitForOtpCode } from "./helpers";

/**
 * Covers the passwordless-OTP auth journey end to end (DECISIONS.md
 * §7/§14d): the single /login entry point (signup was collapsed into it),
 * requesting a real 6-digit code, reading it from the local Mailpit email
 * catcher (never guessed or mocked — see helpers.ts), the wrong-code error
 * path, resend with its cooldown, the change-email back link, the
 * unauthenticated-redirect boundary, and a real sign-out that actually
 * revokes access to protected routes -> sign back in as the now-existing
 * user (which exercises GoTrue's returning-user template path too).
 */
test.describe("auth", () => {
  test("an unauthenticated visitor hitting a protected route is redirected to /login", async ({ page }) => {
    await page.goto("/dashboard");
    await page.waitForURL("**/login**");
    await expect(page.getByRole("heading", { name: "Sign in", level: 1 })).toBeVisible();
    // The old /signup route is gone entirely — it must bounce to /login too,
    // not render a second auth screen or a 404.
    await page.goto("/signup");
    await page.waitForURL("**/login**");
    await expect(page.getByRole("heading", { name: "Sign in", level: 1 })).toBeVisible();
  });

  test("first-time sign-in with an emailed code transparently creates the account and lands on an empty dashboard", async ({
    page,
  }) => {
    const email = uniqueEmail("first-signin");
    await signIn(page, email);

    // Nav shows the signed-in user's email (apps/web/src/components/user-nav.tsx).
    await expect(page.getByRole("button", { name: email })).toBeVisible();

    // A brand-new account (created by `signInWithOtp`'s default
    // `shouldCreateUser` — no signup form anywhere) has never uploaded anything.
    await expect(page.getByText("No files uploaded yet")).toBeVisible();
  });

  test("a wrong code shows a clear inline error and the real code still works afterwards", async ({ page }) => {
    const email = uniqueEmail("wrong-code");
    await page.goto("/login");
    await page.getByLabel("Email").fill(email);
    await page.getByRole("button", { name: "Send code" }).click();
    await expect(page.getByRole("heading", { name: "Check your email", level: 1 })).toBeVisible();

    // Read the REAL code first so the wrong guess is guaranteed wrong.
    const realCode = await waitForOtpCode(email);
    const wrongCode = realCode === "000000" ? "000001" : "000000";

    await otpInput(page).fill(wrongCode);
    await expect(page.getByText(/incorrect or has expired/)).toBeVisible();
    // Still on the code step — a bad code is not a dead end and not a silent no-op.
    await expect(page.getByRole("heading", { name: "Check your email", level: 1 })).toBeVisible();

    // Recovery: the genuine code (same email, still unexpired) signs in.
    await otpInput(page).fill(realCode);
    await page.waitForURL("**/dashboard");
    await expect(page.getByRole("button", { name: email })).toBeVisible();
  });

  test("resend really re-sends a new code (a second email lands in the catcher) and respects the cooldown", async ({
    page,
  }) => {
    const email = uniqueEmail("resend");
    await page.goto("/login");
    await page.getByLabel("Email").fill(email);
    await page.getByRole("button", { name: "Send code" }).click();
    await expect(page.getByRole("heading", { name: "Check your email", level: 1 })).toBeVisible();
    await waitForOtpCode(email);

    // Cooldown active: the resend control is disabled and counting down.
    const countingDown = page.getByRole("button", { name: /Resend code in \d+s/ });
    await expect(countingDown).toBeVisible();
    await expect(countingDown).toBeDisabled();

    // Once the ~30s cooldown elapses it re-enables; clicking it must
    // actually call `signInWithOtp` again — verified by a SECOND real email
    // arriving in Mailpit, not by any UI state alone.
    const resend = page.getByRole("button", { name: "Resend code", exact: true });
    await expect(resend).toBeEnabled({ timeout: 35_000 });
    const before = await countOtpEmails(email);
    await resend.click();
    const newCode = await waitForOtpCode(email, before);

    // Cooldown restarts after the resend…
    await expect(page.getByRole("button", { name: /Resend code in \d+s/ })).toBeDisabled();

    // …and the re-sent code is genuinely valid.
    await otpInput(page).fill(newCode);
    await page.waitForURL("**/dashboard");
  });

  test("the back link recovers from a typo'd email — change it and sign in with the corrected address", async ({
    page,
  }) => {
    const typoEmail = uniqueEmail("typo");
    const realEmail = uniqueEmail("corrected");

    await page.goto("/login");
    await page.getByLabel("Email").fill(typoEmail);
    await page.getByRole("button", { name: "Send code" }).click();
    await expect(page.getByText(typoEmail)).toBeVisible();

    await page.getByRole("button", { name: "Wrong email?" }).click();
    // Back on the email step, with the previous entry still editable.
    await expect(page.getByRole("heading", { name: "Sign in", level: 1 })).toBeVisible();
    await expect(page.getByLabel("Email")).toHaveValue(typoEmail);

    await page.getByLabel("Email").fill(realEmail);
    await page.getByRole("button", { name: "Send code" }).click();
    await expect(page.getByText(realEmail)).toBeVisible();
    const code = await waitForOtpCode(realEmail);
    await otpInput(page).fill(code);
    await page.waitForURL("**/dashboard");
    await expect(page.getByRole("button", { name: realEmail })).toBeVisible();
  });

  test("sign out clears the session — protected routes become inaccessible again, then signing back in restores access", async ({
    page,
  }) => {
    const email = uniqueEmail("signout");
    await signIn(page, email);

    await page.getByRole("button", { name: email }).click();
    await page.getByRole("menuitem", { name: "Sign out" }).click();
    await page.waitForURL("**/login**");

    // The session cookie is actually gone, not just a client-side nav —
    // hitting a protected route directly must bounce back to /login again.
    await page.goto("/dashboard");
    await page.waitForURL("**/login**");
    await expect(page.getByRole("heading", { name: "Sign in", level: 1 })).toBeVisible();

    // Signing back in works identically for the now-existing user (second
    // OTP request for the same address — GoTrue's returning-user path).
    await signIn(page, email);
    await expect(page.getByRole("button", { name: email })).toBeVisible();
  });
});
